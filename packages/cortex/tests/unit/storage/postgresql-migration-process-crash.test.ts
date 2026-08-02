import { once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  PostgreSqlStorageAdapter,
  type PostgreSqlRepositoryFactories,
} from '../../../src/storage/postgresql-adapter.js'
import {
  POSTGRESQL_BASELINE_DDL_HASH,
  POSTGRESQL_BASELINE_NAME,
  POSTGRESQL_BASELINE_VERSION,
} from '../../../src/storage/postgresql-baseline.js'
import { validateStoragePlan, type ValidatedPostgreSqlPlan } from '../../../src/storage/config.js'
import {
  POSTGRESQL_MIGRATION_MANIFEST,
  postgreSqlMigrationFingerprint,
  type PostgreSqlMigration,
  type PostgreSqlMigrationManifest,
} from '../../../src/storage/postgresql-migrations.js'
import { postgreSqlBaselineMatches } from '../../../src/storage/postgresql-schema.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe
const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const CHILD_FIXTURE = join(TEST_DIR, '../../fixtures/run-postgresql-sleeping-migration.ts')
const WORKSPACE_ID = 'sto12-process-crash-workspace'
const V83_SQL = `
  ALTER TABLE ownware.workspaces
  ADD COLUMN sto12_process_crash_marker TEXT NOT NULL DEFAULT 'process-v83'
`.trim()

interface EmptyRepositories {}

const EMPTY_FACTORIES: PostgreSqlRepositoryFactories<EmptyRepositories, EmptyRepositories> = {
  createRoot: () => ({}),
  createTransaction: () => ({}),
}

const verifyV83: PostgreSqlMigration['verifyApplied'] = async (client) => {
  const result = await client.query<{
    readonly data_type: string | null
    readonly nullable: string | null
    readonly default_value: string | null
  }>(`
    SELECT
      (SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'ownware' AND table_name = 'workspaces'
          AND column_name = 'sto12_process_crash_marker') AS data_type,
      (SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'ownware' AND table_name = 'workspaces'
          AND column_name = 'sto12_process_crash_marker') AS nullable,
      (SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'ownware' AND table_name = 'workspaces'
          AND column_name = 'sto12_process_crash_marker') AS default_value
  `)
  const row = result.rows[0]
  return row?.data_type === 'text' && row.nullable === 'NO' &&
    row.default_value === "'process-v83'::text"
}

const V83_MIGRATION: PostgreSqlMigration = {
  version: 83,
  name: 'sto12_process_crash_marker',
  sql: V83_SQL,
  verifyApplied: verifyV83,
}

const BASELINE_ONLY_MANIFEST: PostgreSqlMigrationManifest = {
  migrations: [POSTGRESQL_MIGRATION_MANIFEST.migrations[0]!],
  logicalMigrations: [],
  verifyCurrentSchema: postgreSqlBaselineMatches,
}

const V83_MANIFEST: PostgreSqlMigrationManifest = {
  migrations: [...BASELINE_ONLY_MANIFEST.migrations, V83_MIGRATION],
  logicalMigrations: [{ version: 83, name: V83_MIGRATION.name }],
  verifyCurrentSchema: verifyV83,
}

function plan(url: string): ValidatedPostgreSqlPlan {
  const selected = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => url },
      tls: { mode: 'disable', allowInsecureLoopback: true },
      pool: { migrationTimeoutMs: 10_000, lockTimeoutMs: 5_000 },
    },
  }, '/unused.db')
  if (selected.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
  return selected
}

function adapter(
  url: string,
  manifest: PostgreSqlMigrationManifest = BASELINE_ONLY_MANIFEST,
): PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> {
  return new PostgreSqlStorageAdapter({
    plan: plan(url),
    repositories: EMPTY_FACTORIES,
    migrationManifest: manifest,
  })
}

async function waitForSleepingMigration(
  adminUrl: string,
  database: string,
  child: ChildProcess,
): Promise<number> {
  const client = new Client({ connectionString: adminUrl, ssl: false })
  try {
    await client.connect()
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const result = await client.query<{ readonly pid: number }>(`
        SELECT pid FROM pg_catalog.pg_stat_activity
        WHERE datname = $1
          AND application_name = 'ownware-storage-migration'
          AND state = 'active'
          AND query LIKE '%sto12_process_crash_marker%'
          AND query LIKE '%pg_sleep(2)%'
      `, [database])
      const pid = result.rows[0]?.pid
      if (pid !== undefined) return Number(pid)
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Migration crash fixture exited before reaching its transaction barrier.')
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('Migration crash fixture did not reach its transaction barrier.')
  } finally {
    await client.end().catch(() => {})
  }
}

