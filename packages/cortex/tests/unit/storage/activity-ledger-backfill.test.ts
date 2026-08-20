import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import { runMigrationsSafely } from '../../../src/gateway/db/migration-safety.js'
import { readActivityLedgerCoverage } from '../../../src/gateway/activity-ledger.js'

/**
 * The backfill only matters on an UPGRADE, so every case here migrates to the
 * version before the ledger existed, seeds real receipts, then applies 092 and
 * inspects what the index claims about itself.
 */

const BEFORE_LEDGER = MIGRATIONS.filter((migration) => migration.version < 92)
const LEDGER_MIGRATION = MIGRATIONS.find((migration) => migration.version === 92)!

let dir: string
let dbPath: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cortex-ledger-backfill-'))
  dbPath = join(dir, 'ledger.db')
  db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  runMigrationsSafely(db, dbPath, BEFORE_LEDGER)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

interface LedgerRow {
  readonly ledger_seq: number
  readonly family: string
  readonly receipt_id: string
  readonly origin: string
  readonly occurred_at: number
  readonly profile_id: string
  readonly thread_id: string
  readonly tool_name: string | null
  readonly outcome: string | null
  readonly consequence: string | null
}

function applyLedgerMigration(): void {
  runMigrationsSafely(db, dbPath, [...BEFORE_LEDGER, LEDGER_MIGRATION])
}

function rows(): LedgerRow[] {
  return db.prepare('SELECT * FROM activity_ledger ORDER BY ledger_seq').all() as LedgerRow[]
}

