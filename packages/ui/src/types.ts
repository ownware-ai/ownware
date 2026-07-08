/**
 * @ownware/ui — the headless core of the chat kit.
 *
 * Framework-agnostic types + reducer. Turns the gateway's raw event stream
 * into `ChatState` — the exact shape a UI renders: message rows, streaming
 * text, tool calls (each ready for its uiDescriptor card), and the approval
 * card. Zero runtime dependencies (mirrors @ownware/client). The React
 * binding (@ownware/react) and the vanilla <script> embed both sit on this.
 *
 * The state deliberately mirrors the Studio chat anatomy
 * (.catalyst/design-system-v2/studio): a thread of rows, an open streaming
 * assistant reply, tool cards, and a pending-approval slot.
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
export type ChatStatus = 'idle' | 'streaming' | 'awaiting_approval' | 'error'

export type ToolCallStatus = 'running' | 'done' | 'error'

/**
 * A single tool invocation inside an assistant reply. The renderer attaches
 * the tool's `uiDescriptor` (looked up by `name`) to draw the card; the
 * reducer only captures *what happened* — descriptor-agnostic on purpose.
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
}

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
  /** True while this assistant reply is still receiving events (draws the caret). */
  readonly streaming: boolean
}

/**
 * A paused run waiting on a human decision — a zone 'ask' or a profile
 * `approve` hook. This is the amber approval card. Answer it with
 * `resume(threadId, { action, requestId })`.
 */
export interface PendingApproval {
  readonly requestId: string
  readonly toolName: string
  readonly reason: string
}

/** The whole chat, derived purely from the event stream. What a UI renders. */
export interface ChatState {
  readonly messages: readonly Message[]
  readonly status: ChatStatus
  readonly pendingApproval: PendingApproval | null
  /** The model the gateway actually dispatched (from turn usage), once known. */
  readonly model?: string
  /** Set when status is 'error'. */
  readonly error?: string
  /** Highest gateway seq seen — reconnect with `since: lastSeq` to resume. */
  readonly lastSeq: number
}
