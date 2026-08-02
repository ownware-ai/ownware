import { Client } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { csvDataViewOrdinalId } from '../../../src/gateway/csv-data-view.js'
import type { PreparedCsvDataViewArtifact } from '../../../src/gateway/source-byte-store.js'
import {
  SourceQuotaExceededError,
  type SourceQuotaLimits,
} from '../../../src/gateway/source-quota-policy.js'
import { validateStoragePlan, type ValidatedPostgreSqlPlan } from '../../../src/storage/config.js'
import { PostgreSqlStorageAdapter } from '../../../src/storage/postgresql-adapter.js'
import { createPostgreSqlSourceDataViewRepository } from '../../../src/storage/postgresql-source-data-view-repository.js'
import type { SourceDataViewRepository } from '../../../src/storage/source-repositories.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe
const WORKSPACE_ID = 'data-view-workspace'
const PROFILE_ID = 'data-view-profile'
const SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const VERSION_ID = '22222222-2222-4222-8222-222222222222'
const SOURCE_CHECKSUM = `sha256:${'a'.repeat(64)}`

const LIMITS: SourceQuotaLimits = {
  workspace: ceilings(100),
  profile: ceilings(100),
}

interface RootRepositories {
  readonly dataViews: SourceDataViewRepository
}

describePostgreSql('PostgreSQL source Data View repository', () => {
  let database: Awaited<ReturnType<typeof createDisposablePostgreSqlDatabase>>
  let selected: ValidatedPostgreSqlPlan
  let storage: PostgreSqlStorageAdapter<RootRepositories, object>
  let client: Client

  beforeEach(async () => {
    database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const validated = validateStoragePlan({
      storage: {
        kind: 'postgresql',
        runtimeConnection: { source: 'provider', resolve: () => database.url },
        tls: { mode: 'disable', allowInsecureLoopback: true },
      },
    }, '/unused.db')
    if (validated.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
    selected = validated
    storage = await open(LIMITS)
    client = new Client({ connectionString: database.url, ssl: false })
    await client.connect()
    await seed(client)
  })

  afterEach(async () => {
    await client?.end().catch(() => {})
    await storage?.close().catch(() => {})
    await database?.close()
  })

  it('publishes an exact manifest and reopens public, protected and private projections', async () => {
    const repository = storage.repositories.dataViews
    const job = await repository.enqueue(input(), 100)
    expect(await repository.enqueue(input(), 101)).toEqual(job)
    expect(await repository.getJobScoped(job.jobId, 'other-workspace', PROFILE_ID)).toBeNull()

    const claim = await repository.claimNext('data-view-worker', 200)
    expect(claim).toMatchObject({
      jobId: job.jobId,
      attempt: 1,
      checkpoint: 0,
      leaseExpiresAt: 30_200,
      dataViewId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(await repository.getClaimedTarget(job.jobId, claim!.claimToken, 201)).toEqual({
      objectKey: `sources/${SOURCE_ID}/versions/${VERSION_ID}/original`,
      expectedByteCount: 16,
      expectedChecksum: SOURCE_CHECKSUM,
      sourceId: SOURCE_ID,
      sourceVersionId: VERSION_ID,
      dataViewId: claim!.dataViewId,
    })
    expect(await repository.renewClaim(job.jobId, claim!.claimToken, 202)).toBe(true)
    expect(await repository.publish(job.jobId, claim!.claimToken, artifact(claim!.dataViewId), 203))
      .toBe('checkpoint_incomplete')
    expect(await repository.advanceCheckpoint(job.jobId, claim!.claimToken, 1, 2, 203))
      .toBe('checkpoint_conflict')
    await advance(repository, claim!, 300)
    expect(await repository.publish(
      job.jobId,
      claim!.claimToken,
      artifact('44444444-4444-4444-8444-444444444444'),
      400,
    )).toBe('state_conflict')
    expect(await repository.publish(job.jobId, claim!.claimToken, artifact(claim!.dataViewId), 401))
      .toBe('finished')

    expect(await repository.getJobScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'succeeded', checkpoint: 4, dataViewId: claim!.dataViewId,
      outcomeCode: 'preparation_complete', terminalAt: 401,
    })
    const view = await repository.getViewScoped(claim!.dataViewId, WORKSPACE_ID, PROFILE_ID)
    expect(view).toMatchObject({
      jobId: job.jobId,
      dataViewId: claim!.dataViewId,
      sourceId: SOURCE_ID,
      sourceVersionId: VERSION_ID,
      fieldCount: 2,
      rowCount: 1,
      freshness: 'current',
    })
    expect(JSON.stringify(view)).not.toContain('privateObjectKey')
    expect(await repository.getProtectedSelectionTargetScoped(
      claim!.dataViewId, WORKSPACE_ID, PROFILE_ID,
    )).toMatchObject({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      privateObjectKey:
        `sources/${SOURCE_ID}/versions/${VERSION_ID}/data-views/${claim!.dataViewId}.json`,
    })
    expect(await repository.getPrivateArtifact(
      claim!.dataViewId, WORKSPACE_ID, PROFILE_ID,
    )).toEqual({
      privateObjectKey:
        `sources/${SOURCE_ID}/versions/${VERSION_ID}/data-views/${claim!.dataViewId}.json`,
      artifactChecksum: `sha256:${'b'.repeat(64)}`,
      artifactByteCount: 128,
    })

    await client.query(`
      UPDATE ownware.source_data_views SET fields_json = $1 WHERE data_view_id = $2
    `, [JSON.stringify([
      { fieldId: 'invalid-field', ordinal: 0, label: 'name' },
      { fieldId: csvDataViewOrdinalId('field', VERSION_ID, 1), ordinal: 1, label: 'value' },
    ]), claim!.dataViewId])
    expect(await repository.getViewScoped(claim!.dataViewId, WORKSPACE_ID, PROFILE_ID)).toBeNull()
    await client.query(`
      UPDATE ownware.source_data_views SET fields_json = $1 WHERE data_view_id = $2
    `, [JSON.stringify(artifact(claim!.dataViewId).manifest.fields), claim!.dataViewId])

    await storage.close()
    storage = await open(LIMITS)
    expect(await storage.repositories.dataViews.getViewScoped(
      claim!.dataViewId, WORKSPACE_ID, PROFILE_ID,
    )).toEqual(view)
  })

  it('admits one claimant, fences stale owners, defers and recovers a durable checkpoint', async () => {
    const peer = await open(LIMITS)
    try {
      const job = await storage.repositories.dataViews.enqueue(input(), 100)
      const claims = await Promise.all([
        storage.repositories.dataViews.claimNext('primary-worker', 200),
        peer.repositories.dataViews.claimNext('peer-worker', 200),
      ])
      expect(claims.filter(Boolean)).toHaveLength(1)
      const first = claims.find((value) => value !== null)!
      const owner = claims[0] === first ? storage.repositories.dataViews : peer.repositories.dataViews
      const successor = owner === storage.repositories.dataViews
        ? peer.repositories.dataViews
        : storage.repositories.dataViews

      expect(await owner.advanceCheckpoint(job.jobId, first.claimToken, 0, 1, 201))
        .toBe('advanced')
      expect(await owner.fenceUnpublishedArtifactCleanup(
        job.jobId, first.claimToken, first.dataViewId, 30_000,
      )).toBe(true)
      expect(await successor.recoverExpiredClaims(first.leaseExpiresAt + 1))
        .toEqual({ requeued: 0, failed: 0 })
      expect(await owner.deferUntil(job.jobId, first.claimToken, 31_000, 30_001))
        .toBe('deferred')
      expect(await successor.claimNext('too-early-worker', 30_999)).toBeNull()
      const second = await successor.claimNext('successor-worker', 31_000)
      expect(second).toMatchObject({ jobId: job.jobId, attempt: 2, checkpoint: 1 })
      expect(await owner.advanceCheckpoint(job.jobId, first.claimToken, 1, 2, 31_001))
        .toBe('stale_claim')
      expect(await successor.advanceCheckpoint(job.jobId, second!.claimToken, 1, 2, 31_001))
        .toBe('advanced')
      expect(await owner.recoverExpiredClaims(second!.leaseExpiresAt + 1))
        .toEqual({ requeued: 1, failed: 0 })
      expect((await owner.getJobScoped(job.jobId, WORKSPACE_ID, PROFILE_ID))?.checkpoint).toBe(2)
      const third = await successor.claimNext('final-worker', second!.leaseExpiresAt + 2)
      expect(third).toMatchObject({ jobId: job.jobId, attempt: 3, checkpoint: 2 })
      expect(await successor.advanceCheckpoint(
        job.jobId, third!.claimToken, 2, 3, third!.leaseExpiresAt + 1,
      )).toBe('lease_expired')
      expect(await owner.recoverExpiredClaims(third!.leaseExpiresAt + 1))
        .toEqual({ requeued: 0, failed: 1 })
      expect(await owner.getJobScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
        state: 'failed', attempt: 3, checkpoint: 2, outcomeCode: 'attempts_exhausted',
      })
    } finally {
      await peer.close()
    }
  })

  it('serializes same-version enqueue contenders into one replayed identity', async () => {
    await storage.close()
    const oneSlot = { workspace: ceilings(1), profile: ceilings(1) }
    storage = await open(oneSlot)
    const peer = await open(oneSlot)
    try {
      const results = await Promise.all([
        storage.repositories.dataViews.enqueue(input(), 100),
        peer.repositories.dataViews.enqueue(input(), 100),
      ])
      expect(results[1]).toEqual(results[0])
      expect((await client.query(`SELECT count(*)::text AS count FROM ownware.source_data_view_jobs`))
        .rows[0]).toEqual({ count: '1' })
    } finally {
      await peer.close()
    }
  })

  it('requires an exact cancellation cleanup owner before making cancellation terminal', async () => {
    const repository = storage.repositories.dataViews
    const job = await repository.enqueue(input(), 100)
    expect(await repository.requestCancel(job.jobId, 'other-workspace', PROFILE_ID, 150))
      .toBe('missing')
    expect(await repository.requestCancel(job.jobId, WORKSPACE_ID, PROFILE_ID, 150))
      .toBe('requested')
    expect(await repository.requestCancel(job.jobId, WORKSPACE_ID, PROFILE_ID, 151))
      .toBe('already_requested')
    await expect(repository.claimNextCancellation('INVALID WORKER', 200)).rejects.toBeInstanceOf(TypeError)
    const claim = await repository.claimNextCancellation('cleanup-worker', 200)
    expect(claim).not.toBeNull()
    expect(await repository.fenceUnpublishedArtifactCleanup(
      job.jobId, claim!.claimToken, claim!.dataViewId, 201,
    )).toBe(true)
    expect(await repository.confirmCancelled(job.jobId, 'wrong-claim', 202)).toBe('stale_claim')
    expect(await repository.confirmCancelled(job.jobId, claim!.claimToken, 202)).toBe('cancelled')
    expect(await repository.requestCancel(job.jobId, WORKSPACE_ID, PROFILE_ID, 203)).toBe('terminal')
    expect(await repository.getJobScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'cancelled', outcomeCode: 'cancelled', dataViewId: null, terminalAt: 202,
    })
  })

  it('preserves eligibility errors, transactional quota refusal and failed-attempt state', async () => {
    await client.query(`UPDATE ownware.runtime_sources SET kind = 'text' WHERE source_id = $1`, [SOURCE_ID])
    await expect(storage.repositories.dataViews.enqueue(input(), 100)).rejects.toMatchObject({
      name: 'SourceDataViewUnavailableError',
      code: 'source_data_view_kind_unsupported',
    })
    await client.query(`UPDATE ownware.runtime_sources SET kind = 'structured_export' WHERE source_id = $1`, [SOURCE_ID])

    const limited = await open({ workspace: ceilings(0), profile: ceilings(0) })
    try {
      await expect(limited.repositories.dataViews.enqueue(input(), 101))
        .rejects.toBeInstanceOf(SourceQuotaExceededError)
      expect((await client.query(`SELECT count(*)::text AS count FROM ownware.source_data_view_jobs`))
        .rows[0]).toEqual({ count: '0' })
    } finally {
      await limited.close()
    }

    const repository = storage.repositories.dataViews
    const job = await repository.enqueue(input(), 110)
    const first = await repository.claimNext('failure-worker', 120)
    expect(await repository.finishFailed(job.jobId, first!.claimToken, 'NOT_VALID', 121))
      .toBe('state_conflict')
    expect(await repository.finishFailed(job.jobId, first!.claimToken, 'worker_failed', 121))
      .toBe('finished')
    expect(await repository.getJobScoped(job.jobId, WORKSPACE_ID, PROFILE_ID)).toMatchObject({
      state: 'failed', outcomeCode: 'worker_failed', terminalAt: 121,
    })
  })

  async function open(
    limits: SourceQuotaLimits,
  ): Promise<PostgreSqlStorageAdapter<RootRepositories, object>> {
    const adapter = new PostgreSqlStorageAdapter<RootRepositories, object>({
      plan: selected,
      repositories: {
        createRoot: (context) => ({
          dataViews: createPostgreSqlSourceDataViewRepository(context, limits),
        }),
        createTransaction: () => ({}),
      },
    })
    await adapter.initialize()
    return adapter
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

async function advance(
  repository: SourceDataViewRepository,
  claim: { readonly jobId: string; readonly claimToken: string },
  now: number,
): Promise<void> {
  expect(await repository.advanceCheckpoint(claim.jobId, claim.claimToken, 0, 1, now))
    .toBe('advanced')
  expect(await repository.advanceCheckpoint(claim.jobId, claim.claimToken, 1, 2, now + 1))
    .toBe('advanced')
  expect(await repository.advanceCheckpoint(claim.jobId, claim.claimToken, 2, 3, now + 2))
    .toBe('advanced')
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
        { fieldId: csvDataViewOrdinalId('field', VERSION_ID, 1), ordinal: 1, label: 'value' },
      ],
    },
  }
}

