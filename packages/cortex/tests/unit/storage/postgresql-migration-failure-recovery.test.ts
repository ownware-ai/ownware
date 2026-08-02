import { createHash } from 'node:crypto'
import {
  Client,
  Pool,
  type ClientConfig,
  type PoolConfig,
} from 'pg'
import { describe, expect, it } from 'vitest'
import {
  PostgreSqlStorageAdapter,
  type PostgreSqlRepositoryFactories,
} from '../../../src/storage/postgresql-adapter.js'
import {
  validateStoragePlan,
  type ValidatedPostgreSqlPlan,
} from '../../../src/storage/config.js'
import { PostgreSqlStorageError } from '../../../src/storage/contracts.js'
import {
  POSTGRESQL_BASELINE_DDL_HASH,
  POSTGRESQL_BASELINE_NAME,
  POSTGRESQL_BASELINE_VERSION,
} from '../../../src/storage/postgresql-baseline.js'
import type { PostgreSqlDriver } from '../../../src/storage/postgresql-driver.js'
import {
  POSTGRESQL_MIGRATION_MANIFEST,
  type PostgreSqlMigration,
  type PostgreSqlMigrationManifest,
} from '../../../src/storage/postgresql-migrations.js'
import {
  inspectPostgreSqlBaseline,
  postgreSqlBaselineMatches,
} from '../../../src/storage/postgresql-schema.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe
const FAILURE_CANARY = 'STO12_MIGRATION_FAILURE_CANARY_3c07e3'
const TERMINATION_CANARY = 'STO12_MIGRATION_TERMINATION_CANARY_5cb22d'
const EXISTING_WORKSPACE_ID = 'sto12-existing-workspace'
const FAULT_WORKSPACE_ID = 'sto12-migration-workspace'
const V83_NAME = 'sto12_upgrade_marker'
const V83_SQL = `
  ALTER TABLE ownware.workspaces
  ADD COLUMN sto12_upgrade_marker TEXT NOT NULL DEFAULT 'v83'
`.trim()
const V83_FINGERPRINT = `sha256:${createHash('sha256').update(V83_SQL).digest('hex')}`
const V84_NAME = 'sto12_materialize_upgrade_effect'
const V84_EFFECT_ID = 'sto12-v84-effect'
const V84_SQL = `
  CREATE TABLE ownware.sto12_v84_upgrade_effects (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES ownware.workspaces(id),
    marker TEXT NOT NULL
  );
  INSERT INTO ownware.sto12_v84_upgrade_effects (id, workspace_id, marker)
  SELECT '${V84_EFFECT_ID}', id, sto12_upgrade_marker
  FROM ownware.workspaces WHERE id = '${EXISTING_WORKSPACE_ID}'
`.trim()
const V84_FINGERPRINT = `sha256:${createHash('sha256').update(V84_SQL).digest('hex')}`

interface EmptyRepositories {}

interface MigrationReceiptSnapshot {
  readonly version: string
  readonly name: string
  readonly fingerprint: string
  readonly applied_at: string
}

interface V84DurableSnapshot {
  readonly history: readonly MigrationReceiptSnapshot[]
  readonly state: {
    readonly existing_rows: string
    readonly existing_name: string | null
    readonly v83_marker: string | null
    readonly effect_rows: string
    readonly effect_workspace_id: string | null
    readonly effect_marker: string | null
    readonly fault_rows: string
    readonly probe_table: string | null
  }
}

const EMPTY_FACTORIES: PostgreSqlRepositoryFactories<
  EmptyRepositories,
  EmptyRepositories
> = {
  createRoot: () => ({}),
  createTransaction: () => ({}),
}

type RawQuery = (...args: unknown[]) => unknown
type MigrationQuery = (text: string, values?: unknown[]) => Promise<unknown>

