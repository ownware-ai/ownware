import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import {
  ACCESS_GRANT_MIN_TTL_SECONDS,
  AccessGrantStoreError,
} from '../../../src/gateway/access-grant-store.js'
import { csvDataViewOrdinalId } from '../../../src/gateway/csv-data-view.js'
import type { PreparedCsvDataViewArtifact } from '../../../src/gateway/source-byte-store.js'
import type { SourceQuotaLimits } from '../../../src/gateway/source-quota-policy.js'
import {
  beginCodexThreadTurn,
  createCodexThreadReference,
} from '../../../src/runtime/codex/official-thread.js'
import { CodexThreadReferenceStoreError } from '../../../src/runtime/codex/thread-reference-store.js'
import {
  PostgreSqlStorageAdapter,
  type PostgreSqlRepositoryFactories,
} from '../../../src/storage/postgresql-adapter.js'
import { createPostgreSqlCoreRepositories } from '../../../src/storage/postgresql-core-repositories.js'
import { createPostgreSqlAccessGrantRepository } from '../../../src/storage/postgresql-access-grant-repository.js'
import type { PostgreSqlPool } from '../../../src/storage/postgresql-driver.js'
import {
  createPostgreSqlSecurityRepositories,
  createPostgreSqlSecurityTransactionRepositories,
} from '../../../src/storage/postgresql-security-repositories.js'
import type {
  AccessGrantRepository,
  SecurityRepositories,
  SecurityTransactionRepositories,
} from '../../../src/storage/security-repositories.js'
import { createPostgreSqlSourceRepositories } from '../../../src/storage/postgresql-source-repositories.js'
import type { SourceRepositories } from '../../../src/storage/source-repositories.js'
import {
  validateStoragePlan,
  type ValidatedPostgreSqlPlan,
} from '../../../src/storage/config.js'
import { StorageRepositoryError } from '../../../src/storage/contracts.js'
import type { CoreStorageRepositories } from '../../../src/storage/core-repositories.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe
const CONTENDERS = 16
const GRANT_CAPACITY = 3
const GRANT_WORKSPACE_ID = 'security-grant-workspace'
const GRANT_PROFILE_ID = 'security-grant-profile'
const GRANT_SOURCE_CHECKSUM = `sha256:${'d'.repeat(64)}`
const GRANT_CHUNK_CHECKSUM = `sha256:${'e'.repeat(64)}`

function sourceCeilings(limit: number) {
  return {
    maxSourceRegistrations: limit,
    maxRetainedAndReservedBytes: 1024 * 1024 * 1024,
    maxActiveUploadSessions: limit,
    maxNonterminalJobs: limit,
    maxDerivedResources: limit,
  }
}

const SOURCE_LIMITS: SourceQuotaLimits = {
  workspace: sourceCeilings(128),
  profile: sourceCeilings(128),
}

interface RootRepositories {
  readonly core: CoreStorageRepositories
  readonly security: readonly SecurityRepositories[]
  readonly boundedGrants: readonly AccessGrantRepository[]
  readonly sources: readonly SourceRepositories[]
}

interface Harness {
  readonly database: Awaited<ReturnType<typeof createDisposablePostgreSqlDatabase>>
  readonly storage: PostgreSqlStorageAdapter<RootRepositories, SecurityTransactionRepositories>
  readonly pool: PostgreSqlPool
  close(): Promise<void>
}

type Settled<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown }

function plan(url: string): ValidatedPostgreSqlPlan {
  const validated = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => url },
      tls: { mode: 'disable', allowInsecureLoopback: true },
      pool: {
        maxConnections: 32,
        statementTimeoutMs: 10_000,
        lockTimeoutMs: 10_000,
      },
    },
  }, '/unused.db')
  if (validated.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
  return validated
}

