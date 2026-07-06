/**
 * ConnectorStatusBus — source-agnostic fan-out of connector status
 * transitions.
 *
 * Problem this solves
 * -------------------
 * M1 and M1.5 surfaced per-source status ("ready" / "needs_setup" / "error")
 * via the `GET /connectors` endpoint, but every change required the client to
 * poll or refetch. The client has no way to hear about a live transition —
 * e.g. user saves credentials for an MCP server in another window, or
 * `PATCH /connectors/web_search/provider` flips the active provider.
 *
 * This bus is the single place every connector source publishes status
 * transitions. SSE handlers subscribe; emitters stay transport-free.
 *
 * Invariants
 * ----------
 *   - Emission is best-effort: if no subscriber is listening, the event
 *     is dropped. The authoritative state is always readable via
 *     `GET /connectors`; the bus is a live hint, not a durable log.
 *   - Emitters never touch HTTP. They call `emit()` with a payload.
 *   - Last-known status is cached per connectorId so emitters can
 *     compute `previousStatus` without threading state through every
 *     handler. The cache is in-process only.
 *   - Zod-validated payload at the bus boundary — prevents a future
 *     source from emitting a shape the client can't parse.
 *
 * Scope
 * -----
 * Single-process (the gateway is a single Node process). A multi-
 * process gateway would swap this for Redis/NATS; that's out of scope
 * for v1.
 */

import { EventEmitter } from 'node:events'
import { z } from 'zod'
import { ConnectorSourceSchema, ConnectorStatusSchema } from './schema.js'
import type { ConnectorSource, ConnectorStatus } from './schema.js'

// ---------------------------------------------------------------------------
// Event schema
// ---------------------------------------------------------------------------

export const ConnectorStatusEventSchema = z.object({
  /** Discriminator for future event types on the same channel. */
  type: z.literal('connector.status_changed'),
  /** Unique id of the connector (e.g. `web_search`, MCP server id). */
  connectorId: z.string().min(1),
  /** Tool source that owns this connector. */
  source: ConnectorSourceSchema,
  /** New status after the transition. */
  status: ConnectorStatusSchema,
  /** Previous status. Null when this is the first observation for the id. */
  previousStatus: ConnectorStatusSchema.nullable(),
  /** Optional human-readable reason (e.g. "Credentials saved"). */
  reason: z.string().optional(),
  /** ISO timestamp of emission. */
  at: z.string().min(1),
})

export type ConnectorStatusEvent = z.infer<typeof ConnectorStatusEventSchema>

/** Listener contract — receives already-validated events. */
export type ConnectorStatusListener = (event: ConnectorStatusEvent) => void

/** Unsubscribe handle, idempotent. */
export type Unsubscribe = () => void

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

export interface EmitInput {
  readonly connectorId: string
  readonly source: ConnectorSource
  readonly status: ConnectorStatus
  /**
   * If provided, this is used as the previous status and the bus cache
   * is updated. If omitted, the bus reads its cache (null when unknown)
   * and then records the new status.
   */
  readonly previousStatus?: ConnectorStatus | null
  readonly reason?: string
}

const EVENT_NAME = 'connector.status_changed'

/**
 * Emit semantics:
 *   - Always validates through Zod before dispatching.
 *   - If the computed previousStatus equals status, no event is dispatched.
 *     Idempotent callers (e.g. "saveCredentials" called twice with the
 *     same body) don't spam the client with no-op transitions.
 */
export class ConnectorStatusBus {
  private readonly emitter = new EventEmitter()
  private readonly lastStatus = new Map<string, ConnectorStatus>()

  constructor() {
    // Subscribers may come and go frequently; keep the warning ceiling
    // high enough that a healthy gateway never fires it.
    this.emitter.setMaxListeners(100)
  }

  subscribe(listener: ConnectorStatusListener): Unsubscribe {
    this.emitter.on(EVENT_NAME, listener)
    return () => {
      this.emitter.off(EVENT_NAME, listener)
    }
  }

  /**
   * Publish a status transition. Returns the event that was dispatched,
   * or null when the transition was a no-op (status unchanged).
   */
  emit(input: EmitInput): ConnectorStatusEvent | null {
    const key = `${input.source}:${input.connectorId}`
    const prior =
      input.previousStatus !== undefined
        ? input.previousStatus
        : this.lastStatus.get(key) ?? null

    if (prior === input.status) {
      // Still record it — a caller that passed an explicit previousStatus
      // may have raced with the cache, and we still want the latest
      // value memoized for the next emit.
      this.lastStatus.set(key, input.status)
      return null
    }

    const event: ConnectorStatusEvent = {
      type: 'connector.status_changed',
      connectorId: input.connectorId,
      source: input.source,
      status: input.status,
      previousStatus: prior,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      at: new Date().toISOString(),
    }

    // Validate on the way out — the bus is a published contract.
    ConnectorStatusEventSchema.parse(event)

    this.lastStatus.set(key, input.status)
    this.emitter.emit(EVENT_NAME, event)
    return event
  }

  /**
   * Read the currently cached status without publishing. Used by
   * emitters that want to know whether their computed "new status"
   * would be a no-op before doing expensive work (e.g. a full
   * WebSearchService.resolve()).
   */
  peek(source: ConnectorSource, connectorId: string): ConnectorStatus | null {
    return this.lastStatus.get(`${source}:${connectorId}`) ?? null
  }

  /** Number of live subscribers. Observability + tests. */
  get listenerCount(): number {
    return this.emitter.listenerCount(EVENT_NAME)
  }

  /** Remove every subscriber. Used on gateway shutdown. */
  clear(): void {
    this.emitter.removeAllListeners(EVENT_NAME)
    this.lastStatus.clear()
  }

  /** Test-only: reset the memoized status cache. */
  __resetForTests(): void {
    this.lastStatus.clear()
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

/**
 * The gateway instantiates one bus at boot and hands the same instance
 * to every emitter/subscriber. Exposing a module-level singleton too
 * would defeat test isolation — tests construct their own bus and pass
 * it in. Production code paths receive the bus via DI (constructor
 * arg / handler factory parameter), never by reaching for a global.
 */
export function createConnectorStatusBus(): ConnectorStatusBus {
  return new ConnectorStatusBus()
}
