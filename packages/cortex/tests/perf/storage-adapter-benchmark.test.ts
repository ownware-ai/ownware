import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer, type Socket } from 'node:net'
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import type { SourceQuotaLimits } from '../../src/gateway/source-quota-policy.js'
import type { CoreStorageRepositories } from '../../src/storage/core-repositories.js'
import type { StorageAdapter } from '../../src/storage/contracts.js'
import { createPostgreSqlCoreRepositories } from '../../src/storage/postgresql-core-repositories.js'
import { PostgreSqlStorageAdapter } from '../../src/storage/postgresql-adapter.js'
import { createPostgreSqlSourceRepositories } from '../../src/storage/postgresql-source-repositories.js'
import { createSqliteCoreRepositories } from '../../src/storage/sqlite-core-repositories.js'
import { SqliteStorageAdapter } from '../../src/storage/sqlite-adapter.js'
import { createSqliteSourceRepositories } from '../../src/storage/sqlite-source-repositories.js'
import type { SourceRepositories } from '../../src/storage/source-repositories.js'
import { validateStoragePlan } from '../../src/storage/config.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../storage/postgresql-test-database.js'

const require = createRequire(import.meta.url)
const TEST_URL = configuredPostgreSqlTestUrl()
const ENABLED = process.env['RUN_STORAGE_ADAPTER_BENCHMARK'] === '1' && TEST_URL !== undefined

const CONCURRENCY = 8
const WARMUP_COUNT = 16
const THREAD_WRITES = 160
const EVENT_WRITES = 320
const JOB_WRITES = 80
const INJECTED_ONE_WAY_DELAY_MS = 5
const PROFILE_ID = 'storage-benchmark'
const WORKSPACE_ID = 'storage-benchmark-workspace'
const SOURCE_CHECKSUM = `sha256:${'a'.repeat(64)}`
const CHUNK_CHECKSUM = `sha256:${'c'.repeat(64)}`

interface BenchmarkRepositories {
  readonly core: CoreStorageRepositories
  readonly sources: SourceRepositories
}

interface Distribution {
  readonly samples: number
  readonly concurrency: number
  readonly throughputOpsPerSecond: number
  readonly latencyMs: {
    readonly p50: number
    readonly p95: number
    readonly p99: number
    readonly max: number
  }
}

interface BenchmarkHarness {
  readonly adapter: StorageAdapter<BenchmarkRepositories, Record<string, never>>
  readonly label: 'sqlite' | 'postgresql-loopback' | 'postgresql-delayed-loopback'
  readonly engine: string
  readonly transport: string
  sizeBytes(): Promise<number>
  close(): Promise<void>
}

interface LatencyProxy {
  readonly url: string
  close(): Promise<void>
}

describe('storage adapter performance receipt', () => {
  it.runIf(ENABLED)(
    'records correctness-guarded concurrent latency, throughput and growth',
    async () => {
      const results = []
      for (const create of [
        createSqliteHarness,
        () => createPostgreSqlHarness(0),
        () => createPostgreSqlHarness(INJECTED_ONE_WAY_DELAY_MS),
      ]) {
        const harness = await create()
        try {
          results.push(await runWorkload(harness))
        } finally {
          await harness.close()
        }
      }

      expect(results.map(({ adapter }) => adapter)).toEqual([
        'sqlite',
        'postgresql-loopback',
        'postgresql-delayed-loopback',
      ])
      for (const result of results) {
        expect(result.storage.growthBytes).toBeGreaterThan(0)
        expect(result.operations.appendEvent.samples).toBe(EVENT_WRITES)
        expect(result.operations.claimJob.samples).toBe(JOB_WRITES)
      }

      const sqlite = results[0]!
      const postgresql = results[1]!
      const comparison = Object.fromEntries(
        Object.keys(sqlite.operations).map((operation) => {
          const sqliteP99 = sqlite.operations[operation]!.latencyMs.p99
          const postgresqlP99 = postgresql.operations[operation]!.latencyMs.p99
          return [operation, {
            sqliteP99Ms: sqliteP99,
            postgresqlP99Ms: postgresqlP99,
            postgresqlToSqliteP99Ratio: sqliteP99 === 0 ? null : postgresqlP99 / sqliteP99,
            slowerAdapter: postgresqlP99 > sqliteP99 ? 'postgresql' : 'sqlite',
          }]
        }),
      )

      console.log(`STORAGE_ADAPTER_BENCHMARK ${JSON.stringify({
        receiptVersion: 1,
        measuredAt: new Date().toISOString(),
        runtime: {
          node: process.version,
          bun: process.versions.bun ?? null,
          platform: platform(),
          release: release(),
          arch: arch(),
          logicalCpuCount: cpus().length,
          cpuModel: cpus()[0]?.model ?? 'unknown',
          totalMemoryBytes: totalmem(),
          pgDriver: packageVersion('pg'),
          sqliteDriver: packageVersion('better-sqlite3'),
        },
        parameters: {
          concurrency: CONCURRENCY,
          warmupCoreOperationsPerKind: WARMUP_COUNT,
          warmupJobPipelines: 1,
          threadWrites: THREAD_WRITES,
          eventWrites: EVENT_WRITES,
          jobWrites: JOB_WRITES,
          delayedTransport: {
            mechanism: 'loopback TCP proxy; minimum delay applied to each chunk in each direction',
            oneWayDelayMs: INJECTED_ONE_WAY_DELAY_MS,
            realRemoteNetworkClaimed: false,
          },
        },
        results,
        directPostgresqlVsSqlite: comparison,
      })}`)
    },
    180_000,
  )
})

