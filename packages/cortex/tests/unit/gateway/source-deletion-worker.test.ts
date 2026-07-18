import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { AccessGrantStore } from '../../../src/gateway/access-grant-store.js'
import { RunIdempotencyStore } from '../../../src/gateway/idempotency.js'
import {
  SourceDeletionStore,
  type SourceDeletionArtifactKind,
} from '../../../src/gateway/source-deletion-store.js'
import {
  SourceDeletionWorker,
  type SourceDeletionByteRemover,
} from '../../../src/gateway/source-deletion-worker.js'
import { SourceJobStore } from '../../../src/gateway/source-job-store.js'
import { SourceStore } from '../../../src/gateway/source-store.js'
import { SourceUploadStore } from '../../../src/gateway/source-upload-store.js'

const WORKSPACE_ID = 'workspace-a'
const PROFILE_ID = 'mini'
const VERSION_ID = '11111111-1111-4111-8111-111111111111'
const REPLAY_ID = '22222222-2222-4222-8222-222222222222'
const RESOURCE_ID = '44444444-4444-4444-8444-444444444444'

class FakeDeletionBytes implements SourceDeletionByteRemover {
  readonly removedUploads: string[] = []
  readonly removedVersions: Array<{ sourceId: string; versionId: string }> = []
  versionAbsent = true
  throwOnVersionRemove = false

  async removeUploadArtifacts(uploadId: string): Promise<void> {
    this.removedUploads.push(uploadId)
  }

  async uploadArtifactsAbsent(): Promise<boolean> {
    return true
  }

  async removeVersionArtifacts(sourceId: string, versionId: string): Promise<void> {
    this.removedVersions.push({ sourceId, versionId })
    if (this.throwOnVersionRemove) throw new Error('injected private remove failure')
  }

  async versionArtifactsAbsent(): Promise<boolean> {
    return this.versionAbsent
  }
}

