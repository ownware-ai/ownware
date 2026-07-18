/**
 * ChannelJobWorker — the procedure engine end to end at the store level:
 * work lines stream, a consent gate parks the job, an approve resumes it
 * (including across a full "restart"), a decline ends it honestly, crashes
 * recover from the checkpoint, and failures defer/finish per their type.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { ChannelJobStore } from '../../../src/gateway/channel-job-store.js'
import { ChannelJobWorker } from '../../../src/gateway/channel-job-worker.js'
import {
  ChannelProcedureRegistry,
  gateStepId,
  ProcedureStepError,
  TransientStepError,
  type ChannelProcedure,
} from '../../../src/gateway/channel-procedures.js'

const GATE_ID = gateStepId('connect_demo', 'approve_connect')

function demoProcedure(log: string[]): ChannelProcedure {
  return {
    operation: 'connect_demo',
    channelKind: 'whatsapp',
    steps: [
      {
        kind: 'work',
        name: 'check_number',
        run: async (ctx): Promise<void> => {
          log.push('check_number')
          ctx.workLine('Checked the number', 'it can link to Rosa without moving anything')
          ctx.state['numberOk'] = true
        },
      },
      {
        kind: 'gate',
        name: 'approve_connect',
        gate: (ctx) => ({
          id: GATE_ID,
          title: `Connect ${String(ctx.params['phoneNumber'])} to Rosa?`,
          included: ['Customers who message this number reach Rosa — once you publish, not before'],
          excluded: ['She never messages anyone first'],
          onDecline: 'No WhatsApp yet. Nothing else changes.',
        }),
      },
      {
        kind: 'work',
        name: 'connect',
        run: async (ctx): Promise<void> => {
          log.push(`connect:numberOk=${String(ctx.state['numberOk'])}`)
          ctx.workLine('Number connected')
          ctx.receipt({
            kind: 'connection',
            title: 'WhatsApp connected — Not live',
            body: { whatRemainedUnchanged: 'Nothing reaches a customer until you publish' },
          })
        },
      },
    ],
  }
}

describe('ChannelJobWorker', () => {
  let dir: string
  let database: CortexDatabase
  let store: ChannelJobStore
  let registry: ChannelProcedureRegistry
  let worker: ChannelJobWorker
  let log: string[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'channel-job-worker-'))
    database = new CortexDatabase(join(dir, 'ownware.db'))
    store = new ChannelJobStore(database.rawMainHandle)
    registry = new ChannelProcedureRegistry()
    log = []
    registry.register(demoProcedure(log))
    worker = new ChannelJobWorker(store, registry, { workerId: 'test-worker' })
  })

  afterEach(async () => {
    await worker.stop()
    database.close()
    await rm(dir, { recursive: true, force: true })
  })

  function enqueueDemo(profileId = 'rosa', now = 100): string {
    return store.enqueue({
      profileId,
      operation: 'connect_demo',
      channelKind: 'whatsapp',
      params: { phoneNumber: '0400555210' },
      stepCount: 3,
    }, now).jobId
  }

  it('runs to the gate, parks, resumes on approve, and finishes with receipts', async () => {
    const jobId = enqueueDemo()

    expect(await worker.runOne(200)).toBe(true)
    expect(store.get(jobId)).toMatchObject({
      state: 'waiting_for_input',
      checkpoint: 1,
      gate: {
        id: GATE_ID,
        title: 'Connect 0400555210 to Rosa?',
        presentedAt: 200,
      },
    })
    expect(log).toEqual(['check_number'])
    // Nothing else to do while a person decides.
    expect(await worker.runOne(210)).toBe(false)

    expect(store.respondToGate(jobId, {
      gateId: GATE_ID, action: 'approve', actor: 'Maria Santos',
    }, 300)).toBe('accepted')

    expect(await worker.runOne(400)).toBe(true)
    expect(store.get(jobId)).toMatchObject({
      state: 'succeeded',
      outcomeCode: 'procedure_complete',
      checkpoint: 3,
    })
    // State crossed the gate: the connect step saw check_number's work.
    expect(log).toEqual(['check_number', 'connect:numberOk=true'])

    expect(store.workLines(jobId).map((l) => l.title)).toEqual([
      'Checked the number', 'Number connected',
    ])
    expect(store.receiptsForJob(jobId).map((r) => r.kind)).toEqual([
      'gate_decision', 'connection',
    ])
  })

  it('survives a full restart while parked at the gate', async () => {
    const jobId = enqueueDemo()
    await worker.runOne(200)
    expect(store.get(jobId)?.state).toBe('waiting_for_input')

    // "Restart": brand-new store/registry/worker over the same database.
    const store2 = new ChannelJobStore(database.rawMainHandle)
    const log2: string[] = []
    const registry2 = new ChannelProcedureRegistry()
    registry2.register(demoProcedure(log2))
    const worker2 = new ChannelJobWorker(store2, registry2, { workerId: 'after-restart' })
    expect(store2.recoverExpiredClaims(60_000)).toEqual({ requeued: 0, failed: 0, cancelled: 0 })

    // The gate is still presentable from the durable row after restart.
    expect(store2.get(jobId)?.gate?.title).toBe('Connect 0400555210 to Rosa?')
    store2.respondToGate(jobId, { gateId: GATE_ID, action: 'approve', actor: 'Maria' }, 60_100)
    expect(await worker2.runOne(60_200)).toBe(true)
    expect(store2.get(jobId)).toMatchObject({ state: 'succeeded', checkpoint: 3 })
    expect(log2).toEqual(['connect:numberOk=true']) // step 0 was NOT re-run
  })

  it('recovers a crash mid-procedure from the last checkpoint', async () => {
    const jobId = enqueueDemo()
    // Simulate a crash: claim the job and vanish without finishing.
    const claim = store.claimNext('crashed-worker', 200)!
    expect(store.advanceCheckpoint(jobId, claim.claimToken, 0, { numberOk: true }, 210)).toBe('advanced')

    const recovered = store.recoverExpiredClaims(210 + 31_000)
    expect(recovered.requeued).toBe(1)
    expect(await worker.runOne(210 + 32_000)).toBe(true)
    // It resumed AT the gate (checkpoint 1) — step 0 did not re-run.
    expect(log).toEqual([])
    expect(store.get(jobId)).toMatchObject({ state: 'waiting_for_input', attempt: 1 })
  })

  it('a declined gate ends the procedure; the worker finds nothing to run', async () => {
    const jobId = enqueueDemo()
    await worker.runOne(200)
    expect(store.respondToGate(jobId, {
      gateId: GATE_ID, action: 'deny', actor: 'Maria Santos',
    }, 300)).toBe('declined')
    expect(store.get(jobId)).toMatchObject({ state: 'cancelled', outcomeCode: 'gate_declined' })
    expect(await worker.runOne(400)).toBe(false)
    expect(log).toEqual(['check_number'])
  })

  it('cancelling a parked job finalizes it with a receipt', async () => {
    const jobId = enqueueDemo()
    await worker.runOne(200)
    expect(store.requestCancel(jobId, 300)).toBe('requested')
    expect(await worker.runOne(310)).toBe(true) // confirms the cancellation
    expect(store.get(jobId)).toMatchObject({ state: 'cancelled', outcomeCode: 'cancelled' })
    expect(store.receiptsForJob(jobId).map((r) => r.kind)).toEqual(['procedure_cancelled'])
  })

  it('transient failures defer with the attempt budget, then exhaust honestly', async () => {
    const registry2 = new ChannelProcedureRegistry()
    let failures = 0
    registry2.register({
      operation: 'connect_flaky',
      channelKind: 'whatsapp',
      steps: [{
        kind: 'work',
        name: 'flaky',
        run: async (): Promise<void> => {
          failures += 1
          throw new TransientStepError('provider hiccup', 1_000)
        },
      }],
    })
    const flakyWorker = new ChannelJobWorker(store, registry2, { workerId: 'flaky' })
    const jobId = store.enqueue({
      profileId: 'rosa',
      operation: 'connect_flaky',
      channelKind: 'whatsapp',
      params: {},
      stepCount: 1,
    }, 100).jobId

    expect(await flakyWorker.runOne(200)).toBe(true)
    expect(store.get(jobId)).toMatchObject({ state: 'waiting_for_retry', attempt: 1 })
    expect(await flakyWorker.runOne(1_300)).toBe(true)
    expect(await flakyWorker.runOne(2_400)).toBe(true)
    expect(store.get(jobId)).toMatchObject({ state: 'waiting_for_retry', attempt: 3 })
    expect(await flakyWorker.runOne(3_500)).toBe(true)
    expect(store.get(jobId)).toMatchObject({ state: 'failed', outcomeCode: 'attempts_exhausted' })
    expect(failures).toBe(4)
  })

  it('a permanent step failure finishes with its outcome code', async () => {
    const registry2 = new ChannelProcedureRegistry()
    registry2.register({
      operation: 'connect_doomed',
      channelKind: 'whatsapp',
      steps: [{
        kind: 'work',
        name: 'doomed',
        run: async (): Promise<void> => {
          throw new ProcedureStepError('number_on_personal_whatsapp')
        },
      }],
    })
    const doomedWorker = new ChannelJobWorker(store, registry2, { workerId: 'doomed' })
    const jobId = store.enqueue({
      profileId: 'rosa',
      operation: 'connect_doomed',
      channelKind: 'whatsapp',
      params: {},
      stepCount: 1,
    }, 100).jobId
    expect(await doomedWorker.runOne(200)).toBe(true)
    expect(store.get(jobId)).toMatchObject({
      state: 'failed',
      outcomeCode: 'number_on_personal_whatsapp',
    })
  })

  it('unknown operations and reshaped procedures fail honestly instead of queue-rotting', async () => {
    const emptyWorker = new ChannelJobWorker(
      store, new ChannelProcedureRegistry(), { workerId: 'empty' },
    )
    const unknownId = enqueueDemo('profile-a')
    expect(await emptyWorker.runOne(200)).toBe(true)
    expect(store.get(unknownId)).toMatchObject({ state: 'failed', outcomeCode: 'procedure_unknown' })

    const reshapedId = store.enqueue({
      profileId: 'profile-b',
      operation: 'connect_demo',
      channelKind: 'whatsapp',
      params: { phoneNumber: '1' },
      stepCount: 2, // registered procedure has 3 steps
    }, 300).jobId
    expect(await worker.runOne(400)).toBe(true)
    expect(store.get(reshapedId)).toMatchObject({
      state: 'failed',
      outcomeCode: 'procedure_shape_changed',
    })
  })
})
