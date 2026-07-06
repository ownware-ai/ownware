/**
 * Journey 13: Data isolation
 *
 * Verifies that data is strictly isolated between profiles, workspaces,
 * and threads. No leaks. No cross-contamination.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'

describe('Journey: 13 Data Isolation', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('Profile A and B usage records are independent', () => {
    gw.state.addUsageRecord({
      profileId: 'iso-a',
      model: 'm', provider: 'p',
      inputTokens: 100, outputTokens: 50, costUsd: 0.01,
    })
    gw.state.addUsageRecord({
      profileId: 'iso-b',
      model: 'm', provider: 'p',
      inputTokens: 200, outputTokens: 100, costUsd: 0.02,
    })

    const breakdown = gw.state.getProfileBreakdown()
    const a = breakdown.find(r => r.profileId === 'iso-a')!
    const b = breakdown.find(r => r.profileId === 'iso-b')!

    expect(a.tokens).toBe(150)
    expect(b.tokens).toBe(300)
    expect(a.cost).toBeCloseTo(0.01)
    expect(b.cost).toBeCloseTo(0.02)
  })

  it('Workspace 1 threads do not appear in workspace 2', () => {
    const ws1 = gw.state.createWorkspace(gw.tmpDir + '_iso1', 'iso1')
    const ws2 = gw.state.createWorkspace(gw.tmpDir + '_iso2', 'iso2')

    gw.state.createThread('mini', 'iso-t1', ws1.id)
    gw.state.createThread('mini', 'iso-t2', ws1.id)
    gw.state.createThread('mini', 'iso-t3', ws2.id)

    const ws1Threads = gw.state.listThreadsByWorkspace(ws1.id)
    const ws2Threads = gw.state.listThreadsByWorkspace(ws2.id)

    expect(ws1Threads.length).toBe(2)
    expect(ws2Threads.length).toBe(1)

    const ws1Ids = ws1Threads.map(t => t.id)
    for (const t of ws2Threads) {
      expect(ws1Ids).not.toContain(t.id)
    }
  })

  it('Deleting thread cascades to its messages', () => {
    const t = gw.state.createThread('mini', 'cascade-test')
    gw.state.addMessage(t.id, {
      id: 'msg_cascade_1',
      role: 'user',
      content: 'test',
      timestamp: new Date().toISOString(),
    })
    expect(gw.state.getMessages(t.id).length).toBe(1)

    gw.state.deleteThread(t.id)
    expect(gw.state.getMessages(t.id).length).toBe(0)
    expect(gw.state.getThread(t.id)).toBeUndefined()
  })

  it('Deleting workspace orphans threads (does NOT delete them)', () => {
    const ws = gw.state.createWorkspace(gw.tmpDir + '_orphan', 'orphan-ws')
    const t1 = gw.state.createThread('mini', 'orphan-1', ws.id)

    gw.state.deleteWorkspace(ws.id)

    // Thread should still exist with workspaceId now null
    const after = gw.state.getThread(t1.id)
    expect(after).toBeDefined()
    expect(after?.workspaceId).toBeNull()
  })

  it('Each profile useCount tracks independently', () => {
    gw.state.incrementProfileUsage('iso-track-a', 0.01)
    gw.state.incrementProfileUsage('iso-track-a', 0.01)
    gw.state.incrementProfileUsage('iso-track-b', 0.02)

    const a = gw.state.getProfileMetadata('iso-track-a')!
    const b = gw.state.getProfileMetadata('iso-track-b')!

    expect(a.useCount).toBe(2)
    expect(b.useCount).toBe(1)
    expect(a.totalCost).toBeCloseTo(0.02)
    expect(b.totalCost).toBeCloseTo(0.02)
  })
})