async function seed(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO ownware.runtime_sources (
      source_id, workspace_id, profile_id, kind, label, classification,
      authority, audience_policy_ref, sensitivity_policy_ref, purpose_policy_ref,
      retention_policy_ref, freshness_policy_ref, revision, current_version_id,
      registration_state, inspection_state, preparation_state, access_state,
      freshness_state, conflict_state, deletion_state, created_at, updated_at
    ) VALUES ($1, $2, $3, 'structured_export', 'Synthetic CSV', 'internal',
      'supporting_reference', 'audience.policy.test', 'sensitivity.policy.test',
      'purpose.policy.test', 'retention.policy.test', 'freshness.policy.test',
      1, $4, 'registered', 'complete', 'not_requested', 'available', 'fresh',
      'none', 'active', 10, 10)
  `, [SOURCE_ID, WORKSPACE_ID, PROFILE_ID, VERSION_ID])
  await client.query(`
    INSERT INTO ownware.source_versions (
      source_version_id, source_id, checksum, verified_media_type, byte_count,
      object_key, inspection_state, preparation_state, created_at
    ) VALUES ($1, $2, $3, 'text/plain', 16, $4, 'complete', 'not_requested', 10)
  `, [
    VERSION_ID,
    SOURCE_ID,
    SOURCE_CHECKSUM,
    `sources/${SOURCE_ID}/versions/${VERSION_ID}/original`,
  ])
}

function ceilings(maxDerivedResources: number) {
  return {
    maxSourceRegistrations: 1_000,
    maxRetainedAndReservedBytes: 1024 * 1024 * 1024,
    maxActiveUploadSessions: 256,
    maxNonterminalJobs: 64,
    maxDerivedResources,
  }
}
