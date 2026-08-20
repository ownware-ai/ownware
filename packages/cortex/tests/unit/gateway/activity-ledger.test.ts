import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ActivityLedgerError,
  appendActivityLedgerRow,
  decodeActivityLedgerCursor,
  listActivityLedger,
} from '../../../src/gateway/activity-ledger.js'
import { EffectReceiptStore } from '../../../src/gateway/effect-receipt-store.js'
import { GatewayRunStore } from '../../../src/gateway/run-store.js'
import { GatewayState } from '../../../src/gateway/state.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ownware-activity-ledger-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface LedgerRow {
  readonly ledger_seq: number
  readonly family: string
  readonly receipt_id: string
  readonly run_id: string
  readonly thread_id: string
  readonly profile_id: string
  readonly workspace_id: string | null
  readonly occurred_at: number
  readonly origin: string
  readonly outcome: string | null
  readonly consequence: string | null
  readonly tool_name: string | null
}

async function fixture(profileId = 'ledger-test'): Promise<{
  readonly state: GatewayState
  readonly receipts: EffectReceiptStore
  readonly runId: string
  readonly threadId: string
  rows(): LedgerRow[]
}> {
  const state = new GatewayState(join(dir, 'ledger.db'))
  const thread = await state.createThread(profileId)
  const runs = new GatewayRunStore(state.rawDbHandle, 'ledger-test-secret')
  const run = runs.create({
    threadId: thread.id,
    profileId,
    model: 'test:model',
    timeoutMs: 60_000,
    startSeq: 0,
  }, 100)
  runs.markRunning(run.runId, 101)
  const db = state.rawDbHandle
  return {
    state,
    receipts: new EffectReceiptStore(db),
    runId: run.runId,
    threadId: thread.id,
    rows: () => db.prepare(
      'SELECT * FROM activity_ledger ORDER BY ledger_seq',
    ).all() as LedgerRow[],
  }
}

