import { describe, expect, it } from 'vitest'
import type { SourceQuotaLimits } from '../../../src/gateway/source-quota-policy.js'
import { validateStoragePlan } from '../../../src/storage/config.js'
import { PostgreSqlStorageAdapter } from '../../../src/storage/postgresql-adapter.js'
import { createPostgreSqlSourceJobRepository } from '../../../src/storage/postgresql-source-job-repository.js'
import {
  createPostgreSqlSourceRepository,
  createPostgreSqlSourceUploadRepository,
} from '../../../src/storage/postgresql-source-foundation.js'
import type {
  SourceJobRepository,
  SourceRepository,
  SourceUploadRepository,
} from '../../../src/storage/source-repositories.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const limits: SourceQuotaLimits = {
  workspace: {
    maxSourceRegistrations: 10,
    maxRetainedAndReservedBytes: 1_000_000,
    maxActiveUploadSessions: 10,
    maxNonterminalJobs: 10,
    maxDerivedResources: 10,
  },
  profile: {
    maxSourceRegistrations: 10,
    maxRetainedAndReservedBytes: 1_000_000,
    maxActiveUploadSessions: 10,
    maxNonterminalJobs: 10,
    maxDerivedResources: 10,
  },
}

interface Root {
  readonly sources: SourceRepository
  readonly uploads: SourceUploadRepository
  readonly jobs: SourceJobRepository
}

if (TEST_URL === undefined) {
  describe.skip('PostgreSQL source job repository', () => {
    it('requires OWNWARE_TEST_POSTGRES_URL', () => {})
  })
} else {
  describe('PostgreSQL source job repository', () => {
    it('gives one worker the claim, fences expiry and durably finishes inspection', async () => {
      const database = await createDisposablePostgreSqlDatabase(TEST_URL)
      const plan = validateStoragePlan({
        storage: {
          kind: 'postgresql',
          runtimeConnection: { source: 'provider', resolve: () => database.url },
          tls: { mode: 'disable', allowInsecureLoopback: true },
        },
      }, '/unused.db')
      if (plan.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
      const open = async () => {
        const adapter = new PostgreSqlStorageAdapter<Root, object>({
          plan,
          repositories: {
            createRoot: (context) => ({
              sources: createPostgreSqlSourceRepository(context, limits),
              uploads: createPostgreSqlSourceUploadRepository(context, limits),
              jobs: createPostgreSqlSourceJobRepository(context, limits),
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
        const scope = { workspaceId: 'source-job-workspace', profileId: 'source-job-profile' }
        const source = await primary.repositories.sources.create({
          ...scope,
          kind: 'structured_export',
          label: 'source job claim',
          classification: 'internal',
          authority: 'supporting_reference',
          audiencePolicyRef: 'audience.policy.test',
          sensitivityPolicyRef: 'sensitivity.policy.test',
          purposePolicyRef: 'purpose.policy.test',
          retentionPolicyRef: 'retention.policy.test',
          freshnessPolicyRef: 'freshness.policy.test',
        }, 10)
        const sourceChecksum = `sha256:${'a'.repeat(64)}`
        const upload = await primary.repositories.uploads.create({
          ...scope,
          sourceId: source.sourceId,
          principalKey: 'source-job-principal',
          expectedBytes: 16,
          expectedChecksum: sourceChecksum,
          declaredMediaType: 'text/plain',
          filename: 'source.csv',
        }, 20)
        await primary.repositories.uploads.advanceChunk(upload.uploadId, 0, {
          byteCount: 16,
          checksum: `sha256:${'c'.repeat(64)}`,
        }, 30)
        const versionId = await primary.repositories.uploads.beginCompletion(upload.uploadId, 40)
        await primary.repositories.uploads.finishCompletion(upload.uploadId, {
          versionId,
          checksum: sourceChecksum,
          verifiedMediaType: 'text/plain',
          byteCount: 16,
          objectKey: `sources/${source.sourceId}/versions/${versionId}/original`,
        }, 50)
        const job = await primary.repositories.jobs.enqueue({
          ...scope,
          sourceId: source.sourceId,
          sourceVersionId: versionId,
          operation: 'inspect_format',
        }, 100)
        const claims = await Promise.all([
          primary.repositories.jobs.claimNext('source-job-primary', 200),
          peer.repositories.jobs.claimNext('source-job-peer', 200),
        ])
        expect(claims.filter((claim) => claim !== null)).toHaveLength(1)
        const first = claims.find((claim) => claim !== null)!
        expect(await primary.repositories.jobs.advanceCheckpoint(
          first.jobId, first.claimToken, 0, 1, 201,
        )).toBe('advanced')
        expect(await primary.repositories.jobs.recoverExpiredClaims(first.leaseExpiresAt + 1))
          .toEqual({ requeued: 1, failed: 0, cancelled: 0 })
        const successor = await peer.repositories.jobs.claimNext(
          'source-job-successor',
          first.leaseExpiresAt + 2,
        )
        expect(successor).not.toBeNull()
        expect(await primary.repositories.jobs.advanceCheckpoint(
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
        await peer.repositories.jobs.advanceCheckpoint(
          successor!.jobId,
          successor!.claimToken,
          2,
          3,
          first.leaseExpiresAt + 4,
        )
        expect(await peer.repositories.jobs.finishInspection(
          successor!.jobId,
          successor!.claimToken,
          'succeeded',
          'inspection_complete',
          first.leaseExpiresAt + 5,
        )).toBe('finished')
        expect(await primary.repositories.jobs.getScoped(job.jobId, scope.workspaceId, scope.profileId))
          .toMatchObject({ state: 'succeeded', checkpoint: 4, outcomeCode: 'inspection_complete' })
        expect((await primary.repositories.sources.getScoped(
          source.sourceId, scope.workspaceId, scope.profileId,
        ))?.health.inspection).toBe('complete')
      } finally {
        await Promise.all([primary.close().catch(() => {}), peer.close().catch(() => {})])
        await database.close()
      }
    })
  })
}
