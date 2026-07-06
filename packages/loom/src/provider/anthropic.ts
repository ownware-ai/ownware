/**
 * Anthropic Provider Adapter
 *
 * Direct @anthropic-ai/sdk usage — no LangChain wrapper.
 * Handles Claude-specific features: extended thinking, prompt caching,
 * PDF input, computer use, and the Anthropic streaming format.
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  ProviderAdapter,
  ProviderChunk,
  ProviderFeature,
  ProviderRequest,
  ToolDefinition,
} from './types.js'
import type { ModelPricing } from './pricing.js'
import { getModelInfo, getModelPricing } from './pricing.js'
import type { Message, ContentBlock } from '../messages/types.js'
import { ProviderError, classifyHttpError } from '../core/errors.js'
import { LOOM_TRACE } from '../observability/debug-trace.js'

/**
 * Anthropic requires a minimum thinking budget of 1024 tokens. Enforced at the
 * adapter so we fail loud before the API does.
 */
const MIN_THINKING_BUDGET_TOKENS = 1024

export class AnthropicProvider implements ProviderAdapter {
  readonly name = 'anthropic'

  /**
   * Resolved at construction when the consumer passed a static `apiKey`.
   * Reused for every `stream()` call. `null` only when the dynamic
   * `apiKeyProvider` path is in use — the client is then constructed
   * per stream call from a freshly-resolved key.
   */
  private readonly staticClient: Anthropic | null
  /**
   * Optional dynamic resolver. When set, takes precedence over the
   * static `apiKey` constructor option: every `stream()` call
   * resolves a fresh key, constructs an SDK client around it, and
   * lets the client go after the stream completes. Used by the
   * gateway's resolver-backed binding (C24b) so every LLM call
   * flows through resolve → audit → spend gate before the request
   * goes out.
   */
  private readonly apiKeyProvider: (() => Promise<string>) | undefined
  private readonly dynamicBaseURL: string | undefined

  constructor(opts?: {
    apiKey?: string
    baseURL?: string
    apiKeyProvider?: () => Promise<string>
  }) {
    if (opts?.apiKeyProvider) {
      this.staticClient = null
      this.apiKeyProvider = opts.apiKeyProvider
      this.dynamicBaseURL = opts.baseURL
    } else {
      this.staticClient = new Anthropic({
        apiKey: opts?.apiKey,
        baseURL: opts?.baseURL,
      })
      this.apiKeyProvider = undefined
      this.dynamicBaseURL = undefined
    }
  }

  /**
   * Resolve the SDK client for one `stream()` call. The dynamic path
   * constructs a fresh `Anthropic` instance per call so the resolved
   * key cannot leak across requests; the SDK client is GC'd after the
   * stream completes.
   */
  private async getClient(): Promise<Anthropic> {
    if (this.apiKeyProvider !== undefined) {
      const apiKey = await this.apiKeyProvider()
      return new Anthropic({
        apiKey,
        ...(this.dynamicBaseURL !== undefined ? { baseURL: this.dynamicBaseURL } : {}),
      })
    }
    return this.staticClient!
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
    // Outer wrapper: translate SDK-thrown errors (APIError subclasses,
    // connection errors, user aborts) into typed ProviderError subclasses
    // so callers can `instanceof AuthenticationError` etc. The actual work
    // lives in streamImpl — this wrapper exists purely for error mapping.
    try {
      yield* this.streamImpl(request)
    } catch (err) {
      throw translateAnthropicError(err)
    }
  }

