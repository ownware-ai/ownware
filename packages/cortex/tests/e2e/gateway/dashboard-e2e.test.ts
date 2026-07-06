/**
 * E2E tests for dashboard, activity, storage, and data export endpoints.
 *
 * Starts a REAL OwnwareGateway, seeds data via the gateway state,
 * and makes REAL HTTP requests to verify responses.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { join } from 'node:path'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let gateway: OwnwareGateway
let token: string
let tempDir: string
let dbPath: string
const baseUrl = () => `http://127.0.0.1:${gateway.port}`

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cortex-dash-e2e-'))
  dbPath = join(tempDir, 'test.db')

  // Create profiles
  for (const name of ['alpha', 'beta', 'gamma']) {
    const profileDir = join(tempDir, 'profiles', name)
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'agent.json'), JSON.stringify({
      name,
      description: `${name} agent`,
      model: 'anthropic:claude-sonnet-4-20250514',
      tools: { preset: 'none' },
      context: { cwd: false, datetime: false },
    }))
  }

  gateway = new OwnwareGateway({
    port: 0,
    profilesDir: join(tempDir, 'profiles'),
    dbPath,
    dataDir: join(tempDir, 'data'),
  })
  await gateway.start()
  token = gateway.token

  // Seed test data directly via state
  const state = gateway.state

  // Create workspaces
  const ws1 = state.createWorkspace('/tmp/project-a', 'Project A')
  const ws2 = state.createWorkspace('/tmp/project-b', 'Project B')

  // Create threads in workspaces
  for (let i = 0; i < 3; i++) {
    state.createThread('alpha', `Alpha thread ${i}`, ws1.id)
  }
  for (let i = 0; i < 2; i++) {
    state.createThread('beta', `Beta thread ${i}`, ws2.id)
  }

  // Seed usage records across profiles
  const profiles = ['alpha', 'beta', 'gamma']
  for (const profileId of profiles) {
    const count = profileId === 'alpha' ? 10 : profileId === 'beta' ? 6 : 4
    for (let i = 0; i < count; i++) {
      state.addUsageRecord({
        profileId,
        model: 'anthropic:claude-sonnet-4-20250514',
        provider: 'anthropic',
        inputTokens: 100 + i * 10,
        outputTokens: 50 + i * 5,
        costUsd: 0.001 * (i + 1),
        durationMs: 200 + i * 50,
        success: i % 5 !== 0 ? true : false, // 80% success rate
      })
    }
  }
}, 15_000)

afterAll(async () => {
  await gateway?.stop()
  await rm(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function api(path: string, opts?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...opts?.headers },
  })
}

// ---------------------------------------------------------------------------
// Dashboard backward compat
// ---------------------------------------------------------------------------

describe('dashboard e2e', () => {
  it('GET /dashboard returns old DashboardStats shape', async () => {
    const res = await api('/api/v1/dashboard')
    expect(res.status).toBe(200)

    const body = await res.json() as Record<string, unknown>
    expect(typeof body.activeAgents).toBe('number')
    expect(typeof body.todayRuns).toBe('number')
    expect(typeof body.todayTokens).toBe('number')
    expect(typeof body.todayCost).toBe('number')
    expect(typeof body.weekCost).toBe('number')
    expect(typeof body.workspaceCount).toBe('number')
    expect(Array.isArray(body.byProfile)).toBe(true)
    expect(Array.isArray(body.byWorkspace)).toBe(true)
  })

  // ── KPIs ──────────────────────────────────────────────────────────

  it('GET /dashboard/kpis?range=7d returns 4 KPI cards with sparklines', async () => {
    const res = await api('/api/v1/dashboard/kpis?range=7d')
    expect(res.status).toBe(200)

    const body = await res.json() as { range: string; cards: Array<{ label: string; sparkline: number[] }> }
    expect(body.range).toBe('7d')
    expect(body.cards).toHaveLength(4)

    for (const card of body.cards) {
      expect(card.sparkline).toHaveLength(12)
      // No NaN or undefined in sparkline
      for (const v of card.sparkline) {
        expect(typeof v).toBe('number')
        expect(Number.isFinite(v)).toBe(true)
      }
    }
  })

  it('GET /dashboard/kpis defaults to 7d when range is invalid', async () => {
    const res = await api('/api/v1/dashboard/kpis?range=invalid')
    expect(res.status).toBe(200)
    const body = await res.json() as { range: string }
    expect(body.range).toBe('7d')
  })

  it('GET /dashboard/kpis?range=24h works', async () => {
    const res = await api('/api/v1/dashboard/kpis?range=24h')
    expect(res.status).toBe(200)
    const body = await res.json() as { range: string }
    expect(body.range).toBe('24h')
  })

  // ── Usage chart ───────────────────────────────────────────────────

  it('GET /dashboard/usage-chart?range=7d returns buckets with peak and total', async () => {
    const res = await api('/api/v1/dashboard/usage-chart?range=7d')
    expect(res.status).toBe(200)

    const body = await res.json() as {
      buckets: Array<{ date: string; tokens: number; cost: number; runs: number }>
      peak: { tokens: number; cost: number; runs: number }
      total: { tokens: number; cost: number; runs: number }
    }

    expect(body.buckets).toHaveLength(7)
    // Buckets in chronological order
    for (let i = 1; i < body.buckets.length; i++) {
      expect(body.buckets[i]!.date >= body.buckets[i - 1]!.date).toBe(true)
    }
    // Peak and total are populated
    expect(body.total.runs).toBeGreaterThan(0)
    expect(body.peak.runs).toBeGreaterThan(0)
    expect(body.total.tokens).toBeGreaterThan(0)
  })

  // ── Profile breakdown ─────────────────────────────────────────────

  it('GET /dashboard/profile-breakdown returns per-profile stats', async () => {
    const res = await api('/api/v1/dashboard/profile-breakdown')
    expect(res.status).toBe(200)

    const body = await res.json() as Array<{
      profileId: string
      runs: number
      tokens: number
      cost: number
      avgDurationMs: number | null
      successRate: number
    }>

    expect(body.length).toBeGreaterThanOrEqual(3) // alpha, beta, gamma
    const alpha = body.find(r => r.profileId === 'alpha')
    expect(alpha).toBeDefined()
    expect(alpha!.runs).toBe(10)
    expect(alpha!.avgDurationMs).toBeGreaterThan(0)
    expect(alpha!.successRate).toBeGreaterThan(0)
    expect(alpha!.successRate).toBeLessThanOrEqual(1)
  })

  // ── Recent activity ───────────────────────────────────────────────

  it('GET /dashboard/recent-activity?limit=3 returns exactly 3 entries', async () => {
    const res = await api('/api/v1/dashboard/recent-activity?limit=3')
    expect(res.status).toBe(200)

    const body = await res.json() as Array<{ id: string; createdAt: string }>
    expect(body).toHaveLength(3)
    // Ordered by createdAt desc
    for (let i = 1; i < body.length; i++) {
      expect(body[i]!.createdAt <= body[i - 1]!.createdAt).toBe(true)
    }
  })

  it('GET /dashboard/recent-activity defaults to 20', async () => {
    const res = await api('/api/v1/dashboard/recent-activity')
    expect(res.status).toBe(200)
    const body = await res.json() as Array<unknown>
    expect(body.length).toBe(20) // We seeded 20 records
  })
})

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

describe('activity feed e2e', () => {
  it('GET /activity returns data with total/running/idle', async () => {
    const res = await api('/api/v1/activity')
    expect(res.status).toBe(200)

    const body = await res.json() as {
      data: Array<{ id: string; status: string }>
      total: number
      running: number
      idle: number
    }
    expect(Array.isArray(body.data)).toBe(true)
    expect(typeof body.total).toBe('number')
    expect(typeof body.running).toBe('number')
    expect(typeof body.idle).toBe('number')
    // We have threads but no running agents
    expect(body.running).toBe(0)
    expect(body.data.length).toBeGreaterThan(0)
  })

  it('GET /activity?status=running returns only running agents', async () => {
    const res = await api('/api/v1/activity?status=running')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ status: string }> }
    // No running agents in test setup
    for (const entry of body.data) {
      expect(entry.status).toBe('running')
    }
  })

  it('GET /activity?limit=2 respects limit', async () => {
    const res = await api('/api/v1/activity?limit=2')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: unknown[] }
    expect(body.data.length).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe('storage e2e', () => {
  it('GET /storage/stats returns counts and DB size', async () => {
    const res = await api('/api/v1/storage/stats')
    expect(res.status).toBe(200)

    const body = await res.json() as {
      dbSizeBytes: number
      threadCount: number
      messageCount: number
      usageRecordCount: number
      eventLogEntries: number
    }
    expect(body.dbSizeBytes).toBeGreaterThan(0)
    expect(body.threadCount).toBeGreaterThanOrEqual(5) // 3 alpha + 2 beta
    expect(body.usageRecordCount).toBe(20) // 10 + 6 + 4
    expect(typeof body.eventLogEntries).toBe('number')
  })

  it('POST /storage/clear-cache clears event logs', async () => {
    // Add an event log entry first
    gateway.state.logEvent('thread-1', { type: 'text.delta', text: 'x' } as any)

    const res = await api('/api/v1/storage/clear-cache', { method: 'POST' })
    expect(res.status).toBe(200)

    const body = await res.json() as { cleared: { eventLogs: number } }
    expect(body.cleared.eventLogs).toBeGreaterThanOrEqual(1)

    // Verify cleared
    expect(gateway.state.eventLogEntryCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Data export
// ---------------------------------------------------------------------------

describe('data export e2e', () => {
  it('POST /data/export returns all user data', async () => {
    const res = await api('/api/v1/data/export', { method: 'POST' })
    expect(res.status).toBe(200)

    const body = await res.json() as {
      threads: unknown[]
      messages: Record<string, unknown[]>
      workspaces: unknown[]
      settings: unknown[]
      usage: { totalTokens: number; totalCost: number; recordCount: number }
      exportedAt: string
    }

    expect(body.threads.length).toBeGreaterThanOrEqual(5)
    expect(body.workspaces.length).toBeGreaterThanOrEqual(2)
    expect(body.usage.recordCount).toBe(20)
    expect(body.usage.totalTokens).toBeGreaterThan(0)
    expect(body.exportedAt).toBeTruthy()
    // Messages should have entries for each thread
    expect(Object.keys(body.messages).length).toBeGreaterThan(0)
  })
})
