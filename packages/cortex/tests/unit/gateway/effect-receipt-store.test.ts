import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EffectReceiptStore,
  EffectReceiptStoreError,
} from '../../../src/gateway/effect-receipt-store.js'
import { GatewayRunStore } from '../../../src/gateway/run-store.js'
import { GatewayState } from '../../../src/gateway/state.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ownware-effect-receipts-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function fixture(): Promise<{
  readonly state: GatewayState
  readonly runs: GatewayRunStore
  readonly receipts: EffectReceiptStore
  readonly runId: string
}> {
  const state = new GatewayState(join(dir, 'effects.db'))
  const thread = await state.createThread('effect-test')
  const runs = new GatewayRunStore(state.rawDbHandle, 'effect-test-secret')
  const run = runs.create({
    threadId: thread.id,
    profileId: 'effect-test',
    model: 'test:model',
    timeoutMs: 60_000,
    startSeq: 0,
  }, 100)
  runs.markRunning(run.runId, 101)
  return {
    state,
    runs,
    receipts: new EffectReceiptStore(state.rawDbHandle),
    runId: run.runId,
  }
}

describe('immutable effect receipts', () => {
  it('keeps one stable effect identity, appends lifecycle evidence and paginates', async () => {
    const { state, runs, receipts, runId } = await fixture()
    try {
      const intent = receipts.observe({
        runId,
        toolCallId: 'call_1',
        toolName: 'send_message',
        observationKey: 'runtime:1',
        kind: 'intent_observed',
        outcome: 'pending',
        consequence: 'none_observed',
        authorityKind: 'runtime',
        authorityRef: 'runtime.tool_call.start',
        runtimeSequence: 1,
      }, 110)
      const repeated = receipts.observe({
        runId,
        toolCallId: 'call_1',
        toolName: 'send_message',
        observationKey: 'runtime:1',
        kind: 'intent_observed',
        outcome: 'pending',
        consequence: 'none_observed',
        authorityKind: 'runtime',
        authorityRef: 'runtime.tool_call.start',
        runtimeSequence: 1,
      }, 999)
      expect(repeated).toEqual(intent)

      const outcome = receipts.observe({
        runId,
        toolCallId: 'call_1',
        toolName: 'send_message',
        observationKey: 'runtime:2',
        kind: 'authority_confirmed',
        outcome: 'succeeded',
        consequence: 'effect_confirmed',
        authorityKind: 'effect_observer',
        authorityRef: 'connector.message.lookup',
        runtimeSequence: 2,
      }, 120)
      expect(outcome.effectId).toBe(intent.effectId)
      expect(runs.get(runId)).toMatchObject({
        consequence: 'effect_confirmed',
        updatedAt: 120,
      })

      const first = receipts.listForRun(runId, { limit: 1, cursor: null })
      expect(first.items).toEqual([intent])
      expect(first.nextCursor).toBe(intent.receiptId)
      const second = receipts.listForRun(runId, {
        limit: 1,
        cursor: first.nextCursor,
      })
      expect(second.items).toEqual([outcome])
      expect(second.nextCursor).toBeNull()

      expect(() => state.rawDbHandle.prepare(`
        UPDATE effect_receipts SET outcome = 'unknown' WHERE receipt_id = ?
      `).run(intent.receiptId)).toThrow(/immutable/)
      expect(() => state.rawDbHandle.prepare(`
        DELETE FROM effect_identities WHERE effect_id = ?
      `).run(intent.effectId)).toThrow(/immutable/)
    } finally {
      state.close()
    }
  })

  it('rejects conflicting replay and rolls back identity plus run consequence atomically', async () => {
    const { state, runs, receipts, runId } = await fixture()
    try {
      receipts.observe({
        runId,
        toolCallId: 'call_conflict',
        toolName: 'send_message',
        observationKey: 'runtime:1',
        kind: 'intent_observed',
        outcome: 'pending',
        consequence: 'none_observed',
        authorityKind: 'runtime',
        authorityRef: 'runtime.tool_call.start',
        runtimeSequence: 1,
      }, 110)
      expect(() => receipts.observe({
        runId,
        toolCallId: 'call_conflict',
        toolName: 'send_message',
        observationKey: 'runtime:1',
        kind: 'outcome_observed',
        outcome: 'succeeded',
        consequence: 'effect_possible',
        authorityKind: 'runtime',
        authorityRef: 'runtime.tool_call.end',
        runtimeSequence: 1,
      }, 120)).toThrowError(expect.objectContaining({ code: 'observation_conflict' }))

      state.rawDbHandle.exec(`
        CREATE TRIGGER effect_receipt_test_reject
        BEFORE INSERT ON effect_receipts
        BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END;
      `)
      expect(() => receipts.observe({
        runId,
        toolCallId: 'call_atomic',
        toolName: 'send_message',
        observationKey: 'runtime:2',
        kind: 'authority_confirmed',
        outcome: 'succeeded',
        consequence: 'effect_confirmed',
        authorityKind: 'effect_observer',
        authorityRef: 'connector.message.lookup',
        runtimeSequence: 2,
      }, 130)).toThrow(/synthetic receipt failure/)
      expect(state.rawDbHandle.prepare(`
        SELECT COUNT(*) FROM effect_identities WHERE tool_call_id = 'call_atomic'
      `).pluck().get()).toBe(0)
      expect(runs.get(runId)?.consequence).toBe('none_observed')
    } finally {
      state.close()
    }
  })

  it('rejects unknown receipt vocabulary before storage', async () => {
    const { state, receipts, runId } = await fixture()
    try {
      const base = {
        runId,
        toolCallId: 'call_unknown_vocabulary',
        toolName: 'future_tool',
        observationKey: 'runtime:1',
        kind: 'intent_observed',
        outcome: 'pending',
        consequence: 'none_observed',
        authorityKind: 'runtime',
        authorityRef: 'runtime.tool_call.start',
      } as const
      for (const invalid of [
        { ...base, kind: 'future_kind' },
        { ...base, outcome: 'maybe' },
        { ...base, authorityKind: 'provider_claim' },
        { ...base, kind: 'reconciliation', authorityKind: 'reconciler' },
        {
          ...base,
          kind: 'authority_confirmed',
          outcome: 'succeeded',
          consequence: 'effect_possible',
          authorityKind: 'effect_observer',
        },
        {
          ...base,
          kind: 'outcome_observed',
          outcome: 'succeeded',
          consequence: 'effect_confirmed',
          authorityKind: 'effect_observer',
        },
      ]) {
        expect(() => receipts.observe(invalid as never)).toThrowError(
          expect.objectContaining({ code: 'invalid_input' }),
        )
      }
      expect(receipts.listForRun(runId, { limit: 10, cursor: null }).items).toEqual([])
    } finally {
      state.close()
    }
  })

  it('turns a pending action into explicit uncertainty once and never invents confirmation', async () => {
    const { state, runs, receipts, runId } = await fixture()
    try {
      receipts.observe({
        runId,
        toolCallId: 'call_pending',
        toolName: 'unknown_adapter_tool',
        observationKey: 'runtime:1',
        kind: 'intent_observed',
        outcome: 'pending',
        consequence: 'none_observed',
        authorityKind: 'runtime',
        authorityRef: 'runtime.tool_call.start',
        runtimeSequence: 1,
      }, 110)
      expect(receipts.markPendingUnknownForRun(
        runId,
        'runtime.terminal_without_outcome',
        120,
      )).toBe(1)
      expect(receipts.markPendingUnknownForRun(
        runId,
        'runtime.terminal_without_outcome',
        130,
      )).toBe(0)
      expect(receipts.listForRun(runId, { limit: 10, cursor: null }).items.at(-1))
        .toMatchObject({
          kind: 'reconciliation',
          outcome: 'unknown',
          consequence: 'effect_possible',
          authorityKind: 'reconciler',
        })
      expect(runs.get(runId)?.consequence).toBe('effect_possible')

      expect(() => receipts.observe({
        runId,
        toolCallId: 'call_invalid_confirmation',
        toolName: 'unknown_adapter_tool',
        observationKey: 'runtime:2',
        kind: 'outcome_observed',
        outcome: 'succeeded',
        consequence: 'effect_confirmed',
        authorityKind: 'runtime',
        authorityRef: 'runtime.tool_call.end',
        runtimeSequence: 2,
      })).toThrowError(EffectReceiptStoreError)
    } finally {
      state.close()
    }
  })
})
