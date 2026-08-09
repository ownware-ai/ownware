import type { LoomEvent, TurnUsage } from '@ownware/loom'
import type { RuntimeCompletion, RuntimeConsequence } from '../port.js'
import type { CodexNotification } from './app-server-client.js'
import type {
  CodexMcpDeliveryObservation,
  CodexMcpDeliveryResult,
} from './mcp-tool-bridge.js'
import type { CodexTerminalTurnReference } from './official-thread.js'

export type CodexTurnProtocolErrorCode =
  | 'invalid_notification'
  | 'scope_mismatch'
  | 'turn_not_started'
  | 'turn_start_conflict'
  | 'item_not_started'
  | 'item_identity_conflict'
  | 'open_item_at_terminal'
  | 'late_notification'
  | 'terminal_conflict'

export class CodexTurnProtocolError extends Error {
  public override readonly name = 'CodexTurnProtocolError'

  constructor(readonly code: CodexTurnProtocolErrorCode) {
    super(`Codex turn protocol failed (${code}).`)
  }
}

export interface CodexTranslatedTurnEvent {
  readonly event: LoomEvent
  readonly consequence?: RuntimeConsequence
}

export interface CodexTurnObservation {
  readonly events: readonly CodexTranslatedTurnEvent[]
  readonly completion?: RuntimeCompletion
  readonly terminal?: CodexTerminalTurnReference
  readonly unknownSourceType?: string
}

interface McpDeliveryAuthority {
  confirmAppServerDelivery(
    observation: CodexMcpDeliveryObservation,
  ): CodexMcpDeliveryResult
}

export interface CodexOfficialTurnBridgeOptions {
  readonly threadId: string
  readonly turnId: string
  readonly turnIndex: number
  readonly model: string
  readonly mcpRun?: McpDeliveryAuthority
  readonly now?: () => number
}

interface ItemState {
  readonly id: string
  readonly type: string
  readonly startedDigest: string
  readonly startedAtMs: number
  completedDigest?: string
}

type RecordValue = Record<string, unknown>

function asRecord(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : null
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  const record = asRecord(value)
  if (record == null) return value
  const result: RecordValue = {}
  for (const key of Object.keys(record).sort()) {
    result[key] = stable(record[key])
  }
  return result
}

function digest(value: unknown): string {
  return JSON.stringify(stable(value))
}

function safeSourceType(value: string): string {
  return /^[A-Za-z0-9_.:/-]{1,160}$/.test(value)
    ? value
    : 'unrecognized'
}

function itemType(item: RecordValue): string | null {
  return nonEmpty(item['id']) == null ? null : nonEmpty(item['type'])
}

function toolResultText(value: unknown): string {
  const result = asRecord(value)
  if (result == null || !Array.isArray(result['content'])) return ''
  return result['content']
    .map((part) => {
      const record = asRecord(part)
      return record?.['type'] === 'text' && typeof record['text'] === 'string'
        ? record['text']
        : ''
    })
    .filter((part) => part.length > 0)
    .join('\n')
}

function terminalTimestamp(turn: RecordValue, fallback: number): number {
  const completedAt = safeInteger(turn['completedAt'])
  return completedAt == null ? fallback : completedAt * 1_000
}

function terminalIso(turn: RecordValue, fallback: number): string {
  return new Date(terminalTimestamp(turn, fallback)).toISOString()
}

function emptyUsage(model: string): TurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model,
    costUsd: 0,
    costBasis: 'subscription_allowance',
    usageAuthority: 'runtime_report',
  }
}

/**
 * Version-pinned semantic projection for one app-server turn.
 *
 * `turn/completed` is the sole terminal authority. Retry errors, interrupt
 * acknowledgements, item prose, and process exit never synthesize success.
 */
export class CodexOfficialTurnBridge {
  private readonly items = new Map<string, ItemState>()
  private startedDigest: string | null = null
  private terminalDigest: string | null = null
  private cancellationReason: 'user' | 'timeout' | 'system' = 'system'
  private usage: TurnUsage
  private readonly now: () => number

  constructor(private readonly options: CodexOfficialTurnBridgeOptions) {
    this.now = options.now ?? Date.now
    this.usage = emptyUsage(options.model)
  }

  noteCancellation(reason: 'user' | 'timeout' | 'system'): void {
    this.cancellationReason = reason
  }

