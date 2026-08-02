import { describe, expect, it } from 'vitest'
import { csvDataViewOrdinalId } from '../../../src/gateway/csv-data-view.js'
import type { PreparedCsvDataViewArtifact } from '../../../src/gateway/source-byte-store.js'
import {
  SourceQuotaExceededError,
  type SourceQuotaLimits,
} from '../../../src/gateway/source-quota-policy.js'
import { PostgreSqlStorageAdapter } from '../../../src/storage/postgresql-adapter.js'
import { validateStoragePlan, type ValidatedPostgreSqlPlan } from '../../../src/storage/config.js'
import type { PostgreSqlPool } from '../../../src/storage/postgresql-driver.js'
import { createPostgreSqlSourceRepositories } from '../../../src/storage/postgresql-source-repositories.js'
import type { SourceRepositories } from '../../../src/storage/source-repositories.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = process.env['POSTGRES_TEST_URL'] ?? configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe
const WORKSPACE_ID = 'source-concurrency-workspace'
const PROFILE_ID = 'source-concurrency-profile'
const SOURCE_CHECKSUM = `sha256:${'a'.repeat(64)}`
const CHUNK_CHECKSUM = `sha256:${'b'.repeat(64)}`

interface Root {
  readonly sources: SourceRepositories
}

interface OpenAdapter {
  readonly adapter: PostgreSqlStorageAdapter<Root, object>
  readonly poolMetrics: () => {
    readonly total: number
    readonly idle: number
    readonly waiting: number
  }
}

const generousLimits: SourceQuotaLimits = {
  workspace: ceilings(64, 16_384, 64, 64, 64),
  profile: ceilings(64, 16_384, 64, 64, 64),
}

function ceilings(
  registrations: number,
  bytes: number,
  uploads: number,
  jobs: number,
  derived: number,
) {
  return {
    maxSourceRegistrations: registrations,
    maxRetainedAndReservedBytes: bytes,
    maxActiveUploadSessions: uploads,
    maxNonterminalJobs: jobs,
    maxDerivedResources: derived,
  }
}

function plan(url: string): ValidatedPostgreSqlPlan {
  const value = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => url },
      tls: { mode: 'disable', allowInsecureLoopback: true },
      pool: { maxConnections: 16 },
    },
  }, '/unused.db')
  if (value.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
  return value
}

async function openAdapter(
  storagePlan: ValidatedPostgreSqlPlan,
  quotaLimits: SourceQuotaLimits,
): Promise<OpenAdapter> {
  let pool: PostgreSqlPool | undefined
  const adapter = new PostgreSqlStorageAdapter<Root, object>({
    plan: storagePlan,
    repositories: {
      createRoot: (context) => {
        pool = context.pool
        return {
          sources: createPostgreSqlSourceRepositories(context, { quotaLimits }),
        }
      },
      createTransaction: () => ({}),
    },
  })
  await adapter.initialize()
  return {
    adapter,
    poolMetrics: () => {
      if (pool === undefined) throw new Error('PostgreSQL pool unavailable.')
      return {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      }
    },
  }
}

async function withAdapters(
  quotaLimits: SourceQuotaLimits,
  run: (primary: OpenAdapter, peer: OpenAdapter) => Promise<void>,
): Promise<void> {
  const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
  const storagePlan = plan(database.url)
  const primary = await openAdapter(storagePlan, quotaLimits)
  const peer = await openAdapter(storagePlan, quotaLimits)
  try {
    await run(primary, peer)
    assertPoolReleased(primary)
    assertPoolReleased(peer)
  } finally {
    await primary.adapter.close()
    await peer.adapter.close()
    // node-postgres resolves Pool.end() before every closed socket event has
    // necessarily been delivered. Let those events drain before DROP ... FORCE
    // so a later test cannot receive a backend-termination error from this DB.
    await new Promise<void>((resolve) => setImmediate(resolve))
    await database.close()
  }
}

function assertPoolReleased(open: OpenAdapter): void {
  const metrics = open.poolMetrics()
  expect(metrics.waiting).toBe(0)
  expect(metrics.total - metrics.idle).toBe(0)
}

