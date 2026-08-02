import { describe, expect, it } from 'vitest'
import { ACCESS_GRANT_MIN_TTL_SECONDS } from '../../../src/gateway/access-grant-store.js'
import type { EvidenceSearchCache } from '../../../src/gateway/evidence-search-cache.js'
import type { SourceQuotaLimits } from '../../../src/gateway/source-quota-policy.js'
import { validateStoragePlan } from '../../../src/storage/config.js'
import { PostgreSqlStorageAdapter } from '../../../src/storage/postgresql-adapter.js'
import { createPostgreSqlAccessGrantRepository } from '../../../src/storage/postgresql-access-grant-repository.js'
import { createPostgreSqlSourceDeletionRepository } from '../../../src/storage/postgresql-source-deletion-repository.js'
import {
  createPostgreSqlSourceRepository,
  createPostgreSqlSourceUploadRepository,
} from '../../../src/storage/postgresql-source-foundation.js'
import { createPostgreSqlSourceJobRepository } from '../../../src/storage/postgresql-source-job-repository.js'
import type { AccessGrantRepository } from '../../../src/storage/security-repositories.js'
import type {
  SourceDeletionRepository,
  SourceJobRepository,
  SourceRepository,
  SourceUploadRepository,
} from '../../../src/storage/source-repositories.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe
const WORKSPACE_ID = 'deletion-repository-workspace'
const PROFILE_ID = 'deletion-repository-profile'
const CHECKSUM = `sha256:${'a'.repeat(64)}`

const limits: SourceQuotaLimits = {
  workspace: {
    maxSourceRegistrations: 20,
    maxRetainedAndReservedBytes: 10_000_000,
    maxActiveUploadSessions: 20,
    maxNonterminalJobs: 20,
    maxDerivedResources: 20,
  },
  profile: {
    maxSourceRegistrations: 20,
    maxRetainedAndReservedBytes: 10_000_000,
    maxActiveUploadSessions: 20,
    maxNonterminalJobs: 20,
    maxDerivedResources: 20,
  },
}

interface Root {
  readonly sources: SourceRepository
  readonly uploads: SourceUploadRepository
  readonly jobs: SourceJobRepository
  readonly deletions: SourceDeletionRepository
  readonly grants: AccessGrantRepository
}

function registration(label: string) {
  return {
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    kind: 'structured_export' as const,
    label,
    classification: 'internal' as const,
    authority: 'supporting_reference' as const,
    audiencePolicyRef: 'audience.policy.deletion-test',
    sensitivityPolicyRef: 'sensitivity.policy.deletion-test',
    purposePolicyRef: 'purpose.policy.deletion-test',
    retentionPolicyRef: 'retention.policy.deletion-test',
    freshnessPolicyRef: 'freshness.policy.deletion-test',
  }
}

function storagePlan(url: string) {
  const plan = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => url },
      tls: { mode: 'disable', allowInsecureLoopback: true },
    },
  }, '/unused.db')
  if (plan.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
  return plan
}

function testCache() {
  let entries = 1
  const invalidatedGrants: string[] = []
  const cache = {
    inventorySource: () => ({ entries, retainedBytes: entries * 8 }),
    invalidateSource: () => { entries = 0 },
    invalidateGrant: (scope: { readonly grantId: string }) => {
      invalidatedGrants.push(scope.grantId)
    },
  } as unknown as EvidenceSearchCache
  return { cache, entries: () => entries, invalidatedGrants }
}

async function completedVersion(repositories: Root, label: string, now = 10) {
  const source = await repositories.sources.create(registration(label), now)
  const upload = await repositories.uploads.create({
    sourceId: source.sourceId,
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    principalKey: `deletion-principal-${label}`,
    expectedBytes: 16,
    expectedChecksum: CHECKSUM,
    declaredMediaType: 'text/plain',
    filename: `${label}.txt`,
  }, now + 1)
  await repositories.uploads.advanceChunk(upload.uploadId, 0, {
    byteCount: 16,
    checksum: `sha256:${'b'.repeat(64)}`,
  }, now + 2)
  const versionId = await repositories.uploads.beginCompletion(upload.uploadId, now + 3)
  const version = await repositories.uploads.finishCompletion(upload.uploadId, {
    versionId,
    checksum: CHECKSUM,
    verifiedMediaType: 'text/plain',
    byteCount: 16,
    objectKey: `sources/${source.sourceId}/versions/${versionId}/original`,
  }, now + 4)
  return { source, upload, version }
}

