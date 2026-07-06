/**
 * SSE handler for the workspace CRUD channel.
 *
 *   GET /api/v1/workspaces/events
 *
 * Streams every `workspace.changed` event from `WorkspaceEventBus` to
 * the connected client. The client's `useWorkspaceEvents` hook keeps the
 * `workspaceKeys.all` cache warm on every emit so multi-window users
 * never see a stale workspace list.
 *
 * Shape mirrors `handlers/credential-events.ts` — same `:ready`
 * preamble, same 30 s `:keepalive` cadence, same `stream.shutdown`
 * semantics, same DI: caller passes the bus + gateway state and gets
 * back a handler function. This keeps the SSE surface uniform across
 * channels so a single client transport can consume any of them.
 *
 * Principle 5 invariant: the wire frame is the event the bus emits
 * (validate-on-emit ensures only `workspaceId` + `action` + `at` reach
 * the socket). Workspace name / path / description never touch this
 * code path.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  WorkspaceChangedEvent,
  WorkspaceEventBus,
} from '../workspace-event-bus.js'
import { startSSE, writeSSE } from '../sse.js'
import type { GatewayState } from '../state.js'

const KEEPALIVE_INTERVAL_MS = 30_000
const GATEWAY_SHUTDOWN_RETRY_AFTER_MS = 5_000

export interface WorkspaceEventsHandlerDeps {
  readonly bus: WorkspaceEventBus
  readonly state: GatewayState
}

export function createWorkspaceEventsHandler(deps: WorkspaceEventsHandlerDeps) {
  const { bus, state } = deps

  async function streamWorkspaceEvents(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    void req
    startSSE(res)

    // Emit an initial ready comment so clients know the stream is open
    // even before the first real event lands. Matches the credential
    // channel's preamble.
    res.write(':ready\n\n')

    // Queue + drain pattern: writes are async (writeSSE awaits drain),
    // so we serialize them to keep frame order matching emit order.
    // The bus listener is sync and only enqueues; drain runs in a
    // microtask. Same shape as credential-events.
    const queue: WorkspaceChangedEvent[] = []
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
    // back off intentionally. Reason + retry-after mirror the credential
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
    // cadence to the credential channel so a half-open TCP connection
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

  return { streamWorkspaceEvents }
}
