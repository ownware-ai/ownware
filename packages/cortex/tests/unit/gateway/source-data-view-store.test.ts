import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import {
  SourceDataViewStore,
} from '../../../src/gateway/source-data-view-store.js'
import {
  SourceQuotaExceededError,
  SourceQuotaPolicy,
  type SourceQuotaLimits,
} from '../../../src/gateway/source-quota-policy.js'
import { csvDataViewOrdinalId } from '../../../src/gateway/csv-data-view.js'
import type { PreparedCsvDataViewArtifact } from '../../../src/gateway/source-byte-store.js'

const WORKSPACE_ID = 'workspace-a'
const PROFILE_ID = 'mini'
const SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const VERSION_ID = '22222222-2222-4222-8222-222222222222'
const NEXT_VERSION_ID = '33333333-3333-4333-8333-333333333333'
const SOURCE_CHECKSUM = `sha256:${'a'.repeat(64)}`

describe('SourceDataViewStore', () => {
  let dir: string
  let database: CortexDatabase
  let store: SourceDataViewStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'source-data-view-store-'))
    database = new CortexDatabase(join(dir, 'ownware.db'))
    seed(database)
    store = new SourceDataViewStore(database.rawMainHandle)
  })

  afterEach(async () => {
    database.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('enqueues one exact eligible version, replays its identity and scopes safe job reads', () => {
    const job = enqueue(100)

    expect(job).toMatchObject({
      operation: 'prepare_data_view',
      implementationVersion: 'csv_data_view.v1',
      sourceId: SOURCE_ID,
      sourceVersionId: VERSION_ID,
      dataViewId: null,
      state: 'queued',
      attempt: 0,
      maxAttempts: 3,
      checkpoint: 0,
      createdAt: 100,
    })
    expect(enqueue(200)).toEqual(job)
    expect(store.getJobScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toEqual(job)
    expect(store.getJobScoped(job.jobId, 'workspace-b', PROFILE_ID)).toBeNull()
    expect(JSON.stringify(job)).not.toContain('object_key')
    expect(JSON.stringify(job)).not.toContain('/versions/')
  })

  it('claims through a private lease and atomically publishes a current content-free view', () => {
    const job = enqueue(100)
    const claim = store.claimNext('data-view-worker', 200)!
    expect(claim).toMatchObject({
      jobId: job.jobId,
      attempt: 1,
      checkpoint: 0,
      leaseExpiresAt: 30_200,
      dataViewId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(store.getClaimedTarget(job.jobId, claim.claimToken, 201)).toEqual({
      objectKey: `sources/${SOURCE_ID}/versions/${VERSION_ID}/original`,
      expectedByteCount: 16,
      expectedChecksum: SOURCE_CHECKSUM,
      sourceId: SOURCE_ID,
      sourceVersionId: VERSION_ID,
      dataViewId: claim.dataViewId,
    })
    advanceToPublication(claim)
    expect(store.publish(job.jobId, claim.claimToken, artifact(claim.dataViewId), 500))
      .toBe('finished')

    expect(store.getJobScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'succeeded', checkpoint: 4, dataViewId: claim.dataViewId,
      outcomeCode: 'preparation_complete', terminalAt: 500,
    })
    const view = store.getViewScoped(claim.dataViewId, WORKSPACE_ID, PROFILE_ID)
    expect(view).toMatchObject({
      dataViewId: claim.dataViewId,
      jobId: job.jobId,
      sourceVersionId: VERSION_ID,
      sourceChecksum: SOURCE_CHECKSUM,
      fieldCount: 2,
      rowCount: 1,
      freshness: 'current',
      audiencePolicyRef: 'audience.policy.test',
      sensitivityPolicyRef: 'sensitivity.policy.test',
      purposePolicyRef: 'purpose.policy.test',
      retentionPolicyRef: 'retention.policy.test',
      freshnessPolicyRef: 'freshness.policy.test',
      fields: [
        { ordinal: 0, label: 'name' },
        { ordinal: 1, label: 'formula' },
      ],
    })
    expect(JSON.stringify(view)).not.toContain('privateObjectKey')
    expect(JSON.stringify(view)).not.toContain('=2+2')
    expect(store.getViewScoped(claim.dataViewId, 'workspace-b', PROFILE_ID)).toBeNull()
    database.rawMainHandle.prepare(`
      UPDATE source_data_views SET fields_json = ? WHERE data_view_id = ?
    `).run(JSON.stringify(artifact(claim.dataViewId).manifest.fields.map((field) => ({
      ...field,
      values: ['projection-canary'],
    }))), claim.dataViewId)
    expect(JSON.stringify(
      store.getViewScoped(claim.dataViewId, WORKSPACE_ID, PROFILE_ID),
    )).not.toContain('projection-canary')
    expect(store.getPrivateArtifact(claim.dataViewId, WORKSPACE_ID, PROFILE_ID)).toEqual({
      privateObjectKey:
        `sources/${SOURCE_ID}/versions/${VERSION_ID}/data-views/${claim.dataViewId}.json`,
      artifactChecksum: `sha256:${'b'.repeat(64)}`,
      artifactByteCount: 128,
    })
    expect(store.getPrivateArtifact(claim.dataViewId, 'workspace-b', PROFILE_ID)).toBeNull()
  })

  it('fails public manifest lookup closed across deletion, lineage and field corruption', () => {
    const job = enqueue(100)
    const claim = store.claimNext('data-view-worker', 200)!
    advanceToPublication(claim)
    expect(store.publish(job.jobId, claim.claimToken, artifact(claim.dataViewId), 500))
      .toBe('finished')

    database.rawMainHandle.prepare(`
      UPDATE runtime_sources SET deletion_state = 'frozen' WHERE source_id = ?
    `).run(SOURCE_ID)
    expect(store.getViewScoped(claim.dataViewId, WORKSPACE_ID, PROFILE_ID)).toBeNull()

    database.rawMainHandle.prepare(`
      UPDATE runtime_sources SET deletion_state = 'active' WHERE source_id = ?
    `).run(SOURCE_ID)
    database.rawMainHandle.prepare(`
      UPDATE source_data_views SET fields_json = ? WHERE data_view_id = ?
    `).run(JSON.stringify([
      { fieldId: 'not-a-field-id', ordinal: 0, label: 'name' },
      { fieldId: csvDataViewOrdinalId('field', VERSION_ID, 1), ordinal: 1, label: 'formula' },
    ]), claim.dataViewId)
    expect(store.getViewScoped(claim.dataViewId, WORKSPACE_ID, PROFILE_ID)).toBeNull()

    database.rawMainHandle.prepare(`
      UPDATE source_data_views SET fields_json = ? WHERE data_view_id = ?
    `).run(JSON.stringify(artifact(claim.dataViewId).manifest.fields), claim.dataViewId)
    database.rawMainHandle.prepare(`
      UPDATE runtime_sources SET current_version_id = NULL WHERE source_id = ?
    `).run(SOURCE_ID)
    expect(store.getViewScoped(claim.dataViewId, WORKSPACE_ID, PROFILE_ID)).toBeNull()
  })

  it('publishes an old in-flight completion as stale without relabelling the new version', () => {
    const job = enqueue(100)
    const claim = store.claimNext('data-view-worker', 200)!
    advanceToPublication(claim)
    seedNextVersion(database)

    expect(store.publish(job.jobId, claim.claimToken, artifact(claim.dataViewId), 500))
      .toBe('finished')
    expect(store.getViewScoped(claim.dataViewId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      freshness: 'stale', staleAt: 500,
    })
    expect(database.rawMainHandle.prepare(`
      SELECT current_version_id, preparation_state FROM runtime_sources
      WHERE source_id = ?
    `).get(SOURCE_ID)).toEqual({
      current_version_id: NEXT_VERSION_ID,
      preparation_state: 'not_requested',
    })
  })

  it('rejects wrong artifact identity without publishing or terminating the live claim', () => {
    const job = enqueue(100)
    const claim = store.claimNext('data-view-worker', 200)!
    advanceToPublication(claim)

    const wrong = artifact('44444444-4444-4444-8444-444444444444')
    expect(store.publish(job.jobId, claim.claimToken, wrong, 500)).toBe('state_conflict')
    expect(store.getViewScoped(claim.dataViewId, WORKSPACE_ID, PROFILE_ID)).toBeNull()
    expect(store.getJobScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'running', checkpoint: 3, dataViewId: null,
    })

    const malformed = {
      ...artifact(claim.dataViewId),
      manifest: {
        ...artifact(claim.dataViewId).manifest,
        artifactChecksum: 'not-a-checksum',
      },
    }
    expect(store.publish(job.jobId, claim.claimToken, malformed, 501))
      .toBe('state_conflict')
    expect(database.rawMainHandle.prepare(
      'SELECT COUNT(*) AS count FROM source_data_views',
    ).get()).toEqual({ count: 0 })

    database.rawMainHandle.prepare(`
      UPDATE runtime_sources SET deletion_state = 'frozen' WHERE source_id = ?
    `).run(SOURCE_ID)
    expect(store.publish(job.jobId, claim.claimToken, artifact(claim.dataViewId), 502))
      .toBe('state_conflict')
    expect(database.rawMainHandle.prepare(
      'SELECT COUNT(*) AS count FROM source_data_views',
    ).get()).toEqual({ count: 0 })
  })

  it('recovers the exact durable checkpoint after a real database restart', () => {
    const path = join(dir, 'ownware.db')
    const job = enqueue(100)
    const first = store.claimNext('worker-a', 200)!
    expect(store.advanceCheckpoint(job.jobId, first.claimToken, 0, 1, 300)).toBe('advanced')
    expect(store.advanceCheckpoint(job.jobId, first.claimToken, 1, 2, 400)).toBe('advanced')
    database.close()

    database = new CortexDatabase(path)
    store = new SourceDataViewStore(database.rawMainHandle)
    expect(store.recoverExpiredClaims(first.leaseExpiresAt + 1)).toEqual({
      requeued: 1, failed: 0,
    })
    const second = store.claimNext('worker-b', first.leaseExpiresAt + 2)!
    expect(second).toMatchObject({ attempt: 2, checkpoint: 2, dataViewId: first.dataViewId })
    expect(second.claimToken).not.toBe(first.claimToken)
  })

  it('atomically extends the live lease before unpublished artifact cleanup', () => {
    const job = enqueue(100)
    const claim = store.claimNext('worker-a', 200)!

    expect(store.fenceUnpublishedArtifactCleanup(
      job.jobId, claim.claimToken, claim.dataViewId, 30_000,
    )).toBe(true)
    expect(store.recoverExpiredClaims(claim.leaseExpiresAt + 1)).toEqual({
      requeued: 0, failed: 0,
    })
    expect(store.fenceUnpublishedArtifactCleanup(
      job.jobId, '44444444-4444-4444-8444-444444444444', claim.dataViewId, 30_001,
    )).toBe(false)
  })

  it('keeps public cancellation requested until an exact cleanup claimant confirms it', () => {
    const job = enqueue(100)
    expect(store.requestCancel(job.jobId, 'workspace-b', PROFILE_ID, 150)).toBe('missing')
    expect(store.requestCancel(job.jobId, WORKSPACE_ID, PROFILE_ID, 150)).toBe('requested')
    expect(store.getJobScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'cancel_requested', cancelRequestedAt: 150, terminalAt: null,
    })
    const claim = store.claimNextCancellation('cleanup-worker', 200)!
    expect(store.confirmCancelled(job.jobId, claim.claimToken, 201)).toBe('cancelled')
    expect(store.getJobScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'cancelled', outcomeCode: 'cancelled', dataViewId: null,
    })
    expect(store.requestCancel(job.jobId, WORKSPACE_ID, PROFILE_ID, 202)).toBe('terminal')
  })

  it.each([
    ['UPDATE runtime_sources SET current_version_id = NULL WHERE source_id = ?',
      'source_version_not_current'],
    ["UPDATE source_versions SET inspection_state = 'not_started' WHERE source_id = ?",
      'source_inspection_incomplete'],
    ["UPDATE runtime_sources SET kind = 'text' WHERE source_id = ?",
      'source_data_view_kind_unsupported'],
    ["UPDATE source_versions SET verified_media_type = 'application/pdf' WHERE source_id = ?",
      'source_media_unsupported'],
    ["UPDATE runtime_sources SET authority = 'excluded' WHERE source_id = ?",
      'source_authority_excluded'],
    ["UPDATE runtime_sources SET access_state = 'denied' WHERE source_id = ?",
      'source_access_unavailable'],
    ["UPDATE runtime_sources SET conflict_state = 'confirmed' WHERE source_id = ?",
      'source_conflict_confirmed'],
    ["UPDATE runtime_sources SET deletion_state = 'frozen' WHERE source_id = ?",
      'source_version_not_found'],
  ] as const)('returns a closed eligibility code: %s', (sql, code) => {
    database.rawMainHandle.prepare(sql).run(SOURCE_ID)
    expect(() => enqueue(100)).toThrow(expect.objectContaining({ code }))
    expect(database.rawMainHandle.prepare(
      'SELECT COUNT(*) AS count FROM source_data_view_jobs',
    ).get()).toEqual({ count: 0 })
  })

  it('fails closed for an ineligible target and transactional quota refusal', () => {
    database.rawMainHandle.prepare(`
      UPDATE runtime_sources SET kind = 'text' WHERE source_id = ?
    `).run(SOURCE_ID)
    expect(() => enqueue(100)).toThrow(expect.objectContaining({
      code: 'source_data_view_kind_unsupported',
    }))
    database.rawMainHandle.prepare(`
      UPDATE runtime_sources SET kind = 'structured_export' WHERE source_id = ?
    `).run(SOURCE_ID)

    const zeroDerived: SourceQuotaLimits = {
      workspace: limits(0),
      profile: limits(0),
    }
    const limited = new SourceDataViewStore(
      database.rawMainHandle,
      new SourceQuotaPolicy(database.rawMainHandle, zeroDerived),
    )
    expect(() => limited.enqueue(input(), 100)).toThrow(SourceQuotaExceededError)
    expect(database.rawMainHandle.prepare(
      'SELECT COUNT(*) AS count FROM source_data_view_jobs',
    ).get()).toEqual({ count: 0 })
  })

  function enqueue(now: number) {
    return store.enqueue(input(), now)
  }

  function advanceToPublication(claim: { jobId: string; claimToken: string }): void {
    expect(store.advanceCheckpoint(claim.jobId, claim.claimToken, 0, 1, 300)).toBe('advanced')
    expect(store.advanceCheckpoint(claim.jobId, claim.claimToken, 1, 2, 350)).toBe('advanced')
    expect(store.advanceCheckpoint(claim.jobId, claim.claimToken, 2, 3, 400)).toBe('advanced')
  }
})

