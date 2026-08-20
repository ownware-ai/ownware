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

import type {
  AgentEvent,
  ChatState,
  Message,
  MessagePart,
  PendingApproval,
  PendingSensitiveInput,
  SkillActivationEvidence,
  ToolCall,
} from './types.js'
import { normalizeToolUIDescriptor } from './descriptors.js'

/** Stop reasons on a `turn.end` that mean the loop CONTINUES (not the reply's end). */
const CONTINUE_STOP_REASONS = new Set<string>(['tool_use', 'pause_turn'])

export function initialChatState(): ChatState {
  return {
    messages: [],
    status: 'idle',
    pendingApproval: null,
    pendingApprovals: [],
    pendingSensitiveInput: null,
    pendingSensitiveInputs: [],
    skillActivations: [],
    connection: {
      phase: 'idle',
      lastDeliveredSeq: 0,
      expectedNextSeq: 1,
      unsupportedEventTypes: [],
    },
    lastSeq: 0,
  }
}

/** Fold a sequence of events onto a state (convenience for hydrate + tests). */
export function applyEvents(state: ChatState, events: Iterable<AgentEvent>): ChatState {
  let s = state
  for (const e of events) s = chatReducer(s, e)
  return s
}

/** Seed a reducer from an authoritative hydrate/replay cursor. */
export function seedReplayCursor(state: ChatState, since: number): ChatState {
  if (!Number.isSafeInteger(since) || since < 0) return state
  return {
    ...state,
    lastSeq: since,
    connection: {
      ...state.connection,
      phase: 'replaying',
      lastDeliveredSeq: since,
      expectedNextSeq: since + 1,
    },
  }
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
    parts: [{ kind: 'text', text }],
    streaming: false,
  }
  return { ...state, messages: [...state.messages, msg], status: 'streaming' }
}