describe('SourceDeletionWorker', () => {
  let dir: string
  let database: CortexDatabase
  let sourceId: string
  let uploadId: string
  let oldJobId: string
  let grantId: string
  let wrongScopeGrantId: string
  let grantReplayId: string
  let deletions: SourceDeletionStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'source-deletion-worker-'))
    database = new CortexDatabase(join(dir, 'ownware.db'))
    sourceId = new SourceStore(database.rawMainHandle).create({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      kind: 'file',
      label: 'Synthetic deletion worker source',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.test',
      sensitivityPolicyRef: 'sensitivity.test',
      purposePolicyRef: 'purpose.test',
      retentionPolicyRef: 'retention.test',
      freshnessPolicyRef: 'freshness.test',
    }, 10).sourceId
    uploadId = new SourceUploadStore(database.rawMainHandle).create({
      sourceId,
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      principalKey: 'deletion-worker-test',
      expectedBytes: 4,
      expectedChecksum: `sha256:${'a'.repeat(64)}`,
      declaredMediaType: 'text/plain',
      filename: 'synthetic.txt',
    }, 20).uploadId
    database.rawMainHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, preparation_state, created_at
      ) VALUES (?, ?, ?, 'text/plain', 4, ?, 'not_started', 'not_requested', 30)
    `).run(
      VERSION_ID,
      sourceId,
      `sha256:${'a'.repeat(64)}`,
      `sources/${sourceId}/versions/${VERSION_ID}/original`,
    )
    database.rawMainHandle.prepare(`
      UPDATE runtime_sources SET revision = 2, current_version_id = ?,
        registration_state = 'registered', freshness_state = 'fresh', updated_at = 30
      WHERE source_id = ?
    `).run(VERSION_ID, sourceId)
    oldJobId = new SourceJobStore(database.rawMainHandle).enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
    }, 40).jobId
    database.rawMainHandle.prepare(`
      INSERT INTO source_derived_resources (
        resource_id, job_id, workspace_id, profile_id, source_id,
        source_version_id, kind, operation, implementation_version,
        source_revision, source_checksum, resource_checksum, byte_start,
        byte_end, byte_count, classification, authority, audience_policy_ref,
        sensitivity_policy_ref, purpose_policy_ref, retention_policy_ref,
        freshness_policy_ref, coverage, freshness, created_at, stale_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, 'text_extraction', 'extract_text', 'text_extraction.v1',
        2, ?, ?, 0, 4, 4, 'internal', 'supporting_reference', 'audience.test',
        'sensitivity.test', 'purpose.test', 'retention.test', 'freshness.test',
        'complete', 'current', 41, NULL
      )
    `).run(
      RESOURCE_ID,
      oldJobId,
      WORKSPACE_ID,
      PROFILE_ID,
      sourceId,
      VERSION_ID,
      `sha256:${'a'.repeat(64)}`,
      `sha256:${'a'.repeat(64)}`,
    )
    database.rawMainHandle.prepare(`
      INSERT INTO run_idempotency (
        id, principal_key, operation, idempotency_key, request_salt,
        request_digest, state, lease_owner, status_code, result_json,
        created_at, updated_at, expires_at, source_id
      ) VALUES (
        ?, 'delegate', 'sources.register',
        '33333333-3333-4333-8333-333333333333', 'salt', 'digest', 'completed',
        'lease', 202, ?, 10, 10, 1000, ?
      )
    `).run(REPLAY_ID, JSON.stringify({ sourceId }), sourceId)
    grantId = new AccessGrantStore(database.rawMainHandle).create({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      subjectId: 'person.synthetic-1',
      purpose: 'customer_support',
      channel: 'web.primary',
      resourceKind: 'source_resource',
      resourceId: RESOURCE_ID,
      operation: 'source_content.read',
      fieldScope: { mode: 'all' },
      rowScope: { mode: 'all' },
      consent: { state: 'not_required' },
      autonomyCeiling: 'observe',
      effectiveAt: 42,
      expiresAt: 10_000,
      issuedBy: 'owner.synthetic',
    }, 42).grantId
    wrongScopeGrantId = new AccessGrantStore(database.rawMainHandle).create({
      workspaceId: 'workspace-other',
      profileId: PROFILE_ID,
      subjectId: 'person.synthetic-1',
      purpose: 'customer_support',
      channel: 'web.primary',
      resourceKind: 'source_resource',
      resourceId: RESOURCE_ID,
      operation: 'source_content.read',
      fieldScope: { mode: 'all' },
      rowScope: { mode: 'all' },
      consent: { state: 'not_required' },
      autonomyCeiling: 'observe',
      effectiveAt: 42,
      expiresAt: 10_000,
      issuedBy: 'owner.synthetic',
    }, 42).grantId
    const idempotency = new RunIdempotencyStore(database.rawMainHandle, 'grant-replay')
    const replay = idempotency.claim({
      principalKey: 'owner',
      operation: 'private.access-grant-mutation',
      key: '55555555-5555-4555-8555-555555555555',
      input: { resourceId: RESOURCE_ID },
    }, 43) as { kind: 'claimed'; recordId: string }
    idempotency.linkSourceMutation(replay.recordId, sourceId, 'access_grant', 44)
    grantReplayId = replay.recordId
    deletions = new SourceDeletionStore(database.rawMainHandle)
  })

  afterEach(async () => {
    database.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('persists destruction before removal and succeeds only after every artifact is absent', async () => {
    const plan = planDeletion()
    const bytes = new FakeDeletionBytes()
    const worker = new SourceDeletionWorker(deletions, bytes, {
      workerId: 'deletion-test',
    })

    expect(await worker.runAvailable(100)).toBe(1)
    expect(deletions.getScoped(sourceId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      jobId: plan.jobId,
      state: 'succeeded',
    })
    expect(database.rawMainHandle.prepare(`
      SELECT source_id, source_revision, immutable_originals, upload_staging,
        derived_resources, source_jobs, idempotency_replays,
        access_grant_revocations, grant_mutation_replays
      FROM source_deletion_tombstones WHERE job_id = ?
    `).get(plan.jobId)).toEqual({
      source_id: sourceId,
      source_revision: 3,
      immutable_originals: 1,
      upload_staging: 1,
      derived_resources: 1,
      source_jobs: 1,
      idempotency_replays: 1,
      access_grant_revocations: 1,
      grant_mutation_replays: 1,
    })
    expect(deletions.getInventoryEntries(plan.jobId)).toEqual([])
    expect(bytes.removedUploads).toEqual([uploadId])
    expect(bytes.removedVersions).toEqual([{ sourceId, versionId: VERSION_ID }])
    expect(database.rawMainHandle.prepare(
      'SELECT 1 FROM source_upload_sessions WHERE upload_id = ?',
    ).get(uploadId)).toBeUndefined()
    expect(database.rawMainHandle.prepare(
      'SELECT 1 FROM source_derived_resources WHERE resource_id = ?',
    ).get(RESOURCE_ID)).toBeUndefined()
    expect(database.rawMainHandle.prepare(
      'SELECT 1 FROM source_jobs WHERE job_id = ?',
    ).get(oldJobId)).toBeUndefined()
    expect(database.rawMainHandle.prepare(
      'SELECT 1 FROM run_idempotency WHERE id = ?',
    ).get(REPLAY_ID)).toBeUndefined()
    expect(database.rawMainHandle.prepare(
      'SELECT 1 FROM run_idempotency WHERE id = ?',
    ).get(grantReplayId)).toBeUndefined()
    expect(new AccessGrantStore(database.rawMainHandle).getCurrentScoped(
      grantId, WORKSPACE_ID, PROFILE_ID,
    )).toMatchObject({ state: 'revoked', revision: 2 })
    expect(database.rawMainHandle.prepare(`
      SELECT COUNT(*) AS count FROM access_grant_revisions WHERE grant_id = ?
    `).get(grantId)).toEqual({ count: 2 })
    expect(new AccessGrantStore(database.rawMainHandle).getCurrentScoped(
      wrongScopeGrantId, 'workspace-other', PROFILE_ID,
    )).toMatchObject({ state: 'active', revision: 1 })
    expect(database.rawMainHandle.prepare(`
      SELECT deletion_state FROM runtime_sources WHERE source_id = ?
    `).get(sourceId)).toBeUndefined()
    const publicDeletion = deletions.getPublicByJobScoped(
      plan.jobId, WORKSPACE_ID, PROFILE_ID,
    )!
    expect(publicDeletion.affected).not.toHaveProperty('accessGrantRevocations')
    expect(publicDeletion.affected).not.toHaveProperty('grantMutationReplays')
  })

  it('keeps failed absence truthful and retries the exact durable inventory', async () => {
    const plan = planDeletion()
    const bytes = new FakeDeletionBytes()
    bytes.versionAbsent = false
    const worker = new SourceDeletionWorker(deletions, bytes, {
      workerId: 'deletion-test',
    })

    expect(await worker.runAvailable(100)).toBe(1)
    expect(deletions.getScoped(sourceId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'partial',
    })
    expect(inventoryState(plan.jobId, 'immutable_original')).toBe('failed')
    expect(inventoryState(plan.jobId, 'upload_staging')).toBe('verified_absent')
    expect(inventoryState(plan.jobId, 'derived_resource')).toBe('verified_absent')
    expect(inventoryState(plan.jobId, 'source_job')).toBe('verified_absent')
    expect(inventoryState(plan.jobId, 'idempotency_replay')).toBe('verified_absent')
    expect(database.rawMainHandle.prepare(`
      SELECT deletion_state FROM runtime_sources WHERE source_id = ?
    `).get(sourceId)).toEqual({ deletion_state: 'partially_deleted' })

    bytes.versionAbsent = true
    expect(deletions.retryPartial(plan.jobId, 200)).toBe('queued')
    expect(await worker.runAvailable(300)).toBe(1)
    expect(deletions.getScoped(sourceId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'succeeded',
    })
    expect(deletions.getInventoryEntries(plan.jobId)).toEqual([])
    expect(database.rawMainHandle.prepare(`
      SELECT immutable_originals FROM source_deletion_tombstones WHERE job_id = ?
    `).get(plan.jobId)).toEqual({ immutable_originals: 1 })
    expect(bytes.removedVersions).toHaveLength(2)
  })

  it('retries a failed grant revocation proof without deleting immutable history', async () => {
    const plan = planDeletion()
    reactivateGrant(3, 60)
    database.rawMainHandle.exec(`
      CREATE TRIGGER injected_retry_grant_revocation_failure
      BEFORE INSERT ON access_grant_revisions
      WHEN NEW.grant_id = '${grantId}' AND NEW.revision = 4
      BEGIN SELECT RAISE(ABORT, 'private grant revocation failure'); END;
    `)
    const worker = new SourceDeletionWorker(deletions, new FakeDeletionBytes(), {
      workerId: 'deletion-test',
    })

    expect(await worker.runAvailable(100)).toBe(1)
    expect(deletions.getScoped(sourceId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'partial',
    })
    expect(inventoryState(plan.jobId, 'access_grant_revocation')).toBe('failed')
    expect(new AccessGrantStore(database.rawMainHandle).getCurrentScoped(
      grantId, WORKSPACE_ID, PROFILE_ID,
    )).toMatchObject({ revision: 3, state: 'active' })

    database.rawMainHandle.exec('DROP TRIGGER injected_retry_grant_revocation_failure')
    expect(deletions.retryPartial(plan.jobId, 200)).toBe('queued')
    expect(await worker.runAvailable(300)).toBe(1)
    expect(deletions.getScoped(sourceId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'succeeded',
    })
    expect(new AccessGrantStore(database.rawMainHandle).getCurrentScoped(
      grantId, WORKSPACE_ID, PROFILE_ID,
    )).toMatchObject({ revision: 4, state: 'revoked' })
    expect(database.rawMainHandle.prepare(`
      SELECT revision, state FROM access_grant_revisions
      WHERE grant_id = ? ORDER BY revision
    `).all(grantId)).toEqual([
      { revision: 1, state: 'active' },
      { revision: 2, state: 'revoked' },
      { revision: 3, state: 'active' },
      { revision: 4, state: 'revoked' },
    ])
  })

  it('accepts a removal error only when independent verification proves absence', async () => {
    planDeletion()
    const bytes = new FakeDeletionBytes()
    bytes.throwOnVersionRemove = true
    bytes.versionAbsent = true

    expect(await new SourceDeletionWorker(deletions, bytes, {
      workerId: 'deletion-test',
    }).runAvailable(100)).toBe(1)
    expect(deletions.getScoped(sourceId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'succeeded',
    })
  })

  it('rolls back tombstone finalization atomically and completes after restart recovery', async () => {
    const plan = planDeletion()
    database.rawMainHandle.exec(`
      CREATE TRIGGER injected_tombstone_failure
      BEFORE INSERT ON source_deletion_tombstones
      BEGIN SELECT RAISE(ABORT, 'private tombstone failure'); END;
    `)
    const worker = new SourceDeletionWorker(deletions, new FakeDeletionBytes(), {
      workerId: 'deletion-test',
    })

    await expect(worker.runAvailable(100)).rejects.toThrow('private tombstone failure')
    expect(database.rawMainHandle.prepare(`
      SELECT state, checkpoint FROM source_jobs WHERE job_id = ?
    `).get(plan.jobId)).toEqual({ state: 'running', checkpoint: 3 })
    expect(database.rawMainHandle.prepare(`
      SELECT deletion_state FROM runtime_sources WHERE source_id = ?
    `).get(sourceId)).toEqual({ deletion_state: 'deleting' })
    expect(database.rawMainHandle.prepare(`
      SELECT COUNT(*) AS count FROM source_versions WHERE source_id = ?
    `).get(sourceId)).toEqual({ count: 1 })
    expect(database.rawMainHandle.prepare(`
      SELECT COUNT(*) AS count FROM source_deletion_tombstones WHERE job_id = ?
    `).get(plan.jobId)).toEqual({ count: 0 })

    database.rawMainHandle.exec('DROP TRIGGER injected_tombstone_failure')
    expect(deletions.recoverExpiredClaims(30_101)).toEqual({ requeued: 1, partial: 0 })
    expect(await worker.runAvailable(30_102)).toBe(1)
    expect(deletions.getPublicByJobScoped(plan.jobId, WORKSPACE_ID, PROFILE_ID))
      .toMatchObject({ state: 'deleted' })
  })

  it('fails closed on a corrupted immutable locator without touching a sibling identity', async () => {
    const plan = planDeletion()
    database.rawMainHandle.prepare(`
      UPDATE source_versions SET object_key = ? WHERE source_version_id = ?
    `).run(
      `sources/44444444-4444-4444-8444-444444444444/versions/${VERSION_ID}/original`,
      VERSION_ID,
    )
    const bytes = new FakeDeletionBytes()

    expect(await new SourceDeletionWorker(deletions, bytes, {
      workerId: 'deletion-test',
    }).runAvailable(100)).toBe(1)
    expect(deletions.getScoped(sourceId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'partial',
    })
    expect(inventoryState(plan.jobId, 'immutable_original')).toBe('failed')
    expect(bytes.removedVersions).toEqual([])
  })

  it('recovers every irreversible checkpoint without permitting cancellation or thaw', () => {
    const plan = planDeletion()
    const claim = deletions.claimNext('crashed-worker', 100)!
    expect(deletions.startDestruction(plan.jobId, claim.claimToken, 101)).toBe('advanced')
    expect(deletions.requestCancellation(
      plan.jobId, WORKSPACE_ID, PROFILE_ID, 102,
    )).toBe('destruction_started')
    expect(deletions.recoverExpiredClaims(claim.leaseExpiresAt + 1)).toEqual({
      requeued: 1,
      partial: 0,
    })
    expect(deletions.getScoped(sourceId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'queued',
    })
    expect(database.rawMainHandle.prepare(`
      SELECT checkpoint FROM source_jobs WHERE job_id = ?
    `).get(plan.jobId)).toEqual({ checkpoint: 1 })
    expect(database.rawMainHandle.prepare(`
      SELECT deletion_state FROM runtime_sources WHERE source_id = ?
    `).get(sourceId)).toEqual({ deletion_state: 'deleting' })
  })

  it('requeues exhausted checkpoint-zero work without inventing partial deletion', () => {
    const plan = planDeletion()
    const claim = deletions.claimNext('crashed-before-destruction', 100)!
    database.rawMainHandle.prepare(`
      UPDATE source_jobs SET attempt = max_attempts, lease_expires_at = 99
      WHERE job_id = ?
    `).run(plan.jobId)

    expect(deletions.recoverExpiredClaims(101)).toEqual({ requeued: 1, partial: 0 })
    expect(database.rawMainHandle.prepare(`
      SELECT state, attempt, checkpoint FROM source_jobs WHERE job_id = ?
    `).get(plan.jobId)).toEqual({ state: 'queued', attempt: 0, checkpoint: 0 })
    expect(database.rawMainHandle.prepare(`
      SELECT deletion_state FROM runtime_sources WHERE source_id = ?
    `).get(sourceId)).toEqual({ deletion_state: 'frozen' })
    expect(deletions.requestCancellation(
      plan.jobId, WORKSPACE_ID, PROFILE_ID, 102,
    )).toBe('requested')
    expect(claim.checkpoint).toBe(0)
  })

  it('renews a live deletion lease without reviving an expired claim', () => {
    const plan = planDeletion()
    const claim = deletions.claimNext('heartbeat-worker', 100)!
    expect(deletions.renewClaim(plan.jobId, claim.claimToken, 200)).toBe(true)
    expect(deletions.recoverExpiredClaims(30_150)).toEqual({ requeued: 0, partial: 0 })
    expect(deletions.renewClaim(plan.jobId, claim.claimToken, 30_201)).toBe(false)
    expect(deletions.recoverExpiredClaims(30_201)).toEqual({ requeued: 1, partial: 0 })
  })

  it.each([1, 2, 3] as const)(
    'restarts from durable checkpoint %i and re-verifies the exact inventory',
    async (checkpoint) => {
      const plan = planDeletion()
      const claim = deletions.claimNext('crashed-worker', 100)!
      expect(deletions.startDestruction(plan.jobId, claim.claimToken, 101)).toBe('advanced')
      if (checkpoint >= 2) {
        expect(deletions.advanceCheckpoint(
          plan.jobId, claim.claimToken, 1, 2, 102,
        )).toBe('advanced')
      }
      if (checkpoint >= 3) {
        expect(deletions.advanceCheckpoint(
          plan.jobId, claim.claimToken, 2, 3, 103,
        )).toBe('advanced')
      }
      expect(deletions.recoverExpiredClaims(claim.leaseExpiresAt + 1)).toEqual({
        requeued: 1,
        partial: 0,
      })

      expect(await new SourceDeletionWorker(deletions, new FakeDeletionBytes(), {
        workerId: 'restarted-worker',
      }).runAvailable(claim.leaseExpiresAt + 2)).toBe(1)
      expect(deletions.getScoped(sourceId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
        state: 'succeeded',
      })
      expect(database.rawMainHandle.prepare(`
        SELECT source_id FROM source_deletion_tombstones WHERE job_id = ?
      `).get(plan.jobId)).toEqual({ source_id: sourceId })
    },
  )

  function planDeletion() {
    return deletions.plan({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      expectedRevision: 2,
    }, 50)
  }

  function inventoryState(jobId: string, kind: SourceDeletionArtifactKind): string {
    return deletions.getInventoryEntries(jobId).find((entry) => entry.kind === kind)!.state
  }

  function reactivateGrant(revision: number, now: number): void {
    database.rawMainHandle.prepare(`
      INSERT INTO access_grant_revisions (
        grant_id, revision, workspace_id, profile_id, state, subject_id,
        purpose, channel, resource_kind, resource_id, operation,
        field_scope_mode, field_ids_json, row_scope_mode, row_ids_json,
        consent_state, consent_evidence_id, autonomy_ceiling, effective_at,
        expires_at, issued_by, revision_created_at, revoked_at
      )
      SELECT grant_id, ?, workspace_id, profile_id, 'active', subject_id,
        purpose, channel, resource_kind, resource_id, operation,
        field_scope_mode, field_ids_json, row_scope_mode, row_ids_json,
        consent_state, consent_evidence_id, autonomy_ceiling, effective_at,
        expires_at, issued_by, ?, NULL
      FROM access_grant_revisions WHERE grant_id = ? AND revision = 2
    `).run(revision, now, grantId)
    database.rawMainHandle.prepare(`
      UPDATE access_grants SET current_revision = ? WHERE grant_id = ?
    `).run(revision, grantId)
  }
})