const verifyV83Schema: PostgreSqlMigration['verifyApplied'] = async (client) => {
  const result = await client.query<{
    readonly data_type: string | null
    readonly nullable: string | null
    readonly default_value: string | null
  }>(`
    SELECT
      (SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'ownware' AND table_name = 'workspaces'
          AND column_name = 'sto12_upgrade_marker') AS data_type,
      (SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'ownware' AND table_name = 'workspaces'
          AND column_name = 'sto12_upgrade_marker') AS nullable,
      (SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'ownware' AND table_name = 'workspaces'
          AND column_name = 'sto12_upgrade_marker') AS default_value
  `)
  const row = result.rows[0]
  return row?.data_type === 'text' && row.nullable === 'NO' &&
    row.default_value === "'v83'::text"
}

const V83_MIGRATION: PostgreSqlMigration = Object.freeze({
  version: POSTGRESQL_BASELINE_VERSION + 1,
  name: V83_NAME,
  sql: V83_SQL,
  verifyApplied: verifyV83Schema,
})

const BASELINE_ONLY_MANIFEST: PostgreSqlMigrationManifest = Object.freeze({
  migrations: Object.freeze([POSTGRESQL_MIGRATION_MANIFEST.migrations[0]!]),
  logicalMigrations: Object.freeze([]),
  verifyCurrentSchema: postgreSqlBaselineMatches,
})

const V83_MANIFEST: PostgreSqlMigrationManifest = Object.freeze({
  migrations: Object.freeze([...BASELINE_ONLY_MANIFEST.migrations, V83_MIGRATION]),
  logicalMigrations: Object.freeze([{
    version: V83_MIGRATION.version,
    name: V83_MIGRATION.name,
  }]),
  verifyCurrentSchema: verifyV83Schema,
})

const verifyV84Schema: PostgreSqlMigration['verifyApplied'] = async (client) => {
  if (!await verifyV83Schema(client)) return false
  const result = await client.query<{
    readonly table_exists: boolean
    readonly effect_rows: string
    readonly workspace_id: string | null
    readonly marker: string | null
  }>(`
    SELECT
      to_regclass('ownware.sto12_v84_upgrade_effects') IS NOT NULL AS table_exists,
      (SELECT count(*)::text FROM ownware.sto12_v84_upgrade_effects
        WHERE id = $1) AS effect_rows,
      (SELECT workspace_id FROM ownware.sto12_v84_upgrade_effects
        WHERE id = $1) AS workspace_id,
      (SELECT marker FROM ownware.sto12_v84_upgrade_effects
        WHERE id = $1) AS marker
  `, [V84_EFFECT_ID])
  const row = result.rows[0]
  return row?.table_exists === true &&
    row.effect_rows === '1' && row.workspace_id === EXISTING_WORKSPACE_ID &&
    row.marker === 'v83'
}

const V84_MIGRATION: PostgreSqlMigration = Object.freeze({
  version: V83_MIGRATION.version + 1,
  name: V84_NAME,
  sql: V84_SQL,
  verifyApplied: verifyV84Schema,
})

const V84_MANIFEST: PostgreSqlMigrationManifest = Object.freeze({
  migrations: Object.freeze([
    ...BASELINE_ONLY_MANIFEST.migrations,
    V83_MIGRATION,
    V84_MIGRATION,
  ]),
  logicalMigrations: Object.freeze([
    { version: V83_MIGRATION.version, name: V83_MIGRATION.name },
    { version: V84_MIGRATION.version, name: V84_MIGRATION.name },
  ]),
  verifyCurrentSchema: verifyV84Schema,
})

