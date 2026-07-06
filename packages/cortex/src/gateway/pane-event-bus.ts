/**
 * PaneEventBus — fan-out of workspace-pane CRUD transitions, scoped
 * per-workspace.
 *
 * Problem this solves
 * -------------------
 * Before this bus existed the pane handlers (create / patch / delete /
 * reorder) wrote to SQLite and returned 200 but never notified any
 * subscriber. The client's `usePanes(wsId)` query was cached with a 2 s
 * staleTime, so a pane mutation in window A only became visible in
 * window B after up to 2 s + a focus refetch — and a long-running
 * client window (no focus event) could drift indefinitely. The audit board
 * calls this issue #2 C3 (F1b, Chunk #20), the panes companion to
 * the workspaces channel that landed in Chunk #19.
 *
 * Why per-workspace (and not a global bus like workspaces / credentials)
 * ---------------------------------------------------------------------
 * Panes are scoped to a workspace. A user with two client windows open
 * on different workspaces does NOT want pane mutations in workspace A
 * to invalidate workspace B's pane cache — it would thrash the cache
 * on every drag-reorder. So this bus is keyed by `wsId`: subscribers
 * register `(wsId, listener)` and emits fan out only to listeners of
 * the same `wsId`.
 *
 * The per-workspace shape was templated on the terminal event bus
 * (`packages/cortex/src/terminal/event-bus.ts`), which already keys
 * its fan-out by `(workspaceId, kind, terminalId)`. This file uses
 * a `Map<wsId, EventEmitter>` rather than a single global emitter
 * + filter, so the listener count is observable per-wsId for tests
 * and so a stuck listener on one wsId can't gum up another.
 *
 * Principle 5 (local-first / zero-data-leak) — non-negotiable
 * -----------------------------------------------------------
 * Events on this bus are INVALIDATE-ONLY. They carry `wsId`,
 * `paneId`, `action`, `at`, and (optional, cheap) `paneKind`. The
 * pane's `title`, `config` (which may carry file paths or chat ids),
 * `metadata`, `position` — every writable field — are explicitly
 * absent so that an SSE consumer cannot reconstruct the row from the
 * event stream alone. Clients re-fetch via
 * `GET /api/v1/workspaces/:wsId/panes` to pick up the new state.
 * `paneKind` is allowed because it's coarse (chat / tasks / files /
 * markdown / …) and lets consumers invalidate type-specific child
 * caches (file source caches, task lists) without an extra round-trip.
 *
 * Scope
 * -----
 * Single-process (the gateway is one Node process). A multi-process
 * gateway would swap this for Redis/NATS; not in v1. Same trade-off
 * as `EventBus`, `WorkspaceEventBus`, `CredentialEventBus`.
 */

import { EventEmitter } from 'node:events'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Event schema
// ---------------------------------------------------------------------------

/**
 * Discriminator for the action that produced the event.
 *
 *   created  — POST /api/v1/workspaces/:wsId/panes opened a pane.
 *   updated  — PATCH /api/v1/workspaces/:wsId/panes/:paneId succeeded
 *              (any field — title, focus, metadata, config, …).
 *   moved    — PUT /api/v1/workspaces/:wsId/panes reordered a zone.
 *              Single zone-level event, no `paneId` (the whole zone
 *              changed). Subscribers refetch the pane list.
 *   deleted  — DELETE /api/v1/workspaces/:wsId/panes/:paneId succeeded.
 *
 * No separate `closed` variant — pane "close" IS pane "delete" at
 * the DB layer (rows are removed, not soft-archived). The HTTP
 * response uses `closed: true` for UX symmetry but the bus mirrors
 * the durable verb.
 */
export const PaneActionSchema = z.enum([
  'created',
  'updated',
  'moved',
  'deleted',
])
export type PaneAction = z.infer<typeof PaneActionSchema>

/**
 * Wire schema. `paneId` is optional only for `action: 'moved'`
 * because a reorder is a zone-level transition; every other action
 * carries the affected pane id. Validation below enforces this so a
 * mistaken caller can't drop a paneId on a `created` event.
 */
