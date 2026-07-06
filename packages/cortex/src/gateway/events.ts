/**
 * Gateway Event Contract — single source of truth for the SSE wire format.
 *
 * Every event a Cortex client can receive from the gateway is
 * typed here. The contract is the union of:
 *
 *   1. All of Loom's core agent events — re-exported from @ownware/loom so
 *      there is exactly one definition in the whole repo. No mirroring, no
 *      drift. If Loom renames a field, every caller of these types fails
 *      to compile — exactly what we want.
 *
 *   2. Three gateway-owned wrapper events that Loom knows nothing about:
 *        - stream.start             — opens the SSE channel, carries resume
 *                                     metadata (threadId, agentId, since,
 *                                     maxSeqAtStart).
 *        - stream.replay.complete   — emitted once historical DB events have
 *                                     been flushed; everything after is live.
 *        - stream.shutdown          — emitted when the gateway is restarting
 *                                     so clients can back off intentionally.
 *        - done                     — emitted right before the gateway ends
 *                                     the HTTP response.
 *
 * Runtime direction is strictly one-way: Loom emits agent events, the gateway
 * wraps them into the SSE transport, UI clients consume. Clients do NOT
 * import from Loom directly — they pull these types through the gateway
 * tsconfig path alias, which is why this file lives in packages/cortex.
 */

// ── Loom core agent events — re-exported, not redefined ────────────────────

export type {
  // Discriminated union
  LoomEvent,

  // Supporting primitives
  StopReason,
  TurnUsage,

  // Session
  SessionStartEvent,
  SessionEndEvent,

  // Turn
  TurnStartEvent,
  TurnEndEvent,

  // Content
  TextDeltaEvent,
  TextCompleteEvent,
  ThinkingDeltaEvent,
  ThinkingCompleteEvent,

  // Tools
  ToolCallStartEvent,
  ToolCallArgsDeltaEvent,
  ToolCallProgressEvent,
  ToolCallEndEvent,

  // Compaction
  CompactionStartEvent,
  CompactionEndEvent,

  // Context + cache
  ContextPressureEvent,
  CacheStatusEvent,

  // Recovery
  RecoveryEvent,

  // Permissions
  PermissionRequestEvent,
  PermissionResponseEvent,

  // Credentials
  CredentialRequestEvent,
  CredentialResponseEvent,
  CredentialPlacement,
  CredentialHandle,
  EnvCredentialEntry,

  // Sub-agents
  AgentSpawnEvent,
  AgentCompleteEvent,

  // Checkpoints
  CheckpointSavedEvent,

  // Security
  SecurityBlockEvent,
  SecurityRedactEvent,
  AuditEvent,

  // Errors
  ErrorEvent,
} from '@ownware/loom'

// ── Gateway wrapper events (SSE transport layer) ───────────────────────────

/**
 * Sent once when the gateway opens an SSE stream. Carries the resume cursor
 * so a reconnecting client can compare against the server's authoritative
 * max sequence number and know whether it has missed events.
 */
export interface StreamStartEvent {
  readonly type: 'stream.start'
  readonly threadId: string
  readonly agentId: string
  /** The `?since=N` cursor the client requested (0 for a fresh connection). */
  readonly since: number
  /** The highest sequence number on disk when the stream opened. */
  readonly maxSeqAtStart: number
}

/**
 * Emitted after the gateway has finished flushing historical DB events.
 * Every event after this one is live, not replayed.
 */
export interface StreamReplayCompleteEvent {
  readonly type: 'stream.replay.complete'
  readonly threadId: string
  readonly agentId: string
  readonly since: number
  /** The last sequence number included in the replay. */
  readonly replayedThroughSeq: number
  readonly maxSeqAtStart: number
  /** True if the agent is still running — subsequent events will stream live. */
  readonly liveTail: boolean
}

/**
 * Emitted when the gateway intentionally tears down a stream and wants
 * the client to distinguish that from a generic network failure.
 *
 * Reason codes:
 *   `gateway_shutdown` — gateway process is restarting; reconnect after
 *                        the suggested delay.
 *   `slow_consumer`    — this client could not keep up with the live
 *                        write rate; the gateway dropped the socket to
 *                        protect memory. The client should back off, reload
 *                        via /hydrate, and only reopen SSE for live
 *                        threads.
 */
export interface StreamShutdownEvent {
  readonly type: 'stream.shutdown'
  readonly threadId?: string
  readonly agentId?: string
  readonly reason: 'gateway_shutdown' | 'slow_consumer'
  /** Suggested reconnect delay in milliseconds. */
  readonly retryAfterMs: number
}

/**
 * Emitted right before the gateway closes the HTTP response. Terminal.
 */
export interface StreamDoneEvent {
  readonly type: 'done'
  readonly status: 'complete' | 'aborted' | 'error'
}

import type { AttachmentMeta } from './types.js'

