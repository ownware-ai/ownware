/**
 * Journey 08: Dashboard accuracy
 *
 * Seed known data, verify every dashboard query reflects it accurately.
 *   1. Create 2 profiles + insert known usage records for each
 *   2. Verify dashboard stats match
 *   3. Verify time series buckets sum to inputs
 *   4. Verify profile breakdown matches per-profile sums
 *   5. Verify recent activity shows newest first
 *   6. Verify KPIs reflect totals
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'

describe('Journey: 08 Dashboard Accuracy', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway({
      seed: (state) => {
        // Profile A: 3 runs, 600 tokens total, $0.06 total
        for (let i = 0; i < 3; i++) {
          state.addUsageRecord({
            profileId: 'profile-a',
            model: 'anthropic:claude-sonnet-4-20250514',
            provider: 'anthropic',
            inputTokens: 100,
            outputTokens: 100,
            costUsd: 0.02,
            durationMs: 1000,
            success: true,
          })
        }
        // Profile B: 2 runs, 600 tokens total, $0.04 total
        for (let i = 0; i < 2; i++) {
          state.addUsageRecord({
            profileId: 'profile-b',
            model: 'anthropic:claude-haiku-4-5-20251001',
            provider: 'anthropic',
            inputTokens: 200,
            outputTokens: 100,
            costUsd: 0.02,
            durationMs: 500,
            success: true,
          })
        }
      },
    })
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('Step 1: GET /dashboard reflects total runs', async () => {
    const r = await gw.client.get<{ todayRuns: number; todayTokens: number }>('/api/v1/dashboard')
    expect(r.body.todayRuns).toBe(5)
    expect(r.body.todayTokens).toBe(1200) // 600 + 600
  })

  it('Step 2: KPIs reflect totals', () => {
    const kpis = gw.state.getKPIs('7d')
    const tokens = kpis.cards.find(c => c.label === 'Tokens')!
    const cost = kpis.cards.find(c => c.label === 'Cost')!
    const runs = kpis.cards.find(c => c.label === 'Runs')!

    expect(tokens.value).toBe(1200)
    expect(cost.value).toBeCloseTo(0.10)
    expect(runs.value).toBe(5)
  })

  it('Step 3: Today bucket has correct counts', () => {
    const buckets = gw.state.getUsageTimeSeries('7d')
    const today = new Date().toISOString().split('T')[0]!
    const todayBucket = buckets.find(b => b.date === today)!
    expect(todayBucket).toBeDefined()
    expect(todayBucket.runs).toBe(5)
    expect(todayBucket.tokens).toBe(1200)
    expect(todayBucket.cost).toBeCloseTo(0.10)
  })

  it('Step 4: Profile breakdown shows both profiles', () => {
    const rows = gw.state.getProfileBreakdown()
    const a = rows.find(r => r.profileId === 'profile-a')!
    const b = rows.find(r => r.profileId === 'profile-b')!

    expect(a.runs).toBe(3)
    expect(a.tokens).toBe(600)
    expect(a.cost).toBeCloseTo(0.06)
    expect(a.avgDurationMs).toBe(1000)
    expect(a.successRate).toBe(1)

    expect(b.runs).toBe(2)
    expect(b.tokens).toBe(600)
    expect(b.cost).toBeCloseTo(0.04)
    expect(b.avgDurationMs).toBe(500)
    expect(b.successRate).toBe(1)
  })

  it('Step 5: Recent activity returns 5 entries newest first', () => {
    const activity = gw.state.getRecentActivity(10)
    expect(activity.length).toBe(5)
    for (let i = 0; i < activity.length - 1; i++) {
      expect(activity[i]!.createdAt >= activity[i + 1]!.createdAt).toBe(true)
    }
  })

  it('Step 6: byProfile in dashboard sums correctly', async () => {
    const r = await gw.client.get<{ byProfile: Array<{ profileId: string; runCount: number }> }>('/api/v1/dashboard')
    const a = r.body.byProfile.find(p => p.profileId === 'profile-a')
    const b = r.body.byProfile.find(p => p.profileId === 'profile-b')
    expect(a?.runCount).toBe(3)
    expect(b?.runCount).toBe(2)
  })
})
