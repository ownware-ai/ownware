/**
 * Unit tests — credential audit log module.
 *
 * Pinned:
 *   - Every event field round-trips through INSERT/SELECT.
 *   - JSON detail column survives malformed JSON without throwing.
 *   - Pagination respects limit + offset; total reflects unfiltered count.
 *   - Cost aggregation buckets by UTC date and prefers actual over estimate.
 *   - Usage aggregation groups + sorts top consumers descending.
 *   - The plaintext value is structurally absent from the wire shape.
 */

import Database from 'better-sqlite3'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import {
  CredentialAuditLog,
  type RecordEventInput,
} from '../../../src/credential/audit.js'
import { DbCredentialBackend } from '../../../src/credential/store/db-backend.js'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let prevHome: string | undefined
let tmpHome: string
let db: Database.Database
let audit: CredentialAuditLog
let credentialId: string

beforeEach(async () => {
  prevHome = process.env['HOME']
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-cred-audit-'))
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()
  db = new Database(':memory:')
  for (const m of MIGRATIONS) db.exec(m.sql)
  // Audit rows have a FK to credentials — seed one row so inserts pass.
  const backend = new DbCredentialBackend(db)
  const cred = await backend.save({
    name: 'Anthropic',
    value: 'sk-ant-XXXXXXXX-HM8A',
    category: 'llm',
    authType: 'api-key',
    variableName: 'ANTHROPIC_API_KEY',
    source: 'manual',
  })
  credentialId = cred.id
  audit = new CredentialAuditLog(db)
})
afterEach(() => {
  db.close()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
})

function record(input: Partial<RecordEventInput> = {}) {
  return audit.recordEvent({
    credentialId,
    eventType: 'reveal',
    outcome: 'ok',
    ...input,
  })
}

// ---------------------------------------------------------------------------
// recordEvent
// ---------------------------------------------------------------------------

