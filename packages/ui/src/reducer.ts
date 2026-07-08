/**
 * The chat reducer — the brain of the UI.
 *
 * `chatReducer(state, event)` folds the gateway's raw event stream
 * (@ownware/client's `.events(threadId)`) into `ChatState`. Pure and
 * deterministic: no IO, no Date.now/Math.random, same events → same state.
 * That makes it trivially testable and safe to run in React's useReducer,
 * a Svelte store, or the vanilla embed.
 *
 * Mapping (event `type` → effect):
 *   user.message           → append a user row
 *   text.delta             → append to the open assistant reply
 *   thinking.delta         → append to its reasoning
 *   tool.call.start        → add a running tool card
 *   tool.call.progress     → update that card's progress line
 *   tool.call.end          → mark it done/error + capture the result
 *   permission.request     → pause: status 'awaiting_approval' + the card
 *   permission.response    → resume: clear the card, back to 'streaming'
 *   turn.end (tool_use)    → keep the reply open (a tool round-trip)
 *   turn.end (terminal)    → close the reply, status 'idle'
 *   turn.interrupted/error → close the reply, status 'error'
 */

import type { AgentEvent, ChatState, Message, ToolCall } from './types.js'

/** Stop reasons on a `turn.end` that mean the loop CONTINUES (not the reply's end). */
const CONTINUE_STOP_REASONS = new Set<string>(['tool_use', 'pause_turn'])

export function initialChatState(): ChatState {
  return { messages: [], status: 'idle', pendingApproval: null, lastSeq: 0 }
}

/** Fold a sequence of events onto a state (convenience for hydrate + tests). */
export function applyEvents(state: ChatState, events: Iterable<AgentEvent>): ChatState {
  let s = state
  for (const e of events) s = chatReducer(s, e)
  return s
}

/**
 * Optimistically add the user's own prompt so it shows the instant they hit
 * send — for UIs that DON'T also render the stream's `user.message` (avoid
 * doing both, or the row doubles). Sets status to 'streaming'.
 */
export function addUserMessage(state: ChatState, text: string, id?: string): ChatState {
  const msg: Message = {
    id: id ?? `u-local-${state.messages.length}`,
    role: 'user',
    text,
    toolCalls: [],
    streaming: false,
  }
  return { ...state, messages: [...state.messages, msg], status: 'streaming' }
}

