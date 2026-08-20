/**
 * ScheduleRunner unit tests — deterministic, no API. We inject a
 * controllable clock + a stub `startProfileRun`, so we can prove the
 * reliability logic (advance-before-fire, collapse-once, catch-up policy,
 * overlap, boot reconcile) without waiting real time or calling a model.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { SqliteScheduleStore } from '../../../src/schedules/store.js'
import { ScheduleRunner, type StartProfileRunFn } from '../../../src/schedules/runner.js'
import type { CreateScheduleInput } from '../../../src/schedules/types.js'

let tmpDir: string
let db: CortexDatabase
let store: SqliteScheduleStore

// Controllable clock.
let clock = 1_000_000_000_000
const now = (): number => clock

// Stub startProfileRun: records calls, returns a controllable `done`.
interface StubCall {
  readonly params: Parameters<StartProfileRunFn>[0]
  /**
   * Resolve the run's `done` with a terminal RunResult verdict (default
   * 'completed'). `errorEvent` mirrors an in-band error message recorded
   * during a run that still returned 'completed' (BUGS HON-1).
   */
  resolve: (status?: string, errorEvent?: string) => void
  threadId: string
}
let calls: StubCall[]
let runningThreads: Set<string>
let threadSeq: number

function makeStub(): StartProfileRunFn {
  return async (params) => {
    const threadId = `thread_${threadSeq++}`
    // The real startProfileRun creates a thread row; mirror that so the
    // schedule_runs.thread_id FK is satisfied (and faithful to production).
    db.rawMainHandle
      .prepare(`INSERT INTO threads (id, profile_id) VALUES (?, ?)`)
      .run(threadId, params.profileId ?? 'ownware')
    runningThreads.add(threadId)
    let resolve!: (status?: string, errorEvent?: string) => void
    // `done` resolves to a RunResult-shaped verdict, exactly like the real
    // session runner — the engine classifies the outcome from it.
    const done = new Promise<{ status: string; errorEvent?: string }>((r) => {
      resolve = (status = 'completed', errorEvent?: string): void => {
        runningThreads.delete(threadId)
        r({ status, ...(errorEvent != null ? { errorEvent } : {}) })
      }
    })
    calls.push({ params, resolve, threadId })
    return { threadId, done }
  }
}

function makeRunner(over: Partial<Parameters<typeof ScheduleRunner.prototype.constructor>[0]> = {}): ScheduleRunner {
  return new ScheduleRunner({
    store,
    startProfileRun: makeStub(),
    isRunning: (t) => runningThreads.has(t),
    now,
    tickIntervalMs: 60_000,
    onError: (err, ctx) => {
      throw new Error(`unexpected runner error [${ctx}]: ${String(err)}`)
    },
    ...over,
  })
}

