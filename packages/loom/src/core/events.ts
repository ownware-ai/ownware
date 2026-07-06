/**
 * Loom Event System
 *
 * Every event the framework emits flows through this discriminated union.
 * Consumers (TUI, web gateway, tests) receive these from the AsyncGenerator
 * returned by the agent loop.
 *
 * Events are readonly, carry monotonic sequence numbers, and are designed
 * for efficient serialization over SSE/WebSocket.
 */

import type { CredentialPlacement } from '../credentials/types.js'

// Re-exported so consumers that import this file directly (e.g. a client's
// `@ownware/loom` path alias, which resolves to this file rather than the
// package root) can access the credential primitives without a second
// import hop. This mirrors how `CredentialPlacement` is baked into the
// `CredentialRequestEvent` shape below.
export type {
  CredentialPlacement,
  CredentialHandle,
  CredentialRequest,
  CredentialValue,
  EnvCredentialEntry,
} from '../credentials/types.js'

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

export interface TurnStartEvent {
  readonly type: 'turn.start'
  readonly turnIndex: number
  readonly timestamp: number
}

export interface TurnEndEvent {
  readonly type: 'turn.end'
  readonly turnIndex: number
  readonly stopReason: StopReason
  readonly usage: TurnUsage
  readonly timestamp: number
}

export type StopReason =
  | 'end_turn'        // Model finished naturally
  | 'tool_use'        // Model requested tool calls (loop continues)
  | 'max_tokens'      // Output token limit hit
  | 'max_turns'       // Turn limit reached
  | 'budget_exceeded' // Cost/token budget exceeded
  | 'aborted'         // User or system abort
  | 'error'           // Unrecoverable error
  | 'refusal'         // Model refused the prompt (content policy / safety block)
  | 'pause_turn'      // Model paused mid-turn (long-chain reasoning / interleaved tools)
  | 'stop_sequence'   // A configured stop string was emitted

export interface TurnUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheCreationTokens: number
  readonly model: string
  readonly costUsd: number
  /**
   * True when `costUsd` was computed via the Sonnet-tier fallback because
   * the model wasn't in Loom's pricing catalog. Consumers (status bars,
   * audit logs) should render the value as an estimate (e.g. `≈ $X.XXXX`)
   * rather than implying exact precision.
   *
   * Optional for back-compat: events emitted before this field shipped
   * (and rows persisted then) load with `isFallbackPricing` absent —
   * consumers must treat absence as "authoritative" (false).
   *
   * BUG #24 (accuracy-audit, 2026-05-16).
   */
  readonly isFallbackPricing?: boolean
}

// ---------------------------------------------------------------------------
// Streaming content
// ---------------------------------------------------------------------------

export interface TextDeltaEvent {
  readonly type: 'text.delta'
  readonly text: string
  readonly turnIndex: number
}

export interface TextCompleteEvent {
  readonly type: 'text.complete'
  readonly text: string
  readonly turnIndex: number
}

export interface ThinkingDeltaEvent {
  readonly type: 'thinking.delta'
  readonly text: string
  readonly turnIndex: number
}

export interface ThinkingCompleteEvent {
  readonly type: 'thinking.complete'
  readonly text: string
  readonly turnIndex: number
}

// ---------------------------------------------------------------------------
// Tool lifecycle
// ---------------------------------------------------------------------------

export interface ToolCallStartEvent {
  readonly type: 'tool.call.start'
  readonly toolCallId: string
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly turnIndex: number
}

export interface ToolCallArgsDeltaEvent {
  readonly type: 'tool.call.args_delta'
  readonly toolCallId: string
  readonly delta: string
  readonly turnIndex: number
}

export interface ToolCallProgressEvent {
  readonly type: 'tool.call.progress'
  readonly toolCallId: string
  readonly progress: string
  readonly turnIndex: number
}