describe('activity ledger', () => {
  it('indexes an effect receipt in the receipt\'s own transaction', async () => {
    const f = await fixture()
    const receipt = await f.receipts.observe({
      runId: f.runId,
      toolCallId: 'call-1',
      toolName: 'send_email',
      observationKey: 'obs-1',
      kind: 'outcome_observed',
      outcome: 'succeeded',
      consequence: 'effect_possible',
      authorityKind: 'runtime',
      authorityRef: 'runtime:test',
    })

    const rows = f.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      ledger_seq: 1,
      family: 'effect',
      receipt_id: receipt.receiptId,
      run_id: f.runId,
      thread_id: f.threadId,
      profile_id: 'ledger-test',
      origin: 'live',
      outcome: 'succeeded',
      consequence: 'effect_possible',
      tool_name: 'send_email',
    })
  })

  it('indexes one receipt exactly once when an observation converges', async () => {
    const f = await fixture()
    const input = {
      runId: f.runId,
      toolCallId: 'call-1',
      toolName: 'send_email',
      observationKey: 'obs-1',
      kind: 'outcome_observed',
      outcome: 'succeeded',
      consequence: 'effect_possible',
      authorityKind: 'runtime',
      authorityRef: 'runtime:test',
    } as const
    const first = await f.receipts.observe(input)
    const replay = await f.receipts.observe(input)

    expect(replay.receiptId).toBe(first.receiptId)
    expect(f.rows()).toHaveLength(1)
  })

  it('assigns a gap-free install-wide sequence across runs and families', async () => {
    const f = await fixture()
    for (const [index, tool] of ['a_tool', 'b_tool', 'c_tool'].entries()) {
      await f.receipts.observe({
        runId: f.runId,
        toolCallId: `call-${index}`,
        toolName: tool,
        observationKey: `obs-${index}`,
        kind: 'outcome_observed',
        outcome: 'succeeded',
        consequence: 'output_observed',
        authorityKind: 'runtime',
        authorityRef: 'runtime:test',
      })
    }
    expect(f.rows().map((row) => row.ledger_seq)).toEqual([1, 2, 3])
  })

  it('reads scope from the run, so a caller cannot file evidence elsewhere', async () => {
    const f = await fixture('real-profile')
    appendActivityLedgerRow(f.state.rawDbHandle, {
      family: 'egress',
      receiptId: randomUUID(),
      runId: f.runId,
      occurredAt: 200,
    })
    // No profile/thread input exists to spoof; scope comes from gateway_runs.
    expect(f.rows()[0]).toMatchObject({
      profile_id: 'real-profile',
      thread_id: f.threadId,
    })
  })

  it('refuses to index a receipt for a run that does not exist', async () => {
    const f = await fixture()
    expect(() => appendActivityLedgerRow(f.state.rawDbHandle, {
      family: 'effect',
      receiptId: randomUUID(),
      runId: randomUUID(),
      occurredAt: 200,
    })).toThrow(ActivityLedgerError)
    expect(f.rows()).toHaveLength(0)
  })

  it('rejects an unknown family, malformed receipt id and out-of-range values', async () => {
    const f = await fixture()
    const base = { receiptId: randomUUID(), runId: f.runId, occurredAt: 200 }
    const cases = [
      { ...base, family: 'wire_transfer' as never },
      { ...base, family: 'effect' as const, receiptId: 'not-a-uuid' },
      { ...base, family: 'effect' as const, occurredAt: -1 },
      { ...base, family: 'effect' as const, occurredAt: 1.5 },
      { ...base, family: 'effect' as const, outcome: 'Succeeded' },
      { ...base, family: 'effect' as const, outcome: 'x'.repeat(41) },
      { ...base, family: 'effect' as const, toolName: 'tool name with spaces' },
    ]
    for (const input of cases) {
      expect(() => appendActivityLedgerRow(f.state.rawDbHandle, input))
        .toThrow(ActivityLedgerError)
    }
    expect(f.rows()).toHaveLength(0)
  })

  it('is immutable evidence — a row cannot be rewritten', async () => {
    const f = await fixture()
    appendActivityLedgerRow(f.state.rawDbHandle, {
      family: 'effect',
      receiptId: randomUUID(),
      runId: f.runId,
      occurredAt: 200,
    })
    expect(() => f.state.rawDbHandle.prepare(
      'UPDATE activity_ledger SET profile_id = ? WHERE ledger_seq = 1',
    ).run('other-profile')).toThrow(/immutable/)
  })

  it('indexes at most one row per receipt id within a family', async () => {
    const f = await fixture()
    const receiptId = randomUUID()
    appendActivityLedgerRow(f.state.rawDbHandle, {
      family: 'effect', receiptId, runId: f.runId, occurredAt: 200,
    })
    expect(() => appendActivityLedgerRow(f.state.rawDbHandle, {
      family: 'effect', receiptId, runId: f.runId, occurredAt: 201,
    })).toThrow()
    expect(f.rows()).toHaveLength(1)
  })
  it('fails the receipt write when the receipt cannot be indexed', async () => {
    // The whole point of appending inside the receipt's transaction is that a
    // receipt can never exist unindexed. Make indexing impossible and prove
    // the evidence write fails closed rather than landing un-findable.
    const f = await fixture()
    f.state.rawDbHandle.exec('ALTER TABLE activity_ledger RENAME TO activity_ledger_moved')

    // The SQLite store is synchronous internally, so this throws rather than
    // returning a rejected promise; both are failures, neither is a write.
    expect(() => f.receipts.observe({
      runId: f.runId,
      toolCallId: 'call-1',
      toolName: 'send_email',
      observationKey: 'obs-1',
      kind: 'outcome_observed',
      outcome: 'succeeded',
      consequence: 'effect_possible',
      authorityKind: 'runtime',
      authorityRef: 'runtime:test',
    })).toThrow()

    const receipts = f.state.rawDbHandle.prepare(
      'SELECT COUNT(*) AS value FROM effect_receipts',
    ).pluck().get() as number
    expect(receipts).toBe(0)
    const identities = f.state.rawDbHandle.prepare(
      'SELECT COUNT(*) AS value FROM effect_identities',
    ).pluck().get() as number
    expect(identities).toBe(0)
  })

  it('rolls the index row back with a failed receipt transaction', async () => {
    const f = await fixture()
    const db = f.state.rawDbHandle
    expect(() => db.transaction(() => {
      appendActivityLedgerRow(db, {
        family: 'effect',
        receiptId: randomUUID(),
        runId: f.runId,
        occurredAt: 200,
      })
      throw new Error('receipt write failed after indexing')
    })()).toThrow('receipt write failed after indexing')
    expect(f.rows()).toHaveLength(0)
  })
  it('indexes every wired family under one install-wide sequence', async () => {
    // The point of the ledger is that ONE cursor pages every evidence family.
    // This asserts the families share a sequence rather than each keeping its
    // own, which is what makes a single cross-run query possible.
    const f = await fixture()
    const db = f.state.rawDbHandle
    await f.receipts.observe({
      runId: f.runId,
      toolCallId: 'call-1',
      toolName: 'send_email',
      observationKey: 'obs-1',
      kind: 'outcome_observed',
      outcome: 'succeeded',
      consequence: 'effect_possible',
      authorityKind: 'runtime',
      authorityRef: 'runtime:test',
    })
    for (const family of ['egress', 'skill_activation', 'reversal'] as const) {
      appendActivityLedgerRow(db, {
        family,
        receiptId: randomUUID(),
        runId: f.runId,
        occurredAt: 300,
      })
    }
    const rows = f.rows()
    expect(rows.map((row) => row.ledger_seq)).toEqual([1, 2, 3, 4])
    expect(rows.map((row) => row.family)).toEqual([
      'effect', 'egress', 'skill_activation', 'reversal',
    ])
    // Every row carries the scope needed to answer "what happened on this
    // profile / thread" without joining back to the run.
    for (const row of rows) {
      expect(row.profile_id).toBe('ledger-test')
      expect(row.thread_id).toBe(f.threadId)
      expect(row.origin).toBe('live')
    }
  })
})

