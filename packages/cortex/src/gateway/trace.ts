/**
 * Pipeline trace — per-seam structured logging for the run → bus → SSE path.
 *
 * Gated on `OWNWARE_TRACE=1` so production is silent. When enabled every seam
 * emits one line so the full lifetime of an event can be reconstructed by
 * grepping on (thread, seq). The desktop client keeps an equivalent
 * SSE-trace helper that uses the same format so server and browser logs
 * line up when you open both side-by-side.
 *
 * Turn on:   OWNWARE_TRACE=1 bun run dev
 * Turn off:  (default) — helper is a no-op when the env var is missing.
 *
 * Format: [trace <thread8>/<agent>] <phase> type=<event> seq=<n> extra…
 * Example:
 *   [trace a1b2c3d4/root] runner-ingest type=text.delta seq=42
 *   [trace a1b2c3d4/root] bus-publish   type=text.delta seq=42
 *   [trace a1b2c3d4/root] sse-enqueue   type=text.delta seq=42 pending=1
 *   [trace a1b2c3d4/root] sse-write     type=text.delta seq=42 drain=0ms
 */

const TRACE_ENABLED = process.env['OWNWARE_TRACE'] === '1'

/**
 * Cheap per-phase last-seen map so each log line can include `dt=<ms>` —
 * how long since the same (thread+phase+type) happened last. Catches the
 * "GPT goes silent for 12s" case without needing to diff timestamps by eye.
 */
const lastSeen = new Map<string, number>()

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(-8)
}

export function trace(
  phase: string,
  threadId: string,
  agentId: string,
  eventType: string,
  extra?: Record<string, unknown>,
): void {
  if (!TRACE_ENABLED) return
  const now = Date.now()
  const key = `${threadId}|${phase}|${eventType}`
  const prev = lastSeen.get(key)
  lastSeen.set(key, now)
  const dt = prev != null ? `${now - prev}ms` : 'first'
  const extras = extra
    ? ' ' + Object.entries(extra)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
    : ''
  // eslint-disable-next-line no-console
  console.log(
    `[trace ${shortId(threadId)}/${agentId}] ${phase} type=${eventType} dt=${dt}${extras}`,
  )
}

export const traceEnabled = TRACE_ENABLED
