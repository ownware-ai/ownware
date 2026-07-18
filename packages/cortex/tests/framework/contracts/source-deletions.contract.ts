import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SourceByteStore } from '../../../src/gateway/source-byte-store.js'
import { SourceDeletionStore } from '../../../src/gateway/source-deletion-store.js'
import {
  SourceDeletionWorker,
  type SourceDeletionByteRemover,
} from '../../../src/gateway/source-deletion-worker.js'
import { SourceStore } from '../../../src/gateway/source-store.js'
import { createTestGateway, type TestGateway } from '../harness/index.js'

const CountsSchema = z.object({
  immutableOriginals: z.number().int().nonnegative(),
  uploadStaging: z.number().int().nonnegative(),
  placedCandidates: z.number().int().nonnegative(),
  derivedResources: z.number().int().nonnegative(),
  dataViews: z.number().int().nonnegative(),
  searchIndexes: z.number().int().nonnegative(),
  sourceJobs: z.number().int().nonnegative(),
  idempotencyReplays: z.number().int().nonnegative(),
  retrievalCacheEntries: z.number().int().nonnegative(),
}).strict()

const DeletionSchema = z.object({
  jobId: z.string().uuid(),
  sourceId: z.string().uuid(),
  operation: z.literal('delete_source'),
  state: z.enum([
    'queued', 'deleting', 'cancel_requested', 'cancelled',
    'partially_deleted', 'deleted',
  ]),
  sourceRevision: z.number().int().positive(),
  affected: CountsSchema,
  remaining: CountsSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  terminalAt: z.number().int().nullable(),
}).strict()

const PROFILE_ID = 'mini'