  fileChangeContext(itemId: string): {
    readonly input: Record<string, unknown>
    readonly authority: 'item/fileChange/started'
  } | null {
    const state = this.items.get(itemId)
    if (state?.type !== 'fileChange') return null
    const parsed = JSON.parse(state.startedDigest) as {
      readonly item?: Record<string, unknown>
    }
    const changes = parsed.item?.['changes']
    return Array.isArray(changes)
      ? {
          input: { changes },
          authority: 'item/fileChange/started',
        }
      : null
  }

  observe(notification: CodexNotification): CodexTurnObservation {
    if (this.terminalDigest != null) {
      if (notification.method !== 'turn/completed') {
        throw new CodexTurnProtocolError('late_notification')
      }
      const parsed = this.parseTurnTerminal(notification.params)
      const current = digest(parsed)
      if (current !== this.terminalDigest) {
        throw new CodexTurnProtocolError('terminal_conflict')
      }
      return { events: [] }
    }

    switch (notification.method) {
      case 'thread/started':
        return this.observeThreadStarted(notification.params)
      case 'turn/started':
        return this.observeTurnStarted(notification.params)
      case 'item/started':
        return this.observeItemStarted(notification.params)
      case 'item/completed':
        return this.observeItemCompleted(notification.params)
      case 'item/agentMessage/delta':
        return this.observeTextDelta(notification.params, 'agentMessage')
      case 'item/plan/delta':
        return this.observeTextDelta(notification.params, 'plan', true)
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        return this.observeTextDelta(notification.params, 'reasoning', true)
      case 'item/reasoning/summaryPartAdded':
        return this.observeScopedItemSignal(notification.params, 'reasoning')
      case 'item/commandExecution/outputDelta':
      case 'item/commandExecution/terminalInteraction':
        return this.observeProgress(notification.params, 'commandExecution')
      case 'item/fileChange/outputDelta':
      case 'item/fileChange/patchUpdated':
        return this.observeProgress(notification.params, 'fileChange')
      case 'item/mcpToolCall/progress':
        return this.observeMcpProgress(notification.params)
      case 'thread/tokenUsage/updated':
        return this.observeUsage(notification.params)
      case 'serverRequest/resolved':
        return { events: [] }
      case 'error':
        return this.observeError(notification.params)
      case 'turn/completed':
        return this.observeTerminal(notification.params)
      default:
        return {
          events: [],
          unknownSourceType: safeSourceType(notification.method),
        }
    }
  }

  private observeThreadStarted(value: unknown): CodexTurnObservation {
    const params = asRecord(value)
    const thread = asRecord(params?.['thread'])
    if (
      params == null
      || thread == null
      || params['threadId'] !== undefined
      || thread['id'] !== this.options.threadId
    ) {
      throw new CodexTurnProtocolError('scope_mismatch')
    }
    return { events: [] }
  }

  private observeTurnStarted(value: unknown): CodexTurnObservation {
    const params = asRecord(value)
    const turn = asRecord(params?.['turn'])
    if (
      params == null
      || turn == null
      || params['threadId'] !== this.options.threadId
      || turn['id'] !== this.options.turnId
      || turn['status'] !== 'inProgress'
    ) {
      throw new CodexTurnProtocolError('scope_mismatch')
    }
    const current = digest(params)
    if (this.startedDigest != null) {
      if (current !== this.startedDigest) {
        throw new CodexTurnProtocolError('turn_start_conflict')
      }
      return { events: [] }
    }
    this.startedDigest = current
    const startedAt = safeInteger(turn['startedAt'])
    const timestamp = startedAt == null ? this.now() : startedAt * 1_000
    return {
      events: [
        {
          event: {
            type: 'session.start',
            sessionId: this.options.threadId,
            model: this.options.model,
            timestamp,
          },
        },
        {
          event: {
            type: 'turn.start',
            turnIndex: this.options.turnIndex,
            timestamp,
          },
        },
      ],
    }
  }

