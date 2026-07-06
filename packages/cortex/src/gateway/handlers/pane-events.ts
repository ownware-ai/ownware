/**
 * SSE handler for the per-workspace pane CRUD channel.
 *
 *   GET /api/v1/workspaces/:wsId/panes/events
 *
 * Streams every `pane.changed` event from `PaneEventBus` that targets
 * the caller's workspace. The client's `usePaneEvents(wsId)` hook keeps
 * the `paneKeys.list(wsId)` cache warm on every emit so multi-window
 * users never see a stale pane layout.
 *
 * Shape mirrors `handlers/workspace-events.ts` byte-for-byte — same
 * `:ready` preamble, same 30 s `:keepalive` cadence, same
 * `stream.shutdown` semantics, same DI: caller passes the bus +
 * gateway state and gets back a handler function. The ONE difference
 * is the per-workspace scoping: the handler reads `:wsId` from the
 * route params and subscribes to ONLY that wsId's listener slot in
 * the bus. Cross-workspace events never reach this socket because
 * the bus's fan-out is per-wsId at the emitter layer.
 *
 * Principle 5 invariant: the wire frame is the event the bus emits
 * (validate-on-emit ensures only `wsId`, `paneId`, `action`, `at`,
 * and optional `paneKind` reach the socket). Pane `title`, `config`,
 * `metadata` never touch this code path.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  PaneChangedEvent,
  PaneEventBus,
} from '../pane-event-bus.js'
import { startSSE, writeSSE } from '../sse.js'
import { sendError } from '../router.js'
import type { GatewayState } from '../state.js'

const KEEPALIVE_INTERVAL_MS = 30_000
const GATEWAY_SHUTDOWN_RETRY_AFTER_MS = 5_000

export interface PaneEventsHandlerDeps {
  readonly bus: PaneEventBus
  readonly state: GatewayState
}

export function createPaneEventsHandler(deps: PaneEventsHandlerDeps) {
  const { bus, state } = deps

  async function streamPaneEvents(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    void req
    const wsId = params['wsId']
    if (wsId === undefined || wsId.length === 0) {
      sendError(res, 400, 'Missing wsId')
      return
    }

    startSSE(res)

    // Emit an initial ready comment so clients know the stream is open
    // even before the first real event lands. Matches the workspace
    // channel's preamble.
    res.write(':ready\n\n')

    // Queue + drain pattern: writes are async (writeSSE awaits drain),
    // so we serialize them to keep frame order matching emit order.
    // The bus listener is sync and only enqueues; drain runs in a
    // microtask. Same shape as workspace-events / credential-events.
    const queue: PaneChangedEvent[] = []
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

    // Subscribe ONLY to this wsId's listener slot. The bus's per-wsId
    // fan-out means cross-workspace emits never enter this callback —
    // we don't need a runtime filter here, the bus already enforces it.
    const unsubscribe = bus.subscribe(wsId, ev => {
      queue.push(ev)
      void drain()
    })

    // On gateway shutdown, send a structured frame BEFORE closing so
    // the client can distinguish "we restarted" from "network failure" and
    // back off intentionally. Reason + retry-after mirror the workspace
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
    // cadence to the workspace channel so a half-open TCP connection
    // surfaces on every channel at the same rate. Comments are ignored
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

  return { streamPaneEvents }
}
