import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { SqliteScheduleStore } from '../../../src/schedules/store.js'
import type { CreateScheduleInput } from '../../../src/schedules/types.js'

let tmpDir: string
let db: CortexDatabase
let store: SqliteScheduleStore

function baseInput(over: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    profileId: 'ownware',
    name: 'Morning triage',
    prompt: 'Triage my inbox and draft replies for approval.',
    cadenceKind: 'daily',
    cadenceExpr: '0 9 * * *',
    cadenceDisplay: 'Daily at 9:00 AM',
    timezone: 'America/New_York',
    ...over,
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-sched-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'))
  store = new SqliteScheduleStore(db.rawMainHandle)
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('SqliteScheduleStore — schedules CRUD', () => {
  it('migration 43 created the tables', () => {
    const tables = db.rawMainHandle
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('schedules','schedule_runs')`)
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name).sort()).toEqual(['schedule_runs', 'schedules'])
  })

  it('creates and reads back a schedule with all fields + defaults', () => {
    const s = store.create(
      baseInput({
        model: 'openrouter:haiku-4.5',
        nextRunAt: 1_900_000_000_000,
        skipWeekends: true,
        toolEnvelope: { autoRun: ['readFile'], autoDeny: ['shell'] },
      }),
    )
    expect(s.id).toMatch(/^sched_/)
    expect(s.profileId).toBe('ownware')
    expect(s.model).toBe('openrouter:haiku-4.5')
    expect(s.nextRunAt).toBe(1_900_000_000_000)
    expect(s.skipWeekends).toBe(true)
    expect(s.skipHolidays).toBe(false) // default
    expect(s.catchUpPolicy).toBe('catch-up') // default (owner-locked)
    expect(s.overlapPolicy).toBe('skip-if-running') // default
    expect(s.enabled).toBe(true) // default
    expect(s.state).toBe('scheduled')
    expect(s.toolEnvelope).toEqual({ autoRun: ['readFile'], autoDeny: ['shell'] })
    expect(s.createdAt).toBeGreaterThan(0)

    const fetched = store.get(s.id)
    expect(fetched).toEqual(s)
  })

  it('get() returns null for an unknown id', () => {
    expect(store.get('sched_nope')).toBeNull()
  })

  it('lists by profile and enabledOnly', () => {
    const a = store.create(baseInput({ profileId: 'ownware', name: 'A' }))
    store.create(baseInput({ profileId: 'coder', name: 'B' }))
    const c = store.create(baseInput({ profileId: 'ownware', name: 'C', enabled: false }))

    expect(store.list().length).toBe(3)
    expect(store.list({ profileId: 'ownware' }).map((s) => s.id).sort()).toEqual([a.id, c.id].sort())
    expect(store.list({ profileId: 'ownware', enabledOnly: true }).map((s) => s.id)).toEqual([a.id])
  })

  it('updates user-facing fields without touching the engine cursor', () => {
    const s = store.create(baseInput({ nextRunAt: 123 }))
    const updated = store.update(s.id, {
      name: 'Renamed',
      catchUpPolicy: 'skip',
      skipHolidays: true,
      prompt: 'new prompt',
    })
    expect(updated?.name).toBe('Renamed')
    expect(updated?.catchUpPolicy).toBe('skip')
    expect(updated?.skipHolidays).toBe(true)
    expect(updated?.prompt).toBe('new prompt')
    // cursor untouched by update()
    expect(updated?.nextRunAt).toBe(123)
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(s.updatedAt)
  })

  it('update() returns null for an unknown id', () => {
    expect(store.update('sched_nope', { name: 'x' })).toBeNull()
  })

  it('setEnabled pauses and resumes (state follows)', () => {
    const s = store.create(baseInput())
    const paused = store.setEnabled(s.id, false)
    expect(paused?.enabled).toBe(false)
    expect(paused?.state).toBe('paused')
    const resumed = store.setEnabled(s.id, true)
    expect(resumed?.enabled).toBe(true)
    expect(resumed?.state).toBe('scheduled')
  })

  it('deletes a schedule', () => {
    const s = store.create(baseInput())
    expect(store.delete(s.id)).toBe(true)
    expect(store.get(s.id)).toBeNull()
    expect(store.delete(s.id)).toBe(false) // already gone
  })
})

describe('SqliteScheduleStore — getDue (the engine hot query)', () => {
  it('returns only enabled rows due at/before now, oldest-first', () => {
    const now = 1_000_000
    const past1 = store.create(baseInput({ name: 'past1', nextRunAt: now - 5000 }))
    const past2 = store.create(baseInput({ name: 'past2', nextRunAt: now - 1000 }))
    store.create(baseInput({ name: 'future', nextRunAt: now + 5000 }))
    store.create(baseInput({ name: 'no-cursor', nextRunAt: null }))
    const disabledPast = store.create(baseInput({ name: 'disabled', nextRunAt: now - 9000, enabled: false }))

    const due = store.getDue(now)
    expect(due.map((s) => s.id)).toEqual([past1.id, past2.id]) // ascending by next_run_at
    expect(due.map((s) => s.id)).not.toContain(disabledPast.id)
  })

  it('treats next_run_at == now as due (inclusive)', () => {
    const now = 500
    const s = store.create(baseInput({ nextRunAt: now }))
    expect(store.getDue(now).map((d) => d.id)).toEqual([s.id])
  })
})

describe('SqliteScheduleStore — advance (at-most-once cursor)', () => {
  it('moves next_run_at forward and records last_run', () => {
    const s = store.create(baseInput({ nextRunAt: 100 }))
    const run = store.recordRun({ scheduleId: s.id, scheduledFor: 100, runStatus: 'succeeded' })
    const advanced = store.advance(s.id, { nextRunAt: 200, lastRunAt: 150, lastRunId: run.id })
    expect(advanced?.nextRunAt).toBe(200)
    expect(advanced?.lastRunAt).toBe(150)
    expect(advanced?.lastRunId).toBe(run.id)
    // No longer due at t=150 (advanced past it).
    expect(store.getDue(150).map((d) => d.id)).not.toContain(s.id)
  })

  it('can null the cursor + mark a one-off completed', () => {
    const s = store.create(baseInput({ cadenceKind: 'once', nextRunAt: 100 }))
    const done = store.advance(s.id, { nextRunAt: null, state: 'completed' })
    expect(done?.nextRunAt).toBeNull()
    expect(done?.state).toBe('completed')
    expect(store.getDue(999_999).map((d) => d.id)).not.toContain(s.id)
  })
})

describe('SqliteScheduleStore — run history ledger', () => {
  it('records, reads, updates, and lists runs newest-first', () => {
    const s = store.create(baseInput())
    const r1 = store.recordRun({ scheduleId: s.id, scheduledFor: 100, runStatus: 'succeeded', wasCatchUp: true })
    const r2 = store.recordRun({ scheduleId: s.id, scheduledFor: 200, runStatus: 'skipped', skipReason: 'asleep-caught-up' })
    expect(r1.wasCatchUp).toBe(true)
    expect(r2.skipReason).toBe('asleep-caught-up')

    // A run links to a REAL thread (the FK to threads is enforced — that's
    // intentional: a bogus thread_id must not be storable).
    db.rawMainHandle.prepare(`INSERT INTO threads (id, profile_id) VALUES (?, ?)`).run('thread_abc', 'ownware')
    const updated = store.updateRun(r1.id, { threadId: 'thread_abc', runStatus: 'ran-empty', finishedAt: 999 })
    expect(updated?.threadId).toBe('thread_abc')
    expect(updated?.runStatus).toBe('ran-empty')
    expect(updated?.finishedAt).toBe(999)

    const runs = store.listRuns(s.id)
    expect(runs.map((r) => r.id)).toEqual([r2.id, r1.id]) // scheduled_for DESC
  })

  it('cascade-deletes runs when the schedule is deleted (FK ON DELETE CASCADE)', () => {
    const s = store.create(baseInput())
    store.recordRun({ scheduleId: s.id, scheduledFor: 100, runStatus: 'succeeded' })
    store.recordRun({ scheduleId: s.id, scheduledFor: 200, runStatus: 'succeeded' })
    expect(store.listRuns(s.id).length).toBe(2)
    store.delete(s.id)
    expect(store.listRuns(s.id).length).toBe(0)
  })
})

describe('SqliteScheduleStore — corruption is loud, not silent', () => {
  it('throws on a corrupt enum at read time (Zod parse)', () => {
    const s = store.create(baseInput())
    db.rawMainHandle.prepare(`UPDATE schedules SET state = 'garbage' WHERE id = ?`).run(s.id)
    expect(() => store.get(s.id)).toThrow()
  })
})
