import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { SourceJobStore, SOURCE_JOB_LEASE_MS } from '../../../src/gateway/source-job-store.js'
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
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for source inspection')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