function input() {
  return {
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    sourceId: SOURCE_ID,
    sourceVersionId: VERSION_ID,
  }
}

function artifact(dataViewId: string): PreparedCsvDataViewArtifact {
  return {
    privateObjectKey:
      `sources/${SOURCE_ID}/versions/${VERSION_ID}/data-views/${dataViewId}.json`,
    manifest: {
      dataViewId,
      implementationVersion: 'csv_data_view.v1',
      sourceVersionId: VERSION_ID,
      sourceChecksum: SOURCE_CHECKSUM,
      artifactChecksum: `sha256:${'b'.repeat(64)}`,
      artifactByteCount: 128,
      fieldCount: 2,
      rowCount: 1,
      fields: [
        { fieldId: csvDataViewOrdinalId('field', VERSION_ID, 0), ordinal: 0, label: 'name' },
        { fieldId: csvDataViewOrdinalId('field', VERSION_ID, 1), ordinal: 1, label: 'formula' },
      ],
    },
  }
}

function seed(database: CortexDatabase): void {
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
      'supporting_reference', 'audience.policy.test', 'sensitivity.policy.test',
      'purpose.policy.test', 'retention.policy.test', 'freshness.policy.test',
      1, ?, 'registered', 'complete', 'not_requested', 'available', 'fresh',
      'none', 'active', 10, 10
    )
  `).run(SOURCE_ID, WORKSPACE_ID, PROFILE_ID, VERSION_ID)
  database.rawMainHandle.prepare(`
    INSERT INTO source_versions (
      source_version_id, source_id, checksum, verified_media_type, byte_count,
      object_key, inspection_state, preparation_state, created_at
    ) VALUES (?, ?, ?, 'text/plain', 16, ?, 'complete', 'not_requested', 10)
  `).run(
    VERSION_ID,
    SOURCE_ID,
    SOURCE_CHECKSUM,
    `sources/${SOURCE_ID}/versions/${VERSION_ID}/original`,
  )
}

function seedNextVersion(database: CortexDatabase): void {
  database.rawMainHandle.prepare(`
    INSERT INTO source_versions (
      source_version_id, source_id, checksum, verified_media_type, byte_count,
      object_key, inspection_state, preparation_state, created_at
    ) VALUES (?, ?, ?, 'text/plain', 16, ?, 'complete', 'not_requested', 450)
  `).run(
    NEXT_VERSION_ID,
    SOURCE_ID,
    `sha256:${'c'.repeat(64)}`,
    `sources/${SOURCE_ID}/versions/${NEXT_VERSION_ID}/original`,
  )
  database.rawMainHandle.prepare(`
    UPDATE runtime_sources SET revision = 2, current_version_id = ?,
      preparation_state = 'not_requested', updated_at = 450 WHERE source_id = ?
  `).run(NEXT_VERSION_ID, SOURCE_ID)
}

function limits(maxDerivedResources: number) {
  return {
    maxSourceRegistrations: 1_000,
    maxRetainedAndReservedBytes: 1024 * 1024 * 1024,
    maxActiveUploadSessions: 256,
    maxNonterminalJobs: 64,
    maxDerivedResources,
  }
}