export function chatReducer(state: ChatState, event: AgentEvent): ChatState {
  const data = event.data ?? {}
  if (event.type === 'stream.start') return reduceStreamStart(state, data)
  if (event.type === 'stream.replay.complete') return reduceReplayComplete(state, data)
  if (event.type === 'stream.shutdown') return reduceStreamShutdown(state, data)
  if (event.type === 'done') {
    return {
      ...state,
      connection: { ...state.connection, phase: 'closed', expectedNextSeq: null },
    }
  }
  const seq = event.seq
  if (!Number.isSafeInteger(seq) || seq < 0) return state
  if (seq > 0 && seq <= state.lastSeq) return state
  if (
    seq > 0
    && state.connection.lastDeliveredSeq > 0
    && seq > state.lastSeq + 1
  ) {
    return {
      ...state,
      connection: {
        ...state.connection,
        phase: 'resync_required',
        expectedNextSeq: state.lastSeq + 1,
      },
    }
  }
  const lastSeq = seq > 0 ? seq : state.lastSeq
  const base: ChatState = {
    ...state,
    lastSeq,
    connection: {
      ...state.connection,
      phase: state.connection.phase === 'replaying' ? 'replaying' : 'live',
      lastDeliveredSeq: lastSeq,
      expectedNextSeq: lastSeq + 1,
    },
  }

  switch (event.type) {
    case 'user.message': {
      const text = readString(data, 'text') || readString(data, 'content') || readString(data, 'prompt')
      if (!text) return base
      const msg: Message = {
        id: `u${seq}`,
        role: 'user',
        text,
        toolCalls: [],
        parts: [{ kind: 'text', text }],
        streaming: false,
      }
      return {
        ...base,
        messages: reconcileOptimisticUser(base.messages, msg),
        status: 'streaming',
        error: undefined,
      }
    }

    case 'text.delta': {
      const { list, idx } = ensureOpenAssistant(base.messages, seq)
      const cur = list[idx]!
      const text = readString(data, 'text')
      list[idx] = {
        ...cur,
        text: cur.text + text,
        parts: appendMessagePart(cur.parts, { kind: 'text', text }),
      }
      return { ...base, messages: list, status: 'streaming' }
    }

    case 'text.complete': {
      // Deltas normally build the text; only honor `complete` if nothing streamed.
      const last = base.messages[base.messages.length - 1]
      if (last && last.role === 'assistant' && last.text.length > 0) return base
      const { list, idx } = ensureOpenAssistant(base.messages, seq)
      const text = readString(data, 'text')
      list[idx] = {
        ...list[idx]!,
        text,
        parts: text.length === 0 ? [] : [{ kind: 'text', text }],
      }
      return { ...base, messages: list, status: 'streaming' }
    }

    case 'thinking.delta': {
      const { list, idx } = ensureOpenAssistant(base.messages, seq)
      const cur = list[idx]!
      const text = readString(data, 'text')
      list[idx] = {
        ...cur,
        thinking: (cur.thinking ?? '') + text,
        parts: appendMessagePart(cur.parts, { kind: 'thinking', text }),
      }
      return { ...base, messages: list, status: 'streaming' }
    }

    case 'tool.call.start': {
      const toolCallId = readString(data, 'toolCallId')
      const toolName = readString(data, 'toolName')
      if (!toolCallId || !toolName) return rememberUnsupported(base, event.type)
      const { list, idx } = ensureOpenAssistant(base.messages, seq)
      const cur = list[idx]!
      const call: ToolCall = {
        id: toolCallId,
        name: toolName,
        input: readObject(data, 'input'),
        status: 'running',
        ...descriptorProperty(data['uiDescriptor']),
      }
      list[idx] = {
        ...cur,
        toolCalls: cur.toolCalls.some(existing => existing.id === call.id)
          ? cur.toolCalls
          : [...cur.toolCalls, call],
        parts: appendToolPart(cur.parts, call.id),
      }
      return { ...base, messages: list, status: 'streaming' }
    }

    case 'tool.call.progress': {
      const id = readString(data, 'toolCallId')
      if (!id) return rememberUnsupported(base, event.type)
      const progress = readString(data, 'progress')
      return {
        ...base,
        messages: updateOrInsertToolCall(base.messages, seq, id, {
          id,
          name: readString(data, 'toolName') || 'unknown',
          input: {},
          status: 'running',
          progress,
          partial: true,
        }, (call) => ({ ...call, progress })),
      }
    }

    case 'tool.call.end': {
      const id = readString(data, 'toolCallId')
      const toolName = readString(data, 'toolName')
      if (!id || !toolName) return rememberUnsupported(base, event.type)
      const isError = data['isError'] === true
      return {
        ...base,
        messages: updateOrInsertToolCall(base.messages, seq, id, {
          id,
          name: toolName,
          input: {},
          status: isError ? 'error' : 'done',
          result: readString(data, 'result'),
          isError,
          durationMs: readNumber(data, 'durationMs'),
          partial: true,
          ...descriptorProperty(data['uiDescriptor']),
        }, (call) => ({
          ...call,
          status: isError ? 'error' : 'done',
          result: readString(data, 'result'),
          isError,
          durationMs: readNumber(data, 'durationMs'),
          ...descriptorProperty(data['uiDescriptor']),
        })),
      }
    }

    case 'permission.request': {
      const requestId = readString(data, 'requestId')
      if (!requestId) return base
      const operationHash = readString(data, 'operationHash')
      const approval: PendingApproval = {
        requestId,
        toolName: readString(data, 'toolName') || 'unknown',
        reason: readString(data, 'reason') || 'Review the exact tool request.',
        ...(isOperationHash(operationHash) ? { operationHash } : {}),
        ...(data['intentRevision'] === 1 ? { intentRevision: 1 as const } : {}),
      }
      const pendingApprovals = upsertById(base.pendingApprovals, approval, 'requestId')
      return {
        ...base,
        status: 'awaiting_approval',
        pendingApproval: pendingApprovals[0] ?? null,
        pendingApprovals,
      }
    }

    case 'permission.response': {
      const requestId = readString(data, 'requestId')
      if (!requestId) return rememberUnsupported(base, event.type)
      const pendingApprovals = base.pendingApprovals.filter(item => item.requestId !== requestId)
      return {
        ...base,
        status: waitingStatus(pendingApprovals, base.pendingSensitiveInputs),
        pendingApproval: pendingApprovals[0] ?? null,
        pendingApprovals,
      }
    }

    case 'sensitive.input.request': {
      const requestId = readString(data, 'requestId')
      const toolCallId = readString(data, 'toolCallId')
      const toolName = readString(data, 'toolName')
      const label = readString(data, 'label')
      const usage = readString(data, 'usage')
      const adapterRevision = readString(data, 'adapterRevision')
      const agentId = data['agentId']
      if (
        !requestId || !toolCallId || !toolName || !label || !usage || !adapterRevision
        || (typeof agentId !== 'string' && agentId !== null)
      ) return rememberUnsupported(base, event.type)
      const request: PendingSensitiveInput = {
        requestId,
        toolCallId,
        toolName,
        label,
        usage,
        agentId,
        adapterRevision,
      }
      const pendingSensitiveInputs = upsertById(
        base.pendingSensitiveInputs,
        request,
        'requestId',
      )
      return {
        ...base,
        status: base.pendingApprovals.length > 0
          ? 'awaiting_approval'
          : 'awaiting_sensitive_input',
        pendingSensitiveInput: pendingSensitiveInputs[0] ?? null,
        pendingSensitiveInputs,
      }
    }

    case 'sensitive.input.response': {
      const requestId = readString(data, 'requestId')
      if (!requestId) return rememberUnsupported(base, event.type)
      const pendingSensitiveInputs = base.pendingSensitiveInputs.filter(
        item => item.requestId !== requestId,
      )
      return {
        ...base,
        status: waitingStatus(base.pendingApprovals, pendingSensitiveInputs),
        pendingSensitiveInput: pendingSensitiveInputs[0] ?? null,
        pendingSensitiveInputs,
      }
    }

    case 'skill.activation': {
      const activationId = boundedIdentity(readString(data, 'activationId'))
      const skillName = boundedIdentity(readString(data, 'skillName'))
      const skillDigest = readString(data, 'skillDigest')
      const sourceRef = boundedIdentity(readString(data, 'sourceRef'))
      const sourceDigest = readString(data, 'sourceDigest')
      const turnIndex = readNumber(data, 'turnIndex')
      const timestamp = readNumber(data, 'timestamp')
      const rawAgentId = data['agentId']
      const agentId = typeof rawAgentId === 'string'
        ? boundedIdentity(rawAgentId)
        : rawAgentId === null ? null : undefined
      const rawToolCallId = data['toolCallId']
      const toolCallId = typeof rawToolCallId === 'string'
        ? boundedIdentity(rawToolCallId)
        : rawToolCallId === null ? null : undefined
      if (
        !activationId || !uuidIdentity(activationId)
        || !skillName || !keyedDigest(skillDigest)
        || !sourceRef || !keyedDigest(sourceDigest)
        || agentId === undefined || toolCallId === undefined
        || !Number.isSafeInteger(turnIndex) || turnIndex! < 0
        || !Number.isSafeInteger(timestamp) || timestamp! < 0
      ) return rememberUnsupported(base, event.type)
      const activation: SkillActivationEvidence = {
        activationId,
        skillName,
        skillDigest,
        sourceRef,
        sourceDigest,
        agentId,
        toolCallId,
        turnIndex: turnIndex!,
        timestamp: timestamp!,
      }
      return {
        ...base,
        skillActivations: upsertById(base.skillActivations, activation, 'activationId'),
      }
    }

    case 'turn.end': {
      const stopReason = readString(data, 'stopReason')
      const model = readString(readObject(data, 'usage'), 'model') || base.model
      if (!stopReason) {
        const unsupported = rememberUnsupported(base, 'turn.end:missing-stop-reason')
        return {
          ...unsupported,
          connection: {
            ...unsupported.connection,
            phase: 'resync_required',
            expectedNextSeq: lastSeq + 1,
          },
        }
      }
      if (CONTINUE_STOP_REASONS.has(stopReason)) {
        // A tool round-trip — the reply keeps streaming after the tool returns.
        return { ...base, model }
      }
      if (stopReason !== 'end_turn' && stopReason !== 'max_tokens' && stopReason !== 'stop_sequence') {
        const unsupported = rememberUnsupported(base, `turn.end:${stopReason}`)
        return {
          ...unsupported,
          connection: {
            ...unsupported.connection,
            phase: 'resync_required',
            expectedNextSeq: lastSeq + 1,
          },
        }
      }
      return {
        ...base,
        messages: closeOpenAssistant(base.messages),
        status: waitingStatus(base.pendingApprovals, base.pendingSensitiveInputs, 'idle'),
        model,
      }
    }

    case 'turn.interrupted': {
      const reason = readString(data, 'reason') || 'interrupted'
      return terminalError(base, `Run ${reason}. Start another turn or refresh the run state.`)
    }

    case 'error': {
      const message = readString(data, 'message') || 'agent error'
      return terminalError(base, message)
    }

    case 'session.start': {
      const model = readString(data, 'model') || base.model
      return { ...base, model }
    }

    default:
      return rememberUnsupported(base, event.type)
  }
}

