import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assembleJobReceipt, JobReceiptError } from '../../../src/gateway/job-receipt.js'
import { EffectReceiptStore } from '../../../src/gateway/effect-receipt-store.js'
import { GatewayRunStore } from '../../../src/gateway/run-store.js'
import { GatewayState } from '../../../src/gateway/state.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ownware-job-receipt-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const state = new GatewayState(join(dir, 'jobs.db'))
  const thread = await state.createThread('job-test')
  const runs = new GatewayRunStore(state.rawDbHandle, 'job-secret')
  const run = runs.create({
    threadId: thread.id,
    profileId: 'job-test',
    model: 'test:model',
    timeoutMs: 60_000,
    startSeq: 0,
  }, 100)
  runs.markRunning(run.runId, 101)
  return {
    state, runs, runId: run.runId,
    receipts: new EffectReceiptStore(state.rawDbHandle),
    db: state.rawDbHandle,
  }
}

type F = Awaited<ReturnType<typeof fixture>>

async function observe(
  f: F, toolCallId: string, toolName: string,
  kind: 'intent_observed' | 'outcome_observed' | 'authority_confirmed',
  outcome: 'pending' | 'succeeded' | 'failed' | 'denied',
  consequence: 'none_observed' | 'output_observed' | 'effect_possible' | 'effect_confirmed',
  at: number,
) {
  return f.receipts.observe({
    runId: f.runId,
    toolCallId,
    toolName,
    observationKey: `${toolCallId}-${kind}-${outcome}`,
    kind,
    outcome,
    consequence,
    authorityKind: kind === 'authority_confirmed' ? 'effect_observer' : 'runtime',
    authorityRef: 'runtime:test',
  }, at)
}