function plan(
  runtimeUrl: string,
  migrationUrl?: string,
): ValidatedPostgreSqlPlan {
  const validated = validateStoragePlan({
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
  if (validated.kind !== 'postgresql') throw new Error('Expected PostgreSQL test plan.')
  return validated
}

function adapter(
  selected: ValidatedPostgreSqlPlan,
  driver?: PostgreSqlDriver,
  migrationManifest?: PostgreSqlMigrationManifest,
): PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> {
  return new PostgreSqlStorageAdapter({
    plan: selected,
    repositories: EMPTY_FACTORIES,
    ...(driver === undefined ? {} : { loadDriver: async () => driver }),
    migrationManifest: migrationManifest ?? BASELINE_ONLY_MANIFEST,
  })
}

function migrationInjectionDriver(
  migrationSql: string,
  inject: (query: MigrationQuery) => Promise<void>,
): PostgreSqlDriver {
  class InjectedMigrationClient extends Client {
    constructor(config?: string | ClientConfig) {
      super(config)
      if (
        typeof config !== 'object' || config === null ||
        config.application_name !== 'ownware-storage-migration'
      ) return

      const original = this.query.bind(this) as unknown as RawQuery
      let injected = false
      const query: MigrationQuery = async (text, values) => await Promise.resolve(
        values === undefined ? original(text) : original(text, values),
      )
      this.query = ((...args: unknown[]) => {
        if (!injected && args[0] === migrationSql) {
          injected = true
          return (async () => {
            const result = await Promise.resolve(original(...args))
            await inject(query)
            return result
          })()
        }
        return original(...args)
      }) as typeof this.query
    }
  }

  return { Client: InjectedMigrationClient, Pool }
}

function runtimeConnectBarrierDriver(
  reached: () => void,
  release: Promise<void>,
): PostgreSqlDriver {
  class BarrierPool extends Pool {
    constructor(config?: PoolConfig) {
      super(config)
      const original = this.connect.bind(this) as unknown as RawQuery
      let blocked = false
      this.connect = ((...args: unknown[]) => {
        if (blocked || args.length !== 0) return original(...args)
        blocked = true
        reached()
        return release.then(() => original(...args))
      }) as typeof this.connect
    }
  }

  return { Client, Pool: BarrierPool }
}

function observeExpectedFailure<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {})
  return promise
}

function renderedError(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(error)
  return JSON.stringify(error, Object.getOwnPropertyNames(error)) + String(error)
}

async function inspectAbsent(url: string): Promise<void> {
  const client = new Client({ connectionString: url, ssl: false })
  try {
    await client.connect()
    const result = await client.query<{
      readonly schema_name: string | null
      readonly history_table: string | null
      readonly workspace_table: string | null
      readonly probe_table: string | null
    }>(`
      SELECT
        to_regnamespace('ownware')::text AS schema_name,
        to_regclass('ownware._migrations')::text AS history_table,
        to_regclass('ownware.workspaces')::text AS workspace_table,
        to_regclass('ownware.sto12_migration_probe')::text AS probe_table
    `)
    expect(result.rows[0]).toEqual({
      schema_name: null,
      history_table: null,
      workspace_table: null,
      probe_table: null,
    })
  } finally {
    await client.end().catch(() => {})
  }
}

async function installPopulatedBaseline(url: string): Promise<void> {
  const storage = adapter(plan(url))
  const client = new Client({ connectionString: url, ssl: false })
  try {
    await storage.initialize()
    await storage.close()
    await client.connect()
    await client.query(`
      INSERT INTO ownware.workspaces (
        id, name, path, status, pinned, last_opened_at, created_at, updated_at
      ) VALUES (
        $1, 'existing-before-upgrade', '/tmp/sto12-existing',
        'active', FALSE, '2026-08-02T00:00:00.000Z',
        '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
      )
    `, [EXISTING_WORKSPACE_ID])
  } finally {
    await storage.close().catch(() => {})
    await client.end().catch(() => {})
  }
}