  private async *streamImpl(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
    const client = await this.getClient()
    const messages = request.messages
      .filter(m => m.role !== 'system')
      .map(m => toAnthropicMessage(m))

    // Prompt caching: pass array system blocks with cache_control as-is
    const system = typeof request.system === 'string'
      ? request.system
      : request.system.map(block => ({
          type: 'text' as const,
          text: block.text,
          ...(block.cache_control && { cache_control: block.cache_control }),
        }))

    // Extended thinking: validate + translate Loom's normalized config into
    // the Anthropic-specific `thinking` API parameter. Validation runs before
    // we call the API so misconfiguration surfaces as a ProviderError, not a
    // 400 buried inside the SDK stream.
    const thinkingParam = resolveThinkingParam(request)

    const stream = client.messages.stream(
      {
        model: request.model,
        system,
        messages,
        tools: request.tools.map(toAnthropicTool),
        max_tokens: request.maxTokens,
        ...(thinkingParam ? { thinking: thinkingParam } : {}),
        ...(request.temperature !== null && { temperature: request.temperature }),
      },
      request.signal ? { signal: request.signal } : undefined,
    )

    // Track current state for accumulation
    let currentToolId: string | undefined
    let currentToolInput = ''

    // Stall detection: abort the stream if no events arrive for too long.
    // Two thresholds — the normal 90s general guard, and a tight 2s
    // post-`message_stop` grace window. The grace handles a documented
    // class of Anthropic streaming bugs (anthropics/anthropic-sdk-typescript
    // issues #842, #867, #998): the model emits `message_stop` but the
    // HTTP connection stays open, leaving the SDK's async iterator
    // parked indefinitely. The grace makes us fail loud within 2s
    // instead of hanging until the 90s guard fires.
    const STALL_WARN_MS = 30_000
    const STALL_TIMEOUT_MS = 90_000
    const POST_FINISH_GRACE_MS = 2_000
    let stallWarnTimer: ReturnType<typeof setTimeout> | undefined
    let stallTimeoutTimer: ReturnType<typeof setTimeout> | undefined
    let stallError: ProviderError | null = null
    let stopSignalSeen = false
    const stallAbortController = new AbortController()

    const clearStallTimers = () => {
      if (stallWarnTimer) clearTimeout(stallWarnTimer)
      if (stallTimeoutTimer) clearTimeout(stallTimeoutTimer)
    }

    const resetStallTimers = () => {
      clearStallTimers()
      // After `message_stop` was observed, the only event we should
      // realistically still be waiting for is the iterator's natural
      // termination. Use the tight grace window — 2s — so a parked
      // iterator surfaces as a clean error instead of an indefinite hang.
      const timeoutMs = stopSignalSeen ? POST_FINISH_GRACE_MS : STALL_TIMEOUT_MS
      stallWarnTimer = setTimeout(() => {
        console.warn(`[loom/anthropic] Stream stall warning: no events for ${STALL_WARN_MS / 1000}s`)
      }, STALL_WARN_MS)
      stallTimeoutTimer = setTimeout(() => {
        const reason = stopSignalSeen
          ? `Stream open beyond message_stop grace (${POST_FINISH_GRACE_MS}ms)`
          : `Stream stalled: no events received for ${STALL_TIMEOUT_MS / 1000}s`
        if (LOOM_TRACE) {
          // eslint-disable-next-line no-console
          console.log(`[anthropic-trace] stall-fire stopSignalSeen=${stopSignalSeen} reason="${reason}"`)
        }
        stallError = new ProviderError(reason, 'anthropic', { recoverable: true })
        stallAbortController.abort()
        if (typeof (stream as any).abort === 'function') {
          (stream as any).abort()
        }
      }, timeoutMs)
    }

    resetStallTimers()

    try {
      for await (const event of stream) {
        // Reset stall detection on each event
        resetStallTimers()

        // Abort signal check
        if (request.signal?.aborted) {
          break
        }

        switch (event.type) {
          case 'content_block_start': {
            const block = event.content_block
            if (block.type === 'text') {
              // Text block started
            } else if (block.type === 'tool_use') {
              currentToolId = block.id
              currentToolInput = ''
              yield {
                type: 'tool_use_start',
                id: block.id,
                name: block.name,
              }
            } else if (block.type === 'thinking') {
              // Thinking block started
            }
            break
          }

          case 'content_block_delta': {
            const delta = event.delta
            if (delta.type === 'text_delta') {
              yield { type: 'text_delta', text: delta.text }
            } else if (delta.type === 'input_json_delta') {
              currentToolInput += delta.partial_json
              yield {
                type: 'tool_use_args_delta',
                id: currentToolId!,
                delta: delta.partial_json,
              }
            } else if (delta.type === 'thinking_delta') {
              yield { type: 'thinking_delta', text: (delta as { thinking: string }).thinking }
            }
            break
          }

          case 'content_block_stop': {
            if (currentToolId) {
              yield { type: 'tool_use_end', id: currentToolId }
              currentToolId = undefined
              currentToolInput = ''
            }
            break
          }

          case 'message_stop': {
            // The model has signaled end-of-message. From this point on
            // the iterator should terminate within a couple of frames;
            // if it doesn't (Issue #842 class of hang), the
            // POST_FINISH_GRACE_MS branch in resetStallTimers will fire
            // and surface a recoverable error instead of hanging.
            stopSignalSeen = true
            resetStallTimers()
            break
          }
        }
      }
    } finally {
      clearStallTimers()
    }

    // If stream was killed by stall detection, throw the error
    if (stallError) {
      throw stallError
    }

    // If aborted by user, don't try to get final message
    if (request.signal?.aborted) {
      throw new ProviderError('Request was aborted', 'anthropic', { recoverable: false })
    }

    // Get final message for complete content and usage
    const finalMessage = await stream.finalMessage()

    // Overloaded-error guard. Anthropic signals server overload by returning
    // HTTP 200 with `content: [{ type: 'text', text: '...' }]` AND an
    // `error: { type: 'overloaded_error', message: ... }` top-level field
    // (or the same error shape embedded in the first content block). Retry
    // logic keys off ProviderError.statusCode — surfacing this as a thrown
    // retryable error is what lets the 5xx/529 retry path pick it up.
    detectOverloadedError(finalMessage)

    const content: ContentBlock[] = finalMessage.content.map(block => {
      if (block.type === 'text') {
        return { type: 'text' as const, text: block.text }
      }
      if (block.type === 'tool_use') {
        return {
          type: 'tool_use' as const,
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        }
      }
      if (block.type === 'thinking') {
        const thinkingBlock = block as { thinking: string; signature: string }
        return {
          type: 'thinking' as const,
          text: thinkingBlock.thinking,
          signature: thinkingBlock.signature,
        }
      }
      if (block.type === 'redacted_thinking') {
        return {
          type: 'redacted_thinking' as const,
          data: (block as { data: string }).data,
        }
      }
      return { type: 'text' as const, text: '' }
    })

    yield {
      type: 'message_complete',
      content,
      stopReason: mapAnthropicStopReason(finalMessage.stop_reason),
      usage: totalUsageIncludingIterations(finalMessage.usage),
    }
  }

