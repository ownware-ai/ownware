/**
 * @ownware/ui — the headless core of the chat kit.
 *
 * Framework-agnostic types + reducer. Turns the gateway's raw event stream
 * into `ChatState` — the exact shape a UI renders: message rows, streaming
 * text, tool calls (each ready for its uiDescriptor card), and the approval
 * card. Zero runtime dependencies (mirrors @ownware/client). React and
 * terminal clients can consume the same state model.
 */

/**
 * One raw gateway event. Structurally identical to @ownware/client's
 * `GatewayEvent` ({ type, seq, data }) — redefined here so this core has
 * ZERO dependencies and builds standalone. The React binding passes the
 * client's events straight in (they're the same shape).
 */
export interface AgentEvent {
  readonly type: string
  /** Monotonic gateway sequence — the resume cursor. */
  readonly seq: number
  /** The event payload (the SSE frame's JSON). Read defensively. */
  readonly data: Record<string, unknown>
}

/** Where the run is right now. Drives the composer / caret / approval card. */
export type ChatStatus =
  | 'idle'
  | 'streaming'
  | 'awaiting_approval'
  | 'awaiting_sensitive_input'
  | 'error'

export type ToolCallStatus = 'running' | 'done' | 'error'

/**
 * A single tool invocation inside an assistant reply. Tool lifecycle success
 * is not proof of an external effect; evidence selectors keep those facts
 * separate. Descriptors control presentation only.
 */
export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
  readonly status: ToolCallStatus
  /** Latest progress line, if the tool streamed one. */
  readonly progress?: string
  /** The tool's output (present once status is done/error). */
  readonly result?: string
  readonly isError?: boolean
  readonly durationMs?: number
  /** Exact presentation descriptor published with this tool call, when supported. */
  readonly uiDescriptor?: import('./descriptors.js').ToolUIDescriptor
  /** True when replay/hydration omitted the matching start observation. */
  readonly partial?: boolean
}

/** Ordered observations within one message. IDs remain opaque correlations. */
export type MessagePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'tool'; readonly toolCallId: string }
  | { readonly kind: 'subagent'; readonly agentId: string }
  | { readonly kind: 'permission'; readonly requestId: string }
  | { readonly kind: 'credential'; readonly requestId: string }

/** One row in the thread — a user turn or an assistant reply. */
export interface Message {
  readonly id: string
  readonly role: 'user' | 'assistant'
  /** Accumulated visible text. */
  readonly text: string
  /** Accumulated reasoning, if the model streamed thinking. */
  readonly thinking?: string
  /** Tool cards under this reply, in call order. */
  readonly toolCalls: readonly ToolCall[]
  /** Exact durable/live ordering when supplied by the Gateway. */
  readonly parts?: readonly MessagePart[]
  /** True while this assistant reply is still receiving events (draws the caret). */
  readonly streaming: boolean
}

/**
 * A paused run waiting on a human decision. Current Gateways require the
 * run-scoped request id and operation hash; the reducer never authorizes the
 * mutation itself.
 */
export interface PendingApproval {
  readonly requestId: string
  readonly toolName: string
  readonly reason: string
  /** Exact run-scoped intent identity. Required by current Gateways. */
  readonly operationHash?: string
  readonly intentRevision?: 1
}

/** Metadata-only request for the dedicated non-event sensitive-value channel. */
export interface PendingSensitiveInput {
  readonly requestId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly label: string
  readonly usage: string
  readonly agentId: string | null
  readonly adapterRevision: string
}

/** Content-free evidence that an exact skill body entered a conversation. */
export interface SkillActivationEvidence {
  readonly activationId: string
  readonly skillName: string
  readonly skillDigest: string
  readonly sourceRef: string
  readonly sourceDigest: string
  readonly agentId: string | null
  readonly toolCallId: string | null
  readonly turnIndex: number
  readonly timestamp: number
}

export type StreamProjectionPhase =
  | 'idle'
  | 'replaying'
  | 'live'
  | 'reconnecting'
  | 'resync_required'
  | 'closed'

export interface StreamProjection {
  readonly phase: StreamProjectionPhase
  readonly lastDeliveredSeq: number
  readonly expectedNextSeq: number | null
  /** Unknown additive observations retained for honest host diagnostics. */
  readonly unsupportedEventTypes: readonly string[]
}

/** The whole chat, derived purely from the event stream. What a UI renders. */
export interface ChatState {
  readonly messages: readonly Message[]
  readonly status: ChatStatus
  /** First pending request, retained for compatibility with existing renderers. */
  readonly pendingApproval: PendingApproval | null
  /** Every exact outstanding request; helpers may park more than one. */
  readonly pendingApprovals: readonly PendingApproval[]
  /** First dedicated sensitive-input request, for compact renderers. */
  readonly pendingSensitiveInput: PendingSensitiveInput | null
  readonly pendingSensitiveInputs: readonly PendingSensitiveInput[]
  /** Dispatcher evidence only; never behavioral-compliance proof. */
  readonly skillActivations: readonly SkillActivationEvidence[]
  readonly connection: StreamProjection
  /** The model the gateway actually dispatched (from turn usage), once known. */
  readonly model?: string
  /** Set when status is 'error'. */
  readonly error?: string
  /** Highest gateway seq seen — reconnect with `since: lastSeq` to resume. */
  readonly lastSeq: number
}
