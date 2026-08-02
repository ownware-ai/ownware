import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { csvDataViewOrdinalId } from '../../src/gateway/csv-data-view.js'
import type { PreparedCsvDataViewArtifact } from '../../src/gateway/source-byte-store.js'
import { SourceQuotaExceededError } from '../../src/gateway/source-quota-policy.js'
import type { SourceRepositories } from '../../src/storage/source-repositories.js'

export interface SourceRepositoryPeer {
  readonly repositories: SourceRepositories
  close(): Promise<void>
}

export interface SourceRepositoryHarness {
  readonly repositories: SourceRepositories
  openPeer(): Promise<SourceRepositoryPeer>
  reopen(): Promise<void>
  close(): Promise<void>
}

export type SourceRepositoryHarnessFactory = () => Promise<SourceRepositoryHarness>

const WORKSPACE_ID = 'contract-workspace'
const PROFILE_ID = 'contract-profile'
const SOURCE_CHECKSUM = `sha256:${'a'.repeat(64)}`
const CHUNK_CHECKSUM = `sha256:${'c'.repeat(64)}`

/**
 * Backend-neutral contract for source metadata and durable workers moved in
 * STO-06. Filesystem placement/removal has a separate effect-boundary suite;
 * this contract proves the database authority every adapter must share.
 */
