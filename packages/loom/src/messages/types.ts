/**
 * Loom Message Types
 *
 * Provider-agnostic message format. Serializers convert to/from
 * provider-specific formats (Anthropic, OpenAI, Google).
 *
 * These types map closely to the Anthropic API format because it's
 * the most expressive. Other providers get adapted.
 */

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

export interface ImageBlock {
  readonly type: 'image'
  readonly source:
    | { readonly type: 'base64'; readonly mediaType: string; readonly data: string }
    | { readonly type: 'url'; readonly url: string }
}

export interface ToolUseBlock {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
}

export interface ToolResultBlock {
  readonly type: 'tool_result'
  readonly toolUseId: string
  readonly content: string | ContentBlock[]
  readonly isError: boolean
  /**
   * Loom-internal metadata produced by the tool's `execute()` and
   * carried alongside the wire-visible content. Provider serializers
   * pick the wire fields explicitly (`toolUseId`, `content`,
   * `isError`) and never include this — so it stays inside the
   * Loom-side message log and never leaks to Anthropic/OpenAI/Google
   * API payloads.
   *
   * Consumers that need stable typed discriminators (compaction
   * strategies, UI renderers, telemetry) read fields from here
   * instead of matching strings in `content`. The browser-aware
   * compactor (B4b), for example, keys snapshot supersession on
   * `metadata.kind === 'browser-snapshot'` and `metadata.targetId`.
   *
   * Optional and free-shape — individual tools own what they put
   * here. Treat unknown keys as opaque.
   */
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface DocumentBlock {
  readonly type: 'document'
  readonly source: {
    readonly type: 'base64'
    readonly mediaType: 'application/pdf'
    readonly data: string
  }
}

export interface ThinkingBlock {
  readonly type: 'thinking'
  readonly text: string
  /**
   * Provider-issued signature that proves the block was produced by the model.
   * Anthropic requires this to be echoed back verbatim when the assistant turn
   * contains a tool_use block — without it the follow-up request is rejected.
   */
  readonly signature?: string
}

export interface RedactedThinkingBlock {
  readonly type: 'redacted_thinking'
  readonly data: string
}

/**
 * Cache control marker for Anthropic prompt caching on content blocks.
 *
 * Mirrors the canonical `CacheControlMarker` shape in `core/cache-control.ts`
 * but is re-declared here so `messages/types.ts` stays a leaf in the
 * dependency graph — no downstream code has to pull in `core/` transitively
 * just to annotate a message block. If the canonical shape ever gains a
 * field, this interface must be updated in lockstep.
 */
export interface CacheControl {
  readonly type: 'ephemeral'
  readonly ttl?: '5m' | '1h'
}

export type ContentBlock =
  | (TextBlock & { readonly cache_control?: CacheControl })
  | (ImageBlock & { readonly cache_control?: CacheControl })
  | (DocumentBlock & { readonly cache_control?: CacheControl })
  | (ToolUseBlock & { readonly cache_control?: CacheControl })
  | (ToolResultBlock & { readonly cache_control?: CacheControl })
  | (ThinkingBlock & { readonly cache_control?: CacheControl })
  | (RedactedThinkingBlock & { readonly cache_control?: CacheControl })

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface SystemMessage {
  readonly role: 'system'
  readonly content: string
  /** Anthropic cache_control markers for prompt caching */
  readonly cacheControl?: { readonly type: 'ephemeral' }
}

export interface UserMessage {
  readonly role: 'user'
  readonly content: string | ContentBlock[]
}

export interface AssistantMessage {
  readonly role: 'assistant'
  readonly content: ContentBlock[]
}

export type Message = SystemMessage | UserMessage | AssistantMessage

// ---------------------------------------------------------------------------
// Extended message (with Loom metadata)
// ---------------------------------------------------------------------------

export interface LoomMessage {
  /** Unique message identifier */
  readonly uuid: string
  /** The API message */
  readonly message: Message
  /** ISO timestamp */
  readonly timestamp: string
  /** Turn index when this message was created */
  readonly turnIndex: number
  /** Whether this is a synthetic/meta message (not user-authored) */
  readonly isMeta: boolean
  /** Whether this is a compaction summary */
  readonly isCompactSummary: boolean
  /** API error if this message represents an error response */
  readonly apiError?: string
  /** Usage for assistant messages */
  readonly usage?: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheCreationTokens: number
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function extractToolCalls(message: AssistantMessage): ToolUseBlock[] {
  return message.content.filter(
    (block): block is ToolUseBlock => block.type === 'tool_use',
  )
}

export function extractText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')
}

export function hasToolCalls(message: AssistantMessage): boolean {
  return message.content.some(block => block.type === 'tool_use')
}

export function createUserMessage(content: string | ContentBlock[]): UserMessage {
  return { role: 'user', content }
}

export function createToolResultMessage(
  toolUseId: string,
  content: string,
  isError = false,
  metadata?: Readonly<Record<string, unknown>>,
): UserMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        toolUseId,
        content,
        isError,
        ...(metadata !== undefined ? { metadata } : {}),
      },
    ],
  }
}