async function inspectRolledBackUpgrade(url: string): Promise<void> {
  const client = new Client({ connectionString: url, ssl: false })
  try {
    await client.connect()
    await expect(inspectPostgreSqlBaseline(client)).resolves.toBe('matches')
    const history = await client.query<{
      readonly version: string
      readonly name: string
      readonly fingerprint: string
    }>(`
      SELECT version::text, name, fingerprint
      FROM ownware._migrations ORDER BY version
    `)
    expect(history.rows).toEqual([{
      version: String(POSTGRESQL_BASELINE_VERSION),
      name: POSTGRESQL_BASELINE_NAME,
      fingerprint: POSTGRESQL_BASELINE_DDL_HASH,
    }])
    const state = await client.query<{
      readonly marker_columns: string
      readonly existing_rows: string
      readonly existing_name: string | null
      readonly fault_rows: string
      readonly probe_table: string | null
      readonly v84_table: string | null
    }>(`
      SELECT
        (SELECT count(*)::text FROM information_schema.columns
          WHERE table_schema = 'ownware' AND table_name = 'workspaces'
            AND column_name = 'sto12_upgrade_marker') AS marker_columns,
        (SELECT count(*)::text FROM ownware.workspaces WHERE id = $1) AS existing_rows,
        (SELECT name FROM ownware.workspaces WHERE id = $1) AS existing_name,
        (SELECT count(*)::text FROM ownware.workspaces WHERE id = $2) AS fault_rows,
        to_regclass('ownware.sto12_migration_probe')::text AS probe_table,
        to_regclass('ownware.sto12_v84_upgrade_effects')::text AS v84_table
    `, [EXISTING_WORKSPACE_ID, FAULT_WORKSPACE_ID])
    expect(state.rows[0]).toEqual({
      marker_columns: '0',
      existing_rows: '1',
      existing_name: 'existing-before-upgrade',
      fault_rows: '0',
      probe_table: null,
      v84_table: null,
    })
  } finally {
    await client.end().catch(() => {})
  }
}

async function inspectRecoveredUpgrade(url: string): Promise<void> {
  const client = new Client({ connectionString: url, ssl: false })
  try {
    await client.connect()
    await expect(verifyV83Schema(client)).resolves.toBe(true)
    const history = await client.query<{
      readonly version: string
      readonly name: string
      readonly fingerprint: string
      readonly applied_at: string
    }>(`
      SELECT version::text, name, fingerprint, applied_at::text
      FROM ownware._migrations ORDER BY version
    `)
    expect(history.rows).toEqual([
      {
        version: String(POSTGRESQL_BASELINE_VERSION),
        name: POSTGRESQL_BASELINE_NAME,
        fingerprint: POSTGRESQL_BASELINE_DDL_HASH,
        applied_at: expect.any(String),
      },
      {
        version: String(V83_MIGRATION.version),
        name: V83_NAME,
        fingerprint: V83_FINGERPRINT,
        applied_at: expect.any(String),
      },
    ])
    const receipts = JSON.stringify(history.rows)
    expect(receipts).not.toContain(FAILURE_CANARY)
    expect(receipts).not.toContain(TERMINATION_CANARY)
    expect(receipts).not.toContain('existing-before-upgrade')
    const state = await client.query<{
      readonly existing_rows: string
      readonly existing_name: string | null
      readonly marker: string | null
      readonly fault_rows: string
      readonly probe_table: string | null
    }>(`
      SELECT
        (SELECT count(*)::text FROM ownware.workspaces WHERE id = $1) AS existing_rows,
        (SELECT name FROM ownware.workspaces WHERE id = $1) AS existing_name,
        (SELECT sto12_upgrade_marker FROM ownware.workspaces WHERE id = $1) AS marker,
        (SELECT count(*)::text FROM ownware.workspaces WHERE id = $2) AS fault_rows,
        to_regclass('ownware.sto12_migration_probe')::text AS probe_table
    `, [EXISTING_WORKSPACE_ID, FAULT_WORKSPACE_ID])
    expect(state.rows[0]).toEqual({
      existing_rows: '1',
      existing_name: 'existing-before-upgrade',
      marker: 'v83',
      fault_rows: '0',
      probe_table: null,
    })
  } finally {
    await client.end().catch(() => {})
  }
}