async function createHarness(): Promise<Harness> {
  const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
  const previousMasterKey = process.env['OWNWARE_MASTER_KEY']
  process.env['OWNWARE_MASTER_KEY'] = 'ab'.repeat(32)
  __resetMasterKeyCacheForTests()
  let pool: PostgreSqlPool | undefined
  const factories: PostgreSqlRepositoryFactories<
    RootRepositories,
    SecurityTransactionRepositories
  > = {
    createRoot(context) {
      pool = context.pool
      return {
        core: createPostgreSqlCoreRepositories(context),
        security: Array.from({ length: CONTENDERS }, (_, index) =>
          createPostgreSqlSecurityRepositories(context, {
            permissionHashSecret: 'security-concurrency-permission-secret',
            idempotencyLeaseOwner: `security-idempotency-owner-${index}`,
            oauthRefreshOwner: `security-oauth-owner-${index}`,
          })),
        boundedGrants: Array.from({ length: CONTENDERS }, () =>
          createPostgreSqlAccessGrantRepository(context, undefined, GRANT_CAPACITY)),
        sources: Array.from({ length: CONTENDERS }, () =>
          createPostgreSqlSourceRepositories(context, { quotaLimits: SOURCE_LIMITS })),
      }
    },
    createTransaction: createPostgreSqlSecurityTransactionRepositories,
  }
  const storage = new PostgreSqlStorageAdapter({
    plan: plan(database.url),
    repositories: factories,
  })
  try {
    await storage.initialize()
  } catch (error) {
    await storage.close().catch(() => {})
    await database.close().catch(() => {})
    if (previousMasterKey === undefined) delete process.env['OWNWARE_MASTER_KEY']
    else process.env['OWNWARE_MASTER_KEY'] = previousMasterKey
    __resetMasterKeyCacheForTests()
    throw error
  }
  if (pool === undefined) throw new Error('PostgreSQL pool was not captured.')
  const runtimePool = pool
  return {
    database,
    storage,
    pool: runtimePool,
    async close() {
      await storage.close().catch(() => {})
      await waitForPoolClose(runtimePool)
      await database.close().catch(() => {})
      if (previousMasterKey === undefined) delete process.env['OWNWARE_MASTER_KEY']
      else process.env['OWNWARE_MASTER_KEY'] = previousMasterKey
      __resetMasterKeyCacheForTests()
    },
  }
}

async function startTogether<T>(
  operations: ReadonlyArray<() => Promise<T>>,
): Promise<readonly T[]> {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const pending = operations.map(async (operation) => {
    await gate
    return operation()
  })
  await Promise.resolve()
  release!()
  return Promise.all(pending)
}

async function settleTogether<T>(
  operations: ReadonlyArray<() => Promise<T>>,
): Promise<readonly Settled<T>[]> {
  return startTogether(operations.map((operation) => async () => {
    try {
      return { status: 'fulfilled', value: await operation() } as const
    } catch (reason) {
      return { status: 'rejected', reason } as const
    }
  }))
}

function poolCheckoutState(pool: PostgreSqlPool): {
  readonly total: number
  readonly idle: number
  readonly waiting: number
  readonly checkedOut: number
} {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    checkedOut: pool.totalCount - pool.idleCount,
  }
}

async function waitForPoolReturn(pool: PostgreSqlPool): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const state = poolCheckoutState(pool)
    if (state.checkedOut === 0 && state.waiting === 0) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('PostgreSQL pool clients did not return after security contention.')
}

async function waitForPoolClose(pool: PostgreSqlPool): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (pool.totalCount === 0) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('PostgreSQL pool clients did not close before database cleanup.')
}

async function waitForBlockedRuntimePid(
  observer: Client,
  lockHolderPid: number,
): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await observer.query<{ readonly pid: number }>(`
      SELECT pid FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND application_name = 'ownware-storage-runtime'
        AND $1::integer = ANY(pg_catalog.pg_blocking_pids(pid))
      ORDER BY pid ASC
    `, [lockHolderPid])
    const pid = result.rows[0]?.pid
    if (Number.isSafeInteger(pid)) return pid!
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Credential CAS did not reach the deterministic row-lock barrier.')
}

