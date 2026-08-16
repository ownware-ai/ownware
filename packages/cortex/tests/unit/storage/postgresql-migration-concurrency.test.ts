import { Client, Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  PostgreSqlStorageAdapter,
  type PostgreSqlRepositoryFactories,
} from '../../../src/storage/postgresql-adapter.js'
import {
  POSTGRESQL_BASELINE_SQL,
  POSTGRESQL_BASELINE_VERSION,
} from '../../../src/storage/postgresql-baseline.js'
import {
  validateStoragePlan,
  type PostgreSqlPoolOptions,
  type ValidatedPostgreSqlPlan,
} from '../../../src/storage/config.js'
import { PostgreSqlStorageError } from '../../../src/storage/contracts.js'
import type { PostgreSqlDriver } from '../../../src/storage/postgresql-driver.js'
import { STORAGE_LOGICAL_MIGRATIONS } from '../../../src/storage/migration-manifest.js'
import {
  POSTGRESQL_MIGRATION_MANIFEST,
  postgreSqlMigrationFingerprint,
  type PostgreSqlMigration,
  type PostgreSqlMigrationManifest,
} from '../../../src/storage/postgresql-migrations.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = process.env['POSTGRES_TEST_URL'] ?? configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe
const MIGRATION_LOCK_NAMESPACE = 1_335_664_962
const MIGRATION_LOCK_KEY = 0
const MIGRATION_APPLICATION_NAME = 'ownware-storage-migration'
const V90_NAME = 'add_thread_upgrade_marker'
const V90_SQL = `
  ALTER TABLE ownware.threads
  ADD COLUMN upgrade_marker TEXT NOT NULL DEFAULT 'v90'
`.trim()

const verifyV90Schema: PostgreSqlMigration['verifyApplied'] = async (client) => {
  const result = await client.query<{
    readonly tables: string
    readonly columns: string
    readonly data_type: string | null
    readonly nullable: string | null
    readonly default_value: string | null
  }>(`
    SELECT
      (SELECT count(*)::text FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'ownware' AND relation.relkind = 'r') AS tables,
      (SELECT count(*)::text FROM pg_catalog.pg_attribute AS attribute
        JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'ownware' AND relation.relkind = 'r'
          AND attribute.attnum > 0 AND NOT attribute.attisdropped) AS columns,
      (SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'ownware' AND table_name = 'threads'
          AND column_name = 'upgrade_marker') AS data_type,
      (SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'ownware' AND table_name = 'threads'
          AND column_name = 'upgrade_marker') AS nullable,
      (SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'ownware' AND table_name = 'threads'
          AND column_name = 'upgrade_marker') AS default_value
  `)
  const row = result.rows[0]
  return row?.tables === '75' && row.columns === '811' &&
    row.data_type === 'text' && row.nullable === 'NO' &&
    row.default_value === "'v90'::text"
}

const V90_MIGRATION: PostgreSqlMigration = Object.freeze({
  version: 90,
  name: V90_NAME,
  sql: V90_SQL,
  verifyApplied: verifyV90Schema,
})
const V90_FINGERPRINT = postgreSqlMigrationFingerprint(V90_MIGRATION)
const V90_MANIFEST: PostgreSqlMigrationManifest = Object.freeze({
  migrations: Object.freeze([...POSTGRESQL_MIGRATION_MANIFEST.migrations, V90_MIGRATION]),
  logicalMigrations: Object.freeze([
    ...STORAGE_LOGICAL_MIGRATIONS,
    { version: 90, name: V90_NAME },
  ]),
  verifyCurrentSchema: verifyV90Schema,
})

interface EmptyRepositories {}

interface MigrationRow {
  readonly version: string
  readonly name: string
  readonly fingerprint: string | null
}

interface MigrationReceipt extends MigrationRow {
  readonly applied_at: string
}

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

type QueryObserver = (
  client: Client,
  text: string,
  proceed: () => Promise<unknown>,
) => Promise<unknown>

const EMPTY_FACTORIES: PostgreSqlRepositoryFactories<EmptyRepositories, EmptyRepositories> = {
  createRoot: () => ({}),
  createTransaction: () => ({}),
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve() {
      resolvePromise?.()
    },
  }
}