async function runWorkload(harness: BenchmarkHarness) {
  const { core, sources } = harness.adapter.repositories

  const warmThreads = []
  for (let index = 0; index < WARMUP_COUNT; index += 1) {
    const thread = await core.threads.create(PROFILE_ID, `warmup-${index}`)
    warmThreads.push(thread)
    await core.messages.add(thread.id, message(`warmup-message-${index}`, index))
    await core.events.append(event(thread.id, index))
  }
  const warmJob = await prepareJob(sources, 'warmup-job', 1)
  const warmClaim = await sources.jobs.claimNext('warmup-worker', 10_000)
  expect(warmClaim?.jobId).toBe(warmJob)
  expect(await sources.jobs.advanceCheckpoint(
    warmClaim!.jobId,
    warmClaim!.claimToken,
    0,
    1,
    10_001,
  )).toBe('advanced')

  const beforeBytes = await harness.sizeBytes()
  const created = await measure(THREAD_WRITES, CONCURRENCY, async (index) =>
    core.threads.create(PROFILE_ID, `measured-${index}`))
  const threadIds = created.values.map(({ id }) => id)

  const addMessage = await measure(THREAD_WRITES, CONCURRENCY, async (index) =>
    core.messages.add(threadIds[index]!, message(`measured-message-${index}`, index)))

  const appendEvent = await measure(EVENT_WRITES, CONCURRENCY, async (index) =>
    core.events.append(event(threadIds[index % threadIds.length]!, index)))

  const getThread = await measure(THREAD_WRITES, CONCURRENCY, async (index) =>
    core.threads.get(threadIds[index]!))

  const listMessages = await measure(THREAD_WRITES, CONCURRENCY, async (index) =>
    core.messages.list(threadIds[index]!))

  const jobIds: string[] = []
  for (let index = 0; index < JOB_WRITES; index += 1) {
    jobIds.push(await prepareJob(sources, `measured-job-${index}`, index + 100))
  }
  const claimJob = await measure(JOB_WRITES, CONCURRENCY, async (index) => {
    const claim = await sources.jobs.claimNext(`measured-worker-${index}`, 20_000)
    if (claim === null) throw new Error('Benchmark job claim unavailable.')
    return claim
  })
  expect(new Set(claimJob.values.map(({ jobId }) => jobId))).toEqual(new Set(jobIds))

  const checkpointJob = await measure(JOB_WRITES, CONCURRENCY, async (index) => {
    const claim = claimJob.values[index]!
    return sources.jobs.advanceCheckpoint(
      claim.jobId,
      claim.claimToken,
      0,
      1,
      20_001,
    )
  })

  expect(checkpointJob.values.every((value) => value === 'advanced')).toBe(true)
  expect(getThread.values.every((thread) => thread?.profileId === PROFILE_ID)).toBe(true)
  expect(listMessages.values.every((messages) => messages.length === 1)).toBe(true)
  expect(await core.events.count()).toBe(WARMUP_COUNT + EVENT_WRITES)
  expect(await core.events.maxSeq(threadIds[0]!, 'root')).toBe(2)
  expect((await core.messages.list(threadIds[0]!))[0]?.id).toBe('measured-message-0')

  const afterBytes = await harness.sizeBytes()
  return {
    adapter: harness.label,
    engine: harness.engine,
    transport: harness.transport,
    storage: {
      beforeBytes,
      afterBytes,
      growthBytes: afterBytes - beforeBytes,
    },
    operations: {
      createThread: created.distribution,
      addMessage: addMessage.distribution,
      appendEvent: appendEvent.distribution,
      getThread: getThread.distribution,
      listMessages: listMessages.distribution,
      claimJob: claimJob.distribution,
      checkpointJob: checkpointJob.distribution,
    } satisfies Record<string, Distribution>,
  }
}

