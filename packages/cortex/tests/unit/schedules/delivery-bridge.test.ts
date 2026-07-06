/**
 * Slice 8 delivery bridge — the seam from a terminal scheduled run to an
 * outbound channel push. Same deterministic harness as runner.test.ts
 * (controllable clock, stub startProfileRun, real SQLite store); the sink
 * and finalText are injected so no channel adapter is involved.
 *
 * The honest-ledger contract under test:
 *   no `deliver` on the schedule → delivery_status 'not-requested'
 *   notify rule says quiet       → 'not-delivered', run status untouched
 *   no sink / send failed        → 'not-delivered'; a clean success
 *                                  escalates to 'failed-to-deliver'
 *   sent                         → 'delivered'
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { SqliteScheduleStore } from '../../../src/schedules/store.js'
import {
  ScheduleRunner,
  type StartProfileRunFn,
  type ScheduleDelivery,
  type ScheduleDeliverySink,
} from '../../../src/schedules/runner.js'
import type { CreateScheduleInput } from '../../../src/schedules/types.js'

let tmpDir: string
let db: CortexDatabase
let store: SqliteScheduleStore

let clock = 1_000_000_000_000
const now = (): number => clock

interface StubCall {
  resolve: (status?: string, errorEvent?: string) => void
  threadId: string
}
let calls: StubCall[]
let threadSeq: number

function makeStub(behavior: { throwOnStart?: string } = {}): StartProfileRunFn {
  return async (params) => {
    if (behavior.throwOnStart != null) throw new Error(behavior.throwOnStart)
    const threadId = `thread_${threadSeq++}`
    db.rawMainHandle
      .prepare(`INSERT INTO threads (id, profile_id) VALUES (?, ?)`)
      .run(threadId, params.profileId ?? 'ownware')
    let resolve!: (status?: string, errorEvent?: string) => void
    const done = new Promise<{ status: string; errorEvent?: string }>((r) => {
      resolve = (status = 'completed', errorEvent?: string): void => {
        r({ status, ...(errorEvent != null ? { errorEvent } : {}) })
      }
    })
    calls.push({ resolve, threadId })
    return { threadId, done }
  }
}

let sinkCalls: ScheduleDelivery[]
let sinkImpl: ScheduleDeliverySink | null
let finalTextByThread: Map<string, string>

function makeRunner(over: {
  startProfileRun?: StartProfileRunFn
  onError?: (err: unknown, ctx: string) => void
} = {}): ScheduleRunner {
  return new ScheduleRunner({
    store,
    startProfileRun: over.startProfileRun ?? makeStub(),
    isRunning: () => false,
    now,
    tickIntervalMs: 60_000,
    onError: over.onError ?? ((err, ctx): void => {
      throw new Error(`unexpected runner error [${ctx}]: ${String(err)}`)
    }),
    delivery: {
      finalText: (threadId) => finalTextByThread.get(threadId) ?? null,
      sink: () => sinkImpl,
    },
  })
}

function input(over: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  return {
    profileId: 'ownware',
    name: 'morning brief',
    prompt: 'summarize my inbox',
    cadenceKind: 'interval',
    cadenceExpr: '1',
    cadenceDisplay: 'Every 1 minute',
    timezone: 'UTC',
    nextRunAt: clock,
    deliver: { channel: 'slack', target: '#general' },
    ...over,
  }
}

/** Fire the due schedule and settle the run with `status`. */
async function fireAndSettle(runner: ScheduleRunner, status = 'completed'): Promise<void> {
  await runner.tickOnce()
  expect(calls.length).toBeGreaterThan(0)
  calls[calls.length - 1]!.resolve(status)
  await runner.drain()
}