  async countTokens(messages: Message[], system?: string): Promise<number> {
    const client = await this.getClient()
    const result = await client.messages.countTokens({
      model: 'claude-sonnet-4-6',
      messages: messages
        .filter(m => m.role !== 'system')
        .map(m => toAnthropicMessage(m)),
      ...(system && { system }),
    })
    return result.input_tokens
  }

  supportsFeature(feature: ProviderFeature): boolean {
    const supported: Set<ProviderFeature> = new Set([
      'streaming',
      'vision',
      'tool_use',
      'parallel_tool_use',
      'cache_control',
      'thinking',
      'extended_thinking',
      'pdf',
    ])
    return supported.has(feature)
  }

  formatTools(tools: ToolDefinition[]): unknown[] {
    return tools.map(toAnthropicTool)
  }

  getModelPricing(model: string): ModelPricing | null {
    return getModelPricing('anthropic', model)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toAnthropicMessage(msg: Message): Anthropic.MessageParam {
  if (msg.role === 'system') {
    // System messages are handled separately in Anthropic
    return { role: 'user', content: msg.content }
  }

  if (msg.role === 'user') {
    if (typeof msg.content === 'string') {
      return { role: 'user', content: msg.content }
    }

    // Convert content blocks — pass through cache_control for prompt caching
    const blocks: Anthropic.ContentBlockParam[] = msg.content.map(block => {
      const cacheMarker = 'cache_control' in block && block.cache_control
        ? { cache_control: block.cache_control }
        : {}

      if (block.type === 'text') {
        return { type: 'text', text: block.text, ...cacheMarker }
      }
      if (block.type === 'tool_result') {
        return {
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: typeof block.content === 'string' ? block.content : '',
          is_error: block.isError,
          ...cacheMarker,
        } as Anthropic.ToolResultBlockParam
      }
      if (block.type === 'image') {
        if (block.source.type === 'base64') {
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: block.source.mediaType as Anthropic.Base64ImageSource['media_type'],
              data: block.source.data,
            },
            ...cacheMarker,
          }
        }
      }
      // PDF document — Anthropic accepts a base64 document block natively, so
      // the model actually reads the file. Without this case a document block
      // fell through to the empty-text return below and the PDF vanished
      // silently (Loom's own attachment pipeline emits these for PDF uploads).
      if (block.type === 'document') {
        return {
          type: 'document',
          source: {
            type: 'base64',
            media_type: block.source.mediaType,
            data: block.source.data,
          },
          ...cacheMarker,
        }
      }
      return { type: 'text', text: '', ...cacheMarker }
    })

    return { role: 'user', content: blocks }
  }

