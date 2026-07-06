/**
 * WorkspaceEventBus — fan-out of workspace CRUD transitions.
 *
 * Problem this solves
 * -------------------
 * Before this bus existed the workspace handlers (create / update /
 * delete) wrote to SQLite and returned 200 but never notified any
 * subscriber. The client's `workspaceKeys.list` query was cached with a
 * 10 s staleTime, so a create in window A only became visible in
 * window B after up to 10 s + a focus refetch. Multi-window users
 * (the common "two client instances on the same machine" path) saw
 * drifted workspace lists. The audit board calls this issue #2 C2 (F1a).
 *
 * Shape mirrors `CredentialEventBus` (see `credential-event-bus.ts`) —
 * the credentials channel was the immediately preceding template:
 *   - In-process EventEmitter, no buffering.
 *   - Zod-validated payload at the bus boundary.
 *   - Emitters call `emit()` with a typed input; subscribers receive
 *     already-validated events.
 *
 * Principle 5 (local-first / zero-data-leak) — non-negotiable
 * -----------------------------------------------------------
 * Events on this bus are INVALIDATE-ONLY. They carry `workspaceId`,
 * `action`, and `at` — nothing more. The workspace's `name`, `path`,
 * `description`, and every other writable field are explicitly absent
 * so that an SSE consumer cannot reconstruct the row from the event
 * stream alone. Clients re-fetch via `GET /api/v1/workspaces` to pick
 * up the new state. This matches the package CLAUDE.md "Gateway
 * Realtime Contract" rule: "SSE never carries business payloads — it
 * carries `{ type, resource_id }` invalidation hints only."
 *
 * Scope
 * -----
 * Single-process (the gateway is one Node process). A multi-process
 * gateway would swap this for Redis/NATS; not in v1. Same trade-off
 * as `EventBus`, `ConnectorStatusBus`, and `CredentialEventBus`.
 */

import { EventEmitter } from 'node:events'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Event schema
// ---------------------------------------------------------------------------

/**
 * Discriminator for the action that produced the event.
 *
 *   created   — POST /api/v1/workspaces created (or reactivated from
 *               archived) a workspace.
 *   updated   — PUT /api/v1/workspaces/:id succeeded (any field).
 *   archived  — PUT updated `status` to `archived` (soft-remove path).
 *   deleted   — DELETE /api/v1/workspaces/:id succeeded.
 *
 * `archived` is split out from `updated` because the client's workspace
 * picker may want to drop the row from the active list without waiting
 * for a refetch. Today both invalidate the same key, but the
 * discriminator keeps the option open without a wire-format break.
 */
export const WorkspaceActionSchema = z.enum([
  'created',
  'updated',
  'archived',
  'deleted',
])
export type WorkspaceAction = z.infer<typeof WorkspaceActionSchema>

export const WorkspaceChangedEventSchema = z.object({
  /** Discriminator. Kept open for future workspace.* event types. */
  type: z.literal('workspace.changed'),
  /** Stable id of the affected workspace row. */
  workspaceId: z.string().min(1),
  /** What the gateway did to the row. */
  action: WorkspaceActionSchema,
  /** ISO timestamp of emission. */
  at: z.string().min(1),
})

export type WorkspaceChangedEvent = z.infer<typeof WorkspaceChangedEventSchema>

/** Listener contract — receives already-validated events. */
export type WorkspaceEventListener = (event: WorkspaceChangedEvent) => void

/** Unsubscribe handle, idempotent. */
export type Unsubscribe = () => void

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

export interface EmitWorkspaceInput {
  readonly workspaceId: string
  readonly action: WorkspaceAction
}

const EVENT_NAME = 'workspace.changed'

export class WorkspaceEventBus {
  private readonly emitter = new EventEmitter()

  constructor() {
    // Match the ceiling used by `CredentialEventBus` / `ConnectorStatusBus`
    // so a healthy gateway with multiple client windows never trips it.
    this.emitter.setMaxListeners(100)
  }

  subscribe(listener: WorkspaceEventListener): Unsubscribe {
    this.emitter.on(EVENT_NAME, listener)
    return () => {
      this.emitter.off(EVENT_NAME, listener)
    }
  }

  /**
   * Publish a workspace change. Returns the event that was dispatched.
   *
   * No idempotency suppression (matching `CredentialEventBus`): two
   * back-to-back `updated` events on the same id are legitimate — e.g.
   * the user renamed twice, or toggled a setting then renamed. The bus
   * is a hint stream; cached observers will refetch and converge
   * regardless.
   *
   * Validation runs on every emit so a future caller that drops a
   * required field fails loudly here, not silently on the wire.
   */
  emit(input: EmitWorkspaceInput): WorkspaceChangedEvent {
    const event: WorkspaceChangedEvent = {
      type: 'workspace.changed',
      workspaceId: input.workspaceId,
      action: input.action,
      at: new Date().toISOString(),
    }
    WorkspaceChangedEventSchema.parse(event)
    this.emitter.emit(EVENT_NAME, event)
    return event
  }

  /** Live subscriber count. Observability + tests. */
  get listenerCount(): number {
    return this.emitter.listenerCount(EVENT_NAME)
  }

  /** Remove every subscriber. Used on gateway shutdown. */
  clear(): void {
    this.emitter.removeAllListeners(EVENT_NAME)
  }
}

// ---------------------------------------------------------------------------
// Process-wide factory
// ---------------------------------------------------------------------------

/**
 * The gateway instantiates one bus at boot and threads the same
 * instance through the workspace handler factory + the SSE handler
 * factory. Tests construct their own bus and pass it in — no
 * module-level singleton, same DI shape as
 * `createConnectorStatusBus` / `createCredentialEventBus`.
 */
export function createWorkspaceEventBus(): WorkspaceEventBus {
  return new WorkspaceEventBus()
}