async function measure<T>(
  count: number,
  concurrency: number,
  operation: (index: number) => Promise<T>,
): Promise<{ readonly values: T[]; readonly distribution: Distribution }> {
  const values = new Array<T>(count)
  const latency = new Array<number>(count)
  let next = 0
  const started = performance.now()
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= count) return
      const operationStarted = performance.now()
      values[index] = await operation(index)
      latency[index] = performance.now() - operationStarted
    }
  }))
  const elapsedMs = performance.now() - started
  const ordered = [...latency].sort((left, right) => left - right)
  return {
    values,
    distribution: {
      samples: count,
      concurrency,
      throughputOpsPerSecond: count / (elapsedMs / 1_000),
      latencyMs: {
        p50: percentile(ordered, 50),
        p95: percentile(ordered, 95),
        p99: percentile(ordered, 99),
        max: ordered.at(-1)!,
      },
    },
  }
}

function percentile(ordered: readonly number[], percentileValue: number): number {
  const index = Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1)
  return ordered[Math.min(index, ordered.length - 1)]!
}

function message(id: string, index: number) {
  return {
    id,
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `fixed benchmark message ${index} ${'x'.repeat(160)}`,
    timestamp: new Date(Date.UTC(2026, 7, 2, 0, 0, 0, index)).toISOString(),
  }
}

function event(threadId: string, index: number) {
  return {
    threadId,
    agentId: 'root',
    parentAgentId: null,
    type: 'text.delta',
    payload: { type: 'text.delta', text: `fixed benchmark event ${index} ${'y'.repeat(80)}` },
  }
}

async function prepareJob(
  repositories: SourceRepositories,
  label: string,
  clock: number,
): Promise<string> {
  const source = await repositories.sources.create({
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    kind: 'structured_export',
    label,
    classification: 'internal',
    authority: 'supporting_reference',
    audiencePolicyRef: 'audience.policy.benchmark',
    sensitivityPolicyRef: 'sensitivity.policy.benchmark',
    purposePolicyRef: 'purpose.policy.benchmark',
    retentionPolicyRef: 'retention.policy.benchmark',
    freshnessPolicyRef: 'freshness.policy.benchmark',
  }, clock)
  const upload = await repositories.uploads.create({
    sourceId: source.sourceId,
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    principalKey: `delegated\0benchmark-${label}\0workspace\0profile`,
    expectedBytes: 16,
    expectedChecksum: SOURCE_CHECKSUM,
    declaredMediaType: 'text/plain',
    filename: 'benchmark.txt',
  }, clock + 1)
  await repositories.uploads.advanceChunk(
    upload.uploadId,
    0,
    { byteCount: 16, checksum: CHUNK_CHECKSUM },
    clock + 2,
  )
  const versionId = await repositories.uploads.beginCompletion(upload.uploadId, clock + 3)
  const version = await repositories.uploads.finishCompletion(upload.uploadId, {
    versionId,
    checksum: SOURCE_CHECKSUM,
    verifiedMediaType: 'text/plain',
    byteCount: 16,
    objectKey: `sources/${source.sourceId}/versions/${versionId}/original`,
  }, clock + 4)
  const job = await repositories.jobs.enqueue({
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    sourceId: source.sourceId,
    sourceVersionId: version.sourceVersionId,
    operation: 'inspect_format',
  }, clock + 5)
  return job.jobId
}

