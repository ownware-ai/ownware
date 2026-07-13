import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { SourceStore } from '../../../src/gateway/source-store.js'
import {
  SourceJobStore,
  SourceJobTargetNotFoundError,
} from '../../../src/gateway/source-job-store.js'

const WORKSPACE_ID = 'workspace-a'
const PROFILE_ID = 'mini'
const VERSION_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_VERSION_ID = '33333333-3333-4333-8333-333333333333'

describe('SourceJobStore', () => {
  let dir: string
  let database: CortexDatabase
  let store: SourceJobStore
  let sourceId: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'source-job-store-'))
    database = new CortexDatabase(join(dir, 'ownware.db'))
    store = new SourceJobStore(database.rawMainHandle)
    sourceId = seedVersion(database, VERSION_ID)
  })

  afterEach(async () => {
    database.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('enqueues one exact source version and scopes safe reads', () => {
    const job = store.enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
    }, 100)

    expect(job).toEqual({
      jobId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      sourceId,
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
      state: 'queued',
      attempt: 0,
      maxAttempts: 3,
      checkpoint: 0,
      cancelRequestedAt: null,
      outcomeCode: null,
      createdAt: 100,
      updatedAt: 100,
      terminalAt: null,
    })
    expect(store.enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
    }, 200)).toEqual(job)
    expect(store.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toEqual(job)
    expect(store.getScoped(job.jobId, 'workspace-b', PROFILE_ID)).toBeNull()
    expect(store.getScoped(job.jobId, WORKSPACE_ID, 'other')).toBeNull()

    expect(() => store.enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId: '22222222-2222-4222-8222-222222222222',
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
    })).toThrow(SourceJobTargetNotFoundError)
  })

  it('claims one queued job exactly once with a bounded private lease', () => {
    const job = store.enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
    }, 100)

    const claim = store.claimNext('worker-a', 200)
    expect(claim).toEqual({
      jobId: job.jobId,
      sourceId,
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
      attempt: 1,
      maxAttempts: 3,
      checkpoint: 0,
      claimToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
      leaseExpiresAt: 30_200,
    })
    expect(store.claimNext('worker-b', 201)).toBeNull()
    expect(store.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'running',
      attempt: 1,
      checkpoint: 0,
      updatedAt: 200,
    })
    expect(JSON.stringify(store.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)))
      .not.toContain(claim!.claimToken)
  })

  it('fences stale, replayed, and expired checkpoint writers', () => {
    const job = store.enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
    }, 100)
    const claim = store.claimNext('worker-a', 200)!

    expect(store.advanceCheckpoint(job.jobId, claim.claimToken, 0, 1, 300))
      .toBe('advanced')
    expect(store.advanceCheckpoint(job.jobId, claim.claimToken, 0, 1, 301))
      .toBe('checkpoint_conflict')
    expect(store.advanceCheckpoint(
      job.jobId,
      '22222222-2222-4222-8222-222222222222',
      1,
      2,
      302,
    )).toBe('stale_claim')
    expect(store.advanceCheckpoint(
      job.jobId, claim.claimToken, 1, 2, claim.leaseExpiresAt + 1,
    )).toBe('lease_expired')
    expect(store.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'running', checkpoint: 1, updatedAt: 300,
    })
  })

  it('recovers expired leases from the last checkpoint and exhausts bounded attempts', () => {
    const job = store.enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
    }, 100)
    const first = store.claimNext('worker-a', 200)!
    expect(store.advanceCheckpoint(job.jobId, first.claimToken, 0, 1, 300))
      .toBe('advanced')

    expect(store.recoverExpiredClaims(first.leaseExpiresAt + 1)).toEqual({
      requeued: 1, failed: 0, cancelled: 0,
    })
    expect(store.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'queued', attempt: 1, checkpoint: 1,
    })
    const second = store.claimNext('worker-b', first.leaseExpiresAt + 2)!
    expect(second.attempt).toBe(2)
    expect(second.checkpoint).toBe(1)
    expect(second.claimToken).not.toBe(first.claimToken)
    expect(store.advanceCheckpoint(
      job.jobId, first.claimToken, 1, 2, first.leaseExpiresAt + 3,
    )).toBe('stale_claim')

    expect(store.recoverExpiredClaims(second.leaseExpiresAt + 1)).toMatchObject({
      requeued: 1, failed: 0,
    })
    const third = store.claimNext('worker-c', second.leaseExpiresAt + 2)!
    expect(third.attempt).toBe(3)
    expect(store.recoverExpiredClaims(third.leaseExpiresAt + 1)).toEqual({
      requeued: 0, failed: 1, cancelled: 0,
    })
    expect(store.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'failed',
      attempt: 3,
      checkpoint: 1,
      outcomeCode: 'attempts_exhausted',
      terminalAt: third.leaseExpiresAt + 1,
    })
    expect(store.claimNext('worker-d', third.leaseExpiresAt + 2)).toBeNull()
  })

  it('records cancellation as a request until the exact claimant confirms it', () => {
    const queued = store.enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
    }, 100)
    expect(store.requestCancel(
      queued.jobId, WORKSPACE_ID, PROFILE_ID, 110,
    )).toBe('requested')
    expect(store.requestCancel(
      queued.jobId, WORKSPACE_ID, PROFILE_ID, 120,
    )).toBe('already_requested')
    expect(store.getScoped(queued.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'cancel_requested', cancelRequestedAt: 110, terminalAt: null,
    })
    expect(store.claimNext('worker-a', 121)).toBeNull()
    expect(store.confirmCancelled(queued.jobId, null, 130)).toBe('cancelled')
    expect(store.getScoped(queued.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'cancelled', outcomeCode: 'cancelled', terminalAt: 130,
    })
    expect(store.requestCancel(
      queued.jobId, WORKSPACE_ID, PROFILE_ID, 140,
    )).toBe('terminal')

    const otherSourceId = seedVersion(database, OTHER_VERSION_ID)
    const running = store.enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId: otherSourceId,
      sourceVersionId: OTHER_VERSION_ID,
      operation: 'inspect_format',
    }, 200)
    const claim = store.claimNext('worker-b', 210)!
    expect(claim.jobId).toBe(running.jobId)
    expect(store.requestCancel(
      running.jobId, WORKSPACE_ID, PROFILE_ID, 220,
    )).toBe('requested')
    expect(store.confirmCancelled(
      running.jobId, '44444444-4444-4444-8444-444444444444', 230,
    )).toBe('stale_claim')
    expect(store.confirmCancelled(running.jobId, claim.claimToken, 240))
      .toBe('cancelled')
  })

  it('releases a waiting job until its explicit retry time', () => {
    const job = store.enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
    }, 100)
    const first = store.claimNext('worker-a', 200)!

    expect(store.deferUntil(job.jobId, first.claimToken, 1_000, 300))
      .toBe('deferred')
    expect(store.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'waiting_for_resource', attempt: 1, checkpoint: 0, updatedAt: 300,
    })
    expect(store.claimNext('worker-b', 999)).toBeNull()
    const second = store.claimNext('worker-b', 1_000)!
    expect(second).toMatchObject({ jobId: job.jobId, attempt: 2, checkpoint: 0 })
    expect(second.claimToken).not.toBe(first.claimToken)
    expect(store.deferUntil(job.jobId, first.claimToken, 2_000, 1_001))
      .toBe('stale_claim')
  })

  it('requires the final checkpoint and a safe code before terminal success', () => {
    const job = store.enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
    }, 100)
    const claim = store.claimNext('worker-a', 200)!

    expect(store.finish(
      job.jobId, claim.claimToken, 'succeeded', 'inspection_complete', 300,
    )).toBe('checkpoint_incomplete')
    expect(() => store.finish(
      job.jobId, claim.claimToken, 'succeeded', 'parser failed: /private/source', 301,
    )).toThrow('Source job outcome code is invalid')
    for (const checkpoint of [1, 2, 3, 4]) {
      expect(store.advanceCheckpoint(
        job.jobId, claim.claimToken, checkpoint - 1, checkpoint, 310 + checkpoint,
      )).toBe('advanced')
    }
    expect(store.finish(
      job.jobId,
      '55555555-5555-4555-8555-555555555555',
      'succeeded',
      'inspection_complete',
      320,
    )).toBe('stale_claim')
    expect(store.finish(
      job.jobId, claim.claimToken, 'succeeded', 'inspection_complete', 330,
    )).toBe('finished')
    expect(store.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'succeeded',
      checkpoint: 4,
      outcomeCode: 'inspection_complete',
      terminalAt: 330,
    })
    expect(store.finish(
      job.jobId, claim.claimToken, 'succeeded', 'inspection_complete', 340,
    )).toBe('state_conflict')
  })

  it('confirms cancellation when the last claimant lease expires', () => {
    const job = store.enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
    }, 100)
    const claim = store.claimNext('worker-a', 200)!
    expect(store.requestCancel(job.jobId, WORKSPACE_ID, PROFILE_ID, 300))
      .toBe('requested')

    expect(store.recoverExpiredClaims(claim.leaseExpiresAt + 1)).toEqual({
      requeued: 0, failed: 0, cancelled: 1,
    })
    expect(store.getScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'cancelled',
      cancelRequestedAt: 300,
      outcomeCode: 'cancelled',
      terminalAt: claim.leaseExpiresAt + 1,
    })
    expect(store.advanceCheckpoint(
      job.jobId, claim.claimToken, 0, 1, claim.leaseExpiresAt + 2,
    )).toBe('stale_claim')
  })
})

function seedVersion(database: CortexDatabase, versionId: string): string {
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
  database.rawMainHandle.prepare(`
    INSERT INTO source_versions (
      source_version_id, source_id, checksum, verified_media_type,
      byte_count, object_key, inspection_state, created_at
    ) VALUES (?, ?, ?, 'text/plain', 4, ?, 'not_started', 20)
  `).run(
    versionId,
    source.sourceId,
    `sha256:${'a'.repeat(64)}`,
    `sources/${source.sourceId}/versions/${versionId}/original`,
  )
  database.rawMainHandle.prepare(`
    UPDATE runtime_sources SET registration_state = 'registered',
      current_version_id = ?, freshness_state = 'fresh', updated_at = 20
    WHERE source_id = ?
  `).run(versionId, source.sourceId)
  return source.sourceId
}
