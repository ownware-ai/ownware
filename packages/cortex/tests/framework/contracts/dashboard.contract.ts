/**
 * Contract: Dashboard endpoints + internal state methods
 *
 * GET /api/v1/dashboard
 * Plus internal methods (getKPIs, getUsageTimeSeries, getProfileBreakdown,
 * getRecentActivity) tested directly via state.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { z } from 'zod'
import { createTestGateway, type TestGateway } from '../harness/index.js'
import {
  DashboardStatsSchema,
  DashboardKPIsSchema,
  UsageBucketSchema,
  ProfileBreakdownRowSchema,
  RecentActivityRowSchema,
} from '../harness/schema-validator.js'

describe('Contract: Dashboard', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway({
      seed: (state) => {
        // Seed some usage records for non-empty dashboard
        for (let i = 0; i < 3; i++) {
          state.addUsageRecord({
            profileId: 'mini',
            model: 'anthropic:claude-sonnet-4-20250514',
            provider: 'anthropic',
            inputTokens: 100,
            outputTokens: 50,
            costUsd: 0.01,
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

  it('GET /dashboard returns valid DashboardStats', async () => {
    const r = await gw.client.get('/api/v1/dashboard', DashboardStatsSchema)
    expect(r.status).toBe(200)
    expect(typeof r.body.activeAgents).toBe('number')
    expect(typeof r.body.todayRuns).toBe('number')
    expect(typeof r.body.todayTokens).toBe('number')
    expect(typeof r.body.todayCost).toBe('number')
    expect(Array.isArray(r.body.byProfile)).toBe(true)
    expect(Array.isArray(r.body.byWorkspace)).toBe(true)
  })

  // ── Internal state methods (will become HTTP endpoints later) ──

  it('state.getKPIs(7d) returns 4 cards with sparklines', () => {
    const kpis = gw.state.getKPIs('7d')
    const result = DashboardKPIsSchema.safeParse(kpis)
    expect(result.success).toBe(true)
    expect(kpis.cards.length).toBe(4)
    expect(kpis.range).toBe('7d')
    for (const card of kpis.cards) {
      expect(card.sparkline.length).toBe(12)
    }
  })

  it('state.getUsageTimeSeries(7d) returns 7 daily buckets', () => {
    const buckets = gw.state.getUsageTimeSeries('7d')
    const result = z.array(UsageBucketSchema).safeParse(buckets)
    expect(result.success).toBe(true)
    expect(buckets.length).toBe(7)
  })

  it('state.getUsageTimeSeries(24h) returns 24 hourly buckets', () => {
    const buckets = gw.state.getUsageTimeSeries('24h')
    expect(buckets.length).toBe(24)
  })

  it('state.getUsageTimeSeries(30d) returns 30 daily buckets', () => {
    const buckets = gw.state.getUsageTimeSeries('30d')
    expect(buckets.length).toBe(30)
  })

  it('state.getUsageTimeSeries(90d) returns 90 daily buckets', () => {
    const buckets = gw.state.getUsageTimeSeries('90d')
    expect(buckets.length).toBe(90)
  })

  it('state.getProfileBreakdown returns valid rows', () => {
    const rows = gw.state.getProfileBreakdown()
    const result = z.array(ProfileBreakdownRowSchema).safeParse(rows)
    expect(result.success).toBe(true)
    // We seeded 3 mini records
    const mini = rows.find(r => r.profileId === 'mini')
    expect(mini).toBeDefined()
    expect(mini!.runs).toBeGreaterThanOrEqual(3)
  })

  it('state.getRecentActivity returns valid rows', () => {
    const rows = gw.state.getRecentActivity(10)
    const result = z.array(RecentActivityRowSchema).safeParse(rows)
    expect(result.success).toBe(true)
    expect(rows.length).toBeGreaterThanOrEqual(3)
  })

  it('KPI delta is null when no prior period exists', () => {
    const kpis = gw.state.getKPIs('7d')
    const tokens = kpis.cards.find(c => c.label === 'Tokens')!
    // Fresh DB, only current period has data → delta is null
    expect(tokens.delta).toBeNull()
  })

  it('KPI cards include Tokens, Cost, Runs, Avg Duration', () => {
    const kpis = gw.state.getKPIs('7d')
    const labels = kpis.cards.map(c => c.label)
    expect(labels).toContain('Tokens')
    expect(labels).toContain('Cost')
    expect(labels).toContain('Runs')
    expect(labels).toContain('Avg Duration')
  })
})