export function runSourceRepositoryContract(
  name: string,
  createHarness: SourceRepositoryHarnessFactory,
): void {
  describe(`source storage repository contract — ${name}`, () => {
    let harness: SourceRepositoryHarness

    beforeEach(async () => {
      harness = await createHarness()
    })

    afterEach(async () => {
      await harness.close()
    })

    it('keeps registration, upload reservation and exact version durable', async () => {
      let repositories = harness.repositories
      const prepared = await prepareVersion(repositories, 'durable source')
      expect(await repositories.sources.getScoped(
        prepared.source.sourceId, WORKSPACE_ID, PROFILE_ID,
      )).toMatchObject({
        revision: 2,
        currentVersionId: prepared.version.sourceVersionId,
        health: {
          registration: 'registered',
          inspection: 'not_started',
          deletion: 'active',
        },
      })
      expect(await repositories.uploads.getCompletedVersion(prepared.uploadId))
        .toEqual(prepared.version)
      expect(await repositories.uploads.getVersionScoped(
        prepared.source.sourceId,
        prepared.version.sourceVersionId,
        WORKSPACE_ID,
        PROFILE_ID,
      )).toEqual(prepared.version)
      expect(await repositories.uploads.getVersionScoped(
        prepared.source.sourceId,
        prepared.version.sourceVersionId,
        'other-workspace',
        PROFILE_ID,
      )).toBeNull()

      await harness.reopen()
      repositories = harness.repositories
      expect((await repositories.sources.getScoped(
        prepared.source.sourceId, WORKSPACE_ID, PROFILE_ID,
      ))?.currentVersionId).toBe(prepared.version.sourceVersionId)
      expect((await repositories.uploads.getCompletedVersion(prepared.uploadId))?.checksum)
        .toBe(SOURCE_CHECKSUM)
    })

    it('admits only one contender for the final registration quota slot', async () => {
      const repositories = harness.repositories
      for (let index = 0; index < 3; index += 1) {
        await repositories.sources.create(registration(`quota-${index}`), 100 + index)
      }
      const peer = await harness.openPeer()
      try {
        const results = await Promise.allSettled([
          repositories.sources.create(registration('quota-primary'), 200),
          peer.repositories.sources.create(registration('quota-peer'), 200),
        ])
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        const rejected = results.find(result => result.status === 'rejected')
        expect(rejected).toMatchObject({
          status: 'rejected',
          reason: expect.any(SourceQuotaExceededError),
        })
        expect((await repositories.sources.listScoped(
          WORKSPACE_ID, PROFILE_ID, { limit: 20 },
        )).items).toHaveLength(4)
      } finally {
        await peer.close()
      }
    })

    it('has one live source-job claim and rejects a stale owner after expiry', async () => {
      const repositories = harness.repositories
      const prepared = await prepareVersion(repositories, 'claim source')
      const job = await repositories.jobs.enqueue({
        workspaceId: WORKSPACE_ID,
        profileId: PROFILE_ID,
        sourceId: prepared.source.sourceId,
        sourceVersionId: prepared.version.sourceVersionId,
        operation: 'inspect_format',
      }, 100)
      const peer = await harness.openPeer()
      try {
        const claims = await Promise.all([
          repositories.jobs.claimNext('contract-worker-primary', 200),
          peer.repositories.jobs.claimNext('contract-worker-peer', 200),
        ])
        expect(claims.filter(Boolean)).toHaveLength(1)
        const first = claims.find(claim => claim !== null)!
        expect(await repositories.jobs.advanceCheckpoint(
          first.jobId, first.claimToken, 0, 1, 201,
        )).toBe('advanced')
        expect(await repositories.jobs.recoverExpiredClaims(first.leaseExpiresAt + 1))
          .toMatchObject({ requeued: 1 })
        const successor = await peer.repositories.jobs.claimNext(
          'contract-worker-successor', first.leaseExpiresAt + 2,
        )
        expect(successor).not.toBeNull()
        expect(await repositories.jobs.advanceCheckpoint(
          first.jobId,
          first.claimToken,
          1,
          2,
          first.leaseExpiresAt + 3,
        )).toBe('stale_claim')
        expect(await peer.repositories.jobs.advanceCheckpoint(
          successor!.jobId,
          successor!.claimToken,
          1,
          2,
          first.leaseExpiresAt + 3,
        )).toBe('advanced')
        expect((await repositories.jobs.getScoped(
          job.jobId, WORKSPACE_ID, PROFILE_ID,
        ))?.checkpoint).toBe(2)
      } finally {
        await peer.close()
      }
    })

    it('publishes one bounded Data View under the exact claim and reopens it', async () => {
      let repositories = harness.repositories
      const prepared = await prepareVersion(repositories, 'data view source', true)
      const job = await repositories.dataViews.enqueue({
        workspaceId: WORKSPACE_ID,
        profileId: PROFILE_ID,
        sourceId: prepared.source.sourceId,
        sourceVersionId: prepared.version.sourceVersionId,
      }, 500)
      const claim = await repositories.dataViews.claimNext('contract-data-view', 600)
      expect(claim).not.toBeNull()
      const active = claim!
      expect(await repositories.dataViews.advanceCheckpoint(
        active.jobId, active.claimToken, 0, 1, 610,
      )).toBe('advanced')
      expect(await repositories.dataViews.advanceCheckpoint(
        active.jobId, active.claimToken, 1, 2, 620,
      )).toBe('advanced')
      expect(await repositories.dataViews.advanceCheckpoint(
        active.jobId, active.claimToken, 2, 3, 630,
      )).toBe('advanced')
      expect(await repositories.dataViews.publish(
        active.jobId,
        active.claimToken,
        dataViewArtifact(
          prepared.source.sourceId,
          prepared.version.sourceVersionId,
          active.dataViewId,
        ),
        640,
      )).toBe('finished')
      const view = await repositories.dataViews.getViewScoped(
        active.dataViewId, WORKSPACE_ID, PROFILE_ID,
      )
      expect(view).toMatchObject({
        jobId: job.jobId,
        dataViewId: active.dataViewId,
        sourceId: prepared.source.sourceId,
        sourceVersionId: prepared.version.sourceVersionId,
        fieldCount: 2,
        rowCount: 1,
        freshness: 'current',
      })
      expect(JSON.stringify(view)).not.toContain('privateObjectKey')

      await harness.reopen()
      repositories = harness.repositories
      expect(await repositories.dataViews.getViewScoped(
        active.dataViewId, WORKSPACE_ID, PROFILE_ID,
      )).toEqual(view)
    })

    it('keeps deletion freeze/plan durable and thaws only a reversible cancellation', async () => {
      let repositories = harness.repositories
      const prepared = await prepareVersion(repositories, 'deletion source')
      const plan = await repositories.deletions.plan({
        workspaceId: WORKSPACE_ID,
        profileId: PROFILE_ID,
        sourceId: prepared.source.sourceId,
        expectedRevision: 2,
      }, 1_000)
      expect((await repositories.sources.getScoped(
        prepared.source.sourceId, WORKSPACE_ID, PROFILE_ID,
      ))?.health.deletion).toBe('frozen')
      expect((await repositories.deletions.getInventoryEntries(plan.jobId)).length)
        .toBeGreaterThan(0)

      await harness.reopen()
      repositories = harness.repositories
      expect((await repositories.deletions.getScoped(
        prepared.source.sourceId, WORKSPACE_ID, PROFILE_ID,
      ))?.state).toBe('queued')
      expect((await repositories.sources.getScoped(
        prepared.source.sourceId, WORKSPACE_ID, PROFILE_ID,
      ))?.health.deletion).toBe('frozen')
      expect(await repositories.deletions.requestCancellation(
        plan.jobId, WORKSPACE_ID, PROFILE_ID, 1_100,
      )).toBe('requested')
      expect(await repositories.deletions.confirmNextCancellation(1_101)).toBe(true)
      expect((await repositories.sources.getScoped(
        prepared.source.sourceId, WORKSPACE_ID, PROFILE_ID,
      ))?.health.deletion).toBe('active')
      expect(await repositories.deletions.getPublicByJobScoped(
        plan.jobId, WORKSPACE_ID, PROFILE_ID,
      )).toMatchObject({ state: 'cancelled', terminalAt: 1_101 })
    })
  })
}

