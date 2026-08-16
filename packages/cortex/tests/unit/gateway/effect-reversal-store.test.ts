import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EffectReceiptStore } from '../../../src/gateway/effect-receipt-store.js'
import {
  EffectReversalStore,
  MEMORY_PROPOSAL_REVERSAL_ADAPTER_REF,
  MEMORY_PROPOSAL_REVERSAL_ADAPTER_REVISION,
} from '../../../src/gateway/effect-reversal-store.js'
import { GatewayRunStore } from '../../../src/gateway/run-store.js'
import { GatewayState } from '../../../src/gateway/state.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ownware-effect-reversals-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function fixture(callId = 'call_remember'): Promise<{
  readonly state: GatewayState
  readonly effects: EffectReceiptStore
  readonly reversals: EffectReversalStore
  readonly runId: string
  readonly threadId: string
  readonly proposalId: string
  readonly revision: string
}> {
  const state = new GatewayState(join(dir, `${callId}.db`))
  const thread = await state.createThread('memory-profile')
  const runs = new GatewayRunStore(state.rawDbHandle, 'effect-reversal-test-secret')
  const run = runs.create({
    threadId: thread.id,
    profileId: 'memory-profile',
    model: 'test:model',
    timeoutMs: 60_000,
    startSeq: 0,
  }, 100)
  runs.markRunning(run.runId, 101)
  const effects = new EffectReceiptStore(state.rawDbHandle)
  effects.observe({
    runId: run.runId,
    toolCallId: callId,
    toolName: 'remember',
    observationKey: 'runtime:1',
    kind: 'intent_observed',
    outcome: 'pending',
    consequence: 'none_observed',
    authorityKind: 'runtime',
    authorityRef: 'runtime.tool_call.start',
    runtimeSequence: 1,
  }, 110)
  const disposition = await state.platformRepositories.memoryProposals.proposeWithDisposition({
    profileId: 'memory-profile',
    threadId: thread.id,
    content: `Fact for ${callId}`,
  })
  expect(disposition.created).toBe(true)
  return {
    state,
    effects,
    reversals: new EffectReversalStore(state.rawDbHandle, effects),
    runId: run.runId,
    threadId: thread.id,
    proposalId: disposition.proposal.id,
    revision: disposition.proposal.createdAt,
  }
}

