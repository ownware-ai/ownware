import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { SourceJobStore, SOURCE_JOB_LEASE_MS } from '../../../src/gateway/source-job-store.js'
import { SourceDataViewStore } from '../../../src/gateway/source-data-view-store.js'
import { SourceStore } from '../../../src/gateway/source-store.js'
import { createTestGateway } from '../../framework/harness/gateway.js'

const VERSION_ID = '66666666-6666-4666-8666-666666666666'
const WORKER_VERSION_ID = '77777777-7777-4777-8777-777777777777'

let cleanupDir: string | undefined
let restarted: OwnwareGateway | undefined

afterEach(async () => {
  await restarted?.stop()
  restarted = undefined
  if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true })
  cleanupDir = undefined
})

describe('source job across a real Gateway restart', () => {
  it('replays the exact public creation result after restart', async () => {
    const gateway = await createTestGateway({
      disableAuth: false,
      disableSourceWorker: true,
    })
    cleanupDir = gateway.tmpDir
    const workspaceId = gateway.state.createWorkspace(
      gateway.tmpDir,
      'Public source job replay',
    ).id
    const source = new SourceStore(gateway.state.rawDbHandle).create({
      workspaceId,
      profileId: 'mini',
      kind: 'file',
      label: 'Synthetic public replay source',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.test',
      sensitivityPolicyRef: 'sensitivity.test',
      purposePolicyRef: 'purpose.test',
      retentionPolicyRef: 'retention.test',
      freshnessPolicyRef: 'freshness.test',
    })
    gateway.state.rawDbHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, created_at
      ) VALUES (?, ?, ?, 'text/plain', 4, ?, 'not_started', ?)
    `).run(
      VERSION_ID,
      source.sourceId,
      `sha256:${'a'.repeat(64)}`,
      `sources/${source.sourceId}/versions/${VERSION_ID}/original`,
      Date.now(),
    )
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'public-source-job-replay',
      workspaceId,
      profileId: 'mini',
      purpose: 'contract-replay',
      operations: ['source_jobs.create', 'source_jobs.read'],
    })
    const token = (issued.body as { token: string }).token
    const url = `http://127.0.0.1:${gateway.port}/api/v1/sources/${source.sourceId}/versions/${VERSION_ID}/jobs`
    const request = (target: string) => fetch(target, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': '87878787-abab-4878-8878-878787878787',
      },
      body: JSON.stringify({ operation: 'inspect_format' }),
    })
    const firstResponse = await request(url)
    expect(firstResponse.status).toBe(202)
    const first = await firstResponse.json() as { jobId: string }
    const persisted = gateway.state.rawDbHandle.prepare(`
      SELECT result_json FROM run_idempotency
      WHERE operation = 'source_jobs.create'
        AND idempotency_key = '87878787-abab-4878-8878-878787878787'
    `).get() as { result_json: string }
    gateway.state.rawDbHandle.prepare(`
      UPDATE run_idempotency SET result_json = ?
      WHERE operation = 'source_jobs.create'
        AND idempotency_key = '87878787-abab-4878-8878-878787878787'
    `).run(JSON.stringify({
      ...JSON.parse(persisted.result_json),
      claimToken: 'private-claim-canary',
      objectKey: '/private/source/object',
    }))
    await gateway.stop({ cleanup: false })

    restarted = new OwnwareGateway({
      port: 0,
      profilesDir: join(cleanupDir, 'profiles'),
      dataDir: join(cleanupDir, 'data'),
      dbPath: join(cleanupDir, 'test.db'),
      tls: false,
      disableAuth: false,
      disableSourceWorker: true,
    })
    await restarted.start()
    const replay = await request(
      `http://127.0.0.1:${restarted.port}/api/v1/sources/${source.sourceId}/versions/${VERSION_ID}/jobs`,
    )
    expect(replay.status).toBe(202)
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    const replayed = await replay.json()
    expect(replayed).toEqual(first)
    expect(JSON.stringify(replayed)).not.toContain('private-claim-canary')
    expect(JSON.stringify(replayed)).not.toContain('/private/source/object')
    expect((restarted.state.rawDbHandle.prepare(
      'SELECT COUNT(*) AS count FROM source_jobs WHERE source_version_id = ?',
    ).get(VERSION_ID) as { count: number }).count).toBe(1)
  }, 20_000)

  it('requeues an expired claim from its last verified checkpoint', async () => {
    const gateway = await createTestGateway({
      disableAuth: false,
      disableSourceWorker: true,
    })
    cleanupDir = gateway.tmpDir
    const workspaceId = gateway.state.createWorkspace(gateway.tmpDir, 'Job restart').id
    const source = new SourceStore(gateway.state.rawDbHandle).create({
      workspaceId,
      profileId: 'mini',
      kind: 'file',
      label: 'Synthetic restart source',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.test',
      sensitivityPolicyRef: 'sensitivity.test',
      purposePolicyRef: 'purpose.test',
      retentionPolicyRef: 'retention.test',
      freshnessPolicyRef: 'freshness.test',
    })
    gateway.state.rawDbHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, created_at
      ) VALUES (?, ?, ?, 'text/plain', 4, ?, 'not_started', ?)
    `).run(
      VERSION_ID,
      source.sourceId,
      `sha256:${'a'.repeat(64)}`,
      `sources/${source.sourceId}/versions/${VERSION_ID}/original`,
      Date.now(),
    )
    const jobs = new SourceJobStore(gateway.state.rawDbHandle)
    const jobCreatedAt = Date.now() - SOURCE_JOB_LEASE_MS - 2_000
    const job = jobs.enqueue({
      workspaceId,
      profileId: 'mini',
      sourceId: source.sourceId,
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
    }, jobCreatedAt)
    const claimTime = jobCreatedAt + 100
    const claim = jobs.claimNext('restart-worker', claimTime)!
    expect(jobs.advanceCheckpoint(
      job.jobId, claim.claimToken, 0, 1, claimTime + 100,
    )).toBe('advanced')
    await gateway.stop({ cleanup: false })

    restarted = new OwnwareGateway({
      port: 0,
      profilesDir: join(cleanupDir, 'profiles'),
      dataDir: join(cleanupDir, 'data'),
      dbPath: join(cleanupDir, 'test.db'),
      tls: false,
      disableAuth: false,
      disableSourceWorker: true,
    })
    await restarted.start()
    const recovered = new SourceJobStore(restarted.state.rawDbHandle)
    expect(recovered.getScoped(job.jobId, workspaceId, 'mini')).toMatchObject({
      state: 'queued', attempt: 1, checkpoint: 1,
    })
    const resumed = recovered.claimNext('restart-worker-2')!
    expect(resumed).toMatchObject({
      jobId: job.jobId, attempt: 2, checkpoint: 1,
    })
    expect(resumed.claimToken).not.toBe(claim.claimToken)
  }, 20_000)

  it('resumes queued inspection with the bounded worker after restart', async () => {
    const gateway = await createTestGateway({
      disableAuth: false,
      disableSourceWorker: true,
    })
    cleanupDir = gateway.tmpDir
    const workspaceId = gateway.state.createWorkspace(
      gateway.tmpDir,
      'Inspection restart',
    ).id
    const source = new SourceStore(gateway.state.rawDbHandle).create({
      workspaceId,
      profileId: 'mini',
      kind: 'file',
      label: 'Synthetic inspection restart source',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.test',
      sensitivityPolicyRef: 'sensitivity.test',
      purposePolicyRef: 'purpose.test',
      retentionPolicyRef: 'retention.test',
      freshnessPolicyRef: 'freshness.test',
    })
    const bytes = Buffer.from('Synthetic restart inspection evidence.\n', 'utf8')
    const objectKey = `sources/${source.sourceId}/versions/${WORKER_VERSION_ID}/original`
    const objectPath = join(gateway.tmpDir, 'data', 'source-storage', objectKey)
    await mkdir(dirname(objectPath), { recursive: true, mode: 0o700 })
    await writeFile(objectPath, bytes, { mode: 0o600 })
    const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    gateway.state.rawDbHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, created_at
      ) VALUES (?, ?, ?, 'text/plain', ?, ?, 'not_started', ?)
    `).run(
      WORKER_VERSION_ID,
      source.sourceId,
      checksum,
      bytes.length,
      objectKey,
      Date.now(),
    )
    gateway.state.rawDbHandle.prepare(`
      UPDATE runtime_sources SET registration_state = 'registered',
        current_version_id = ?, freshness_state = 'fresh', updated_at = ?
      WHERE source_id = ?
    `).run(WORKER_VERSION_ID, Date.now(), source.sourceId)
    const job = new SourceJobStore(gateway.state.rawDbHandle).enqueue({
      workspaceId,
      profileId: 'mini',
      sourceId: source.sourceId,
      sourceVersionId: WORKER_VERSION_ID,
      operation: 'inspect_format',
    })
    await gateway.stop({ cleanup: false })

    restarted = new OwnwareGateway({
      port: 0,
      profilesDir: join(cleanupDir, 'profiles'),
      dataDir: join(cleanupDir, 'data'),
      dbPath: join(cleanupDir, 'test.db'),
      tls: false,
      disableAuth: false,
    })
    await restarted.start()
    const restartedJobs = new SourceJobStore(restarted.state.rawDbHandle)
    await waitFor(() => restartedJobs.getScoped(
      job.jobId,
      workspaceId,
      'mini',
    )?.state === 'succeeded')

    expect(restartedJobs.getScoped(job.jobId, workspaceId, 'mini')).toMatchObject({
      state: 'succeeded', attempt: 1, checkpoint: 4,
      outcomeCode: 'inspection_complete',
    })
    expect(restarted.state.rawDbHandle.prepare(`
      SELECT inspection_state FROM source_versions WHERE source_version_id = ?
    `).get(WORKER_VERSION_ID)).toEqual({ inspection_state: 'complete' })
    expect(restarted.state.rawDbHandle.prepare(`
      SELECT inspection_state FROM runtime_sources WHERE source_id = ?
    `).get(source.sourceId)).toEqual({ inspection_state: 'complete' })
  }, 20_000)

  it('resumes queued text preparation and publishes one resource after restart', async () => {
    const gateway = await createTestGateway({
      disableAuth: false,
      disableSourceWorker: true,
    })
    cleanupDir = gateway.tmpDir
    const workspaceId = gateway.state.createWorkspace(
      gateway.tmpDir,
      'Preparation restart',
    ).id
    const source = new SourceStore(gateway.state.rawDbHandle).create({
      workspaceId,
      profileId: 'mini',
      kind: 'file',
      label: 'Synthetic preparation restart source',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.test',
      sensitivityPolicyRef: 'sensitivity.test',
      purposePolicyRef: 'purpose.test',
      retentionPolicyRef: 'retention.test',
      freshnessPolicyRef: 'freshness.test',
    })
    const bytes = Buffer.from('Synthetic restart preparation evidence.\n', 'utf8')
    const objectKey = `sources/${source.sourceId}/versions/${WORKER_VERSION_ID}/original`
    const objectPath = join(gateway.tmpDir, 'data', 'source-storage', objectKey)
    await mkdir(dirname(objectPath), { recursive: true, mode: 0o700 })
    await writeFile(objectPath, bytes, { mode: 0o600 })
    const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    gateway.state.rawDbHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, preparation_state, created_at
      ) VALUES (?, ?, ?, 'text/plain', ?, ?, 'complete', 'not_requested', ?)
    `).run(
      WORKER_VERSION_ID,
      source.sourceId,
      checksum,
      bytes.length,
      objectKey,
      Date.now(),
    )
    gateway.state.rawDbHandle.prepare(`
      UPDATE runtime_sources SET registration_state = 'registered',
        current_version_id = ?, inspection_state = 'complete',
        freshness_state = 'fresh', updated_at = ? WHERE source_id = ?
    `).run(WORKER_VERSION_ID, Date.now(), source.sourceId)
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'public-preparation-restart', workspaceId, profileId: 'mini',
      purpose: 'contract-replay',
      operations: ['source_preparations.create', 'source_jobs.read', 'source_resources.read'],
    })
    const token = (issued.body as { token: string }).token
    const path = `/api/v1/sources/${source.sourceId}/versions/${WORKER_VERSION_ID}/preparations`
    const request = (baseUrl: string) => fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': '93939393-abab-4939-8939-939393939393',
      },
      body: JSON.stringify({ operation: 'extract_text' }),
    })
    const firstResponse = await request(`http://127.0.0.1:${gateway.port}`)
    expect(firstResponse.status).toBe(202)
    const job = await firstResponse.json() as { jobId: string }
    await gateway.stop({ cleanup: false })

    restarted = new OwnwareGateway({
      port: 0,
      profilesDir: join(cleanupDir, 'profiles'),
      dataDir: join(cleanupDir, 'data'),
      dbPath: join(cleanupDir, 'test.db'),
      tls: false,
      disableAuth: false,
    })
    await restarted.start()
    const replay = await request(`http://127.0.0.1:${restarted.port}`)
    expect(replay.status).toBe(202)
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    expect(await replay.json()).toEqual(job)
    expect((restarted.state.rawDbHandle.prepare(`
      SELECT COUNT(*) AS count FROM source_jobs
      WHERE source_version_id = ? AND operation = 'extract_text'
    `).get(WORKER_VERSION_ID) as { count: number }).count).toBe(1)
    const restartedJobs = new SourceJobStore(restarted.state.rawDbHandle)
    await waitFor(() => restartedJobs.getScoped(
      job.jobId, workspaceId, 'mini',
    )?.state === 'succeeded')

    expect(restartedJobs.getScoped(job.jobId, workspaceId, 'mini')).toMatchObject({
      operation: 'extract_text', state: 'succeeded', attempt: 1, checkpoint: 4,
      outcomeCode: 'preparation_complete',
    })
    expect(restarted.state.rawDbHandle.prepare(`
      SELECT kind, freshness, byte_count FROM source_derived_resources WHERE job_id = ?
    `).get(job.jobId)).toEqual({
      kind: 'text_extraction', freshness: 'current', byte_count: bytes.length,
    })
  }, 20_000)

  it('resumes queued Data View preparation through the combined worker after restart', async () => {
    const gateway = await createTestGateway({
      disableAuth: false,
      disableSourceWorker: true,
    })
    cleanupDir = gateway.tmpDir
    const workspaceId = gateway.state.createWorkspace(
      gateway.tmpDir,
      'Data View preparation restart',
    ).id
    const source = new SourceStore(gateway.state.rawDbHandle).create({
      workspaceId,
      profileId: 'mini',
      kind: 'structured_export',
      label: 'Synthetic CSV restart source',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.test',
      sensitivityPolicyRef: 'sensitivity.test',
      purposePolicyRef: 'purpose.test',
      retentionPolicyRef: 'retention.test',
      freshnessPolicyRef: 'freshness.test',
    })
    const csv = Buffer.from('name,formula\nAda,=2+2')
    const objectKey = `sources/${source.sourceId}/versions/${WORKER_VERSION_ID}/original`
    const objectPath = join(gateway.tmpDir, 'data', 'source-storage', objectKey)
    await mkdir(dirname(objectPath), { recursive: true, mode: 0o700 })
    await writeFile(objectPath, csv, { mode: 0o600 })
    const checksum = `sha256:${createHash('sha256').update(csv).digest('hex')}`
    gateway.state.rawDbHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, preparation_state, created_at
      ) VALUES (?, ?, ?, 'text/plain', ?, ?, 'complete', 'not_requested', ?)
    `).run(
      WORKER_VERSION_ID, source.sourceId, checksum, csv.length, objectKey, Date.now(),
    )
    gateway.state.rawDbHandle.prepare(`
      UPDATE runtime_sources SET registration_state = 'registered',
        current_version_id = ?, inspection_state = 'complete',
        freshness_state = 'fresh', updated_at = ? WHERE source_id = ?
    `).run(WORKER_VERSION_ID, Date.now(), source.sourceId)
    const job = new SourceDataViewStore(gateway.state.rawDbHandle).enqueue({
      workspaceId,
      profileId: 'mini',
      sourceId: source.sourceId,
      sourceVersionId: WORKER_VERSION_ID,
    })
    await gateway.stop({ cleanup: false })

    restarted = new OwnwareGateway({
      port: 0,
      profilesDir: join(cleanupDir, 'profiles'),
      dataDir: join(cleanupDir, 'data'),
      dbPath: join(cleanupDir, 'test.db'),
      tls: false,
      disableAuth: false,
    })
    await restarted.start()
    const restartedViews = new SourceDataViewStore(restarted.state.rawDbHandle)
    await waitFor(() => restartedViews.getJobScoped(
      job.jobId, workspaceId, 'mini',
    )?.state === 'succeeded')

    const completed = restartedViews.getJobScoped(job.jobId, workspaceId, 'mini')!
    expect(completed).toMatchObject({
      state: 'succeeded', attempt: 1, checkpoint: 4,
      outcomeCode: 'preparation_complete',
      dataViewId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(restartedViews.getViewScoped(
      completed.dataViewId!, workspaceId, 'mini',
    )).toMatchObject({
      sourceVersionId: WORKER_VERSION_ID,
      fieldCount: 2,
      rowCount: 1,
      freshness: 'current',
    })
  }, 20_000)
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for source inspection')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
