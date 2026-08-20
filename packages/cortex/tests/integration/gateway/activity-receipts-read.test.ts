import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'
import { appendActivityLedgerRow } from '../../../src/gateway/activity-ledger.js'

/**
 * The cross-run read has no single record to authorize against, so the
 * principal has to constrain the query itself. These cases exercise that seam
 * over real HTTP rather than at the repository, because the enforcement lives
 * in the handler.
 */

const PROFILE_A = 'activity-a'
const PROFILE_B = 'activity-b'

let gateway: TestGateway | undefined

afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
})

async function seedRun(profileId: string): Promise<string> {
  const thread = await gateway!.state.createThread(profileId)
  const runId = randomUUID()
  const db = gateway!.state.rawDbHandle
  db.prepare(`
    INSERT INTO gateway_runs (
      id, thread_id, workspace_id, profile_id, model, timeout_ms, status,
      start_seq, accepted_at, updated_at, consequence
    ) VALUES (?, ?, NULL, ?, 'test:model', 60000, 'running', 0, 100, 100, 'none_observed')
  `).run(runId, thread.id, profileId)
  return runId
}

function append(runId: string, occurredAt: number): void {
  appendActivityLedgerRow(gateway!.state.rawDbHandle, {
    family: 'effect',
    receiptId: randomUUID(),
    runId,
    occurredAt,
  })
}

interface Page {
  readonly items: ReadonlyArray<{ readonly profileId: string; readonly ledgerSeq: number }>
  readonly nextCursor: string | null
  readonly coverage: { readonly reconstructedCount: number }
}

describe('GET /api/v1/activity-receipts', () => {
  it('serves the owner a cross-run trail with ordering provenance and no caching', async () => {
    gateway = await createTestGateway({
      profiles: [{ name: PROFILE_A, tools: { preset: 'none' } }],
    })
    const runOne = await seedRun(PROFILE_A)
    const runTwo = await seedRun(PROFILE_A)
    append(runOne, 100)
    append(runTwo, 200)
    append(runOne, 300)

    const response = await gateway.client.get('/api/v1/activity-receipts')
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const body = response.body as Page
    // Newest first, spanning both runs — the thing no per-run endpoint can do.
    expect(body.items.map((item) => item.ledgerSeq)).toEqual([3, 2, 1])
    expect(body.nextCursor).toBeNull()
    expect(body.coverage.reconstructedCount).toBe(0)
  })

  it('confines a delegated principal to its own profile', async () => {
    gateway = await createTestGateway({
      disableAuth: false,
      profiles: [
        { name: PROFILE_A, tools: { preset: 'none' } },
        { name: PROFILE_B, tools: { preset: 'none' } },
      ],
    })
    const workspaceId = (await gateway.state.createWorkspace(gateway.tmpDir, 'Activity')).id
    append(await seedRun(PROFILE_A), 100)
    append(await seedRun(PROFILE_B), 200)

    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'browser-activity',
      workspaceId,
      profileId: PROFILE_A,
      subjectId: 'subject-a',
      purpose: 'support',
      channel: 'web',
      operations: ['activity.read'],
    })
    expect(issued.status).toBe(201)
    const token = (issued.body as { token: string }).token

    const scoped = await fetch(`${gateway.baseUrl}/api/v1/activity-receipts`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(scoped.status).toBe(200)
    const body = await scoped.json() as Page
    // Profile B's row exists and is invisible; the caller never named a scope.
    expect(body.items.every((item) => item.profileId === PROFILE_A)).toBe(true)

    const owner = await gateway.client.get('/api/v1/activity-receipts')
    expect((owner.body as Page).items).toHaveLength(2)
  })

  it('refuses a delegated request that names another profile instead of narrowing it', async () => {
    // Quietly returning the caller's own rows would let an empty page be read
    // as "that profile did nothing". Deny the question that was actually asked.
    gateway = await createTestGateway({
      disableAuth: false,
      profiles: [
        { name: PROFILE_A, tools: { preset: 'none' } },
        { name: PROFILE_B, tools: { preset: 'none' } },
      ],
    })
    const workspaceId = (await gateway.state.createWorkspace(gateway.tmpDir, 'Activity')).id
    append(await seedRun(PROFILE_B), 200)

    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'browser-activity',
      workspaceId,
      profileId: PROFILE_A,
      subjectId: 'subject-a',
      purpose: 'support',
      channel: 'web',
      operations: ['activity.read'],
    })
    const token = (issued.body as { token: string }).token

    const denied = await fetch(
      `${gateway.baseUrl}/api/v1/activity-receipts?profileId=${PROFILE_B}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    expect(denied.status).toBe(403)
    expect((await denied.json() as { error: string }).error).toBe('principal_scope_denied')
  })

  it('rejects an unknown query parameter, bad limit and malformed cursor', async () => {
    gateway = await createTestGateway({
      profiles: [{ name: PROFILE_A, tools: { preset: 'none' } }],
    })
    append(await seedRun(PROFILE_A), 100)

    for (const query of [
      '?unexpected=1',
      '?limit=0',
      '?limit=101',
      '?limit=abc',
      '?limit=1&limit=2',
      '?cursor=0',
      '?cursor=not-a-number',
      '?since=-1',
      '?family=wire_transfer',
    ]) {
      const response = await gateway.client.get(`/api/v1/activity-receipts${query}`)
      expect([400], `query ${query} should be rejected`).toContain(response.status)
    }
    // A valid request still works afterwards.
    expect((await gateway.client.get('/api/v1/activity-receipts')).status).toBe(200)
  })

  it('pages a large trail without repeating or dropping a row', async () => {
    gateway = await createTestGateway({
      profiles: [{ name: PROFILE_A, tools: { preset: 'none' } }],
    })
    const runId = await seedRun(PROFILE_A)
    for (let index = 0; index < 250; index += 1) append(runId, 1000 + index)

    const seen: number[] = []
    let cursor: string | null = null
    let guard = 0
    do {
      const path = `/api/v1/activity-receipts?limit=100${cursor === null ? '' : `&cursor=${cursor}`}`
      const body = (await gateway.client.get(path)).body as Page
      seen.push(...body.items.map((item) => item.ledgerSeq))
      cursor = body.nextCursor
      guard += 1
    } while (cursor !== null && guard < 10)

    expect(seen).toHaveLength(250)
    expect(new Set(seen).size).toBe(250)
    expect(seen[0]).toBe(250)
    expect(seen[seen.length - 1]).toBe(1)
  })
})