async function waitForSessionExit(adminUrl: string, pid: number): Promise<void> {
  const client = new Client({ connectionString: adminUrl, ssl: false })
  try {
    await client.connect()
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const result = await client.query<{ readonly present: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = $1
        ) AS present
      `, [pid])
      if (result.rows[0]?.present === false) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('Killed migration session remained visible past the recovery bound.')
  } finally {
    await client.end().catch(() => {})
  }
}

describePostgreSql('PostgreSQL migration process-crash recovery', () => {
  it('rolls back a killed migration process, then upgrades and restarts exactly', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const seed = adapter(database.url)
    const inspector = new Client({ connectionString: database.url, ssl: false })
    let child: ChildProcess | undefined
    let recovered: PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> | undefined
    let restarted: PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> | undefined
    try {
      await seed.initialize()
      await seed.close()
      await inspector.connect()
      await inspector.query(`
        INSERT INTO ownware.workspaces (
          id, name, path, status, pinned, last_opened_at, created_at, updated_at
        ) VALUES (
          $1, 'process-crash-preserved', '/tmp/sto12-process-crash',
          'active', FALSE, '2026-08-02T00:00:00.000Z',
          '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
        )
      `, [WORKSPACE_ID])

      child = spawn('bun', [CHILD_FIXTURE], {
        cwd: join(TEST_DIR, '../../..'),
        env: { ...process.env, OWNWARE_TEST_CHILD_POSTGRES_URL: database.url },
        stdio: 'ignore',
      })
      const pid = await waitForSleepingMigration(database.adminUrl, database.name, child)
      expect(child.kill('SIGKILL')).toBe(true)
      await once(child, 'exit')
      await waitForSessionExit(database.adminUrl, pid)

      const rolledBack = await inspector.query<{
        readonly history_count: string
        readonly marker_count: string
        readonly workspace_name: string | null
      }>(`
        SELECT
          (SELECT count(*)::text FROM ownware._migrations) AS history_count,
          (SELECT count(*)::text FROM information_schema.columns
            WHERE table_schema = 'ownware' AND table_name = 'workspaces'
              AND column_name = 'sto12_process_crash_marker') AS marker_count,
          (SELECT name FROM ownware.workspaces WHERE id = $1) AS workspace_name
      `, [WORKSPACE_ID])
      expect(rolledBack.rows[0]).toEqual({
        history_count: '1',
        marker_count: '0',
        workspace_name: 'process-crash-preserved',
      })

      recovered = adapter(database.url, V83_MANIFEST)
      await recovered.initialize()
      await expect(recovered.health()).resolves.toMatchObject({ state: 'ready', schemaVersion: 83 })
      await recovered.close()
      const receipt = await inspector.query(`
        SELECT version::text, name, fingerprint FROM ownware._migrations ORDER BY version
      `)
      expect(receipt.rows).toEqual([
        {
          version: String(POSTGRESQL_BASELINE_VERSION),
          name: POSTGRESQL_BASELINE_NAME,
          fingerprint: POSTGRESQL_BASELINE_DDL_HASH,
        },
        {
          version: '83',
          name: V83_MIGRATION.name,
          fingerprint: postgreSqlMigrationFingerprint(V83_MIGRATION),
        },
      ])
      await expect(verifyV83(inspector)).resolves.toBe(true)

      restarted = adapter(database.url, V83_MANIFEST)
      await restarted.initialize()
      await expect(restarted.health()).resolves.toMatchObject({ state: 'ready', schemaVersion: 83 })
      await restarted.close()
      await expect(inspector.query(`
        SELECT version::text, name, fingerprint FROM ownware._migrations ORDER BY version
      `)).resolves.toEqual(expect.objectContaining({ rows: receipt.rows }))
      expect((await inspector.query(`
        SELECT name, sto12_process_crash_marker AS marker
        FROM ownware.workspaces WHERE id = $1
      `, [WORKSPACE_ID])).rows).toEqual([{
        name: 'process-crash-preserved',
        marker: 'process-v83',
      }])
    } finally {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await once(child, 'exit').catch(() => {})
      }
      await seed.close().catch(() => {})
      await recovered?.close().catch(() => {})
      await restarted?.close().catch(() => {})
      await inspector.end().catch(() => {})
      await database.close().catch(() => {})
    }
  }, 30_000)
})
