/**
 * SSE handler for the multiplexed gateway invalidation channel.
 *
 *   GET /api/v1/events
 *
 * One SSE connection carries `connector.status_changed`,
 * `credential.changed`, and `workspace.changed` envelopes — every
 * always-on invalidation hint the app-root subscribes to today as
 * three separate channels. The client's `useGatewayEvents` hook
 * (replacing `useConnectorEvents` / `useCredentialEvents` /
 * `useWorkspaceEvents` in `app-effects.tsx`) routes each envelope to
 * the existing coalescer.
 *
 * Why multiplex
 * ---------------------------------------------------------------------
 * Chrome caps HTTP/1.1 at 6 concurrent connections per origin. Each
 * always-on per-resource SSE channel holds one slot for the lifetime
 * of the client window. With 4 invalidation channels (the three folded
 * here plus the per-workspace pane channel) + the chat-stream
 * channel + any pane-scoped channels open (files, terminal, tasks,
 * memory), a typical streaming workspace already exceeds the cap,
 * causing real user-driven HTTP to queue indefinitely. Folding the
 * three GLOBAL invalidation channels into one frees 2 slots
 * regardless of window count — a per-window structural improvement.
 *
 * Pane events stay per-workspace for now: their bus is wsId-scoped
 * and the routing complexity belongs to a follow-up slice.
 *
 * Shape mirrors `handlers/credential-events.ts` byte-for-byte (same
 * preamble, queue+drain, keepalive cadence, stream.shutdown
 * semantics). Each event reuses its native bus event name as the SSE
 * `event:` field so the client can read the discriminator without
 * unwrapping a custom envelope.
 *
 * Principle 5 (no business payloads) — preserved. Each bus already
 * validates its event on emit; this handler only fans the validated
 * payloads through one socket.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectorStatusBus, ConnectorStatusEvent } from '../../connector/status-bus.js'
import type {
  CredentialChangedEvent,
  CredentialEventBus,
} from '../credential-event-bus.js'
import type {
  WorkspaceChangedEvent,
  WorkspaceEventBus,
} from '../workspace-event-bus.js'
import type { TeamChangedEvent, TeamEventBus } from '../../team/event-bus.js'
import { startSSE, writeSSE } from '../sse.js'
import type { GatewayState } from '../state.js'

const KEEPALIVE_INTERVAL_MS = 30_000
const GATEWAY_SHUTDOWN_RETRY_AFTER_MS = 5_000

export interface GatewayEventsHandlerDeps {
  readonly connectorBus: ConnectorStatusBus
  readonly credentialBus: CredentialEventBus
  readonly workspaceBus: WorkspaceEventBus
  /**
   * Team vertical invalidation hints (board changes, catalog changes).
   * Optional so tests that construct the handler without the team
   * module keep working; absent → no `team.changed` events on the wire.
   */
  readonly teamBus?: TeamEventBus
  readonly state: GatewayState
}

type QueuedEvent =
  | { readonly kind: 'connector.status_changed'; readonly event: ConnectorStatusEvent }
  | { readonly kind: 'credential.changed'; readonly event: CredentialChangedEvent }
  | { readonly kind: 'workspace.changed'; readonly event: WorkspaceChangedEvent }
  | { readonly kind: 'team.changed'; readonly event: TeamChangedEvent }

export function createGatewayEventsHandler(deps: GatewayEventsHandlerDeps) {
  const { connectorBus, credentialBus, workspaceBus, teamBus, state } = deps

  async function streamGatewayEvents(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    void req
    startSSE(res)
    res.write(':ready\n\n')

    // Single FIFO queue across all three buses. Cross-bus ordering is
    // the wall-clock arrival order of emits — TS event loop is single-
    // threaded so an emit on bus A arriving before an emit on bus B
    // enqueues first. The queue+drain pattern is identical to the
    // single-bus handlers; the only addition is a `kind` discriminator
    // per item so the drain loop picks the right SSE event name.
    const queue: QueuedEvent[] = []
    let draining = false

    const drain = async (): Promise<void> => {
      if (draining) return
      draining = true
      try {
        while (queue.length > 0 && !res.writableEnded) {
          const item = queue.shift()!
          await writeSSE(res, item.kind, item.event)
        }
      } finally {
        draining = false
      }
    }

    const unsubscribeConnector = connectorBus.subscribe((ev) => {
      queue.push({ kind: 'connector.status_changed', event: ev })
      void drain()
    })
    const unsubscribeCredential = credentialBus.subscribe((ev) => {
      queue.push({ kind: 'credential.changed', event: ev })
      void drain()
    })
    const unsubscribeWorkspace = workspaceBus.subscribe((ev) => {
      queue.push({ kind: 'workspace.changed', event: ev })
      void drain()
    })
    const unsubscribeTeam = teamBus?.subscribe((ev) => {
      queue.push({ kind: 'team.changed', event: ev })
      void drain()
    })

    const unsubscribeAll = (): void => {
      unsubscribeConnector()
      unsubscribeCredential()
      unsubscribeWorkspace()
      unsubscribeTeam?.()
    }

    const unsubscribeShutdown = state.subscribeToShutdown(async () => {
      if (res.writableEnded) return
      try {
        await writeSSE(res, 'stream.shutdown', {
          type: 'stream.shutdown',
          reason: 'gateway_shutdown',
          retryAfterMs: GATEWAY_SHUTDOWN_RETRY_AFTER_MS,
        })
      } finally {
        clearInterval(keepalive)
        unsubscribeAll()
        unsubscribeShutdown()
        if (!res.writableEnded) res.end()
      }
    })

    const keepalive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(':keepalive\n\n')
      }
    }, KEEPALIVE_INTERVAL_MS)

    await new Promise<void>((resolve) => {
      res.on('close', () => {
        clearInterval(keepalive)
        unsubscribeAll()
        unsubscribeShutdown()
        resolve()
      })
    })
  }

  return { streamGatewayEvents }
}