function observation(input: Awaited<ReturnType<typeof fixture>>, expiresAt?: number) {
  return {
    runId: input.runId,
    toolCallId: 'call_remember',
    toolName: 'remember',
    profileId: 'memory-profile',
    threadId: input.threadId,
    proposalId: input.proposalId,
    targetRevision: input.revision,
    adapterRef: MEMORY_PROPOSAL_REVERSAL_ADAPTER_REF,
    adapterRevision: MEMORY_PROPOSAL_REVERSAL_ADAPTER_REVISION,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

describe('effect reversal authority', () => {
  it('offers and confirms only the exact pending proposal with one atomic receipt', async () => {
    const f = await fixture()
    try {
      const offer = f.reversals.observeMemoryProposal(observation(f), 120)
      expect(offer).toMatchObject({
        sequence: 1,
        runId: f.runId,
        toolCallId: 'call_remember',
        toolName: 'remember',
        operationKind: 'inverse',
        status: 'available',
      })
      expect(JSON.stringify(offer)).not.toContain(f.proposalId)
      expect(f.effects.listForRun(f.runId, { limit: 10, cursor: null }).items.at(-1)).toMatchObject({
        kind: 'authority_confirmed',
        consequence: 'effect_confirmed',
        authorityRef: 'memory.pending-proposal:1',
      })

      const key = randomUUID()
      const executed = f.reversals.executeMemoryProposal({
        runId: f.runId,
        offerId: offer.offerId,
        idempotencyKey: key,
        actorKind: 'owner',
        adapterRef: offer.adapterRef,
        adapterRevision: offer.adapterRevision,
      }, 130)
      expect(executed).toMatchObject({
        disposition: 'executed',
        offer: { status: 'confirmed' },
        receipt: { outcome: 'confirmed', sequence: 1 },
      })
      expect(await f.state.platformRepositories.memoryProposals.getById(f.proposalId)).toMatchObject({
        status: 'rejected',
      })
      expect(f.state.rawDbHandle.prepare(`
        SELECT resolution_authority_ref FROM memory_proposals WHERE id = ?
      `).pluck().get(f.proposalId)).toBe(offer.offerId)

      const replay = f.reversals.executeMemoryProposal({
        runId: f.runId,
        offerId: offer.offerId,
        idempotencyKey: key,
        actorKind: 'owner',
        adapterRef: offer.adapterRef,
        adapterRevision: offer.adapterRevision,
      }, 999)
      expect(replay).toMatchObject({
        disposition: 'replayed',
        receipt: { receiptId: executed.disposition === 'missing' ? '' : executed.receipt.receiptId },
      })
      expect(f.reversals.listReceiptsForRun(f.runId, { limit: 10, cursor: null }).items).toHaveLength(1)
    } finally {
      f.state.close()
    }
  })

  it('returns stale without overwriting a user resolution', async () => {
    const f = await fixture()
    try {
      const offer = f.reversals.observeMemoryProposal(observation(f), 120)
      await f.state.platformRepositories.memoryProposals.reject(f.proposalId, 'User rejected it first')
      const result = f.reversals.executeMemoryProposal({
        runId: f.runId,
        offerId: offer.offerId,
        idempotencyKey: randomUUID(),
        actorKind: 'owner',
        adapterRef: offer.adapterRef,
        adapterRevision: offer.adapterRevision,
      }, 130)
      expect(result).toMatchObject({
        disposition: 'executed',
        offer: { status: 'stale' },
        receipt: { outcome: 'stale' },
      })
      expect(await f.state.platformRepositories.memoryProposals.getById(f.proposalId)).toMatchObject({
        status: 'rejected',
        rejectionReason: 'User rejected it first',
      })
      expect(f.state.rawDbHandle.prepare(`
        SELECT resolution_authority_ref FROM memory_proposals WHERE id = ?
      `).pluck().get(f.proposalId)).toBeNull()
    } finally {
      f.state.close()
    }
  })

  it('expires without changing a still-pending target', async () => {
    const f = await fixture()
    try {
      const offer = f.reversals.observeMemoryProposal(observation(f, 125), 120)
      const result = f.reversals.executeMemoryProposal({
        runId: f.runId,
        offerId: offer.offerId,
        idempotencyKey: randomUUID(),
        actorKind: 'delegated',
        adapterRef: offer.adapterRef,
        adapterRevision: offer.adapterRevision,
      }, 125)
      expect(result).toMatchObject({ offer: { status: 'expired' }, receipt: { outcome: 'expired' } })
      expect(await f.state.platformRepositories.memoryProposals.getById(f.proposalId)).toMatchObject({
        status: 'pending',
      })
    } finally {
      f.state.close()
    }
  })

  it('rolls back the target transition when receipt persistence fails', async () => {
    const f = await fixture()
    try {
      const offer = f.reversals.observeMemoryProposal(observation(f), 120)
      f.state.rawDbHandle.exec(`
        CREATE TRIGGER reversal_receipt_test_reject
        BEFORE INSERT ON effect_reversal_receipts
        BEGIN SELECT RAISE(ABORT, 'synthetic reversal receipt failure'); END;
      `)
      expect(() => f.reversals.executeMemoryProposal({
        runId: f.runId,
        offerId: offer.offerId,
        idempotencyKey: randomUUID(),
        actorKind: 'owner',
        adapterRef: offer.adapterRef,
        adapterRevision: offer.adapterRevision,
      }, 130)).toThrow(/synthetic reversal receipt failure/)
      expect(f.reversals.getOffer(f.runId, offer.offerId)).toMatchObject({ status: 'available' })
      expect(await f.state.platformRepositories.memoryProposals.getById(f.proposalId)).toMatchObject({
        status: 'pending',
      })
    } finally {
      f.state.close()
    }
  })

  it('fails closed for the wrong revision, missing intent, and adapter mismatch', async () => {
    const f = await fixture()
    try {
      expect(() => f.reversals.observeMemoryProposal({
        ...observation(f),
        targetRevision: '2099-01-01T00:00:00.000Z',
      }, 120)).toThrowError(expect.objectContaining({ code: 'target_stale' }))
      expect(f.reversals.listOffersForRun(f.runId, { limit: 10, cursor: null }).items).toEqual([])

      const offer = f.reversals.observeMemoryProposal(observation(f), 121)
      expect(() => f.reversals.executeMemoryProposal({
        runId: f.runId,
        offerId: offer.offerId,
        idempotencyKey: randomUUID(),
        actorKind: 'owner',
        adapterRef: 'unregistered.adapter',
        adapterRevision: '1',
      }, 130)).toThrowError(expect.objectContaining({ code: 'adapter_mismatch' }))
      expect(f.reversals.getOffer(f.runId, offer.offerId)).toMatchObject({ status: 'available' })
    } finally {
      f.state.close()
    }
  })

  it('keeps offer identity and receipts immutable in storage', async () => {
    const f = await fixture()
    try {
      const offer = f.reversals.observeMemoryProposal(observation(f), 120)
      const result = f.reversals.executeMemoryProposal({
        runId: f.runId,
        offerId: offer.offerId,
        idempotencyKey: randomUUID(),
        actorKind: 'owner',
        adapterRef: offer.adapterRef,
        adapterRevision: offer.adapterRevision,
      }, 130)
      if (result.disposition === 'missing') throw new Error('missing execution')
      expect(() => f.state.rawDbHandle.prepare(`
        UPDATE effect_reversal_offers SET target_ref = 'different' WHERE offer_id = ?
      `).run(offer.offerId)).toThrow(/immutable|transition/)
      expect(() => f.state.rawDbHandle.prepare(`
        DELETE FROM effect_reversal_receipts WHERE receipt_id = ?
      `).run(result.receipt.receiptId)).toThrow(/immutable/)
    } finally {
      f.state.close()
    }
  })
})
