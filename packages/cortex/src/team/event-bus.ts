/**
 * TeamEventBus — invalidation hints for the team vertical.
 *
 * Shape mirrors `WorkspaceEventBus` (the gateway's bus template):
 * in-process EventEmitter, zod-validated on emit, INVALIDATE-ONLY
 * payloads. Per the Gateway Realtime Contract, SSE never carries
 * business payloads — subscribers see `{ threadId, runId, scope }`
 * and re-fetch the board (`GET /api/v1/threads/:tid/team-board`) or
 * the teams list (`GET /api/v1/teams`) over HTTP.
 *
 * Events ride the multiplexed `/api/v1/events` channel as the
 * `team.changed` SSE event (one new `kind` in gateway-events.ts).
 */

import { EventEmitter } from 'node:events'
import { z } from 'zod'

/**
 *   board — a task/lease/run-status mutation on a live run's board.
 *           The client re-fetches the thread's board view (strip, desk).
 *   teams — the team CATALOG changed (create/update/delete, or a run
 *           finished and the directory card's "last run" moved).
 *           The client re-fetches the teams list.
 */
export const TeamChangedScopeSchema = z.enum(['board', 'teams'])
export type TeamChangedScope = z.infer<typeof TeamChangedScopeSchema>

export const TeamChangedEventSchema = z.object({
  type: z.literal('team.changed'),
  scope: TeamChangedScopeSchema,
  /** Thread the run is bound to — null for catalog-scope events. */
  threadId: z.string().min(1).nullable(),
  /** Run whose board changed — null for catalog-scope events. */
  runId: z.string().min(1).nullable(),
  at: z.string().min(1),
})

export type TeamChangedEvent = z.infer<typeof TeamChangedEventSchema>

export type TeamEventListener = (event: TeamChangedEvent) => void
export type Unsubscribe = () => void

const EVENT_NAME = 'team.changed'

export class TeamEventBus {
  private readonly emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(100)
  }

  subscribe(listener: TeamEventListener): Unsubscribe {
    this.emitter.on(EVENT_NAME, listener)
    return () => {
      this.emitter.off(EVENT_NAME, listener)
    }
  }

  emit(input: {
    readonly scope: TeamChangedScope
    readonly threadId?: string | null
    readonly runId?: string | null
  }): TeamChangedEvent {
    const event: TeamChangedEvent = {
      type: 'team.changed',
      scope: input.scope,
      threadId: input.threadId ?? null,
      runId: input.runId ?? null,
      at: new Date().toISOString(),
    }
    TeamChangedEventSchema.parse(event)
    this.emitter.emit(EVENT_NAME, event)
    return event
  }

  get listenerCount(): number {
    return this.emitter.listenerCount(EVENT_NAME)
  }

  clear(): void {
    this.emitter.removeAllListeners(EVENT_NAME)
  }
}

export function createTeamEventBus(): TeamEventBus {
  return new TeamEventBus()
}
