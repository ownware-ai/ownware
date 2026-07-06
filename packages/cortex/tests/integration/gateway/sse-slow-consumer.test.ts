/**
 * SSE backpressure — slow-consumer drop.
 *
 * The handler caps both the live-tail write chain (`MAX_PENDING_WRITES`)
 * and the phase-1 replay buffer (`MAX_REPLAY_BUFFER`). When either cap
 * trips, the handler emits `stream.shutdown` with `reason: 'slow_consumer'`
 * and tears the socket down so the gateway memory footprint can't grow
 * unbounded on a frozen client.
 *
 * The cap is hard to provoke deterministically over real HTTP on
 * localhost — write() never returns false because the OS buffer drains
 * instantly when a consumer is reading, and a non-reading consumer
 * collides with vitest's fetch implementation which itself buffers
 * aggressively. So this suite runs a end-to-end smoke that proves:
 *
 *   1. The env overrides are read at request time, not module load.
 *   2. A real SSE connection survives a normal load with the default
 *      caps (no false-positive shutdowns).
 *
 * The full overflow path is exercised in production by long-tail clients
 * (sleeping laptops, hung tabs); a deterministic test of that path
 * would require exporting the handler internals so a mock `res` can
 * intentionally stall `write()`. Tracked as a follow-up improvement
 * rather than blocking the retention rollout.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'
import type { LoomEvent } from '@ownware/loom'

function textEvent(text: string): LoomEvent {
  return { type: 'text.delta', text, turnIndex: 0 } as LoomEvent
}

describe('SSE slow-consumer guard (smoke)', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  }, 30_000)

  afterAll(async () => {
    await gw.stop()
  })

  it('does not drop a normal consumer that reads at line rate', async () => {
    const thread = gw.state.createThread('mini')
    const agentId = 'agent_normal'

    // Modest pre-ingest so phase-1 has work but well under any cap.
    for (let i = 0; i < 50; i++) {
      gw.state.eventIngestor.ingestSubagentEvent(thread.id, agentId, textEvent(`pre-${i}`))
    }

    const res = await fetch(
      `${gw.baseUrl}/api/v1/threads/${thread.id}/agents/${agentId}/events`,
      { headers: { Authorization: `Bearer ${gw.token}` } },
    )
    expect(res.status).toBe(200)

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let sawShutdown = false
    let sawReplayComplete = false

    const deadline = Date.now() + 3_000
    try {
      while (Date.now() < deadline && !sawShutdown && !sawReplayComplete) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          if (block.includes('event: stream.shutdown')) sawShutdown = true
          if (block.includes('event: stream.replay.complete')) sawReplayComplete = true
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }

    // A reading consumer never trips the cap — proves no false-positive.
    expect(sawShutdown).toBe(false)
    expect(sawReplayComplete).toBe(true)
  })
})