// ── internals ────────────────────────────────────────────────────────────────

function reduceStreamStart(state: ChatState, data: Record<string, unknown>): ChatState {
  const since = readNumber(data, 'since')
  const maxSeqAtStart = readNumber(data, 'maxSeqAtStart')
  if (
    !Number.isSafeInteger(since) || since! < 0
    || !Number.isSafeInteger(maxSeqAtStart) || maxSeqAtStart! < since!
  ) return rememberUnsupported(state, 'stream.start')
  if (state.lastSeq !== 0 && state.lastSeq !== since) {
    const unsupported = rememberUnsupported(state, 'stream.start:cursor-mismatch')
    return {
      ...unsupported,
      connection: {
        ...unsupported.connection,
        phase: 'resync_required',
        expectedNextSeq: state.lastSeq + 1,
      },
    }
  }
  return seedReplayCursor(state, since!)
}

function reduceReplayComplete(state: ChatState, data: Record<string, unknown>): ChatState {
  const since = readNumber(data, 'since')
  const replayedThroughSeq = readNumber(data, 'replayedThroughSeq')
  const maxSeqAtStart = readNumber(data, 'maxSeqAtStart')
  const liveTail = data['liveTail']
  if (
    !Number.isSafeInteger(since) || since! < 0
    || !Number.isSafeInteger(replayedThroughSeq) || replayedThroughSeq! < since!
    || !Number.isSafeInteger(maxSeqAtStart) || maxSeqAtStart! < since!
    || typeof liveTail !== 'boolean'
    || replayedThroughSeq !== state.lastSeq
  ) {
    const unsupported = rememberUnsupported(state, 'stream.replay.complete')
    return {
      ...unsupported,
      connection: {
        ...unsupported.connection,
        phase: 'resync_required',
        expectedNextSeq: state.lastSeq + 1,
      },
    }
  }
  return {
    ...state,
    connection: {
      ...state.connection,
      phase: liveTail ? 'live' : 'closed',
      lastDeliveredSeq: state.lastSeq,
      expectedNextSeq: liveTail ? state.lastSeq + 1 : null,
    },
  }
}