async function preparedResource(repositories: Root, sourceId: string, versionId: string) {
  const inspection = await repositories.jobs.enqueue({
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    sourceId,
    sourceVersionId: versionId,
    operation: 'inspect_format',
  }, 20)
  const inspectionClaim = await repositories.jobs.claimNext('deletion-inspection', 21)
  if (inspectionClaim === null || inspectionClaim.jobId !== inspection.jobId) {
    throw new Error('Expected the inspection claim.')
  }
  for (const checkpoint of [1, 2, 3] as const) {
    await repositories.jobs.advanceCheckpoint(
      inspection.jobId, inspectionClaim.claimToken, checkpoint - 1, checkpoint, 21 + checkpoint,
    )
  }
  await repositories.jobs.finishInspection(
    inspection.jobId, inspectionClaim.claimToken, 'succeeded', 'inspection_complete', 25,
  )
  const preparation = await repositories.jobs.enqueuePreparation({
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    sourceId,
    sourceVersionId: versionId,
  }, 30)
  const preparationClaim = await repositories.jobs.claimNext('deletion-preparation', 31)
  if (preparationClaim === null || preparationClaim.jobId !== preparation.jobId ||
    preparationClaim.resourceId === null) {
    throw new Error('Expected the preparation claim.')
  }
  for (const checkpoint of [1, 2, 3] as const) {
    await repositories.jobs.advanceCheckpoint(
      preparation.jobId, preparationClaim.claimToken, checkpoint - 1, checkpoint, 31 + checkpoint,
    )
  }
  await repositories.jobs.finishPreparation(
    preparation.jobId, preparationClaim.claimToken, 'succeeded', 'preparation_complete', 35,
  )
  return preparationClaim.resourceId
}

async function verifyAndRemoveInventory(
  deletions: SourceDeletionRepository,
  jobId: string,
  claimToken: string,
  now: number,
): Promise<void> {
  const entries = await deletions.getInventoryEntries(jobId)
  for (const entry of entries) {
    switch (entry.kind) {
      case 'retrieval_cache':
        expect(await deletions.removeRetrievalCacheArtifact(
          jobId, claimToken, entry.id, now,
        )).toBe(true)
        expect(await deletions.retrievalCacheArtifactAbsent(jobId, entry.id)).toBe(true)
        break
      case 'access_grant_revocation':
        expect(await deletions.ensureGrantRevoked(jobId, entry.id, now)).toBe(true)
        expect(await deletions.grantRevocationEffective(jobId, entry.id)).toBe(true)
        break
      case 'immutable_original':
      case 'placed_candidate':
        expect(await deletions.versionLocatorMatches(jobId, entry.kind, entry.id)).toBe(true)
        break
      case 'data_view':
        expect(await deletions.dataViewLocator(jobId, entry.id)).not.toBeNull()
        expect(await deletions.removeControlArtifact(
          jobId, claimToken, entry.kind, entry.id, now,
        )).toBe(true)
        expect(await deletions.controlArtifactAbsent(entry.kind, entry.id)).toBe(true)
        break
      case 'upload_staging':
      case 'derived_resource':
      case 'source_job':
      case 'idempotency_replay':
      case 'grant_mutation_replay':
        expect(await deletions.removeControlArtifact(
          jobId, claimToken, entry.kind, entry.id, now,
        )).toBe(true)
        expect(await deletions.controlArtifactAbsent(entry.kind, entry.id)).toBe(true)
        break
      case 'search_index':
        throw new Error('Search-index removal needs an external effect implementation.')
    }
    expect(await deletions.markArtifact(
      jobId, claimToken, entry.kind, entry.id, 'removed', now + 1,
    )).toBe('advanced')
    expect(await deletions.markArtifact(
      jobId, claimToken, entry.kind, entry.id, 'verified_absent', now + 2,
    )).toBe('advanced')
  }
}

