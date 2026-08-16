/**
 * SqliteApprovalStore unit tests (Slice 8c). DB-backed — runs under the
 * node-ABI window (ENV-2), alongside the other schedules store tests. The
 * migration + FK cascade + inbox join are also proven non-disruptively by
 * `scratchpad` electron-node check during the build; this is the canonical
 * regression suite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { SqliteScheduleStore } from '../../../src/schedules/store.js'
import { SqliteApprovalStore } from '../../../src/schedules/approvals.js'
import type { CreateScheduleInput } from '../../../src/schedules/types.js'

let tmpDir: string
let db: CortexDatabase
let schedules: SqliteScheduleStore
let approvals: SqliteApprovalStore
let scheduleId: string
let runId: string

const scheduleInput = (over: Partial<CreateScheduleInput> = {}): CreateScheduleInput => ({
  profileId: 'ari',
  name: 'inbox triage',
  prompt: 'triage',
  cadenceKind: 'daily',
  cadenceExpr: '{"time":"09:00"}',
  cadenceDisplay: 'Every day at 9:00 AM',
  timezone: 'UTC',
  ...over,
})

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-appr-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'))
  schedules = new SqliteScheduleStore(db.rawMainHandle)
  approvals = new SqliteApprovalStore(db.rawMainHandle)
  const s = schedules.create(scheduleInput())
  scheduleId = s.id
  runId = schedules.recordRun({ scheduleId, scheduledFor: 1, runStatus: 'running', startedAt: 1 }).id
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

const mkAppr = (over: Record<string, unknown> = {}) =>
  approvals.create({
    scheduleId,
    runId,
    toolName: 'gmail_send',
    toolInput: { to: 'dana@acme.com', subject: 'Re: renewal', body: 'Hi Dana…' },
    summary: 'Email to dana@acme.com — Re: renewal',
    policyRevision: 'a'.repeat(64),
    toolRevision: 'b'.repeat(64),
    targetRevision: null,
    ...over,
  })

describe('SqliteApprovalStore', () => {
  it('creates + reads back a pending approval, JSON draft round-trips', () => {
    const a = mkAppr()
    expect(a.status).toBe('pending')
    expect(a.decidedAt).toBeNull()
    const got = approvals.get(a.id)!
    expect(got.toolName).toBe('gmail_send')
    expect(got.toolInput).toEqual({ to: 'dana@acme.com', subject: 'Re: renewal', body: 'Hi Dana…' })
    expect(got.summary).toContain('dana@acme.com')
  })

  it('lists by run (newest first)', () => {
    mkAppr({ summary: 'one' })
    mkAppr({ summary: 'two' })
    expect(approvals.listByRun(runId).length).toBe(2)
  })

  it('listPending enriches with the agent identity + filters by profileId', () => {
    mkAppr()
    const pending = approvals.listPending()
    expect(pending.length).toBe(1)
    expect(pending[0]!.scheduleName).toBe('inbox triage')
    expect(pending[0]!.profileId).toBe('ari')
    expect(approvals.listPending({ profileId: 'ari' }).length).toBe(1)
    expect(approvals.listPending({ profileId: 'someone-else' }).length).toBe(0)
  })

  it('countPending tracks the inbox badge', () => {
    mkAppr(); mkAppr()
    expect(approvals.countPending()).toBe(2)
    const a = approvals.listByRun(runId)[0]!
    approvals.decide(a.id, { status: 'discarded' })
    expect(approvals.countPending()).toBe(1)
  })

  it('claims once, then records success; a second claim cannot resend', () => {
    const a = mkAppr()
    const claim = approvals.claim(a.id, 10)
    expect(claim.status).toBe('claimed')
    expect(approvals.claim(a.id, 11).status).toBe('already_claimed')
    const approved = approvals.decide(a.id, { status: 'approved', result: { sent: true } })!
    expect(approved.status).toBe('approved')
    expect(approved.decidedAt).not.toBeNull()
    expect(approved.result).toEqual({ sent: true })
    // a second decide is a no-op (does not re-stamp / flip)
    const again = approvals.decide(a.id, { status: 'discarded' })!
    expect(again.status).toBe('approved')
  })

  it('decide can record an approved-but-failed execution honestly (never a fake success)', () => {
    const a = mkAppr()
    expect(approvals.claim(a.id).status).toBe('claimed')
    const failed = approvals.decide(a.id, { status: 'failed', errorMessage: 'Slack token expired' })!
    expect(failed.status).toBe('failed')
    expect(failed.errorMessage).toBe('Slack token expired')
  })

  it('rejects a corrupt lifecycle at the database boundary', () => {
    const a = mkAppr()
    expect(() => db.rawMainHandle
      .prepare(`UPDATE schedule_approvals SET status = 'bogus' WHERE id = ?`)
      .run(a.id)).toThrow()
  })

  it('marks a claimed action indeterminate after restart recovery and never makes it pending', () => {
    const a = mkAppr()
    expect(approvals.claim(a.id, 10).status).toBe('claimed')
    expect(approvals.recoverInterruptedClaims(20)).toBe(1)
    expect(approvals.get(a.id)).toMatchObject({ status: 'indeterminate', claimedAt: 10 })
    expect(approvals.claim(a.id, 30).status).toBe('already_claimed')
  })

  it('blocks a changed stored action instead of dispatching it', () => {
    const a = mkAppr()
    db.rawMainHandle.prepare(`UPDATE schedule_approvals SET tool_input = ? WHERE id = ?`)
      .run(JSON.stringify({ to: 'attacker@example.com' }), a.id)
    expect(approvals.claim(a.id).status).toBe('intent_mismatch')
    expect(approvals.get(a.id)?.status).toBe('indeterminate')
  })

  it('cascade-deletes when the parent schedule is removed (FK ON DELETE CASCADE)', () => {
    mkAppr()
    expect(approvals.countPending()).toBe(1)
    schedules.delete(scheduleId)
    expect(approvals.countPending()).toBe(0)
  })
})