function reduceStreamShutdown(state: ChatState, data: Record<string, unknown>): ChatState {
  const reason = readString(data, 'reason')
  if (reason === 'gateway_shutdown') {
    return {
      ...state,
      connection: { ...state.connection, phase: 'reconnecting' },
    }
  }
  if (reason === 'slow_consumer') {
    return {
      ...state,
      connection: {
        ...state.connection,
        phase: 'resync_required',
        expectedNextSeq: state.lastSeq + 1,
      },
    }
  }
  return rememberUnsupported(state, 'stream.shutdown')
}

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
  list.push({
    id: `a${seq}`,
    role: 'assistant',
    text: '',
    toolCalls: [],
    parts: [],
    streaming: true,
  })
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

/** Reconcile one optimistic prompt with the authoritative streamed observation. */
function reconcileOptimisticUser(messages: readonly Message[], observed: Message): Message[] {
  const list = messages.slice()
  const last = list[list.length - 1]
  if (
    last
    && last.role === 'user'
    && last.id.startsWith('u-local-')
    && last.text === observed.text
  ) {
    list[list.length - 1] = observed
    return list
  }
  list.push(observed)
  return list
}

/** Update an observed call, or retain an honest partial placeholder after retention loss. */
function updateOrInsertToolCall(
  messages: readonly Message[],
  seq: number,
  id: string,
  initial: ToolCall,
  update: (call: ToolCall) => ToolCall,
): Message[] {
  if (messages.some(message => message.toolCalls.some(call => call.id === id))) {
    return updateToolCall(messages, id, update)
  }
  const { list, idx } = ensureOpenAssistant(messages, seq)
  const message = list[idx]!
  list[idx] = {
    ...message,
    toolCalls: [...message.toolCalls, initial],
    parts: appendToolPart(message.parts, id),
  }
  return list
}

