import { describe, expect, it } from 'vitest'
import { validateStoragePlan } from '../../../src/storage/config.js'
import { PostgreSqlStorageAdapter } from '../../../src/storage/postgresql-adapter.js'
import {
  createPostgreSqlSourceRepository,
  createPostgreSqlSourceUploadRepository,
} from '../../../src/storage/postgresql-source-foundation.js'
import type {
  SourceRepository,
  SourceUploadRepository,
} from '../../../src/storage/source-repositories.js'
import type { SourceQuotaLimits } from '../../../src/gateway/source-quota-policy.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const limits: SourceQuotaLimits = {
  workspace: {
    maxSourceRegistrations: 4,
    maxRetainedAndReservedBytes: 1_000_000,
    maxActiveUploadSessions: 10,
    maxNonterminalJobs: 10,
    maxDerivedResources: 10,
  },
  profile: {
    maxSourceRegistrations: 4,
    maxRetainedAndReservedBytes: 1_000_000,
    maxActiveUploadSessions: 10,
    maxNonterminalJobs: 10,
    maxDerivedResources: 10,
  },
}

interface Root {
  readonly sources: SourceRepository
  readonly uploads: SourceUploadRepository
}

const registration = (label: string) => ({
  workspaceId: 'source-foundation-workspace',
  profileId: 'source-foundation-profile',
  kind: 'structured_export' as const,
  label,
  classification: 'internal' as const,
  authority: 'supporting_reference' as const,
  audiencePolicyRef: 'audience.policy.test',
  sensitivityPolicyRef: 'sensitivity.policy.test',
  purposePolicyRef: 'purpose.policy.test',
  retentionPolicyRef: 'retention.policy.test',
  freshnessPolicyRef: 'freshness.policy.test',
})

if (TEST_URL === undefined) {
  describe.skip('PostgreSQL source foundation', () => {
    it('requires OWNWARE_TEST_POSTGRES_URL', () => {})
  })
} else {
  describe('PostgreSQL source foundation', () => {
    it('keeps source registration and an exact uploaded version durable', async () => {
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
            }),
            createTransaction: () => ({}),
          },
        })
        await adapter.initialize()
        return adapter
      }
      let adapter = await open()
      try {
        const source = await adapter.repositories.sources.create(registration('durable'), 10)
        const checksum = `sha256:${'a'.repeat(64)}`
        const upload = await adapter.repositories.uploads.create({
          sourceId: source.sourceId,
          workspaceId: registration('').workspaceId,
          profileId: registration('').profileId,
          principalKey: 'source-foundation-principal',
          expectedBytes: 16,
          expectedChecksum: checksum,
          declaredMediaType: 'text/plain',
          filename: 'source.csv',
        }, 20)
        await adapter.repositories.uploads.advanceChunk(upload.uploadId, 0, {
          byteCount: 16,
          checksum: `sha256:${'c'.repeat(64)}`,
        }, 30)
        const versionId = await adapter.repositories.uploads.beginCompletion(upload.uploadId, 40)
        const version = await adapter.repositories.uploads.finishCompletion(upload.uploadId, {
          versionId,
          checksum,
          verifiedMediaType: 'text/plain',
          byteCount: 16,
          objectKey: `sources/${source.sourceId}/versions/${versionId}/original`,
        }, 50)
        expect((await adapter.repositories.sources.getScoped(
          source.sourceId,
          registration('').workspaceId,
          registration('').profileId,
        ))?.revision).toBe(2)
        await adapter.close()
        adapter = await open()
        expect(await adapter.repositories.uploads.getCompletedVersion(upload.uploadId)).toEqual(version)
      } finally {
        await adapter.close().catch(() => {})
        await database.close()
      }
    })

    it('serializes contenders for the final source-registration quota slot', async () => {
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
        const adapter = new PostgreSqlStorageAdapter<{ readonly sources: SourceRepository }, object>({
          plan,
          repositories: {
            createRoot: (context) => ({ sources: createPostgreSqlSourceRepository(context, limits) }),
            createTransaction: () => ({}),
          },
        })
        await adapter.initialize()
        return adapter
      }
      const primary = await open()
      const peer = await open()
      try {
        for (let index = 0; index < 3; index += 1) {
          await primary.repositories.sources.create(registration(`existing-${index}`), 10 + index)
        }
        const outcomes = await Promise.allSettled([
          primary.repositories.sources.create(registration('primary'), 20),
          peer.repositories.sources.create(registration('peer'), 20),
        ])
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
        expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
          reason: { name: 'SourceQuotaExceededError' },
        })
      } finally {
        await Promise.all([primary.close().catch(() => {}), peer.close().catch(() => {})])
        await database.close()
      }
    })
  })
}