  private observeItemStarted(value: unknown): CodexTurnObservation {
    this.requireStarted()
    const { params, item, id, type, observedAtMs } = this.parseItem(value, true)
    const current = digest(params)
    const previous = this.items.get(id)
    if (previous != null) {
      if (previous.startedDigest !== current) {
        throw new CodexTurnProtocolError('item_identity_conflict')
      }
      return { events: [] }
    }

    const supported = new Set([
      'userMessage',
      'agentMessage',
      'plan',
      'reasoning',
      'commandExecution',
      'fileChange',
      'mcpToolCall',
      'imageView',
    ])
    if (!supported.has(type)) {
      return {
        events: [],
        unknownSourceType: safeSourceType(`item/started:${type}`),
      }
    }

    this.items.set(id, {
      id,
      type,
      startedDigest: current,
      startedAtMs: observedAtMs,
    })
    if (type === 'commandExecution') {
      const command = nonEmpty(item['command'])
      const cwd = nonEmpty(item['cwd'])
      if (command == null || cwd == null || item['status'] !== 'inProgress') {
        throw new CodexTurnProtocolError('invalid_notification')
      }
      return {
        events: [{
          event: {
            type: 'tool.call.start',
            toolCallId: id,
            toolName: 'codex_native_command',
            input: { command, cwd },
            turnIndex: this.options.turnIndex,
          },
          consequence: 'effect_possible',
        }],
      }
    }
    if (type === 'fileChange') {
      if (!Array.isArray(item['changes']) || item['status'] !== 'inProgress') {
        throw new CodexTurnProtocolError('invalid_notification')
      }
      return {
        events: [{
          event: {
            type: 'tool.call.start',
            toolCallId: id,
            toolName: 'codex_native_file_change',
            input: { changes: item['changes'] },
            turnIndex: this.options.turnIndex,
          },
          consequence: 'effect_possible',
        }],
      }
    }
    if (type === 'mcpToolCall') {
      const server = nonEmpty(item['server'])
      const tool = nonEmpty(item['tool'])
      const input = asRecord(item['arguments'])
      if (
        server !== 'ownware_run'
        || tool == null
        || input == null
        || item['status'] !== 'inProgress'
      ) {
        return {
          events: [],
          unknownSourceType: safeSourceType(`item/started:${type}`),
        }
      }
      return {
        events: [{
          event: {
            type: 'tool.call.start',
            toolCallId: id,
            toolName: tool,
            input,
            turnIndex: this.options.turnIndex,
          },
        }],
      }
    }
    return { events: [] }
  }

  private observeItemCompleted(value: unknown): CodexTurnObservation {
    this.requireStarted()
    const { params, item, id, type, observedAtMs } = this.parseItem(value, false)
    const state = this.items.get(id)
    if (state == null) throw new CodexTurnProtocolError('item_not_started')
    if (state.type !== type) {
      throw new CodexTurnProtocolError('item_identity_conflict')
    }
    const current = digest(params)
    if (state.completedDigest != null) {
      if (state.completedDigest !== current) {
        throw new CodexTurnProtocolError('item_identity_conflict')
      }
      return { events: [] }
    }
    state.completedDigest = current

    if (type === 'agentMessage') {
      const value = text(item['text'])
      if (value == null) throw new CodexTurnProtocolError('invalid_notification')
      return {
        events: [{
          event: {
            type: 'text.complete',
            text: value,
            turnIndex: this.options.turnIndex,
          },
        }],
      }
    }
    if (type === 'reasoning' || type === 'plan') {
      const parts = type === 'plan'
        ? [text(item['text']) ?? '']
        : [
            ...(Array.isArray(item['summary'])
              ? item['summary'].filter((part): part is string => typeof part === 'string')
              : []),
            ...(Array.isArray(item['content'])
              ? item['content'].filter((part): part is string => typeof part === 'string')
              : []),
          ]
      return {
        events: parts.length === 0
          ? []
          : [{
              event: {
                type: 'thinking.complete',
                text: parts.join('\n'),
                turnIndex: this.options.turnIndex,
              },
            }],
      }
    }
    if (type === 'commandExecution') {
      const status = item['status']
      if (
        status !== 'completed'
        && status !== 'failed'
        && status !== 'declined'
      ) throw new CodexTurnProtocolError('invalid_notification')
      return {
        events: [{
          event: {
            type: 'tool.call.end',
            toolCallId: id,
            toolName: 'codex_native_command',
            result: text(item['aggregatedOutput']) ?? `Command ${status}.`,
            isError: status !== 'completed',
            durationMs: safeInteger(item['durationMs'])
              ?? Math.max(0, observedAtMs - state.startedAtMs),
            turnIndex: this.options.turnIndex,
          },
          consequence: 'effect_possible',
        }],
      }
    }
    if (type === 'fileChange') {
      const status = item['status']
      if (
        status !== 'completed'
        && status !== 'failed'
        && status !== 'declined'
      ) throw new CodexTurnProtocolError('invalid_notification')
      return {
        events: [{
          event: {
            type: 'tool.call.end',
            toolCallId: id,
            toolName: 'codex_native_file_change',
            result: `File change ${status}.`,
            isError: status !== 'completed',
            durationMs: Math.max(0, observedAtMs - state.startedAtMs),
            turnIndex: this.options.turnIndex,
          },
          consequence: 'effect_possible',
        }],
      }
    }
    if (type === 'mcpToolCall') {
      const tool = nonEmpty(item['tool'])
      const input = asRecord(item['arguments'])
      const status = item['status']
      if (
        item['server'] !== 'ownware_run'
        || tool == null
        || input == null
        || (status !== 'completed' && status !== 'failed')
      ) throw new CodexTurnProtocolError('invalid_notification')

      const delivery = this.options.mcpRun?.confirmAppServerDelivery({
        toolName: tool,
        input,
        status,
        authority: 'item/completed',
      })
      const consequence = delivery?.status === 'confirmed'
        ? delivery.consequence
        : 'effect_possible'
      return {
        events: [{
          event: {
            type: 'tool.call.end',
            toolCallId: id,
            toolName: tool,
            result: status === 'completed'
              ? toolResultText(item['result'])
              : nonEmpty(asRecord(item['error'])?.['message']) ?? 'Tool failed.',
            isError: status === 'failed',
            durationMs: safeInteger(item['durationMs'])
              ?? Math.max(0, observedAtMs - state.startedAtMs),
            turnIndex: this.options.turnIndex,
          },
          consequence,
        }],
      }
    }
    return { events: [] }
  }

