import { Client, type Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  PostgreSqlStorageAdapter,
  type PostgreSqlRepositoryFactories,
} from '../../../src/storage/postgresql-adapter.js'
import {
  validateStoragePlan,
  type PostgreSqlPoolOptions,
  type ValidatedPostgreSqlPlan,
} from '../../../src/storage/config.js'
import { PostgreSqlStorageError } from '../../../src/storage/contracts.js'
import { POSTGRESQL_MIGRATION_MANIFEST } from '../../../src/storage/postgresql-migrations.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe

interface EmptyRepositories {}

const EMPTY_FACTORIES: PostgreSqlRepositoryFactories<EmptyRepositories, EmptyRepositories> = {
  createRoot: () => ({}),
  createTransaction: () => ({}),
}

function plan(
  runtimeUrl: string,
  options: {
    readonly migrationUrl?: string
    readonly pool?: PostgreSqlPoolOptions
  } = {},
): ValidatedPostgreSqlPlan {
  const validated = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => runtimeUrl },
      ...(options.migrationUrl === undefined
        ? {}
        : {
            migrationConnection: {
              source: 'provider' as const,
              resolve: () => options.migrationUrl!,
            },
          }),
      tls: { mode: 'disable', allowInsecureLoopback: true },
      ...(options.pool === undefined ? {} : { pool: options.pool }),
    },
  }, '/unused.db')
  if (validated.kind !== 'postgresql') throw new Error('Expected PostgreSQL test plan.')
  return validated
}

function adapter(selected: ValidatedPostgreSqlPlan) {
  return new PostgreSqlStorageAdapter({
    plan: selected,
    repositories: EMPTY_FACTORIES,
  })
}

async function activityCount(adminUrl: string, database: string): Promise<number> {
  const client = new Client({ connectionString: adminUrl, ssl: false })
  try {
    await client.connect()
    const result = await client.query<{ readonly count: string }>(`
      SELECT count(*)::text AS count FROM pg_catalog.pg_stat_activity
      WHERE datname = $1 AND application_name LIKE 'ownware-storage-%'
    `, [database])
    return Number(result.rows[0]?.count ?? '-1')
  } finally {
    await client.end().catch(() => {})
  }
}

