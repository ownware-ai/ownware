/**
 * Shared low-level SSE formatting helpers.
 */

import type { ServerResponse } from 'node:http'
import { trace, traceEnabled } from './trace.js'

/**
 * Set SSE response headers and begin streaming.
 *
 * CORS headers are already set by the router's handleCORS() middleware
 * before the handler runs. We must NOT override them here — writeHead()
 * replaces any previously-set header of the same name, which would
 * bypass the origin allowlist with a blanket '*'.
 */
export function startSSE(res: ServerResponse): void {
  // NOTE: no 'Connection: keep-alive' header. It is the implicit default
  // on HTTP/1.1 and is FORBIDDEN on HTTP/2 — writeHead would throw
  // ERR_HTTP2_INVALID_CONNECTION_HEADERS. Omitting it is correct on both
  // transports; the gateway serves SSE over HTTP/2 since
  // gateway-perf-2026-06-13.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  })
  // Flush small token writes immediately instead of letting TCP batch
  // them. HTTP/2 manages its own framing/flow-control and its compat
  // `socket` is a shared session proxy, so only poke the raw socket on
  // HTTP/1.1 (Http2ServerResponse exposes a `.stream`; ServerResponse
  // does not — that's the discriminator).
  if (!('stream' in res)) {
    res.socket?.setNoDelay(true)
  }
}

/**
 * Write a single SSE event.
 * Handles backpressure — if the kernel buffer is full, waits for drain.
 *
 * Emits a diagnostic log when drain takes longer than a threshold. A slow
 * drain means the downstream TCP receive window stayed full for that long
 * — the client is not reading. In a stuck-stream symptom this is the
 * smoking gun: every writeChain write was blocked here, so no events
 * ever left the gateway, even though the connection looked open.
 */
const DRAIN_WARN_MS = 2_000

export async function writeSSE(res: ServerResponse, event: string, data: unknown): Promise<void> {
  if (res.writableEnded) {
    if (traceEnabled) {
      // eslint-disable-next-line no-console
      console.log(`[trace ?/?] sse-write-skip type=${event} reason=ended`)
    }
    return
  }
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const ok = res.write(payload)
  if (traceEnabled) {
    const seq = typeof (data as { seq?: unknown })?.seq === 'number'
      ? (data as { seq: number }).seq
      : '?'
    const threadId = typeof (data as { threadId?: unknown })?.threadId === 'string'
      ? (data as { threadId: string }).threadId
      : ''
    const agentId = typeof (data as { agentId?: unknown })?.agentId === 'string'
      ? (data as { agentId: string }).agentId
      : '?'
    trace('sse-write', threadId, agentId, event, { seq, ok, bytes: payload.length })
  }
  if (!ok) {
    const waitStart = Date.now()
    await new Promise<void>((resolve) => res.once('drain', resolve))
    const waitMs = Date.now() - waitStart
    if (traceEnabled) {
      // eslint-disable-next-line no-console
      console.log(`[trace] sse-drain type=${event} wait=${waitMs}ms`)
    }
    if (waitMs >= DRAIN_WARN_MS) {
      // eslint-disable-next-line no-console
      console.warn(`[sse] drain wait ${waitMs}ms for event=${event} — slow/stuck consumer`)
    }
  }
}
