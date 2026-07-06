/**
 * OpenAI Provider Adapter
 *
 * Direct 'openai' SDK usage — translates between Loom's normalized
 * format and OpenAI's chat completions API including function calling.
 */

import OpenAI from 'openai'
import type {
  ProviderAdapter,
  ProviderChunk,
  ProviderFeature,
  ProviderRequest,
  ProviderUsage,
  ToolDefinition,
} from './types.js'
import type { ModelPricing } from './pricing.js'
import { getModelInfo, getModelPricing } from './pricing.js'
import type { Message, ContentBlock } from '../messages/types.js'
import { assertPairing } from '../messages/pairing.js'
import { withStallGuard } from './stall-guard.js'
import { ProviderError, classifyHttpError } from '../core/errors.js'
import { LOOM_TRACE } from '../observability/debug-trace.js'
import { isKimiModel } from './quirks/kimi.js'
import { toCanonicalKimiId } from './quirks/kimi-id-mapper.js'

// ---------------------------------------------------------------------------
// Stall detection defaults (match Anthropic provider)
// ---------------------------------------------------------------------------

const STALL_WARN_MS = 30_000
const STALL_TIMEOUT_MS = 90_000

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class OpenAIProvider implements ProviderAdapter {
  readonly name: string = 'openai'

  /** Static SDK client; reused for every stream when constructed
   *  with a static apiKey. `null` when the dynamic apiKeyProvider
   *  path is in use. */
  private readonly staticClient: OpenAI | null
  /** Dynamic resolver. When set, takes precedence over `apiKey`:
   *  every stream call resolves a fresh key, constructs a fresh
   *  SDK client around it, and lets the client go after the stream
   *  completes. Wired by the gateway's resolver-backed binding so
   *  every LLM call flows through resolve → audit → spend gate. */
  private readonly apiKeyProvider: (() => Promise<string>) | undefined
  private readonly dynamicBaseURL: string | undefined
  private readonly dynamicOrganization: string | undefined

  constructor(opts?: {
    apiKey?: string
    baseURL?: string
    organization?: string
    apiKeyProvider?: () => Promise<string>
  }) {
    if (opts?.apiKeyProvider) {
      this.staticClient = null
      this.apiKeyProvider = opts.apiKeyProvider
      this.dynamicBaseURL = opts.baseURL
      this.dynamicOrganization = opts.organization
    } else {
      this.staticClient = new OpenAI({
        apiKey: opts?.apiKey,
        baseURL: opts?.baseURL,
        organization: opts?.organization,
      })
      this.apiKeyProvider = undefined
      this.dynamicBaseURL = undefined
      this.dynamicOrganization = undefined
    }
  }

  /**
   * Resolve the SDK client for one `stream()` call. The dynamic path
   * constructs a fresh `OpenAI` instance per call so the resolved key
   * cannot leak across requests.
   */
  private async getClient(): Promise<OpenAI> {
    if (this.apiKeyProvider !== undefined) {
      const apiKey = await this.apiKeyProvider()
      return new OpenAI({
        apiKey,
        ...(this.dynamicBaseURL !== undefined ? { baseURL: this.dynamicBaseURL } : {}),
        ...(this.dynamicOrganization !== undefined ? { organization: this.dynamicOrganization } : {}),
      })
    }
    return this.staticClient!
  }

  /**
   * Subclass hook for adding provider-specific top-level parameters to the
   * chat-completions request body. Returns `{}` by default. OpenRouter uses
   * this to opt into `usage: { include: true }` so the response includes
   * the upstream-provider-billed USD cost (DeepInfra, Together, Fireworks,
   * etc.) — without this, Loom would have to estimate from a local pricing
   * table that doesn't cover the long tail of OpenRouter-hosted models.
   *
   * OpenAI proper rejects unknown body params, so the default empty object
   * is correct for the direct-OpenAI path; only override on subclasses
   * targeting compatible gateways that accept the extra fields.
   */
  protected getProviderSpecificStreamParams(): Record<string, unknown> {
    return {}
  }

  /**
   * Stream a chat completion from OpenAI.
   *
   * Maps OpenAI's streaming delta events to Loom's normalized ProviderChunk format.
   * Handles text content, tool calls (function calling), and usage tracking.
   * Includes stall detection — throws ProviderError if no events for 90s (configurable).
   */
  async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
    // Outer wrapper: translate OpenAI SDK errors into typed ProviderError
    // subclasses. See streamImpl() below for the actual stream logic.
    try {
      yield* this.streamImpl(request)
    } catch (err) {
      throw translateOpenAIError(err)
    }
  }

  private async *streamImpl(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
    // Defensive guard: catch any tool_use ↔ tool_result pairing break
    // BEFORE shipping to the API. A broken array returns a confusing
    // 400 ("messages with role 'tool' must be a response to a preceding
    // message with 'tool_calls'") that's hard to trace back to the
    // compaction step that produced it. Failing here surfaces the
    // offending tool_use_id(s) in a clear loom-side error instead.
    assertPairing(request.messages)

    const client = await this.getClient()
    // Reasoning-model handling — catalog-driven (models.dev marks o-series,
    // gpt-5 non-chat, and future reasoners with `reasoning: true`). The
    // reasoning endpoint rejects a handful of params the standard Chat
    // Completions endpoint accepts, and needs `developer` instead of
    // `system` for the lead message. Validate once up front, then build a
    // shape that's safe to send either way.
    const modelInfo = getModelInfo('openai', request.model)
    const isReasoningModel = modelInfo?.supportsReasoning === true
    // `thinking` is a provider-agnostic hint. Per core/config.ts, providers
    // that can't honor it must ignore the field — not throw. Clearing it
    // here on non-reasoning models keeps the turn alive when callers pass
    // a profile-wide `thinking.enabled` alongside a model that can't
    // reason (e.g. routing Haiku or gpt-4o through a thinking-enabled
    // profile). Reasoning models still get the full `thinking` object.
    const thinking = isReasoningModel ? request.thinking : undefined

    const messages = toOpenAIMessages(request, {
      useDeveloperRole: isReasoningModel,
      // Kimi K2/K2.5/K2.6 require canonical `functions.<name>:<idx>`
      // tool-call IDs in conversation history. Non-canonical IDs degrade
      // multi-turn tool-call accuracy per Moonshot's spec + the vLLM
      // post-mortem at https://vllm.ai/blog/Kimi-K2-Accuracy. We mint
      // Loom-internal IDs that round-trip losslessly via
      // `toCanonicalKimiId` (see `kimi-id-mapper.ts`); flip this flag
      // and the converter rewrites every `tool_call_id` and
      // `tool_calls[].id` on the wire. No-op for other providers.
      normalizeKimiIds: isKimiModel(request.model),
    })
    const tools = request.tools.length > 0
      ? request.tools.map(toOpenAITool)
      : undefined

    // Base params — always safe.
    const params: Record<string, unknown> = {
      model: request.model,
      messages,
      tools,
      max_completion_tokens: request.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...this.getProviderSpecificStreamParams(),
    }

    if (isReasoningModel) {
      // Reasoning models reject: presence_penalty, frequency_penalty,
      // logit_bias, top_logprobs. top_p is rejected when reasoning is
      // actually engaged. Temperature locks to 1.0 on o-series (they'll
      // quietly ignore anything else) and is conditionally allowed on
      // gpt-5.1+ only when reasoning is disabled — the safe stance is to
      // omit temperature for reasoning models entirely so behavior is
      // consistent across the family. See LEARNING.md §6.
      //
      // `reasoning_effort` + `tools` is rejected by gpt-5.x on
      // /v1/chat/completions with: "Function tools with reasoning_effort
      // are not supported … Please use /v1/responses instead." Until the
      // Responses-API transport lands, drop `reasoning_effort` on tool
      // turns so the request goes through on the standard endpoint.
      // Default reasoning still engages — only the explicit effort knob
      // is surrendered. Same for tool-free turns: reasoning_effort stays.
      if (thinking?.enabled && tools === undefined) {
        params.reasoning_effort = thinking.effort ?? mapBudgetToEffort(thinking.budgetTokens)
      }
      // Else: let the API pick its own default. o-series reason at 'medium'
      // by default; gpt-5-chat variants don't reason. No explicit effort
      // keeps backward-compat for callers who aren't thinking-aware — and
      // keeps gpt-5.x tool-calls from 400ing on /v1/chat/completions.
    } else {
      // Standard chat completion — honor temperature as before.
      if (request.temperature !== null) {
        params.temperature = request.temperature
      }
    }

    const stream = await client.chat.completions.create(
      params as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
    )

    // Accumulate state across streamed deltas
    const contentBlocks: ContentBlock[] = []
    let fullText = ''
    let fullThinking = ''
    const toolCalls = new Map<number, {
      id: string
      name: string
      args: string
    }>()
    let finishReason: string | null = null
    let usage: ProviderUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }

    // Wrap stream with stall detection
    const guardedStream = withStallGuard(stream, {
      provider: 'openai',
      warnMs: request.stallWarnMs ?? STALL_WARN_MS,
      timeoutMs: request.stallTimeoutMs ?? STALL_TIMEOUT_MS,
    })

    let chunkCount = 0
    let lastFinishReasonSeen: string | null = null
    let lastChunkAt = Date.now()

    // OpenRouter doesn't always close the HTTP stream cleanly after a
    // tool call — `finish_reason` arrives but the SDK's async iterator
    // keeps waiting for `data: [DONE]` that may never come (heartbeats
    // keep the connection alive). Anything-llm documented this in their
    // OpenRouter adapter: "Not all OpenRouter models will return a stop
    // reason which keeps the connection open."
    //
    // Fix: after we see ANY finish_reason on a chunk, give the stream a
    // short grace window (POST_FINISH_GRACE_MS) to deliver the trailing
    // usage chunk, then break manually. This handles every model+route
    // combination uniformly, not as a per-provider patch.
    const POST_FINISH_GRACE_MS = 2000

    // We need manual iteration (not for-await) so we can race against
    // the grace timer once finish_reason has been observed.
    type StreamChunk = OpenAI.ChatCompletionChunk
    type IterStep = { kind: 'chunk'; chunk: StreamChunk } | { kind: 'end' } | { kind: 'grace-expired' }

    const streamIter = guardedStream[Symbol.asyncIterator]() as AsyncIterator<StreamChunk>
    let finishedAndDrained = false
    while (!finishedAndDrained) {
      // After finish_reason is seen, race the next chunk against a 2s
      // grace timer. The grace lets us capture the trailing usage
      // chunk OpenRouter sends after finish_reason; the timeout makes
      // sure we don't hang if the stream never closes.
      const useGraceTimer: boolean = lastFinishReasonSeen != null
      let graceTimer: ReturnType<typeof setTimeout> | undefined

      const step: IterStep = useGraceTimer
        ? await Promise.race([
            streamIter.next().then<IterStep>((r) =>
              r.done ? { kind: 'end' } : { kind: 'chunk', chunk: r.value },
            ),
            new Promise<IterStep>((resolve) => {
              graceTimer = setTimeout(() => resolve({ kind: 'grace-expired' }), POST_FINISH_GRACE_MS)
            }),
          ])
        : await streamIter.next().then<IterStep>((r) =>
            r.done ? { kind: 'end' } : { kind: 'chunk', chunk: r.value },
          )
      if (graceTimer !== undefined) clearTimeout(graceTimer)

      if (step.kind === 'grace-expired') {
        if (LOOM_TRACE) {
          // eslint-disable-next-line no-console
          console.log(`[openai-trace] post-finish grace expired — forcing stream close`, JSON.stringify({
            model: request.model,
            finishReason: lastFinishReasonSeen,
            chunkCount,
            waited: POST_FINISH_GRACE_MS,
          }))
        }
        // Best-effort cancel of the upstream iterator so the HTTP
        // socket closes promptly instead of leaking until OS timeout.
        if (typeof streamIter.return === 'function') {
          try { await streamIter.return(undefined) } catch { /* ignore */ }
        }
        finishedAndDrained = true
        break
      }

      if (step.kind === 'end') break
      // step.kind === 'chunk' is the only remaining variant
      const chunk: StreamChunk = step.chunk
      chunkCount++
      lastChunkAt = Date.now()
      const choice: StreamChunk['choices'][number] | undefined = chunk.choices?.[0]
      // [openai-trace] One-line diagnostic per chunk — type-only, no
      // content payload. Logs first 3, every 25th, plus any with a
      // finish_reason for forensic correlation against gateway logs.
      // Gated on LOOM_TRACE so the per-chunk object build + log are
      // skipped entirely on the hot path in production.
      if (LOOM_TRACE) {
        const dbg = {
          n: chunkCount,
          finish: choice?.finish_reason ?? null,
          hasDelta: !!choice?.delta,
          hasContent: !!choice?.delta?.content,
          hasTools: !!choice?.delta?.tool_calls,
          hasUsage: !!chunk.usage,
        }
        if (chunkCount <= 3 || dbg.finish != null || chunkCount % 25 === 0) {
          // eslint-disable-next-line no-console
          console.log(`[openai-trace] chunk model=${request.model}`, JSON.stringify(dbg))
        }
      }
      if (choice?.finish_reason) lastFinishReasonSeen = choice.finish_reason

      // Usage comes in the final chunk (stream_options.include_usage).
      //
      // Important: OpenAI's `prompt_tokens` is the FULL prompt count and
      // INCLUDES `prompt_tokens_details.cached_tokens` as a subset (per
      // https://platform.openai.com/docs/guides/prompt-caching). If we passed
      // both fields straight into calculateCost, the cached portion would be
      // billed twice — once at the input rate, once at the cache_read rate.
      // We split the prompt into the fresh and cached subsets here so the
      // pricing layer can charge each at the right rate.
      //
      // OpenAI does not bill for cache writes, so cacheCreationTokens stays 0.
      if (chunk.usage) {
        const totalPrompt = chunk.usage.prompt_tokens ?? 0
        const usageExt = chunk.usage as unknown as Record<string, unknown> & {
          prompt_tokens_details?: { cached_tokens?: number }
          // o-series / GPT-5 reasoning models report internal chain-
          // of-thought consumption here. The count is ALREADY INSIDE
          // `completion_tokens` (the model paid for these tokens to
          // produce its visible reply) — we surface it separately so
          // consumers can break down visible-output vs reasoning
          // cost without re-parsing.
          completion_tokens_details?: { reasoning_tokens?: number }
          // OpenRouter (when `usage: { include: true }` is sent) returns the
          // billed USD cost for the call as `usage.cost`. Number, in dollars.
          cost?: number
        }
        const cachedTokens = usageExt.prompt_tokens_details?.cached_tokens ?? 0
        const reasoningTokens = usageExt.completion_tokens_details?.reasoning_tokens
        const reportedCost = typeof usageExt.cost === 'number' ? usageExt.cost : undefined
        usage = {
          inputTokens: Math.max(0, totalPrompt - cachedTokens),
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: cachedTokens,
          cacheCreationTokens: 0,
          ...(typeof reasoningTokens === 'number' && reasoningTokens > 0
            ? { reasoningTokens }
            : {}),
          ...(reportedCost !== undefined ? { reportedCostUsd: reportedCost } : {}),
        }
      }

      if (!choice) continue

      if (choice.finish_reason) {
        finishReason = choice.finish_reason
      }

      const delta = choice.delta
      if (!delta) continue

      // --- Reasoning content (OpenRouter / DeepSeek-R1 / Kimi K2.5+ / GLM-4.6) ---
      // OpenRouter normalizes the various provider-specific reasoning fields
      // (DeepSeek's `reasoning_content`, Anthropic's nested thinking blocks,
      // etc.) into a single `delta.reasoning` string. Some direct providers
      // emit `delta.reasoning_content` instead. Capture both shapes so the
      // model's chain-of-thought surfaces as Loom `thinking_delta` events
      // instead of being silently dropped.
      const deltaWithReasoning = delta as unknown as {
        reasoning?: string
        reasoning_content?: string
      }
      const reasoningChunk =
        deltaWithReasoning.reasoning ?? deltaWithReasoning.reasoning_content
      if (reasoningChunk) {
        fullThinking += reasoningChunk
        yield { type: 'thinking_delta', text: reasoningChunk }
      }

      // --- Text content ---
      if (delta.content) {
        fullText += delta.content
        yield { type: 'text_delta', text: delta.content }
      }

      // --- Tool calls (function calling) ---
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index
          let tracked = toolCalls.get(idx)

          // New tool call — OpenAI sends id only on the first delta
          if (tc.id && !tracked) {
            tracked = { id: tc.id, name: tc.function?.name ?? '', args: '' }
            toolCalls.set(idx, tracked)
            yield {
              type: 'tool_use_start',
              id: tracked.id,
              name: tracked.name,
            }
          }

          if (!tracked) continue

          // Name may arrive in a later delta
          if (tc.function?.name && !tracked.name) {
            tracked.name = tc.function.name
          }

          // Argument fragment
          if (tc.function?.arguments) {
            tracked.args += tc.function.arguments
            yield {
              type: 'tool_use_args_delta',
              id: tracked.id,
              delta: tc.function.arguments,
            }
          }
        }
      }
    }

    // Finalize all tool calls
    for (const [, tc] of toolCalls) {
      yield { type: 'tool_use_end', id: tc.id }
    }

    // Build final content blocks. Thinking comes first when present so the
    // assistant turn replays in the natural reasoning → answer order.
    if (fullThinking) {
      contentBlocks.push({ type: 'thinking', text: fullThinking })
    }
    if (fullText) {
      contentBlocks.push({ type: 'text', text: fullText })
    }
    for (const [, tc] of toolCalls) {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(tc.args || '{}')
      } catch {
        input = { _raw: tc.args }
      }
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input,
      })
    }

    // Map OpenAI finish reasons to Loom stop reasons
    const stopReason = finishReason === 'tool_calls' ? 'tool_use' as const
      : finishReason === 'length' ? 'max_tokens' as const
      : 'end_turn' as const

    // [openai-trace] End-of-stream summary. If this fires but no
    // message_complete reaches the loop, the bug is downstream; if it
    // doesn't fire at all, the for-await never exited. The timing
    // since lastChunkAt tells us whether the SDK closed the stream
    // promptly or was sitting on the iterator long after meaningful
    // data stopped.
    if (LOOM_TRACE) {
      // eslint-disable-next-line no-console
      console.log('[openai-trace] stream-end', JSON.stringify({
        model: request.model,
        chunkCount,
        finishReason,
        lastFinishReasonSeen,
        stopReason,
        toolCallsCount: toolCalls.size,
        fullTextLen: fullText.length,
        fullThinkingLen: fullThinking.length,
        contentBlocks: contentBlocks.length,
        msSinceLastChunk: Date.now() - lastChunkAt,
      }))
    }

    yield {
      type: 'message_complete',
      content: contentBlocks,
      stopReason,
      usage,
    }
  }

  /**
   * Estimate token count for messages.
   *
   * Uses a ~4 chars/token heuristic. For precise counts, integrate tiktoken.
   */
  async countTokens(messages: Message[], system?: string): Promise<number> {
    let total = 0
    if (system) {
      total += Math.ceil(system.length / 4)
    }
    for (const msg of messages) {
      total += 4 // per-message overhead
      if (typeof msg.content === 'string') {
        total += Math.ceil(msg.content.length / 4)
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') {
            total += Math.ceil(block.text.length / 4)
          } else if (block.type === 'tool_use') {
            total += Math.ceil(JSON.stringify(block.input).length / 4)
          } else if (block.type === 'tool_result') {
            const content = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content)
            total += Math.ceil(content.length / 4)
          }
        }
      }
    }
    return total
  }

  /** Check if OpenAI supports a given feature. */
  supportsFeature(feature: ProviderFeature): boolean {
    const supported: Set<ProviderFeature> = new Set([
      'streaming',
      'vision',
      'tool_use',
      'parallel_tool_use',
      'structured_output',
    ])
    return supported.has(feature)
  }

  /** Format tool definitions into OpenAI's function calling format. */
  formatTools(tools: ToolDefinition[]): unknown[] {
    return tools.map(toOpenAITool)
  }

  getModelPricing(model: string): ModelPricing | null {
    return getModelPricing('openai', model)
  }
}

