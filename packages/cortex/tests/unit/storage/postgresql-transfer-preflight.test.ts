import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  PostgreSqlStorageAdapter,
  type PostgreSqlRepositoryFactories,
} from '../../../src/storage/postgresql-adapter.js'
import { validateStoragePlan, type ValidatedPostgreSqlPlan } from '../../../src/storage/config.js'
import {
  lockAndValidateEmptyPostgreSqlTransferTarget,
  PostgreSqlTransferPreflightError,
  preflightPostgreSqlTransferTarget,
} from '../../../src/storage/postgresql-transfer-preflight.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe

const EMPTY_FACTORIES: PostgreSqlRepositoryFactories<object, object> = {
  createRoot: () => ({}),
  createTransaction: () => ({}),
}

function plan(runtimeUrl: string, migrationUrl?: string): ValidatedPostgreSqlPlan {
  const selected = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => runtimeUrl },
      ...(migrationUrl === undefined
        ? {}
        : {
            migrationConnection: {
              source: 'provider' as const,
              resolve: () => migrationUrl,
            },
          }),
      tls: { mode: 'disable', allowInsecureLoopback: true },
    },
  }, '/unused.db')
  if (selected.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
  return selected
}

async function sessions(url: string): Promise<readonly [Client, Client]> {
  const migration = new Client({ connectionString: url, ssl: false })
  const runtime = new Client({ connectionString: url, ssl: false })
  await migration.connect()
  try {
    await runtime.connect()
  } catch (error) {
    await migration.end().catch(() => {})
    throw error
  }
  return [migration, runtime]
}