describePostgreSql('PostgreSQL storage lifecycle', () => {
  it('initializes one exact current manifest, reports health, closes every client and reopens unchanged', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    let capturedPool: Pool | undefined
    const factories: PostgreSqlRepositoryFactories<EmptyRepositories, EmptyRepositories> = {
      createRoot(context) {
        capturedPool = context.pool
        return {}
      },
      createTransaction: () => ({}),
    }
    try {
      const first = new PostgreSqlStorageAdapter({ plan: plan(database.url), repositories: factories })
      await first.initialize()
      await expect(first.health()).resolves.toEqual(expect.objectContaining({
        kind: 'postgresql',
        state: 'ready',
        schemaVersion: 86,
      }))
      expect(capturedPool).toBeDefined()

      const inspector = new Client({ connectionString: database.url, ssl: false })
      await inspector.connect()
      expect(await POSTGRESQL_MIGRATION_MANIFEST.verifyCurrentSchema(inspector)).toBe(true)
      const history = await inspector.query(`
        SELECT version::text, name, fingerprint FROM ownware._migrations ORDER BY version
      `)
      expect(history.rows).toHaveLength(POSTGRESQL_MIGRATION_MANIFEST.migrations.length)
      const before = await inspector.query<{ readonly count: string }>(`
        SELECT count(*)::text AS count FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'ownware'
      `)
      await inspector.end()

      await first.close()
      expect(capturedPool?.totalCount).toBe(0)
      expect(await activityCount(database.adminUrl, database.name)).toBe(0)

      const reopened = adapter(plan(database.url))
      await reopened.initialize()
      const secondInspector = new Client({ connectionString: database.url, ssl: false })
      await secondInspector.connect()
      const after = await secondInspector.query<{ readonly count: string }>(`
        SELECT count(*)::text AS count FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'ownware'
      `)
      await secondInspector.end()
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count)
      await reopened.close()
      expect(await activityCount(database.adminUrl, database.name)).toBe(0)
    } finally {
      await database.close()
    }
  })

  it('uses the advisory lock and leaves a failed contender reusable after lock release', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const holder = new Client({ connectionString: database.url, ssl: false })
    try {
      await holder.connect()
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock($1, $2)', [1_335_664_962, 0])

      const blocked = adapter(plan(database.url, {
        pool: { lockTimeoutMs: 100, migrationTimeoutMs: 2_000 },
      }))
      let caught: unknown
      try {
        await blocked.initialize()
      } catch (error) {
        caught = error
      }
      expect(caught).toEqual(expect.objectContaining({
        code: 'migration_lock_timeout',
        retryable: true,
      }))
      await blocked.close()
      await holder.query('ROLLBACK')

      const retry = adapter(plan(database.url))
      await retry.initialize()
      await retry.close()
      expect(await activityCount(database.adminUrl, database.name)).toBe(0)
    } finally {
      await holder.end().catch(() => {})
      await database.close()
    }
  })

  it('refuses an unrecognized fixed schema instead of adopting or overwriting it', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const client = new Client({ connectionString: database.url, ssl: false })
    try {
      await client.connect()
      await client.query('CREATE SCHEMA ownware AUTHORIZATION CURRENT_USER')
      await client.query('CREATE TABLE ownware.unrelated_customer_table (id bigint PRIMARY KEY)')

      const storage = adapter(plan(database.url))
      await expect(storage.initialize()).rejects.toEqual(expect.objectContaining({
        code: 'schema_unrecognized',
      }))
      await storage.close()
      const preserved = await client.query<{ readonly exists: string | null }>(
        `SELECT to_regclass('ownware.unrelated_customer_table')::text AS exists`,
      )
      expect(preserved.rows[0]?.exists).toBe('ownware.unrelated_customer_table')
    } finally {
      await client.end().catch(() => {})
      await database.close()
    }
  })

  it('enforces logical value bounds and append-only effects at the database boundary', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const storage = adapter(plan(database.url))
    const client = new Client({ connectionString: database.url, ssl: false })
    try {
      await storage.initialize()
      await client.connect()
      await expect(client.query(`
        INSERT INTO ownware.threads (id, profile_id, total_tokens)
        VALUES ('thread-invalid-integer', 'profile', 9007199254740992)
      `)).rejects.toEqual(expect.objectContaining({ code: '23514' }))
      await expect(client.query(`
        INSERT INTO ownware.threads (id, profile_id, created_at, updated_at)
        VALUES ('thread-invalid-instant', 'profile', '2026-02-30T00:00:00.000Z',
          '2026-08-02T00:00:00.000Z')
      `)).rejects.toEqual(expect.objectContaining({ code: '23514' }))

      await client.query(`
        INSERT INTO ownware.channel_receipts (
          receipt_id, profile_id, title, body_json, kind, created_at
        ) VALUES (
          '00000000-0000-4000-8000-000000000001', 'profile', 'receipt', '{}',
          'delivered', 1
        )
      `)
      await expect(client.query(`
        UPDATE ownware.channel_receipts SET title = 'changed'
        WHERE receipt_id = '00000000-0000-4000-8000-000000000001'
      `)).rejects.toEqual(expect.objectContaining({ code: '23000' }))
      await expect(client.query(`
        DELETE FROM ownware.channel_receipts
        WHERE receipt_id = '00000000-0000-4000-8000-000000000001'
      `)).rejects.toEqual(expect.objectContaining({ code: '23000' }))
    } finally {
      await client.end().catch(() => {})
      await storage.close().catch(() => {})
      await database.close()
    }
  })

  it('supports separate migration/runtime roles without granting runtime DDL or history mutation', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    let storage: PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> | undefined
    let runtimeClient: Client | undefined
    try {
      const migration = await database.createRole('migration')
      const runtime = await database.createRole('runtime')
      await database.transferOwnershipTo(migration.name)
      storage = adapter(plan(runtime.url, { migrationUrl: migration.url }))
      await storage.initialize()

      runtimeClient = new Client({ connectionString: runtime.url, ssl: false })
      await runtimeClient.connect()
      await expect(runtimeClient.query('CREATE TABLE ownware.forbidden_ddl (id bigint)'))
        .rejects.toEqual(expect.objectContaining({ code: '42501' }))
      await expect(runtimeClient.query(`
        UPDATE ownware._migrations SET name = 'tampered' WHERE version = 82
      `)).rejects.toEqual(expect.objectContaining({ code: '42501' }))
      await expect(runtimeClient.query('SELECT version FROM ownware._migrations'))
        .resolves.toEqual(expect.objectContaining({
          rowCount: POSTGRESQL_MIGRATION_MANIFEST.migrations.length,
        }))
      await runtimeClient.end()
      runtimeClient = undefined

      await storage.close()
      storage = undefined
      expect(await activityCount(database.adminUrl, database.name)).toBe(0)
    } finally {
      await runtimeClient?.end().catch(() => {})
      await storage?.close().catch(() => {})
      await database.close()
    }
  })

  it('fails an underprivileged migration role before creating any schema object', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    try {
      const migration = await database.createRole('migration')
      const storage = adapter(plan(migration.url))
      let caught: unknown
      try {
        await storage.initialize()
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(PostgreSqlStorageError)
      expect(caught).toEqual(expect.objectContaining({ code: 'migration_permission_denied' }))
      expect(JSON.stringify(caught)).not.toContain(new URL(migration.url).password)
      await storage.close()

      const inspector = new Client({ connectionString: database.url, ssl: false })
      await inspector.connect()
      const schema = await inspector.query<{ readonly exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'ownware'
        ) AS exists
      `)
      expect(schema.rows[0]?.exists).toBe(false)
      await inspector.end()
    } finally {
      await database.close()
    }
  })

  it('discards connection secrets from driver failures', async () => {
    const secret = 'secret-canary-sto09'
    const invalid = new URL(TEST_URL!)
    invalid.password = secret
    invalid.port = '1'
    const storage = adapter(plan(invalid.toString(), {
      pool: { connectionTimeoutMs: 100 },
    }))
    let caught: unknown
    try {
      await storage.initialize()
    } catch (error) {
      caught = error
    }
    expect(caught).toEqual(expect.objectContaining({ code: 'connection_failed' }))
    expect(String(caught)).not.toContain(secret)
    expect(JSON.stringify(caught)).not.toContain(secret)
    await storage.close()
  })
})