async function waitForBlockedRuntimePids(
  observer: Client,
  lockHolderPid: number,
  minimum: number,
): Promise<readonly number[]> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await observer.query<{ readonly pid: number }>(`
      SELECT pid FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND application_name = 'ownware-storage-runtime'
        AND $1::integer = ANY(pg_catalog.pg_blocking_pids(pid))
      ORDER BY pid ASC
    `, [lockHolderPid])
    if (result.rows.length >= minimum) return result.rows.map((row) => row.pid)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Only some grant contenders reached the advisory-lock barrier.`)
}

function grantSourceRegistration(label: string) {
  return {
    workspaceId: GRANT_WORKSPACE_ID,
    profileId: GRANT_PROFILE_ID,
    kind: 'structured_export' as const,
    label,
    classification: 'internal' as const,
    authority: 'supporting_reference' as const,
    audiencePolicyRef: 'audience.policy.security-grant',
    sensitivityPolicyRef: 'sensitivity.policy.security-grant',
    purposePolicyRef: 'purpose.policy.security-grant',
    retentionPolicyRef: 'retention.policy.security-grant',
    freshnessPolicyRef: 'freshness.policy.security-grant',
  }
}

function grantDataViewArtifact(
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
      sourceChecksum: GRANT_SOURCE_CHECKSUM,
      artifactChecksum: `sha256:${'f'.repeat(64)}`,
      artifactByteCount: 256,
      fieldCount: 2,
      rowCount: 4,
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

async function prepareGrantTargets(repositories: SourceRepositories): Promise<{
  readonly sourceId: string
  readonly sourceRevision: number
  readonly sourceVersionId: string
  readonly resourceId: string
  readonly dataViewId: string
  readonly fieldIds: readonly string[]
}> {
  const source = await repositories.sources.create(
    grantSourceRegistration('security grant source'),
    10_000,
  )
  const upload = await repositories.uploads.create({
    sourceId: source.sourceId,
    workspaceId: GRANT_WORKSPACE_ID,
    profileId: GRANT_PROFILE_ID,
    principalKey: 'security-grant-principal',
    expectedBytes: 16,
    expectedChecksum: GRANT_SOURCE_CHECKSUM,
    declaredMediaType: 'text/plain',
    filename: 'security-grants.csv',
  }, 10_010)
  await repositories.uploads.advanceChunk(upload.uploadId, 0, {
    byteCount: 16,
    checksum: GRANT_CHUNK_CHECKSUM,
  }, 10_020)
  const sourceVersionId = await repositories.uploads.beginCompletion(upload.uploadId, 10_030)
  await repositories.uploads.finishCompletion(upload.uploadId, {
    versionId: sourceVersionId,
    checksum: GRANT_SOURCE_CHECKSUM,
    verifiedMediaType: 'text/plain',
    byteCount: 16,
    objectKey: `sources/${source.sourceId}/versions/${sourceVersionId}/original`,
  }, 10_040)

  const inspection = await repositories.jobs.enqueue({
    workspaceId: GRANT_WORKSPACE_ID,
    profileId: GRANT_PROFILE_ID,
    sourceId: source.sourceId,
    sourceVersionId,
    operation: 'inspect_format',
  }, 10_050)
  const inspectionClaim = await repositories.jobs.claimNext('security-grant-inspection', 10_060)
  if (inspectionClaim === null || inspectionClaim.jobId !== inspection.jobId) {
    throw new Error('Security grant inspection claim was unavailable.')
  }
  for (const checkpoint of [1, 2, 3] as const) {
    await repositories.jobs.advanceCheckpoint(
      inspection.jobId,
      inspectionClaim.claimToken,
      checkpoint - 1,
      checkpoint,
      10_060 + checkpoint,
    )
  }
  await repositories.jobs.finishInspection(
    inspection.jobId,
    inspectionClaim.claimToken,
    'succeeded',
    'inspection_complete',
    10_064,
  )

  const preparation = await repositories.jobs.enqueuePreparation({
    workspaceId: GRANT_WORKSPACE_ID,
    profileId: GRANT_PROFILE_ID,
    sourceId: source.sourceId,
    sourceVersionId,
  }, 10_070)
  const preparationClaim = await repositories.jobs.claimNext('security-grant-preparation', 10_080)
  if (preparationClaim === null || preparationClaim.jobId !== preparation.jobId ||
    preparationClaim.resourceId === null) {
    throw new Error('Security grant preparation claim was unavailable.')
  }
  for (const checkpoint of [1, 2, 3] as const) {
    await repositories.jobs.advanceCheckpoint(
      preparation.jobId,
      preparationClaim.claimToken,
      checkpoint - 1,
      checkpoint,
      10_080 + checkpoint,
    )
  }
  await repositories.jobs.finishPreparation(
    preparation.jobId,
    preparationClaim.claimToken,
    'succeeded',
    'preparation_complete',
    10_084,
  )

  const dataViewJob = await repositories.dataViews.enqueue({
    workspaceId: GRANT_WORKSPACE_ID,
    profileId: GRANT_PROFILE_ID,
    sourceId: source.sourceId,
    sourceVersionId,
  }, 10_090)
  const dataViewClaim = await repositories.dataViews.claimNext('security-grant-data-view', 10_100)
  if (dataViewClaim === null || dataViewClaim.jobId !== dataViewJob.jobId) {
    throw new Error('Security grant Data View claim was unavailable.')
  }
  for (const checkpoint of [1, 2, 3] as const) {
    await repositories.dataViews.advanceCheckpoint(
      dataViewJob.jobId,
      dataViewClaim.claimToken,
      checkpoint - 1,
      checkpoint,
      10_100 + checkpoint,
    )
  }
  const artifact = grantDataViewArtifact(
    source.sourceId,
    sourceVersionId,
    dataViewClaim.dataViewId,
  )
  const published = await repositories.dataViews.publish(
    dataViewJob.jobId,
    dataViewClaim.claimToken,
    artifact,
    10_104,
  )
  if (published !== 'finished') throw new Error(`Data View publication failed: ${published}`)
  const current = await repositories.sources.getScoped(
    source.sourceId,
    GRANT_WORKSPACE_ID,
    GRANT_PROFILE_ID,
  )
  if (current === null) throw new Error('Security grant source was unavailable.')
  return {
    sourceId: source.sourceId,
    sourceRevision: current.revision,
    sourceVersionId,
    resourceId: preparationClaim.resourceId,
    dataViewId: dataViewClaim.dataViewId,
    fieldIds: artifact.manifest.fields.map((field) => field.fieldId),
  }
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
    throw new Error('Expected storage operation to fail.')
  } catch (error) {
    return error
  }
}

describePostgreSql('PostgreSQL security authority concurrency', () => {
  it('has one durable winner for simultaneous CAS, permission, lease, grant and account fences', async () => {
    const harness = await createHarness()
    try {
      const { core, security } = harness.storage.repositories
      const primary = security[0]!

      const credential = await primary.credentials.save({
        name: 'security concurrency credential',
        value: 'SECURITY_CONCURRENCY_ORIGINAL',
        category: 'llm',
        authType: 'api-key',
        variableName: 'SECURITY_CONCURRENCY_KEY',
        source: 'manual',
      })
      const baseline = await primary.credentials.decrypt(credential.id)
      if (baseline === null) throw new Error('Credential baseline was unavailable.')
      const rotations = await startTogether(security.map((repositories, index) => () =>
        repositories.credentials.updateIfUnchanged(
          credential.id,
          {
            valueRevision: baseline.valueRevision,
            status: baseline.metadata.status,
          },
          { value: `SECURITY_CONCURRENCY_ROTATION_${index}` },
        )))
      expect(rotations.filter((result) => result.kind === 'updated')).toHaveLength(1)
      expect(rotations.filter((result) => result.kind === 'conflict'))
        .toHaveLength(CONTENDERS - 1)
      const credentialWinner = rotations.findIndex((result) => result.kind === 'updated')
      expect((await primary.credentials.decrypt(credential.id))?.value)
        .toBe(`SECURITY_CONCURRENCY_ROTATION_${credentialWinner}`)

      const runThread = await core.threads.create('security-concurrency-profile')
      const run = await primary.runs.create({
        threadId: runThread.id,
        profileId: 'security-concurrency-profile',
        model: 'security:test',
        timeoutMs: 60_000,
        startSeq: 0,
      }, 1_000)
      await primary.runs.markRunning(run.runId, 1_010)
      const permission = await primary.runs.recordPermissionRequest({
        runId: run.runId,
        requestId: 'security_concurrency_permission',
        toolName: 'send_email',
        toolInput: { recipient: 'bounded@example.test' },
      }, 1_020)
      await primary.runs.markWaiting(run.runId, 1_020)
      const decisions = await startTogether(security.map((repositories, index) => () =>
        repositories.runs.decidePermission(
          run.runId,
          permission.requestId,
          permission.operationHash,
          index % 2 === 0 ? 'approve' : 'deny',
          1_030 + index,
        )))
      expect(decisions.filter((result) => result === 'decided')).toHaveLength(1)
      expect(decisions.filter((result) => result === 'already_decided'))
        .toHaveLength(CONTENDERS - 1)
      expect((await primary.runs.getPermissionRequest(run.runId, permission.requestId))?.status)
        .toMatch(/^(approved|denied)$/)

      await primary.runs.markRunningAfterDecision(run.runId, 1_100)
      const cancellations = await startTogether(Array.from({ length: CONTENDERS }, (_, index) =>
        () => security[index]!.runs.requestCancel(run.runId, 1_110 + index)))
      expect(cancellations.filter((result) => result === 'requested')).toHaveLength(1)
      expect(cancellations.filter((result) => result === 'already_requested'))
        .toHaveLength(CONTENDERS - 1)
      await primary.runs.markTerminal(run.runId, 'cancelled', { endSeq: 9, now: 1_200 })
      await expect(primary.runs.requestCancel(run.runId, 1_201)).resolves.toBe('terminal')

      const principal = {
        kind: 'delegated' as const,
        tokenId: '60000000-0000-4000-8000-000000000006',
        delegateId: 'security-concurrency-delegate',
        workspaceId: 'security-concurrency-workspace',
        profileId: 'security-concurrency-profile',
        purpose: 'customer_support',
        operations: ['runs.snapshot'],
        issuedAt: 1_000,
        expiresAt: 9_000,
      }
      const principalInserts = await settleTogether(security.map((repositories) => () =>
        repositories.principals.insert(principal)))
      expect(principalInserts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(principalInserts.filter((result) =>
        result.status === 'rejected' && result.reason instanceof StorageRepositoryError))
        .toHaveLength(CONTENDERS - 1)
      const revocations = await startTogether(security.map((repositories, index) => () =>
        repositories.principals.revoke(principal.tokenId, 'owner_revoked', 2_000 + index)))
      expect(revocations.filter(Boolean)).toHaveLength(1)

      const bindingThread = await core.threads.create('security-concurrency-profile')
      const bindings = await startTogether(security.map((repositories, index) => () =>
        repositories.threadBindings.bind(
          bindingThread.id,
          `security-concurrency-principal-${index}`,
          3_000 + index,
        )))
      expect(bindings.filter(Boolean)).toHaveLength(1)
      const bindingWinner = bindings.findIndex(Boolean)
      await expect(primary.threadBindings.allows(
        bindingThread.id,
        `security-concurrency-principal-${bindingWinner}`,
      )).resolves.toBe(true)

      const oauthCredential = await primary.credentials.save({
        name: 'security concurrency oauth',
        value: '{"accessToken":"old","refreshToken":"rotate"}',
        hint: '...rotate',
        category: 'oauth',
        authType: 'oauth2',
        source: 'oauth-flow',
      })
      const leases = await startTogether(security.map((repositories) => () =>
        repositories.oauthRefresh.tryAcquire(oauthCredential.id, 4_000, 100)))
      expect(leases.filter((result) => result.kind === 'acquired')).toHaveLength(1)
      expect(leases.filter((result) => result.kind === 'held')).toHaveLength(CONTENDERS - 1)
      const leaseWinner = leases.findIndex((result) => result.kind === 'acquired')
      const firstLease = leases[leaseWinner]!
      if (firstLease.kind !== 'acquired') throw new Error('OAuth lease winner was unavailable.')
      const takeoverRepository = security[(leaseWinner + 1) % CONTENDERS]!
      const takeover = await takeoverRepository.oauthRefresh.tryAcquire(
        oauthCredential.id,
        4_100,
        100,
      )
      expect(takeover.kind).toBe('acquired')
      if (takeover.kind !== 'acquired') throw new Error('OAuth lease takeover failed.')
      expect(takeover.lease.generation).toBe(firstLease.lease.generation + 1)
      await expect(security[leaseWinner]!.oauthRefresh.renew(firstLease.lease, 4_101, 100))
        .resolves.toBeNull()
      await expect(security[leaseWinner]!.oauthRefresh.release(firstLease.lease))
        .resolves.toBe(false)

      const grant = await primary.accessGrants.create({
        workspaceId: 'security-concurrency-workspace',
        profileId: 'security-concurrency-profile',
        subjectId: 'security-concurrency-subject',
        purpose: 'customer_support',
        channel: 'web.primary',
        resourceKind: 'source_resource',
        resourceId: '70000000-0000-4000-8000-000000000007',
        operation: 'source_content.read',
        fieldScope: { mode: 'all' },
        rowScope: { mode: 'all' },
        consent: { state: 'recorded', evidenceId: 'security-concurrency-consent' },
        autonomyCeiling: 'draft',
        effectiveAt: 5_000,
        expiresAt: 9_000,
        issuedBy: 'security-concurrency-owner',
      }, 5_000)
      const grantRevokes = await settleTogether(security.map((repositories, index) => () =>
        repositories.accessGrants.revoke({
          grantId: grant.grantId,
          workspaceId: grant.workspaceId,
          profileId: grant.profileId,
          expectedRevision: grant.revision,
        }, 5_100 + index)))
      expect(grantRevokes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(grantRevokes.filter((result) =>
        result.status === 'rejected' && result.reason instanceof AccessGrantStoreError))
        .toHaveLength(CONTENDERS - 1)
      await expect(primary.accessGrants.getCurrentForOwner(grant.grantId)).resolves.toMatchObject({
        revision: 2,
        state: 'revoked',
      })

      const codexThread = await core.threads.create('security-concurrency-profile')
      const initialReference = createCodexThreadReference({
        localThreadId: codexThread.id,
        remoteThreadId: 'security-concurrency-remote',
        accountBinding: `hmac-sha256:${'a'.repeat(64)}`,
        model: 'gpt-security-concurrency',
        modelProvider: 'openai',
        profileReportId: 'security-concurrency-profile-report',
        sandboxReportId: 'security-concurrency-sandbox-report',
        boundAt: '2026-08-02T00:00:00.000Z',
      })
      await primary.codexThreadReferences.save(initialReference)
      const codexCandidates = security.map((_, index) => ({
        ...beginCodexThreadTurn(initialReference, {
          id: `security-concurrency-turn-${index}`,
          startedAt: `2026-08-02T00:00:${String(index).padStart(2, '0')}.000Z`,
        }),
        accountBinding: `hmac-sha256:${((index + 1) % 16).toString(16).repeat(64)}`,
      }))
      const codexWrites = await settleTogether(security.map((repositories, index) => () =>
        repositories.codexThreadReferences.save(codexCandidates[index])))
      expect(codexWrites.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(codexWrites.filter((result) =>
        result.status === 'rejected' && result.reason instanceof CodexThreadReferenceStoreError))
        .toHaveLength(CONTENDERS - 1)
      const codexWinner = codexWrites.findIndex((result) => result.status === 'fulfilled')
      await expect(primary.codexThreadReferences.load(codexThread.id)).resolves.toMatchObject({
        accountBinding: codexCandidates[codexWinner]!.accountBinding,
        activeTurn: { id: `security-concurrency-turn-${codexWinner}` },
      })

      const idempotencyInput = {
        principalKey: 'security-concurrency-idempotency-principal',
        operation: 'runs.start',
        key: '80000000-0000-4000-8000-000000000008',
        input: { profileId: 'security-concurrency-profile', prompt: 'bounded' },
      }
      const idempotencyClaims = await startTogether(Array.from(
        { length: CONTENDERS },
        () => () => primary.idempotency.claim(idempotencyInput, 6_000),
      ))
      expect(idempotencyClaims.filter((result) => result.kind === 'claimed')).toHaveLength(1)
      expect(idempotencyClaims.filter((result) => result.kind === 'in_progress'))
        .toHaveLength(CONTENDERS - 1)
      const claim = idempotencyClaims.find((result) => result.kind === 'claimed')
      if (claim?.kind !== 'claimed') throw new Error('Idempotency winner was unavailable.')
      await primary.idempotency.linkRun(claim.recordId, run.runId)
      await primary.idempotency.complete({
        principalKey: idempotencyInput.principalKey,
        operation: idempotencyInput.operation,
        key: idempotencyInput.key,
        statusCode: 200,
        result: {
          runId: run.runId,
          threadId: run.threadId,
          agentId: 'root',
          profileId: run.profileId,
          candidateId: null,
          model: run.model,
          status: 'running',
          timeoutMs: run.timeoutMs,
        },
      }, 6_100)
      await expect(primary.idempotency.claim(idempotencyInput, 6_101))
        .resolves.toMatchObject({ kind: 'replay', statusCode: 200 })

      await waitForPoolReturn(harness.pool)
      expect(poolCheckoutState(harness.pool)).toMatchObject({
        checkedOut: 0,
        waiting: 0,
      })
      expect(harness.pool.idleCount).toBe(harness.pool.totalCount)
    } finally {
      await harness.close()
    }
  }, 30_000)

  it('serializes scoped grant admission and bulk-revokes only the frozen source grants', async () => {
    const harness = await createHarness()
    const lockHolder = new Client({
      connectionString: harness.database.url,
      ssl: false,
      application_name: 'security-grant-capacity-lock-holder',
    })
    const observer = new Client({
      connectionString: harness.database.url,
      ssl: false,
      application_name: 'security-grant-capacity-observer',
    })
    try {
      await lockHolder.connect()
      await observer.connect()
      const { boundedGrants, security, sources } = harness.storage.repositories
      const primaryGrants = boundedGrants[0]!
      const targets = await prepareGrantTargets(sources[0]!)

      const preparedInput = {
        workspaceId: GRANT_WORKSPACE_ID,
        profileId: GRANT_PROFILE_ID,
        subjectId: 'security-grant-prepared-subject',
        purpose: 'customer_support',
        channel: 'web.primary',
        resourceId: targets.resourceId,
        operation: 'source_content.read' as const,
        consent: { state: 'not_required' as const },
        ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
        issuedBy: 'security-grant-owner',
      }
      await expect(primaryGrants.createPreparedTextAccessGrant({
        ...preparedInput,
        workspaceId: 'security-grant-other-workspace',
      }, 20_000)).rejects.toMatchObject({
        name: 'AccessGrantStoreError',
        code: 'access_grant_resource_unavailable',
      })
      const preparedGrant = await primaryGrants.createPreparedTextAccessGrant(
        preparedInput,
        20_000,
      )
      expect(preparedGrant).toMatchObject({
        revision: 1,
        state: 'active',
        workspaceId: GRANT_WORKSPACE_ID,
        profileId: GRANT_PROFILE_ID,
        resourceKind: 'source_resource',
        resourceId: targets.resourceId,
        operation: 'source_content.read',
      })

      const dataViewInput = {
        workspaceId: GRANT_WORKSPACE_ID,
        profileId: GRANT_PROFILE_ID,
        dataViewId: targets.dataViewId,
        subjectId: 'security-grant-data-view-subject',
        purpose: 'customer_support',
        channel: 'web.primary',
        consent: { state: 'not_required' as const },
        ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
        fieldIds: [targets.fieldIds[0]!],
        rowOffset: 1,
        rowCount: 2,
        issuedBy: 'security-grant-owner',
      }
      await expect(primaryGrants.createDataViewQueryWindowGrant({
        ...dataViewInput,
        profileId: 'security-grant-other-profile',
      }, 20_010)).rejects.toMatchObject({
        name: 'AccessGrantStoreError',
        code: 'access_grant_resource_unavailable',
      })
      await expect(primaryGrants.createDataViewQueryWindowGrant({
        ...dataViewInput,
        fieldIds: [csvDataViewOrdinalId(
          'field',
          '90000000-0000-4000-8000-000000000009',
          0,
        )],
      }, 20_010)).rejects.toMatchObject({
        name: 'AccessGrantStoreError',
        code: 'access_grant_invalid',
      })
      await expect(primaryGrants.createDataViewQueryWindowGrant({
        ...dataViewInput,
        rowOffset: 3,
        rowCount: 2,
      }, 20_010)).rejects.toMatchObject({
        name: 'AccessGrantStoreError',
        code: 'access_grant_invalid',
      })
      const dataViewGrant = await primaryGrants.createDataViewQueryWindowGrant(
        dataViewInput,
        20_010,
      )
      expect(dataViewGrant).toMatchObject({
        revision: 1,
        state: 'active',
        workspaceId: GRANT_WORKSPACE_ID,
        profileId: GRANT_PROFILE_ID,
        resourceKind: 'source_data_view',
        resourceId: targets.dataViewId,
        operation: 'source_data_views.query',
        fieldScope: { mode: 'list', ids: dataViewInput.fieldIds },
        rowScope: {
          mode: 'list',
          ids: [
            csvDataViewOrdinalId('row', targets.sourceVersionId, 1),
            csvDataViewOrdinalId('row', targets.sourceVersionId, 2),
          ].sort(),
        },
      })
      expect((await primaryGrants.listCurrentForOwner(
        { limit: 100, cursor: null },
        20_011,
      )).items).toHaveLength(2)

      await lockHolder.query('BEGIN')
      const holder = await lockHolder.query<{ readonly pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )
      const lockHolderPid = holder.rows[0]?.pid
      if (!Number.isSafeInteger(lockHolderPid)) {
        throw new Error('Grant capacity lock-holder identity was unavailable.')
      }
      await lockHolder.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 1335664962))',
        [`${GRANT_WORKSPACE_ID}\u001f${GRANT_PROFILE_ID}`],
      )
      const capacityRace = settleTogether(boundedGrants.map((repository, index) => () =>
        repository.create({
          workspaceId: GRANT_WORKSPACE_ID,
          profileId: GRANT_PROFILE_ID,
          subjectId: `security-grant-capacity-subject-${index}`,
          purpose: 'customer_support',
          channel: 'web.primary',
          resourceKind: 'source_resource',
          resourceId: targets.resourceId,
          operation: 'source_content.search',
          fieldScope: { mode: 'all' },
          rowScope: { mode: 'all' },
          consent: { state: 'not_required' },
          autonomyCeiling: 'observe',
          effectiveAt: 20_020,
          expiresAt: 400_000,
          issuedBy: 'security-grant-owner',
        }, 20_020)))
      const blocked = await waitForBlockedRuntimePids(
        observer,
        lockHolderPid!,
        CONTENDERS,
      )
      expect(new Set(blocked).size).toBe(CONTENDERS)
      await lockHolder.query('ROLLBACK')
      const capacityResults = await capacityRace
      expect(capacityResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(capacityResults.filter((result) =>
        result.status === 'rejected' && result.reason instanceof AccessGrantStoreError &&
        result.reason.code === 'access_grant_limit_exceeded'))
        .toHaveLength(CONTENDERS - 1)
      const capacityWinner = capacityResults.find((result) => result.status === 'fulfilled')
      if (capacityWinner?.status !== 'fulfilled') {
        throw new Error('Grant capacity winner was unavailable.')
      }
      const sourceGrantIds = [
        preparedGrant.grantId,
        dataViewGrant.grantId,
        capacityWinner.value.grantId,
      ]
      expect((await primaryGrants.listCurrentForOwner(
        { limit: 100, cursor: null },
        20_021,
      )).items.filter((grant) => grant.state === 'active')).toHaveLength(GRANT_CAPACITY)

      const unrelatedGrant = await security[0]!.accessGrants.create({
        workspaceId: GRANT_WORKSPACE_ID,
        profileId: GRANT_PROFILE_ID,
        subjectId: 'security-grant-unrelated-subject',
        purpose: 'customer_support',
        channel: 'web.primary',
        resourceKind: 'source_resource',
        resourceId: 'a0000000-0000-4000-8000-00000000000a',
        operation: 'source_content.read',
        fieldScope: { mode: 'all' },
        rowScope: { mode: 'all' },
        consent: { state: 'not_required' },
        autonomyCeiling: 'observe',
        effectiveAt: 20_030,
        expiresAt: 400_000,
        issuedBy: 'security-grant-owner',
      }, 20_030)

      const deletionPlans = await startTogether(sources.map((repositories, index) => () =>
        repositories.deletions.plan({
          workspaceId: GRANT_WORKSPACE_ID,
          profileId: GRANT_PROFILE_ID,
          sourceId: targets.sourceId,
          expectedRevision: targets.sourceRevision,
        }, 30_000 + index)))
      expect(deletionPlans).toHaveLength(CONTENDERS)
      for (const replay of deletionPlans.slice(1)) expect(replay).toEqual(deletionPlans[0])
      expect(deletionPlans[0]).toMatchObject({
        sourceId: targets.sourceId,
        sourceRevision: targets.sourceRevision + 1,
        inventoryCounts: { accessGrantRevocations: GRANT_CAPACITY },
      })
      for (const grantId of sourceGrantIds) {
        await expect(primaryGrants.getCurrentForOwner(grantId)).resolves.toMatchObject({
          revision: 2,
          state: 'revoked',
        })
      }
      await expect(primaryGrants.getCurrentForOwner(unrelatedGrant.grantId)).resolves.toMatchObject({
        revision: 1,
        state: 'active',
      })
      const revisions = await observer.query<{ readonly grant_id: string; readonly count: string }>(`
        SELECT grant_id, COUNT(*)::text AS count
        FROM ownware.access_grant_revisions
        WHERE grant_id = ANY($1::text[])
        GROUP BY grant_id
        ORDER BY grant_id
      `, [[...sourceGrantIds, unrelatedGrant.grantId]])
      expect(revisions.rows).toHaveLength(GRANT_CAPACITY + 1)
      expect(revisions.rows.filter((row) =>
        sourceGrantIds.includes(row.grant_id) && row.count === '2'))
        .toHaveLength(GRANT_CAPACITY)
      expect(revisions.rows.find((row) => row.grant_id === unrelatedGrant.grantId)?.count).toBe('1')

      await waitForPoolReturn(harness.pool)
      expect(poolCheckoutState(harness.pool)).toMatchObject({ checkedOut: 0, waiting: 0 })
      expect(harness.pool.idleCount).toBe(harness.pool.totalCount)
    } finally {
      await lockHolder.query('ROLLBACK').catch(() => {})
      await observer.end().catch(() => {})
      await lockHolder.end().catch(() => {})
      await harness.close()
    }
  }, 30_000)

  it('cancels a blocked credential CAS, rolls back and returns its client to the pool', async () => {
    const harness = await createHarness()
    const lockHolder = new Client({
      connectionString: harness.database.url,
      ssl: false,
      application_name: 'security-concurrency-lock-holder',
    })
    const observer = new Client({
      connectionString: harness.database.url,
      ssl: false,
      application_name: 'security-concurrency-observer',
    })
    try {
      await lockHolder.connect()
      await observer.connect()
      const repositories = harness.storage.repositories.security[0]!
      const credential = await repositories.credentials.save({
        name: 'security cancellation credential',
        value: 'SECURITY_CANCELLATION_ORIGINAL',
        category: 'llm',
        authType: 'api-key',
        variableName: 'SECURITY_CANCELLATION_KEY',
        source: 'manual',
      })
      const baseline = await repositories.credentials.decrypt(credential.id)
      if (baseline === null) throw new Error('Credential cancellation baseline was unavailable.')
      await waitForPoolReturn(harness.pool)
      const poolBaseline = poolCheckoutState(harness.pool)

      await lockHolder.query('BEGIN')
      const holder = await lockHolder.query<{ readonly pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )
      const lockHolderPid = holder.rows[0]?.pid
      if (!Number.isSafeInteger(lockHolderPid)) throw new Error('Lock-holder identity was unavailable.')
      await lockHolder.query(
        'SELECT id FROM ownware.credentials WHERE id = $1 FOR UPDATE',
        [credential.id],
      )

      const blockedUpdate = repositories.credentials.updateIfUnchanged(
        credential.id,
        {
          valueRevision: baseline.valueRevision,
          status: baseline.metadata.status,
        },
        { value: 'SECURITY_CANCELLATION_MUST_ROLL_BACK' },
      )
      const blockedPid = await waitForBlockedRuntimePid(observer, lockHolderPid!)
      const cancelled = await observer.query<{ readonly cancelled: boolean }>(
        'SELECT pg_cancel_backend($1) AS cancelled',
        [blockedPid],
      )
      expect(cancelled.rows[0]?.cancelled).toBe(true)

      const failure = await caught(() => blockedUpdate)
      expect(failure).toBeInstanceOf(StorageRepositoryError)
      expect(failure).toEqual(expect.objectContaining({
        domain: 'credentials',
        operation: 'update_if_unchanged',
        code: 'write_failed',
        retryable: true,
      }))
      expect(JSON.stringify(failure)).not.toContain('SECURITY_CANCELLATION_MUST_ROLL_BACK')
      await waitForPoolReturn(harness.pool)
      expect(poolCheckoutState(harness.pool)).toEqual(poolBaseline)
      expect((await repositories.credentials.decrypt(credential.id))?.value)
        .toBe('SECURITY_CANCELLATION_ORIGINAL')

      await lockHolder.query('ROLLBACK')
      const retry = await repositories.credentials.updateIfUnchanged(
        credential.id,
        {
          valueRevision: baseline.valueRevision,
          status: baseline.metadata.status,
        },
        { value: 'SECURITY_CANCELLATION_RETRY' },
      )
      expect(retry.kind).toBe('updated')
      await waitForPoolReturn(harness.pool)
      expect(poolCheckoutState(harness.pool)).toEqual(poolBaseline)
    } finally {
      await lockHolder.query('ROLLBACK').catch(() => {})
      await observer.end().catch(() => {})
      await lockHolder.end().catch(() => {})
      await harness.close()
    }
  }, 30_000)
})