function upsertById<T, K extends keyof T>(items: readonly T[], item: T, key: K): T[] {
  const index = items.findIndex(existing => existing[key] === item[key])
  if (index < 0) return [...items, item]
  const next = items.slice()
  next[index] = item
  return next
}

function waitingStatus(
  approvals: readonly PendingApproval[],
  sensitiveInputs: readonly PendingSensitiveInput[],
  fallback: ChatState['status'] = 'streaming',
): ChatState['status'] {
  if (approvals.length > 0) return 'awaiting_approval'
  if (sensitiveInputs.length > 0) return 'awaiting_sensitive_input'
  return fallback
}

function terminalError(state: ChatState, message: string): ChatState {
  return {
    ...state,
    messages: closeOpenAssistant(state.messages),
    status: 'error',
    error: message,
    pendingApproval: null,
    pendingApprovals: [],
    pendingSensitiveInput: null,
    pendingSensitiveInputs: [],
  }
}

function rememberUnsupported(state: ChatState, type: string): ChatState {
  const current = state.connection.unsupportedEventTypes
  if (current.includes(type)) return state
  const unsupportedEventTypes = [...current, type].slice(-32)
  return {
    ...state,
    connection: { ...state.connection, unsupportedEventTypes },
  }
}

function isOperationHash(value: string): boolean {
  if (value.length !== 64) return false
  for (const char of value) {
    const code = char.charCodeAt(0)
    const digit = code >= 48 && code <= 57
    const lowerHex = code >= 97 && code <= 102
    if (!digit && !lowerHex) return false
  }
  return true
}

function boundedIdentity(value: string): string | undefined {
  if (value.length === 0 || value.length > 240) return undefined
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return undefined
  }
  return value
}

function keyedDigest(value: string): boolean {
  const prefix = 'hmac-sha256:'
  if (value.length !== prefix.length + 64 || !value.startsWith(prefix)) return false
  for (let index = prefix.length; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const digit = code >= 48 && code <= 57
    const lowerHex = code >= 97 && code <= 102
    if (!digit && !lowerHex) return false
  }
  return true
}

function uuidIdentity(value: string): boolean {
  if (value.length !== 36) return false
  for (let index = 0; index < value.length; index += 1) {
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      if (value[index] !== '-') return false
      continue
    }
    const code = value.charCodeAt(index)
    const digit = code >= 48 && code <= 57
    const lowerHex = code >= 97 && code <= 102
    if (!digit && !lowerHex) return false
  }
  const version = value.charCodeAt(14)
  const variant = value.charCodeAt(19)
  return version >= 49 && version <= 53
    && (variant === 56 || variant === 57 || variant === 97 || variant === 98)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function descriptorProperty(value: unknown): { readonly uiDescriptor?: import('./descriptors.js').ToolUIDescriptor } {
  const descriptor = normalizeToolUIDescriptor(value)
  return descriptor === undefined ? {} : { uiDescriptor: descriptor }
}

function appendMessagePart(
  parts: readonly MessagePart[] | undefined,
  part: Extract<MessagePart, { kind: 'text' | 'thinking' }>,
): readonly MessagePart[] {
  const current = parts ?? []
  if (part.text.length === 0) return current
  const last = current[current.length - 1]
  if (last?.kind === part.kind) {
    const next = current.slice()
    next[next.length - 1] = { ...last, text: last.text + part.text }
    return next
  }
  return [...current, part]
}

function appendToolPart(parts: readonly MessagePart[] | undefined, toolCallId: string): readonly MessagePart[] {
  const current = parts ?? []
  return current.some(part => part.kind === 'tool' && part.toolCallId === toolCallId)
    ? current
    : [...current, { kind: 'tool', toolCallId }]
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
  return isRecord(v) ? v : {}
}