async function inspectRecoveredV84(url: string): Promise<V84DurableSnapshot> {
  const client = new Client({ connectionString: url, ssl: false })
  try {
    await client.connect()
    await expect(verifyV84Schema(client)).resolves.toBe(true)
    const history = await client.query<MigrationReceiptSnapshot>(`
      SELECT version::text, name, fingerprint, applied_at::text
      FROM ownware._migrations ORDER BY version
    `)
    expect(history.rows).toEqual([
      {
        version: String(POSTGRESQL_BASELINE_VERSION),
        name: POSTGRESQL_BASELINE_NAME,
        fingerprint: POSTGRESQL_BASELINE_DDL_HASH,
        applied_at: expect.any(String),
      },
      {
        version: String(V83_MIGRATION.version),
        name: V83_NAME,
        fingerprint: V83_FINGERPRINT,
        applied_at: expect.any(String),
      },
      {
        version: String(V84_MIGRATION.version),
        name: V84_NAME,
        fingerprint: V84_FINGERPRINT,
        applied_at: expect.any(String),
      },
    ])
    const receipts = JSON.stringify(history.rows)
    expect(receipts).not.toContain(FAILURE_CANARY)
    expect(receipts).not.toContain(TERMINATION_CANARY)
    expect(receipts).not.toContain('existing-before-upgrade')
    const state = await client.query<V84DurableSnapshot['state']>(`
      SELECT
        (SELECT count(*)::text FROM ownware.workspaces WHERE id = $1) AS existing_rows,
        (SELECT name FROM ownware.workspaces WHERE id = $1) AS existing_name,
        (SELECT sto12_upgrade_marker FROM ownware.workspaces WHERE id = $1) AS v83_marker,
        (SELECT count(*)::text FROM ownware.sto12_v84_upgrade_effects) AS effect_rows,
        (SELECT workspace_id FROM ownware.sto12_v84_upgrade_effects
          WHERE id = $2) AS effect_workspace_id,
        (SELECT marker FROM ownware.sto12_v84_upgrade_effects
          WHERE id = $2) AS effect_marker,
        (SELECT count(*)::text FROM ownware.workspaces WHERE id = $3) AS fault_rows,
        to_regclass('ownware.sto12_migration_probe')::text AS probe_table
    `, [EXISTING_WORKSPACE_ID, V84_EFFECT_ID, FAULT_WORKSPACE_ID])
    expect(state.rows[0]).toEqual({
      existing_rows: '1',
      existing_name: 'existing-before-upgrade',
      v83_marker: 'v83',
      effect_rows: '1',
      effect_workspace_id: EXISTING_WORKSPACE_ID,
      effect_marker: 'v83',
      fault_rows: '0',
      probe_table: null,
    })
    return { history: history.rows, state: state.rows[0]! }
  } finally {
    await client.end().catch(() => {})
  }
}

async function inspectRecoveredBaseline(url: string): Promise<void> {
  const client = new Client({ connectionString: url, ssl: false })
  try {
    await client.connect()
    await expect(inspectPostgreSqlBaseline(client)).resolves.toBe('matches')
    const history = await client.query<{
      readonly version: string
      readonly name: string
      readonly fingerprint: string
    }>(`
      SELECT version::text, name, fingerprint
      FROM ownware._migrations ORDER BY version
    `)
    expect(history.rows).toEqual([{
      version: String(POSTGRESQL_BASELINE_VERSION),
      name: POSTGRESQL_BASELINE_NAME,
      fingerprint: POSTGRESQL_BASELINE_DDL_HASH,
    }])
    const application = await client.query<{
      readonly workspaces: string
      readonly probe_table: string | null
    }>(`
      SELECT
        (SELECT count(*)::text FROM ownware.workspaces
          WHERE id = $1) AS workspaces,
        to_regclass('ownware.sto12_migration_probe')::text AS probe_table
    `, [FAULT_WORKSPACE_ID])
    expect(application.rows[0]).toEqual({ workspaces: '0', probe_table: null })
  } finally {
    await client.end().catch(() => {})
  }
}