function input(over: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    profileId: 'ownware',
    name: 'test',
    prompt: 'do the thing',
    cadenceKind: 'interval',
    cadenceExpr: '1', // 1 minute
    cadenceDisplay: 'Every 1 minute',
    timezone: 'UTC',
    nextRunAt: clock,
    ...over,
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-sched-run-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'))
  store = new SqliteScheduleStore(db.rawMainHandle)
  clock = 1_000_000_000_000
  calls = []
  runningThreads = new Set()
  threadSeq = 0
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('ScheduleRunner — firing + at-most-once', () => {
  it('fires a due schedule and advances the cursor BEFORE dispatch', async () => {
    const s = store.create(input({ nextRunAt: clock }))
    const runner = makeRunner()

    await runner.tickOnce()

    // Cursor advanced synchronously, before the (async) run resolves.
    const afterTick = store.get(s.id)!
    expect(afterTick.nextRunAt).toBe(clock + 60_000) // +1 minute
    expect(afterTick.lastRunAt).toBe(clock)
    // The atomic record+advance linked lastRunId to the new run.
    expect(afterTick.lastRunId).toBe(store.listRuns(s.id)[0]!.id)
    expect(calls.length).toBe(1)
    expect(calls[0]!.params.prompt).toBe('do the thing')

    // A run record exists, in-flight ('running') with the thread linked.
    let runs = store.listRuns(s.id)
    expect(runs.length).toBe(1)
    expect(runs[0]!.runStatus).toBe('running')

    // Resolve the run → it finalizes to succeeded.
    calls[0]!.resolve('completed')
    await runner.drain()

    runs = store.listRuns(s.id)
    expect(runs[0]!.runStatus).toBe('succeeded')
    expect(runs[0]!.threadId).toBe(calls[0]!.threadId)
    expect(runs[0]!.finishedAt).toBe(clock)
  })

  it('does not re-fire until the next slot is due (at-most-once)', async () => {
    const s = store.create(input({ nextRunAt: clock }))
    const runner = makeRunner()

    await runner.tickOnce()
    expect(calls.length).toBe(1)
    // Same instant — not due again (cursor already advanced).
    await runner.tickOnce()
    expect(calls.length).toBe(1)

    // Settle the first run so overlap protection doesn't block the next slot.
    calls[0]!.resolve('completed')
    await runner.drain()

    // Advance the clock past the next slot → fires again.
    clock += 60_000
    await runner.tickOnce()
    expect(calls.length).toBe(2)
  })

  it('fires 3× across 3 ticks as time advances', async () => {
    const s = store.create(input({ nextRunAt: clock }))
    const runner = makeRunner()
    for (let i = 0; i < 3; i++) {
      await runner.tickOnce()
      // settle each run as succeeded
      const c = calls[i]!
      c.resolve('completed')
      await runner.drain()
      clock += 60_000
    }
    expect(calls.length).toBe(3)
    expect(store.listRuns(s.id).filter((r) => r.runStatus === 'succeeded').length).toBe(3)
  })

  it('marks a dispatch failure as failed-to-run (honest, not silent)', async () => {
    const s = store.create(input({ nextRunAt: clock }))
    const runner = new ScheduleRunner({
      store,
      startProfileRun: async () => {
        throw new Error('boom')
      },
      isRunning: () => false,
      now,
      onError: () => {}, // expected here
    })
    await runner.tickOnce()
    await runner.drain()
    const runs = store.listRuns(s.id)
    expect(runs[0]!.runStatus).toBe('failed-to-run')
    expect(runs[0]!.errorMessage).toContain('boom')
    // cursor still advanced (at-most-once: we don't retry-storm).
    expect(store.get(s.id)!.nextRunAt).toBe(clock + 60_000)
  })

  it('classifies an errored run as failed-to-run (from the RunResult verdict)', async () => {
    const s = store.create(input({ nextRunAt: clock }))
    const runner = makeRunner()
    await runner.tickOnce()
    calls[0]!.resolve('error')
    await runner.drain()
    expect(store.listRuns(s.id)[0]!.runStatus).toBe('failed-to-run')
  })

  it('classifies an ABORTED/timed-out run as failed-to-run, never a false success', async () => {
    const s = store.create(input({ nextRunAt: clock }))
    const runner = makeRunner()
    await runner.tickOnce()
    calls[0]!.resolve('aborted') // thread status would be 'completed' — but the verdict is honest
    await runner.drain()
    const run = store.listRuns(s.id)[0]!
    expect(run.runStatus).toBe('failed-to-run')
    expect(run.errorMessage).toMatch(/aborted|timed out/i)
  })

  it('an unknown/missing run verdict is failed-to-run, not a silent success', async () => {
    const s = store.create(input({ nextRunAt: clock }))
    const runner = makeRunner()
    await runner.tickOnce()
    calls[0]!.resolve('weird-unexpected-status')
    await runner.drain()
    expect(store.listRuns(s.id)[0]!.runStatus).toBe('failed-to-run')
  })

  it('HON-1: a completed run that ended in an in-band error message is failed-to-run', async () => {
    // Repro of the live bug: adam (anthropic model, no ANTHROPIC_API_KEY) — the
    // agent turn ends with a role:'error' message ("Could not resolve
    // authentication method"), but the loop returns 'completed'. The run must
    // be recorded failed-to-run, never a false 'succeeded'.
    const s = store.create(input({ nextRunAt: clock }))
    const runner = makeRunner()
    await runner.tickOnce()
    calls[0]!.resolve('completed', 'Could not resolve authentication method')
    await runner.drain()
    const run = store.listRuns(s.id)[0]!
    expect(run.runStatus).toBe('failed-to-run')
    expect(run.errorMessage).toContain('authentication')
  })

  it('a genuinely clean completed run (no error event) is still succeeded', async () => {
    const s = store.create(input({ nextRunAt: clock }))
    const runner = makeRunner()
    await runner.tickOnce()
    calls[0]!.resolve('completed') // no errorEvent
    await runner.drain()
    expect(store.listRuns(s.id)[0]!.runStatus).toBe('succeeded')
  })
})

describe('ScheduleRunner — catch-up policy (the owner question)', () => {
  it('collapse-once: a long-overdue recurring schedule fires ONCE and fast-forwards', async () => {
    // due 10 minutes ago; clock is "now".
    const s = store.create(input({ nextRunAt: clock - 10 * 60_000, catchUpPolicy: 'catch-up' }))
    const runner = makeRunner()
    await runner.tickOnce()
    expect(calls.length).toBe(1) // ONE catch-up, not 10
    const after = store.get(s.id)!
    expect(after.nextRunAt).toBe(clock + 60_000) // re-anchored to now+period
    const run = store.listRuns(s.id)[0]!
    expect(run.wasCatchUp).toBe(true)
  })

  it("skip: a missed recurring schedule does NOT run late; records 'skipped'", async () => {
    const s = store.create(input({ nextRunAt: clock - 10 * 60_000, catchUpPolicy: 'skip' }))
    const runner = makeRunner()
    await runner.tickOnce()
    expect(calls.length).toBe(0) // did NOT dispatch a run
    const run = store.listRuns(s.id)[0]!
    expect(run.runStatus).toBe('skipped')
    expect(run.skipReason).toBe('asleep-caught-up')
    expect(run.wasCatchUp).toBe(true)
    // still advanced so it waits for the next slot.
    expect(store.get(s.id)!.nextRunAt).toBe(clock + 60_000)
  })

  it('an on-time fire (within grace) is NOT marked catch-up, even under skip policy', async () => {
    // due 5s ago — within the 30s grace for a 1-min schedule.
    const s = store.create(input({ nextRunAt: clock - 5_000, catchUpPolicy: 'skip' }))
    const runner = makeRunner()
    await runner.tickOnce()
    expect(calls.length).toBe(1) // runs (not a catch-up → skip doesn't apply)
    expect(store.listRuns(s.id)[0]!.wasCatchUp).toBe(false)
  })

  it('window: catches up only if missed by less than the window', async () => {
    const recent = store.create(
      input({ nextRunAt: clock - 90_000, catchUpPolicy: 'window', catchUpWindowMs: 120_000 }),
    )
    const stale = store.create(
      input({ nextRunAt: clock - 200_000, catchUpPolicy: 'window', catchUpWindowMs: 120_000 }),
    )
    const runner = makeRunner()
    await runner.tickOnce()
    expect(calls.length).toBe(1) // only the recent one ran
    expect(store.listRuns(recent.id)[0]!.runStatus).toBe('running')
    expect(store.listRuns(stale.id)[0]!.runStatus).toBe('skipped')
  })

  it('window with NO window configured catches up (never a silent collapse to skip)', async () => {
    // catchUpWindowMs left unset → treated as "always catch up", not "never".
    const s = store.create(input({ nextRunAt: clock - 10 * 60_000, catchUpPolicy: 'window' }))
    const runner = makeRunner()
    await runner.tickOnce()
    expect(calls.length).toBe(1)
    expect(store.listRuns(s.id)[0]!.runStatus).toBe('running')
  })
})

describe('ScheduleRunner — overlap + one-off + boot reconcile', () => {
  it('skip-if-running: does not start a new run while the previous is active', async () => {
    const s = store.create(input({ nextRunAt: clock, overlapPolicy: 'skip-if-running' }))
    const runner = makeRunner()
    await runner.tickOnce() // fires; thread is "running" (not resolved)
    expect(calls.length).toBe(1)

    // next slot due, previous still running → skipped(previous-still-running)
    clock += 60_000
    await runner.tickOnce()
    expect(calls.length).toBe(1)
    const runs = store.listRuns(s.id)
    expect(runs[0]!.runStatus).toBe('skipped')
    expect(runs[0]!.skipReason).toBe('previous-still-running')
  })

  it('a one-off fires once and is marked completed (cursor nulled)', async () => {
    const s = store.create(input({ cadenceKind: 'once', cadenceExpr: String(clock), nextRunAt: clock }))
    const runner = makeRunner()
    await runner.tickOnce()
    expect(calls.length).toBe(1)
    const after = store.get(s.id)!
    expect(after.nextRunAt).toBeNull()
    expect(after.state).toBe('completed')
    // never due again
    clock += 10 * 60_000
    await runner.tickOnce()
    expect(calls.length).toBe(1)
  })

  it('boot reconcile: orphaned running runs become failed on start()', async () => {
    const s = store.create(input({ nextRunAt: clock + 999_999 })) // not due
    // Simulate a run that was interrupted mid-flight (left 'running').
    store.recordRun({ scheduleId: s.id, scheduledFor: clock, runStatus: 'running', startedAt: clock })
    const runner = makeRunner()
    await runner.start()
    runner.stop() // don't leave a timer
    const runs = store.listRuns(s.id)
    expect(runs[0]!.runStatus).toBe('failed-to-run')
    expect(runs[0]!.errorMessage).toContain('Interrupted')
  })

  it('a disabled schedule never fires', async () => {
    const s = store.create(input({ nextRunAt: clock, enabled: false }))
    const runner = makeRunner()
    await runner.tickOnce()
    expect(calls.length).toBe(0)
    expect(store.listRuns(s.id).length).toBe(0)
  })
})

describe('ScheduleRunner — weekly re-arm (V1)', () => {
  // The board flagged "weekly/cron re-arm unverified (runner doc-drift)".
  // These pin the runner's actual behaviour: weekly re-arms to the next
  // CHOSEN day after each fire, and the re-arm math is DST-stable.

  it('re-arms a weekly schedule to the next chosen day after firing', async () => {
    // Mon 2026-08-17 09:00 UTC; fires Mon/Fri at 09:00.
    const monday = Date.UTC(2026, 7, 17, 9, 0, 0)
    clock = monday
    const s = store.create(input({
      cadenceKind: 'weekly',
      cadenceExpr: '{"time":"09:00","days":[1,5]}',
      cadenceDisplay: 'Mondays and Fridays at 09:00',
      nextRunAt: monday,
    }))
    const runner = makeRunner()
    await runner.tickOnce()
    expect(calls).toHaveLength(1)
    calls[0]!.resolve()
    await runner.drain()

    const friday = Date.UTC(2026, 7, 21, 9, 0, 0)
    const after = store.get(s.id)!
    expect(after.state).toBe('scheduled')
    expect(after.nextRunAt).toBe(friday)

    // And across the week boundary: fire Friday, re-arm to NEXT Monday.
    clock = friday
    await runner.tickOnce()
    expect(calls).toHaveLength(2)
    calls[1]!.resolve()
    await runner.drain()
    expect(store.get(s.id)!.nextRunAt).toBe(Date.UTC(2026, 7, 24, 9, 0, 0))
  })

  it('keeps the local fire time across a DST transition', async () => {
    // America/New_York leaves DST on Sun 2026-11-01. A Friday 09:00 schedule
    // fired on Oct 30 must re-arm to Nov 6 09:00 LOCAL — which is a different
    // UTC offset (13:00Z → 14:00Z). Fixed-interval math would drift an hour.
    const fridayBeforeDst = Date.UTC(2026, 9, 30, 13, 0, 0) // 09:00 EDT
    clock = fridayBeforeDst
    const s = store.create(input({
      cadenceKind: 'weekly',
      cadenceExpr: '{"time":"09:00","days":[5]}',
      cadenceDisplay: 'Fridays at 09:00',
      timezone: 'America/New_York',
      nextRunAt: fridayBeforeDst,
    }))
    const runner = makeRunner()
    await runner.tickOnce()
    calls[0]!.resolve()
    await runner.drain()
    expect(store.get(s.id)!.nextRunAt).toBe(Date.UTC(2026, 10, 6, 14, 0, 0)) // 09:00 EST
  })

  it('completes a weekly whose day set is empty instead of spinning', async () => {
    const s = store.create(input({
      cadenceKind: 'weekly',
      cadenceExpr: '{"time":"09:00","days":[]}',
      cadenceDisplay: 'never',
      nextRunAt: clock,
    }))
    const runner = makeRunner()
    await runner.tickOnce()
    calls[0]!.resolve()
    await runner.drain()
    // No next occurrence exists; the honest terminal state is completed.
    expect(store.get(s.id)!.state).toBe('completed')
    expect(store.get(s.id)!.nextRunAt).toBeNull()
  })
})
