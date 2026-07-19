import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { SourceByteStore } from '../../../src/gateway/source-byte-store.js'
import {
  SOURCE_DATA_VIEW_JOB_LEASE_MS,
  SourceDataViewStore,
} from '../../../src/gateway/source-data-view-store.js'
import { SourceJobStore } from '../../../src/gateway/source-job-store.js'
import { SourceDeletionStore } from '../../../src/gateway/source-deletion-store.js'
import {
  SourceJobWorker,
  type SourceDataViewWorkerBytes,
  type SourceJobReader,
} from '../../../src/gateway/source-job-worker.js'

const WORKSPACE_ID = 'workspace-a'
const PROFILE_ID = 'mini'
const SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const VERSION_ID = '22222222-2222-4222-8222-222222222222'
const OBJECT_KEY = `sources/${SOURCE_ID}/versions/${VERSION_ID}/original`

describe('SourceJobWorker Data View execution', () => {
  let dir: string
  let storageRoot: string
  let database: CortexDatabase
  let dataViews: SourceDataViewStore
  let bytes: SourceByteStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'source-data-view-worker-'))
    storageRoot = join(dir, 'source-storage')
    database = new CortexDatabase(join(dir, 'ownware.db'))
    dataViews = new SourceDataViewStore(database.rawMainHandle)
    bytes = new SourceByteStore(storageRoot)
  })

  afterEach(async () => {
    database.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('profiles, durably publishes and rereads one exact CSV artifact', async () => {
    const original = Buffer.from('name,formula\nAda,=2+2')
    await seed(original)
    const job = enqueue(100)

    expect(await worker(bytes).runAvailable(200)).toBe(1)

    const completed = dataViews.getJobScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)!
    expect(completed).toMatchObject({
      state: 'succeeded', checkpoint: 4, outcomeCode: 'preparation_complete',
      dataViewId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    const view = dataViews.getViewScoped(
      completed.dataViewId!, WORKSPACE_ID, PROFILE_ID,
    )!
    expect(view).toMatchObject({ fieldCount: 2, rowCount: 1, freshness: 'current' })
    const locator = dataViews.getPrivateArtifact(
      completed.dataViewId!, WORKSPACE_ID, PROFILE_ID,
    )!
    await expect(bytes.readCsvDataViewArtifact({
      ...locator,
      dataViewId: completed.dataViewId!,
      sourceVersionId: VERSION_ID,
      sourceChecksum: checksum(original),
    })).resolves.toMatchObject({
      rows: [{ values: ['Ada', '=2+2'] }],
    })
  })

  it('fails malformed CSV with a closed code and publishes no artifact', async () => {
    const original = Buffer.from('a,b\n1')
    await seed(original)
    const job = enqueue(100)

    expect(await worker(bytes).runAvailable(200)).toBe(1)

    expect(dataViews.getJobScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'failed', outcomeCode: 'csv_row_ragged', dataViewId: null,
    })
    const reserved = database.rawMainHandle.prepare(`
      SELECT data_view_id FROM source_data_view_jobs WHERE job_id = ?
    `).get(job.jobId) as { data_view_id: string }
    await expect(bytes.dataViewArtifactAbsent(SOURCE_ID, VERSION_ID, reserved.data_view_id))
      .resolves.toBe(true)
  })

  it('removes live-owned output when deletion freeze blocks publication', async () => {
    const original = Buffer.from('name\nAda')
    await seed(original)
    const job = enqueue(100)
    database.rawMainHandle.prepare(`
      UPDATE runtime_sources SET deletion_state = 'frozen' WHERE source_id = ?
    `).run(SOURCE_ID)

    expect(await worker(bytes).runAvailable(200)).toBe(1)

    const row = database.rawMainHandle.prepare(`
      SELECT state, outcome_code, data_view_id FROM source_data_view_jobs WHERE job_id = ?
    `).get(job.jobId) as { state: string; outcome_code: string; data_view_id: string }
    expect(row).toMatchObject({
      state: 'failed', outcome_code: 'data_view_publication_conflict',
    })
    await expect(bytes.dataViewArtifactAbsent(SOURCE_ID, VERSION_ID, row.data_view_id))
      .resolves.toBe(true)
  })

  it('confirms a queued deletion cancellation only after reserved output is absent', async () => {
    const original = Buffer.from('name\nAda')
    await seed(original)
    const job = enqueue(100)
    const deletions = new SourceDeletionStore(database.rawMainHandle)
    const plan = deletions.plan({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId: SOURCE_ID,
      expectedRevision: 1,
    }, 150)

    expect(deletions.claimNext('deletion-worker', 151)).toBeNull()
    expect(await worker(bytes).runOne(200)).toBe(true)
    expect(dataViews.getJobScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'cancelled', outcomeCode: 'cancelled', dataViewId: null,
    })
    const reserved = database.rawMainHandle.prepare(`
      SELECT data_view_id FROM source_data_view_jobs WHERE job_id = ?
    `).get(job.jobId) as { data_view_id: string }
    await expect(bytes.dataViewArtifactAbsent(
      SOURCE_ID, VERSION_ID, reserved.data_view_id,
    )).resolves.toBe(true)
    expect(deletions.claimNext('deletion-worker', 201)).toMatchObject({
      jobId: plan.jobId,
    })
  })

  it('cleans output written across a deletion freeze before releasing deletion', async () => {
    const original = Buffer.from('name\nAda')
    await seed(original)
    const job = enqueue(100)
    let releasePreparation!: () => void
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve
    })
    let preparationStarted!: () => void
    const started = new Promise<void>((resolve) => {
      preparationStarted = resolve
    })
    const paused: SourceJobReader & SourceDataViewWorkerBytes = {
      inspectPlaced: (...args) => bytes.inspectPlaced(...args),
      prepareCsvDataViewArtifact: async (input) => {
        preparationStarted()
        await preparationGate
        return bytes.prepareCsvDataViewArtifact(input)
      },
      removeDataViewArtifact: (...args) => bytes.removeDataViewArtifact(...args),
      dataViewArtifactAbsent: (...args) => bytes.dataViewArtifactAbsent(...args),
    }
    const running = worker(paused).runOne(200)
    await started
    const deletions = new SourceDeletionStore(database.rawMainHandle)
    const plan = deletions.plan({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId: SOURCE_ID,
      expectedRevision: 1,
    }, 201)
    expect(deletions.claimNext('deletion-worker', 202)).toBeNull()

    releasePreparation()
    await expect(running).resolves.toBe(true)
    const reserved = database.rawMainHandle.prepare(`
      SELECT data_view_id, state FROM source_data_view_jobs WHERE job_id = ?
    `).get(job.jobId) as { data_view_id: string; state: string }
    expect(reserved.state).toBe('cancelled')
    await expect(bytes.dataViewArtifactAbsent(
      SOURCE_ID, VERSION_ID, reserved.data_view_id,
    )).resolves.toBe(true)
    expect(deletions.claimNext('deletion-worker', 203)).toMatchObject({
      jobId: plan.jobId,
    })
  })

  it('preserves an expired claimant artifact for byte-identical replacement reuse', async () => {
    const original = Buffer.from('name\nAda')
    await seed(original)
    const job = enqueue(100)
    const first = dataViews.claimNext('worker-a', 200)!
    const target = dataViews.getClaimedTarget(job.jobId, first.claimToken, 201)!
    expect(dataViews.advanceCheckpoint(job.jobId, first.claimToken, 0, 1, 202))
      .toBe('advanced')
    const artifact = await bytes.prepareCsvDataViewArtifact(target)
    expect(dataViews.advanceCheckpoint(job.jobId, first.claimToken, 1, 2, 203))
      .toBe('advanced')

    const expired = 200 + SOURCE_DATA_VIEW_JOB_LEASE_MS + 1
    expect(dataViews.recoverExpiredClaims(expired)).toEqual({ requeued: 1, failed: 0 })
    expect(await worker(bytes).runAvailable(expired + 1)).toBe(1)

    expect(dataViews.getJobScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'succeeded', attempt: 2, dataViewId: first.dataViewId,
    })
    await expect(bytes.dataViewArtifactAbsent(SOURCE_ID, VERSION_ID, first.dataViewId))
      .resolves.toBe(false)
    expect(dataViews.getPrivateArtifact(
      first.dataViewId, WORKSPACE_ID, PROFILE_ID,
    )).toMatchObject({ artifactChecksum: artifact.manifest.artifactChecksum })
  })

  it('retries transient preparation failure three times, then fails explicitly', async () => {
    const original = Buffer.from('name\nAda')
    await seed(original)
    const job = enqueue(100)
    const unavailable: SourceJobReader & SourceDataViewWorkerBytes = {
      inspectPlaced: (...args) => bytes.inspectPlaced(...args),
      prepareCsvDataViewArtifact: async () => { throw new Error('synthetic unavailable') },
      removeDataViewArtifact: (...args) => bytes.removeDataViewArtifact(...args),
      dataViewArtifactAbsent: (...args) => bytes.dataViewArtifactAbsent(...args),
    }
    const running = worker(unavailable)

    expect(await running.runOne(200)).toBe(true)
    expect(dataViews.getJobScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'waiting_for_resource', attempt: 1,
    })
    expect(await running.runOne(1_200)).toBe(true)
    expect(await running.runOne(2_200)).toBe(true)
    expect(dataViews.getJobScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'failed', attempt: 3, outcomeCode: 'data_view_unavailable',
    })
  })

  function worker(reader: SourceJobReader & SourceDataViewWorkerBytes): SourceJobWorker {
    return new SourceJobWorker(
      new SourceJobStore(database.rawMainHandle),
      reader,
      { workerId: 'combined-source-worker' },
      dataViews,
    )
  }

  function enqueue(now: number) {
    return dataViews.enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId: SOURCE_ID,
      sourceVersionId: VERSION_ID,
    }, now)
  }

  async function seed(original: Buffer): Promise<void> {
    database.rawMainHandle.prepare(`
      INSERT INTO runtime_sources (
        source_id, workspace_id, profile_id, kind, label, classification,
        authority, audience_policy_ref, sensitivity_policy_ref,
        purpose_policy_ref, retention_policy_ref, freshness_policy_ref,
        revision, current_version_id, registration_state, inspection_state,
        preparation_state, access_state, freshness_state, conflict_state,
        deletion_state, created_at, updated_at
      ) VALUES (
        ?, ?, ?, 'structured_export', 'Synthetic CSV', 'internal',
        'supporting_reference', 'audience.test', 'sensitivity.test',
        'purpose.test', 'retention.test', 'freshness.test', 1, ?, 'registered',
        'complete', 'not_requested', 'available', 'fresh', 'none', 'active', 10, 10
      )
    `).run(SOURCE_ID, WORKSPACE_ID, PROFILE_ID, VERSION_ID)
    database.rawMainHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type, byte_count,
        object_key, inspection_state, preparation_state, created_at
      ) VALUES (?, ?, ?, 'text/plain', ?, ?, 'complete', 'not_requested', 10)
    `).run(VERSION_ID, SOURCE_ID, checksum(original), original.length, OBJECT_KEY)
    await mkdir(dirname(join(storageRoot, OBJECT_KEY)), { recursive: true })
    await writeFile(join(storageRoot, OBJECT_KEY), original)
  }
})

function checksum(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}