function registration(profileId: string, label: string) {
  return {
    workspaceId: WORKSPACE_ID,
    profileId,
    kind: 'structured_export' as const,
    label,
    classification: 'internal' as const,
    authority: 'supporting_reference' as const,
    audiencePolicyRef: 'audience.source-concurrency',
    sensitivityPolicyRef: 'sensitivity.source-concurrency',
    purposePolicyRef: 'purpose.source-concurrency',
    retentionPolicyRef: 'retention.source-concurrency',
    freshnessPolicyRef: 'freshness.source-concurrency',
  }
}

async function completedVersion(
  repositories: SourceRepositories,
  label: string,
  profileId = PROFILE_ID,
  now = 10,
) {
  const source = await repositories.sources.create(registration(profileId, label), now)
  const principalKey = `source-concurrency\0${profileId}\0${label}`
  const upload = await repositories.uploads.create({
    sourceId: source.sourceId,
    workspaceId: WORKSPACE_ID,
    profileId,
    principalKey,
    expectedBytes: 8,
    expectedChecksum: SOURCE_CHECKSUM,
    declaredMediaType: 'text/plain',
    filename: `${label}.csv`,
  }, now + 1)
  await repositories.uploads.advanceChunk(upload.uploadId, 0, {
    byteCount: 8,
    checksum: CHUNK_CHECKSUM,
  }, now + 2)
  const versionId = await repositories.uploads.beginCompletion(upload.uploadId, now + 3)
  const version = await repositories.uploads.finishCompletion(upload.uploadId, {
    versionId,
    checksum: SOURCE_CHECKSUM,
    verifiedMediaType: 'text/plain',
    byteCount: 8,
    objectKey: `sources/${source.sourceId}/versions/${versionId}/original`,
  }, now + 4)
  return { source, upload, version, principalKey }
}

async function inspectVersion(
  repositories: SourceRepositories,
  sourceId: string,
  sourceVersionId: string,
  now = 100,
): Promise<void> {
  const job = await repositories.jobs.enqueue({
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    sourceId,
    sourceVersionId,
    operation: 'inspect_format',
  }, now)
  const claim = await repositories.jobs.claimNext('source-concurrency-inspector', now + 1)
  if (claim === null || claim.jobId !== job.jobId) throw new Error('Inspection claim unavailable.')
  for (const checkpoint of [1, 2, 3] as const) {
    expect(await repositories.jobs.advanceCheckpoint(
      job.jobId,
      claim.claimToken,
      checkpoint - 1,
      checkpoint,
      now + 1 + checkpoint,
    )).toBe('advanced')
  }
  expect(await repositories.jobs.finishInspection(
    job.jobId,
    claim.claimToken,
    'succeeded',
    'inspection_complete',
    now + 5,
  )).toBe('finished')
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
      artifactChecksum: `sha256:${'c'.repeat(64)}`,
      artifactByteCount: 128,
      fieldCount: 1,
      rowCount: 1,
      fields: [{
        fieldId: csvDataViewOrdinalId('field', sourceVersionId, 0),
        ordinal: 0,
        label: 'name',
      }],
    },
  }
}

function winners<T>(results: readonly PromiseSettledResult<T>[]): T[] {
  return results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
}

function expectQuotaLosers<T>(results: readonly PromiseSettledResult<T>[], count: number): void {
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  expect(rejected).toHaveLength(count)
  expect(rejected.every(({ reason }) => reason instanceof SourceQuotaExceededError)).toBe(true)
}