export function chatReducer(state: ChatState, event: AgentEvent): ChatState {
  const data = event.data ?? {}
  const seq = typeof event.seq === 'number' ? event.seq : state.lastSeq
  const lastSeq = Math.max(state.lastSeq, seq)

  switch (event.type) {
    case 'user.message': {
      const text = readString(data, 'text') || readString(data, 'content') || readString(data, 'prompt')
      if (!text) return { ...state, lastSeq }
      const msg: Message = { id: `u${seq}`, role: 'user', text, toolCalls: [], streaming: false }
      return { ...state, messages: [...state.messages, msg], status: 'streaming', lastSeq }
    }

    case 'text.delta': {
      const { list, idx } = ensureOpenAssistant(state.messages, seq)
      const cur = list[idx]!
      list[idx] = { ...cur, text: cur.text + readString(data, 'text') }
      return { ...state, messages: list, status: 'streaming', lastSeq }
    }

    case 'text.complete': {
      // Deltas normally build the text; only honor `complete` if nothing streamed.
      const last = state.messages[state.messages.length - 1]
      if (last && last.role === 'assistant' && last.text.length > 0) return { ...state, lastSeq }
      const { list, idx } = ensureOpenAssistant(state.messages, seq)
      list[idx] = { ...list[idx]!, text: readString(data, 'text') }
      return { ...state, messages: list, status: 'streaming', lastSeq }
    }

    case 'thinking.delta': {
      const { list, idx } = ensureOpenAssistant(state.messages, seq)
      const cur = list[idx]!
      list[idx] = { ...cur, thinking: (cur.thinking ?? '') + readString(data, 'text') }
      return { ...state, messages: list, status: 'streaming', lastSeq }
    }

    case 'tool.call.start': {
      const { list, idx } = ensureOpenAssistant(state.messages, seq)
      const cur = list[idx]!
      const call: ToolCall = {
        id: readString(data, 'toolCallId'),
        name: readString(data, 'toolName'),
        input: readObject(data, 'input'),
        status: 'running',
      }
      list[idx] = { ...cur, toolCalls: [...cur.toolCalls, call] }
      return { ...state, messages: list, status: 'streaming', lastSeq }
    }

    case 'tool.call.progress': {
      const id = readString(data, 'toolCallId')
      const progress = readString(data, 'progress')
      return { ...state, messages: updateToolCall(state.messages, id, (c) => ({ ...c, progress })), lastSeq }
    }

    case 'tool.call.end': {
      const id = readString(data, 'toolCallId')
      const isError = data['isError'] === true
      return {
        ...state,
        messages: updateToolCall(state.messages, id, (c) => ({
          ...c,
          status: isError ? 'error' : 'done',
          result: readString(data, 'result'),
          isError,
          durationMs: readNumber(data, 'durationMs'),
        })),
        lastSeq,
      }
    }

    case 'permission.request': {
      const requestId = readString(data, 'requestId')
      if (!requestId) return { ...state, lastSeq }
      return {
        ...state,
        status: 'awaiting_approval',
        pendingApproval: {
          requestId,
          toolName: readString(data, 'toolName') || 'unknown',
          reason: readString(data, 'reason') || 'Tool requires explicit approval',
        },
        lastSeq,
      }
    }

    case 'permission.response': {
      // The human answered; the run resumes.
      return { ...state, status: 'streaming', pendingApproval: null, lastSeq }
    }

    case 'turn.end': {
      const stopReason = readString(data, 'stopReason') || 'end_turn'
      const model = readString(readObject(data, 'usage'), 'model') || state.model
      if (CONTINUE_STOP_REASONS.has(stopReason)) {
        // A tool round-trip — the reply keeps streaming after the tool returns.
        return { ...state, model, lastSeq }
      }
      return { ...state, messages: closeOpenAssistant(state.messages), status: 'idle', model, lastSeq }
    }

    case 'turn.interrupted': {
      const reason = readString(data, 'reason') || 'interrupted'
      return { ...state, messages: closeOpenAssistant(state.messages), status: 'error', error: `run ${reason}`, lastSeq }
    }

    case 'error': {
      const message = readString(data, 'message') || 'agent error'
      return { ...state, messages: closeOpenAssistant(state.messages), status: 'error', error: message, lastSeq }
    }

    case 'stream.shutdown': {
      const reason = readString(data, 'reason') || 'closed'
      return { ...state, messages: closeOpenAssistant(state.messages), status: 'error', error: `stream ${reason}`, lastSeq }
    }

    case 'session.start': {
      const model = readString(data, 'model') || state.model
      return { ...state, model, lastSeq }
    }

    default:
      // Unknown/ignored event — still advance the resume cursor.
      return lastSeq === state.lastSeq ? state : { ...state, lastSeq }
  }
}

// ── internals ────────────────────────────────────────────────────────────────

/**
 * Ensure the last row is an OPEN streaming assistant reply (creating one keyed
 * by `seq` if the last row is a user turn or a closed reply). Returns a mutable
 * copy of the list + the index of that reply. Callers replace `list[idx]` with
 * a NEW message object (never mutate the existing one).
 */
function ensureOpenAssistant(messages: readonly Message[], seq: number): { list: Message[]; idx: number } {
  const list = messages.slice()
  const last = list[list.length - 1]
  if (last && last.role === 'assistant' && last.streaming) {
    return { list, idx: list.length - 1 }
  }
  list.push({ id: `a${seq}`, role: 'assistant', text: '', toolCalls: [], streaming: true })
  return { list, idx: list.length - 1 }
}

/** Close the open assistant reply (streaming → false), if there is one. */
function closeOpenAssistant(messages: readonly Message[]): Message[] {
  const list = messages.slice()
  const i = list.length - 1
  const last = list[i]
  if (last && last.role === 'assistant' && last.streaming) list[i] = { ...last, streaming: false }
  return list
}

/** Replace a tool call (found by id) inside whichever message holds it. */
function updateToolCall(
  messages: readonly Message[],
  id: string,
  fn: (c: ToolCall) => ToolCall,
): Message[] {
  return messages.map((m) =>
    m.toolCalls.some((c) => c.id === id)
      ? { ...m, toolCalls: m.toolCalls.map((c) => (c.id === id ? fn(c) : c)) }
      : m,
  )
}

function readString(data: Record<string, unknown>, key: string): string {
  const v = data[key]
  return typeof v === 'string' ? v : ''
}

function readNumber(data: Record<string, unknown>, key: string): number | undefined {
  const v = data[key]
  return typeof v === 'number' ? v : undefined
}

function readObject(data: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = data[key]
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}