/**
 * The user's prompt, written into the agent_events log at the start of
 * every run so a replay stream is self-contained. Loom never emits this
 * (user input is not an agent event), so it lives in the gateway-owned
 * event union instead of Loom's core event set.
 *
 * The client's reducer consumes it to draw the user turn bubble without
 * having to cross-reference the messages table.
 */
export interface UserMessageEvent {
  readonly type: 'user.message'
  readonly text: string
  readonly attachments: readonly AttachmentMeta[] | null
  readonly timestamp: number
}

/**
 * Emitted when a run terminates without a preceding `turn.end`. Tells
 * the client that the last assistant turn is partial — accumulators were
 * flushed to `messages` as a best-effort snapshot, but no `turn.end`
 * closed the exchange. Used to render the "Run interrupted" badge on
 * the trailing assistant bubble.
 *
 * Emitted exactly once per terminated run, after the gateway has
 * finalized the partial turn in the messages table.
 */
export interface TurnInterruptedEvent {
  readonly type: 'turn.interrupted'
  readonly reason: 'aborted' | 'error' | 'timeout' | 'shutdown'
  readonly turnIndex: number
  readonly hadContent: boolean
  readonly hadTools: boolean
  readonly hadSubAgents: boolean
  readonly hadPendingPermissions: boolean
  /**
   * True iff the turn was flushed with at least one credential HITL that
   * never received a response. Lets the client show a distinct "was waiting
   * on credential" badge vs. generic "interrupted" on a hydrated row.
   *
   * Always emitted (set unconditionally in `flushPartialTurn`). Required
   * on the wire — server and client ship together in this repo, so a
   * missing field is a version mismatch and should fail Zod validation
   * loudly rather than silently coerce to false.
   */
  readonly hadPendingCredentials: boolean
  readonly timestamp: number
}

/**
 * Emitted by the gateway resolver when a tool's `requires` declaration
 * cannot be satisfied — the canonical credential isn't in the unified
 * store (board: credentials-unification — C34/C35).
 *
 * The client's chat-stream subscriber mounts an inline
 * `<MissingCredentialCard>` against this event. The card surfaces the
 * descriptor's name + description + getKeyUrl and lets the user paste a
 * value. After `POST /credentials`, the gateway resumes the paused run.
 *
 * Wire shape mirrors the descriptor on `Tool.requires` so the card has
 * everything it needs without a follow-up fetch.
 */
export interface CredentialMissingEvent {
  readonly type: 'credential.missing'
  readonly threadId: string
  readonly agentId: string
  /** Stable id for the missing-credential request. The card POSTs back
   *  to `/credentials` and the gateway correlates by this id. */
  readonly requestId: string
  readonly variableName: string
  readonly description: string
  readonly getKeyUrl?: string
  readonly authType:
    | 'api-key'
    | 'oauth2'
    | 'bearer-token'
    | 'basic'
  readonly category?: 'llm' | 'tool' | 'oauth' | 'mcp-server'
  readonly forConnector?: string
  readonly placeholder?: string
  readonly toolName?: string
  readonly timestamp: number
}

/**
 * Emitted by the gateway when the user fills (or dismisses) a missing
 * credential the agent was waiting on. The chat-stream subscriber
 * unmounts the corresponding card on this event.
 */
export interface CredentialResolvedEvent {
  readonly type: 'credential.resolved'
  readonly threadId: string
  readonly agentId: string
  readonly requestId: string
  /**
   *   - `saved`     — user pasted a value; run resumes.
   *   - `skipped`   — user clicked Skip; run resumes with sentinel.
   *   - `cancelled` — user clicked Cancel; run aborts.
   */
  readonly outcome: 'saved' | 'skipped' | 'cancelled'
  readonly timestamp: number
}

/**
 * Emitted on the dedicated credentials SSE channel
 * (`GET /api/v1/credentials/events`) whenever a credential CRUD handler
 * mutates the unified store. Audit #5 H1 (2026-05-16): before this
 * event existed, multi-window clients drifted up to 10s + a focus
 * refetch behind reality because the only fan-out was the HTTP
 * response itself.
 *
 * The shape is intentionally minimal — invalidate-only.
 *
 *   - `credentialId`: stable id of the affected row (`cred_<uuid>`).
 *   - `action`: which CRUD verb produced the event. Lets clients
 *     scope optimistic UI ("the row I just created is now durable")
 *     vs. plain "something changed, refetch."
 *   - `at`: ISO emission timestamp; useful for last-write-wins
 *     reconciliation across multiple subscribers.
 *
 * **Principle 5 invariant — non-negotiable:** the event carries NO
 * plaintext value, NO masked hint, NO row metadata beyond the id.
 * Clients re-fetch via `GET /api/v1/credentials/:id` (or the list
 * endpoint) to learn the new state. This event is the trigger, not
 * the payload.
 */