function seedRun(profileId = 'backfill-profile'): { runId: string; threadId: string } {
  const threadId = `thread_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const runId = randomUUID()
  db.prepare(`
    INSERT INTO threads (id, profile_id, title, created_at, updated_at)
    VALUES (?, ?, 'backfill', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
  `).run(threadId, profileId)
  db.prepare(`
    INSERT INTO gateway_runs (
      id, thread_id, workspace_id, profile_id, model, timeout_ms, status,
      start_seq, accepted_at, updated_at, consequence
    ) VALUES (?, ?, NULL, ?, 'test:model', 60000, 'running', 0, 100, 100, 'none_observed')
  `).run(runId, threadId, profileId)
  return { runId, threadId }
}

function seedEffect(runId: string, at: number, toolName: string): string {
  const effectId = randomUUID()
  const receiptId = randomUUID()
  db.prepare(`
    INSERT INTO effect_identities (effect_id, run_id, tool_call_id, tool_name, first_observed_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(effectId, runId, `call-${receiptId.slice(0, 8)}`, toolName, at)
  db.prepare(`
    INSERT INTO effect_receipts (
      receipt_id, receipt_seq, effect_id, run_id, observation_key, kind, outcome,
      consequence, authority_kind, authority_ref, runtime_sequence, observed_at
    ) VALUES (?, ?, ?, ?, ?, 'outcome_observed', 'succeeded', 'effect_possible',
      'runtime', 'runtime:test', NULL, ?)
  `).run(
    receiptId,
    db.prepare('SELECT COALESCE(MAX(receipt_seq),0)+1 FROM effect_receipts WHERE run_id = ?')
      .pluck().get(runId) as number,
    effectId, runId, `obs-${receiptId.slice(0, 8)}`, at,
  )
  return receiptId
}

describe('activity ledger backfill', () => {
  it('indexes nothing on a fresh install and claims no reconstructed order', () => {
    applyLedgerMigration()
    expect(rows()).toHaveLength(0)
    expect(readActivityLedgerCoverage(db)).toEqual({
      reconstructedThrough: 0,
      reconstructedCount: 0,
      observedFrom: null,
    })
  })

  it('indexes pre-existing receipts in timestamp order and marks them reconstructed', () => {
    const { runId, threadId } = seedRun()
    const later = seedEffect(runId, 300, 'send_email')
    const earlier = seedEffect(runId, 100, 'read_file')
    const middle = seedEffect(runId, 200, 'write_file')

    applyLedgerMigration()

    const indexed = rows()
    expect(indexed.map((row) => row.receipt_id)).toEqual([earlier, middle, later])
    expect(indexed.map((row) => row.ledger_seq)).toEqual([1, 2, 3])
    for (const row of indexed) {
      expect(row.origin).toBe('backfill')
      expect(row.profile_id).toBe('backfill-profile')
      expect(row.thread_id).toBe(threadId)
    }
    expect(indexed.map((row) => row.tool_name)).toEqual(['read_file', 'write_file', 'send_email'])
    expect(readActivityLedgerCoverage(db)).toEqual({
      reconstructedThrough: 3,
      reconstructedCount: 3,
      observedFrom: null,
    })
  })

  it('orders a timestamp tie deterministically instead of arbitrarily', () => {
    // Two receipts recorded in the same millisecond have no observable order.
    // The index must still be stable across rebuilds, so receipt_id breaks the
    // tie — and the row stays marked reconstructed, because a stable order is
    // not the same as a true one.
    const { runId } = seedRun()
    const a = seedEffect(runId, 500, 'tool_a')
    const b = seedEffect(runId, 500, 'tool_b')
    applyLedgerMigration()
    const expected = [a, b].sort()
    expect(rows().map((row) => row.receipt_id)).toEqual(expected)
    expect(rows().every((row) => row.origin === 'backfill')).toBe(true)
  })

  it('carries each family through with its own bounded filter values', () => {
    const { runId } = seedRun()
    seedEffect(runId, 100, 'send_email')
    const egressId = randomUUID()
    db.prepare(`
      INSERT INTO egress_dispatches (
        dispatch_id, run_id, mode, source_kind, source_ref, transport, mediation,
        first_observed_at
      ) VALUES (?, ?, 'unrestricted', 'provider', 'ollama', 'http', 'platform_fetch', 100)
    `).run(egressId, runId)
    const egressReceipt = randomUUID()
    db.prepare(`
      INSERT INTO egress_receipts (
        receipt_id, receipt_seq, dispatch_id, run_id, observation_key,
        destination_origin, phase, reason_code, observed_at
      ) VALUES (?, 1, ?, ?, 'obs-e', 'http://127.0.0.1:11434', 'response_observed',
        NULL, 200)
    `).run(egressReceipt, egressId, runId)

    applyLedgerMigration()

    const indexed = rows()
    expect(indexed.map((row) => row.family)).toEqual(['effect', 'egress'])
    expect(indexed[0]!.consequence).toBe('effect_possible')
    expect(indexed[0]!.outcome).toBe('succeeded')
    // Egress phase is the family's own vocabulary, carried as a filter label.
    expect(indexed[1]!.outcome).toBe('response_observed')
    expect(indexed[1]!.consequence).toBeNull()
  })

  it('cannot be asked to index a receipt whose run is gone', () => {
    // The backfill inner-joins gateway_runs so a scope-less receipt is omitted
    // rather than given an invented profile. That branch is defensive: the
    // foreign key makes the orphan unreachable in the first place. Prove the
    // guarantee at the constraint, not by trusting the join.
    const { runId } = seedRun()
    seedEffect(runId, 100, 'send_email')
    expect(() => db.prepare('DELETE FROM gateway_runs WHERE id = ?').run(runId))
      .toThrow(/FOREIGN KEY/)
    applyLedgerMigration()
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.profile_id).toBe('backfill-profile')
  })

  it('continues the live sequence above the backfill without renumbering it', () => {
    const { runId } = seedRun()
    seedEffect(runId, 100, 'read_file')
    seedEffect(runId, 200, 'write_file')
    applyLedgerMigration()

    // A live append after an upgrade must not disturb reconstructed rows.
    const liveReceipt = randomUUID()
    db.prepare(`
      INSERT INTO activity_ledger (
        ledger_seq, family, receipt_id, run_id, thread_id, profile_id,
        workspace_id, occurred_at, origin, outcome, consequence, tool_name
      )
      SELECT (SELECT COALESCE(MAX(ledger_seq),0)+1 FROM activity_ledger),
             'effect', ?, id, thread_id, profile_id, workspace_id, 900, 'live',
             NULL, NULL, NULL
      FROM gateway_runs WHERE id = ?
    `).run(liveReceipt, runId)

    expect(rows().map((row) => [row.ledger_seq, row.origin])).toEqual([
      [1, 'backfill'], [2, 'backfill'], [3, 'live'],
    ])
    expect(readActivityLedgerCoverage(db)).toEqual({
      reconstructedThrough: 2,
      reconstructedCount: 2,
      observedFrom: 3,
    })
  })

  it('leaves no partial index when the upgrade fails midway', () => {
    const { runId } = seedRun()
    seedEffect(runId, 100, 'read_file')
    // A migration list whose next step fails must roll the ledger back with it,
    // so a retried upgrade never finds half an index already present.
    const poisoned = {
      version: 93,
      name: '093_intentional_failure',
      sql: 'SELECT RAISE_INVALID_SYNTAX_HERE;',
    }
    expect(() => runMigrationsSafely(
      db, dbPath, [...BEFORE_LEDGER, LEDGER_MIGRATION, poisoned as never],
    )).toThrow()
    // Migration failure closes the handle; reopen and inspect what survived.
    db.close()
    db = new Database(dbPath)
    const present = db.prepare(`
      SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='activity_ledger'
    `).pluck().get() as number
    // Either 092 rolled back entirely, or it committed with a complete index —
    // never a half-built one.
    expect(present === 0 || rows().length === 1).toBe(true)
  })
})