describe('Contract: scoped source deletions', () => {
  let gw: TestGateway
  let workspaceId: string
  let token: string

  beforeAll(async () => {
    gw = await createTestGateway({ disableAuth: false, disableSourceWorker: true })
    workspaceId = gw.state.createWorkspace(gw.tmpDir, 'Source deletion contract').id
    token = await issue(workspaceId, 'deletion-client', [
      'source_deletions.create', 'source_deletions.read',
      'source_deletions.cancel', 'source_deletions.retry', 'sources.read',
    ])
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('creates, exactly replays, reads, and safely cancels before destruction', async () => {
    const sourceId = createSource('Cancellable deletion source')
    const idempotencyKey = '11111111-abab-4111-8111-111111111111'
    const create = () => createDeletion(sourceId, 1, idempotencyKey)
    const createdResponse = await create()
    expect(createdResponse.status).toBe(202)
    const createdRaw = await createdResponse.text()
    const created = DeletionSchema.parse(JSON.parse(createdRaw))
    expect(created).toMatchObject({
      sourceId,
      state: 'queued',
      sourceRevision: 2,
      affected: zeroCounts(),
      remaining: zeroCounts(),
      terminalAt: null,
    })
    assertPrivateDeletionStateAbsent(createdRaw)

    const replay = await create()
    expect(replay.status).toBe(202)
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    expect(DeletionSchema.parse(await replay.json())).toEqual(created)

    const detail = await readDeletion(created.jobId)
    expect(detail.status).toBe(200)
    expect(DeletionSchema.parse(await detail.json())).toEqual(created)

    const cancellation = await fetch(
      `${gw.baseUrl}/api/v1/source-deletions/${created.jobId}/cancel`,
      { method: 'POST', headers: auth(), body: '{}' },
    )
    expect(cancellation.status).toBe(202)
    await expect(cancellation.json()).resolves.toMatchObject({
      jobId: created.jobId,
      state: 'cancel_requested',
      cancellation: 'requested',
    })
    const deletions = new SourceDeletionStore(gw.state.rawDbHandle)
    expect(await new SourceDeletionWorker(deletions, realBytes(), {
      workerId: 'cancel-deletion-worker',
    }).runAvailable()).toBe(1)
    await expect((await readDeletion(created.jobId)).json()).resolves.toMatchObject({
      state: 'cancelled',
    })
    expect(gw.state.rawDbHandle.prepare(`
      SELECT revision, deletion_state FROM runtime_sources WHERE source_id = ?
    `).get(sourceId)).toEqual({ revision: 3, deletion_state: 'active' })

    const replacement = await createDeletion(
      sourceId, 3, '12121212-abab-4121-8121-121212121212',
    )
    expect(replacement.status).toBe(202)
    const replacementDeletion = DeletionSchema.parse(await replacement.json())
    expect(replacementDeletion.jobId).not.toBe(created.jobId)
    const supersededReplay = await create()
    expect(supersededReplay.status).toBe(202)
    expect(supersededReplay.headers.get('idempotency-replayed')).toBe('true')
    expect(DeletionSchema.parse(await supersededReplay.json())).toEqual(created)
    await expect((await readDeletion(created.jobId)).json()).resolves.toMatchObject({
      state: 'cancelled',
      remaining: zeroCounts(),
    })
    expect((await fetch(
      `${gw.baseUrl}/api/v1/source-deletions/${replacementDeletion.jobId}/cancel`,
      { method: 'POST', headers: auth(), body: '{}' },
    )).status).toBe(202)
    expect(await new SourceDeletionWorker(deletions, realBytes(), {
      workerId: 'replacement-cancel-worker',
    }).runAvailable()).toBe(1)
  })

  it('reports deleted only after byte absence and retains only the scoped tombstone', async () => {
    const target = await createVersionedSource('Verified deletion source')
    const idempotencyKey = '22222222-abab-4222-8222-222222222222'
    const createdResponse = await createDeletion(target.sourceId, 2, idempotencyKey)
    expect(createdResponse.status).toBe(202)
    const created = DeletionSchema.parse(await createdResponse.json())
    expect(created).toMatchObject({
      state: 'queued',
      affected: { immutableOriginals: 1 },
      remaining: { immutableOriginals: 1 },
    })

    expect(await new SourceDeletionWorker(
      new SourceDeletionStore(gw.state.rawDbHandle),
      realBytes(),
      { workerId: 'verified-deletion-worker' },
    ).runAvailable()).toBe(1)
    const deletedResponse = await readDeletion(created.jobId)
    const deletedRaw = await deletedResponse.text()
    const deleted = DeletionSchema.parse(JSON.parse(deletedRaw))
    expect(deleted).toMatchObject({
      jobId: created.jobId,
      sourceId: target.sourceId,
      state: 'deleted',
      affected: { immutableOriginals: 1 },
      remaining: zeroCounts(),
      terminalAt: expect.any(Number),
    })
    assertPrivateDeletionStateAbsent(deletedRaw)
    expect((await fetch(`${gw.baseUrl}/api/v1/sources/${target.sourceId}`, {
      headers: auth(),
    })).status).toBe(404)
    expect(gw.state.rawDbHandle.prepare(
      'SELECT 1 FROM runtime_sources WHERE source_id = ?',
    ).get(target.sourceId)).toBeUndefined()
    expect(gw.state.rawDbHandle.prepare(
      'SELECT 1 FROM source_versions WHERE source_id = ?',
    ).get(target.sourceId)).toBeUndefined()
    expect(gw.state.rawDbHandle.prepare(
      'SELECT 1 FROM source_deletion_plans WHERE source_id = ?',
    ).get(target.sourceId)).toBeUndefined()
    expect(gw.state.rawDbHandle.prepare(`
      SELECT job_id, source_id, source_revision, immutable_originals,
        state, created_at, terminal_at
      FROM source_deletion_tombstones WHERE source_id = ?
    `).get(target.sourceId)).toMatchObject({
      job_id: created.jobId,
      source_id: target.sourceId,
      state: 'deleted',
      source_revision: 3,
      immutable_originals: 1,
    })

    const exactReplay = await createDeletion(target.sourceId, 2, idempotencyKey)
    expect(exactReplay.headers.get('idempotency-replayed')).toBe('true')
    expect(DeletionSchema.parse(await exactReplay.json())).toEqual(created)
    const naturalReplay = await createDeletion(
      target.sourceId, 2, '23232323-abab-4232-8232-232323232323',
    )
    expect(naturalReplay.status).toBe(202)
    expect(DeletionSchema.parse(await naturalReplay.json())).toEqual(deleted)
    expect(gw.state.rawDbHandle.prepare(`
      SELECT COUNT(*) AS count FROM run_idempotency
      WHERE operation = 'source_deletions.create' AND source_id IS NULL
        AND idempotency_key IN (?, ?)
    `).get(idempotencyKey, '23232323-abab-4232-8232-232323232323'))
      .toEqual({ count: 2 })
  })

  it('keeps partial deletion frozen, rejects cancellation, and retries only failed inventory', async () => {
    const target = await createVersionedSource('Partial deletion source')
    const created = DeletionSchema.parse(await (await createDeletion(
      target.sourceId, 2, '33333333-abab-4333-8333-333333333333',
    )).json())
    const unavailable: SourceDeletionByteRemover = {
      async removeUploadArtifacts() {},
      async uploadArtifactsAbsent() { return true },
      async removeVersionArtifacts() {},
      async versionArtifactsAbsent() { return false },
    }
    expect(await new SourceDeletionWorker(
      new SourceDeletionStore(gw.state.rawDbHandle),
      unavailable,
      { workerId: 'partial-deletion-worker' },
    ).runAvailable()).toBe(1)
    const partial = DeletionSchema.parse(await (await readDeletion(created.jobId)).json())
    expect(partial).toMatchObject({
      state: 'partially_deleted',
      affected: { immutableOriginals: 1 },
      remaining: { immutableOriginals: 1 },
      terminalAt: expect.any(Number),
    })
    expect(gw.state.rawDbHandle.prepare(`
      SELECT deletion_state FROM runtime_sources WHERE source_id = ?
    `).get(target.sourceId)).toEqual({ deletion_state: 'partially_deleted' })
    const cancellation = await fetch(
      `${gw.baseUrl}/api/v1/source-deletions/${created.jobId}/cancel`,
      { method: 'POST', headers: auth(), body: '{}' },
    )
    expect(cancellation.status).toBe(409)
    await expect(cancellation.json()).resolves.toMatchObject({
      error: 'source_deletion_terminal',
    })

    const retry = await fetch(
      `${gw.baseUrl}/api/v1/source-deletions/${created.jobId}/retry`,
      { method: 'POST', headers: auth(), body: '{}' },
    )
    expect(retry.status).toBe(202)
    await expect(retry.json()).resolves.toMatchObject({
      state: 'queued',
      retry: 'queued',
    })
    expect(await new SourceDeletionWorker(
      new SourceDeletionStore(gw.state.rawDbHandle),
      realBytes(),
      { workerId: 'retry-deletion-worker' },
    ).runAvailable()).toBe(1)
    await expect((await readDeletion(created.jobId)).json()).resolves.toMatchObject({
      state: 'deleted',
      remaining: zeroCounts(),
    })
  })

  it('enforces exact revision and separate authorities without leaking scope', async () => {
    const sourceId = createSource('Scoped deletion source')
    const key = '44444444-abab-4444-8444-444444444444'
    const conflict = await createDeletion(sourceId, 2, key)
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({
      error: 'source_deletion_revision_conflict',
    })
    expect(gw.state.rawDbHandle.prepare(`
      SELECT COUNT(*) AS count FROM source_deletion_plans WHERE source_id = ?
    `).get(sourceId)).toEqual({ count: 0 })
    const created = DeletionSchema.parse(await (await createDeletion(sourceId, 1, key)).json())

    const otherWorkspace = gw.state.createWorkspace(
      join(gw.tmpDir, 'other-deletion-scope'),
      'Other deletion scope',
    ).id
    const wrongScope = await issue(otherWorkspace, 'wrong-scope', [
      'source_deletions.create', 'source_deletions.read',
    ])
    expect((await readDeletion(created.jobId, wrongScope)).status).toBe(404)
    expect((await createDeletion(
      sourceId, 1, '45454545-abab-4454-8454-454545454545', wrongScope,
    )).status).toBe(404)

    const createOnly = await issue(workspaceId, 'create-only', [
      'source_deletions.create',
    ])
    expect((await readDeletion(created.jobId, createOnly)).status).toBe(403)
    const readOnly = await issue(workspaceId, 'read-only', [
      'source_deletions.read',
    ])
    expect((await createDeletion(
      sourceId, 1, '46464646-abab-4464-8464-464646464646', readOnly,
    )).status).toBe(403)
  })

  function createSource(label: string): string {
    return new SourceStore(gw.state.rawDbHandle).create({
      workspaceId,
      profileId: PROFILE_ID,
      kind: 'file',
      label,
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.test',
      sensitivityPolicyRef: 'sensitivity.test',
      purposePolicyRef: 'purpose.test',
      retentionPolicyRef: 'retention.test',
      freshnessPolicyRef: 'freshness.test',
    }).sourceId
  }

  async function createVersionedSource(label: string): Promise<{
    sourceId: string
    versionId: string
  }> {
    const sourceId = createSource(label)
    const versionId = crypto.randomUUID()
    const objectKey = `sources/${sourceId}/versions/${versionId}/original`
    const objectPath = join(gw.tmpDir, 'data', 'source-storage', objectKey)
    await mkdir(dirname(objectPath), { recursive: true, mode: 0o700 })
    await writeFile(objectPath, 'Synthetic deletion evidence.\n', { mode: 0o600 })
    gw.state.rawDbHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, preparation_state, created_at
      ) VALUES (?, ?, ?, 'text/plain', 29, ?, 'not_started', 'not_requested', ?)
    `).run(versionId, sourceId, `sha256:${'a'.repeat(64)}`, objectKey, Date.now())
    gw.state.rawDbHandle.prepare(`
      UPDATE runtime_sources SET revision = 2, current_version_id = ?,
        registration_state = 'registered', freshness_state = 'fresh', updated_at = ?
      WHERE source_id = ?
    `).run(versionId, Date.now(), sourceId)
    return { sourceId, versionId }
  }

  function createDeletion(
    sourceId: string,
    expectedRevision: number,
    idempotencyKey: string,
    bearer = token,
  ): Promise<Response> {
    return fetch(`${gw.baseUrl}/api/v1/sources/${sourceId}/deletions`, {
      method: 'POST',
      headers: auth({ 'idempotency-key': idempotencyKey }, bearer),
      body: JSON.stringify({ expectedRevision }),
    })
  }

  function readDeletion(jobId: string, bearer = token): Promise<Response> {
    return fetch(`${gw.baseUrl}/api/v1/source-deletions/${jobId}`, {
      headers: { authorization: `Bearer ${bearer}` },
    })
  }

  function realBytes(): SourceByteStore {
    return new SourceByteStore(join(gw.tmpDir, 'data', 'source-storage'))
  }

  async function issue(
    targetWorkspaceId: string,
    delegateId: string,
    operations: readonly string[],
  ): Promise<string> {
    const response = await gw.client.post('/api/v1/auth/delegations', {
      delegateId,
      workspaceId: targetWorkspaceId,
      profileId: PROFILE_ID,
      purpose: 'source-deletion-contract',
      operations,
    })
    expect(response.status).toBe(201)
    return (response.body as { token: string }).token
  }

  function auth(extra: Record<string, string> = {}, bearer = token): Record<string, string> {
    return {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      ...extra,
    }
  }
})

function zeroCounts() {
  return {
    immutableOriginals: 0,
    uploadStaging: 0,
    placedCandidates: 0,
    derivedResources: 0,
    dataViews: 0,
    searchIndexes: 0,
    sourceJobs: 0,
    idempotencyReplays: 0,
    retrievalCacheEntries: 0,
  }
}

function assertPrivateDeletionStateAbsent(raw: string): void {
  for (const privateValue of [
    'artifactId', 'implementationVersion', 'checkpoint', 'attempt', 'maxAttempts',
    'claimToken', 'claimedBy', 'leaseExpiresAt', 'objectKey', 'path', 'checksum',
  ]) expect(raw).not.toContain(privateValue)
}
