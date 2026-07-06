/**
 * Stress: Concurrent writes
 *
 * Hammer the DB with concurrent writes to verify WAL mode + transactions
 * keep data consistent.
 *
 * Tests:
 *   - 100 concurrent addUsageRecord — count must be exactly 100
 *   - 50 concurrent addMessage on same thread — message_count atomic
 *   - 50 concurrent incrementProfileUsage — useCount atomic
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'

describe('Stress: Concurrent writes', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('100 concurrent addUsageRecord — exact count preserved', async () => {
    const promises: Promise<void>[] = []
    for (let i = 0; i < 100; i++) {
      promises.push(
        Promise.resolve().then(() => {
          gw.state.addUsageRecord({
            profileId: 'concurrent-usage',
            model: 'm', provider: 'p',
            inputTokens: 1, outputTokens: 1, costUsd: 0.001,
          })
        }),
      )
    }
    await Promise.all(promises)

    const breakdown = gw.state.getProfileBreakdown()
    const row = breakdown.find(r => r.profileId === 'concurrent-usage')!
    expect(row.runs).toBe(100)
  })

  it('100 concurrent addMessage on same thread — message_count atomic', async () => {
    const t = gw.state.createThread('mini', 'concurrent-msg')
    const promises: Promise<void>[] = []
    for (let i = 0; i < 100; i++) {
      promises.push(
        Promise.resolve().then(() => {
          gw.state.addMessage(t.id, {
            id: `msg_concur_${i}`,
            role: 'user',
            content: `Message ${i}`,
            timestamp: new Date().toISOString(),
          })
        }),
      )
    }
    await Promise.all(promises)

    const updated = gw.state.getThread(t.id)!
    expect(updated.messageCount).toBe(100)
    expect(gw.state.getMessages(t.id).length).toBe(100)
  })

  it('100 concurrent incrementProfileUsage — useCount atomic', async () => {
    const promises: Promise<void>[] = []
    for (let i = 0; i < 100; i++) {
      promises.push(
        Promise.resolve().then(() => {
          gw.state.incrementProfileUsage('concurrent-profile', 0.01)
        }),
      )
    }
    await Promise.all(promises)

    const meta = gw.state.getProfileMetadata('concurrent-profile')!
    expect(meta.useCount).toBe(100)
    expect(meta.totalCost).toBeCloseTo(1.0)
  })
})
