import {
  PostgreSqlStorageAdapter,
  type PostgreSqlRepositoryFactories,
} from '../../src/storage/postgresql-adapter.js'
import { POSTGRESQL_BASELINE_VERSION } from '../../src/storage/postgresql-baseline.js'
import { validateStoragePlan } from '../../src/storage/config.js'
import {
  POSTGRESQL_MIGRATION_MANIFEST,
  type PostgreSqlMigration,
  type PostgreSqlMigrationManifest,
} from '../../src/storage/postgresql-migrations.js'
import { postgreSqlBaselineMatches } from '../../src/storage/postgresql-schema.js'

const url = process.env.OWNWARE_TEST_CHILD_POSTGRES_URL
if (url === undefined || url.trim() === '') process.exit(2)

const SQL = `
  ALTER TABLE ownware.workspaces
  ADD COLUMN sto12_process_crash_marker TEXT NOT NULL DEFAULT 'process-v83';
  SELECT pg_sleep(2)
`.trim()

const verify: PostgreSqlMigration['verifyApplied'] = async (client) => {
  const result = await client.query<{ readonly present: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'ownware' AND table_name = 'workspaces'
        AND column_name = 'sto12_process_crash_marker'
    ) AS present
  `)
  return result.rows[0]?.present === true
}

const migration: PostgreSqlMigration = {
  version: POSTGRESQL_BASELINE_VERSION + 1,
  name: 'sto12_process_crash_marker',
  sql: SQL,
  verifyApplied: verify,
}

const baselineOnlyManifest: PostgreSqlMigrationManifest = {
  migrations: [POSTGRESQL_MIGRATION_MANIFEST.migrations[0]!],
  logicalMigrations: [],
  verifyCurrentSchema: postgreSqlBaselineMatches,
}

const manifest: PostgreSqlMigrationManifest = {
  migrations: [...baselineOnlyManifest.migrations, migration],
  logicalMigrations: [{ version: migration.version, name: migration.name }],
  verifyCurrentSchema: verify,
}

const selected = validateStoragePlan({
  storage: {
    kind: 'postgresql',
    runtimeConnection: { source: 'provider', resolve: () => url },
    tls: { mode: 'disable', allowInsecureLoopback: true },
    pool: { migrationTimeoutMs: 60_000, lockTimeoutMs: 5_000 },
  },
}, '/unused.db')
if (selected.kind !== 'postgresql') process.exit(2)

const repositories: PostgreSqlRepositoryFactories<object, object> = {
  createRoot: () => ({}),
  createTransaction: () => ({}),
}

const storage = new PostgreSqlStorageAdapter({
  plan: selected,
  repositories,
  migrationManifest: manifest,
})

try {
  await storage.initialize()
  await storage.close()
  process.exitCode = 3
} catch {
  await storage.close().catch(() => {})
  process.exitCode = 1
}
