import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'
import { EffectReceiptStore } from '../../../src/gateway/effect-receipt-store.js'

const PROFILE = 'job-receipt-http'

let gateway: TestGateway | undefined

afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
})

async function seedRunWithActions(): Promise<string> {
  const thread = await gateway!.state.createThread(PROFILE)
  const runId = randomUUID()
  const db = gateway!.state.rawDbHandle
  db.prepare(`
    INSERT INTO gateway_runs (
      id, thread_id, workspace_id, profile_id, model, timeout_ms, status,
      start_seq, accepted_at, updated_at, consequence
    ) VALUES (?, ?, NULL, ?, 'test:model', 60000, 'running', 0, 100, 100, 'none_observed')
  `).run(runId, thread.id, PROFILE)
  const receipts = new EffectReceiptStore(db)
  await receipts.observe({
    runId, toolCallId: 'call-1', toolName: 'send_email', observationKey: 'obs-1',
    kind: 'outcome_observed', outcome: 'succeeded', consequence: 'effect_possible',
    authorityKind: 'runtime', authorityRef: 'runtime:test',
  }, 200)
  await receipts.observe({
    runId, toolCallId: 'call-2', toolName: 'read_file', observationKey: 'obs-2',
    kind: 'intent_observed', outcome: 'pending', consequence: 'none_observed',
    authorityKind: 'runtime', authorityRef: 'runtime:test',
  }, 210)
  await receipts.markPendingUnknownForRun(runId, 'runtime:test', 300)
  return runId
}

describe('GET /api/v1/runs/{runId}/job-receipt', () => {
  it('serves the assembled receipt with no caching', async () => {
    gateway = await createTestGateway({ profiles: [{ name: PROFILE, tools: { preset: 'none' } }] })
    const runId = await seedRunWithActions()
    const response = await gateway.client.get(`/api/v1/runs/${runId}/job-receipt`)
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toMatchObject({
      runId,
      totals: {
        observedActions: 2,
        completed: 1,
        indeterminate: 1,
        effectPossibleOrStronger: 2,
      },
    })
  })

  it('returns 404 for a run it has no record of', async () => {
    gateway = await createTestGateway({ profiles: [{ name: PROFILE, tools: { preset: 'none' } }] })
    const response = await gateway.client.get(`/api/v1/runs/${randomUUID()}/job-receipt`)
    expect(response.status).toBe(404)
  })

  it('advertises the capability', async () => {
    gateway = await createTestGateway({ profiles: [{ name: PROFILE, tools: { preset: 'none' } }] })
    const body = (await gateway.client.get('/api/v1/capabilities')).body as {
      capabilities: ReadonlyArray<{ id: string }>
    }
    const ids = new Set(body.capabilities.map((c) => c.id))
    expect(ids.has('runs.job-receipt.read')).toBe(true)
    expect(ids.has('activity.read')).toBe(true)
  })
})
