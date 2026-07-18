import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import {
  assertNoSecretShapedKeys,
  ChannelJobConflictError,
  ChannelJobStore,
} from '../../../src/gateway/channel-job-store.js'
import type { ChannelGateSpec } from '../../../src/gateway/channel-procedures.js'

const PROFILE_ID = 'rosa'
const GATE: ChannelGateSpec = {
  id: 'connect_demo:approve-connect',
  title: 'Connect 0400 555 210 to Rosa?',
  included: ['Customers who message this number reach Rosa — once you publish, not before'],
  excluded: ['She never messages anyone first'],
  onDecline: 'No WhatsApp yet. Nothing else changes.',
}

describe('ChannelJobStore', () => {
  let dir: string
  let database: CortexDatabase
  let store: ChannelJobStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'channel-job-store-'))
    database = new CortexDatabase(join(dir, 'ownware.db'))
    store = new ChannelJobStore(database.rawMainHandle)
  })

  afterEach(async () => {
    database.close()
    await rm(dir, { recursive: true, force: true })
  })

  function enqueueDemo(now = 100): ReturnType<ChannelJobStore['enqueue']> {
    return store.enqueue({
      profileId: PROFILE_ID,
      operation: 'connect_demo',
      channelKind: 'whatsapp',
      params: { phoneNumber: '0400555210' },
      stepCount: 3,
    }, now)
  }

  it('enqueues a queued job with the projected shape', () => {
    const job = enqueueDemo()
    expect(job).toMatchObject({
      profileId: PROFILE_ID,
      operation: 'connect_demo',
      channelKind: 'whatsapp',
      channelId: null,
      state: 'queued',
      attempt: 0,
      maxAttempts: 3,
      checkpoint: 0,
      stepCount: 3,
      gate: null,
      outcomeCode: null,
      terminalAt: null,
    })
    expect(job.jobId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('rejects a second live job for the same profile+operation, allows one after terminal', () => {
    const first = enqueueDemo()
    expect(() => enqueueDemo(101)).toThrow(ChannelJobConflictError)

    const claim = store.claimNext('w1', 200)!
    expect(store.finish(first.jobId, claim.claimToken, 'failed', 'test_over', 210)).toBe('finished')
    expect(enqueueDemo(300).state).toBe('queued')
  })

  it('rejects secret-shaped keys in params, state, gates, and receipts', () => {
    expect(() => store.enqueue({
      profileId: PROFILE_ID,
      operation: 'connect_demo',
      channelKind: 'whatsapp',
      params: { accessToken: 'oops' },
      stepCount: 3,
    })).toThrow(/secret/)
    expect(() => assertNoSecretShapedKeys({ nested: { app_secret: 'x' } })).toThrow(/secret/)
    // Handles are fine — they reference the vault, they are not values.
    expect(() => assertNoSecretShapedKeys({ credentialId: 'cred-1', tokenRef: 'r1' })).not.toThrow()

    const job = enqueueDemo()
    const claim = store.claimNext('w1', 200)!
    expect(() => store.advanceCheckpoint(
      job.jobId, claim.claimToken, 0, { apiKey: 'nope' }, 210,
    )).toThrow(/secret/)
    expect(() => store.appendReceipt({
      profileId: PROFILE_ID,
      kind: 'note',
      title: 'x',
      body: { password: 'hunter2' },
    })).toThrow(/secret/)
  })

  it('claims, renews, advances checkpoints with persisted state, and finishes', () => {
    const job = enqueueDemo()
    const claim = store.claimNext('w1', 200)!
    expect(claim).toMatchObject({
      jobId: job.jobId,
      operation: 'connect_demo',
      checkpoint: 0,
      attempt: 0,
      params: { phoneNumber: '0400555210' },
      state: {},
      gateResponse: null,
    })
    expect(store.get(job.jobId)?.state).toBe('running')

    expect(store.renewLease(job.jobId, claim.claimToken, 210)).toBe('ok')
    expect(store.advanceCheckpoint(
      job.jobId, claim.claimToken, 0, { checked: true }, 220,
    )).toBe('advanced')
    expect(store.advanceCheckpoint(
      job.jobId, claim.claimToken, 0, {}, 221,
    )).toBe('checkpoint_conflict')

    // succeeded demands the full walk — no early "done" lies.
    expect(store.finish(job.jobId, claim.claimToken, 'succeeded', 'x_done', 230))
      .toBe('checkpoint_incomplete')
    expect(store.advanceCheckpoint(job.jobId, claim.claimToken, 1, { checked: true }, 240)).toBe('advanced')
    expect(store.advanceCheckpoint(job.jobId, claim.claimToken, 2, { checked: true }, 250)).toBe('advanced')
    expect(store.finish(job.jobId, claim.claimToken, 'succeeded', 'procedure_complete', 260)).toBe('finished')
    expect(store.get(job.jobId)).toMatchObject({
      state: 'succeeded',
      outcomeCode: 'procedure_complete',
      checkpoint: 3,
    })

    // The persisted state survived: a fresh claim on a new job proves shape,
    // but here just assert the terminal row kept it via a direct read.
    const raw = database.rawMainHandle.prepare(
      'SELECT state_json FROM channel_jobs WHERE job_id = ?',
    ).get(job.jobId) as { state_json: string }
    expect(JSON.parse(raw.state_json)).toEqual({ checked: true })
  })

  it('work lines require a live claim and stay ordered', () => {
    const job = enqueueDemo()
    const claim = store.claimNext('w1', 200)!
    expect(store.appendWorkLine(job.jobId, claim.claimToken, 'Checked the number', 'it can link', 210)).toBe('ok')
    expect(store.appendWorkLine(job.jobId, claim.claimToken, 'Number connected', undefined, 220)).toBe('ok')
    expect(store.appendWorkLine(job.jobId, 'bogus-token', 'zombie', undefined, 230)).toBe('stale_claim')
    expect(store.workLines(job.jobId)).toEqual([
      { seq: 1, title: 'Checked the number', detail: 'it can link', createdAt: 210 },
      { seq: 2, title: 'Number connected', detail: null, createdAt: 220 },
    ])
  })

  it('parks at a gate, approve requeues with the decision, and the receipt records scope', () => {
    const job = enqueueDemo()
    const claim = store.claimNext('w1', 200)!
    expect(store.parkForGate(job.jobId, claim.claimToken, GATE, 210)).toBe('parked')
    expect(store.get(job.jobId)).toMatchObject({
      state: 'waiting_for_input',
      gate: { ...GATE, presentedAt: 210 },
    })

    // A stale worker cannot touch a parked job.
    expect(store.advanceCheckpoint(job.jobId, claim.claimToken, 0, {}, 215)).toBe('stale_claim')

    expect(store.respondToGate(job.jobId, {
      gateId: 'wrong-gate', action: 'approve', actor: 'Maria Santos',
    }, 220)).toBe('gate_mismatch')
    expect(store.respondToGate(job.jobId, {
      gateId: GATE.id, action: 'approve', actor: 'Maria Santos',
    }, 230)).toBe('accepted')
    expect(store.get(job.jobId)).toMatchObject({ state: 'queued', gate: null })

    const resumed = store.claimNext('w1', 240)!
    expect(resumed.gateResponse).toEqual({
      gateId: GATE.id, action: 'approve', actor: 'Maria Santos', decidedAt: 230,
    })
    expect(store.consumeGateResponse(job.jobId, resumed.claimToken, 0, GATE.id, 250)).toBe('advanced')

    const receipts = store.receiptsForJob(job.jobId)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      kind: 'gate_decision',
      title: `Approved — ${GATE.title}`,
      body: {
        gateId: GATE.id,
        action: 'approve',
        actor: 'Maria Santos',
        scope: GATE.included,
        exclusions: GATE.excluded,
        requestedAt: 210,
        decidedAt: 230,
      },
    })
  })

  it('a declined gate ends the job with state-unchanged truth in the receipt', () => {
    const job = enqueueDemo()
    const claim = store.claimNext('w1', 200)!
    store.parkForGate(job.jobId, claim.claimToken, GATE, 210)
    expect(store.respondToGate(job.jobId, {
      gateId: GATE.id, action: 'deny', actor: 'Maria Santos',
    }, 220)).toBe('declined')
    expect(store.get(job.jobId)).toMatchObject({
      state: 'cancelled',
      outcomeCode: 'gate_declined',
      gate: null,
    })
    const receipts = store.receiptsForJob(job.jobId)
    expect(receipts[0]).toMatchObject({
      title: `Declined — ${GATE.title}`,
      body: { whatRemainedUnchanged: GATE.onDecline },
    })
    // Deciding twice is a conflict, not a double receipt.
    expect(store.respondToGate(job.jobId, {
      gateId: GATE.id, action: 'deny', actor: 'Maria Santos',
    }, 230)).toBe('state_conflict')
    expect(store.receiptsForJob(job.jobId)).toHaveLength(1)
  })

  it('defer costs an attempt and refuses past the budget', () => {
    const job = enqueueDemo()
    let claim = store.claimNext('w1', 200)!
    expect(store.deferUntil(job.jobId, claim.claimToken, 300, 210)).toBe('deferred')
    expect(store.get(job.jobId)).toMatchObject({ state: 'waiting_for_retry', attempt: 1 })
    expect(store.claimNext('w1', 250)).toBeNull() // retry_after not reached

    claim = store.claimNext('w1', 300)!
    expect(store.deferUntil(job.jobId, claim.claimToken, 400, 310)).toBe('deferred')
    claim = store.claimNext('w1', 400)!
    expect(store.deferUntil(job.jobId, claim.claimToken, 500, 410)).toBe('deferred')
    claim = store.claimNext('w1', 500)!
    expect(store.deferUntil(job.jobId, claim.claimToken, 600, 510)).toBe('attempts_exhausted')
  })

  it('cancel requests finalize with a receipt; recovery handles expired leases', () => {
    const job = enqueueDemo()
    const claim = store.claimNext('w1', 200)!
    expect(store.requestCancel(job.jobId, 210)).toBe('requested')
    // The running claim notices on its next store op.
    expect(store.advanceCheckpoint(job.jobId, claim.claimToken, 0, {}, 220)).toBe('stale_claim')
    expect(store.confirmCancelled(job.jobId, claim.claimToken, 230)).toBe('cancelled')
    expect(store.get(job.jobId)).toMatchObject({ state: 'cancelled', outcomeCode: 'cancelled' })
    expect(store.receiptsForJob(job.jobId).map((r) => r.kind)).toEqual(['procedure_cancelled'])

    // Crash recovery: a running job whose lease expired requeues (+1 attempt),
    // and at the attempt budget it fails honestly.
    const second = store.enqueue({
      profileId: 'other',
      operation: 'connect_demo',
      channelKind: 'whatsapp',
      params: {},
      stepCount: 3,
    }, 300)
    store.claimNext('w1', 300)
    const recovered = store.recoverExpiredClaims(300 + 31_000)
    expect(recovered).toEqual({ requeued: 1, failed: 0, cancelled: 0 })
    expect(store.get(second.jobId)).toMatchObject({ state: 'queued', attempt: 1 })
  })

  it('receipts are append-only at the database level', () => {
    const receipt = store.appendReceipt({
      profileId: PROFILE_ID,
      kind: 'connection',
      title: 'WhatsApp connected — Not live',
      body: { whatRemainedUnchanged: 'Nothing reaches a customer until you publish' },
    }, 100)
    const db = database.rawMainHandle
    expect(() => db.prepare(
      "UPDATE channel_receipts SET title = 'rewritten history' WHERE receipt_id = ?",
    ).run(receipt.receiptId)).toThrow(/append-only/)
    expect(() => db.prepare(
      'DELETE FROM channel_receipts WHERE receipt_id = ?',
    ).run(receipt.receiptId)).toThrow(/append-only/)
  })
})