  // Assistant message — pass through cache_control.
  //
  // Thinking + redacted_thinking blocks must be echoed back on the next
  // request when the same assistant turn also contains a tool_use; Anthropic
  // rejects the follow-up otherwise. We serialize them with their original
  // signature / data so the model recognizes its own prior reasoning.
  const blocks: Anthropic.ContentBlockParam[] = msg.content.flatMap(block => {
    const cacheMarker = 'cache_control' in block && block.cache_control
      ? { cache_control: block.cache_control }
      : {}

    if (block.type === 'text') {
      return [{ type: 'text', text: block.text, ...cacheMarker }]
    }
    if (block.type === 'tool_use') {
      return [{
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
        ...cacheMarker,
      }]
    }
    if (block.type === 'thinking') {
      // Without a signature the block can't be replayed — drop it rather than
      // send an invalid placeholder that would 400 the request.
      if (!block.signature) return []
      return [{
        type: 'thinking',
        thinking: block.text,
        signature: block.signature,
        ...cacheMarker,
      } as Anthropic.ThinkingBlockParam]
    }
    if (block.type === 'redacted_thinking') {
      return [{
        type: 'redacted_thinking',
        data: block.data,
        ...cacheMarker,
      } as unknown as Anthropic.ContentBlockParam]
    }
    return [{ type: 'text', text: '', ...cacheMarker }]
  })

  return { role: 'assistant', content: blocks }
}

/**
 * Translate any error thrown by the Anthropic SDK or inside streamImpl()
 * into a typed Loom error. Idempotent — if the error is already a
 * ProviderError we pass it through untouched.
 *
 * Duck-types the SDK's APIError shape (`status`, `error`, `headers`) so we
 * don't drag SDK types into the error module. Network errors
 * (APIConnectionError has `status: undefined`) fall through to a
 * recoverable ProviderError with `statusCode: null` — the retry path
 * already handles that case via the "connection error" branch.
 */
function translateAnthropicError(err: unknown): Error {
  if (err instanceof ProviderError) return err
  if (!(err instanceof Error)) return new ProviderError('Unknown error', 'anthropic')

  const shape = err as Error & {
    status?: unknown
    headers?: unknown
    error?: unknown
  }

  const statusCode = typeof shape.status === 'number' ? shape.status : null
  const headers = normalizeHeaders(shape.headers)
  const retryAfterMs = parseRetryAfter(headers)
  // Serialize the body object if present so the classifier can substring-match
  // for context-window / content-policy signals.
  const bodyText = shape.error != null
    ? (typeof shape.error === 'string' ? shape.error : safeStringify(shape.error))
    : err.message

  if (statusCode != null) {
    return classifyHttpError(statusCode, bodyText, 'anthropic', {
      message: err.message,
      retryAfterMs,
      headers,
    })
  }

  // No status → connection-level failure. Retryable, statusCode:null so
  // retry.ts's "null ⇒ retryable" branch fires.
  return new ProviderError(err.message, 'anthropic', {
    recoverable: true,
    headers,
  })
}

function normalizeHeaders(h: unknown): Record<string, string> {
  if (h == null) return {}
  if (typeof h !== 'object') return {}
  if (h instanceof Headers) {
    const out: Record<string, string> = {}
    h.forEach((v, k) => { out[k.toLowerCase()] = v })
    return out
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v
  }
  return out
}

function parseRetryAfter(headers: Record<string, string>): number | undefined {
  const raw = headers['retry-after']
  if (!raw) return undefined
  const asNum = Number(raw)
  if (!Number.isNaN(asNum) && asNum >= 0) return asNum * 1000
  const asDate = Date.parse(raw)
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now())
  return undefined
}

function safeStringify(x: unknown): string {
  try { return JSON.stringify(x) } catch { return String(x) }
}

/**
 * Anthropic returns HTTP 200 when their fleet is overloaded. The response
 * carries a top-level `error: { type: 'overloaded_error', message: ... }`
 * field. Since we don't see a 5xx, the SDK doesn't throw and retry.ts never
 * kicks in. Translate it into a retryable ProviderError with statusCode 529
 * (Anthropic's documented overload code) so the retry ladder fires.
 */
function detectOverloadedError(finalMessage: unknown): void {
  if (finalMessage == null || typeof finalMessage !== 'object') return

  const err = (finalMessage as { error?: unknown }).error
  if (err == null || typeof err !== 'object') return

  const errType = (err as { type?: unknown }).type
  if (typeof errType !== 'string') return

  if (errType === 'overloaded_error') {
    const msg = (err as { message?: string }).message ?? 'Anthropic is overloaded'
    throw new ProviderError(msg, 'anthropic', {
      statusCode: 529,
      recoverable: true,
    })
  }

  // Other error shapes returned alongside a 200 are still problems — but they
  // may be permanent (auth, invalid_request). Throw unrecoverable so the loop
  // surfaces a real error instead of an empty assistant turn.
  const msg = (err as { message?: string }).message ?? `Anthropic returned error type "${errType}"`
  throw new ProviderError(msg, 'anthropic', { recoverable: false })
}