describe('job receipt', () => {
  it('reports an empty but honest receipt for a run with no observed actions', async () => {
    const f = await fixture()
    const receipt = assembleJobReceipt(f.db, f.runId)
    expect(receipt.actions).toHaveLength(0)
    expect(receipt.totals.observedActions).toBe(0)
    // No actions observed is not a claim that nothing happened.
    expect(receipt.consequence).toBe('none_observed')
  })

  it('aggregates by action, not by receipt', async () => {
    // One action emits several receipts as it advances. Counting receipts
    // would overstate how much the job did.
    const f = await fixture()
    await observe(f, 'call-1', 'send_email', 'intent_observed', 'pending', 'none_observed', 100)
    await observe(f, 'call-1', 'send_email', 'outcome_observed', 'succeeded', 'output_observed', 200)

    const receipt = assembleJobReceipt(f.db, f.runId)
    expect(receipt.actions).toHaveLength(1)
    expect(receipt.totals.observedActions).toBe(1)
    expect(receipt.actions[0]).toMatchObject({
      toolName: 'send_email',
      outcome: 'succeeded',
      disposition: 'completed',
      receiptCount: 2,
      firstObservedAt: 100,
      lastObservedAt: 200,
    })
  })

  it('keeps the strongest consequence, not the latest one', async () => {
    // Consequence only advances. An action that reached effect_possible never
    // becomes safe again, whatever a later receipt says.
    const f = await fixture()
    await observe(f, 'call-1', 'charge_card', 'intent_observed', 'pending', 'none_observed', 100)
    await observe(f, 'call-1', 'charge_card', 'outcome_observed', 'failed', 'effect_possible', 200)

    const receipt = assembleJobReceipt(f.db, f.runId)
    expect(receipt.actions[0]!.consequence).toBe('effect_possible')
    // Failure is a completed observation, NOT evidence that nothing happened.
    expect(receipt.actions[0]!.disposition).toBe('completed')
    expect(receipt.actions[0]!.outcome).toBe('failed')
    expect(receipt.totals.effectPossibleOrStronger).toBe(1)
  })

  it('counts a failed and a denied action as observed, never as nothing-happened', async () => {
    const f = await fixture()
    await observe(f, 'call-1', 'send_email', 'outcome_observed', 'failed', 'effect_possible', 100)
    await observe(f, 'call-2', 'delete_file', 'outcome_observed', 'denied', 'none_observed', 200)

    const receipt = assembleJobReceipt(f.db, f.runId)
    expect(receipt.totals).toMatchObject({
      observedActions: 2, completed: 2, indeterminate: 0, failed: 1, denied: 1, succeeded: 0,
    })
    // The denied one never reached the world; the failed one may have.
    expect(receipt.totals.effectPossibleOrStronger).toBe(1)
  })

  it('reports an unfinished action as indeterminate after reconciliation', async () => {
    const f = await fixture()
    await observe(f, 'call-1', 'send_email', 'intent_observed', 'pending', 'none_observed', 100)
    await f.receipts.markPendingUnknownForRun(f.runId, 'runtime:test', 300)

    const receipt = assembleJobReceipt(f.db, f.runId)
    expect(receipt.actions[0]).toMatchObject({
      outcome: 'unknown',
      consequence: 'effect_possible',
      disposition: 'indeterminate',
    })
    expect(receipt.totals).toMatchObject({ completed: 0, indeterminate: 1 })
  })

  it('cannot separate interrupted from never-dispatched, and does not pretend to', async () => {
    // Reconciliation collapses both into unknown/effect_possible. A three-part
    // stop account would have to invent the third bucket, so this projection
    // reports two and the sheet must say two.
    const f = await fixture()
    await observe(f, 'call-1', 'send_email', 'outcome_observed', 'succeeded', 'output_observed', 100)
    await observe(f, 'call-2', 'send_email', 'intent_observed', 'pending', 'none_observed', 150)
    await observe(f, 'call-3', 'send_email', 'intent_observed', 'pending', 'none_observed', 160)
    await f.receipts.markPendingUnknownForRun(f.runId, 'runtime:test', 300)

    const receipt = assembleJobReceipt(f.db, f.runId)
    expect(receipt.totals).toMatchObject({ observedActions: 3, completed: 1, indeterminate: 2 })
    const dispositions = new Set(
      receipt.actions.filter((a) => a.disposition === 'indeterminate').map((a) => a.outcome))
    // Both unfinished actions look identical — that is the honest answer.
    expect([...dispositions]).toEqual(['unknown'])
  })

  it('records an authority-confirmed effect distinctly from a merely possible one', async () => {
    const f = await fixture()
    await observe(f, 'call-1', 'remember', 'authority_confirmed', 'succeeded', 'effect_confirmed', 100)
    await observe(f, 'call-2', 'send_email', 'outcome_observed', 'succeeded', 'effect_possible', 200)

    const receipt = assembleJobReceipt(f.db, f.runId)
    expect(receipt.totals.effectConfirmed).toBe(1)
    expect(receipt.totals.effectPossibleOrStronger).toBe(2)
  })

  it('orders actions by when they were first observed', async () => {
    const f = await fixture()
    await observe(f, 'call-a', 'first_tool', 'outcome_observed', 'succeeded', 'output_observed', 100)
    await observe(f, 'call-b', 'second_tool', 'outcome_observed', 'succeeded', 'output_observed', 200)
    await observe(f, 'call-c', 'third_tool', 'outcome_observed', 'succeeded', 'output_observed', 300)

    expect(assembleJobReceipt(f.db, f.runId).actions.map((a) => a.toolName))
      .toEqual(['first_tool', 'second_tool', 'third_tool'])
  })

  it('refuses a run it has no record of instead of returning an empty receipt', async () => {
    const f = await fixture()
    expect(() => assembleJobReceipt(f.db, randomUUID())).toThrow(JobReceiptError)
  })
  it('reports a stop as the same two buckets, not a third', async () => {
    // "Kept / cut mid-way" is the completed / indeterminate split already
    // computed. The stop flag only lets a surface phrase it as a stop.
    const f = await fixture()
    await observe(f, 'call-1', 'draft_email', 'outcome_observed', 'succeeded', 'output_observed', 100)
    await observe(f, 'call-2', 'draft_email', 'outcome_observed', 'succeeded', 'output_observed', 110)
    await observe(f, 'call-3', 'draft_email', 'intent_observed', 'pending', 'none_observed', 120)
    f.runs.requestCancel(f.runId, 200)
    await f.receipts.markPendingUnknownForRun(f.runId, 'runtime:test', 300)

    const receipt = assembleJobReceipt(f.db, f.runId)
    expect(receipt.stopRequested).toBe(true)
    expect(receipt.stopRequestedAt).toBe(200)
    expect(receipt.totals).toMatchObject({ observedActions: 3, completed: 2, indeterminate: 1 })
  })

  it('does not mark a run stopped when it simply finished', async () => {
    const f = await fixture()
    await observe(f, 'call-1', 'read_file', 'outcome_observed', 'succeeded', 'output_observed', 100)
    const receipt = assembleJobReceipt(f.db, f.runId)
    expect(receipt.stopRequested).toBe(false)
    expect(receipt.stopRequestedAt).toBeNull()
  })
})
