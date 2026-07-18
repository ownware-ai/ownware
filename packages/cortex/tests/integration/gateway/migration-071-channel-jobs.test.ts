import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { runMigrationsSafely } from '../../../src/gateway/db/migration-safety.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

const JOB_ID = '11111111-1111-4111-8111-111111111111'
const RECEIPT_ID = '22222222-2222-4222-8222-222222222222'
const CLAIM = '33333333-3333-4333-8333-333333333333'

function baseJobRow(db: Database.Database, overrides: Record<string, unknown> = {}): void {
  const row = {
    job_id: JOB_ID,
    profile_id: 'rosa',
    operation: 'connect_whatsapp',
    channel_kind: 'whatsapp',
    channel_id: null,
    params_json: '{}',
    state_json: '{}',
    step_count: 3,
    state: 'queued',
    attempt: 0,
    max_attempts: 3,
    checkpoint: 0,
    gate_json: null,
    gate_response_json: null,
    claim_token: null,
    claimed_by: null,
    lease_expires_at: null,
    retry_after: null,
    cancel_requested_at: null,
    outcome_code: null,
    created_at: 100,
    updated_at: 100,
    terminal_at: null,
    ...overrides,
  }
  db.prepare(`
    INSERT INTO channel_jobs (${Object.keys(row).join(', ')})
    VALUES (${Object.keys(row).map(() => '?').join(', ')})
  `).run(...Object.values(row))
}

describe('migration 071 channel jobs and receipts', () => {
  it('upgrades an older database and enforces the state-machine invariants', () => {
    dir = mkdtempSync(join(tmpdir(), 'channel-jobs-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    runMigrationsSafely(old, path, MIGRATIONS.filter((m) => m.version <= 70))
    old.close()

    const upgraded = new CortexDatabase(path)
    const db = upgraded.rawMainHandle
    try {
      const columns = (db.prepare('PRAGMA table_info(channel_jobs)')
        .all() as Array<{ name: string }>).map((c) => c.name)
      expect(columns).toEqual([
        'job_id', 'profile_id', 'operation', 'channel_kind', 'channel_id',
        'params_json', 'state_json', 'step_count', 'state', 'attempt',
        'max_attempts', 'checkpoint', 'gate_json', 'gate_response_json',
        'claim_token', 'claimed_by', 'lease_expires_at', 'retry_after',
        'cancel_requested_at', 'outcome_code', 'created_at', 'updated_at',
        'terminal_at',
      ])

      // A valid queued row inserts.
      baseJobRow(db)

      // One live job per (profile, operation).
      expect(() => baseJobRow(db, { job_id: CLAIM })).toThrow(/UNIQUE/)

      // running requires a claim triple.
      expect(() => baseJobRow(db, {
        job_id: '44444444-4444-4444-8444-444444444444',
        profile_id: 'other-1',
        state: 'running',
      })).toThrow(/CHECK/)

      // waiting_for_input requires the gate payload (and vice versa).
      expect(() => baseJobRow(db, {
        job_id: '55555555-5555-4555-8555-555555555555',
        profile_id: 'other-2',
        state: 'waiting_for_input',
      })).toThrow(/CHECK/)
      expect(() => baseJobRow(db, {
        job_id: '66666666-6666-4666-8666-666666666666',
        profile_id: 'other-3',
        gate_json: '{"id":"x"}',
      })).toThrow(/CHECK/)

      // Terminal states demand outcome + terminal time together.
      expect(() => baseJobRow(db, {
        job_id: '77777777-7777-4777-8777-777777777777',
        profile_id: 'other-4',
        state: 'failed',
        terminal_at: 200,
      })).toThrow(/CHECK/)

      // Secrets have no schema hole: params/state must be JSON objects.
      expect(() => baseJobRow(db, {
        job_id: '88888888-8888-4888-8888-888888888888',
        profile_id: 'other-5',
        params_json: '"just a string"',
      })).toThrow(/CHECK/)

      // Operation is shape-checked, NOT enumerated — new procedures need no
      // table rebuild (the migration-065 lesson).
      baseJobRow(db, {
        job_id: '99999999-9999-4999-8999-999999999999',
        profile_id: 'other-6',
        operation: 'connect_some_future_channel',
      })

      // Receipts: valid insert, then append-only enforced by triggers.
      db.prepare(`
        INSERT INTO channel_receipts (
          receipt_id, job_id, profile_id, channel_kind, channel_id,
          kind, title, body_json, created_at
        ) VALUES (?, ?, 'rosa', 'whatsapp', NULL, 'gate_decision', 'Approved — x', '{}', 100)
      `).run(RECEIPT_ID, JOB_ID)
      expect(() => db.prepare(
        "UPDATE channel_receipts SET title = 'edited' WHERE receipt_id = ?",
      ).run(RECEIPT_ID)).toThrow(/append-only/)
      expect(() => db.prepare(
        'DELETE FROM channel_receipts WHERE receipt_id = ?',
      ).run(RECEIPT_ID)).toThrow(/append-only/)

      // Work lines: composite key, positive seq.
      db.prepare(`
        INSERT INTO channel_job_work_lines (job_id, seq, title, detail, created_at)
        VALUES (?, 1, 'Checked the number', NULL, 100)
      `).run(JOB_ID)
      expect(() => db.prepare(`
        INSERT INTO channel_job_work_lines (job_id, seq, title, detail, created_at)
        VALUES (?, 0, 'bad seq', NULL, 100)
      `).run(JOB_ID)).toThrow(/CHECK/)
    } finally {
      upgraded.close()
    }
  })
})