// ---------------------------------------------------------------------------
// Message conversion: Loom -> OpenAI
// ---------------------------------------------------------------------------

/** Convert a full Loom ProviderRequest to OpenAI message format. */
function toOpenAIMessages(
  request: ProviderRequest,
  opts?: {
    readonly useDeveloperRole?: boolean
    /**
     * When true, every `tool_call_id` and `tool_calls[].id` on the
     * wire is rewritten via `toCanonicalKimiId` so Kimi sees
     * `functions.<name>:<idx>` instead of the Loom-internal opaque
     * ID. No-op for IDs not minted by `mintKimiId` (legacy history,
     * cross-provider — pass-through). See `kimi-id-mapper.ts`.
     */
    readonly normalizeKimiIds?: boolean
  },
): OpenAI.ChatCompletionMessageParam[] {
  const canon = opts?.normalizeKimiIds === true
    ? toCanonicalKimiId
    : (id: string) => id
  const out: OpenAI.ChatCompletionMessageParam[] = []

  // System prompt. Reasoning models (o-series, gpt-5 non-chat) require
  // `developer` role rather than `system` — the API 400s on `system` for
  // these families. The SDK's chat types don't list 'developer' in the
  // static union yet, so cast through unknown.
  if (request.system) {
    const systemText = typeof request.system === 'string'
      ? request.system
      : request.system.map(s => s.text).join('\n\n')
    const leadRole = opts?.useDeveloperRole ? 'developer' : 'system'
    out.push({ role: leadRole, content: systemText } as unknown as OpenAI.ChatCompletionMessageParam)
  }

  for (const msg of request.messages) {
    if (msg.role === 'system') continue

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content })
        continue
      }

      // Tool results become separate 'tool' messages in OpenAI
      const toolResults = msg.content.filter(b => b.type === 'tool_result')
      if (toolResults.length > 0) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            out.push({
              role: 'tool',
              tool_call_id: canon(block.toolUseId),
              content: typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content),
            } as OpenAI.ChatCompletionToolMessageParam)
          }
        }
        continue
      }

      // Mixed content (text + images)
      const parts: OpenAI.ChatCompletionContentPart[] = []
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'image') {
          if (block.source.type === 'base64') {
            parts.push({
              type: 'image_url',
              image_url: {
                url: `data:${block.source.mediaType};base64,${block.source.data}`,
              },
            })
          } else if (block.source.type === 'url') {
            parts.push({
              type: 'image_url',
              image_url: { url: block.source.url },
            })
          }
        } else if (block.type === 'document') {
          // OpenAI Chat Completions PDF/file input varies by model and route
          // (and many OpenRouter targets reject a `file` part outright), so we
          // surface an honest placeholder instead of risking a 400 — and never
          // silently drop the attachment, which is what the missing case did.
          parts.push({
            type: 'text',
            text:
              '[A PDF document was attached but this provider/model does not accept ' +
              'document input. Ask the user to paste the relevant text, or use a model ' +
              'with native PDF support such as Claude or Gemini.]',
          })
        }
      }
      out.push({ role: 'user', content: parts })
      continue
    }

    // Assistant message
    if (msg.role === 'assistant') {
      const textParts = msg.content
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join('')

      const toolCallBlocks = msg.content.filter(b => b.type === 'tool_use')

      if (toolCallBlocks.length > 0) {
        out.push({
          role: 'assistant',
          content: textParts || null,
          tool_calls: toolCallBlocks.map(b => {
            const block = b as { id: string; name: string; input: Record<string, unknown> }
            return {
              id: canon(block.id),
              type: 'function' as const,
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            }
          }),
        })
      } else {
        out.push({ role: 'assistant', content: textParts })
      }
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Tool conversion: Loom -> OpenAI
// ---------------------------------------------------------------------------

/** Convert a Loom ToolDefinition to OpenAI's function calling format. */
function toOpenAITool(
  tool: ToolDefinition,
): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as unknown as Record<string, unknown>,
    },
  }
}

