/**
 * Interpreting a root-agent SSE stream as ONE run's reply.
 *
 * The legacy thread SSE stays open for future turns; the bounded run SSE
 * closes after its terminal event. Neither sends a synthetic `done` frame,
 * so a single reply completes at terminal `turn.end` (stopReason not in
 * {tool_use, pause_turn}), or on turn.interrupted / error / stream.shutdown.
 * `interpretSseEvent` encodes exactly that.
 */

/** One event from a single run's reply, carrying the gateway seq (resume cursor). */
export type RunStreamEvent =
  | { readonly type: 'delta'; readonly text: string; readonly seq: number }
  | { readonly type: 'done'; readonly seq: number }
  | { readonly type: 'error'; readonly message: string; readonly seq: number }
  /**
   * The run PAUSED on a human decision (a zone 'ask' or a profile
   * `approve` hook). The run is still live — nothing streams until
   * someone answers via `decidePermission(runId, requestId, {
   * decision: 'approve'|'deny', operationHash })` or the gateway's HITL timeout denies it. Consumers
   * that ignore this member keep the old behaviour (silent wait).
   */
  | {
      readonly type: 'permission'
      readonly requestId: string
      readonly toolName: string
      readonly reason: string
      readonly operationHash?: string
      readonly seq: number
    }

/** Stop reasons on a `turn.end` that mean the loop CONTINUES (not the run's end). */
const CONTINUE_STOP_REASONS = new Set(['tool_use', 'pause_turn'])

/**
 * Interpret one parsed SSE event for a root-agent run. Pure and testable —
 * no IO. Returns the RunStreamEvent to emit (if any), whether this event ends
 * the run, and the seq to carry forward as the resume cursor.
 */
export function interpretSseEvent(
  eventName: string,
  data: Record<string, unknown>,
  lastSeq: number,
): { event?: RunStreamEvent; stop: boolean; seq: number } {
  const seq = typeof data['seq'] === 'number' ? (data['seq'] as number) : lastSeq
  const type = typeof data['type'] === 'string' ? (data['type'] as string) : eventName

  switch (type) {
    case 'text.delta': {
      const text = typeof data['text'] === 'string' ? (data['text'] as string) : ''
      return { event: { type: 'delta', text, seq }, stop: false, seq }
    }
    case 'permission.request': {
      // Surface the pause instead of silently waiting: without this, a
      // channel-bound run that hits an approval hangs invisibly until
      // the HITL timeout denies it. The run continues (stop: false) —
      // the answer arrives out-of-band via the exact run permission route.
      const requestId = typeof data['requestId'] === 'string' ? (data['requestId'] as string) : ''
      const toolName = typeof data['toolName'] === 'string' ? (data['toolName'] as string) : 'unknown'
      const reason =
        typeof data['reason'] === 'string' && (data['reason'] as string).length > 0
          ? (data['reason'] as string)
          : 'Tool requires explicit approval'
      const operationHash = typeof data['operationHash'] === 'string'
        ? (data['operationHash'] as string)
        : undefined
      if (requestId === '') return { stop: false, seq }
      return {
        event: {
          type: 'permission',
          requestId,
          toolName,
          reason,
          ...(operationHash !== undefined ? { operationHash } : {}),
          seq,
        },
        stop: false,
        seq,
      }
    }
    case 'turn.end': {
      const reason = typeof data['stopReason'] === 'string' ? (data['stopReason'] as string) : 'end_turn'
      if (CONTINUE_STOP_REASONS.has(reason)) return { stop: false, seq }
      return { event: { type: 'done', seq }, stop: true, seq }
    }
    case 'turn.interrupted': {
      const reason = typeof data['reason'] === 'string' ? (data['reason'] as string) : 'interrupted'
      return { event: { type: 'error', message: `run ${reason}`, seq }, stop: true, seq }
    }
    case 'error': {
      const message = typeof data['message'] === 'string' ? (data['message'] as string) : 'agent error'
      return { event: { type: 'error', message, seq }, stop: true, seq }
    }
    case 'stream.shutdown': {
      const reason = typeof data['reason'] === 'string' ? (data['reason'] as string) : 'closed'
      return { event: { type: 'error', message: `stream ${reason}`, seq }, stop: true, seq }
    }
    default:
      return { stop: false, seq }
  }
}
