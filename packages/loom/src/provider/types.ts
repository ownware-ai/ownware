/**
 * Provider Adapter Interface
 *
 * Every LLM provider (Anthropic, OpenAI, Google, Bedrock) implements
 * this interface. The core loop talks to providers ONLY through this
 * contract — no provider-specific code leaks into the loop.
 *
 * Adapters are thin: they translate Loom's format to the provider SDK
 * and yield normalized streaming chunks back.
 */

import type { Message, ContentBlock } from '../messages/types.js'
import type { ModelPricing } from './pricing.js'
import type { LoomThinkingConfig } from '../core/config.js'
import type { CacheControlMarker } from '../core/cache-control.js'

// ---------------------------------------------------------------------------
// Provider request
// ---------------------------------------------------------------------------

export interface ProviderRequest {
  /** Model identifier (provider-specific, e.g., "claude-sonnet-4-20250514") */
  readonly model: string
  /**
   * System prompt(s). String form is the legacy single-block shape; array
   * form lets the loop emit one text block per entry with independent
   * cache markers (see `buildSystemRequestBlocks`). Markers carry an
   * optional TTL so a long-TTL session can extend cache lifetimes.
   */
  readonly system: string | Array<{ type: 'text'; text: string; cache_control?: CacheControlMarker }>
  /** Conversation messages */
  readonly messages: Message[]
  /** Tool definitions in Loom format */
  readonly tools: ToolDefinition[]
  /** Maximum output tokens */
  readonly maxTokens: number
  /** Temperature (null = provider default) */
  readonly temperature: number | null
  /** Abort signal */
  readonly signal?: AbortSignal
  /** Provider-specific options (escape hatch) */
  readonly providerOptions?: Record<string, unknown>
  /** Stall warning timeout in ms (default: 30000). Warn after this long with no stream events. */
  readonly stallWarnMs?: number
  /** Stall abort timeout in ms (default: 90000). Abort stream after this long with no events. */
  readonly stallTimeoutMs?: number
  /** Extended thinking configuration. Providers that don't support thinking ignore this. */
  readonly thinking?: LoomThinkingConfig
}

// ---------------------------------------------------------------------------
// Tool definition (provider-agnostic)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
}

export interface JsonSchema {
  readonly type: 'object'
  readonly properties: Record<string, JsonSchemaProperty>
  readonly required?: string[]
  readonly additionalProperties?: boolean
}

export interface JsonSchemaProperty {
  readonly type: string
  readonly description?: string
  readonly enum?: string[]
  readonly items?: JsonSchemaProperty
  readonly properties?: Record<string, JsonSchemaProperty>
  readonly required?: string[]
  readonly default?: unknown
}

// ---------------------------------------------------------------------------
// Streaming chunks (normalized from any provider)
// ---------------------------------------------------------------------------

export interface StreamTextDelta {
  readonly type: 'text_delta'
  readonly text: string
}

export interface StreamThinkingDelta {
  readonly type: 'thinking_delta'
  readonly text: string
}

export interface StreamToolUseStart {
  readonly type: 'tool_use_start'
  readonly id: string
  readonly name: string
}

export interface StreamToolUseArgsDelta {
  readonly type: 'tool_use_args_delta'
  readonly id: string
  readonly delta: string
}

export interface StreamToolUseEnd {
  readonly type: 'tool_use_end'
  readonly id: string
}

export interface StreamMessageComplete {
  readonly type: 'message_complete'
  readonly content: ContentBlock[]
  readonly stopReason:
    | 'end_turn'
    | 'tool_use'
    | 'max_tokens'
    | 'refusal'
    | 'pause_turn'
    | 'stop_sequence'
  readonly usage: ProviderUsage
}

export interface StreamError {
  readonly type: 'stream_error'
  readonly error: Error
}

export type ProviderChunk =
  | StreamTextDelta
  | StreamThinkingDelta
  | StreamToolUseStart
  | StreamToolUseArgsDelta
  | StreamToolUseEnd
  | StreamMessageComplete
  | StreamError

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface ProviderUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheCreationTokens: number
  /**
   * Reasoning tokens — the model's chain-of-thought / extended-thinking
   * output that consumes the response budget but is NOT shown to the
   * user (or is shown separately via a thinking-block surface).
   * Already counted INSIDE `outputTokens` by every provider that
   * exposes them (OpenAI o-series, GPT-5 reasoning models — via
   * `completion_tokens_details.reasoning_tokens` on the usage chunk).
   * Surface them here so consumers can break down "visible reply"
   * vs "internal reasoning" cost without re-parsing provider raw
   * responses. Zero / undefined for providers that don't emit them
   * (Anthropic exposes thinking blocks as content, not a usage
   * field; Google doesn't report a reasoning-specific count).
   */
  readonly reasoningTokens?: number
  /**
   * Provider-reported USD cost for the call. Set when the upstream API
   * returns an authoritative figure (e.g. OpenRouter with
   * `usage: { include: true }` returns the actual billed cost from the
   * underlying provider — DeepInfra, Together, Fireworks, etc.). When
   * present, callers should prefer this over local pricing-table math
   * since it reflects the exact route + discounts applied upstream.
   */
  readonly reportedCostUsd?: number
  /**
   * Meaning of the monetary surface for this response.
   *
   * Absent preserves the existing metered-provider behavior. A subscription
   * route reports `subscription_allowance` so the engine retains token counts but
   * does not apply an unrelated API-key pricing table. `unknown` likewise
   * suppresses invented dollars while making the uncertainty explicit.
   */
  readonly costBasis?: ProviderCostBasis
}