function lastRun(scheduleId: string) {
  const runs = store.listRuns(scheduleId)
  expect(runs.length).toBeGreaterThan(0)
  return runs[0]!
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-sched-deliver-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'))
  store = new SqliteScheduleStore(db.rawMainHandle)
  clock = 1_000_000_000_000
  calls = []
  threadSeq = 0
  sinkCalls = []
  finalTextByThread = new Map()
  sinkImpl = async (d): Promise<void> => {
    sinkCalls.push(d)
  }
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// The deliver field itself (store round-trip)
// ---------------------------------------------------------------------------

describe('ScheduleDto.deliver — store round-trip', () => {
  it('persists and reads back the channel/target pair', () => {
    const s = store.create(input())
    expect(store.get(s.id)?.deliver).toEqual({ channel: 'slack', target: '#general' })
  })

  it('defaults to null and can be set + cleared via update', () => {
    const s = store.create(input({ deliver: null }))
    expect(s.deliver).toBeNull()

    const set = store.update(s.id, { deliver: { channel: 'telegram', target: '12345' } })
    expect(set?.deliver).toEqual({ channel: 'telegram', target: '12345' })

    // undefined leaves it alone; explicit null clears it.
    const untouched = store.update(s.id, { name: 'renamed' })
    expect(untouched?.deliver).toEqual({ channel: 'telegram', target: '12345' })
    const cleared = store.update(s.id, { deliver: null })
    expect(cleared?.deliver).toBeNull()
  })

  it('rejects an unknown channel at the boundary', () => {
    expect(() =>
      store.create(input({ deliver: { channel: 'carrier-pigeon' as never, target: 'x' } })),
    ).toThrow()
  })

  it('a half-written row reads as null, not a crash', () => {
    const s = store.create(input())
    db.rawMainHandle
      .prepare(`UPDATE schedules SET deliver_target = NULL WHERE id = ?`)
      .run(s.id)
    expect(store.get(s.id)?.deliver).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

describe('delivery bridge — pushes the run result to the sink', () => {
  it('succeeded run → sink gets the final assistant text, ledger says delivered', async () => {
    const s = store.create(input())
    const runner = makeRunner()
    await runner.tickOnce()
    finalTextByThread.set(calls[0]!.threadId, 'Inbox summary: 3 urgent emails.')
    calls[0]!.resolve('completed')
    await runner.drain()

    expect(sinkCalls).toHaveLength(1)
    expect(sinkCalls[0]).toMatchObject({
      channel: 'slack',
      target: '#general',
      text: 'Inbox summary: 3 urgent emails.',
      scheduleId: s.id,
      runStatus: 'succeeded',
    })
    const run = lastRun(s.id)
    expect(run.runStatus).toBe('succeeded')
    expect(run.deliveryStatus).toBe('delivered')
  })

  it('no deliver on the schedule → sink never called, status not-requested', async () => {
    const s = store.create(input({ deliver: null }))
    const runner = makeRunner()
    await fireAndSettle(runner)

    expect(sinkCalls).toHaveLength(0)
    expect(lastRun(s.id).deliveryStatus).toBe('not-requested')
  })

  it("deliveryMode 'silent' → quiet by rule: nothing sent, run status untouched", async () => {
    const s = store.create(input({ deliveryMode: 'silent' }))
    const runner = makeRunner()
    await fireAndSettle(runner)

    expect(sinkCalls).toHaveLength(0)
    const run = lastRun(s.id)
    expect(run.runStatus).toBe('succeeded')
    expect(run.deliveryStatus).toBe('not-delivered')
  })

  it('no sink running → a clean success escalates to failed-to-deliver (never a fake fine)', async () => {
    sinkImpl = null
    const s = store.create(input())
    const runner = makeRunner()
    await fireAndSettle(runner)

    const run = lastRun(s.id)
    expect(run.runStatus).toBe('failed-to-deliver')
    expect(run.deliveryStatus).toBe('not-delivered')
    expect(run.errorMessage).toContain('no channel')
  })

  it('sink throws → failed-to-deliver with the real error', async () => {
    sinkImpl = async (): Promise<void> => {
      throw new Error('slack said no')
    }
    const errors: string[] = []
    const s = store.create(input())
    const runner = makeRunner({ onError: (err) => errors.push(String(err)) })
    await fireAndSettle(runner)

    const run = lastRun(s.id)
    expect(run.runStatus).toBe('failed-to-deliver')
    expect(run.deliveryStatus).toBe('not-delivered')
    expect(run.errorMessage).toContain('slack said no')
    expect(errors.length).toBe(1)
  })

  it('failed run still notifies (on-activity: failure IS activity) with an honest text', async () => {
    const errors: string[] = []
    const s = store.create(input())
    const runner = makeRunner({ onError: (err) => errors.push(String(err)) })
    await fireAndSettle(runner, 'error')

    expect(sinkCalls).toHaveLength(1)
    expect(sinkCalls[0]!.text).toContain('failed to run')
    const run = lastRun(s.id)
    expect(run.runStatus).toBe('failed-to-run') // the delivery does NOT overwrite the failure
    expect(run.deliveryStatus).toBe('delivered')
  })

  it('startProfileRun throws (no thread at all) → the failure itself is delivered', async () => {
    const errors: string[] = []
    const s = store.create(input())
    const runner = makeRunner({
      startProfileRun: makeStub({ throwOnStart: 'provider not configured' }),
      onError: (err) => errors.push(String(err)),
    })
    await runner.tickOnce()
    await runner.drain()

    expect(sinkCalls).toHaveLength(1)
    expect(sinkCalls[0]!.text).toContain('provider not configured')
    const run = lastRun(s.id)
    expect(run.runStatus).toBe('failed-to-run')
    expect(run.deliveryStatus).toBe('delivered')
  })

  it('succeeded with no text output → an honest placeholder, not an empty message', async () => {
    const s = store.create(input())
    const runner = makeRunner()
    await fireAndSettle(runner) // no finalText registered for the thread

    expect(sinkCalls).toHaveLength(1)
    expect(sinkCalls[0]!.text).toContain('no text output')
    expect(lastRun(s.id).deliveryStatus).toBe('delivered')
  })
})