function plan(
  url: string,
  pool: PostgreSqlPoolOptions = {},
): ValidatedPostgreSqlPlan {
  const selected = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => url },
      tls: { mode: 'disable', allowInsecureLoopback: true },
      pool,
    },
  }, '/unused.db')
  if (selected.kind !== 'postgresql') throw new Error('Expected PostgreSQL test plan.')
  return selected
}

function instrumentedDriver(observer: QueryObserver): PostgreSqlDriver {
  const InstrumentedClient = new Proxy(Client, {
    construct(Target, args) {
      const client = Reflect.construct(Target, args) as Client
      const originalQuery = client.query.bind(client) as (...queryArgs: unknown[]) => Promise<unknown>
      client.query = (async (...queryArgs: unknown[]) => {
        const input = queryArgs[0]
        const text = typeof input === 'string'
          ? input
          : typeof input === 'object' && input !== null && 'text' in input
            ? String((input as { readonly text?: unknown }).text ?? '')
            : ''
        return observer(client, text, () => originalQuery(...queryArgs))
      }) as Client['query']
      return client
    },
  }) as typeof Client
  return { Client: InstrumentedClient, Pool }
}

function adapter(
  url: string,
  options: {
    readonly driver?: PostgreSqlDriver
    readonly pool?: PostgreSqlPoolOptions
    readonly migrationManifest?: PostgreSqlMigrationManifest
  } = {},
): PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> {
  return new PostgreSqlStorageAdapter({
    plan: plan(url, options.pool),
    repositories: EMPTY_FACTORIES,
    ...(options.driver === undefined
      ? {}
      : { loadDriver: async () => options.driver! }),
    ...(options.migrationManifest === undefined
      ? {}
      : { migrationManifest: options.migrationManifest }),
  })
}

async function migrationLockSnapshot(url: string): Promise<{
  readonly granted: number
  readonly waiting: number
}> {
  const inspector = new Client({ connectionString: url, ssl: false })
  try {
    await inspector.connect()
    const result = await inspector.query<{
      readonly granted: boolean
      readonly count: string
    }>(`
      SELECT lock.granted, count(*)::text AS count
      FROM pg_catalog.pg_locks AS lock
      JOIN pg_catalog.pg_stat_activity AS activity ON activity.pid = lock.pid
      WHERE lock.locktype = 'advisory'
        AND lock.database = (SELECT oid FROM pg_catalog.pg_database
          WHERE datname = current_database())
        AND activity.application_name = $1
      GROUP BY lock.granted
    `, [MIGRATION_APPLICATION_NAME])
    let granted = 0
    let waiting = 0
    for (const row of result.rows) {
      if (row.granted) granted += Number(row.count)
      else waiting += Number(row.count)
    }
    return { granted, waiting }
  } finally {
    await inspector.end().catch(() => {})
  }
}