async function createSqliteHarness(): Promise<BenchmarkHarness> {
  const directory = mkdtempSync(join(tmpdir(), 'ownware-storage-benchmark-sqlite-'))
  const dbPath = join(directory, 'ownware.db')
  const adapter = new SqliteStorageAdapter<
    BenchmarkRepositories,
    Record<string, never>
  >({
    dbPath,
    openMode: 'eager',
    repositories: {
      createRoot: (context) => ({
        core: createSqliteCoreRepositories(context),
        sources: createSqliteSourceRepositories(context, { quotaLimits: QUOTA_LIMITS }),
      }),
      createTransaction: () => ({}),
    },
  })
  await adapter.initialize()
  const version = adapter.legacyDatabase.rawMainHandle
    .prepare('SELECT sqlite_version() AS version')
    .get() as { readonly version: string }
  return {
    adapter,
    label: 'sqlite',
    engine: `SQLite ${version.version}`,
    transport: 'local file; WAL; one process',
    async sizeBytes() {
      adapter.legacyDatabase.rawMainHandle.pragma('wal_checkpoint(TRUNCATE)')
      return fileBytes(dbPath) + fileBytes(`${dbPath}-wal`)
    },
    async close() {
      await adapter.close().catch(() => {})
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

async function createPostgreSqlHarness(oneWayDelayMs: number): Promise<BenchmarkHarness> {
  const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
  let proxy: LatencyProxy | undefined
  let adapter: PostgreSqlStorageAdapter<
    BenchmarkRepositories,
    Record<string, never>
  > | undefined
  try {
    proxy = oneWayDelayMs === 0
      ? undefined
      : await createLatencyProxy(database.url, oneWayDelayMs)
    const connectionUrl = proxy?.url ?? database.url
    const plan = validateStoragePlan({
      storage: {
        kind: 'postgresql',
        runtimeConnection: { source: 'provider', resolve: () => connectionUrl },
        tls: { mode: 'disable', allowInsecureLoopback: true },
        pool: { maxConnections: CONCURRENCY },
      },
    }, '/unused.db')
    if (plan.kind !== 'postgresql') throw new Error('Expected PostgreSQL benchmark plan.')
    adapter = new PostgreSqlStorageAdapter({
      plan,
      repositories: {
        createRoot: (context) => ({
          core: createPostgreSqlCoreRepositories(context),
          sources: createPostgreSqlSourceRepositories(context, { quotaLimits: QUOTA_LIMITS }),
        }),
        createTransaction: () => ({}),
      },
    })
    await adapter.initialize()
    const engine = await queryScalar(database.url, 'SHOW server_version')
    return {
      adapter,
      label: oneWayDelayMs === 0 ? 'postgresql-loopback' : 'postgresql-delayed-loopback',
      engine: `PostgreSQL ${engine}`,
      transport: oneWayDelayMs === 0
        ? `loopback TCP; pool max ${CONCURRENCY}`
        : `loopback TCP proxy; ${oneWayDelayMs} ms minimum delay per chunk/direction; ` +
          `pool max ${CONCURRENCY}; not a real remote-network measurement`,
      sizeBytes: () => postgreSqlDatabaseSize(database.adminUrl, database.name),
      async close() {
        await adapter?.close().catch(() => {})
        await proxy?.close().catch(() => {})
        await database.close()
      },
    }
  } catch (error) {
    await adapter?.close().catch(() => {})
    await proxy?.close().catch(() => {})
    await database.close().catch(() => {})
    throw error
  }
}

async function createLatencyProxy(target: string, delayMs: number): Promise<LatencyProxy> {
  const targetUrl = new URL(target)
  const sockets = new Set<Socket>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const server = createServer((downstream) => {
    const upstream = connect({
      host: targetUrl.hostname,
      port: Number(targetUrl.port || 5432),
    })
    sockets.add(downstream)
    sockets.add(upstream)
    const forward = (source: Socket, destination: Socket): void => {
      source.on('data', (chunk: Buffer) => {
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (!destination.destroyed) destination.write(chunk)
        }, delayMs)
        timer.unref?.()
        timers.add(timer)
      })
    }
    forward(downstream, upstream)
    forward(upstream, downstream)
    downstream.on('error', () => upstream.destroy())
    upstream.on('error', () => downstream.destroy())
    downstream.on('close', () => sockets.delete(downstream))
    upstream.on('close', () => sockets.delete(upstream))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('Latency proxy did not bind a TCP port.')
  }
  const proxyUrl = new URL(target)
  proxyUrl.hostname = '127.0.0.1'
  proxyUrl.port = String(address.port)
  return {
    url: proxyUrl.toString(),
    async close() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

async function postgreSqlDatabaseSize(adminUrl: string, database: string): Promise<number> {
  const client = new Client({ connectionString: adminUrl, ssl: false })
  try {
    await client.connect()
    const result = await client.query<{ readonly bytes: string }>(
      'SELECT pg_database_size($1)::text AS bytes',
      [database],
    )
    return Number(result.rows[0]?.bytes)
  } finally {
    await client.end().catch(() => {})
  }
}

async function queryScalar(connectionString: string, sql: string): Promise<string> {
  const client = new Client({ connectionString, ssl: false })
  try {
    await client.connect()
    const result = await client.query<Record<string, string>>(sql)
    return Object.values(result.rows[0] ?? {})[0] ?? 'unknown'
  } finally {
    await client.end().catch(() => {})
  }
}

function packageVersion(name: string): string {
  return (require(`${name}/package.json`) as { readonly version: string }).version
}

function fileBytes(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

const LIMITS = {
  maxSourceRegistrations: 1_000,
  maxRetainedAndReservedBytes: 1_000_000_000,
  maxActiveUploadSessions: 1_000,
  maxNonterminalJobs: 1_000,
  maxDerivedResources: 1_000,
}

const QUOTA_LIMITS: SourceQuotaLimits = {
  workspace: LIMITS,
  profile: LIMITS,
}