describePostgreSql('PostgreSQL transfer target preflight', () => {
  it('classifies absent and owned-empty schemas without creating an object', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const [migration, runtime] = await sessions(database.url)
    try {
      await expect(preflightPostgreSqlTransferTarget(migration, runtime)).resolves
        .toMatchObject({
          state: 'schema_absent_initializable',
          runtimeAuthority: 'not-yet-provisioned',
          schemaVersion: 0,
          businessTableCount: 74,
        })
      expect((await migration.query(`
        SELECT count(*)::text AS count FROM pg_catalog.pg_namespace
        WHERE nspname = 'ownware'
      `)).rows[0]).toEqual({ count: '0' })

      await migration.query('CREATE SCHEMA ownware AUTHORIZATION CURRENT_USER')
      await expect(preflightPostgreSqlTransferTarget(migration, runtime)).resolves
        .toMatchObject({
          state: 'schema_empty_owned_initializable',
          runtimeAuthority: 'not-yet-provisioned',
          schemaVersion: 0,
        })
      expect((await migration.query(`
        SELECT count(*)::text AS count FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'ownware'
      `)).rows[0]).toEqual({ count: '0' })
    } finally {
      await Promise.all([migration.end(), runtime.end()])
      await database.close()
    }
  })

  it('certifies an exact current empty target and refuses any business row', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const adapter = new PostgreSqlStorageAdapter({
      plan: plan(database.url),
      repositories: EMPTY_FACTORIES,
    })
    try {
      await adapter.initialize()
      await adapter.close()
      const [migration, runtime] = await sessions(database.url)
      try {
        const before = await migration.query<{ readonly migrations: string; readonly app: string }>(`
          SELECT
            (SELECT count(*)::text FROM ownware._migrations) AS migrations,
            (SELECT count(*)::text FROM ownware.app_state) AS app
        `)
        await expect(preflightPostgreSqlTransferTarget(migration, runtime)).resolves
          .toMatchObject({
            state: 'schema_current_empty_ready',
            runtimeAuthority: 'combined-elevated',
            schemaVersion: 89,
            businessTableCount: 74,
            nonEmptyBusinessTableCount: 0,
          })
        const after = await migration.query<{ readonly migrations: string; readonly app: string }>(`
          SELECT
            (SELECT count(*)::text FROM ownware._migrations) AS migrations,
            (SELECT count(*)::text FROM ownware.app_state) AS app
        `)
        expect(after.rows).toEqual(before.rows)

        await migration.query(`
          INSERT INTO ownware.app_state (key, value, updated_at)
          VALUES ('key-a', 'value-a', '2026-08-02T00:00:00.000Z')
        `)
        await expect(preflightPostgreSqlTransferTarget(migration, runtime)).rejects
          .toMatchObject({ code: 'target_not_empty' })
      } finally {
        await Promise.all([migration.end(), runtime.end()])
      }
    } finally {
      await adapter.close()
      await database.close()
    }
  })

  it('requires an explicit serializable transaction for the target write fence', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const adapter = new PostgreSqlStorageAdapter({
      plan: plan(database.url),
      repositories: EMPTY_FACTORIES,
    })
    try {
      await adapter.initialize()
      await adapter.close()
      const migration = new Client({ connectionString: database.url, ssl: false })
      await migration.connect()
      try {
        await expect(lockAndValidateEmptyPostgreSqlTransferTarget(migration)).rejects
          .toMatchObject({ code: 'inspection_failed' })
        await migration.query('BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED')
        await expect(lockAndValidateEmptyPostgreSqlTransferTarget(migration)).rejects
          .toMatchObject({ code: 'inspection_failed' })
        await migration.query('ROLLBACK')
        await migration.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE READ WRITE')
        await expect(lockAndValidateEmptyPostgreSqlTransferTarget(migration)).resolves
          .toBeUndefined()
        await migration.query('ROLLBACK')
      } finally {
        await migration.end()
      }
    } finally {
      await adapter.close()
      await database.close()
    }
  })

  it('certifies separate migration ownership and least-privilege runtime authority', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const migrationRole = await database.createRole('migration')
    const runtimeRole = await database.createRole('runtime')
    await database.transferOwnershipTo(migrationRole.name)
    const adapter = new PostgreSqlStorageAdapter({
      plan: plan(runtimeRole.url, migrationRole.url),
      repositories: EMPTY_FACTORIES,
    })
    try {
      await adapter.initialize()
      await adapter.close()
      const [migration, runtime] = await sessions(migrationRole.url)
      await runtime.end()
      const runtimeSession = new Client({ connectionString: runtimeRole.url, ssl: false })
      await runtimeSession.connect()
      try {
        await expect(preflightPostgreSqlTransferTarget(migration, runtimeSession)).resolves
          .toMatchObject({
            state: 'schema_current_empty_ready',
            runtimeAuthority: 'separate-least-privilege',
            schemaVersion: 89,
            nonEmptyBusinessTableCount: 0,
          })
      } finally {
        await Promise.all([migration.end(), runtimeSession.end()])
      }
    } finally {
      await adapter.close()
      await database.close()
    }
  })

  it('rejects different live database authorities before inspecting a schema', async () => {
    const first = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const second = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const migration = new Client({ connectionString: first.url, ssl: false })
    const runtime = new Client({ connectionString: second.url, ssl: false })
    await migration.connect()
    await runtime.connect()
    try {
      await expect(preflightPostgreSqlTransferTarget(migration, runtime)).rejects
        .toEqual(expect.objectContaining<Partial<PostgreSqlTransferPreflightError>>({
          code: 'database_identity_mismatch',
        }))
      for (const client of [migration, runtime]) {
        expect((await client.query(`
          SELECT count(*)::text AS count FROM pg_catalog.pg_namespace
          WHERE nspname = 'ownware'
        `)).rows[0]).toEqual({ count: '0' })
      }
    } finally {
      await Promise.all([migration.end(), runtime.end()])
      await first.close()
      await second.close()
    }
  })

  it('rejects unsupported namespace objects without naming or deleting them', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const adapter = new PostgreSqlStorageAdapter({
      plan: plan(database.url),
      repositories: EMPTY_FACTORIES,
    })
    try {
      await adapter.initialize()
      await adapter.close()
      const [migration, runtime] = await sessions(database.url)
      const canary = 'customer_secret_canary'
      try {
        await migration.query(`CREATE VIEW ownware.${canary} AS SELECT 1 AS value`)
        let error: unknown
        try {
          await preflightPostgreSqlTransferTarget(migration, runtime)
        } catch (caught) {
          error = caught
        }
        expect(error).toMatchObject({ code: 'schema_unrecognized' })
        expect(String(error)).not.toContain(canary)
        expect((await migration.query<{ readonly present: boolean }>(`
          SELECT to_regclass('ownware.${canary}') IS NOT NULL AS present
        `)).rows[0]?.present).toBe(true)
      } finally {
        await Promise.all([migration.end(), runtime.end()])
      }
    } finally {
      await adapter.close()
      await database.close()
    }
  })

  it('rejects a count-matching partial-index predicate drift', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const adapter = new PostgreSqlStorageAdapter({
      plan: plan(database.url),
      repositories: EMPTY_FACTORIES,
    })
    try {
      await adapter.initialize()
      await adapter.close()
      const [migration, runtime] = await sessions(database.url)
      try {
        await migration.query('DROP INDEX ownware.idx_source_jobs_source_deletion')
        await migration.query(`
          CREATE UNIQUE INDEX idx_source_jobs_source_deletion
          ON ownware.source_jobs(source_id)
          WHERE operation = 'customer_secret_canary'
        `)
        let error: unknown
        try {
          await preflightPostgreSqlTransferTarget(migration, runtime)
        } catch (caught) {
          error = caught
        }
        expect(error).toMatchObject({ code: 'schema_manifest_mismatch' })
        expect(String(error)).not.toContain('customer_secret_canary')
      } finally {
        await Promise.all([migration.end(), runtime.end()])
      }
    } finally {
      await adapter.close()
      await database.close()
    }
  })

  it('rejects a count-matching non-default index operator class', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const adapter = new PostgreSqlStorageAdapter({
      plan: plan(database.url),
      repositories: EMPTY_FACTORIES,
    })
    try {
      await adapter.initialize()
      await adapter.close()
      const [migration, runtime] = await sessions(database.url)
      try {
        await migration.query('DROP INDEX ownware.idx_threads_status')
        await migration.query(`
          CREATE INDEX idx_threads_status
          ON ownware.threads(status text_pattern_ops, updated_at DESC)
        `)
        await expect(preflightPostgreSqlTransferTarget(migration, runtime)).rejects
          .toMatchObject({ code: 'schema_manifest_mismatch' })
      } finally {
        await Promise.all([migration.end(), runtime.end()])
      }
    } finally {
      await adapter.close()
      await database.close()
    }
  })

  it('rejects count-matching constraint and default semantic drift', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const adapter = new PostgreSqlStorageAdapter({
      plan: plan(database.url),
      repositories: EMPTY_FACTORIES,
    })
    try {
      await adapter.initialize()
      await adapter.close()
      const [migration, runtime] = await sessions(database.url)
      try {
        await migration.query(`
          ALTER TABLE ownware.threads
          DROP CONSTRAINT ck_semantic_threads_2
        `)
        await migration.query(`
          ALTER TABLE ownware.threads
          ADD CONSTRAINT ck_semantic_threads_2
          CHECK (message_count BETWEEN 0 AND 9007199254740991)
        `)
        await migration.query(`
          ALTER TABLE ownware.threads
          ALTER COLUMN status SET DEFAULT 'customer_secret_canary'
        `)
        let error: unknown
        try {
          await preflightPostgreSqlTransferTarget(migration, runtime)
        } catch (caught) {
          error = caught
        }
        expect(error).toMatchObject({ code: 'schema_manifest_mismatch' })
        expect(String(error)).not.toContain('customer_secret_canary')
      } finally {
        await Promise.all([migration.end(), runtime.end()])
      }
    } finally {
      await adapter.close()
      await database.close()
    }
  })

  it('rejects a function-body drift that preserves its signature and owner', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const adapter = new PostgreSqlStorageAdapter({
      plan: plan(database.url),
      repositories: EMPTY_FACTORIES,
    })
    try {
      await adapter.initialize()
      await adapter.close()
      const [migration, runtime] = await sessions(database.url)
      try {
        await migration.query(`
          CREATE OR REPLACE FUNCTION ownware._reject_immutable_mutation()
          RETURNS trigger LANGUAGE plpgsql AS $function$
          BEGIN
            RETURN OLD;
          END
          $function$
        `)
        await expect(preflightPostgreSqlTransferTarget(migration, runtime)).rejects
          .toMatchObject({ code: 'schema_manifest_mismatch' })
      } finally {
        await Promise.all([migration.end(), runtime.end()])
      }
    } finally {
      await adapter.close()
      await database.close()
    }
  })
})