async function waitForMigrationLocks(
  url: string,
  expected: { readonly granted: number; readonly waiting: number },
): Promise<void> {
  const deadline = Date.now() + 5_000
  let observed = { granted: -1, waiting: -1 }
  do {
    observed = await migrationLockSnapshot(url)
    if (observed.granted === expected.granted && observed.waiting === expected.waiting) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  throw new Error(
    `PostgreSQL migration-lock state did not reach granted=${expected.granted}, ` +
      `waiting=${expected.waiting}; observed granted=${observed.granted}, ` +
      `waiting=${observed.waiting}.`,
  )
}

async function migrationHistory(url: string): Promise<readonly MigrationRow[]> {
  const inspector = new Client({ connectionString: url, ssl: false })
  try {
    await inspector.connect()
    const result = await inspector.query<MigrationRow>(`
      SELECT version::text, name, fingerprint
      FROM ownware._migrations
      ORDER BY version
    `)
    return result.rows
  } finally {
    await inspector.end().catch(() => {})
  }
}

async function migrationReceipts(client: Client): Promise<readonly MigrationReceipt[]> {
  const result = await client.query<MigrationReceipt>(`
    SELECT version::text, name, fingerprint, applied_at
    FROM ownware._migrations
    ORDER BY version
  `)
  return result.rows
}

async function closeAdapters(
  adapters: readonly PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories>[],
): Promise<void> {
  await Promise.all(adapters.map((storage) => storage.close().catch(() => {})))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describePostgreSql('PostgreSQL migration concurrency', () => {
  it('executes one fresh manifest while every concurrent waiter becomes healthy, then restarts unchanged', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const firstLockHeld = deferred()
    const releaseFirstLock = deferred()
    let firstGrantedLockPaused = false
    let baselineExecutions = 0
    const driver = instrumentedDriver(async (_client, text, proceed) => {
      if (text === POSTGRESQL_BASELINE_SQL) baselineExecutions += 1
      if (!text.includes('pg_advisory_xact_lock')) return proceed()

      const result = await proceed()
      if (!firstGrantedLockPaused) {
        firstGrantedLockPaused = true
        firstLockHeld.resolve()
        await releaseFirstLock.promise
      }
      return result
    })
    const storages = Array.from({ length: 6 }, () => adapter(database.url, {
      driver,
      pool: { lockTimeoutMs: 15_000, migrationTimeoutMs: 20_000 },
    }))
    let restart: PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> | undefined
    try {
      const initializations = storages.map((storage) => storage.initialize())
      await firstLockHeld.promise
      await waitForMigrationLocks(database.url, { granted: 1, waiting: storages.length - 1 })
      releaseFirstLock.resolve()

      await Promise.all(initializations)
      expect(baselineExecutions).toBe(1)
      for (const storage of storages) {
        await expect(storage.health()).resolves.toMatchObject({
          kind: 'postgresql',
          state: 'ready',
          schemaVersion: 89,
        })
      }
      await expect(migrationHistory(database.url)).resolves.toEqual(
        POSTGRESQL_MIGRATION_MANIFEST.migrations.map((migration) => ({
          version: String(migration.version),
          name: migration.name,
          fingerprint: postgreSqlMigrationFingerprint(migration),
        })),
      )

      await closeAdapters(storages)
      restart = adapter(database.url, { driver })
      await restart.initialize()
      await expect(restart.health()).resolves.toMatchObject({
        state: 'ready',
        schemaVersion: 89,
      })
      expect(baselineExecutions).toBe(1)
      await expect(migrationHistory(database.url)).resolves
        .toHaveLength(POSTGRESQL_MIGRATION_MANIFEST.migrations.length)
    } finally {
      releaseFirstLock.resolve()
      await restart?.close().catch(() => {})
      await closeAdapters(storages)
      await database.close().catch(() => {})
    }
  }, 30_000)

  it('uses the explicit bounded lock timeout and preserves the raw PostgreSQL timeout SQLSTATE', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const holder = new Client({
      connectionString: database.url,
      ssl: false,
      application_name: 'ownware-storage-migration-test-holder',
    })
    const configuredLockTimeouts: string[] = []
    const rawLockSqlStates: string[] = []
    const driver = instrumentedDriver(async (_client, text, proceed) => {
      if (text.startsWith('SET LOCAL lock_timeout')) configuredLockTimeouts.push(text)
      try {
        return await proceed()
      } catch (error) {
        if (
          text.includes('pg_advisory_xact_lock') &&
          typeof error === 'object' && error !== null && 'code' in error
        ) {
          rawLockSqlStates.push(String((error as { readonly code?: unknown }).code ?? ''))
        }
        throw error
      }
    })
    const blocked = adapter(database.url, {
      driver,
      pool: { lockTimeoutMs: 1_000, migrationTimeoutMs: 5_000 },
    })
    try {
      await holder.connect()
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock($1, $2)', [
        MIGRATION_LOCK_NAMESPACE,
        MIGRATION_LOCK_KEY,
      ])

      const initialization = blocked.initialize()
      await waitForMigrationLocks(database.url, { granted: 0, waiting: 1 })
      await expect(initialization).rejects.toEqual(expect.objectContaining({
        code: 'migration_lock_timeout',
        phase: 'migration',
        retryable: true,
      }))
      expect(configuredLockTimeouts).toEqual(["SET LOCAL lock_timeout = '1000ms'"])
      expect(rawLockSqlStates).toEqual(['55P03'])
      await expect(blocked.health()).resolves.toMatchObject({
        kind: 'postgresql',
        state: 'unavailable',
      })

      await blocked.close()
      await holder.query('ROLLBACK')
      const restart = adapter(database.url)
      try {
        await restart.initialize()
        await expect(restart.health()).resolves.toMatchObject({
          state: 'ready',
          schemaVersion: 89,
        })
      } finally {
        await restart.close().catch(() => {})
      }
    } finally {
      await blocked.close().catch(() => {})
      await holder.query('ROLLBACK').catch(() => {})
      await holder.end().catch(() => {})
      await database.close().catch(() => {})
    }
  }, 20_000)

  it('makes every concurrent initializer refuse an incompatible manifest without rewriting history', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const seed = adapter(database.url)
    const mutator = new Client({ connectionString: database.url, ssl: false })
    const firstLockHeld = deferred()
    const releaseFirstLock = deferred()
    let firstGrantedLockPaused = false
    let baselineExecutions = 0
    const driver = instrumentedDriver(async (_client, text, proceed) => {
      if (text === POSTGRESQL_BASELINE_SQL) baselineExecutions += 1
      if (!text.includes('pg_advisory_xact_lock')) return proceed()

      const result = await proceed()
      if (!firstGrantedLockPaused) {
        firstGrantedLockPaused = true
        firstLockHeld.resolve()
        await releaseFirstLock.promise
      }
      return result
    })
    const contenders = Array.from({ length: 4 }, () => adapter(database.url, {
      driver,
      pool: { lockTimeoutMs: 15_000, migrationTimeoutMs: 20_000 },
    }))
    try {
      await seed.initialize()
      await seed.close()
      await mutator.connect()
      await mutator.query(`
        UPDATE ownware._migrations
        SET name = 'foreign_baseline_v82', fingerprint = $1
        WHERE version = $2
      `, [`sha256:${'f'.repeat(64)}`, POSTGRESQL_BASELINE_VERSION])
      const incompatibleHistory = await migrationHistory(database.url)

      const initializations = contenders.map((storage) => storage.initialize())
      await firstLockHeld.promise
      await waitForMigrationLocks(database.url, { granted: 1, waiting: contenders.length - 1 })
      releaseFirstLock.resolve()
      const settled = await Promise.allSettled(initializations)

      expect(settled).toHaveLength(contenders.length)
      for (const outcome of settled) {
        expect(outcome.status).toBe('rejected')
        if (outcome.status === 'rejected') {
          expect(outcome.reason).toBeInstanceOf(PostgreSqlStorageError)
          expect(outcome.reason).toMatchObject({
            code: 'schema_history_diverged',
            phase: 'migration',
            retryable: false,
          })
        }
      }
      expect(baselineExecutions).toBe(0)
      await expect(migrationHistory(database.url)).resolves.toEqual(incompatibleHistory)
      for (const storage of contenders) {
        await expect(storage.health()).resolves.toMatchObject({
          kind: 'postgresql',
          state: 'unavailable',
          schemaVersion: 0,
        })
      }
    } finally {
      releaseFirstLock.resolve()
      await seed.close().catch(() => {})
      await closeAdapters(contenders)
      await mutator.end().catch(() => {})
      await database.close().catch(() => {})
    }
  }, 30_000)

  it('executes one v90 upgrade for six concurrent initializers and preserves populated state on restart', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const seed = adapter(database.url)
    const inspector = new Client({ connectionString: database.url, ssl: false })
    const firstLockHeld = deferred()
    const releaseFirstLock = deferred()
    let firstGrantedLockPaused = false
    let v90Executions = 0
    const driver = instrumentedDriver(async (_client, text, proceed) => {
      if (text === V90_SQL) v90Executions += 1
      if (!text.includes('pg_advisory_xact_lock')) return proceed()

      const result = await proceed()
      if (!firstGrantedLockPaused) {
        firstGrantedLockPaused = true
        firstLockHeld.resolve()
        await releaseFirstLock.promise
      }
      return result
    })
    const upgraders = Array.from({ length: 6 }, () => adapter(database.url, {
      driver,
      migrationManifest: V90_MANIFEST,
      pool: { lockTimeoutMs: 15_000, migrationTimeoutMs: 20_000 },
    }))
    let restart: PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> | undefined
    try {
      await seed.initialize()
      await inspector.connect()
      await inspector.query(`
        INSERT INTO ownware.threads (id, profile_id, title)
        VALUES ('migration-concurrency-thread', 'migration-concurrency-profile',
          'preserve this populated row')
      `)
      const beforeUpgrade = (await inspector.query(`
        SELECT id, profile_id, title FROM ownware.threads
        WHERE id = 'migration-concurrency-thread'
      `)).rows
      await seed.close()

      const initializations = upgraders.map((storage) => storage.initialize())
      await firstLockHeld.promise
      await waitForMigrationLocks(database.url, { granted: 1, waiting: upgraders.length - 1 })
      releaseFirstLock.resolve()
      await Promise.all(initializations)

      expect(v90Executions).toBe(1)
      for (const storage of upgraders) {
        await expect(storage.health()).resolves.toMatchObject({
          kind: 'postgresql',
          state: 'ready',
          schemaVersion: 90,
        })
      }
      await expect(verifyV90Schema(inspector)).resolves.toBe(true)
      const afterUpgrade = (await inspector.query(`
        SELECT id, profile_id, title, upgrade_marker FROM ownware.threads
        WHERE id = 'migration-concurrency-thread'
      `)).rows
      expect(afterUpgrade).toEqual(beforeUpgrade.map((row) => ({
        ...row,
        upgrade_marker: 'v90',
      })))
      const expectedHistory = [
        ...POSTGRESQL_MIGRATION_MANIFEST.migrations.map(migration => ({
          version: String(migration.version),
          name: migration.name,
          fingerprint: postgreSqlMigrationFingerprint(migration),
        })),
        { version: '90', name: V90_NAME, fingerprint: V90_FINGERPRINT },
      ]
      expect((await migrationReceipts(inspector)).map(({ applied_at: _appliedAt, ...row }) => row))
        .toEqual(expectedHistory)

      const receiptsBeforeRestart = await migrationReceipts(inspector)
      await closeAdapters(upgraders)
      restart = adapter(database.url, { driver, migrationManifest: V90_MANIFEST })
      await restart.initialize()
      await expect(restart.health()).resolves.toMatchObject({ state: 'ready', schemaVersion: 90 })
      expect(v90Executions).toBe(1)
      await expect(migrationReceipts(inspector)).resolves.toEqual(receiptsBeforeRestart)
      expect((await inspector.query(`
        SELECT id, profile_id, title, upgrade_marker FROM ownware.threads
        WHERE id = 'migration-concurrency-thread'
      `)).rows).toEqual(afterUpgrade)
      await expect(verifyV90Schema(inspector)).resolves.toBe(true)
    } finally {
      releaseFirstLock.resolve()
      await seed.close().catch(() => {})
      await restart?.close().catch(() => {})
      await closeAdapters(upgraders)
      await inspector.end().catch(() => {})
      await database.close().catch(() => {})
    }
  }, 30_000)

  it('makes an overlapping older binary unhealthy after a newer manifest commits', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const older = adapter(database.url)
    const newer = adapter(database.url, { migrationManifest: V90_MANIFEST })
    const inspector = new Client({ connectionString: database.url, ssl: false })
    try {
      await older.initialize()
      await expect(older.health()).resolves.toMatchObject({
        state: 'ready',
        schemaVersion: 89,
      })

      // Multi-gateway runtime remains unsupported, but an accidentally
      // overlapping upgrade must not let the old binary keep claiming that its
      // compiled schema head is current.
      await newer.initialize()
      await expect(newer.health()).resolves.toMatchObject({ state: 'ready', schemaVersion: 90 })
      await expect(older.health()).resolves.toMatchObject({
        state: 'unavailable',
        schemaVersion: 0,
        code: 'postgresql_health_failed',
      })

      await inspector.connect()
      expect((await migrationReceipts(inspector)).map(({ applied_at: _appliedAt, ...row }) => row))
        .toEqual([
          ...POSTGRESQL_MIGRATION_MANIFEST.migrations.map(migration => ({
            version: String(migration.version),
            name: migration.name,
            fingerprint: postgreSqlMigrationFingerprint(migration),
          })),
          { version: '90', name: V90_NAME, fingerprint: V90_FINGERPRINT },
        ])
    } finally {
      await older.close().catch(() => {})
      await newer.close().catch(() => {})
      await inspector.end().catch(() => {})
      await database.close().catch(() => {})
    }
  }, 20_000)
})