export const PaneChangedEventSchema = z.object({
  type: z.literal('pane.changed'),
  wsId: z.string().min(1),
  paneId: z.string().min(1).optional(),
  action: PaneActionSchema,
  /** Optional kind hint so consumers can scope sibling-cache fan-out. */
  paneKind: z.string().min(1).optional(),
  /** ISO timestamp of emission. */
  at: z.string().min(1),
}).refine(
  (ev) => ev.action === 'moved' || ev.paneId !== undefined,
  { message: 'paneId required for actions other than "moved"' },
)

export type PaneChangedEvent = z.infer<typeof PaneChangedEventSchema>

/** Listener contract — receives already-validated events. */
export type PaneEventListener = (event: PaneChangedEvent) => void

/** Unsubscribe handle, idempotent. */
export type Unsubscribe = () => void

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

export interface EmitPaneInput {
  readonly wsId: string
  readonly paneId?: string
  readonly action: PaneAction
  readonly paneKind?: string
}

const EVENT_NAME = 'pane.changed'

/**
 * Per-wsId fan-out. The Map keys EventEmitters by workspace id so a
 * subscribe for `wsId=A` never receives events emitted for `wsId=B`.
 * Empty emitters are pruned on the last unsubscribe so the map
 * doesn't leak entries for workspaces that haven't seen activity in
 * a long-running gateway.
 */
export class PaneEventBus {
  private readonly emitters = new Map<string, EventEmitter>()

  private getOrCreate(wsId: string): EventEmitter {
    let em = this.emitters.get(wsId)
    if (em === undefined) {
      em = new EventEmitter()
      // Match the ceiling used by `WorkspaceEventBus` / `ConnectorStatusBus`
      // so a healthy gateway with multiple client windows on the same
      // workspace never trips it.
      em.setMaxListeners(100)
      this.emitters.set(wsId, em)
    }
    return em
  }

  subscribe(wsId: string, listener: PaneEventListener): Unsubscribe {
    const em = this.getOrCreate(wsId)
    em.on(EVENT_NAME, listener)
    return () => {
      em.off(EVENT_NAME, listener)
      // Drop the wsId entry once the last listener leaves so the map
      // doesn't grow without bound in long-lived gateways.
      if (em.listenerCount(EVENT_NAME) === 0) {
        this.emitters.delete(wsId)
      }
    }
  }

  /**
   * Publish a pane change. Returns the event that was dispatched.
   *
   * Validation runs on every emit so a future caller that drops a
   * required field fails loudly here, not silently on the wire.
   */
  emit(input: EmitPaneInput): PaneChangedEvent {
    const event: PaneChangedEvent = {
      type: 'pane.changed',
      wsId: input.wsId,
      ...(input.paneId !== undefined ? { paneId: input.paneId } : {}),
      action: input.action,
      ...(input.paneKind !== undefined ? { paneKind: input.paneKind } : {}),
      at: new Date().toISOString(),
    }
    PaneChangedEventSchema.parse(event)
    // No subscribers for this wsId? Drop silently — there's no one
    // to receive it, and instantiating an emitter just to fire it
    // into the void would leak Map entries.
    const em = this.emitters.get(input.wsId)
    if (em !== undefined) {
      em.emit(EVENT_NAME, event)
    }
    return event
  }

  /** Live subscriber count for a specific workspace. Observability + tests. */
  listenerCount(wsId: string): number {
    const em = this.emitters.get(wsId)
    return em === undefined ? 0 : em.listenerCount(EVENT_NAME)
  }

  /** Remove every subscriber across every workspace. Used on gateway shutdown. */
  clear(): void {
    for (const em of this.emitters.values()) {
      em.removeAllListeners(EVENT_NAME)
    }
    this.emitters.clear()
  }
}

// ---------------------------------------------------------------------------
// Process-wide factory
// ---------------------------------------------------------------------------

/**
 * The gateway instantiates one bus at boot and threads the same
 * instance through the pane handler factory + the SSE handler
 * factory. Tests construct their own bus and pass it in — no
 * module-level singleton, same DI shape as
 * `createWorkspaceEventBus` / `createCredentialEventBus`.
 */
export function createPaneEventBus(): PaneEventBus {
  return new PaneEventBus()
}
