/**
 * Event Collector
 *
 * Drains a Loom AsyncGenerator<LoomEvent, LoopResult> into a typed
 * EventStream with helper methods for analysis and assertion.
 *
 * This is the Loom equivalent of the Cortex framework's sse-parser.ts,
 * but works directly with LoomEvent objects instead of parsing SSE text.
 */

import type { LoomEvent, TurnUsage } from '../../../src/core/events.js'
import type { LoopResult } from '../../../src/core/loop.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly result: string
  readonly isError: boolean
  readonly durationMs: number
}

export interface AgentRecord {
  readonly agentId: string
  readonly profileName: string
  readonly result: string
  readonly durationMs: number
}

export interface PermissionRecord {
  readonly requestId: string
  readonly toolName: string
  readonly reason: string
  readonly granted: boolean | null
}

export interface EventStream {
  /** All collected events in order. */
  readonly events: readonly LoomEvent[]
  /** Total event count. */
  readonly count: number
  /** The final LoopResult (null if generator threw or was aborted). */
  readonly result: LoopResult | null
  /** Error if the generator threw. */
  readonly error: Error | null

  /** Accumulate all text.delta events into a single string. */
  text(): string
  /** Accumulate all thinking.delta events. */
  thinking(): string
  /** Get completed tool calls (paired start + end). */
  tools(): ToolCallRecord[]
  /** Get sub-agent records (paired spawn + complete). */
  agents(): AgentRecord[]
  /** Get permission records (paired request + response). */
  permissions(): PermissionRecord[]
  /** Get total usage across all turn.end events. */
  usage(): { inputTokens: number; outputTokens: number; costUsd: number }
  /** Check if an event type exists in the stream. */
  hasEvent(type: string): boolean
  /** Get all events of a specific type. */
  eventsOfType<T extends LoomEvent>(type: string): T[]
  /** Get event type histogram. */
  eventCounts(): Record<string, number>
  /** Check if the stream completed (session.end with non-error reason). */
  completed(): boolean
  /** Get all error events. */
  errors(): Array<{ code: string; message: string; recoverable: boolean }>
  /** Get all recovery events. */
  recoveries(): Array<{ reason: string; attempt: number; detail?: string }>
  /** Get session end reason (or null if no session.end). */
  endReason(): string | null
  /** Get the number of turns. */
  turnCount(): number
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

/**
 * Collect all events from a Loom AsyncGenerator into an EventStream.
 *
 * Handles:
 * - Normal completion (generator returns LoopResult)
 * - Abort (generator throws AbortError)
 * - Errors (generator throws other errors)
 * - Timeout (optional, throws if exceeded)
 *
 * @param generator - The AsyncGenerator from session.submitMessage() or loop()
 * @param timeoutMs - Optional timeout. Throws if the generator doesn't complete in time.
 */
export async function collectEvents(
  generator: AsyncGenerator<LoomEvent, LoopResult>,
  timeoutMs?: number,
): Promise<EventStream> {
  const events: LoomEvent[] = []
  let result: LoopResult | null = null
  let error: Error | null = null

  const collect = async () => {
    let next = await generator.next()
    while (!next.done) {
      events.push(next.value)
      next = await generator.next()
    }
    result = next.value
  }

  if (timeoutMs) {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`collectEvents timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    try {
      await Promise.race([collect(), timeout])
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e))
    }
  } else {
    try {
      await collect()
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e))
    }
  }

  return createEventStream(events, result, error)
}

/**
 * Collect events with an interactive responder for permission requests.
 *
 * The responder is called each time a permission.request event arrives.
 * It must return the decision synchronously. The approval is then
 * delivered via the HITL handler (passed separately).
 *
 * @param generator - The AsyncGenerator from session.submitMessage()
 * @param onPermission - Called with each permission.request event data
 * @param hitl - The HumanInTheLoop instance to respond to
 * @param timeoutMs - Optional timeout
 */
export async function collectEventsWithResponder(
  generator: AsyncGenerator<LoomEvent, LoopResult>,
  onPermission: (event: { requestId: string; toolName: string }) => boolean,
  hitl: { respond: (requestId: string, approved: boolean) => void },
  timeoutMs?: number,
): Promise<EventStream> {
  const events: LoomEvent[] = []
  let result: LoopResult | null = null
  let error: Error | null = null

  const collect = async () => {
    let next = await generator.next()
    while (!next.done) {
      const event = next.value
      events.push(event)

      // Respond to permission requests mid-stream.
      // The loop yields permission.request BEFORE blocking on requestApproval().
      // We must respond asynchronously so the loop has time to register the
      // pending request in the HITL handler before we call respond().
      if (event.type === 'permission.request') {
        const requestId = (event as { requestId: string }).requestId
        const toolName = (event as { toolName: string }).toolName
        const approved = onPermission({ requestId, toolName })

        // Respond in a microtask — the loop needs one tick to register
        // the pending request before we can resolve it.
        setTimeout(() => {
          hitl.respond(requestId, approved)
        }, 50)
      }

      next = await generator.next()
    }
    result = next.value
  }

  if (timeoutMs) {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`collectEventsWithResponder timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    try {
      await Promise.race([collect(), timeout])
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e))
    }
  } else {
    try {
      await collect()
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e))
    }
  }

  return createEventStream(events, result, error)
}