export type ProviderCostBasis =
  | 'metered'
  | 'subscription_allowance'
  | 'unknown'

// ---------------------------------------------------------------------------
// Transport options (shared adapter construction contract)
// ---------------------------------------------------------------------------

/**
 * The HTTP entry point an adapter uses for model calls.
 *
 * Deliberately declared as the *widest* input the underlying SDKs accept
 * (`string | URL | Request`) so one function value is assignable to every
 * vendor SDK's own `Fetch` type without a cast at each call site.
 */
export type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

/**
 * Transport-level construction options shared by every adapter.
 *
 * These exist so a credential whose authority is not a bearer API key — an
 * OAuth token needing rotation, a request that must carry an account
 * identifier, a tenant-specific endpoint — can be expressed WITHOUT teaching
 * the core loop about any particular provider. The closure owns the auth
 * lifecycle; the adapter stays ignorant of it.
 *
 * ## Support envelope (read before relying on these)
 *
 * These options are NOT uniformly supported, because the vendor SDKs are not
 * uniform. The envelope is declared here rather than discovered at runtime:
 *
 * | Adapter      | `fetch`                  | `defaultHeaders`          |
 * |--------------|--------------------------|---------------------------|
 * | `openai`     | yes (client option)      | yes (client option)       |
 * | `openai-responses` | yes (client option) | yes (client option)      |
 * | `openrouter` | yes (inherited)          | yes (inherited)           |
 * | `anthropic`  | yes (client option)      | yes (client option)       |
 * | `google`     | **no — throws**          | yes (per-request headers) |
 * | `ollama`     | **no — not accepted**    | **no — not accepted**     |
 *
 * Two different refusals, both deliberate:
 *
 * - **`google` throws `ConfigError` at construction.** `@google/generative-ai`
 *   exposes no client-level HTTP hook at any version we support — only
 *   per-request `baseUrl` + `customHeaders`. Accepting a `fetch` and quietly
 *   dropping it would send every request WITHOUT whatever that closure carried
 *   (most likely the credential) while still looking configured: an
 *   authentication failure disguised as a working call. It throws at wiring
 *   time, before any request exists, rather than mid-stream in front of a
 *   customer.
 * - **`ollama` does not accept them in its constructor type at all**, so the
 *   compiler rejects the call. That is stronger than a runtime throw and needs
 *   no test to prove. Ollama is keyless local inference; a caller who genuinely
 *   needs transport control should use `OpenAIProvider` with a `baseURL`.
 *
 * The rule behind both: an option an adapter cannot honour must fail visibly.
 * Never accept-and-ignore.
 */
export interface ProviderTransportOptions {
  /**
   * Replaces the HTTP call used for every model request.
   *
   * The closure receives the fully-formed request the SDK intended to send and
   * returns the response the SDK will parse. Everything between — token
   * refresh, header injection, endpoint rewriting, retry accounting — is the
   * closure's business and invisible to this package.
   *
   * It is called once per HTTP attempt, not once per `stream()`, so an SDK-level
   * retry re-enters it. Any refresh performed inside MUST therefore be
   * single-flight; concurrent streams share the closure.
   */
  readonly fetch?: ProviderFetch

  /**
   * Headers merged into every model request.
   *
   * Use for static per-connection metadata (an account or project identifier).
   * Values that change per request, or that are secret and must be re-resolved,
   * belong in `fetch` instead — headers fixed at construction cannot rotate.
   */
  readonly defaultHeaders?: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// Provider features (capability detection)
// ---------------------------------------------------------------------------

export type ProviderFeature =
  | 'streaming'
  | 'vision'
  | 'tool_use'
  | 'parallel_tool_use'
  | 'cache_control'
  | 'thinking'
  | 'extended_thinking'
  | 'computer_use'
  | 'pdf'
  | 'structured_output'

// ---------------------------------------------------------------------------
// The Provider Adapter interface
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  /** Provider name (e.g., "anthropic", "openai") */
  readonly name: string

  /**
   * Stream a model response.
   * Yields normalized ProviderChunk events.
   * The last chunk is always StreamMessageComplete.
   */
  stream(request: ProviderRequest): AsyncGenerator<ProviderChunk>

  /**
   * Estimate token count for messages.
   * Used by compaction to decide when to compact.
   */
  countTokens(messages: Message[], system?: string): Promise<number>

  /**
   * Check if this provider supports a feature.
   */
  supportsFeature(feature: ProviderFeature): boolean

  /**
   * Format tool definitions for this provider.
   * Anthropic uses input_schema, OpenAI uses function.parameters, etc.
   */
  formatTools(tools: ToolDefinition[]): unknown[]

  /**
   * Get pricing for a model. Returns null if the model is unknown.
   * Used by the loop for accurate per-turn cost calculation.
   */
  getModelPricing(model: string): ModelPricing | null
}
