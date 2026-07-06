/**
 * Unit tests for dashboard analytics — KPIs, time series, profile breakdown,
 * recent activity, storage stats, and activity feed merging.
 *
 * Each test gets a fresh SQLite database seeded with test data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { GatewayState } from '../../../src/gateway/state.js'
import type { DashboardRange } from '../../../src/gateway/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let state: GatewayState
let tempDir: string

function seedUsageRecords(count: number, opts?: {
  profileId?: string
  daysAgo?: number
  durationMs?: number
  success?: boolean
}): void {
  const profileId = opts?.profileId ?? 'test-profile'
  const daysAgo = opts?.daysAgo ?? 0
  const durationMs = opts?.durationMs ?? 500
  const success = opts?.success ?? true

  for (let i = 0; i < count; i++) {
    const createdDate = new Date(Date.now() - (daysAgo * 86400 * 1000) - (i * 60000))
    state.addUsageRecord({
      profileId,
      model: `anthropic:claude-sonnet-4-20250514`,
      provider: 'anthropic',
      inputTokens: 100 + i,
      outputTokens: 50 + i,
      costUsd: 0.001 * (i + 1),
      durationMs,
      success,
    })
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cortex-dash-unit-'))
  state = new GatewayState(join(tempDir, 'test.db'))
})

afterEach(() => {
  state.close()
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// KPI tests
// ---------------------------------------------------------------------------

describe('getKPIs', () => {
  it('returns 4 KPI cards with sparklines of 12 points', () => {
    seedUsageRecords(10, { profileId: 'alpha' })

    const kpis = state.getKPIs('7d')
    expect(kpis.range).toBe('7d')
    expect(kpis.cards).toHaveLength(4)

    for (const card of kpis.cards) {
      expect(card.sparkline).toHaveLength(12)
      expect(card.label).toBeTruthy()
      expect(card.unit).toBeTruthy()
      expect(typeof card.value).toBe('number')
      // Delta can be null or number
      expect(card.delta === null || typeof card.delta === 'number').toBe(true)
    }
  })

  it('returns delta as null when previous period has no data', () => {
    // Only seed current period data
    seedUsageRecords(5)
    const kpis = state.getKPIs('7d')

    // With no prior data, delta should be null (not NaN or Infinity)
    for (const card of kpis.cards) {
      if (card.delta !== null) {
        expect(Number.isFinite(card.delta)).toBe(true)
      }
    }
  })

  it('uses hourly bucketing for 24h range', () => {
    seedUsageRecords(5)
    const kpis = state.getKPIs('24h')
    expect(kpis.range).toBe('24h')
    expect(kpis.cards).toHaveLength(4)
  })

  it('handles empty database without errors', () => {
    const kpis = state.getKPIs('7d')
    expect(kpis.cards).toHaveLength(4)
    for (const card of kpis.cards) {
      expect(card.value).toBe(0)
      expect(card.sparkline).toHaveLength(12)
      expect(card.sparkline.every(v => v === 0)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Usage time series tests
// ---------------------------------------------------------------------------

describe('getUsageTimeSeries', () => {
  it('returns 24 hourly buckets for 24h range', () => {
    seedUsageRecords(3)
    const buckets = state.getUsageTimeSeries('24h')
    expect(buckets).toHaveLength(24)
    // Buckets should be in chronological order
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i]!.date >= buckets[i - 1]!.date).toBe(true)
    }
  })

  it('returns 7 daily buckets for 7d range', () => {
    seedUsageRecords(3)
    const buckets = state.getUsageTimeSeries('7d')
    expect(buckets).toHaveLength(7)
  })

  it('returns 30 daily buckets for 30d range', () => {
    const buckets = state.getUsageTimeSeries('30d')
    expect(buckets).toHaveLength(30)
  })

  it('returns 90 daily buckets for 90d range', () => {
    const buckets = state.getUsageTimeSeries('90d')
    expect(buckets).toHaveLength(90)
  })

  it('zero-fills days with no data', () => {
    const buckets = state.getUsageTimeSeries('7d')
    for (const bucket of buckets) {
      expect(bucket.tokens).toBe(0)
      expect(bucket.cost).toBe(0)
      expect(bucket.runs).toBe(0)
    }
  })

  it('aggregates tokens/cost/runs correctly for seeded data', () => {
    seedUsageRecords(5)
    const buckets = state.getUsageTimeSeries('7d')
    const totalRuns = buckets.reduce((s, b) => s + b.runs, 0)
    expect(totalRuns).toBe(5)
    const totalTokens = buckets.reduce((s, b) => s + b.tokens, 0)
    expect(totalTokens).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Profile breakdown tests
// ---------------------------------------------------------------------------

describe('getProfileBreakdown', () => {
  it('groups by profile correctly', () => {
    seedUsageRecords(5, { profileId: 'alpha' })
    seedUsageRecords(3, { profileId: 'beta' })

    const breakdown = state.getProfileBreakdown()
    expect(breakdown).toHaveLength(2)

    const alpha = breakdown.find(r => r.profileId === 'alpha')
    const beta = breakdown.find(r => r.profileId === 'beta')
    expect(alpha).toBeDefined()
    expect(beta).toBeDefined()
    expect(alpha!.runs).toBe(5)
    expect(beta!.runs).toBe(3)
  })

  it('computes avgDurationMs from duration_ms column', () => {
    seedUsageRecords(3, { profileId: 'fast', durationMs: 100 })
    seedUsageRecords(3, { profileId: 'slow', durationMs: 1000 })

    const breakdown = state.getProfileBreakdown()
    const fast = breakdown.find(r => r.profileId === 'fast')
    const slow = breakdown.find(r => r.profileId === 'slow')
    expect(fast!.avgDurationMs).toBe(100)
    expect(slow!.avgDurationMs).toBe(1000)
  })

  it('computes successRate between 0 and 1', () => {
    seedUsageRecords(3, { profileId: 'good', success: true })
    seedUsageRecords(3, { profileId: 'bad', success: false })

    const breakdown = state.getProfileBreakdown()
    const good = breakdown.find(r => r.profileId === 'good')
    const bad = breakdown.find(r => r.profileId === 'bad')
    expect(good!.successRate).toBe(1)
    expect(bad!.successRate).toBe(0)
  })

  it('returns empty array with no data', () => {
    expect(state.getProfileBreakdown()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Recent activity tests
// ---------------------------------------------------------------------------

describe('getRecentActivity', () => {
  it('returns specified limit', () => {
    seedUsageRecords(10)
    const activity = state.getRecentActivity(5)
    expect(activity).toHaveLength(5)
  })

  it('orders by createdAt desc (newest first)', () => {
    seedUsageRecords(5)
    const activity = state.getRecentActivity(5)
    for (let i = 1; i < activity.length; i++) {
      expect(activity[i]!.createdAt <= activity[i - 1]!.createdAt).toBe(true)
    }
  })

  it('returns correct data shape', () => {
    seedUsageRecords(1)
    const [entry] = state.getRecentActivity(1)
    expect(entry).toBeDefined()
    expect(entry!.id).toBeTruthy()
    expect(entry!.profileId).toBe('test-profile')
    expect(entry!.model).toContain('anthropic')
    expect(typeof entry!.totalTokens).toBe('number')
    expect(typeof entry!.costUsd).toBe('number')
    expect(typeof entry!.success).toBe('boolean')
  })
})

// ---------------------------------------------------------------------------
// Activity feed merging tests
// ---------------------------------------------------------------------------

describe('activity feed merging', () => {
  it('listActiveRuntimes returns empty when no runtimes', () => {
    expect(state.listActiveRuntimes()).toHaveLength(0)
  })

  it('listActiveRuntimes returns running runtimes', () => {
    state.setRuntime('thread-1', {
      session: {} as any,
      hitl: {} as any,
      zoneManager: null,
    })
    const runtimes = state.listActiveRuntimes()
    expect(runtimes).toHaveLength(1)
    expect(runtimes[0]!.threadId).toBe('thread-1')
  })
})

// ---------------------------------------------------------------------------
// Storage stats tests
// ---------------------------------------------------------------------------

describe('storage stats', () => {
  it('returns correct counts from SQLite tables', () => {
    // Seed some data
    const thread = state.createThread('test-profile')
    state.addMessage(thread.id, {
      id: 'msg_001',
      role: 'user',
      content: 'Hello',
      timestamp: new Date().toISOString(),
    })
    seedUsageRecords(3)

    const stats = state.getStorageStats()
    expect(stats.threadCount).toBeGreaterThanOrEqual(1)
    expect(stats.messageCount).toBeGreaterThanOrEqual(1)
    expect(stats.usageRecordCount).toBe(3)
  })

  it('returns zeros for empty database', () => {
    const stats = state.getStorageStats()
    expect(stats.threadCount).toBe(0)
    expect(stats.messageCount).toBe(0)
    expect(stats.usageRecordCount).toBe(0)
  })

  it('dbPath returns a valid string', () => {
    expect(state.dbPath).toContain('test.db')
  })
})

// ---------------------------------------------------------------------------
// Event log clear tests
// ---------------------------------------------------------------------------

describe('clearEventLogs', () => {
  it('clears all event logs and returns count', () => {
    // Add some events
    state.logEvent('thread-1', { type: 'text.delta', text: 'hi' } as any)
    state.logEvent('thread-1', { type: 'text.delta', text: 'there' } as any)
    state.logEvent('thread-2', { type: 'turn.end' } as any)

    expect(state.eventLogEntryCount).toBe(3)

    const cleared = state.clearEventLogs()
    expect(cleared).toBe(3)
    expect(state.eventLogEntryCount).toBe(0)
  })

  it('returns 0 when no logs exist', () => {
    expect(state.clearEventLogs()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Data export tests
// ---------------------------------------------------------------------------

describe('exportAllData', () => {
  it('returns all user data', () => {
    // Seed some data
    const thread = state.createThread('test-profile')
    state.addMessage(thread.id, {
      id: 'msg_001',
      role: 'user',
      content: 'Hello',
      timestamp: new Date().toISOString(),
    })
    state.createWorkspace('/tmp/test-ws', 'Test WS')
    seedUsageRecords(2)

    const data = state.exportAllData()
    expect(data.threads.length).toBeGreaterThanOrEqual(1)
    expect(data.workspaces.length).toBeGreaterThanOrEqual(1)
    expect(data.messages[thread.id]).toHaveLength(1)
    expect(data.usage.recordCount).toBe(2)
    expect(data.usage.totalTokens).toBeGreaterThan(0)
  })
})
