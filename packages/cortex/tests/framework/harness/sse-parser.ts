/**
 * SSE Stream Parser — typed event extraction.
 *
 * Parses raw `event: X\ndata: {...}\n\n` text into typed event objects
 * and provides accumulator helpers for text, tools, sub-agents, etc.
 *
 * Critical for SSE testing: every event type can be inspected, asserted on,
 * and saved to disk for later analysis (e.g., feeding to Sonnet/Haiku for
 * automated review).
 */

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface SSEEvent {
  /** Event name from `event: X` line */
  readonly event: string
  /** Parsed JSON data from `data: ...` line (or raw string if not JSON) */
  readonly data: unknown
  /** Original line index in stream (for ordering analysis) */
  readonly index: number
}

// Specific event payloads (mirror Loom's LoomEvent shapes)

export interface TextDeltaEvent { text: string }
export interface ThinkingDeltaEvent { text: string }
export interface ToolCallStartEvent { toolCallId: string; toolName: string; input: unknown }
export interface ToolCallEndEvent {
  toolCallId: string
  toolName: string
  result: string
  isError: boolean
  durationMs: number
}
export interface AgentSpawnEvent { agentId: string; profileName: string; task?: string }
export interface AgentCompleteEvent {
  agentId: string
  result: string
  durationMs: number
  toolCount?: number
  turnCount?: number
}
export interface PermissionRequestEvent {
  requestId: string
  toolName: string
  input: unknown
  reason: string
  zoneLevel?: number
  zoneName?: string
  explanation?: string
}
export interface PermissionResponseEvent { requestId: string; granted: boolean }
export interface TurnEndEvent {
  turnIndex: number
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
}

// ---------------------------------------------------------------------------
// SSEStream (analyzed view of the parsed events)
// ---------------------------------------------------------------------------

export interface SSEStream {
  /** All events in order */
  readonly events: readonly SSEEvent[]
  /** Total event count */
  readonly count: number
  /** Accumulated text from text.delta events */
  text(): string
  /** Accumulated thinking from thinking.delta events */
  thinking(): string
  /** All completed tool calls (paired tool.call.start + tool.call.end) */
  tools(): ToolCallEndEvent[]
  /** All sub-agent activity */
  agents(): AgentCompleteEvent[]
  /** All permission requests received */
  permissions(): PermissionRequestEvent[]
  /** Total usage from all turn.end events */
  usage(): { inputTokens: number; outputTokens: number; costUsd: number }
  /** Whether a specific event type appeared at least once */
  hasEvent(type: string): boolean
  /** Get all events of a specific type */
  eventsOfType<T = unknown>(type: string): T[]
  /** Counts per event type */
  eventCounts(): Record<string, number>
  /** Whether the stream completed cleanly (saw `done` event) */
  completed(): boolean
  /** Errors encountered (from `error` events) */
  errors(): Array<{ error: string; message: string }>
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseSSE(rawText: string): SSEStream {
  const events: SSEEvent[] = []
  const blocks = rawText.split('\n\n')
  let index = 0

  for (const block of blocks) {
    if (!block.trim()) continue
    if (block.startsWith(':')) continue // keepalive comment

    const lines = block.split('\n')
    let eventName = 'message'
    let dataStr = ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventName = line.slice(7).trim()
      } else if (line.startsWith('data: ')) {
        // Multiple data: lines should be joined with \n
        dataStr = dataStr ? `${dataStr}\n${line.slice(6)}` : line.slice(6)
      }
    }

    if (!dataStr) continue

    let data: unknown
    try {
      data = JSON.parse(dataStr)
    } catch {
      data = dataStr
    }

    events.push({ event: eventName, data, index: index++ })
  }

  return makeStream(events)
}

function makeStream(events: SSEEvent[]): SSEStream {
  return {
    events,
    count: events.length,

    text(): string {
      return events
        .filter(e => e.event === 'text.delta')
        .map(e => (e.data as TextDeltaEvent).text ?? '')
        .join('')
    },

    thinking(): string {
      return events
        .filter(e => e.event === 'thinking.delta')
        .map(e => (e.data as ThinkingDeltaEvent).text ?? '')
        .join('')
    },

    tools(): ToolCallEndEvent[] {
      return events
        .filter(e => e.event === 'tool.call.end')
        .map(e => e.data as ToolCallEndEvent)
    },

    agents(): AgentCompleteEvent[] {
      return events
        .filter(e => e.event === 'agent.complete')
        .map(e => e.data as AgentCompleteEvent)
    },

    permissions(): PermissionRequestEvent[] {
      return events
        .filter(e => e.event === 'permission.request')
        .map(e => e.data as PermissionRequestEvent)
    },

    usage() {
      const turnEnds = events
        .filter(e => e.event === 'turn.end')
        .map(e => e.data as TurnEndEvent)
      return turnEnds.reduce(
        (acc, t) => ({
          inputTokens: acc.inputTokens + (t.usage?.inputTokens ?? 0),
          outputTokens: acc.outputTokens + (t.usage?.outputTokens ?? 0),
          costUsd: acc.costUsd + (t.usage?.costUsd ?? 0),
        }),
        { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      )
    },

    hasEvent(type: string): boolean {
      return events.some(e => e.event === type)
    },

    eventsOfType<T>(type: string): T[] {
      return events.filter(e => e.event === type).map(e => e.data as T)
    },

    eventCounts(): Record<string, number> {
      const counts: Record<string, number> = {}
      for (const e of events) {
        counts[e.event] = (counts[e.event] ?? 0) + 1
      }
      return counts
    },

    completed(): boolean {
      return events.some(e => e.event === 'done')
    },

    errors() {
      return events
        .filter(e => e.event === 'error')
        .map(e => e.data as { error: string; message: string })
    },
  }
}
