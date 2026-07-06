/**
 * SSE handler for the credential CRUD channel.
 *
 *   GET /api/v1/credentials/events
 *
 * Streams every `credential.changed` event from `CredentialEventBus` to
 * the connected client. The client's `useCredentialEvents` hook keeps the
 * `credentialKeys.list` query (and the dependent `providerKeys.list` /
 * `modelKeys.list` queries, since credential presence drives provider /
 * model availability) warm on every emit.
 *
 * Shape mirrors `handlers/connector-events.ts` — same keepalive cadence,
 * same `stream.shutdown` semantics, same DI: caller passes the bus +
 * gateway state and gets back a handler function. This keeps the SSE
 * surface uniform across channels so a single client transport can
 * consume any of them.
 *
 * Principle 5 invariant: the wire frame is the event the bus emits
 * (validate-on-emit ensures only `credentialId` + `action` + `at` reach
 * the socket). The plaintext value never touches this code path.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  CredentialChangedEvent,
  CredentialEventBus,
} from '../credential-event-bus.js'
import { startSSE, writeSSE } from '../sse.js'
import type { GatewayState } from '../state.js'

const KEEPALIVE_INTERVAL_MS = 30_000
const GATEWAY_SHUTDOWN_RETRY_AFTER_MS = 5_000

export interface CredentialEventsHandlerDeps {
  readonly bus: CredentialEventBus
  readonly state: GatewayState
}

export function createCredentialEventsHandler(deps: CredentialEventsHandlerDeps) {
  const { bus, state } = deps

  async function streamCredentialEvents(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    void req
    startSSE(res)

    // Emit an initial ready comment so clients know the stream is open
    // even before the first real event lands. Matches the connector
    // channel's preamble.
    res.write(':ready\n\n')

    // Queue + drain pattern: writes are async (writeSSE awaits drain),
    // so we serialize them to keep frame order matching emit order.
    // The bus listener is sync and only enqueues; drain runs in a
    // microtask. Same shape as connector-events.
    const queue: CredentialChangedEvent[] = []
    let draining = false

    const drain = async (): Promise<void> => {
      if (draining) return
      draining = true
      try {
        while (queue.length > 0 && !res.writableEnded) {
          const ev = queue.shift()!
          await writeSSE(res, ev.type, ev)
        }
      } finally {
        draining = false
      }
    }

    const unsubscribe = bus.subscribe(ev => {
      queue.push(ev)
      void drain()
    })

    // On gateway shutdown, send a structured frame BEFORE closing so
    // the client can distinguish "we restarted" from "network failure" and
    // back off intentionally. Reason + retry-after mirror the connector
    // channel byte-for-byte so the client transport doesn't fork.
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
        unsubscribe()
        unsubscribeShutdown()
        if (!res.writableEnded) res.end()
      }
    })

    // Transport-level keepalive (`:keepalive\n\n` comment). Identical
    // cadence to the connector channel so a half-open TCP connection
    // surfaces on both channels at the same rate. Comments are ignored
    // by the SSE parser; they exist purely to keep the socket alive
    // through idle stretches.
    const keepalive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(':keepalive\n\n')
      }
    }, KEEPALIVE_INTERVAL_MS)

    await new Promise<void>(resolve => {
      res.on('close', () => {
        clearInterval(keepalive)
        unsubscribe()
        unsubscribeShutdown()
        resolve()
      })
    })
  }

  return { streamCredentialEvents }
}