  private observeTextDelta(
    value: unknown,
    expectedType: string,
    thinking = false,
  ): CodexTurnObservation {
    const { params } = this.parseItemSignal(value, expectedType)
    const delta = text(params['delta'])
    if (delta == null) throw new CodexTurnProtocolError('invalid_notification')
    return {
      events: [{
        event: thinking
          ? {
              type: 'thinking.delta',
              text: delta,
              turnIndex: this.options.turnIndex,
            }
          : {
              type: 'text.delta',
              text: delta,
              turnIndex: this.options.turnIndex,
            },
      }],
    }
  }

  private observeProgress(
    value: unknown,
    expectedType: string,
  ): CodexTurnObservation {
    const { params, state } = this.parseItemSignal(value, expectedType)
    const delta = text(params['delta'])
    if (delta == null) throw new CodexTurnProtocolError('invalid_notification')
    return {
      events: [{
        event: {
          type: 'tool.call.progress',
          toolCallId: state.id,
          progress: delta,
          turnIndex: this.options.turnIndex,
        },
        consequence: expectedType === 'mcpToolCall'
          ? undefined
          : 'effect_possible',
      }],
    }
  }

  private observeMcpProgress(value: unknown): CodexTurnObservation {
    const { params, state } = this.parseItemSignal(value, 'mcpToolCall')
    const message = text(params['message'])
    if (message == null) throw new CodexTurnProtocolError('invalid_notification')
    return {
      events: [{
        event: {
          type: 'tool.call.progress',
          toolCallId: state.id,
          progress: message,
          turnIndex: this.options.turnIndex,
        },
      }],
    }
  }

  private observeScopedItemSignal(
    value: unknown,
    expectedType: string,
  ): CodexTurnObservation {
    this.parseItemSignal(value, expectedType)
    return { events: [] }
  }

