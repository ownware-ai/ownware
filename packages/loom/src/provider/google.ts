/**
 * Google (Gemini) Provider Adapter
 *
 * Direct '@google/generative-ai' SDK usage — translates between Loom's
 * normalized format and Google's GenerativeAI streaming API.
 */

import {
  GoogleGenerativeAI,
  type Content,
  type EnhancedGenerateContentResponse,
  type FunctionDeclaration,
  type Part,
} from '@google/generative-ai'
import type { ModelPricing } from './pricing.js'
import { getModelPricing } from './pricing.js'
import type {
  ProviderAdapter,
  ProviderChunk,
  ProviderFeature,
  ProviderRequest,
  ProviderUsage,
  ToolDefinition,
} from './types.js'
import type { Message, ContentBlock } from '../messages/types.js'
import { withStallGuard } from './stall-guard.js'
import { LOOM_TRACE } from '../observability/debug-trace.js'

// ---------------------------------------------------------------------------
// Stall detection defaults (match Anthropic provider)
// ---------------------------------------------------------------------------

const STALL_WARN_MS = 30_000
const STALL_TIMEOUT_MS = 90_000

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class GoogleProvider implements ProviderAdapter {
  readonly name = 'google'

  /** Static SDK client; reused for every stream when constructed with a
   *  static apiKey. `null` when the dynamic apiKeyProvider path is in use. */
  private readonly staticClient: GoogleGenerativeAI | null
  /** Dynamic resolver — see Anthropic / OpenAI providers for rationale. */
  private readonly apiKeyProvider: (() => Promise<string>) | undefined
  private defaultModel: string

  constructor(opts?: {
    apiKey?: string
    model?: string
    apiKeyProvider?: () => Promise<string>
  }) {
    if (opts?.apiKeyProvider) {
      this.staticClient = null
      this.apiKeyProvider = opts.apiKeyProvider
    } else {
      const apiKey = opts?.apiKey ?? process.env['GOOGLE_API_KEY'] ?? ''
      this.staticClient = new GoogleGenerativeAI(apiKey)
      this.apiKeyProvider = undefined
    }
    this.defaultModel = opts?.model ?? 'gemini-2.5-pro'
  }

  /** Resolve the SDK client for one call. Dynamic path constructs a
   *  fresh `GoogleGenerativeAI` per call so the resolved key cannot
   *  leak across requests. */
  private async getClient(): Promise<GoogleGenerativeAI> {
    if (this.apiKeyProvider !== undefined) {
      const apiKey = await this.apiKeyProvider()
      return new GoogleGenerativeAI(apiKey)
    }
    return this.staticClient!
  }

  /**
   * Stream a response from Gemini.
   *
   * Maps Google's generateContentStream chunks to Loom's normalized
   * ProviderChunk format. Handles text and functionCall parts.
   * Includes stall detection — throws ProviderError if no events for 90s (configurable).
   */
  async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
    const client = await this.getClient()
    const systemInstruction = typeof request.system === 'string'
      ? request.system
      : request.system.map(s => s.text).join('\n\n')

    const model = client.getGenerativeModel({
      model: request.model,
      systemInstruction,
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        ...(request.temperature !== null && { temperature: request.temperature }),
      },
      tools: request.tools.length > 0
        ? [{ functionDeclarations: request.tools.map(toGeminiFunctionDeclaration) }]
        : undefined,
    })

    const contents = toGeminiContents(request.messages)
    const streamResult = await model.generateContentStream({ contents })

    const contentBlocks: ContentBlock[] = []
    let fullText = ''
    const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let cachedContentTokens = 0

    // Wrap stream with stall detection
    const guardedStream = withStallGuard(streamResult.stream, {
      provider: 'google',
      warnMs: request.stallWarnMs ?? STALL_WARN_MS,
      timeoutMs: request.stallTimeoutMs ?? STALL_TIMEOUT_MS,
    })

    // Gemini has documented streaming-hang issues (google-gemini/gemini-cli
    // issue #10678 "Model stream ended without a finish reason";
    // googleapis/python-genai #2049 "finishMessage not parsed in
    // streaming mode"; community report of endless STREAM_CHUNK on
    // Pro 06-06). After ANY chunk surfaces a `finishReason`, race the
    // next iterator step against a tight grace timer so a parked
    // stream fails loud in 2s instead of running until the 90s guard.
    const POST_FINISH_GRACE_MS = 2_000
    type StreamChunk = EnhancedGenerateContentResponse
    type IterStep = { kind: 'chunk'; chunk: StreamChunk } | { kind: 'end' } | { kind: 'grace-expired' }

    const streamIter = guardedStream[Symbol.asyncIterator]() as AsyncIterator<StreamChunk>
    let finishSeen = false
    let lastFinishReason: string | undefined
    while (true) {
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      const step: IterStep = finishSeen
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
          console.log('[google-trace] post-finish grace expired — forcing stream close', JSON.stringify({
            model: request.model,
            waited: POST_FINISH_GRACE_MS,
          }))
        }
        if (typeof streamIter.return === 'function') {
          try { await streamIter.return(undefined) } catch { /* ignore */ }
        }
        break
      }
      if (step.kind === 'end') break
      const chunk = step.chunk
      if (chunk.candidates?.[0]?.finishReason) {
        finishSeen = true
        lastFinishReason = chunk.candidates[0].finishReason
      }
      {
      // Usage metadata.
      //
      // Gemini's `promptTokenCount` is the FULL prompt count and includes
      // `cachedContentTokenCount` as a subset (per
      // https://ai.google.dev/gemini-api/docs/caching). We split the cached
      // portion off here so the pricing layer can charge each at the right
      // rate — without this split, cached tokens get billed twice (full
      // input rate + cache_read rate). Same shape as the OpenAI fix.
      if (chunk.usageMetadata) {
        totalInputTokens = chunk.usageMetadata.promptTokenCount ?? 0
        totalOutputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0
        cachedContentTokens = chunk.usageMetadata.cachedContentTokenCount ?? 0
      }

      const candidate = chunk.candidates?.[0]
      if (!candidate?.content?.parts) continue

      for (const part of candidate.content.parts) {
        // Text content
        if (part.text !== undefined) {
          fullText += part.text
          yield { type: 'text_delta', text: part.text }
        }

        // Function call — Gemini sends complete calls per chunk (not streamed args)
        if (part.functionCall) {
          const id = `call_${crypto.randomUUID().slice(0, 8)}`
          const name = part.functionCall.name
          const args = (part.functionCall.args ?? {}) as Record<string, unknown>

          toolCalls.push({ id, name, args })

          yield { type: 'tool_use_start', id, name }
          const argsStr = JSON.stringify(args)
          yield { type: 'tool_use_args_delta', id, delta: argsStr }
          yield { type: 'tool_use_end', id }
        }
      }
      } // end inner block (chunk body)
    } // end while

    // Build final content blocks
    if (fullText) {
      contentBlocks.push({ type: 'text', text: fullText })
    }
    for (const tc of toolCalls) {
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.args,
      })
    }

    // Map Gemini's finishReason so a truncated or blocked response isn't
    // reported as a clean end_turn. MAX_TOKENS must surface (it unblocks the
    // loop's output-token continuation recovery); SAFETY / RECITATION /
    // PROHIBITED_CONTENT / BLOCKLIST / SPII are content blocks → refusal.
    // STOP (and unknown/unspecified) fall through to tool_use vs end_turn.
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal'
    if (lastFinishReason === 'MAX_TOKENS') {
      stopReason = 'max_tokens'
    } else if (
      lastFinishReason === 'SAFETY' ||
      lastFinishReason === 'RECITATION' ||
      lastFinishReason === 'PROHIBITED_CONTENT' ||
      lastFinishReason === 'BLOCKLIST' ||
      lastFinishReason === 'SPII'
    ) {
      stopReason = 'refusal'
    } else {
      stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn'
    }
    const usage: ProviderUsage = {
      inputTokens: Math.max(0, totalInputTokens - cachedContentTokens),
      outputTokens: totalOutputTokens,
      cacheReadTokens: cachedContentTokens,
      cacheCreationTokens: 0,
    }

    yield {
      type: 'message_complete',
      content: contentBlocks,
      stopReason,
      usage,
    }
  }

  /**
   * Count tokens using Google's native countTokens API.
   */
  async countTokens(messages: Message[], system?: string): Promise<number> {
    const client = await this.getClient()
    const model = client.getGenerativeModel({ model: this.defaultModel })
    const contents = toGeminiContents(messages)
    const result = await model.countTokens({ contents })
    let total = result.totalTokens
    if (system) {
      const sysResult = await model.countTokens(system)
      total += sysResult.totalTokens
    }
    return total
  }

  /** Check if Gemini supports a given feature. */
  supportsFeature(feature: ProviderFeature): boolean {
    const supported: Set<ProviderFeature> = new Set([
      'streaming',
      'vision',
      'tool_use',
      'structured_output',
    ])
    return supported.has(feature)
  }

  /** Format tool definitions into Gemini's functionDeclarations format. */
  formatTools(tools: ToolDefinition[]): unknown[] {
    return [{ functionDeclarations: tools.map(toGeminiFunctionDeclaration) }]
  }

  getModelPricing(model: string): ModelPricing | null {
    return getModelPricing('google', model)
  }
}

