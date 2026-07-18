import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import {
  ACCESS_GRANT_MIN_TTL_SECONDS,
  AccessGrantStore,
  type AccessGrantRevision,
} from '../../../src/gateway/access-grant-store.js'
import { RunIdempotencyStore } from '../../../src/gateway/idempotency.js'
import { SourceDeletionStore } from '../../../src/gateway/source-deletion-store.js'
import { SourceJobStore } from '../../../src/gateway/source-job-store.js'
import { SourceStore } from '../../../src/gateway/source-store.js'
import { SourceUploadStore } from '../../../src/gateway/source-upload-store.js'

const WORKSPACE_ID = 'workspace-a'
const PROFILE_ID = 'mini'
const VERSION_ID = '11111111-1111-4111-8111-111111111111'

let dir: string
let database: CortexDatabase
let sourceId: string
let uploadId: string
let inspectionJobId: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'source-deletion-store-'))
  database = new CortexDatabase(join(dir, 'ownware.db'))
  sourceId = new SourceStore(database.rawMainHandle).create({
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    kind: 'file',
    label: 'Synthetic deletion source',
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
    principalKey: 'deletion-test',
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
  inspectionJobId = new SourceJobStore(database.rawMainHandle).enqueue({
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    sourceId,
    sourceVersionId: VERSION_ID,
    operation: 'inspect_format',
  }, 40).jobId
  database.rawMainHandle.prepare(`
    INSERT INTO run_idempotency (
      id, principal_key, operation, idempotency_key, request_salt,
      request_digest, state, lease_owner, status_code, result_json,
      created_at, updated_at, expires_at, source_id
    ) VALUES (
      '22222222-2222-4222-8222-222222222222', 'delegate', 'sources.register',
      '33333333-3333-4333-8333-333333333333', 'salt', 'digest', 'completed',
      'lease', 202, '{"sourceId":"${sourceId}"}', 10, 10, 1000, ?
    )
  `).run(sourceId)
})

afterEach(async () => {
  database.close()
  await rm(dir, { recursive: true, force: true })
})