export interface CredentialChangedEvent {
  readonly type: 'credential.changed'
  readonly credentialId: string
  readonly action: 'created' | 'updated' | 'deleted' | 'validated'
  /** ISO 8601 with offset, e.g. `2026-05-16T12:34:56.789Z`. */
  readonly at: string
}

/**
 * Emitted on the dedicated workspaces SSE channel
 * (`GET /api/v1/workspaces/events`) whenever a workspace CRUD handler
 * mutates the workspaces table. Audit #2 C2 / F1a (2026-05-16): before
 * this event existed, multi-window clients drifted up to 10 s + a focus
 * refetch behind reality because the only fan-out was the HTTP response
 * itself.
 *
 * The shape is intentionally minimal — invalidate-only.
 *
 *   - `workspaceId`: stable id of the affected row.
 *   - `action`: which CRUD verb produced the event. `archived` is
 *     split out from `updated` so future consumers can drop the row
 *     from active-only views without waiting for the refetch.
 *   - `at`: ISO emission timestamp; useful for last-write-wins
 *     reconciliation across multiple subscribers.
 *
 * **Principle 5 invariant — non-negotiable:** the event carries NO
 * `name`, NO `path`, NO `description`, NO row metadata beyond the id.
 * Clients re-fetch via `GET /api/v1/workspaces` to learn the new
 * state. This event is the trigger, not the payload.
 *
 * Like `CredentialChangedEvent` and `ConnectorStatusEvent`, this is a
 * separate channel — NOT part of the `GatewayEvent` union (that union
 * is the agent-events channel only).
 */
export interface WorkspaceChangedEvent {
  readonly type: 'workspace.changed'
  readonly workspaceId: string
  readonly action: 'created' | 'updated' | 'archived' | 'deleted'
  /** ISO 8601 with offset, e.g. `2026-05-16T12:34:56.789Z`. */
  readonly at: string
}

/**
 * Emitted on the dedicated per-workspace pane SSE channel
 * (`GET /api/v1/workspaces/:wsId/panes/events`) whenever a pane CRUD
 * handler mutates the workspace_panes table. Audit #2 C3 / F1b
 * (2026-05-16, Chunk #20): before this event existed, multi-window
 * clients drifted up to 2 s + a focus refetch behind reality for
 * pane mutations because the only fan-out was the HTTP response
 * itself.
 *
 * The shape is intentionally minimal — invalidate-only.
 *
 *   - `wsId`: stable id of the workspace the pane belongs to. Used by
 *     the bus to fan out to the right subscribers and by the client
 *     to confirm the event matches its current workspace.
 *   - `paneId`: stable id of the affected pane. Optional for the
 *     `moved` action — a zone reorder is a zone-level transition,
 *     no single pane identifies it.
 *   - `action`: which CRUD verb produced the event. `moved` is split
 *     out from `updated` because a reorder spans every pane in a
 *     zone; subscribers may want to invalidate differently (today
 *     they don't — the full pane list refetch covers both).
 *   - `paneKind`: optional cheap hint (chat / tasks / files / …) so
 *     consumers can invalidate type-specific child caches without
 *     a follow-up round-trip.
 *   - `at`: ISO emission timestamp; useful for last-write-wins
 *     reconciliation across multiple subscribers.
 *
 * **Principle 5 invariant — non-negotiable:** the event carries NO
 * `title`, NO `config` (which may carry file paths or chat ids), NO
 * `metadata`, NO `position`. Clients re-fetch via
 * `GET /api/v1/workspaces/:wsId/panes` to learn the new state. This
 * event is the trigger, not the payload.
 *
 * Like the workspace / credential channels, this is a separate
 * channel — NOT part of the `GatewayEvent` union (that union is the
 * agent-events channel only).
 */
export interface PaneChangedEvent {
  readonly type: 'pane.changed'
  readonly wsId: string
  /** Absent for `action: 'moved'` (zone-level reorder); set for every other action. */
  readonly paneId?: string
  readonly action: 'created' | 'updated' | 'moved' | 'deleted'
  /** Optional kind hint so consumers can scope sibling-cache fan-out. */
  readonly paneKind?: string
  /** ISO 8601 with offset, e.g. `2026-05-16T12:34:56.789Z`. */
  readonly at: string
}

// ── Unified gateway event ──────────────────────────────────────────────────

import type { LoomEvent } from '@ownware/loom'

/**
 * The full set of events any SSE client can receive from
 * `GET /api/v1/threads/:threadId/agents/:agentId/events`.
 *
 * This is the wire contract. Adding a new event type means adding it to
 * Loom first (if it's agent-domain) or adding a new wrapper here (if it's
 * transport-level), never both.
 */
export type GatewayEvent =
  | LoomEvent
  | StreamStartEvent
  | StreamReplayCompleteEvent
  | StreamShutdownEvent
  | StreamDoneEvent
  | UserMessageEvent
  | TurnInterruptedEvent
  | CredentialMissingEvent
  | CredentialResolvedEvent