// ---------------------------------------------------------------------------
// Message conversion: Loom -> Gemini
// ---------------------------------------------------------------------------

/** Convert Loom messages to Gemini Content array. */
function toGeminiContents(messages: Message[]): Content[] {
  const contents: Content[] = []

  // Gemini pairs a functionResponse to its functionCall BY NAME, not by id.
  // Loom's tool_result only carries the call id (toolUseId), so pre-map each
  // id → the tool NAME from its originating tool_use. Without this, every
  // functionResponse used the id as its name, matched no functionCall, and
  // multi-turn tool calls silently broke on Gemini.
  const toolNameById = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue
    for (const block of msg.content) {
      if (block.type === 'tool_use') toolNameById.set(block.id, block.name)
    }
  }

  for (const msg of messages) {
    if (msg.role === 'system') continue

    if (msg.role === 'user') {
      const parts: Part[] = []

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content })
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ text: block.text })
          } else if (block.type === 'image') {
            if (block.source.type === 'base64') {
              parts.push({
                inlineData: {
                  mimeType: block.source.mediaType,
                  data: block.source.data,
                },
              })
            }
          } else if (block.type === 'document') {
            // Gemini reads PDFs via the same inlineData channel as images.
            // Without this case the document fell through and the PDF vanished.
            parts.push({
              inlineData: {
                mimeType: block.source.mediaType,
                data: block.source.data,
              },
            })
          } else if (block.type === 'tool_result') {
            // Gemini expects functionResponse for tool results, paired to the
            // functionCall BY NAME — so resolve the tool name from the call id
            // (the raw toolUseId never matched and broke multi-turn tools).
            parts.push({
              functionResponse: {
                name: toolNameById.get(block.toolUseId) ?? block.toolUseId,
                response: {
                  content: typeof block.content === 'string'
                    ? block.content
                    : JSON.stringify(block.content),
                  isError: block.isError,
                },
              },
            })
          }
        }
      }

      contents.push({ role: 'user', parts })
      continue
    }

    // Assistant -> 'model' in Gemini
    if (msg.role === 'assistant') {
      const parts: Part[] = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text })
        } else if (block.type === 'tool_use') {
          parts.push({
            functionCall: {
              name: block.name,
              args: block.input,
            },
          })
        }
      }

      contents.push({ role: 'model', parts })
    }
  }

  return contents
}

// ---------------------------------------------------------------------------
// Tool conversion: Loom -> Gemini
// ---------------------------------------------------------------------------

/** Convert a Loom ToolDefinition to Gemini FunctionDeclaration. */
function toGeminiFunctionDeclaration(
  tool: ToolDefinition,
): FunctionDeclaration {
  // Gemini doesn't support additionalProperties in its schema
  const { additionalProperties, ...schema } = tool.inputSchema as unknown as Record<string, unknown>

  return {
    name: tool.name,
    description: tool.description,
    parameters: schema as unknown as FunctionDeclaration['parameters'],
  }
}
