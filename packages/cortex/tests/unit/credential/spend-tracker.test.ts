/**
 * Unit tests — spend tracker.
 *
 * Pinned:
 *   - periodStart returns midnight UTC for 'day' and first-of-month UTC
 *     for 'month', regardless of process timezone.
 *   - currentPeriodSpend prefers actual over estimate, sums correctly,
 *     respects the period window.
 *   - checkSpendCap returns ok/denied with the right shape.
 *   - Edge cases: zero estimate, negative estimate (throws), exact-cap
 *     boundary.
 */

import Database from 'better-sqlite3'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { CredentialAuditLog } from '../../../src/credential/audit.js'
import { DbCredentialBackend } from '../../../src/credential/store/db-backend.js'
import {
  checkSpendCap,
  currentPeriodSpend,
  periodStart,
} from '../../../src/credential/spend-tracker.js'
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
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-spend-'))
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()
  db = new Database(':memory:')
  for (const m of MIGRATIONS) db.exec(m.sql)
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

// ---------------------------------------------------------------------------
// periodStart
// ---------------------------------------------------------------------------

describe('periodStart', () => {
  it('returns midnight UTC for the day window', () => {
    const now = new Date('2026-04-25T18:30:45.123Z')
    expect(periodStart('day', now)).toBe('2026-04-25T00:00:00.000Z')
  })

  it('returns first-of-month UTC for the month window', () => {
    const now = new Date('2026-04-25T18:30:45.123Z')
    expect(periodStart('month', now)).toBe('2026-04-01T00:00:00.000Z')
  })

  it('returns the start of the day even at midnight UTC exactly', () => {
    const now = new Date('2026-04-25T00:00:00.000Z')
    expect(periodStart('day', now)).toBe('2026-04-25T00:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// currentPeriodSpend
// ---------------------------------------------------------------------------

describe('currentPeriodSpend', () => {
  it('returns 0 for a credential with no resolve events', () => {
    const { totalUsd } = currentPeriodSpend(db, credentialId, 'day')
    expect(totalUsd).toBe(0)
  })

  it('prefers actual over estimate when both are present', () => {
    audit.recordEvent({
      credentialId, eventType: 'resolve', outcome: 'ok',
      estimatedCostUsd: 0.05, actualCostUsd: 0.07,
    })
    const { totalUsd } = currentPeriodSpend(db, credentialId, 'day')
    expect(totalUsd).toBeCloseTo(0.07, 5)
  })

  it('falls back to estimate when actual is missing', () => {
    audit.recordEvent({
      credentialId, eventType: 'resolve', outcome: 'ok',
      estimatedCostUsd: 0.05,
    })
    const { totalUsd } = currentPeriodSpend(db, credentialId, 'day')
    expect(totalUsd).toBeCloseTo(0.05, 5)
  })

  it('only counts resolve events (ignores reveal/validate)', () => {
    audit.recordEvent({
      credentialId, eventType: 'reveal', outcome: 'ok',
      estimatedCostUsd: 99,
    })
    audit.recordEvent({
      credentialId, eventType: 'validate', outcome: 'ok',
      estimatedCostUsd: 99,
    })
    audit.recordEvent({
      credentialId, eventType: 'resolve', outcome: 'ok',
      estimatedCostUsd: 0.05,
    })
    const { totalUsd } = currentPeriodSpend(db, credentialId, 'day')
    expect(totalUsd).toBeCloseTo(0.05, 5)
  })

  it('windowStart is midnight UTC for the day window', () => {
    const { windowStart } = currentPeriodSpend(
      db, credentialId, 'day', new Date('2026-04-25T18:30:45.123Z'),
    )
    expect(windowStart).toBe('2026-04-25T00:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// checkSpendCap
// ---------------------------------------------------------------------------

describe('checkSpendCap', () => {
  it('returns ok with remainingUsd when under the cap', () => {
    audit.recordEvent({
      credentialId, eventType: 'resolve', outcome: 'ok',
      actualCostUsd: 1.5,
    })
    const result = checkSpendCap(db, credentialId, { amountUsd: 5, period: 'day' }, 1)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.remainingUsd).toBeCloseTo(2.5, 5)
      expect(result.currentSpendUsd).toBeCloseTo(1.5, 5)
      expect(result.capUsd).toBe(5)
    }
  })

  it('returns denied with SPEND_CAP_EXCEEDED when the estimate would push past the cap', () => {
    audit.recordEvent({
      credentialId, eventType: 'resolve', outcome: 'ok',
      actualCostUsd: 4.5,
    })
    const result = checkSpendCap(db, credentialId, { amountUsd: 5, period: 'day' }, 1)
    expect(result.status).toBe('denied')
    if (result.status === 'denied') {
      expect(result.reason).toBe('SPEND_CAP_EXCEEDED')
      expect(result.currentSpendUsd).toBeCloseTo(4.5, 5)
      expect(result.estimatedCostUsd).toBe(1)
    }
  })

  it('treats the boundary as ok (currentSpend + estimate === cap)', () => {
    audit.recordEvent({
      credentialId, eventType: 'resolve', outcome: 'ok',
      actualCostUsd: 4,
    })
    const result = checkSpendCap(db, credentialId, { amountUsd: 5, period: 'day' }, 1)
    expect(result.status).toBe('ok')
  })

  it('denies the very next call when the cap is exactly hit', () => {
    audit.recordEvent({
      credentialId, eventType: 'resolve', outcome: 'ok',
      actualCostUsd: 5,
    })
    const result = checkSpendCap(db, credentialId, { amountUsd: 5, period: 'day' }, 0.01)
    expect(result.status).toBe('denied')
  })

  it('throws on a negative estimate', () => {
    expect(() =>
      checkSpendCap(db, credentialId, { amountUsd: 5, period: 'day' }, -1),
    ).toThrow()
  })

  it('throws on a NaN estimate', () => {
    expect(() =>
      checkSpendCap(db, credentialId, { amountUsd: 5, period: 'day' }, NaN),
    ).toThrow()
  })

  it('day window does NOT count yesterday\'s spend', () => {
    // Insert a row dated yesterday by writing the audit row manually
    // so we can override created_at — the public API always stamps now.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    db.prepare(`
      INSERT INTO credential_audit_log
        (id, credential_id, event_type, outcome, actual_cost_usd, created_at)
      VALUES (?, ?, 'resolve', 'ok', ?, ?)
    `).run('caud_yesterday001', credentialId, 4.99, yesterday)

    const result = checkSpendCap(db, credentialId, { amountUsd: 5, period: 'day' }, 1)
    // Yesterday's spend doesn't count toward today's window.
    expect(result.status).toBe('ok')
  })

  it('month window includes earlier-this-month spend', () => {
    const earlierThisMonth = new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      1, 0, 5, 0,
    )).toISOString()
    db.prepare(`
      INSERT INTO credential_audit_log
        (id, credential_id, event_type, outcome, actual_cost_usd, created_at)
      VALUES (?, ?, 'resolve', 'ok', ?, ?)
    `).run('caud_earlier000001', credentialId, 4.5, earlierThisMonth)

    const result = checkSpendCap(db, credentialId, { amountUsd: 5, period: 'month' }, 1)
    expect(result.status).toBe('denied')
  })
})