/**
 * Sum usage across server-side compaction iterations. Anthropic attaches
 * `usage.iterations: [{ input_tokens, output_tokens, cache_* }, ...]` when
 * it compacts history mid-response; the top-level usage on the final
 * message reports only the FINAL iteration. Summing catches the full cost.
 *
 * When no iterations[] is present (the common case), just pass through the
 * top-level numbers. Missing cache_* fields default to 0 the same way the
 * pre-fix code did.
 */
interface RawAnthropicUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens?: number
  readonly cache_creation_input_tokens?: number
  readonly iterations?: ReadonlyArray<{
    readonly input_tokens?: number
    readonly output_tokens?: number
    readonly cache_read_input_tokens?: number
    readonly cache_creation_input_tokens?: number
  }>
}

function totalUsageIncludingIterations(raw: unknown): {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheCreationTokens: number
} {
  const u = raw as RawAnthropicUsage
  let inputTokens = u.input_tokens ?? 0
  let outputTokens = u.output_tokens ?? 0
  let cacheReadTokens = u.cache_read_input_tokens ?? 0
  let cacheCreationTokens = u.cache_creation_input_tokens ?? 0

  if (Array.isArray(u.iterations)) {
    for (const it of u.iterations) {
      inputTokens += it.input_tokens ?? 0
      outputTokens += it.output_tokens ?? 0
      cacheReadTokens += it.cache_read_input_tokens ?? 0
      cacheCreationTokens += it.cache_creation_input_tokens ?? 0
    }
  }

  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }
}

/**
 * Translate Anthropic's six stop_reason values into Loom's normalized union.
 * Keep this exhaustive — collapsing unknown values into 'end_turn' hides
 * real signals (refusals look like normal completions, pauses look like
 * end-of-turn) and drives downstream UI + telemetry bugs.
 */
function mapAnthropicStopReason(
  reason: string | null,
): 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | 'stop_sequence' {
  switch (reason) {
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    case 'refusal':
      return 'refusal'
    case 'pause_turn':
      return 'pause_turn'
    case 'stop_sequence':
      return 'stop_sequence'
    case 'end_turn':
    case null:
      return 'end_turn'
    default:
      // Forward-compat: unknown future values land here. Logging beats
      // silently pretending the turn ended cleanly.
      console.warn(`[loom/anthropic] Unknown stop_reason "${reason}" — treating as end_turn.`)
      return 'end_turn'
  }
}

function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }
}

/**
 * Translate Loom's normalized thinking config into the Anthropic API shape,
 * failing loud on any combination the API would reject:
 *   - thinking enabled on a non-reasoning model
 *   - budget below Anthropic's 1024-token floor
 *   - budget >= max_tokens (the API requires budget < max_tokens)
 *
 * Returns `undefined` when thinking is null, disabled, or the field is absent
 * — callers must omit the param entirely in that case, not send `disabled`,
 * because sending `disabled` explicitly can disrupt cache hits on older
 * snapshots where the param was never present.
 */
function resolveThinkingParam(
  request: {
    readonly model: string
    readonly maxTokens: number
    readonly thinking?: { readonly enabled: boolean; readonly budgetTokens: number }
  },
): Anthropic.ThinkingConfigParam | undefined {
  const cfg = request.thinking
  if (!cfg || !cfg.enabled) return undefined

  const info = getModelInfo('anthropic', request.model)
  if (info != null && !info.supportsReasoning) {
    throw new ProviderError(
      `Extended thinking is not supported by model "${request.model}". ` +
      `Use a reasoning-capable Claude model (e.g. claude-sonnet-4-6, ` +
      `claude-opus-4-7, claude-3-7-sonnet-20250219).`,
      'anthropic',
      { recoverable: false },
    )
  }

  if (!Number.isInteger(cfg.budgetTokens) || cfg.budgetTokens < MIN_THINKING_BUDGET_TOKENS) {
    throw new ProviderError(
      `Thinking budgetTokens must be an integer >= ${MIN_THINKING_BUDGET_TOKENS} ` +
      `(got ${cfg.budgetTokens}).`,
      'anthropic',
      { recoverable: false },
    )
  }

  if (cfg.budgetTokens >= request.maxTokens) {
    throw new ProviderError(
      `Thinking budgetTokens (${cfg.budgetTokens}) must be strictly less than ` +
      `maxTokens (${request.maxTokens}). Raise maxTokens or lower the thinking budget.`,
      'anthropic',
      { recoverable: false },
    )
  }

  return { type: 'enabled', budget_tokens: cfg.budgetTokens }
}