/**
 * Translate OpenAI SDK errors to typed Loom errors. Same pattern as the
 * Anthropic translator — duck-types the SDK's APIError shape so we don't
 * import SDK error classes here.
 */
function translateOpenAIError(err: unknown): Error {
  if (err instanceof ProviderError) return err
  if (!(err instanceof Error)) return new ProviderError('Unknown error', 'openai')

  const shape = err as Error & {
    status?: unknown
    headers?: unknown
    error?: unknown
  }

  const statusCode = typeof shape.status === 'number' ? shape.status : null
  const headers = normalizeOpenAIHeaders(shape.headers)
  const retryAfterMs = parseOpenAIRetryAfter(headers)
  const bodyText = shape.error != null
    ? (typeof shape.error === 'string' ? shape.error : safeOpenAIStringify(shape.error))
    : err.message

  if (statusCode != null) {
    return classifyHttpError(statusCode, bodyText, 'openai', {
      message: err.message,
      retryAfterMs,
      headers,
    })
  }

  return new ProviderError(err.message, 'openai', { recoverable: true, headers })
}

function normalizeOpenAIHeaders(h: unknown): Record<string, string> {
  if (h == null || typeof h !== 'object') return {}
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

function parseOpenAIRetryAfter(headers: Record<string, string>): number | undefined {
  const raw = headers['retry-after']
  if (!raw) return undefined
  const asNum = Number(raw)
  if (!Number.isNaN(asNum) && asNum >= 0) return asNum * 1000
  const asDate = Date.parse(raw)
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now())
  return undefined
}

function safeOpenAIStringify(x: unknown): string {
  try { return JSON.stringify(x) } catch { return String(x) }
}

/**
 * Collapse Loom's normalized `budgetTokens` into OpenAI's tri-state effort
 * value when the caller didn't explicitly pass `effort`. Thresholds lifted
 * from comparable Anthropic budgets + what OpenAI documents as typical
 * reasoning-token spend per tier. We skip `minimal` and `xhigh` — they're
 * opt-in extremes that callers should request explicitly via `effort`.
 */
function mapBudgetToEffort(budgetTokens: number): 'low' | 'medium' | 'high' {
  if (budgetTokens <= 4096) return 'low'
  if (budgetTokens <= 16_384) return 'medium'
  return 'high'
}