describe('activity ledger read', () => {
  async function seeded(count: number): Promise<Awaited<ReturnType<typeof fixture>>> {
    const f = await fixture()
    for (let index = 0; index < count; index += 1) {
      appendActivityLedgerRow(f.state.rawDbHandle, {
        family: index % 2 === 0 ? 'effect' : 'egress',
        receiptId: randomUUID(),
        runId: f.runId,
        occurredAt: 1000 + index,
      })
    }
    return f
  }

  it('pages newest-first and walks the whole trail exactly once', async () => {
    const f = await seeded(25)
    const seen: number[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page: ReturnType<typeof listActivityLedger> =
        listActivityLedger(f.state.rawDbHandle, {}, { limit: 10, cursor })
      seen.push(...page.items.map((item) => item.ledgerSeq))
      cursor = page.nextCursor
      pages += 1
    } while (cursor !== null && pages < 10)

    expect(pages).toBe(3)
    expect(seen).toEqual([...Array(25)].map((_, i) => 25 - i))
    expect(new Set(seen).size).toBe(25)
  })

  it('keeps a page stable when rows are appended mid-pagination', async () => {
    // The reason for descending ledger_seq with a strict `<` cursor: an append
    // lands above every cursor already issued, so it can neither appear inside
    // a page the reader has passed nor push a row across a boundary.
    const f = await seeded(10)
    const first = listActivityLedger(f.state.rawDbHandle, {}, { limit: 5, cursor: null })
    expect(first.items.map((i) => i.ledgerSeq)).toEqual([10, 9, 8, 7, 6])

    for (let index = 0; index < 5; index += 1) {
      appendActivityLedgerRow(f.state.rawDbHandle, {
        family: 'reversal',
        receiptId: randomUUID(),
        runId: f.runId,
        occurredAt: 9000 + index,
      })
    }

    const second = listActivityLedger(
      f.state.rawDbHandle, {}, { limit: 5, cursor: first.nextCursor },
    )
    expect(second.items.map((i) => i.ledgerSeq)).toEqual([5, 4, 3, 2, 1])
    expect(second.nextCursor).toBeNull()
  })

  it('reports no next cursor when the last page is exactly full', async () => {
    const f = await seeded(10)
    const page = listActivityLedger(f.state.rawDbHandle, {}, { limit: 10, cursor: null })
    expect(page.items).toHaveLength(10)
    expect(page.nextCursor).toBeNull()
  })

  it('rejects a malformed or foreign cursor instead of restarting the trail', async () => {
    const f = await seeded(3)
    for (const cursor of ['0', '-1', '1.5', 'abc', '', ' 1', '01', "1; DROP TABLE activity_ledger"]) {
      expect(() => listActivityLedger(f.state.rawDbHandle, {}, { limit: 10, cursor }))
        .toThrow(ActivityLedgerError)
    }
    // The table is still there, and a valid cursor still works.
    expect(listActivityLedger(f.state.rawDbHandle, {}, { limit: 10, cursor: null }).items)
      .toHaveLength(3)
  })

  it('rejects an out-of-range limit and an unknown family', async () => {
    const f = await seeded(3)
    for (const limit of [0, -1, 101, 1.5, Number.NaN]) {
      expect(() => listActivityLedger(f.state.rawDbHandle, {}, { limit, cursor: null }))
        .toThrow(ActivityLedgerError)
    }
    expect(() => listActivityLedger(
      f.state.rawDbHandle, { family: 'wire_transfer' as never }, { limit: 10, cursor: null },
    )).toThrow(ActivityLedgerError)
  })

  it('filters by family, run and time range without leaking neighbours', async () => {
    const f = await seeded(6)
    const byFamily = listActivityLedger(
      f.state.rawDbHandle, { family: 'egress' }, { limit: 50, cursor: null },
    )
    expect(byFamily.items.every((item) => item.family === 'egress')).toBe(true)
    expect(byFamily.items).toHaveLength(3)

    const windowed = listActivityLedger(
      f.state.rawDbHandle, { since: 1002, until: 1003 }, { limit: 50, cursor: null },
    )
    expect(windowed.items.map((item) => item.occurredAt)).toEqual([1003, 1002])

    const otherRun = listActivityLedger(
      f.state.rawDbHandle, { runId: randomUUID() }, { limit: 50, cursor: null },
    )
    expect(otherRun.items).toHaveLength(0)
  })

  it('confines a profile-scoped query to that profile', async () => {
    // This is the seam a delegated principal is enforced through: the caller
    // never supplies the profile, the authorization layer does.
    const f = await seeded(4)
    const db = f.state.rawDbHandle
    const otherThread = await f.state.createThread('other-profile')
    const otherRun = randomUUID()
    db.prepare(`
      INSERT INTO gateway_runs (
        id, thread_id, workspace_id, profile_id, model, timeout_ms, status,
        start_seq, accepted_at, updated_at, consequence
      ) VALUES (?, ?, NULL, 'other-profile', 'test:model', 60000, 'running', 0, 100, 100, 'none_observed')
    `).run(otherRun, otherThread.id)
    appendActivityLedgerRow(db, {
      family: 'effect', receiptId: randomUUID(), runId: otherRun, occurredAt: 5000,
    })

    expect(listActivityLedger(db, {}, { limit: 50, cursor: null }).items).toHaveLength(5)
    const mine = listActivityLedger(db, { profileId: 'ledger-test' }, { limit: 50, cursor: null })
    expect(mine.items).toHaveLength(4)
    expect(mine.items.every((item) => item.profileId === 'ledger-test')).toBe(true)
    const theirs = listActivityLedger(db, { profileId: 'other-profile' }, { limit: 50, cursor: null })
    expect(theirs.items).toHaveLength(1)
  })

  it('reports ordering provenance alongside every page', async () => {
    const f = await seeded(2)
    const page = listActivityLedger(f.state.rawDbHandle, {}, { limit: 10, cursor: null })
    // Live rows only: nothing here was reconstructed from timestamps.
    expect(page.coverage).toEqual({
      reconstructedThrough: 0,
      reconstructedCount: 0,
      observedFrom: 1,
    })
    expect(page.items.every((item) => item.origin === 'live')).toBe(true)
  })

  it('decodes a cursor without coercing an invalid one to a valid page', () => {
    expect(decodeActivityLedgerCursor(null)).toBeNull()
    expect(decodeActivityLedgerCursor('42')).toBe(42)
    expect(() => decodeActivityLedgerCursor('0')).toThrow(ActivityLedgerError)
    expect(() => decodeActivityLedgerCursor('9'.repeat(20))).toThrow(ActivityLedgerError)
  })
})
