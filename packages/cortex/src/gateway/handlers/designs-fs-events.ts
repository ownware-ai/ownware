/**
 * Design fs-events SSE handler — Slice B4.1.
 *
 *   GET /api/v1/designs/:designId/fs-events
 *     → SSE: `design-fs.changed` frames as the design's workspace
 *       folder mutates. Per-path; invalidation-shaped (no file
 *       content). Client re-fetches via `/api/v1/designs/:id/raw/*path`.
 *     → 404 { error: 'design_unknown', message } at open time when the
 *       design id doesn't resolve.
 *
 * Error bodies match the discriminator shape used by `files.ts` so
 * the client can branch on `body.error`, not status codes.
 *
 * Per the gateway realtime contract (`packages/cortex/src/gateway/CLAUDE.md`):
 *   - 30s heartbeats keep half-open TCPs detectable client-side.
 *   - Frames are invalidation hints. The client re-fetches the changed
 *     file via the existing raw endpoint.
 *   - No `?since=N` replay — the bus is in-memory, no durable log.
 *     If a client misses events while disconnected it re-fetches all
 *     known paths on reconnect (the client's hook handles that).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendError } from '../router.js'
import { startSSE, writeSSE } from '../sse.js'
import type {
  DesignFsChangedEvent,
  DesignFsEventBus,
  DesignFsService,
} from '../../files/index.js'

const KEEPALIVE_INTERVAL_MS = 30_000

export interface DesignFsEventsHandlerDeps {
  readonly service: DesignFsService
  readonly bus: DesignFsEventBus
}

type ErrorDiscriminator = 'design_unknown' | 'bad_request'

function sendStructuredError(
  res: ServerResponse,
  status: number,
  discriminator: ErrorDiscriminator,
  message: string,
): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
  }
  res.end(JSON.stringify({ error: discriminator, message }))
}

export function createDesignFsEventsHandlers(deps: DesignFsEventsHandlerDeps) {
  const { service, bus } = deps

  // GET /api/v1/designs/:designId/fs-events
  async function streamEvents(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const designId = params['designId']
    if (designId == null || designId.length === 0) {
      sendError(res, 400, 'Missing designId')
      return
    }

    // Pre-check resolution without spawning a watcher — keeps the
    // failure path cheap and avoids holding an SSE socket open just
    // to say "no such design."
    if (!service.hasDesign(designId)) {
      sendStructuredError(
        res,
        404,
        'design_unknown',
        `No design "${designId}"`,
      )
      return
    }

    startSSE(res)
    res.write(':ready\n\n')

    // Backpressure-aware queue — same idiom as files.ts:streamEvents.
    const queue: DesignFsChangedEvent[] = []
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

    const unsubFromBus = bus.subscribe((ev) => {
      if (ev.designId !== designId) return
      queue.push(ev)
      void drain()
    })
    // Keep the service-owned watcher alive for this connection's
    // lifetime. The callback is intentionally a no-op: we receive
    // the event payloads through the bus subscription above. The
    // subscribe call here is the load-bearing one — it refcounts.
    const unsubFromService = service.subscribe(designId)

    const keepalive = setInterval(() => {
      if (res.writableEnded) return
      res.write(':ka\n\n')
    }, KEEPALIVE_INTERVAL_MS)

    let cleanedUp = false
    const cleanup = (): void => {
      if (cleanedUp) return
      cleanedUp = true
      clearInterval(keepalive)
      unsubFromBus()
      if (unsubFromService != null) unsubFromService()
      if (!res.writableEnded) res.end()
    }

    req.on('close', cleanup)
    req.on('error', cleanup)
  }

  return { streamEvents }
}