describePostgreSql('PostgreSQL source-deletion repository', () => {
  it('freezes, inventories, fences, partially retries, and terminally deletes a source', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const cache = testCache()
    const open = async () => {
      const adapter = new PostgreSqlStorageAdapter<Root, object>({
        plan: storagePlan(database.url),
        repositories: {
          createRoot: (context) => ({
            sources: createPostgreSqlSourceRepository(context, limits),
            uploads: createPostgreSqlSourceUploadRepository(context, limits),
            jobs: createPostgreSqlSourceJobRepository(context, limits),
            deletions: createPostgreSqlSourceDeletionRepository(context, cache.cache),
            grants: createPostgreSqlAccessGrantRepository(context, cache.cache),
          }),
          createTransaction: () => ({}),
        },
      })
      await adapter.initialize()
      return adapter
    }
    const primary = await open()
    const peer = await open()
    try {
      const prepared = await completedVersion(primary.repositories, 'destructive')
      const resourceId = await preparedResource(
        primary.repositories, prepared.source.sourceId, prepared.version.sourceVersionId,
      )
      const grant = await primary.repositories.grants.createPreparedTextAccessGrant({
        workspaceId: WORKSPACE_ID,
        profileId: PROFILE_ID,
        subjectId: 'person.deletion-test',
        purpose: 'customer_support',
        channel: 'web.primary',
        resourceId,
        operation: 'source_content.search',
        consent: { state: 'not_required' },
        ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
        issuedBy: 'owner.deletion-test',
      }, 900)
      const [[plan, concurrentReplay], concurrentGrant] = await Promise.all([
        Promise.all([
          primary.repositories.deletions.plan({
            workspaceId: WORKSPACE_ID,
            profileId: PROFILE_ID,
            sourceId: prepared.source.sourceId,
            expectedRevision: 2,
          }, 1_000),
          peer.repositories.deletions.plan({
            workspaceId: WORKSPACE_ID,
            profileId: PROFILE_ID,
            sourceId: prepared.source.sourceId,
            expectedRevision: 2,
          }, 1_001),
        ]),
        peer.repositories.grants.createPreparedTextAccessGrant({
          workspaceId: WORKSPACE_ID,
          profileId: PROFILE_ID,
          subjectId: 'person.concurrent-deletion-test',
          purpose: 'customer_support',
          channel: 'web.primary',
          resourceId,
          operation: 'source_content.read',
          consent: { state: 'not_required' },
          ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
          issuedBy: 'owner.deletion-test',
        }, 901).then(
          (value) => ({ kind: 'created' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        ),
      ])
      expect(concurrentReplay).toEqual(plan)
      if (concurrentGrant.kind === 'created') {
        expect(await primary.repositories.grants.getCurrentForOwner(
          concurrentGrant.value.grantId,
        )).toMatchObject({ state: 'revoked', revision: 2 })
      } else {
        expect(concurrentGrant.error).toMatchObject({
          name: 'AccessGrantStoreError',
          code: 'access_grant_resource_unavailable',
        })
      }
      expect(cache.entries()).toBe(0)
      expect(plan).toMatchObject({
        sourceId: prepared.source.sourceId,
        sourceRevision: 3,
        state: 'queued',
        inventoryState: 'complete',
        inventoryCounts: {
          immutableOriginals: 1,
          uploadStaging: 1,
          placedCandidates: 1,
          derivedResources: 1,
          sourceJobs: 2,
          retrievalCacheEntries: 1,
        },
      })
      await expect(primary.repositories.deletions.plan({
        workspaceId: WORKSPACE_ID,
        profileId: PROFILE_ID,
        sourceId: prepared.source.sourceId,
        expectedRevision: 2,
      }, 1_001)).resolves.toEqual(plan)
      expect(await primary.repositories.deletions.getPublicBySourceScoped(
        prepared.source.sourceId, WORKSPACE_ID, PROFILE_ID,
      )).toMatchObject({ state: 'queued', remaining: { immutableOriginals: 1 } })
      expect(await primary.repositories.deletions.dataViewLocator(plan.jobId, 'missing')).toBeNull()
      expect(await primary.repositories.deletions.ensureGrantRevoked(
        plan.jobId, '00000000-0000-4000-8000-000000000000', 1_002,
      )).toBe(false)
      expect(await primary.repositories.deletions.grantRevocationEffective(
        plan.jobId, grant.grantId,
      )).toBe(true)
      expect(await primary.repositories.grants.getCurrentForOwner(grant.grantId))
        .toMatchObject({ state: 'revoked', revision: 2 })
      expect(plan.inventoryCounts.accessGrantRevocations).toBeGreaterThanOrEqual(1)
      expect(cache.invalidatedGrants).toContain(grant.grantId)

      const contenders = await Promise.all([
        primary.repositories.deletions.claimNext('deletion-primary', 1_010),
        peer.repositories.deletions.claimNext('deletion-peer', 1_010),
      ])
      const claim = contenders.find((candidate) => candidate !== null)
      expect(claim).not.toBeNull()
      expect(contenders.filter((candidate) => candidate !== null)).toHaveLength(1)
      if (claim === null) throw new Error('Expected a deletion claim.')
      expect(await primary.repositories.deletions.renewClaim(
        plan.jobId, claim.claimToken, 1_011,
      )).toBe(true)
      expect(await primary.repositories.deletions.startDestruction(
        plan.jobId, 'stale-token', 1_012,
      )).toBe('stale_claim')
      expect(await primary.repositories.deletions.startDestruction(
        plan.jobId, claim.claimToken, 1_012,
      )).toBe('advanced')
      expect(await primary.repositories.deletions.requestCancellation(
        plan.jobId, WORKSPACE_ID, PROFILE_ID, 1_013,
      )).toBe('destruction_started')
      expect(await primary.repositories.deletions.advanceCheckpoint(
        plan.jobId, claim.claimToken, 1, 2, 1_014,
      )).toBe('advanced')
      expect(await primary.repositories.deletions.advanceCheckpoint(
        plan.jobId, claim.claimToken, 2, 3, 1_015,
      )).toBe('advanced')
      expect(await primary.repositories.deletions.finish(
        plan.jobId, claim.claimToken, 1_016,
      )).toBe('partial')
      expect(await primary.repositories.deletions.retryPartialScoped(
        plan.jobId, 'wrong-workspace', PROFILE_ID, 1_017,
      )).toBe('missing')
      expect(await primary.repositories.deletions.retryPartial(plan.jobId, 1_018)).toBe('queued')

      const retry = await primary.repositories.deletions.claimNext('deletion-retry', 1_019)
      if (retry === null) throw new Error('Expected a retried deletion claim.')
      expect(retry.checkpoint).toBe(1)
      await verifyAndRemoveInventory(
        primary.repositories.deletions, plan.jobId, retry.claimToken, 1_020,
      )
      expect(await primary.repositories.deletions.advanceCheckpoint(
        plan.jobId, retry.claimToken, 1, 2, 1_030,
      )).toBe('advanced')
      expect(await primary.repositories.deletions.advanceCheckpoint(
        plan.jobId, retry.claimToken, 2, 3, 1_031,
      )).toBe('advanced')
      expect(await primary.repositories.deletions.finish(
        plan.jobId, retry.claimToken, 1_032,
      )).toBe('succeeded')
      expect(await primary.repositories.deletions.getPublicByJobScoped(
        plan.jobId, WORKSPACE_ID, PROFILE_ID,
      )).toMatchObject({ state: 'deleted', terminalAt: 1_032, remaining: emptyPublicCounts() })
      expect(await primary.repositories.deletions.getScoped(
        prepared.source.sourceId, WORKSPACE_ID, PROFILE_ID,
      )).toMatchObject({ state: 'succeeded' })
      expect(await primary.repositories.sources.getScoped(
        prepared.source.sourceId, WORKSPACE_ID, PROFILE_ID,
      )).toBeNull()
      expect(await primary.repositories.deletions.getInventory(plan.jobId)).toEqual([])
      expect(await primary.repositories.deletions.requestCancellation(
        plan.jobId, WORKSPACE_ID, PROFILE_ID, 1_033,
      )).toBe('terminal')
      expect(await primary.repositories.deletions.retryPartialScoped(
        plan.jobId, WORKSPACE_ID, PROFILE_ID, 1_034,
      )).toBe('not_partial')
    } finally {
      await Promise.all([primary.close().catch(() => {}), peer.close().catch(() => {})])
      await database.close()
    }
  })

  it('recovers an expired pre-destruction claim and thaws only confirmed cancellation', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const adapter = new PostgreSqlStorageAdapter<Root, object>({
      plan: storagePlan(database.url),
      repositories: {
        createRoot: (context) => ({
          sources: createPostgreSqlSourceRepository(context, limits),
          uploads: createPostgreSqlSourceUploadRepository(context, limits),
          jobs: createPostgreSqlSourceJobRepository(context, limits),
          deletions: createPostgreSqlSourceDeletionRepository(context),
          grants: createPostgreSqlAccessGrantRepository(context),
        }),
        createTransaction: () => ({}),
      },
    })
    try {
      await adapter.initialize()
      const source = await adapter.repositories.sources.create(registration('cancel'), 10)
      const plan = await adapter.repositories.deletions.plan({
        workspaceId: WORKSPACE_ID,
        profileId: PROFILE_ID,
        sourceId: source.sourceId,
        expectedRevision: 1,
      }, 100)
      const claim = await adapter.repositories.deletions.claimNext('crashed-worker', 101)
      if (claim === null) throw new Error('Expected a deletion claim.')
      expect(await adapter.repositories.deletions.renewClaim(
        plan.jobId, claim.claimToken, claim.leaseExpiresAt + 1,
      )).toBe(false)
      expect(await adapter.repositories.deletions.recoverExpiredClaims(
        claim.leaseExpiresAt + 1,
      )).toEqual({ requeued: 1, partial: 0 })
      expect(await adapter.repositories.deletions.requestCancellation(
        plan.jobId, WORKSPACE_ID, PROFILE_ID, claim.leaseExpiresAt + 2,
      )).toBe('requested')
      expect(await adapter.repositories.deletions.requestCancellation(
        plan.jobId, WORKSPACE_ID, PROFILE_ID, claim.leaseExpiresAt + 3,
      )).toBe('already_requested')
      expect(await adapter.repositories.deletions.confirmCancellation(
        '00000000-0000-4000-8000-000000000000', claim.leaseExpiresAt + 4,
      )).toBe(false)
      expect(await adapter.repositories.deletions.confirmNextCancellation(
        claim.leaseExpiresAt + 4,
      )).toBe(true)
      expect(await adapter.repositories.sources.getScoped(
        source.sourceId, WORKSPACE_ID, PROFILE_ID,
      )).toMatchObject({ revision: 3, health: { deletion: 'active' } })
      expect(await adapter.repositories.deletions.getPublicByJobScoped(
        plan.jobId, WORKSPACE_ID, PROFILE_ID,
      )).toMatchObject({ state: 'cancelled', terminalAt: claim.leaseExpiresAt + 4 })
    } finally {
      await adapter.close().catch(() => {})
      await database.close()
    }
  })
})

function emptyPublicCounts() {
  return {
    immutableOriginals: 0,
    uploadStaging: 0,
    placedCandidates: 0,
    derivedResources: 0,
    dataViews: 0,
    searchIndexes: 0,
    sourceJobs: 0,
    idempotencyReplays: 0,
    retrievalCacheEntries: 0,
  }
}
