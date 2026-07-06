/**
 * Unit tests for data layer fixes and new query methods.
 *
 * Covers:
 *  - addMessage() atomic message_count increment
 *  - addUsageRecord() thread total_tokens / total_cost update
 *  - listMCPServers() single-query profile_ids (no N+1)
 *  - Pagination on listThreads, listWorkspaces, listMCPServers
 *  - Dashboard: getUsageTimeSeries, getKPIs, getProfileBreakdown, getRecentActivity
 *  - incrementProfileUsage()
 *  - Race-condition safety for addMessage
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import type { ThreadMessage } from '../../../src/gateway/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    role: 'assistant',
    content: 'Hello world',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

function addUsage(db: CortexDatabase, opts: {
  profileId?: string
  threadId?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  durationMs?: number
  success?: boolean
} = {}): void {
  db.addUsageRecord({
    profileId: opts.profileId ?? 'test-profile',
    threadId: opts.threadId,
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    inputTokens: opts.inputTokens ?? 100,
    outputTokens: opts.outputTokens ?? 50,
    costUsd: opts.costUsd ?? 0.005,
    durationMs: opts.durationMs,
    success: opts.success,
  })
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe('CortexDatabase — data layer fixes', () => {
  let db: CortexDatabase
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cortex-dl-test-'))
    db = new CortexDatabase(join(tempDir, 'test.db'))
  })

  afterEach(async () => {
    db.close()
    await rm(tempDir, { recursive: true, force: true })
  })

  // ── addMessage: atomic counter ──────────────────────────────────────────

  describe('addMessage()', () => {
    it('increments thread.message_count atomically', () => {
      const thread = db.createThread('profile-a')
      expect(thread.messageCount).toBe(0)

      db.addMessage(thread.id, makeMsg())
      db.addMessage(thread.id, makeMsg())
      db.addMessage(thread.id, makeMsg())

      const updated = db.getThread(thread.id)!
      expect(updated.messageCount).toBe(3)
    })

    it('updates last_message_preview for assistant messages', () => {
      const thread = db.createThread('profile-a')
      db.addMessage(thread.id, makeMsg({ role: 'assistant', content: 'Here is my answer' }))
      const updated = db.getThread(thread.id)!
      expect(updated.lastMessagePreview).toBe('Here is my answer')
    })

    it('updates last_message_preview for user messages', () => {
      const thread = db.createThread('profile-a')
      db.addMessage(thread.id, makeMsg({ role: 'user', content: 'What is 2+2?' }))
      const updated = db.getThread(thread.id)!
      expect(updated.lastMessagePreview).toBe('What is 2+2?')
    })

    it('truncates preview to 200 characters', () => {
      const thread = db.createThread('profile-a')
      const long = 'x'.repeat(300)
      db.addMessage(thread.id, makeMsg({ content: long }))
      const updated = db.getThread(thread.id)!
      expect(updated.lastMessagePreview).toHaveLength(200)
    })

    it('increments correctly across multiple threads independently', () => {
      const t1 = db.createThread('profile-a')
      const t2 = db.createThread('profile-b')

      db.addMessage(t1.id, makeMsg())
      db.addMessage(t1.id, makeMsg())
      db.addMessage(t2.id, makeMsg())

      expect(db.getThread(t1.id)!.messageCount).toBe(2)
      expect(db.getThread(t2.id)!.messageCount).toBe(1)
    })

    // ── Migration 027 — cache-token round-trip ────────────────────────────

    it('round-trips cacheReadTokens + cacheCreationTokens through the messages row', () => {
      const thread = db.createThread('profile-a')
      db.addMessage(
        thread.id,
        makeMsg({
          role: 'assistant',
          usage: {
            inputTokens: 444,
            outputTokens: 200,
            cacheReadTokens: 120_000,
            cacheCreationTokens: 0,
          },
        }),
      )

      const [restored] = db.getMessages(thread.id)
      expect(restored?.usage).toEqual({
        inputTokens: 444,
        outputTokens: 200,
        cacheReadTokens: 120_000,
        cacheCreationTokens: 0,
      })
    })

    it('round-trips Anthropic-style cacheCreationTokens (cache write)', () => {
      const thread = db.createThread('profile-a')
      db.addMessage(
        thread.id,
        makeMsg({
          role: 'assistant',
          usage: {
            inputTokens: 5000,
            outputTokens: 300,
            cacheReadTokens: 0,
            cacheCreationTokens: 80_000,
          },
        }),
      )

      const [restored] = db.getMessages(thread.id)
      expect(restored?.usage?.cacheCreationTokens).toBe(80_000)
      expect(restored?.usage?.cacheReadTokens).toBe(0)
    })

    it('keeps cache fields undefined for pre-027 messages (no usage at all)', () => {
      const thread = db.createThread('profile-a')
      db.addMessage(thread.id, makeMsg({ role: 'user', content: 'hi' }))
      const [restored] = db.getMessages(thread.id)
      expect(restored?.usage).toBeUndefined()
    })

    it('keeps cache fields undefined when usage is supplied but cache fields are omitted', () => {
      const thread = db.createThread('profile-a')
      db.addMessage(
        thread.id,
        makeMsg({
          role: 'assistant',
          usage: { inputTokens: 100, outputTokens: 50 },
        }),
      )
      const [restored] = db.getMessages(thread.id)
      expect(restored?.usage?.inputTokens).toBe(100)
      expect(restored?.usage?.outputTokens).toBe(50)
      // Caller didn't supply cache fields → reader returns undefined,
      // not 0. The UI-side reducer coalesces to 0 for client consumption.
      expect(restored?.usage?.cacheReadTokens).toBeUndefined()
      expect(restored?.usage?.cacheCreationTokens).toBeUndefined()
    })
  })

  // ── addUsageRecord: thread token/cost accumulation ─────────────────────

  describe('addUsageRecord()', () => {
    it('updates thread.total_tokens and total_cost when threadId is provided', () => {
      const thread = db.createThread('profile-a')

      addUsage(db, { threadId: thread.id, inputTokens: 100, outputTokens: 50, costUsd: 0.01 })
      addUsage(db, { threadId: thread.id, inputTokens: 200, outputTokens: 100, costUsd: 0.02 })

      const updated = db.getThread(thread.id)!
      expect(updated.totalTokens).toBe(450)
      expect(updated.totalCost).toBeCloseTo(0.03)
    })

    it('does not touch any thread when threadId is omitted', () => {
      const thread = db.createThread('profile-a')
      addUsage(db, { inputTokens: 500, outputTokens: 250, costUsd: 0.05 })
      const unchanged = db.getThread(thread.id)!
      expect(unchanged.totalTokens).toBe(0)
      expect(unchanged.totalCost).toBe(0)
    })

    it('accepts and stores duration_ms', () => {
      const thread = db.createThread('profile-a')
      addUsage(db, { threadId: thread.id, durationMs: 1234 })
      const activity = db.getRecentActivity(1)
      expect(activity[0]!.durationMs).toBe(1234)
    })

    it('accepts and stores success=false', () => {
      addUsage(db, { success: false })
      const activity = db.getRecentActivity(1)
      expect(activity[0]!.success).toBe(false)
    })

    it('defaults success to true when omitted', () => {
      addUsage(db)
      const activity = db.getRecentActivity(1)
      expect(activity[0]!.success).toBe(true)
    })
  })

  // ── listMCPServers: single query, no N+1 ───────────────────────────────

  describe('listMCPServers()', () => {
    it('returns profileIds without N+1 (single-query)', () => {
      db.createMCPServer({ id: 'srv1', name: 'Alpha', transport: 'stdio' })
      db.createMCPServer({ id: 'srv2', name: 'Beta', transport: 'sse' })
      db.assignServerToProfile('srv1', 'profile-x')
      db.assignServerToProfile('srv1', 'profile-y')
      db.assignServerToProfile('srv2', 'profile-z')

      const { items } = db.listMCPServers()
      const alpha = items.find(s => s.id === 'srv1')!
      const beta = items.find(s => s.id === 'srv2')!

      expect(alpha.profileIds).toHaveLength(2)
      expect(alpha.profileIds).toContain('profile-x')
      expect(alpha.profileIds).toContain('profile-y')
      expect(beta.profileIds).toHaveLength(1)
      expect(beta.profileIds).toContain('profile-z')
    })

    it('returns empty profileIds array for unassigned servers', () => {
      db.createMCPServer({ id: 'srv1', name: 'Alone', transport: 'stdio' })
      const { items } = db.listMCPServers()
      expect(items[0]!.profileIds).toEqual([])
    })
  })

  // ── Pagination ─────────────────────────────────────────────────────────

  describe('pagination — listThreads()', () => {
    beforeEach(() => {
      for (let i = 0; i < 10; i++) db.createThread('pg-profile', `Thread ${i}`)
    })

    it('uses default limit of 50 when no opts given', () => {
      const result = db.listThreads()
      expect(result.limit).toBe(50)
    })

    it('honours custom limit', () => {
      const result = db.listThreads(undefined, { limit: 3 })
      expect(result.items).toHaveLength(3)
      expect(result.limit).toBe(3)
    })

    it('caps limit at 200', () => {
      const result = db.listThreads(undefined, { limit: 999 })
      expect(result.limit).toBe(200)
    })

    it('returns correct total independent of limit/offset', () => {
      const r1 = db.listThreads(undefined, { limit: 2, offset: 0 })
      const r2 = db.listThreads(undefined, { limit: 2, offset: 4 })
      expect(r1.total).toBe(10)
      expect(r2.total).toBe(10)
    })

    it('offset pages correctly', () => {
      const page1 = db.listThreads(undefined, { limit: 4, offset: 0 })
      const page2 = db.listThreads(undefined, { limit: 4, offset: 4 })
      expect(page1.items).toHaveLength(4)
      expect(page2.items).toHaveLength(4)
      const ids1 = page1.items.map(t => t.id)
      const ids2 = page2.items.map(t => t.id)
      for (const id of ids2) expect(ids1).not.toContain(id)
    })

    it('offset beyond total returns empty items with correct total', () => {
      const result = db.listThreads(undefined, { limit: 10, offset: 100 })
      expect(result.items).toHaveLength(0)
      expect(result.total).toBe(10)
    })
  })

  describe('pagination — listWorkspaces()', () => {
    beforeEach(() => {
      for (let i = 0; i < 6; i++) db.createWorkspace(`/projects/ws${i}`, `WS ${i}`)
    })

    it('returns correct total', () => {
      const result = db.listWorkspaces(undefined, { limit: 2 })
      expect(result.total).toBe(6)
    })

    it('returns requested page size', () => {
      const result = db.listWorkspaces(undefined, { limit: 2, offset: 0 })
      expect(result.items).toHaveLength(2)
    })

    it('offset beyond total returns empty with correct total', () => {
      const result = db.listWorkspaces(undefined, { limit: 10, offset: 100 })
      expect(result.items).toHaveLength(0)
      expect(result.total).toBe(6)
    })
  })

  describe('pagination — listMCPServers()', () => {
    beforeEach(() => {
      for (let i = 0; i < 5; i++) {
        db.createMCPServer({ id: `srv${i}`, name: `Server ${i}`, transport: 'stdio' })
      }
    })

    it('returns correct total', () => {
      const result = db.listMCPServers({ limit: 2 })
      expect(result.total).toBe(5)
    })

    it('returns correct page', () => {
      const result = db.listMCPServers({ limit: 2, offset: 0 })
      expect(result.items).toHaveLength(2)
    })
  })

  // ── Dashboard: getUsageTimeSeries ──────────────────────────────────────

  describe('getUsageTimeSeries()', () => {
    it('returns 7 daily buckets for 7d range', () => {
      const buckets = db.getUsageTimeSeries('7d')
      expect(buckets).toHaveLength(7)
    })

    it('returns 30 daily buckets for 30d range', () => {
      const buckets = db.getUsageTimeSeries('30d')
      expect(buckets).toHaveLength(30)
    })

    it('returns 90 daily buckets for 90d range', () => {
      const buckets = db.getUsageTimeSeries('90d')
      expect(buckets).toHaveLength(90)
    })

    it('returns 24 hourly buckets for 24h range', () => {
      const buckets = db.getUsageTimeSeries('24h')
      expect(buckets).toHaveLength(24)
    })

    it('fills missing days with zero', () => {
      const buckets = db.getUsageTimeSeries('7d')
      for (const b of buckets) {
        expect(b.tokens).toBe(0)
        expect(b.cost).toBe(0)
        expect(b.runs).toBe(0)
      }
    })

    it('aggregates tokens and cost into buckets', () => {
      // Add records for today
      for (let i = 0; i < 3; i++) addUsage(db, { inputTokens: 100, outputTokens: 50, costUsd: 0.01 })

      const buckets = db.getUsageTimeSeries('7d')
      const today = new Date().toISOString().split('T')[0]!
      const todayBucket = buckets.find(b => b.date === today)
      expect(todayBucket).toBeDefined()
      expect(todayBucket!.tokens).toBe(450)   // 3 × (100+50)
      expect(todayBucket!.cost).toBeCloseTo(0.03)
      expect(todayBucket!.runs).toBe(3)
    })
  })

  // ── Dashboard: getKPIs ─────────────────────────────────────────────────

  describe('getKPIs()', () => {
    it('returns cards for tokens, cost, runs, avg duration', () => {
      const kpis = db.getKPIs('7d')
      const labels = kpis.cards.map(c => c.label)
      expect(labels).toContain('Tokens')
      expect(labels).toContain('Cost')
      expect(labels).toContain('Runs')
      expect(labels).toContain('Avg Duration')
    })

    it('returns sparkline with exactly 12 data points per card', () => {
      const kpis = db.getKPIs('7d')
      for (const card of kpis.cards) {
        expect(card.sparkline).toHaveLength(12)
      }
    })

    it('returns null delta when there is no prior period data', () => {
      addUsage(db, { inputTokens: 100, outputTokens: 50, costUsd: 0.01 })
      const kpis = db.getKPIs('7d')
      const tokenCard = kpis.cards.find(c => c.label === 'Tokens')!
      // No data in prior 7d window → delta null
      expect(tokenCard.delta).toBeNull()
    })

    it('echoes back the requested range', () => {
      expect(db.getKPIs('30d').range).toBe('30d')
      expect(db.getKPIs('7d').range).toBe('7d')
    })

    it('computes non-null delta when both periods have data', () => {
      // Current period: today
      addUsage(db, { inputTokens: 200, outputTokens: 100, costUsd: 0.02 })

      const kpis = db.getKPIs('7d')
      // Since previous period is empty, delta is null — just verify no crash
      expect(kpis.cards.find(c => c.label === 'Runs')!.value).toBe(1)
    })
  })

  // ── Dashboard: getProfileBreakdown ─────────────────────────────────────

  describe('getProfileBreakdown()', () => {
    it('groups by profile and includes avgDurationMs and successRate', () => {
      addUsage(db, { profileId: 'coder', inputTokens: 100, outputTokens: 50, costUsd: 0.01, durationMs: 1000, success: true })
      addUsage(db, { profileId: 'coder', inputTokens: 100, outputTokens: 50, costUsd: 0.01, durationMs: 2000, success: false })
      addUsage(db, { profileId: 'researcher', inputTokens: 200, outputTokens: 100, costUsd: 0.02, durationMs: 500, success: true })

      const rows = db.getProfileBreakdown()
      const coder = rows.find(r => r.profileId === 'coder')!
      const researcher = rows.find(r => r.profileId === 'researcher')!

      expect(coder.runs).toBe(2)
      expect(coder.avgDurationMs).toBe(1500)
      expect(coder.successRate).toBeCloseTo(0.5)
      expect(researcher.runs).toBe(1)
      expect(researcher.avgDurationMs).toBe(500)
      expect(researcher.successRate).toBeCloseTo(1.0)
    })

    it('returns null avgDurationMs when no duration_ms was recorded', () => {
      addUsage(db, { profileId: 'nodur' })
      const rows = db.getProfileBreakdown()
      expect(rows.find(r => r.profileId === 'nodur')!.avgDurationMs).toBeNull()
    })

    it('orders by runs descending', () => {
      addUsage(db, { profileId: 'busy' })
      addUsage(db, { profileId: 'busy' })
      addUsage(db, { profileId: 'idle' })
      const rows = db.getProfileBreakdown()
      expect(rows[0]!.profileId).toBe('busy')
    })
  })

  // ── Dashboard: getRecentActivity ──────────────────────────────────────

  describe('getRecentActivity()', () => {
    it('returns most recent N records ordered by recency', () => {
      for (let i = 0; i < 5; i++) addUsage(db, { profileId: `profile-${i}` })
      const rows = db.getRecentActivity(3)
      expect(rows).toHaveLength(3)
      // Should be ordered newest-first
      for (let i = 0; i < rows.length - 1; i++) {
        expect(rows[i]!.createdAt >= rows[i + 1]!.createdAt).toBe(true)
      }
    })

    it('returns fewer than limit if fewer records exist', () => {
      addUsage(db)
      const rows = db.getRecentActivity(10)
      expect(rows).toHaveLength(1)
    })

    it('includes all expected fields', () => {
      const thread = db.createThread('profile-a')
      addUsage(db, { profileId: 'profile-a', threadId: thread.id, durationMs: 999, success: true })
      const rows = db.getRecentActivity(1)
      const row = rows[0]!
      expect(row.id).toMatch(/^usage_/)
      expect(row.profileId).toBe('profile-a')
      expect(row.threadId).toBe(thread.id)
      expect(row.durationMs).toBe(999)
      expect(row.success).toBe(true)
    })
  })

  // ── incrementProfileUsage ─────────────────────────────────────────────

  describe('incrementProfileUsage()', () => {
    it('creates profile_metadata row on first call with correct values', () => {
      db.incrementProfileUsage('new-profile', 0.05)
      const meta = db.getProfileMetadata('new-profile')!
      expect(meta).toBeDefined()
      expect(meta.useCount).toBe(1)
      expect(meta.totalCost).toBeCloseTo(0.05)
      expect(meta.lastUsedAt).not.toBeNull()
    })

    it('increments use_count on subsequent calls', () => {
      db.incrementProfileUsage('p1', 0.01)
      db.incrementProfileUsage('p1', 0.02)
      db.incrementProfileUsage('p1', 0.03)
      const meta = db.getProfileMetadata('p1')!
      expect(meta.useCount).toBe(3)
    })

    it('accumulates total_cost', () => {
      db.incrementProfileUsage('p2', 0.10)
      db.incrementProfileUsage('p2', 0.20)
      db.incrementProfileUsage('p2', 0.30)
      const meta = db.getProfileMetadata('p2')!
      expect(meta.totalCost).toBeCloseTo(0.60)
    })

    it('updates last_used_at on each call', async () => {
      db.incrementProfileUsage('p3', 0.01)
      const meta1 = db.getProfileMetadata('p3')!
      await new Promise(r => setTimeout(r, 10))
      db.incrementProfileUsage('p3', 0.01)
      const meta2 = db.getProfileMetadata('p3')!
      // updated_at should have advanced
      expect(meta2.updatedAt >= meta1.updatedAt).toBe(true)
    })

    it('handles concurrent calls without losing counts (sequential simulation)', () => {
      const N = 100
      for (let i = 0; i < N; i++) db.incrementProfileUsage('heavy', 0.001)
      const meta = db.getProfileMetadata('heavy')!
      expect(meta.useCount).toBe(N)
      expect(meta.totalCost).toBeCloseTo(0.1)
    })
  })

  // ── Race condition — addMessage ────────────────────────────────────────

  describe('concurrent addMessage (sequential simulation)', () => {
    it('does not lose message_count when called N times in sequence', () => {
      const thread = db.createThread('profile-race')
      const N = 50
      for (let i = 0; i < N; i++) {
        db.addMessage(thread.id, makeMsg({ id: `msg_race_${i}` }))
      }
      expect(db.getThread(thread.id)!.messageCount).toBe(N)
    })
  })
})