function registration(label: string) {
  return {
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    kind: 'structured_export' as const,
    label,
    classification: 'internal' as const,
    authority: 'supporting_reference' as const,
    audiencePolicyRef: 'audience.policy.contract',
    sensitivityPolicyRef: 'sensitivity.policy.contract',
    purposePolicyRef: 'purpose.policy.contract',
    retentionPolicyRef: 'retention.policy.contract',
    freshnessPolicyRef: 'freshness.policy.contract',
  }
}

async function prepareVersion(
  repositories: SourceRepositories,
  label: string,
  inspect = false,
) {
  const source = await repositories.sources.create(registration(label), 10)
  const upload = await repositories.uploads.create({
    sourceId: source.sourceId,
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    principalKey: `delegated\0contract-principal-${label}\0workspace\0profile`,
    expectedBytes: 16,
    expectedChecksum: SOURCE_CHECKSUM,
    declaredMediaType: 'text/plain',
    filename: 'contract.csv',
  }, 20)
  await repositories.uploads.advanceChunk(
    upload.uploadId,
    0,
    { byteCount: 16, checksum: CHUNK_CHECKSUM },
    30,
  )
  const versionId = await repositories.uploads.beginCompletion(upload.uploadId, 40)
  const version = await repositories.uploads.finishCompletion(upload.uploadId, {
    versionId,
    checksum: SOURCE_CHECKSUM,
    verifiedMediaType: 'text/plain',
    byteCount: 16,
    objectKey: `sources/${source.sourceId}/versions/${versionId}/original`,
  }, 50)
  if (inspect) {
    const job = await repositories.jobs.enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId: source.sourceId,
      sourceVersionId: version.sourceVersionId,
      operation: 'inspect_format',
    }, 60)
    const claim = await repositories.jobs.claimNext('contract-inspection', 70)
    if (!claim || claim.jobId !== job.jobId) throw new Error('inspection claim unavailable')
    await repositories.jobs.advanceCheckpoint(job.jobId, claim.claimToken, 0, 1, 71)
    await repositories.jobs.advanceCheckpoint(job.jobId, claim.claimToken, 1, 2, 72)
    await repositories.jobs.advanceCheckpoint(job.jobId, claim.claimToken, 2, 3, 73)
    expect(await repositories.jobs.finishInspection(
      job.jobId, claim.claimToken, 'succeeded', 'inspection_complete', 74,
    )).toBe('finished')
  }
  return { source, uploadId: upload.uploadId, version }
}

function dataViewArtifact(
  sourceId: string,
  sourceVersionId: string,
  dataViewId: string,
): PreparedCsvDataViewArtifact {
  return {
    privateObjectKey:
      `sources/${sourceId}/versions/${sourceVersionId}/data-views/${dataViewId}.json`,
    manifest: {
      dataViewId,
      implementationVersion: 'csv_data_view.v1',
      sourceVersionId,
      sourceChecksum: SOURCE_CHECKSUM,
      artifactChecksum: `sha256:${'b'.repeat(64)}`,
      artifactByteCount: 128,
      fieldCount: 2,
      rowCount: 1,
      fields: [
        {
          fieldId: csvDataViewOrdinalId('field', sourceVersionId, 0),
          ordinal: 0,
          label: 'name',
        },
        {
          fieldId: csvDataViewOrdinalId('field', sourceVersionId, 1),
          ordinal: 1,
          label: 'value',
        },
      ],
    },
  }
}