async function inspectCommittedBaselineWithoutApplicationRows(url: string): Promise<void> {
  const client = new Client({ connectionString: url, ssl: false })
  try {
    await client.connect()
    const result = await client.query<{
      readonly history: string
      readonly workspaces: string
    }>(`
      SELECT
        (SELECT count(*)::text FROM ownware._migrations
          WHERE version = $1 AND name = $2 AND fingerprint = $3) AS history,
        (SELECT count(*)::text FROM ownware.workspaces) AS workspaces
    `, [POSTGRESQL_BASELINE_VERSION, POSTGRESQL_BASELINE_NAME, POSTGRESQL_BASELINE_DDL_HASH])
    expect(result.rows[0]).toEqual({ history: '1', workspaces: '0' })
  } finally {
    await client.end().catch(() => {})
  }
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

describePostgreSql('PostgreSQL migration failure and privilege recovery', () => {
  it('rolls back transactional DDL, DML and history after an injected migration failure', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    let failed: PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> | undefined
    let recovered: PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> | undefined
    try {
      await installPopulatedBaseline(database.url)
      failed = adapter(
        plan(database.url),
        migrationInjectionDriver(V83_SQL, async (query) => {
          await query('CREATE TABLE ownware.sto12_migration_probe (id text PRIMARY KEY)')
          await query("INSERT INTO ownware.sto12_migration_probe VALUES ('must-roll-back')")
          await query(`
            INSERT INTO ownware.workspaces (
              id, name, path, status, pinned, last_opened_at, created_at, updated_at
            ) VALUES (
              $1, 'rollback', '/tmp/sto12-rollback',
              'active', FALSE, '2026-08-02T00:00:00.000Z',
              '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
            )
          `, [FAULT_WORKSPACE_ID])
          await query(`DO $$ BEGIN RAISE EXCEPTION '${FAILURE_CANARY}'; END $$`)
        }),
        V83_MANIFEST,
      )
      const failure = await failed.initialize().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(PostgreSqlStorageError)
      expect(failure).toMatchObject({
        code: 'migration_failed',
        phase: 'migration',
        retryable: false,
      })
      expect(renderedError(failure)).not.toContain(FAILURE_CANARY)
      await failed.close()

      await inspectRolledBackUpgrade(database.url)
      recovered = adapter(plan(database.url), undefined, V83_MANIFEST)
      await recovered.initialize()
      await recovered.close()
      await inspectRecoveredUpgrade(database.url)
    } finally {
      await failed?.close().catch(() => {})
      await recovered?.close().catch(() => {})
      await database.close()
    }
  }, 30_000)

  it('rolls back a terminated in-flight migration and recovers on the next initialization', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    let publishPid!: (pid: number) => void
    const pidReady = new Promise<number>((resolve) => { publishPid = resolve })
    const control = new Client({ connectionString: database.adminUrl, ssl: false })
    let failed: PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> | undefined
    let recovered: PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> | undefined
    try {
      await installPopulatedBaseline(database.url)
      failed = adapter(
        plan(database.url),
        migrationInjectionDriver(V83_SQL, async (query) => {
          await query('CREATE TABLE ownware.sto12_migration_probe (id text PRIMARY KEY)')
          await query("INSERT INTO ownware.sto12_migration_probe VALUES ('termination-must-roll-back')")
          await query(`
            INSERT INTO ownware.workspaces (
              id, name, path, status, pinned, last_opened_at, created_at, updated_at
            ) VALUES (
              $1, '${TERMINATION_CANARY}', '/tmp/sto12-termination',
              'active', FALSE, '2026-08-02T00:00:00.000Z',
              '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
            )
          `, [FAULT_WORKSPACE_ID])
          const result = await query('SELECT pg_backend_pid() AS pid') as {
            readonly rows: readonly [{ readonly pid: number }]
          }
          publishPid(Number(result.rows[0].pid))
          await query('SELECT pg_sleep(30)')
        }),
        V83_MANIFEST,
      )
      await control.connect()
      const initializing = observeExpectedFailure(failed.initialize())
      const pid = await pidReady
      const terminated = await control.query<{ readonly terminated: boolean }>(
        'SELECT pg_terminate_backend($1) AS terminated',
        [pid],
      )
      expect(terminated.rows[0]?.terminated).toBe(true)
      const failure = await initializing.catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(PostgreSqlStorageError)
      expect(failure).toMatchObject({
        code: 'connection_dropped',
        phase: 'migration',
        retryable: true,
      })
      expect(renderedError(failure)).not.toContain(TERMINATION_CANARY)
      await failed.close()

      await inspectRolledBackUpgrade(database.url)
      recovered = adapter(plan(database.url), undefined, V83_MANIFEST)
      await recovered.initialize()
      await recovered.close()
      await inspectRecoveredUpgrade(database.url)
    } finally {
      await control.end().catch(() => {})
      await failed?.close().catch(() => {})
      await recovered?.close().catch(() => {})
      await database.close()
    }
  }, 30_000)

  it('rolls back two pending fixture migrations when the backend terminates during v84', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    let publishInFlight!: (state: {
      readonly pid: number
      readonly history: readonly {
        readonly version: string
        readonly name: string
        readonly fingerprint: string
      }[]
      readonly v83_marker: string | null
      readonly v84_effects: string
      readonly fault_rows: string
    }) => void
    const inFlightReady = new Promise<Parameters<typeof publishInFlight>[0]>((resolve) => {
      publishInFlight = resolve
    })
    const control = new Client({ connectionString: database.adminUrl, ssl: false })
    let migrationPid: number | undefined
    let failed: PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> | undefined
    let recovered: PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> | undefined
    let restarted: PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> | undefined
    try {
      await installPopulatedBaseline(database.url)
      failed = adapter(
        plan(database.url),
        migrationInjectionDriver(V84_SQL, async (query) => {
          await query(`
            INSERT INTO ownware.workspaces (
              id, name, path, status, pinned, last_opened_at, created_at, updated_at
            ) VALUES (
              $1, '${TERMINATION_CANARY}', '/tmp/sto12-v84-termination',
              'active', FALSE, '2026-08-02T00:00:00.000Z',
              '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
            )
          `, [FAULT_WORKSPACE_ID])
          const history = await query(`
            SELECT version::text, name, fingerprint
            FROM ownware._migrations ORDER BY version
          `) as {
            readonly rows: readonly {
              readonly version: string
              readonly name: string
              readonly fingerprint: string
            }[]
          }
          const state = await query(`
            SELECT
              pg_backend_pid() AS pid,
              (SELECT sto12_upgrade_marker FROM ownware.workspaces
                WHERE id = $1) AS v83_marker,
              (SELECT count(*)::text FROM ownware.sto12_v84_upgrade_effects) AS v84_effects,
              (SELECT count(*)::text FROM ownware.workspaces
                WHERE id = $2) AS fault_rows
          `, [EXISTING_WORKSPACE_ID, FAULT_WORKSPACE_ID]) as {
            readonly rows: readonly [{
              readonly pid: number
              readonly v83_marker: string | null
              readonly v84_effects: string
              readonly fault_rows: string
            }]
          }
          publishInFlight({
            pid: Number(state.rows[0].pid),
            history: history.rows,
            v83_marker: state.rows[0].v83_marker,
            v84_effects: state.rows[0].v84_effects,
            fault_rows: state.rows[0].fault_rows,
          })
          await query('SELECT pg_sleep(30)')
        }),
        V84_MANIFEST,
      )
      await control.connect()
      const initializing = observeExpectedFailure(failed.initialize())
      const inFlight = await inFlightReady
      migrationPid = inFlight.pid
      expect(inFlight).toEqual({
        pid: expect.any(Number),
        history: [
          {
            version: String(POSTGRESQL_BASELINE_VERSION),
            name: POSTGRESQL_BASELINE_NAME,
            fingerprint: POSTGRESQL_BASELINE_DDL_HASH,
          },
          {
            version: String(V83_MIGRATION.version),
            name: V83_NAME,
            fingerprint: V83_FINGERPRINT,
          },
        ],
        v83_marker: 'v83',
        v84_effects: '1',
        fault_rows: '1',
      })
      const terminated = await control.query<{ readonly terminated: boolean }>(
        'SELECT pg_terminate_backend($1) AS terminated',
        [migrationPid],
      )
      expect(terminated.rows[0]?.terminated).toBe(true)
      const failure = await initializing.catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(PostgreSqlStorageError)
      expect(failure).toMatchObject({
        code: 'connection_dropped',
        phase: 'migration',
        retryable: true,
      })
      const rendered = renderedError(failure)
      expect(rendered).not.toContain(TERMINATION_CANARY)
      expect(rendered).not.toContain(EXISTING_WORKSPACE_ID)
      expect(rendered).not.toContain(V84_EFFECT_ID)
      await failed.close()

      await inspectRolledBackUpgrade(database.url)
      recovered = adapter(plan(database.url), undefined, V84_MANIFEST)
      await recovered.initialize()
      await expect(recovered.health()).resolves.toMatchObject({
        state: 'ready',
        schemaVersion: V84_MIGRATION.version,
      })
      await recovered.close()
      const recoveredSnapshot = await inspectRecoveredV84(database.url)

      restarted = adapter(plan(database.url), undefined, V84_MANIFEST)
      await restarted.initialize()
      await expect(restarted.health()).resolves.toMatchObject({
        state: 'ready',
        schemaVersion: V84_MIGRATION.version,
      })
      await restarted.close()
      await expect(inspectRecoveredV84(database.url)).resolves.toEqual(recoveredSnapshot)
    } finally {
      if (migrationPid !== undefined) {
        await control.query('SELECT pg_terminate_backend($1)', [migrationPid]).catch(() => {})
      }
      await control.end().catch(() => {})
      await failed?.close().catch(() => {})
      await recovered?.close().catch(() => {})
      await restarted?.close().catch(() => {})
      await database.close()
    }
  }, 30_000)

  it('refuses a migration role without schema authority and leaves no partial schema', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    let failed: PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> | undefined
    let recovered: PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> | undefined
    try {
      const migration = await database.createRole('migration')
      failed = adapter(plan(migration.url))
      const failure = await failed.initialize().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(PostgreSqlStorageError)
      expect(failure).toMatchObject({
        code: 'migration_permission_denied',
        phase: 'migration',
        retryable: false,
      })
      expect(renderedError(failure)).not.toContain(new URL(migration.url).password)
      await failed.close()
      await inspectAbsent(database.url)

      recovered = adapter(plan(database.url))
      await recovered.initialize()
      await recovered.close()
      await inspectRecoveredBaseline(database.url)
    } finally {
      await failed?.close().catch(() => {})
      await recovered?.close().catch(() => {})
      await database.close()
    }
  }, 30_000)

  it('refuses a runtime role whose granted privileges disappear before pool preflight', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    let failed: PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> | undefined
    let recovered: PostgreSqlStorageAdapter<EmptyRepositories, EmptyRepositories> | undefined
    let releaseRuntime!: () => void
    const runtimeRelease = new Promise<void>((resolve) => { releaseRuntime = resolve })
    let runtimeReached!: () => void
    const runtimeReady = new Promise<void>((resolve) => { runtimeReached = resolve })
    try {
      const migration = await database.createRole('migration')
      const runtime = await database.createRole('runtime')
      await database.transferOwnershipTo(migration.name)
      failed = adapter(
        plan(runtime.url, migration.url),
        runtimeConnectBarrierDriver(runtimeReached, runtimeRelease),
      )
      const initializing = observeExpectedFailure(failed.initialize())
      await runtimeReady

      const authority = new Client({ connectionString: migration.url, ssl: false })
      try {
        await authority.connect()
        const role = identifier(runtime.name)
        await authority.query(`REVOKE ALL PRIVILEGES ON SCHEMA ownware FROM ${role}`)
        await authority.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ownware FROM ${role}`)
        await authority.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ownware FROM ${role}`)
        await authority.query(`REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA ownware FROM ${role}`)
      } finally {
        await authority.end().catch(() => {})
        releaseRuntime()
      }

      const failure = await initializing.catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(PostgreSqlStorageError)
      expect(failure).toMatchObject({
        code: 'runtime_permission_denied',
        phase: 'runtime',
        retryable: false,
      })
      const receipt = renderedError(failure)
      expect(receipt).not.toContain(new URL(runtime.url).password)
      expect(receipt).not.toContain(new URL(migration.url).password)
      await failed.close()
      await inspectCommittedBaselineWithoutApplicationRows(migration.url)

      recovered = adapter(plan(runtime.url, migration.url))
      await recovered.initialize()
      await recovered.close()
      await inspectRecoveredBaseline(migration.url)
    } finally {
      releaseRuntime()
      await failed?.close().catch(() => {})
      await recovered?.close().catch(() => {})
      await database.close()
    }
  }, 30_000)
})
