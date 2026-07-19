import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { SourceStore } from '../../../src/gateway/source-store.js'
import { SourceJobStore } from '../../../src/gateway/source-job-store.js'
import {
  SourceUploadRefreshConflictError,
  SourceUploadStore,
} from '../../../src/gateway/source-upload-store.js'

const WORKSPACE_ID = 'workspace-a'
const PROFILE_ID = 'mini'
describe('SourceUploadStore refresh fencing', () => {
  let dir: string
  let database: CortexDatabase
  let uploads: SourceUploadStore
  let sourceId: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'source-upload-store-'))
    database = new CortexDatabase(join(dir, 'ownware.db'))
    uploads = new SourceUploadStore(database.rawMainHandle)
    sourceId = new SourceStore(database.rawMainHandle).create({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      kind: 'text',
      label: 'Refresh source',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.test',
      sensitivityPolicyRef: 'sensitivity.test',
      purposePolicyRef: 'purpose.test',
      retentionPolicyRef: 'retention.test',
      freshnessPolicyRef: 'freshness.test',
    }, 10).sourceId
  })

  afterEach(async () => {
    database.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('captures one private base identity and rejects an out-of-order completion', () => {
    const first = createUpload(20)
    const stale = createUpload(21)
    expect(privateFence(first.uploadId)).toEqual({
      base_source_revision: 1,
      base_current_version_id: null,
    })
    expect(privateFence(stale.uploadId)).toEqual(privateFence(first.uploadId))

    const versionA = uploads.beginCompletion(first.uploadId, 30)
    uploads.finishCompletion(first.uploadId, versionInput(versionA, 'a'), 31)
    const versionB = uploads.beginCompletion(stale.uploadId, 32)
    expect(() => uploads.finishCompletion(
      stale.uploadId, versionInput(versionB, 'b'), 33,
    )).toThrow(SourceUploadRefreshConflictError)

    expect(sourceTruth()).toMatchObject({
      revision: 2,
      current_version_id: versionA,
    })
    expect(database.rawMainHandle.prepare(`
      SELECT COUNT(*) AS count FROM source_versions WHERE source_version_id = ?
    `).get(versionB)).toEqual({ count: 0 })
    expect(database.rawMainHandle.prepare(`
      SELECT state FROM source_upload_sessions WHERE upload_id = ?
    `).get(stale.uploadId)).toEqual({ state: 'completing' })
  })

  it('resets only current inspection and preparation truth after a successful refresh', () => {
    const initial = createUpload(20)
    const versionA = uploads.beginCompletion(initial.uploadId, 21)
    uploads.finishCompletion(initial.uploadId, versionInput(versionA, 'a'), 22)
    expect(database.rawMainHandle.prepare(`
      SELECT byte_reservation_released_at FROM source_upload_sessions WHERE upload_id = ?
    `).get(initial.uploadId)).toEqual({ byte_reservation_released_at: 22 })
    const resourceId = prepareCurrentVersion(versionA, 23)
    const dataViewId = prepareCurrentDataView(versionA, 23)

    const refresh = createUpload(24)
    expect(privateFence(refresh.uploadId)).toEqual({
      base_source_revision: 2,
      base_current_version_id: versionA,
    })
    const versionB = uploads.beginCompletion(refresh.uploadId, 25)
    uploads.finishCompletion(refresh.uploadId, versionInput(versionB, 'b'), 26)

    expect(sourceTruth()).toMatchObject({
      revision: 3,
      current_version_id: versionB,
      inspection_state: 'not_started',
      preparation_state: 'not_requested',
    })
    expect(database.rawMainHandle.prepare(`
      SELECT inspection_state FROM source_versions WHERE source_version_id = ?
    `).get(versionA)).toEqual({ inspection_state: 'complete' })
    expect(database.rawMainHandle.prepare(`
      SELECT freshness, stale_at FROM source_derived_resources WHERE resource_id = ?
    `).get(resourceId)).toEqual({ freshness: 'stale', stale_at: 26 })
    expect(database.rawMainHandle.prepare(`
      SELECT freshness, stale_at FROM source_data_views WHERE data_view_id = ?
    `).get(dataViewId)).toEqual({ freshness: 'stale', stale_at: 26 })
  })

  it('rolls back the version and lifecycle reset when the source CAS write fails', () => {
    const initial = createUpload(20)
    const versionA = uploads.beginCompletion(initial.uploadId, 21)
    uploads.finishCompletion(initial.uploadId, versionInput(versionA, 'a'), 22)
    const resourceId = prepareCurrentVersion(versionA, 23)
    const dataViewId = prepareCurrentDataView(versionA, 23)
    const refresh = createUpload(24)
    const versionB = uploads.beginCompletion(refresh.uploadId, 25)
    database.rawMainHandle.exec(`
      CREATE TRIGGER injected_source_refresh_failure
      BEFORE UPDATE OF current_version_id ON runtime_sources
      WHEN NEW.current_version_id = '${versionB}'
      BEGIN SELECT RAISE(ABORT, 'private refresh failure canary'); END;
    `)

    expect(() => uploads.finishCompletion(
      refresh.uploadId, versionInput(versionB, 'b'), 26,
    )).toThrow('private refresh failure canary')
    expect(sourceTruth()).toMatchObject({
      revision: 2,
      current_version_id: versionA,
      inspection_state: 'complete',
      preparation_state: 'ready',
    })
    expect(database.rawMainHandle.prepare(`
      SELECT COUNT(*) AS count FROM source_versions WHERE source_version_id = ?
    `).get(versionB)).toEqual({ count: 0 })
    expect(database.rawMainHandle.prepare(`
      SELECT freshness, stale_at FROM source_derived_resources WHERE resource_id = ?
    `).get(resourceId)).toEqual({ freshness: 'current', stale_at: null })
    expect(database.rawMainHandle.prepare(`
      SELECT freshness, stale_at FROM source_data_views WHERE data_view_id = ?
    `).get(dataViewId)).toEqual({ freshness: 'current', stale_at: null })
    expect(database.rawMainHandle.prepare(`
      SELECT byte_reservation_released_at FROM source_upload_sessions WHERE upload_id = ?
    `).get(refresh.uploadId)).toEqual({ byte_reservation_released_at: null })
  })

  function createUpload(now: number) {
    const upload = uploads.create({
      sourceId,
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      principalKey: 'delegated-test',
      expectedBytes: 4,
      expectedChecksum: `sha256:${'a'.repeat(64)}`,
      declaredMediaType: 'text/plain',
      filename: 'synthetic.txt',
    }, now)
    uploads.advanceChunk(
      upload.uploadId,
      0,
      { byteCount: 4, checksum: `sha256:${'a'.repeat(64)}` },
      now + 1,
    )
    return upload
  }

  function versionInput(versionId: string, checksumCharacter: string) {
    return {
      versionId,
      checksum: `sha256:${checksumCharacter.repeat(64)}`,
      verifiedMediaType: 'text/plain' as const,
      byteCount: 4,
      objectKey: `sources/${sourceId}/versions/${versionId}/original`,
    }
  }

  function privateFence(uploadId: string) {
    return database.rawMainHandle.prepare(`
      SELECT base_source_revision, base_current_version_id
      FROM source_upload_sessions WHERE upload_id = ?
    `).get(uploadId)
  }

  function sourceTruth() {
    return database.rawMainHandle.prepare(`
      SELECT revision, current_version_id, inspection_state, preparation_state
      FROM runtime_sources WHERE source_id = ?
    `).get(sourceId)
  }

  function prepareCurrentDataView(versionId: string, now: number): string {
    const jobId = '11111111-1111-4111-8111-111111111111'
    const dataViewId = '22222222-2222-4222-8222-222222222222'
    database.rawMainHandle.prepare(`
      INSERT INTO source_data_view_jobs (
        job_id, data_view_id, workspace_id, profile_id, source_id,
        source_version_id, implementation_version, source_revision,
        state, attempt, max_attempts, checkpoint, outcome_code,
        created_at, updated_at, terminal_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, 'csv_data_view.v1', 2,
        'succeeded', 1, 3, 4, 'preparation_complete', ?, ?, ?
      )
    `).run(
      jobId, dataViewId, WORKSPACE_ID, PROFILE_ID, sourceId, versionId,
      now, now, now,
    )
    database.rawMainHandle.prepare(`
      INSERT INTO source_data_views (
        data_view_id, job_id, workspace_id, profile_id, source_id,
        source_version_id, implementation_version, source_revision,
        source_checksum, artifact_checksum, artifact_byte_count,
        private_object_key, field_count, row_count, fields_json,
        classification, authority, audience_policy_ref,
        sensitivity_policy_ref, purpose_policy_ref, retention_policy_ref,
        freshness_policy_ref, freshness, created_at, stale_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, 'csv_data_view.v1', 2,
        ?, ?, 16, ?, 1, 1, ?,
        'internal', 'supporting_reference', 'audience.test',
        'sensitivity.test', 'purpose.test', 'retention.test',
        'freshness.test', 'current', ?, NULL
      )
    `).run(
      dataViewId, jobId, WORKSPACE_ID, PROFILE_ID, sourceId, versionId,
      `sha256:${'a'.repeat(64)}`,
      `sha256:${'b'.repeat(64)}`,
      `sources/${sourceId}/versions/${versionId}/data-views/${dataViewId}.json`,
      JSON.stringify([{ fieldId: 'field.synthetic', ordinal: 0, label: 'name' }]),
      now,
    )
    return dataViewId
  }

  function prepareCurrentVersion(versionId: string, now: number): string {
    database.rawMainHandle.prepare(`
      UPDATE source_versions SET inspection_state = 'complete'
      WHERE source_version_id = ?
    `).run(versionId)
    database.rawMainHandle.prepare(`
      UPDATE runtime_sources SET inspection_state = 'complete', updated_at = ?
      WHERE source_id = ?
    `).run(now, sourceId)
    const jobs = new SourceJobStore(database.rawMainHandle)
    const job = jobs.enqueuePreparation({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      sourceVersionId: versionId,
    }, now)
    const claim = jobs.claimNext('refresh-test-worker', now)!
    for (const checkpoint of [1, 2, 3]) {
      jobs.advanceCheckpoint(
        job.jobId, claim.claimToken, checkpoint - 1, checkpoint, now,
      )
    }
    expect(jobs.finishPreparation(
      job.jobId, claim.claimToken, 'succeeded', 'preparation_complete', now,
    )).toBe('finished')
    return claim.resourceId!
  }
})