export interface ToolCallEndEvent {
  readonly type: 'tool.call.end'
  readonly toolCallId: string
  readonly toolName: string
  readonly result: string
  readonly isError: boolean
  readonly durationMs: number
  readonly turnIndex: number
  /** Tool metadata — not sent to the model but available to consumers (UI, logging).
   *  Contains rich content like images (base64), audio paths, search results, etc. */
  readonly metadata?: Record<string, unknown>
  /** UTF-8 bytes of the tool's raw output BEFORE any truncation/capping.
   *  Equals outputBytesToModel when no truncation happened. */
  readonly outputBytesRaw?: number
  /** UTF-8 bytes of the result string actually returned to the model
   *  (post-truncation). Always <= outputBytesRaw. */
  readonly outputBytesToModel?: number
  /** True when capResultSize trimmed the output. */
  readonly truncated?: boolean
  /** True when the result was served from the session's tool result
   *  cache instead of executing the tool. `durationMs` will be near-zero
   *  for cache hits. */
  readonly cacheHit?: boolean
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

export interface CompactionStartEvent {
  readonly type: 'compaction.start'
  readonly strategy: string
  readonly preTokenCount: number
  readonly turnIndex: number
}

export interface CompactionEndEvent {
  readonly type: 'compaction.end'
  readonly strategy: string
  readonly preTokenCount: number
  readonly postTokenCount: number
  readonly turnIndex: number
  /** Percentage of context freed (0-100) */
  readonly savedPercent: number
  /**
   * Names of skills the agent invoked before this compaction. Used by
   * the loop to fire the `skills.previously-invoked` reminder so the
   * model knows which workflows were active even after the original
   * `skill` tool_results have been summarized away.
   *
   * Empty when no skills ran before compaction; omitted by callers
   * that don't track skill usage.
   */
  readonly activeSkills?: readonly string[]
}

/**
 * Tool-result drop fired — the loop replaced one or more stale
 * `tool_result` bodies with placeholders. No LLM call was made. The
 * event is informational: consumers can render a subtle
 * "older tool outputs collapsed" hint so users know the transcript
 * they see no longer shows the full text of old results.
 */
export interface ToolResultDropEvent {
  readonly type: 'tool_result.drop'
  /** How many tool_result blocks had their content replaced. */
  readonly droppedCount: number
  /**
   * Approximate bytes reclaimed (original content bytes minus
   * placeholder bytes). Not a token count — a proxy for how much
   * pressure the drop relieved.
   */
  readonly bytesReclaimed: number
  readonly turnIndex: number
}

// ---------------------------------------------------------------------------
// Context pressure (pre-compaction awareness)
// ---------------------------------------------------------------------------

export interface ContextPressureEvent {
  readonly type: 'context.pressure'
  /** Current fill level as fraction (0.0 - 1.0) */
  readonly level: number
  /** Estimated tokens currently used */
  readonly tokenCount: number
  /** Context window capacity */
  readonly contextWindow: number
  readonly turnIndex: number
}

// ---------------------------------------------------------------------------
// Cache efficiency
// ---------------------------------------------------------------------------

export interface CacheStatusEvent {
  readonly type: 'cache.status'
  /** Tokens served from cache (cheap) this turn */
  readonly cacheReadTokens: number
  /** Tokens written to cache (25% premium) this turn */
  readonly cacheCreationTokens: number
  /** Regular input tokens (full price) this turn */
  readonly uncachedInputTokens: number
  /** Savings percentage this turn vs no caching (0-100) */
  readonly savingsPercent: number
  /** Cumulative session savings in USD */
  readonly cumulativeSavingsUsd: number
  readonly turnIndex: number
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export interface RecoveryEvent {
  readonly type: 'recovery'
  readonly reason: 'max_output_tokens' | 'prompt_too_long' | 'model_fallback' | 'rate_limit'
  readonly attempt: number
  readonly detail: string
  readonly turnIndex: number
}

// ---------------------------------------------------------------------------
// Permissions / HITL
// ---------------------------------------------------------------------------

export interface PermissionRequestEvent {
  readonly type: 'permission.request'
  readonly requestId: string
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly reason: string
  readonly turnIndex: number
  /** Zone level (0-6) if zone security is active. */
  readonly zoneLevel?: number
  /** Zone name (safe, workspace, build, network, external, machine, never). */
  readonly zoneName?: string
  /** Human-readable explanation from the zone explainer. */
  readonly explanation?: string
  /**
   * Optional UI severity tag attached by the zone classifier (S3).
   * Lets the permission card render with appropriate styling
   * independent of the zone level itself.
   */
  readonly severityTag?: 'info' | 'warn' | 'critical'
  /** Human-readable detail for the severity tag, if present. */
  readonly severityReason?: string
}

export interface PermissionResponseEvent {
  readonly type: 'permission.response'
  readonly requestId: string
  readonly granted: boolean
  readonly turnIndex: number
  /**
   * Typed reason the call was not allowed. Present when `granted: false`
   * (user-denied, timeout, hook-blocked). Travels to the UI for audit
   * display and to clients tracking why a run paused. The model's
   * human-readable copy of this same reason is embedded in the
   * `tool.call.end` result content.
   */
  readonly reason?: import('../permissions/types.js').DecisionReason
}

// ---------------------------------------------------------------------------
// Credentials (HITL — mirrors permission.request/response pattern)
// ---------------------------------------------------------------------------

/**
 * Emitted when a tool asks the user for a secret credential.
 *
 * Deliberately carries NO value field — values are entered by the user
 * out-of-band, encrypted at rest, and only surface via
 * `ToolContext.resolveCredential` inside executor code. UI clients and every
 * other consumer only see metadata (label, hint, placement). SSE payloads
 * are visible in browser DevTools, so a value in this event would
 * directly defeat credential isolation.
 */
export interface CredentialRequestEvent {
  readonly type: 'credential.request'
  readonly requestId: string
  /** Short name the user sees (e.g. "Admin JWT"). */
  readonly label: string
  /** Where the user can find it (e.g. "DevTools > localStorage > token"). */
  readonly hint: string
  /** What the agent will use it for. */
  readonly usage: string
  /** How the credential will be injected at use time. */
  readonly placement: CredentialPlacement
  /** True when the tool cannot proceed without a value. */
  readonly isRequired: boolean
  readonly turnIndex: number
}

/**
 * Emitted after a credential request is resolved — either with a stored
 * credential (`credentialId` non-null, `denied` false) or with a denial
 * (`credentialId` null, `denied` true).
 *
 * As with the request event, no value is ever present here.
 */
export interface CredentialResponseEvent {
  readonly type: 'credential.response'
  readonly requestId: string
  /** Stable id for later resolve() calls. null iff the user denied. */
  readonly credentialId: string | null
  /** Echoed from the request so UIs don't have to hold the request state. */
  readonly label: string
  /** True iff the user denied rather than provided a value. */
  readonly denied: boolean
  readonly turnIndex: number
}

// ---------------------------------------------------------------------------
// Sub-agents
// ---------------------------------------------------------------------------

export interface AgentSpawnEvent {
  readonly type: 'agent.spawn'
  readonly agentId: string
  readonly profileName: string
  readonly parentAgentId: string | null
  readonly turnIndex: number
  /**
   * Orchestration metadata for multi-agent UIs (the fan-out tree, the
   * single-helper card). All optional + back-compat: emitters before these
   * shipped omit them, consumers treat absence as "unknown".
   */
  /** Human-readable worker name (from AgentSpec.name). */
  readonly name?: string
  /** Resolved model id this worker runs on. */
  readonly model?: string
  /** Short digest (≤120 chars) of the worker's task/prompt — for the row label. */
  readonly task?: string
}

/** Terminal state of a spawned agent. Absent on legacy emitters → treat as 'completed'. */
export type AgentTerminalStatus = 'completed' | 'error' | 'aborted'

export interface AgentCompleteEvent {
  readonly type: 'agent.complete'
  readonly agentId: string
  readonly result: string
  readonly durationMs: number
  readonly turnIndex: number
  /**
   * Terminal status. Guaranteed present on current emitters — EVERY non-inline
   * worker emits exactly one agent.complete (success OR error OR abort), so a
   * UI never shows a worker stuck "running" forever. Absent only on legacy
   * rows → treat as 'completed'.
   */
  readonly status?: AgentTerminalStatus
  /** Final token usage + cost. Absent when the worker failed before any model call. */
  readonly usage?: TurnUsage
  /** Number of turns the worker ran. */
  readonly turnCount?: number
  /**
   * Failure message when status is 'error'. Raw — Cortex classifies it into a
   * closed-enum category at the gateway boundary (Loom doesn't own that enum).
   */
  readonly error?: string
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export interface CheckpointSavedEvent {
  readonly type: 'checkpoint.saved'
  readonly checkpointId: string
  readonly turnIndex: number
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export interface SessionStartEvent {
  readonly type: 'session.start'
  readonly sessionId: string
  readonly model: string
  readonly timestamp: number
}

export interface SessionEndEvent {
  readonly type: 'session.end'
  readonly sessionId: string
  readonly reason: StopReason
  readonly totalUsage: TurnUsage
  readonly turnCount: number
  readonly timestamp: number
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

export interface SecurityBlockEvent {
  readonly type: 'security.block'
  readonly toolName: string
  readonly level: string
  readonly reason: string
  readonly command?: string
  readonly turnIndex: number
}

export interface SecurityRedactEvent {
  readonly type: 'security.redact'
  readonly toolName: string
  readonly redactedCount: number
  readonly redactedTypes: readonly string[]
  readonly turnIndex: number
}

export interface AuditEvent {
  readonly type: 'audit.entry'
  readonly entry: {
    readonly toolName: string
    readonly decision: string
    readonly durationMs?: number
  }
  readonly turnIndex: number
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ErrorEvent {
  readonly type: 'error'
  readonly code: string
  readonly message: string
  readonly recoverable: boolean
  readonly turnIndex: number
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type LoomEvent =
  // Session
  | SessionStartEvent
  | SessionEndEvent
  // Turn
  | TurnStartEvent
  | TurnEndEvent
  // Content
  | TextDeltaEvent
  | TextCompleteEvent
  | ThinkingDeltaEvent
  | ThinkingCompleteEvent
  // Tools
  | ToolCallStartEvent
  | ToolCallArgsDeltaEvent
  | ToolCallProgressEvent
  | ToolCallEndEvent
  // Compaction
  | CompactionStartEvent
  | CompactionEndEvent
  | ToolResultDropEvent
  // Context & cache
  | ContextPressureEvent
  | CacheStatusEvent
  // Recovery
  | RecoveryEvent
  // Permissions
  | PermissionRequestEvent
  | PermissionResponseEvent
  // Credentials
  | CredentialRequestEvent
  | CredentialResponseEvent
  // Agents
  | AgentSpawnEvent
  | AgentCompleteEvent
  // Checkpoints
  | CheckpointSavedEvent
  // Security
  | SecurityBlockEvent
  | SecurityRedactEvent
  | AuditEvent
  // Errors
  | ErrorEvent

/**
 * Type guard helpers
 */
export function isToolEvent(event: LoomEvent): event is
  | ToolCallStartEvent
  | ToolCallArgsDeltaEvent
  | ToolCallProgressEvent
  | ToolCallEndEvent {
  return event.type.startsWith('tool.')
}

export function isContentEvent(event: LoomEvent): event is
  | TextDeltaEvent
  | TextCompleteEvent
  | ThinkingDeltaEvent
  | ThinkingCompleteEvent {
  return event.type.startsWith('text.') || event.type.startsWith('thinking.')
}

export function isSecurityEvent(event: LoomEvent): event is
  | SecurityBlockEvent
  | SecurityRedactEvent
  | AuditEvent {
  return event.type.startsWith('security.') || event.type === 'audit.entry'
}

export function isCredentialEvent(event: LoomEvent): event is
  | CredentialRequestEvent
  | CredentialResponseEvent {
  return event.type === 'credential.request' || event.type === 'credential.response'
}