// ---------------------------------------------------------------------------
// EventStream implementation
// ---------------------------------------------------------------------------

function createEventStream(
  events: readonly LoomEvent[],
  result: LoopResult | null,
  error: Error | null,
): EventStream {
  return {
    events,
    count: events.length,
    result,
    error,

    text(): string {
      return events
        .filter(e => e.type === 'text.delta')
        .map(e => (e as { text: string }).text)
        .join('')
    },

    thinking(): string {
      return events
        .filter(e => e.type === 'thinking.delta')
        .map(e => (e as { text: string }).text)
        .join('')
    },

    tools(): ToolCallRecord[] {
      const starts = new Map<string, { toolName: string; input: Record<string, unknown> }>()
      const records: ToolCallRecord[] = []

      for (const e of events) {
        if (e.type === 'tool.call.start') {
          const ev = e as { toolCallId: string; toolName: string; input: Record<string, unknown> }
          starts.set(ev.toolCallId, { toolName: ev.toolName, input: ev.input })
        }
        if (e.type === 'tool.call.end') {
          const ev = e as {
            toolCallId: string; toolName: string
            result: string; isError: boolean; durationMs: number
          }
          const start = starts.get(ev.toolCallId)
          records.push({
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            input: start?.input ?? {},
            result: ev.result,
            isError: ev.isError,
            durationMs: ev.durationMs,
          })
        }
      }
      return records
    },

    agents(): AgentRecord[] {
      const spawns = new Map<string, { profileName: string }>()
      const records: AgentRecord[] = []

      for (const e of events) {
        if (e.type === 'agent.spawn') {
          const ev = e as { agentId: string; profileName: string }
          spawns.set(ev.agentId, { profileName: ev.profileName })
        }
        if (e.type === 'agent.complete') {
          const ev = e as { agentId: string; result: string; durationMs: number }
          const spawn = spawns.get(ev.agentId)
          records.push({
            agentId: ev.agentId,
            profileName: spawn?.profileName ?? 'unknown',
            result: ev.result,
            durationMs: ev.durationMs,
          })
        }
      }
      return records
    },

    permissions(): PermissionRecord[] {
      const requests = new Map<string, { toolName: string; reason: string }>()
      const records: PermissionRecord[] = []

      for (const e of events) {
        if (e.type === 'permission.request') {
          const ev = e as { requestId: string; toolName: string; reason: string }
          requests.set(ev.requestId, { toolName: ev.toolName, reason: ev.reason })
        }
        if (e.type === 'permission.response') {
          const ev = e as { requestId: string; granted: boolean }
          const req = requests.get(ev.requestId)
          records.push({
            requestId: ev.requestId,
            toolName: req?.toolName ?? 'unknown',
            reason: req?.reason ?? '',
            granted: ev.granted,
          })
          requests.delete(ev.requestId)
        }
      }

      // Include unmatched requests (no response yet)
      for (const [requestId, req] of requests) {
        records.push({
          requestId,
          toolName: req.toolName,
          reason: req.reason,
          granted: null,
        })
      }

      return records
    },

    usage(): { inputTokens: number; outputTokens: number; costUsd: number } {
      let inputTokens = 0
      let outputTokens = 0
      let costUsd = 0

      for (const e of events) {
        if (e.type === 'turn.end') {
          const usage = (e as { usage: TurnUsage }).usage
          if (usage) {
            inputTokens += usage.inputTokens
            outputTokens += usage.outputTokens
            costUsd += usage.costUsd
          }
        }
      }

      return { inputTokens, outputTokens, costUsd }
    },

    hasEvent(type: string): boolean {
      return events.some(e => e.type === type)
    },

    eventsOfType<T extends LoomEvent>(type: string): T[] {
      return events.filter(e => e.type === type) as T[]
    },

    eventCounts(): Record<string, number> {
      const counts: Record<string, number> = {}
      for (const e of events) {
        counts[e.type] = (counts[e.type] ?? 0) + 1
      }
      return counts
    },

    completed(): boolean {
      const sessionEnd = events.find(e => e.type === 'session.end')
      if (!sessionEnd) return false
      const reason = (sessionEnd as { reason: string }).reason
      return reason !== 'error'
    },

    errors(): Array<{ code: string; message: string; recoverable: boolean }> {
      return events
        .filter(e => e.type === 'error')
        .map(e => {
          const ev = e as { code: string; message: string; recoverable: boolean }
          return { code: ev.code, message: ev.message, recoverable: ev.recoverable }
        })
    },

    recoveries(): Array<{ reason: string; attempt: number; detail?: string }> {
      return events
        .filter(e => e.type === 'recovery')
        .map(e => {
          const ev = e as { reason: string; attempt: number; detail?: string }
          return { reason: ev.reason, attempt: ev.attempt, detail: ev.detail }
        })
    },

    endReason(): string | null {
      const sessionEnd = events.find(e => e.type === 'session.end')
      return sessionEnd ? (sessionEnd as { reason: string }).reason : null
    },

    turnCount(): number {
      return events.filter(e => e.type === 'turn.start').length
    },
  }
}