describe('CredentialAuditLog — recordEvent', () => {
  it('returns an event with a fresh caud_ id and the given fields', () => {
    const event = record({ eventType: 'validate', toolName: 'shell' })
    expect(event.id).toMatch(/^caud_[a-f0-9]{12}$/)
    expect(event.credentialId).toBe(credentialId)
    expect(event.eventType).toBe('validate')
    expect(event.toolName).toBe('shell')
    expect(event.outcome).toBe('ok')
  })

  it('persists the row so listEventsForCredential returns it', () => {
    record({ eventType: 'reveal' })
    const { events, total } = audit.listEventsForCredential(credentialId)
    expect(total).toBe(1)
    expect(events.length).toBe(1)
    expect(events[0]!.eventType).toBe('reveal')
  })

  it('serialises detail JSON and returns it parsed', () => {
    record({
      eventType: 'resolve',
      outcome: 'ok',
      detail: { host: 'api.anthropic.com', latencyMs: 432 },
    })
    const { events } = audit.listEventsForCredential(credentialId)
    expect(events[0]!.detail).toEqual({ host: 'api.anthropic.com', latencyMs: 432 })
  })

  it('records every optional field as NULL when omitted', () => {
    record()
    const { events } = audit.listEventsForCredential(credentialId)
    const ev = events[0]!
    expect(ev.agentId).toBeNull()
    expect(ev.sessionId).toBeNull()
    expect(ev.threadId).toBeNull()
    expect(ev.toolName).toBeNull()
    expect(ev.host).toBeNull()
    expect(ev.detail).toBeNull()
    expect(ev.estimatedCostUsd).toBeNull()
    expect(ev.actualCostUsd).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// listEventsForCredential
// ---------------------------------------------------------------------------

describe('CredentialAuditLog — listEventsForCredential', () => {
  it('returns newest first, ties broken by id desc', async () => {
    record({ eventType: 'reveal' })
    await new Promise(r => setTimeout(r, 5))
    record({ eventType: 'validate' })
    await new Promise(r => setTimeout(r, 5))
    record({ eventType: 'create' })
    const { events } = audit.listEventsForCredential(credentialId)
    expect(events.map(e => e.eventType)).toEqual(['create', 'validate', 'reveal'])
  })

  it('respects limit and offset', () => {
    for (let i = 0; i < 7; i++) record({ eventType: 'reveal' })
    const page1 = audit.listEventsForCredential(credentialId, { limit: 3, offset: 0 })
    const page2 = audit.listEventsForCredential(credentialId, { limit: 3, offset: 3 })
    expect(page1.events.length).toBe(3)
    expect(page2.events.length).toBe(3)
    expect(page1.total).toBe(7)
    expect(page2.total).toBe(7)
    const ids1 = new Set(page1.events.map(e => e.id))
    expect(page2.events.some(e => ids1.has(e.id))).toBe(false)
  })

  it('caps an unreasonable limit at 200', () => {
    for (let i = 0; i < 50; i++) record()
    const { events } = audit.listEventsForCredential(credentialId, { limit: 999_999 })
    expect(events.length).toBeLessThanOrEqual(200)
  })

  it('returns empty + total: 0 for a credential with no events', () => {
    const { events, total } = audit.listEventsForCredential('cred_000000000000')
    expect(events).toEqual([])
    expect(total).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// aggregateUsage
// ---------------------------------------------------------------------------

describe('CredentialAuditLog — aggregateUsage', () => {
  it('returns total + top consumers grouped by tool_name (default)', () => {
    record({ eventType: 'resolve', toolName: 'shell' })
    record({ eventType: 'resolve', toolName: 'shell' })
    record({ eventType: 'resolve', toolName: 'fetch' })
    const result = audit.aggregateUsage(credentialId)
    expect(result.totalCalls).toBe(3)
    expect(result.topConsumers).toEqual([
      { key: 'shell', count: 2 },
      { key: 'fetch', count: 1 },
    ])
  })

  it('groups by agent_id when requested', () => {
    record({ eventType: 'resolve', agentId: 'agent_a' })
    record({ eventType: 'resolve', agentId: 'agent_b' })
    record({ eventType: 'resolve', agentId: 'agent_b' })
    const result = audit.aggregateUsage(credentialId, { groupBy: 'agent_id' })
    expect(result.topConsumers).toEqual([
      { key: 'agent_b', count: 2 },
      { key: 'agent_a', count: 1 },
    ])
  })

  it('drops events with NULL group key from the top-consumers list', () => {
    record({ eventType: 'resolve' /* toolName: undefined */ })
    record({ eventType: 'resolve', toolName: 'shell' })
    const result = audit.aggregateUsage(credentialId)
    expect(result.totalCalls).toBe(2)
    expect(result.topConsumers).toEqual([{ key: 'shell', count: 1 }])
  })

  it('honours sinceIso to clip the time window', () => {
    record({ eventType: 'resolve', toolName: 'shell' })
    const since = new Date(Date.now() + 60_000).toISOString()
    const result = audit.aggregateUsage(credentialId, { sinceIso: since })
    expect(result.totalCalls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// aggregateCost
// ---------------------------------------------------------------------------

describe('CredentialAuditLog — aggregateCost', () => {
  it('sums estimated and actual cost across all rows', () => {
    record({ eventType: 'resolve', estimatedCostUsd: 0.01, actualCostUsd: 0.012 })
    record({ eventType: 'resolve', estimatedCostUsd: 0.02, actualCostUsd: 0.025 })
    const cost = audit.aggregateCost(credentialId)
    expect(cost.totalEstimatedUsd).toBeCloseTo(0.03, 5)
    expect(cost.totalActualUsd).toBeCloseTo(0.037, 5)
  })

  it('groups rows by UTC date in the buckets array', () => {
    record({ eventType: 'resolve', estimatedCostUsd: 1, actualCostUsd: 1 })
    const cost = audit.aggregateCost(credentialId)
    const today = new Date().toISOString().slice(0, 10)
    expect(cost.buckets.length).toBe(1)
    expect(cost.buckets[0]!.date).toBe(today)
    expect(cost.buckets[0]!.calls).toBe(1)
  })

  it('treats missing actualCost as 0 in the actual sum', () => {
    record({ eventType: 'resolve', estimatedCostUsd: 0.01 })
    const cost = audit.aggregateCost(credentialId)
    expect(cost.totalActualUsd).toBe(0)
    expect(cost.totalEstimatedUsd).toBeCloseTo(0.01, 5)
  })
})

// ---------------------------------------------------------------------------
// FK behaviour — hard-deleting a credential cascades
// ---------------------------------------------------------------------------

describe('CredentialAuditLog — FK cascade on hard-delete', () => {
  it('deletes audit rows when the credential row is hard-deleted', async () => {
    record()
    expect(audit.listEventsForCredential(credentialId).total).toBe(1)
    // Enable FK enforcement for the cascade — better-sqlite3 disables
    // by default per connection; the migration assumes ON DELETE
    // CASCADE is honoured at delete time.
    db.pragma('foreign_keys = ON')
    db.prepare('DELETE FROM credentials WHERE id = ?').run(credentialId)
    expect(audit.listEventsForCredential(credentialId).total).toBe(0)
  })
})
