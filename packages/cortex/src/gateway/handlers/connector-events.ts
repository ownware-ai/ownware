/**
 * SSE handler for the generic connector-status channel.
 *
 *   GET /api/v1/connectors/events
 *
 * Streams every `connector.status_changed` event from the process-wide
 * `ConnectorStatusBus` to the client. The bus itself is transport-free;
 * this handler is the only place that translates bus events into SSE
 * frames.
 *
 * Keepalives + backpressure are reused from `sse.ts` patterns so the
 * behaviour matches the existing run-event stream.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectorStatusBus, ConnectorStatusEvent } from '../../connector/status-bus.js'
import { startSSE, writeSSE } from '../sse.js'
import type { GatewayState } from '../state.js'

const KEEPALIVE_INTERVAL_MS = 30_000
const GATEWAY_SHUTDOWN_RETRY_AFTER_MS = 5_000

export interface ConnectorEventsHandlerDeps {
  readonly statusBus: ConnectorStatusBus
  readonly state: GatewayState
}

export function createConnectorEventsHandler(deps: ConnectorEventsHandlerDeps) {
  const { statusBus, state } = deps

  async function streamConnectorEvents(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    void req
    startSSE(res)

    // Emit an initial ready comment so clients know the stream is open.
    res.write(':ready\n\n')

    const queue: ConnectorStatusEvent[] = []
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

    const unsubscribe = statusBus.subscribe(ev => {
      queue.push(ev)
      void drain()
    })

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

  return { streamConnectorEvents }
}