  private observeUsage(value: unknown): CodexTurnObservation {
    this.requireStarted()
    const params = asRecord(value)
    if (
      params == null
      || params['threadId'] !== this.options.threadId
      || params['turnId'] !== this.options.turnId
    ) throw new CodexTurnProtocolError('scope_mismatch')
    const tokenUsage = asRecord(params['tokenUsage'])
    const last = asRecord(tokenUsage?.['last'])
    if (last == null) throw new CodexTurnProtocolError('invalid_notification')
    const inputTokens = safeInteger(last['inputTokens'])
    const outputTokens = safeInteger(last['outputTokens'])
    const cacheReadTokens = safeInteger(last['cachedInputTokens'])
    const cacheCreationTokens = last['cacheWriteInputTokens'] === undefined
      ? 0
      : safeInteger(last['cacheWriteInputTokens'])
    if (
      inputTokens == null
      || outputTokens == null
      || cacheReadTokens == null
      || cacheCreationTokens == null
    ) throw new CodexTurnProtocolError('invalid_notification')
    this.usage = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      model: this.options.model,
      costUsd: 0,
      costBasis: 'subscription_allowance',
      usageAuthority: 'runtime_report',
    }
    return { events: [] }
  }

  private observeError(value: unknown): CodexTurnObservation {
    this.requireStarted()
    const params = asRecord(value)
    if (
      params == null
      || params['threadId'] !== this.options.threadId
      || params['turnId'] !== this.options.turnId
      || typeof params['willRetry'] !== 'boolean'
      || asRecord(params['error']) == null
    ) throw new CodexTurnProtocolError('scope_mismatch')
    const willRetry = params['willRetry']
    return {
      events: [{
        event: {
          type: 'error',
          code: willRetry ? 'codex_turn_retrying' : 'codex_turn_error_signal',
          message: willRetry
            ? 'Codex reported a recoverable turn error and will retry.'
            : 'Codex reported a turn error; awaiting its terminal state.',
          recoverable: willRetry,
          turnIndex: this.options.turnIndex,
        },
      }],
    }
  }

  private observeTerminal(value: unknown): CodexTurnObservation {
    this.requireStarted()
    const parsed = this.parseTurnTerminal(value)
    if ([...this.items.values()].some((item) => item.completedDigest == null)) {
      throw new CodexTurnProtocolError('open_item_at_terminal')
    }
    const current = digest(parsed)
    this.terminalDigest = current
    const timestamp = terminalTimestamp(parsed.turn, this.now())
    const reason = parsed.status === 'completed'
      ? 'end_turn' as const
      : parsed.status === 'interrupted'
        ? 'aborted' as const
        : 'error' as const
    const completion: RuntimeCompletion = parsed.status === 'completed'
      ? { outcome: 'succeeded', authority: 'turn/completed' }
      : parsed.status === 'interrupted'
        ? {
            outcome: 'cancelled',
            authority: 'turn/completed',
            reason: this.cancellationReason,
          }
        : {
            outcome: 'failed',
            authority: 'turn/completed',
            code: 'codex_turn_failed',
          }
    return {
      events: [
        {
          event: {
            type: 'turn.end',
            turnIndex: this.options.turnIndex,
            stopReason: reason,
            usage: this.usage,
            timestamp,
          },
        },
        {
          event: {
            type: 'session.end',
            sessionId: this.options.threadId,
            reason,
            totalUsage: this.usage,
            turnCount: 1,
            timestamp,
          },
        },
      ],
      completion,
      terminal: {
        id: this.options.turnId,
        status: parsed.status,
        completedAt: terminalIso(parsed.turn, this.now()),
        authority: 'turn/completed',
      },
    }
  }

  private parseTurnTerminal(value: unknown): {
    readonly status: 'completed' | 'interrupted' | 'failed'
    readonly turn: RecordValue
  } {
    const params = asRecord(value)
    const turn = asRecord(params?.['turn'])
    const status = turn?.['status']
    if (
      params == null
      || turn == null
      || params['threadId'] !== this.options.threadId
      || turn['id'] !== this.options.turnId
      || (
        status !== 'completed'
        && status !== 'interrupted'
        && status !== 'failed'
      )
    ) throw new CodexTurnProtocolError('scope_mismatch')
    return { status, turn }
  }

  private parseItem(
    value: unknown,
    started: boolean,
  ): {
    readonly params: RecordValue
    readonly item: RecordValue
    readonly id: string
    readonly type: string
    readonly observedAtMs: number
  } {
    const params = asRecord(value)
    const item = asRecord(params?.['item'])
    if (
      params == null
      || item == null
      || params['threadId'] !== this.options.threadId
      || params['turnId'] !== this.options.turnId
    ) throw new CodexTurnProtocolError('scope_mismatch')
    const id = nonEmpty(item['id'])
    const type = itemType(item)
    const observedAtMs = safeInteger(
      params[started ? 'startedAtMs' : 'completedAtMs'],
    )
    if (id == null || type == null || observedAtMs == null) {
      throw new CodexTurnProtocolError('invalid_notification')
    }
    return { params, item, id, type, observedAtMs }
  }

  private parseItemSignal(
    value: unknown,
    expectedType: string,
  ): { readonly params: RecordValue; readonly state: ItemState } {
    this.requireStarted()
    const params = asRecord(value)
    if (
      params == null
      || params['threadId'] !== this.options.threadId
      || params['turnId'] !== this.options.turnId
    ) throw new CodexTurnProtocolError('scope_mismatch')
    const id = nonEmpty(params['itemId'])
    if (id == null) throw new CodexTurnProtocolError('invalid_notification')
    const state = this.items.get(id)
    if (state == null) throw new CodexTurnProtocolError('item_not_started')
    if (state.type !== expectedType || state.completedDigest != null) {
      throw new CodexTurnProtocolError('item_identity_conflict')
    }
    return { params, state }
  }

  private requireStarted(): void {
    if (this.startedDigest == null) {
      throw new CodexTurnProtocolError('turn_not_started')
    }
  }
}
