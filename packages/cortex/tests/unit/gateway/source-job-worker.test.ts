import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import {
  SourceByteStore,
  SourceByteStoreError,
} from '../../../src/gateway/source-byte-store.js'
import {
  SOURCE_INSPECTION_MAX_BYTES,
  SOURCE_INSPECTION_RETRY_MS,
  SourceJobWorker,
  type SourceJobReader,
} from '../../../src/gateway/source-job-worker.js'
import { SourceJobStore } from '../../../src/gateway/source-job-store.js'
import { SourceStore } from '../../../src/gateway/source-store.js'

const WORKSPACE_ID = 'workspace-a'
const PROFILE_ID = 'mini'
const TEXT_VERSION_ID = '11111111-1111-4111-8111-111111111111'
const PDF_VERSION_ID = '22222222-2222-4222-8222-222222222222'

describe('SourceJobWorker', () => {
  let dir: string
  let storageRoot: string
  let database: CortexDatabase
  let jobs: SourceJobStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'source-job-worker-'))
    storageRoot = join(dir, 'source-storage')
    database = new CortexDatabase(join(dir, 'ownware.db'))
    jobs = new SourceJobStore(database.rawMainHandle)
  })

  afterEach(async () => {
    database.close()
    await rm(dir, { recursive: true, force: true })
  })

  it.each([
    {
      name: 'strict UTF-8 text',
      versionId: TEXT_VERSION_ID,
      mediaType: 'text/plain' as const,
      bytes: Buffer.from('Synthetic inspection evidence.\n', 'utf8'),
    },
    {
      name: 'bounded PDF shape',
      versionId: PDF_VERSION_ID,
      mediaType: 'application/pdf' as const,
      bytes: Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'ascii'),
    },
  ])('completes $name without retaining content or a private locator', async ({
    versionId,
    mediaType,
    bytes,
  }) => {
    const target = await seedPlacedVersion(versionId, mediaType, bytes)
    const job = jobs.enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId: target.sourceId,
      sourceVersionId: versionId,
      operation: 'inspect_format',
    }, 100)
    const worker = new SourceJobWorker(
      jobs,
      new SourceByteStore(storageRoot),
      { workerId: 'inspection-test' },
    )

    expect(await worker.runAvailable(200)).toBe(1)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'succeeded',
      checkpoint: 4,
      outcomeCode: 'inspection_complete',
    })
    expect(database.rawMainHandle.prepare(`
      SELECT inspection_state FROM source_versions WHERE source_version_id = ?
    `).get(versionId)).toEqual({ inspection_state: 'complete' })
    expect(database.rawMainHandle.prepare(`
      SELECT inspection_state FROM runtime_sources WHERE source_id = ?
    `).get(target.sourceId)).toEqual({ inspection_state: 'complete' })

    const exposed = JSON.stringify(
      jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID),
    )
    expect(exposed).not.toContain(bytes.toString('utf8'))
    expect(exposed).not.toContain(target.objectKey)
    expect(exposed).not.toContain(storageRoot)
  })

  it('dispatches bounded text preparation into one content-free resource manifest', async () => {
    const bytes = Buffer.from('Synthetic preparation evidence.\n', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', bytes)
    markInspected(target.sourceId, TEXT_VERSION_ID)
    const job = jobs.enqueuePreparation({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId: target.sourceId,
      sourceVersionId: TEXT_VERSION_ID,
    }, 100)

    expect(await realWorker('preparation-test').runAvailable(200)).toBe(1)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      operation: 'extract_text',
      state: 'succeeded',
      checkpoint: 4,
      outcomeCode: 'preparation_complete',
    })
    const resource = database.rawMainHandle.prepare(`
      SELECT * FROM source_derived_resources WHERE job_id = ?
    `).get(job.jobId) as Record<string, unknown>
    expect(resource).toMatchObject({
      source_id: target.sourceId,
      source_version_id: TEXT_VERSION_ID,
      kind: 'text_extraction',
      operation: 'extract_text',
      byte_start: 0,
      byte_end: bytes.length,
      byte_count: bytes.length,
      coverage: 'complete',
      freshness: 'current',
      stale_at: null,
    })
    const retained = JSON.stringify(resource)
    expect(retained).not.toContain(bytes.toString('utf8'))
    expect(retained).not.toContain(target.objectKey)
    expect(retained).not.toContain(storageRoot)
  })

  it('finishes an old in-flight preparation as stale without relabelling the new version', async () => {
    const bytes = Buffer.from('Version one preparation', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', bytes)
    markInspected(target.sourceId, TEXT_VERSION_ID)
    const job = jobs.enqueuePreparation({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId: target.sourceId,
      sourceVersionId: TEXT_VERSION_ID,
    }, 100)
    const deferred = createDeferredInspection()
    const running = new SourceJobWorker(jobs, deferred.reader, {
      workerId: 'stale-preparation-test',
    }).runOne(200)
    await deferred.started

    database.rawMainHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, preparation_state, created_at
      ) VALUES (?, ?, ?, 'text/plain', 4, ?, 'not_started', 'not_requested', 210)
    `).run(
      PDF_VERSION_ID,
      target.sourceId,
      `sha256:${'b'.repeat(64)}`,
      `sources/${target.sourceId}/versions/${PDF_VERSION_ID}/original`,
    )
    database.rawMainHandle.prepare(`
      UPDATE runtime_sources SET revision = revision + 1, current_version_id = ?,
        inspection_state = 'not_started', preparation_state = 'not_requested',
        updated_at = 210 WHERE source_id = ?
    `).run(PDF_VERSION_ID, target.sourceId)
    deferred.resolve(inspected(bytes, 'text/plain'))
    expect(await running).toBe(true)

    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'succeeded', outcomeCode: 'preparation_complete',
    })
    expect(database.rawMainHandle.prepare(`
      SELECT freshness, stale_at FROM source_derived_resources WHERE job_id = ?
    `).get(job.jobId)).toEqual({ freshness: 'stale', stale_at: 200 })
    expect(database.rawMainHandle.prepare(`
      SELECT preparation_state FROM runtime_sources WHERE source_id = ?
    `).get(target.sourceId)).toEqual({ preparation_state: 'not_requested' })
  })

  it('publishes no resource when in-flight preparation is cancelled', async () => {
    const bytes = Buffer.from('Cancellation preparation evidence', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', bytes)
    markInspected(target.sourceId, TEXT_VERSION_ID)
    const job = jobs.enqueuePreparation({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId: target.sourceId,
      sourceVersionId: TEXT_VERSION_ID,
    }, 100)
    const deferred = createDeferredInspection()
    const running = new SourceJobWorker(jobs, deferred.reader, {
      workerId: 'cancel-preparation-test',
    }).runOne(200)
    await deferred.started
    expect(jobs.requestCancel(job.jobId, WORKSPACE_ID, PROFILE_ID, 201)).toBe('requested')
    deferred.resolve(inspected(bytes, 'text/plain'))
    expect(await running).toBe(true)

    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'cancelled', outcomeCode: 'cancelled',
    })
    expect(database.rawMainHandle.prepare(`
      SELECT COUNT(*) AS count FROM source_derived_resources WHERE job_id = ?
    `).get(job.jobId)).toEqual({ count: 0 })
    expect(database.rawMainHandle.prepare(`
      SELECT preparation_state FROM source_versions WHERE source_version_id = ?
    `).get(TEXT_VERSION_ID)).toEqual({ preparation_state: 'not_requested' })
  })

  it('rolls back resource publication when the preparation commit fails', async () => {
    const bytes = Buffer.from('Atomic preparation evidence', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', bytes)
    markInspected(target.sourceId, TEXT_VERSION_ID)
    const job = jobs.enqueuePreparation({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId: target.sourceId,
      sourceVersionId: TEXT_VERSION_ID,
    }, 100)
    database.rawMainHandle.exec(`
      CREATE TRIGGER fail_source_preparation_commit
      BEFORE INSERT ON source_derived_resources
      BEGIN SELECT RAISE(ABORT, 'private preparation failure /do/not/expose'); END;
    `)

    expect(await realWorker('atomic-preparation-test').runAvailable(200)).toBe(1)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'waiting_for_resource', attempt: 1, checkpoint: 3, outcomeCode: null,
    })
    expect(database.rawMainHandle.prepare(`
      SELECT COUNT(*) AS count FROM source_derived_resources WHERE job_id = ?
    `).get(job.jobId)).toEqual({ count: 0 })
    expect(database.rawMainHandle.prepare(`
      SELECT preparation_state FROM source_versions WHERE source_version_id = ?
    `).get(TEXT_VERSION_ID)).toEqual({ preparation_state: 'queued' })
    expect(JSON.stringify(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)))
      .not.toContain('/do/not/expose')
  })

  it('reports preparation timeout without publishing a partial resource', async () => {
    const bytes = Buffer.from('Timeout preparation evidence', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', bytes)
    markInspected(target.sourceId, TEXT_VERSION_ID)
    const job = jobs.enqueuePreparation({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId: target.sourceId,
      sourceVersionId: TEXT_VERSION_ID,
    }, 100)
    const reader: SourceJobReader = {
      inspectPlaced: async () => {
        throw new SourceByteStoreError('inspection_timeout')
      },
    }

    expect(await new SourceJobWorker(jobs, reader, {
      workerId: 'timeout-preparation-test',
    }).runAvailable(200)).toBe(1)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'failed', outcomeCode: 'preparation_timeout',
    })
    expect(database.rawMainHandle.prepare(`
      SELECT COUNT(*) AS count FROM source_derived_resources WHERE job_id = ?
    `).get(job.jobId)).toEqual({ count: 0 })
  })

  it.each([
    {
      name: 'invalid UTF-8',
      bytes: Buffer.from([0xc3, 0x28]),
      expectedCode: 'source_format_invalid',
    },
    {
      name: 'embedded NUL data',
      bytes: Buffer.from('hostile\0text', 'utf8'),
      expectedCode: 'source_storage_inconsistent',
    },
  ])('fails closed for $name without retaining raw diagnostics', async ({
    bytes,
    expectedCode,
  }) => {
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', bytes)
    const job = enqueue(target.sourceId, TEXT_VERSION_ID)
    const worker = realWorker()

    expect(await worker.runAvailable(200)).toBe(1)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'failed', checkpoint: 1, outcomeCode: expectedCode,
    })
    expect(inspectionStates(target.sourceId, TEXT_VERSION_ID)).toEqual({
      source: 'failed', version: 'failed',
    })
    expect(JSON.stringify(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)))
      .not.toContain(bytes.toString('hex'))
  })

  it('fails closed when the private object is missing', async () => {
    const bytes = Buffer.from('Synthetic source', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', bytes)
    await rm(join(storageRoot, target.objectKey))
    const job = enqueue(target.sourceId, TEXT_VERSION_ID)

    expect(await realWorker().runAvailable(200)).toBe(1)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'failed', outcomeCode: 'source_object_missing',
    })
    expect(inspectionStates(target.sourceId, TEXT_VERSION_ID)).toEqual({
      source: 'failed', version: 'failed',
    })
  })

  it('records the fixed inspection timeout without exposing a reader error', async () => {
    const bytes = Buffer.from('Synthetic source', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', bytes)
    const job = enqueue(target.sourceId, TEXT_VERSION_ID)
    const reader: SourceJobReader = {
      inspectPlaced: async () => {
        throw new SourceByteStoreError('inspection_timeout')
      },
    }

    expect(await new SourceJobWorker(jobs, reader, {
      workerId: 'timeout-test',
    }).runAvailable(200)).toBe(1)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'failed', checkpoint: 1, outcomeCode: 'inspection_timeout',
    })
  })

  it('stops reading beyond the fixed byte budget', async () => {
    const original = Buffer.from('small', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', original)
    await writeFile(
      join(storageRoot, target.objectKey),
      Buffer.alloc(SOURCE_INSPECTION_MAX_BYTES + 1, 0x61),
    )
    const job = enqueue(target.sourceId, TEXT_VERSION_ID)

    expect(await realWorker().runAvailable(200)).toBe(1)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'failed', outcomeCode: 'source_object_oversized',
    })
  })

  it('rejects a valid-format object whose immutable size or checksum changed', async () => {
    const original = Buffer.from('original', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', original)
    await writeFile(join(storageRoot, target.objectKey), Buffer.from('tampered', 'utf8'))
    const job = enqueue(target.sourceId, TEXT_VERSION_ID)

    expect(await realWorker().runAvailable(200)).toBe(1)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'failed', outcomeCode: 'source_object_mismatch',
    })
  })

  it('refuses a corrupted private object key that traverses outside storage', async () => {
    const bytes = Buffer.from('Synthetic source', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', bytes)
    await writeFile(join(dir, 'outside'), bytes, { mode: 0o600 })
    database.rawMainHandle.prepare(`
      UPDATE source_versions SET object_key = '../outside'
      WHERE source_version_id = ?
    `).run(TEXT_VERSION_ID)
    const job = enqueue(target.sourceId, TEXT_VERSION_ID)

    expect(await realWorker().runAvailable(200)).toBe(1)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'failed', outcomeCode: 'source_storage_inconsistent',
    })
  })

  it('completes only the exact version when the logical source advances', async () => {
    const bytes = Buffer.from('Version one', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', bytes)
    const job = enqueue(target.sourceId, TEXT_VERSION_ID)
    const deferred = createDeferredInspection()
    const running = new SourceJobWorker(jobs, deferred.reader, {
      workerId: 'version-fence-test',
    }).runOne(200)
    await deferred.started

    database.rawMainHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, created_at
      ) VALUES (?, ?, ?, 'text/plain', 4, ?, 'not_started', 210)
    `).run(
      PDF_VERSION_ID,
      target.sourceId,
      `sha256:${'b'.repeat(64)}`,
      `sources/${target.sourceId}/versions/${PDF_VERSION_ID}/original`,
    )
    database.rawMainHandle.prepare(`
      UPDATE runtime_sources SET current_version_id = ?,
        inspection_state = 'not_started', updated_at = 210
      WHERE source_id = ?
    `).run(PDF_VERSION_ID, target.sourceId)
    deferred.resolve(inspected(bytes, 'text/plain'))
    expect(await running).toBe(true)

    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'succeeded', outcomeCode: 'inspection_complete',
    })
    expect(inspectionStates(target.sourceId, TEXT_VERSION_ID)).toEqual({
      source: 'not_started', version: 'complete',
    })
    expect(database.rawMainHandle.prepare(`
      SELECT inspection_state FROM source_versions WHERE source_version_id = ?
    `).get(PDF_VERSION_ID)).toEqual({ inspection_state: 'not_started' })
  })

  it('keeps cancellation as a request until in-flight inspection yields', async () => {
    const bytes = Buffer.from('Synthetic source', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', bytes)
    const job = enqueue(target.sourceId, TEXT_VERSION_ID)
    const deferred = createDeferredInspection()
    const running = new SourceJobWorker(jobs, deferred.reader, {
      workerId: 'cancellation-test',
    }).runOne(200)
    await deferred.started

    expect(jobs.requestCancel(
      job.jobId, WORKSPACE_ID, PROFILE_ID, 200,
    )).toBe('requested')
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'cancel_requested', terminalAt: null,
    })
    deferred.resolve(inspected(bytes, 'text/plain'))
    expect(await running).toBe(true)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'cancelled', outcomeCode: 'cancelled', terminalAt: 200,
    })
    expect(inspectionStates(target.sourceId, TEXT_VERSION_ID)).toEqual({
      source: 'not_started', version: 'not_started',
    })
  })

  it('confirms a queued cancellation when the worker is woken', async () => {
    const bytes = Buffer.from('Synthetic source', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', bytes)
    const job = enqueue(target.sourceId, TEXT_VERSION_ID)
    expect(jobs.requestCancel(job.jobId, WORKSPACE_ID, PROFILE_ID, 200))
      .toBe('requested')

    expect(await realWorker().runAvailable(210)).toBe(1)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'cancelled', cancelRequestedAt: 200, terminalAt: 210,
    })
  })

  it('confirms cancellation when an unavailable in-flight reader yields', async () => {
    const bytes = Buffer.from('Synthetic source', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', bytes)
    const job = enqueue(target.sourceId, TEXT_VERSION_ID)
    const deferred = createDeferredFailure()
    const running = new SourceJobWorker(jobs, deferred.reader, {
      workerId: 'failure-cancellation-test',
    }).runOne(200)
    await deferred.started
    expect(jobs.requestCancel(job.jobId, WORKSPACE_ID, PROFILE_ID, 201))
      .toBe('requested')

    deferred.reject(new Error('private reader failure'))
    expect(await running).toBe(true)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'cancelled', outcomeCode: 'cancelled', terminalAt: 200,
    })
  })

  it('fences an expired worker after another claimant completes the job', async () => {
    const bytes = Buffer.from('Synthetic source', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', bytes)
    const job = enqueue(target.sourceId, TEXT_VERSION_ID)
    const deferred = createDeferredInspection()
    const staleRun = new SourceJobWorker(jobs, deferred.reader, {
      workerId: 'stale-worker',
    }).runOne(200)
    await deferred.started

    expect(jobs.recoverExpiredClaims(30_201)).toMatchObject({ requeued: 1 })
    expect(await realWorker('replacement-worker').runAvailable(30_202)).toBe(1)
    deferred.resolve(inspected(bytes, 'text/plain'))
    expect(await staleRun).toBe(true)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'succeeded', attempt: 2, checkpoint: 4,
      outcomeCode: 'inspection_complete',
    })
  })

  it('retries an unavailable reader three times, then fails with a safe code', async () => {
    const bytes = Buffer.from('Synthetic source', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', bytes)
    const job = enqueue(target.sourceId, TEXT_VERSION_ID)
    const reader: SourceJobReader = {
      inspectPlaced: async () => { throw new Error('private failure /do/not/expose') },
    }
    const worker = new SourceJobWorker(jobs, reader, {
      workerId: 'retry-test',
    })

    expect(await worker.runOne(200)).toBe(true)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'waiting_for_resource', attempt: 1, checkpoint: 1,
    })
    expect(inspectionStates(target.sourceId, TEXT_VERSION_ID)).toEqual({
      source: 'queued', version: 'queued',
    })
    expect(await worker.runOne(200 + SOURCE_INSPECTION_RETRY_MS - 1)).toBe(false)
    expect(await worker.runOne(200 + SOURCE_INSPECTION_RETRY_MS)).toBe(true)
    expect(await worker.runOne(200 + (2 * SOURCE_INSPECTION_RETRY_MS))).toBe(true)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'failed', attempt: 3, checkpoint: 1,
      outcomeCode: 'inspection_unavailable',
    })
    expect(JSON.stringify(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)))
      .not.toContain('/do/not/expose')
  })

  it('rolls back target truth when the atomic terminal update is injected to fail', async () => {
    const bytes = Buffer.from('Synthetic source', 'utf8')
    const target = await seedPlacedVersion(TEXT_VERSION_ID, 'text/plain', bytes)
    const job = enqueue(target.sourceId, TEXT_VERSION_ID)
    database.rawMainHandle.exec(`
      CREATE TRIGGER fail_source_inspection_commit
      BEFORE UPDATE OF inspection_state ON runtime_sources
      WHEN NEW.inspection_state = 'complete'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic commit failure with /private/path');
      END;
    `)

    expect(await realWorker().runAvailable(200)).toBe(1)
    expect(jobs.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'waiting_for_resource', attempt: 1, checkpoint: 3,
      outcomeCode: null,
    })
    expect(inspectionStates(target.sourceId, TEXT_VERSION_ID)).toEqual({
      source: 'queued', version: 'queued',
    })
  })

  function enqueue(sourceId: string, sourceVersionId: string) {
    return jobs.enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      sourceVersionId,
      operation: 'inspect_format',
    }, 100)
  }

  function realWorker(workerId = 'inspection-test'): SourceJobWorker {
    return new SourceJobWorker(
      jobs,
      new SourceByteStore(storageRoot),
      { workerId },
    )
  }

  function inspectionStates(sourceId: string, versionId: string) {
    const version = database.rawMainHandle.prepare(`
      SELECT inspection_state FROM source_versions WHERE source_version_id = ?
    `).get(versionId) as { inspection_state: string }
    const source = database.rawMainHandle.prepare(`
      SELECT inspection_state FROM runtime_sources WHERE source_id = ?
    `).get(sourceId) as { inspection_state: string }
    return { source: source.inspection_state, version: version.inspection_state }
  }

  function markInspected(sourceId: string, versionId: string): void {
    database.rawMainHandle.prepare(`
      UPDATE source_versions SET inspection_state = 'complete'
      WHERE source_version_id = ? AND source_id = ?
    `).run(versionId, sourceId)
    database.rawMainHandle.prepare(`
      UPDATE runtime_sources SET inspection_state = 'complete'
      WHERE source_id = ? AND current_version_id = ?
    `).run(sourceId, versionId)
  }

  async function seedPlacedVersion(
    versionId: string,
    mediaType: 'text/plain' | 'application/pdf',
    bytes: Buffer,
  ): Promise<{ readonly sourceId: string; readonly objectKey: string }> {
    const source = new SourceStore(database.rawMainHandle).create({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      kind: 'file',
      label: 'Synthetic source',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.test',
      sensitivityPolicyRef: 'sensitivity.test',
      purposePolicyRef: 'purpose.test',
      retentionPolicyRef: 'retention.test',
      freshnessPolicyRef: 'freshness.test',
    }, 10)
    const objectKey = `sources/${source.sourceId}/versions/${versionId}/original`
    const privatePath = join(storageRoot, objectKey)
    await mkdir(dirname(privatePath), { recursive: true, mode: 0o700 })
    await writeFile(privatePath, bytes, { mode: 0o600 })
    const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    database.rawMainHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'not_started', 20)
    `).run(versionId, source.sourceId, checksum, mediaType, bytes.length, objectKey)
    database.rawMainHandle.prepare(`
      UPDATE runtime_sources SET registration_state = 'registered',
        current_version_id = ?, freshness_state = 'fresh', updated_at = 20
      WHERE source_id = ?
    `).run(versionId, source.sourceId)
    return { sourceId: source.sourceId, objectKey }
  }
})

function inspected(
  bytes: Buffer,
  verifiedMediaType: 'text/plain' | 'application/pdf',
) {
  return {
    byteCount: bytes.length,
    checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    verifiedMediaType,
  } as const
}

function createDeferredInspection(): {
  readonly reader: SourceJobReader
  readonly started: Promise<void>
  resolve(value: ReturnType<typeof inspected>): void
} {
  let markStarted!: () => void
  let resolveInspection!: (value: ReturnType<typeof inspected>) => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const pending = new Promise<ReturnType<typeof inspected>>((resolve) => {
    resolveInspection = resolve
  })
  return {
    reader: {
      inspectPlaced: async () => {
        markStarted()
        return pending
      },
    },
    started,
    resolve: resolveInspection,
  }
}

function createDeferredFailure(): {
  readonly reader: SourceJobReader
  readonly started: Promise<void>
  reject(error: Error): void
} {
  let markStarted!: () => void
  let rejectInspection!: (error: Error) => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const pending = new Promise<never>((_resolve, reject) => {
    rejectInspection = reject
  })
  return {
    reader: {
      inspectPlaced: async () => {
        markStarted()
        return pending
      },
    },
    started,
    reject: rejectInspection,
  }
}
