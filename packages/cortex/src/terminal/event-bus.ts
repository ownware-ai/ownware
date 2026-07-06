/**
 * TerminalEventBus — fan-out for PTY activity. Same shape as
 * `TaskEventBus` and `ConnectorStatusBus` so every SSE surface in the
 * gateway uses identical primitives.
 *
 * Payload carries `kind` + `terminalId` so consumers can filter a
 * shared fan-out stream to a specific terminal:
 *   - `kind: 'agent'` with `terminalId: null` — the workspace's agent
 *     PTY (exactly one, lazy-spawned, written to only by
 *     `shell_execute`).
 *   - `kind: 'user'` with a non-null `terminalId` — one of 0..N
 *     user-owned PTYs for the workspace.
 *
 * Single-process scope. Multi-process scaling is out of scope — would
 * swap the EventEmitter for Redis/NATS behind this interface.
 */

import { EventEmitter } from 'node:events'
import { z } from 'zod'

export const TerminalKindSchema = z.union([z.literal('agent'), z.literal('user')])
export type TerminalKind = z.infer<typeof TerminalKindSchema>

export const TerminalOutputEventSchema = z.object({
  type: z.literal('terminal.output'),
  workspaceId: z.string().min(1),
  kind: TerminalKindSchema,
  terminalId: z.string().min(1).nullable(),
  data: z.string(),
  at: z.string().min(1),
})
export type TerminalOutputEvent = z.infer<typeof TerminalOutputEventSchema>

export const TerminalExitEventSchema = z.object({
  type: z.literal('terminal.exit'),
  workspaceId: z.string().min(1),
  kind: TerminalKindSchema,
  terminalId: z.string().min(1).nullable(),
  exitCode: z.number().int(),
  signal: z.number().int().optional(),
  at: z.string().min(1),
})
export type TerminalExitEvent = z.infer<typeof TerminalExitEventSchema>

/**
 * Rich exit notification for agent-requested sessions flagged
 * `notifyOnExit: true`. Distinct from `terminal.exit` so consumers
 * that don't care (the client's live SSE render) can ignore it, while
 * the Loom `shell_execute` tool can listen specifically for this to
 * surface "Shell 3 exited code 1 — last line: 'Build failed'" on
 * the agent's next turn without polling.
 *
 * - `lineCount` — total lines in the scrollback at exit time.
 * - `lastLine` — the final non-empty line, truncated to 250 chars
 *   (enough to know "why" without bloating the agent's context). null
 *   when the buffer was empty.
 * - `timedOut` — true when the kill was triggered by the session
 *   timeout (Item 6), false otherwise. Lets the agent distinguish
 *   "exceeded budget" from "exited on its own."
 */
export const TerminalExitedEventSchema = z.object({
  type: z.literal('terminal.exited'),
  workspaceId: z.string().min(1),
  kind: TerminalKindSchema,
  terminalId: z.string().min(1).nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().optional(),
  lineCount: z.number().int().nonnegative(),
  lastLine: z.string().nullable(),
  timedOut: z.boolean(),
  at: z.string().min(1),
})
export type TerminalExitedEvent = z.infer<typeof TerminalExitedEventSchema>

/**
 * A session was created. Lets the multiplexed workspace stream tell clients
 * "a new terminal exists" live — so a tab appears the moment the agent (or a
 * peer) spins one up, with no polling.
 */
export const TerminalCreatedEventSchema = z.object({
  type: z.literal('terminal.created'),
  workspaceId: z.string().min(1),
  kind: TerminalKindSchema,
  terminalId: z.string().min(1).nullable(),
  at: z.string().min(1),
})
export type TerminalCreatedEvent = z.infer<typeof TerminalCreatedEventSchema>

export const TerminalEventSchema = z.discriminatedUnion('type', [
  TerminalOutputEventSchema,
  TerminalExitEventSchema,
  TerminalExitedEventSchema,
  TerminalCreatedEventSchema,
])
export type TerminalEvent = z.infer<typeof TerminalEventSchema>

export type TerminalListener = (event: TerminalEvent) => void
export type Unsubscribe = () => void

const EVENT_NAME = 'terminal'

export class TerminalEventBus {
  private readonly emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(200)
  }

  emit(event: TerminalEvent): void {
    const validated = TerminalEventSchema.parse(event)
    this.emitter.emit(EVENT_NAME, validated)
  }

  subscribe(listener: TerminalListener): Unsubscribe {
    this.emitter.on(EVENT_NAME, listener)
    let gone = false
    return () => {
      if (gone) return
      gone = true
      this.emitter.off(EVENT_NAME, listener)
    }
  }
}