describe('SourceDeletionStore', () => {
  it('atomically freezes one revision and inventories every current artifact identity', () => {
    const store = new SourceDeletionStore(database.rawMainHandle)
    const plan = store.plan({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      expectedRevision: 2,
    }, 50)
    expect(plan).toEqual({
      jobId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      sourceId,
      state: 'queued',
      implementationVersion: 'source_deletion.v1',
      sourceRevision: 3,
      inventoryState: 'complete',
      inventoryCounts: {
        accessGrantRevocations: 0,
        immutableOriginals: 1,
        uploadStaging: 1,
        placedCandidates: 0,
        derivedResources: 0,
        dataViews: 0,
        searchIndexes: 0,
        sourceJobs: 1,
        idempotencyReplays: 1,
        grantMutationReplays: 0,
        retrievalCacheEntries: 0,
      },
      createdAt: 50,
      updatedAt: 50,
    })
    expect(database.rawMainHandle.prepare(`
      SELECT revision, deletion_state FROM runtime_sources WHERE source_id = ?
    `).get(sourceId)).toEqual({ revision: 3, deletion_state: 'frozen' })
    expect(database.rawMainHandle.prepare(`
      SELECT state, code, byte_reservation_released_at
      FROM source_upload_sessions WHERE upload_id = ?
    `).get(uploadId)).toEqual({
      state: 'failed', code: 'source_deletion_frozen',
      byte_reservation_released_at: null,
    })
    expect(database.rawMainHandle.prepare(`
      SELECT state, cancel_requested_at FROM source_jobs WHERE job_id = ?
    `).get(inspectionJobId)).toEqual({ state: 'cancel_requested', cancel_requested_at: 50 })
    expect(store.getInventory(plan.jobId)).toEqual([
      { kind: 'idempotency_replay', id: '22222222-2222-4222-8222-222222222222' },
      { kind: 'immutable_original', id: VERSION_ID },
      { kind: 'source_job', id: inspectionJobId },
      { kind: 'upload_staging', id: uploadId },
    ])
    expect(store.plan({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      expectedRevision: 2,
    }, 60)).toEqual(plan)
    expect(new SourceJobStore(database.rawMainHandle).claimNext('normal-worker', 60)).toBeNull()
  })

  it('rolls back the source fence and dependent state when inventory persistence fails', () => {
    database.rawMainHandle.exec(`
      CREATE TRIGGER injected_deletion_plan_failure
      BEFORE INSERT ON source_deletion_plans
      BEGIN SELECT RAISE(ABORT, 'private deletion plan failure'); END;
    `)
    const store = new SourceDeletionStore(database.rawMainHandle)
    expect(() => store.plan({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      expectedRevision: 2,
    }, 50)).toThrow('private deletion plan failure')
    expect(database.rawMainHandle.prepare(`
      SELECT revision, deletion_state FROM runtime_sources WHERE source_id = ?
    `).get(sourceId)).toEqual({ revision: 2, deletion_state: 'active' })
    expect(database.rawMainHandle.prepare(`
      SELECT state, code FROM source_upload_sessions WHERE upload_id = ?
    `).get(uploadId)).toEqual({ state: 'open', code: null })
    expect(database.rawMainHandle.prepare(`
      SELECT state FROM source_jobs WHERE job_id = ?
    `).get(inspectionJobId)).toEqual({ state: 'queued' })
    expect(database.rawMainHandle.prepare(`
      SELECT COUNT(*) AS count FROM source_jobs WHERE operation = 'delete_source'
    `).get()).toEqual({ count: 0 })
  })

  it('thaws only a pre-removal cancellation and advances the revision again', () => {
    const store = new SourceDeletionStore(database.rawMainHandle)
    const plan = store.plan({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      expectedRevision: 2,
    }, 50)
    expect(store.requestCancellation(
      plan.jobId, WORKSPACE_ID, PROFILE_ID, 60,
    )).toBe('requested')
    expect(store.getScoped(sourceId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'cancel_requested', sourceRevision: 3,
    })
    expect(store.confirmCancellation(plan.jobId, 70)).toBe(true)
    expect(database.rawMainHandle.prepare(`
      SELECT revision, deletion_state FROM runtime_sources WHERE source_id = ?
    `).get(sourceId)).toEqual({ revision: 4, deletion_state: 'active' })
    expect(store.getScoped(sourceId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      jobId: plan.jobId, state: 'cancelled', sourceRevision: 3,
    })
    expect(() => new SourceUploadStore(database.rawMainHandle).create({
      sourceId,
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      principalKey: 'post-cancel',
      expectedBytes: 1,
      expectedChecksum: `sha256:${'b'.repeat(64)}`,
      declaredMediaType: 'text/plain',
      filename: 'new.txt',
    }, 80)).not.toThrow()
  })

  it('fences an in-flight preparation before it can publish a resource', () => {
    const jobs = new SourceJobStore(database.rawMainHandle)
    const inspectionClaim = jobs.claimNext('inspection-worker', 41)!
    for (const checkpoint of [1, 2, 3]) {
      expect(jobs.advanceCheckpoint(
        inspectionJobId,
        inspectionClaim.claimToken,
        checkpoint - 1,
        checkpoint,
        41 + checkpoint,
      )).toBe('advanced')
    }
    expect(jobs.finishInspection(
      inspectionJobId,
      inspectionClaim.claimToken,
      'succeeded',
      'inspection_complete',
      45,
    )).toBe('finished')
    const preparation = jobs.enqueuePreparation({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      sourceVersionId: VERSION_ID,
    }, 46)
    const preparationClaim = jobs.claimNext('preparation-worker', 47)!
    for (const checkpoint of [1, 2, 3]) {
      expect(jobs.advanceCheckpoint(
        preparation.jobId,
        preparationClaim.claimToken,
        checkpoint - 1,
        checkpoint,
        47 + checkpoint,
      )).toBe('advanced')
    }

    new SourceDeletionStore(database.rawMainHandle).plan({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      expectedRevision: 2,
    }, 60)
    expect(jobs.finishPreparation(
      preparation.jobId,
      preparationClaim.claimToken,
      'succeeded',
      'preparation_complete',
      61,
    )).toBe('state_conflict')
    expect(database.rawMainHandle.prepare(`
      SELECT COUNT(*) AS count FROM source_derived_resources WHERE source_id = ?
    `).get(sourceId)).toEqual({ count: 0 })
    expect(database.rawMainHandle.prepare(`
      SELECT state FROM source_jobs WHERE job_id = ?
    `).get(preparation.jobId)).toEqual({ state: 'cancel_requested' })
  })

  it('atomically revokes exact prepared-resource grants and neutralizes future replay', () => {
    const { grant, replayId, resourceId } = seedGrantAndMutationReplay()
    const grants = new AccessGrantStore(database.rawMainHandle)
    const unrelatedResource = grants.create({
      ...grantInput('99999999-9999-4999-8999-999999999999'),
      effectiveAt: 45,
      expiresAt: 10_000,
    }, 45)
    const unrelatedScope = grants.create({
      ...grantInput(resourceId),
      workspaceId: 'workspace-other',
      effectiveAt: 45,
      expiresAt: 10_000,
    }, 45)
    const store = new SourceDeletionStore(database.rawMainHandle)

    const plan = store.plan({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      expectedRevision: 2,
    }, 60)

    expect(grants.getCurrentScoped(
      grant.grantId, WORKSPACE_ID, PROFILE_ID,
    )).toMatchObject({ revision: 2, state: 'revoked', revokedAt: 60 })
    expect(grants.getCurrentScoped(
      unrelatedResource.grantId, WORKSPACE_ID, PROFILE_ID,
    )).toMatchObject({ revision: 1, state: 'active' })
    expect(grants.getCurrentScoped(
      unrelatedScope.grantId, 'workspace-other', PROFILE_ID,
    )).toMatchObject({ revision: 1, state: 'active' })
    expect(database.rawMainHandle.prepare(`
      SELECT state, status_code, result_json, source_id, source_mutation_kind
      FROM run_idempotency WHERE id = ?
    `).get(replayId)).toEqual({
      state: 'indeterminate',
      status_code: null,
      result_json: null,
      source_id: sourceId,
      source_mutation_kind: 'access_grant',
    })
    expect(store.getInventory(plan.jobId)).toEqual(expect.arrayContaining([
      { kind: 'access_grant_revocation', id: grant.grantId },
      { kind: 'grant_mutation_replay', id: replayId },
    ]))
    expect(plan.inventoryCounts).toMatchObject({
      accessGrantRevocations: 1,
      grantMutationReplays: 1,
    })

    expect(store.requestCancellation(
      plan.jobId, WORKSPACE_ID, PROFILE_ID, 61,
    )).toBe('requested')
    expect(store.confirmCancellation(plan.jobId, 62)).toBe(true)
    expect(grants.getCurrentScoped(
      grant.grantId, WORKSPACE_ID, PROFILE_ID,
    )).toMatchObject({ revision: 2, state: 'revoked' })
    expect(database.rawMainHandle.prepare(`
      SELECT state, result_json FROM run_idempotency WHERE id = ?
    `).get(replayId)).toEqual({ state: 'indeterminate', result_json: null })
    expect(database.rawMainHandle.prepare(`
      SELECT access_grant_revocations, grant_mutation_replays
      FROM source_deletion_tombstones WHERE job_id = ?
    `).get(plan.jobId)).toEqual({
      access_grant_revocations: 1,
      grant_mutation_replays: 1,
    })
  })

  it('rolls grant revocation and replay neutralization back when planning fails', () => {
    const { grant, replayId } = seedGrantAndMutationReplay()
    database.rawMainHandle.exec(`
      CREATE TRIGGER injected_grant_deletion_plan_failure
      BEFORE INSERT ON source_deletion_plans
      BEGIN SELECT RAISE(ABORT, 'private grant deletion plan failure'); END;
    `)

    expect(() => new SourceDeletionStore(database.rawMainHandle).plan({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      expectedRevision: 2,
    }, 60)).toThrow('private grant deletion plan failure')
    expect(new AccessGrantStore(database.rawMainHandle).getCurrentScoped(
      grant.grantId, WORKSPACE_ID, PROFILE_ID,
    )).toMatchObject({ revision: 1, state: 'active' })
    expect(database.rawMainHandle.prepare(`
      SELECT state, source_mutation_kind FROM run_idempotency WHERE id = ?
    `).get(replayId)).toEqual({
      state: 'in_progress', source_mutation_kind: 'access_grant',
    })
    expect(database.rawMainHandle.prepare(`
      SELECT revision, deletion_state FROM runtime_sources WHERE source_id = ?
    `).get(sourceId)).toEqual({ revision: 2, deletion_state: 'active' })
  })

  function seedGrantAndMutationReplay(): {
    readonly grant: AccessGrantRevision
    readonly replayId: string
    readonly resourceId: string
  } {
    const jobs = new SourceJobStore(database.rawMainHandle)
    const inspection = jobs.claimNext('grant-inspection-worker', 41)!
    for (const checkpoint of [1, 2, 3]) {
      expect(jobs.advanceCheckpoint(
        inspectionJobId, inspection.claimToken, checkpoint - 1, checkpoint,
        41 + checkpoint,
      )).toBe('advanced')
    }
    expect(jobs.finishInspection(
      inspectionJobId, inspection.claimToken, 'succeeded', 'inspection_complete', 45,
    )).toBe('finished')
    const preparation = jobs.enqueuePreparation({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      sourceVersionId: VERSION_ID,
    }, 46)
    const claim = jobs.claimNext('grant-preparation-worker', 47)!
    for (const checkpoint of [1, 2, 3]) {
      expect(jobs.advanceCheckpoint(
        preparation.jobId, claim.claimToken, checkpoint - 1, checkpoint,
        47 + checkpoint,
      )).toBe('advanced')
    }
    expect(jobs.finishPreparation(
      preparation.jobId, claim.claimToken, 'succeeded', 'preparation_complete', 51,
    )).toBe('finished')
    const resourceId = claim.resourceId!
    const grant = new AccessGrantStore(database.rawMainHandle)
      .createPreparedTextReadGrant({
        workspaceId: WORKSPACE_ID,
        profileId: PROFILE_ID,
        subjectId: 'person.synthetic-1',
        purpose: 'customer_support',
        channel: 'web.primary',
        resourceId,
        consent: { state: 'not_required' },
        ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
        issuedBy: 'owner.synthetic',
      }, 52)
    const idempotency = new RunIdempotencyStore(database.rawMainHandle, 'grant-replay-test')
    const replay = idempotency.claim({
      principalKey: 'owner',
      operation: 'private.access-grant-mutation',
      key: '88888888-8888-4888-8888-888888888888',
      input: { resourceId },
    }, 53) as { kind: 'claimed'; recordId: string }
    idempotency.linkSourceMutation(replay.recordId, sourceId, 'access_grant', 54)
    return { grant, replayId: replay.recordId, resourceId }
  }

  function grantInput(resourceId: string) {
    return {
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      subjectId: 'person.synthetic-1',
      purpose: 'customer_support',
      channel: 'web.primary',
      resourceKind: 'source_resource',
      resourceId,
      operation: 'source_content.read',
      fieldScope: { mode: 'all' } as const,
      rowScope: { mode: 'all' } as const,
      consent: { state: 'not_required' } as const,
      autonomyCeiling: 'observe' as const,
      issuedBy: 'owner.synthetic',
    }
  }
})