describePostgreSql('PostgreSQL source concurrency authority', () => {
  it('serializes workspace quota across profiles and upload reservations at the last slots', async () => {
    const quotaLimits: SourceQuotaLimits = {
      workspace: ceilings(4, 16, 4, 16, 16),
      profile: ceilings(4, 16, 4, 16, 16),
    }
    await withAdapters(quotaLimits, async (primary, peer) => {
      const repositories = [
        primary.adapter.repositories.sources,
        peer.adapter.repositories.sources,
      ]
      const attempts = Array.from({ length: 12 }, (_, index) => ({
        profileId: `source-concurrency-profile-${index}`,
        repository: repositories[index % repositories.length]!,
      }))
      const registrations = await Promise.allSettled(attempts.map(
        ({ profileId, repository }, index) =>
          repository.sources.create(registration(profileId, `source-${index}`), 100),
      ))
      const admitted = registrations.flatMap((result, index) =>
        result.status === 'fulfilled'
          ? [{ source: result.value, profileId: attempts[index]!.profileId }]
          : [],
      )
      expect(admitted).toHaveLength(4)
      expectQuotaLosers(registrations, 8)

      const uploads = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => {
        const target = admitted[index % admitted.length]!
        return repositories[index % repositories.length]!.uploads.create({
          sourceId: target.source.sourceId,
          workspaceId: WORKSPACE_ID,
          profileId: target.profileId,
          principalKey: `upload-quota-contender-${index}`,
          expectedBytes: 4,
          expectedChecksum: SOURCE_CHECKSUM,
          declaredMediaType: 'text/plain',
          filename: `quota-${index}.txt`,
        }, 200)
      }))
      expect(winners(uploads)).toHaveLength(4)
      expectQuotaLosers(uploads, 8)
      assertPoolReleased(primary)
      assertPoolReleased(peer)
    })
  }, 60_000)

  it('rolls back upload contention and fences source-job claim, defer, cancel, and recovery transitions', async () => {
    await withAdapters(generousLimits, async (primary, peer) => {
      const primarySources = primary.adapter.repositories.sources
      const peerSources = peer.adapter.repositories.sources
      const source = await primarySources.sources.create(registration(PROFILE_ID, 'upload-race'), 10)
      const principalKey = 'source-upload-checkpoint-race'
      const upload = await primarySources.uploads.create({
        sourceId: source.sourceId,
        workspaceId: WORKSPACE_ID,
        profileId: PROFILE_ID,
        principalKey,
        expectedBytes: 8,
        expectedChecksum: SOURCE_CHECKSUM,
        declaredMediaType: 'text/plain',
        filename: 'race.txt',
      }, 20)
      const chunkRace = await Promise.allSettled([
        primarySources.uploads.advanceChunk(upload.uploadId, 0, {
          byteCount: 4, checksum: CHUNK_CHECKSUM,
        }, 30),
        peerSources.uploads.advanceChunk(upload.uploadId, 0, {
          byteCount: 4, checksum: CHUNK_CHECKSUM,
        }, 30),
      ])
      expect(winners(chunkRace)).toEqual([{ offset: 4, chunkCount: 1 }])
      expect(chunkRace.filter((result) => result.status === 'rejected')).toHaveLength(1)
      expect(await primarySources.uploads.getScoped(
        upload.uploadId, WORKSPACE_ID, PROFILE_ID, principalKey, 31,
      )).toMatchObject({ offset: 4, chunkCount: 1 })
      await expect(peerSources.uploads.advanceChunk(upload.uploadId, 4, {
        byteCount: 4, checksum: CHUNK_CHECKSUM,
      }, 32)).resolves.toEqual({ offset: 8, chunkCount: 2 })
      const versionId = await primarySources.uploads.beginCompletion(upload.uploadId, 33)
      await primarySources.uploads.finishCompletion(upload.uploadId, {
        versionId,
        checksum: SOURCE_CHECKSUM,
        verifiedMediaType: 'text/plain',
        byteCount: 8,
        objectKey: `sources/${source.sourceId}/versions/${versionId}/original`,
      }, 34)

      const job = await primarySources.jobs.enqueue({
        workspaceId: WORKSPACE_ID,
        profileId: PROFILE_ID,
        sourceId: source.sourceId,
        sourceVersionId: versionId,
        operation: 'inspect_format',
      }, 100)
      const repositories = [primarySources, peerSources]
      const claims = await Promise.all(Array.from({ length: 24 }, (_, index) =>
        repositories[index % repositories.length]!.jobs.claimNext(`source-worker-${index}`, 200),
      ))
      const live = claims.filter((claim) => claim !== null)
      expect(live).toHaveLength(1)
      expect(live[0]).toMatchObject({ jobId: job.jobId, attempt: 1, checkpoint: 0 })
      const claim = live[0]!
      const checkpointRace = await Promise.all([
        primarySources.jobs.advanceCheckpoint(job.jobId, claim.claimToken, 0, 1, 201),
        peerSources.jobs.advanceCheckpoint(job.jobId, claim.claimToken, 0, 1, 201),
      ])
      expect(checkpointRace.filter((result) => result === 'advanced')).toHaveLength(1)
      expect(checkpointRace.filter((result) => result !== 'advanced')).toHaveLength(1)
      expect(await peerSources.jobs.recoverExpiredClaims(claim.leaseExpiresAt + 1))
        .toEqual({ requeued: 1, failed: 0, cancelled: 0 })
      expect(await primarySources.jobs.advanceCheckpoint(
        job.jobId, claim.claimToken, 1, 2, claim.leaseExpiresAt + 2,
      )).toBe('stale_claim')
      const successor = await peerSources.jobs.claimNext(
        'source-worker-successor', claim.leaseExpiresAt + 2,
      )
      expect(successor).toMatchObject({ jobId: job.jobId, attempt: 2, checkpoint: 1 })
      const retryAt = successor!.leaseExpiresAt + 100
      expect(await primarySources.jobs.deferUntil(
        job.jobId, successor!.claimToken, retryAt, successor!.leaseExpiresAt - 1,
      )).toBe('deferred')
      expect(await peerSources.jobs.advanceCheckpoint(
        job.jobId, successor!.claimToken, 1, 2, successor!.leaseExpiresAt,
      )).toBe('stale_claim')
      expect(await primarySources.jobs.claimNext('source-worker-too-early', retryAt - 1)).toBeNull()
      const cancellationClaim = await peerSources.jobs.claimNext(
        'source-worker-cancellation', retryAt,
      )
      expect(cancellationClaim).toMatchObject({ jobId: job.jobId, attempt: 3, checkpoint: 1 })
      expect(await primarySources.jobs.requestCancel(
        job.jobId, WORKSPACE_ID, PROFILE_ID, retryAt + 1,
      )).toBe('requested')
      expect(await peerSources.jobs.confirmCancelled(
        job.jobId, 'stale-token', retryAt + 2,
      )).toBe('stale_claim')
      expect(await primarySources.jobs.confirmCancelled(
        job.jobId, cancellationClaim!.claimToken, retryAt + 2,
      )).toBe('cancelled')
      assertPoolReleased(primary)
      assertPoolReleased(peer)
    })
  }, 60_000)

  it('fences N-worker Data View and deletion claims plus same-token checkpoint races', async () => {
    await withAdapters(generousLimits, async (primary, peer) => {
      const primarySources = primary.adapter.repositories.sources
      const peerSources = peer.adapter.repositories.sources
      const prepared = await completedVersion(primarySources, 'data-view-race')
      await inspectVersion(
        primarySources,
        prepared.source.sourceId,
        prepared.version.sourceVersionId,
      )
      const dataViewJob = await primarySources.dataViews.enqueue({
        workspaceId: WORKSPACE_ID,
        profileId: PROFILE_ID,
        sourceId: prepared.source.sourceId,
        sourceVersionId: prepared.version.sourceVersionId,
      }, 200)
      const repositories = [primarySources, peerSources]
      const dataViewClaims = await Promise.all(Array.from({ length: 24 }, (_, index) =>
        repositories[index % repositories.length]!.dataViews.claimNext(
          `data-view-worker-${index}`,
          300,
        ),
      ))
      const dataViewWinners = dataViewClaims.filter((claim) => claim !== null)
      expect(dataViewWinners).toHaveLength(1)
      const dataViewClaim = dataViewWinners[0]!
      expect(dataViewClaim).toMatchObject({ jobId: dataViewJob.jobId, attempt: 1 })
      const dataViewCheckpoint = await Promise.all([
        primarySources.dataViews.advanceCheckpoint(
          dataViewJob.jobId, dataViewClaim.claimToken, 0, 1, 301,
        ),
        peerSources.dataViews.advanceCheckpoint(
          dataViewJob.jobId, dataViewClaim.claimToken, 0, 1, 301,
        ),
      ])
      expect(dataViewCheckpoint.sort()).toEqual(['advanced', 'checkpoint_conflict'])
      expect(await primarySources.dataViews.advanceCheckpoint(
        dataViewJob.jobId, 'stale-token', 1, 2, 302,
      )).toBe('stale_claim')
      expect(await peerSources.dataViews.recoverExpiredClaims(dataViewClaim.leaseExpiresAt + 1))
        .toEqual({ requeued: 1, failed: 0 })
      expect(await primarySources.dataViews.advanceCheckpoint(
        dataViewJob.jobId,
        dataViewClaim.claimToken,
        1,
        2,
        dataViewClaim.leaseExpiresAt + 2,
      )).toBe('stale_claim')
      expect(dataViewArtifact(
        prepared.source.sourceId,
        prepared.version.sourceVersionId,
        dataViewClaim.dataViewId,
      ).manifest.rowCount).toBe(1)

      const cancellable = await completedVersion(primarySources, 'data-view-cancellation', PROFILE_ID, 500)
      await inspectVersion(
        primarySources,
        cancellable.source.sourceId,
        cancellable.version.sourceVersionId,
        600,
      )
      const cancellableJob = await primarySources.dataViews.enqueue({
        workspaceId: WORKSPACE_ID,
        profileId: PROFILE_ID,
        sourceId: cancellable.source.sourceId,
        sourceVersionId: cancellable.version.sourceVersionId,
      }, 700)
      expect(await primarySources.dataViews.requestCancel(
        cancellableJob.jobId, WORKSPACE_ID, PROFILE_ID, 701,
      )).toBe('requested')
      const cancellationClaims = await Promise.all(Array.from({ length: 24 }, (_, index) =>
        repositories[index % repositories.length]!.dataViews.claimNextCancellation(
          `data-view-cleanup-${index}`,
          702,
        ),
      ))
      const cancellationWinners = cancellationClaims.filter((claim) => claim !== null)
      expect(cancellationWinners).toHaveLength(1)
      expect(await primarySources.dataViews.confirmCancelled(
        cancellableJob.jobId, 'stale-token', 703,
      )).toBe('stale_claim')
      expect(await peerSources.dataViews.confirmCancelled(
        cancellableJob.jobId, cancellationWinners[0]!.claimToken, 703,
      )).toBe('cancelled')

      const deletionSource = await primarySources.sources.create(
        registration(PROFILE_ID, 'deletion-race'),
        400,
      )
      const deletionPlan = await primarySources.deletions.plan({
        workspaceId: WORKSPACE_ID,
        profileId: PROFILE_ID,
        sourceId: deletionSource.sourceId,
        expectedRevision: 1,
      }, 410)
      const deletionClaims = await Promise.all(Array.from({ length: 24 }, (_, index) =>
        repositories[index % repositories.length]!.deletions.claimNext(
          `deletion-worker-${index}`,
          420,
        ),
      ))
      const deletionWinners = deletionClaims.filter((claim) => claim !== null)
      expect(deletionWinners).toHaveLength(1)
      const deletionClaim = deletionWinners[0]!
      expect(deletionClaim).toMatchObject({ jobId: deletionPlan.jobId, attempt: 1, checkpoint: 0 })
      const startRace = await Promise.all([
        primarySources.deletions.startDestruction(
          deletionPlan.jobId, deletionClaim.claimToken, 421,
        ),
        peerSources.deletions.startDestruction(
          deletionPlan.jobId, deletionClaim.claimToken, 421,
        ),
      ])
      expect(startRace.sort()).toEqual(['advanced', 'checkpoint_conflict'])
      expect(await primarySources.deletions.advanceCheckpoint(
        deletionPlan.jobId,
        'stale-token',
        1,
        2,
        422,
      )).toBe('stale_claim')
      assertPoolReleased(primary)
      assertPoolReleased(peer)
    })
  }, 60_000)
})
