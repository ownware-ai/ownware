/**
 * Debug script: reproduce the "stuck SSE stream" symptom deterministically.
 *
 * Opens the SSE endpoint, reads the first N chunks, then STOPS reading —
 * simulating a browser tab where the main thread is frozen (heavy render,
 * devtools paused on a breakpoint, GC stall, etc.). The gateway's
 * writeChain should then back up, hit the `pendingWrites` threshold logs,
 * and eventually fire the `slow_consumer` shutdown frame.
 *
 * Expected server-side log sequence on a run with many events:
 *   [sse <thread>/root] pendingWrites=100 (threshold 100, cap 1000)
 *   [sse] drain wait 2000ms for event=text.delta — slow/stuck consumer
 *   [sse] drain wait 4000ms for event=text.delta — slow/stuck consumer
 *   [sse <thread>/root] pendingWrites=500 (threshold 500, cap 1000)
 *   [sse <thread>/root] pendingWrites=900 (threshold 900, cap 1000)
 *   — eventually — slow_consumer shutdown frame emitted
 *
 * Usage:
 *   cd packages/cortex
 *   bun run scripts/debug-sse-stall.ts <threadId> [readCount=3] [hangSeconds=60]
 *
 * Tip: run the gateway with its logs visible, and run this script in a
 * second terminal so you can watch the backpressure build up in real time.
 */

const GATEWAY = process.env['OWNWARE_GATEWAY_URL'] ?? 'http://127.0.0.1:3011'

async function main(): Promise<void> {
  const [, , threadId, readCountRaw, hangSecondsRaw] = process.argv
  if (!threadId) {
    console.error('usage: debug-sse-stall.ts <threadId> [readCount=3] [hangSeconds=60]')
    process.exit(1)
  }
  const readCount = readCountRaw ? parseInt(readCountRaw, 10) : 3
  const hangSeconds = hangSecondsRaw ? parseInt(hangSecondsRaw, 10) : 60

  const url = `${GATEWAY}/api/v1/threads/${threadId}/agents/root/events?since=0`
  console.log(`[stall-probe] connecting to ${url}`)
  const t0 = Date.now()
  const res = await fetch(url, { headers: { Accept: 'text/event-stream' } })
  console.log(`[stall-probe] status=${res.status} (${Date.now() - t0}ms)`)
  if (!res.ok || res.body == null) {
    console.error('[stall-probe] bad response — aborting')
    process.exit(1)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let eventCount = 0
  let keepaliveCount = 0

  for (let i = 0; i < readCount; i++) {
    const readStart = Date.now()
    const { value, done } = await reader.read()
    const readMs = Date.now() - readStart
    if (done) {
      console.log(`[stall-probe] stream ended after read #${i + 1} (${readMs}ms)`)
      return
    }
    const text = decoder.decode(value, { stream: true })
    totalBytes += value.byteLength
    const events = text.match(/\nevent: /g)?.length ?? 0
    const keeps = text.match(/\n:keepalive/g)?.length ?? 0
    eventCount += events
    keepaliveCount += keeps
    console.log(
      `[stall-probe] read #${i + 1}: ${value.byteLength} bytes, +${events} events, +${keeps} keepalives (${readMs}ms)`,
    )
  }

  console.log(
    `[stall-probe] now hanging for ${hangSeconds}s — watch the gateway logs for drain warnings and pendingWrites thresholds`,
  )
  console.log(
    `[stall-probe] totals so far: bytes=${totalBytes} events=${eventCount} keepalives=${keepaliveCount}`,
  )

  await new Promise<void>((resolve) => setTimeout(resolve, hangSeconds * 1000))

  console.log(`[stall-probe] hang complete — resuming reads to drain`)
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      totalBytes += value?.byteLength ?? 0
    }
  } catch (err) {
    console.log(`[stall-probe] read errored during drain: ${err instanceof Error ? err.message : String(err)}`)
  }
  console.log(`[stall-probe] final bytes=${totalBytes}`)
}

main().catch((err) => {
  console.error('[stall-probe] fatal:', err)
  process.exit(1)
})
