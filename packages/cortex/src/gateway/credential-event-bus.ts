/**
 * CredentialEventBus — fan-out of credential CRUD transitions.
 *
 * Problem this solves
 * -------------------
 * Before this bus existed the credential-store handlers (create / update /
 * delete / validate) wrote to disk + SQLite and returned 200, but never
 * notified any subscriber. The client's `credentialKeys.list` query was cached
 * with a 10s staleTime + window-focus refetch, so a save in window A only
 * became visible in window B after up to 10s + a focus change. Multi-window
 * users (the common "Settings opened twice" path) saw stale lists. The
 * audit board calls this issue #5 H1.
 *
 * Shape mirrors `ConnectorStatusBus` (see `connector/status-bus.ts`) — the
 * connector channel was the existing template:
 *   - In-process EventEmitter, no buffering.
 *   - Zod-validated payload at the bus boundary.
 *   - Emitters call `emit()` with a typed input; subscribers receive
 *     already-validated events.
 *
 * Principle 5 (local-first / zero-credential-leak) — non-negotiable
 * ----------------------------------------------------------------
 * Events on this bus are INVALIDATE-ONLY. They carry `credentialId`,
 * `action`, and `at` — nothing more. The plaintext value, the masked
 * hint, even the credential's `name` are explicitly absent so that
 * an SSE consumer cannot reconstruct the row from the event stream
 * alone. Clients re-fetch via `GET /api/v1/credentials` to pick up the
 * new state. This matches the package CLAUDE.md "Gateway Realtime
 * Contract" rule: "SSE never carries business payloads — it carries
 * `{ type, resource_id }` invalidation hints only."
 *
 * Scope
 * -----
 * Single-process (the gateway is one Node process). A multi-process
 * gateway would swap this for Redis/NATS; not in v1. Same trade-off
 * as `EventBus` and `ConnectorStatusBus`.
 */

import { EventEmitter } from 'node:events'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Event schema
// ---------------------------------------------------------------------------

/**
 * Discriminator for the action that produced the event.
 *
 *   created   — POST /api/v1/credentials succeeded.
 *   updated   — PATCH succeeded (any tri-state field touched).
 *   deleted   — DELETE succeeded, soft- or hard-delete.
 *   validated — POST /:id/validate ran; the credential row's
 *               `status` and `statusReason` may have flipped.
 */
export const CredentialActionSchema = z.enum([
  'created',
  'updated',
  'deleted',
  'validated',
])
export type CredentialAction = z.infer<typeof CredentialActionSchema>

export const CredentialChangedEventSchema = z.object({
  /** Discriminator. Kept open for future credential.* event types. */
  type: z.literal('credential.changed'),
  /** Stable id of the affected credential row (`cred_<uuid>`). */
  credentialId: z.string().min(1),
  /** What the gateway did to the row. */
  action: CredentialActionSchema,
  /** ISO timestamp of emission. */
  at: z.string().min(1),
})

export type CredentialChangedEvent = z.infer<typeof CredentialChangedEventSchema>

/** Listener contract — receives already-validated events. */
export type CredentialEventListener = (event: CredentialChangedEvent) => void

/** Unsubscribe handle, idempotent. */
export type Unsubscribe = () => void

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

export interface EmitCredentialInput {
  readonly credentialId: string
  readonly action: CredentialAction
}

const EVENT_NAME = 'credential.changed'

export class CredentialEventBus {
  private readonly emitter = new EventEmitter()

  constructor() {
    // The Settings screen can spawn many short-lived subscribers (a
    // window opening/closing, dev HMR remounts). Match the ceiling used
    // by `ConnectorStatusBus` so a healthy gateway never trips it.
    this.emitter.setMaxListeners(100)
  }

  subscribe(listener: CredentialEventListener): Unsubscribe {
    this.emitter.on(EVENT_NAME, listener)
    return () => {
      this.emitter.off(EVENT_NAME, listener)
    }
  }

  /**
   * Publish a credential change. Returns the event that was dispatched.
   *
   * No idempotency suppression (unlike `ConnectorStatusBus`): two
   * back-to-back `updated` events on the same id are legitimate — e.g.
   * the user fixed a name, then rotated the value. The bus is a hint
   * stream; cached observers will refetch and converge regardless.
   *
   * Validation runs on every emit so a future caller that drops a
   * required field fails loudly here, not silently on the wire.
   */
  emit(input: EmitCredentialInput): CredentialChangedEvent {
    const event: CredentialChangedEvent = {
      type: 'credential.changed',
      credentialId: input.credentialId,
      action: input.action,
      at: new Date().toISOString(),
    }
    CredentialChangedEventSchema.parse(event)
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
 * instance through the credential-store handler factory + the SSE
 * handler factory. Tests construct their own bus and pass it in — no
 * module-level singleton, same DI shape as `createConnectorStatusBus`.
 */
export function createCredentialEventBus(): CredentialEventBus {
  return new CredentialEventBus()
}
