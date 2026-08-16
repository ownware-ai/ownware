import { createHash } from 'node:crypto'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  PostgreSqlStorageAdapter,
  type PostgreSqlRepositoryFactories,
} from '../../../src/storage/postgresql-adapter.js'
import {
  POSTGRESQL_BASELINE_VERSION,
} from '../../../src/storage/postgresql-baseline.js'
import { validateStoragePlan, type ValidatedPostgreSqlPlan } from '../../../src/storage/config.js'
import { PostgreSqlStorageError } from '../../../src/storage/contracts.js'
import type { CoreStorageRepositories } from '../../../src/storage/core-repositories.js'
import { STORAGE_LOGICAL_MIGRATIONS } from '../../../src/storage/migration-manifest.js'
import { createPostgreSqlCoreRepositories } from '../../../src/storage/postgresql-core-repositories.js'
import {
  inspectPostgreSqlBaseline,
  postgreSqlBaselineMatches,
} from '../../../src/storage/postgresql-schema.js'
import {
  POSTGRESQL_MIGRATION_MANIFEST,
  type PostgreSqlMigrationManifest,
} from '../../../src/storage/postgresql-migrations.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe
const V92_NAME = 'add_thread_upgrade_marker'
const V92_SQL = `
  ALTER TABLE ownware.threads
  ADD COLUMN upgrade_marker TEXT NOT NULL DEFAULT 'v92'
`.trim()
const V92_FINGERPRINT = `sha256:${createHash('sha256').update(V92_SQL).digest('hex')}`

const V90_MIGRATION = POSTGRESQL_MIGRATION_MANIFEST.migrations.at(-2)!
const V90_ONLY_MANIFEST: PostgreSqlMigrationManifest = Object.freeze({
  migrations: Object.freeze(POSTGRESQL_MIGRATION_MANIFEST.migrations.slice(0, -1)),
  logicalMigrations: Object.freeze(STORAGE_LOGICAL_MIGRATIONS.slice(0, -1)),
  verifyCurrentSchema: V90_MIGRATION.verifyApplied,
})

const BASELINE_ONLY_MANIFEST: PostgreSqlMigrationManifest = Object.freeze({
  migrations: Object.freeze([POSTGRESQL_MIGRATION_MANIFEST.migrations[0]!]),
  logicalMigrations: Object.freeze([]),
  verifyCurrentSchema: postgreSqlBaselineMatches,
})

interface RootRepositories {
  readonly core: CoreStorageRepositories
}

interface MigrationRow {
  readonly version: string
  readonly name: string
  readonly fingerprint: string | null
  readonly applied_at: string
}

const FACTORIES: PostgreSqlRepositoryFactories<RootRepositories, object> = {
  createRoot: (context) => ({ core: createPostgreSqlCoreRepositories(context) }),
  createTransaction: () => ({}),
}

function plan(url: string): ValidatedPostgreSqlPlan {
  const selected = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => url },
      tls: { mode: 'disable', allowInsecureLoopback: true },
      pool: {
        maxConnections: 4,
        migrationTimeoutMs: 5_000,
        lockTimeoutMs: 1_000,
      },
    },
  }, '/unused.db')
  if (selected.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
  return selected
}

async function open(
  url: string,
  migrationManifest: PostgreSqlMigrationManifest = POSTGRESQL_MIGRATION_MANIFEST,
): Promise<PostgreSqlStorageAdapter<RootRepositories, object>> {
  const storage = new PostgreSqlStorageAdapter({
    plan: plan(url),
    repositories: FACTORIES,
    migrationManifest,
  })
  await storage.initialize()
  return storage
}

async function failedOpen(
  url: string,
  migrationManifest: PostgreSqlMigrationManifest = POSTGRESQL_MIGRATION_MANIFEST,
): Promise<PostgreSqlStorageError> {
  const storage = new PostgreSqlStorageAdapter({
    plan: plan(url),
    repositories: FACTORIES,
    migrationManifest,
  })
  try {
    await storage.initialize()
    throw new Error('Expected PostgreSQL migration startup to fail.')
  } catch (error) {
    if (!(error instanceof PostgreSqlStorageError)) throw error
    return error
  } finally {
    await storage.close().catch(() => {})
  }
}

async function history(client: Client): Promise<readonly MigrationRow[]> {
  const result = await client.query<MigrationRow>(`
    SELECT version::text, name, fingerprint, applied_at
    FROM ownware._migrations
    ORDER BY version
  `)
  return result.rows
}

async function durableSnapshot(client: Client, threadId: string): Promise<{
  readonly history: readonly MigrationRow[]
  readonly thread: unknown
  readonly schema: string
}> {
  const thread = await client.query<{ readonly value: unknown }>(`
    SELECT to_jsonb(thread_record) AS value
    FROM ownware.threads AS thread_record
    WHERE id = $1
  `, [threadId])
  return {
    history: await history(client),
    thread: thread.rows[0]?.value,
    schema: await inspectPostgreSqlBaseline(client),
  }
}

type HistoryMutation = (client: Client) => Promise<void>

const HISTORY_DIVERGENCES: ReadonlyArray<{
  readonly label: string
  readonly mutate: HistoryMutation
  readonly expectedCode?: 'schema_history_diverged' | 'schema_version_newer'
}> = [
  {
    label: 'baseline ID',
    mutate: async (client) => {
      await client.query('UPDATE ownware._migrations SET version = 81 WHERE version = 82')
    },
  },
  {
    label: 'baseline name',
    mutate: async (client) => {
      await client.query(
        'UPDATE ownware._migrations SET name = $1 WHERE version = $2',
        ['divergent_baseline_name', POSTGRESQL_BASELINE_VERSION],
      )
    },
  },
  {
    label: 'baseline fingerprint',
    mutate: async (client) => {
      await client.query(
        'UPDATE ownware._migrations SET fingerprint = $1 WHERE version = $2',
        [`sha256:${'9'.repeat(64)}`, POSTGRESQL_BASELINE_VERSION],
      )
    },
  },
  {
    label: 'malformed next receipt',
    mutate: async (client) => {
      await client.query(`
        INSERT INTO ownware._migrations (version, name, fingerprint)
        VALUES (92, '', 'not-a-fingerprint')
      `)
    },
  },
  {
    label: 'gapped receipt',
    mutate: async (client) => {
      await client.query(`
        INSERT INTO ownware._migrations (version, name, fingerprint)
        VALUES (93, 'skipped_v92', $1)
      `, [V92_FINGERPRINT])
    },
  },
  {
    label: 'unknown newer receipt',
    expectedCode: 'schema_version_newer',
    mutate: async (client) => {
      await client.query(`
        INSERT INTO ownware._migrations (version, name, fingerprint)
        VALUES (92, 'unknown_v92', $1)
      `, [V92_FINGERPRINT])
    },
  },
]

describePostgreSql('PostgreSQL migration history and upgrade boundary', () => {
  it('upgrades populated v82 messages to the real v83 order authority and restarts exactly', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const client = new Client({ connectionString: database.url, ssl: false })
    let baseline: PostgreSqlStorageAdapter<RootRepositories, object> | undefined
    let upgraded: PostgreSqlStorageAdapter<RootRepositories, object> | undefined
    try {
      baseline = await open(database.url, BASELINE_ONLY_MANIFEST)
      await baseline.close()
      baseline = undefined
      await client.connect()
      await client.query(`
        INSERT INTO ownware.threads (id, profile_id, title)
        VALUES
          ('message-upgrade-a', 'migration-profile', 'A'),
          ('message-upgrade-b', 'migration-profile', 'B');

        INSERT INTO ownware.messages (
          id, thread_id, role, content, tools, sub_agents, permissions,
          attachments, thinking, usage_input, usage_output, created_at, parts,
          credentials, model, usage_cache_read, usage_cache_creation
        ) VALUES
          (
            'message-z', 'message-upgrade-a', 'assistant', 'rich row',
            '[{"name":"tool"}]', '[{"agentId":"child"}]',
            '[{"requestId":"permission"}]', '[{"name":"file.txt"}]',
            'thought', 11, 7, '2026-08-02T00:00:00.000Z',
            '[{"kind":"text","text":"rich row"}]',
            '[{"credentialId":"opaque"}]', 'provider:model', 5, 3
          ),
          (
            'message-a', 'message-upgrade-a', 'user', 'same timestamp',
            NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            '2026-08-02T00:00:00.000Z', NULL, NULL, NULL, NULL, NULL
          ),
          (
            'message-b2', 'message-upgrade-b', 'assistant', 'later',
            NULL, NULL, NULL, NULL, NULL, 2, 1,
            '2026-08-02T00:00:02.000Z', NULL, NULL, 'provider:other', 0, 0
          ),
          (
            'message-b1', 'message-upgrade-b', 'user', 'earlier',
            NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            '2026-08-02T00:00:01.000Z', NULL, NULL, NULL, NULL, NULL
          );
      `)
      const before = (await client.query(`
        SELECT to_jsonb(message_record) AS value
        FROM ownware.messages AS message_record
        ORDER BY thread_id, created_at, id
      `)).rows

      upgraded = await open(database.url)
      await expect(upgraded.health()).resolves.toMatchObject({ state: 'ready', schemaVersion: 91 })
      const after = (await client.query(`
        SELECT to_jsonb(message_record) - 'message_seq' AS value
        FROM ownware.messages AS message_record
        ORDER BY thread_id, created_at, id
      `)).rows
      expect(after).toEqual(before)
      expect((await client.query(`
        SELECT thread_id, id, message_seq::text
        FROM ownware.messages ORDER BY thread_id, message_seq
      `)).rows).toEqual([
        { thread_id: 'message-upgrade-a', id: 'message-a', message_seq: '1' },
        { thread_id: 'message-upgrade-a', id: 'message-z', message_seq: '2' },
        { thread_id: 'message-upgrade-b', id: 'message-b1', message_seq: '1' },
        { thread_id: 'message-upgrade-b', id: 'message-b2', message_seq: '2' },
      ])
      expect((await history(client)).map(({ applied_at: _appliedAt, ...row }) => row))
        .toEqual(POSTGRESQL_MIGRATION_MANIFEST.migrations.map((migration) => ({
          version: String(migration.version),
          name: migration.name,
          fingerprint: `sha256:${createHash('sha256').update(migration.sql).digest('hex')}`,
        })))
      await expect(POSTGRESQL_MIGRATION_MANIFEST.verifyCurrentSchema(client)).resolves.toBe(true)

      const durableHistory = await history(client)
      await upgraded.close()
      upgraded = await open(database.url)
      await expect(upgraded.health()).resolves.toMatchObject({ state: 'ready', schemaVersion: 91 })
      expect(await history(client)).toEqual(durableHistory)
      await upgraded.close()
      upgraded = undefined

      await expect(failedOpen(database.url, BASELINE_ONLY_MANIFEST)).resolves.toMatchObject({
        code: 'schema_version_newer',
        phase: 'migration',
        retryable: false,
      })
      expect(await history(client)).toEqual(durableHistory)
    } finally {
      await baseline?.close().catch(() => {})
      await upgraded?.close().catch(() => {})
      await client.end().catch(() => {})
      await database.close().catch(() => {})
    }
  }, 20_000)

  it('installs the exact current schema and preserves populated domain state on restart', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const client = new Client({ connectionString: database.url, ssl: false })
    let storage: PostgreSqlStorageAdapter<RootRepositories, object> | undefined
    try {
      storage = await open(database.url)
      await client.connect()
      const thread = await storage.repositories.core.threads.create(
        'migration-history-profile',
        'populated baseline thread',
      )
      expect(await storage.health()).toMatchObject({
        kind: 'postgresql',
        state: 'ready',
        schemaVersion: 91,
      })
      expect(await history(client)).toEqual(POSTGRESQL_MIGRATION_MANIFEST.migrations.map(
        (migration) => ({
          version: String(migration.version),
          name: migration.name,
          fingerprint: `sha256:${createHash('sha256').update(migration.sql).digest('hex')}`,
          applied_at: expect.any(String),
        }),
      ))
      await expect(POSTGRESQL_MIGRATION_MANIFEST.verifyCurrentSchema(client)).resolves.toBe(true)

      await storage.close()
      storage = await open(database.url)
      await expect(storage.repositories.core.threads.get(thread.id)).resolves.toMatchObject({
        id: thread.id,
        profileId: 'migration-history-profile',
        title: 'populated baseline thread',
      })
      await expect(storage.health()).resolves.toMatchObject({
        state: 'ready',
        schemaVersion: 91,
      })
      expect(await history(client)).toHaveLength(POSTGRESQL_MIGRATION_MANIFEST.migrations.length)
    } finally {
      await storage?.close().catch(() => {})
      await client.end().catch(() => {})
      await database.close().catch(() => {})
    }
  })

  it('makes fresh v91 and populated v90→v91 converge, then restarts exactly', async () => {
    const populated = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const fresh = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const populatedClient = new Client({ connectionString: populated.url, ssl: false })
    const freshClient = new Client({ connectionString: fresh.url, ssl: false })
    let populatedStorage: PostgreSqlStorageAdapter<RootRepositories, object> | undefined
    let freshStorage: PostgreSqlStorageAdapter<RootRepositories, object> | undefined
    try {
      populatedStorage = await open(populated.url, V90_ONLY_MANIFEST)
      const thread = await populatedStorage.repositories.core.threads.create(
        'migration-v91-profile',
        'populated upgrade row',
      )
      const before = await populatedStorage.repositories.core.threads.get(thread.id)
      await populatedStorage.close()

      populatedStorage = await open(populated.url)
      await populatedClient.connect()
      expect(await populatedStorage.health()).toMatchObject({ state: 'ready', schemaVersion: 91 })
      await expect(populatedStorage.repositories.core.threads.get(thread.id)).resolves.toEqual(before)

      freshStorage = await open(fresh.url)
      await freshClient.connect()
      expect(await freshStorage.health()).toMatchObject({ state: 'ready', schemaVersion: 91 })
      await expect(POSTGRESQL_MIGRATION_MANIFEST.verifyCurrentSchema(populatedClient))
        .resolves.toBe(true)
      await expect(POSTGRESQL_MIGRATION_MANIFEST.verifyCurrentSchema(freshClient))
        .resolves.toBe(true)
      const expectedHistory = POSTGRESQL_MIGRATION_MANIFEST.migrations.map((migration) => ({
        version: String(migration.version),
        name: migration.name,
        fingerprint: `sha256:${createHash('sha256').update(migration.sql).digest('hex')}`,
      }))
      for (const client of [populatedClient, freshClient]) {
        expect((await history(client)).map(({ version, name, fingerprint }) => ({
          version,
          name,
          fingerprint,
        }))).toEqual(expectedHistory)
      }

      await populatedStorage.close()
      populatedStorage = await open(populated.url)
      await expect(populatedStorage.repositories.core.threads.get(thread.id)).resolves.toEqual(before)
      await expect(populatedStorage.health()).resolves.toMatchObject({
        state: 'ready',
        schemaVersion: 91,
      })
      await populatedStorage.close()
      populatedStorage = undefined

      const beforeOlderBinary = {
        history: await history(populatedClient),
        row: (await populatedClient.query(`
          SELECT id, title FROM ownware.threads WHERE id = $1
        `, [thread.id])).rows,
      }
      await expect(failedOpen(populated.url, V90_ONLY_MANIFEST)).resolves.toMatchObject({
        code: 'schema_version_newer',
        phase: 'migration',
        retryable: false,
      })
      expect(await history(populatedClient)).toEqual(beforeOlderBinary.history)
      expect((await populatedClient.query(`
        SELECT id, title FROM ownware.threads WHERE id = $1
      `, [thread.id])).rows).toEqual(beforeOlderBinary.row)
    } finally {
      await populatedStorage?.close().catch(() => {})
      await freshStorage?.close().catch(() => {})
      await populatedClient.end().catch(() => {})
      await freshClient.end().catch(() => {})
      await populated.close().catch(() => {})
      await fresh.close().catch(() => {})
    }
  }, 20_000)

  it('refuses a coherent pre-applied v92 migration unchanged because no compiled v92 seam exists', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const client = new Client({ connectionString: database.url, ssl: false })
    let storage: PostgreSqlStorageAdapter<RootRepositories, object> | undefined
    try {
      storage = await open(database.url)
      const thread = await storage.repositories.core.threads.create(
        'migration-upgrade-profile',
        'pre-upgrade domain row',
      )
      await storage.close()
      storage = undefined
      await client.connect()
      await client.query('BEGIN')
      await client.query(V92_SQL)
      await client.query(`
        INSERT INTO ownware._migrations (version, name, fingerprint)
        VALUES (92, $1, $2)
      `, [V92_NAME, V92_FINGERPRINT])
      await client.query('COMMIT')
      const before = await client.query<{
        readonly id: string
        readonly title: string | null
        readonly upgrade_marker: string
      }>(`
        SELECT id, title, upgrade_marker FROM ownware.threads WHERE id = $1
      `, [thread.id])
      const beforeHistory = await history(client)

      const failure = await failedOpen(database.url)
      expect(failure).toMatchObject({
        code: 'schema_version_newer',
        phase: 'migration',
        retryable: false,
      })
      expect(await history(client)).toEqual(beforeHistory)
      expect((await client.query(`
        SELECT id, title, upgrade_marker FROM ownware.threads WHERE id = $1
      `, [thread.id])).rows).toEqual(before.rows)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      await storage?.close().catch(() => {})
      await client.end().catch(() => {})
      await database.close().catch(() => {})
    }
  })

  it.each(HISTORY_DIVERGENCES)(
    'refuses divergent $label history before changing schema, history, or domain rows',
    async ({ mutate, expectedCode = 'schema_history_diverged' }) => {
      const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
      const client = new Client({ connectionString: database.url, ssl: false })
      let storage: PostgreSqlStorageAdapter<RootRepositories, object> | undefined
      try {
        storage = await open(database.url)
        const thread = await storage.repositories.core.threads.create(
          'migration-refusal-profile',
          'history refusal canary',
        )
        await storage.close()
        storage = undefined
        await client.connect()
        await mutate(client)
        const before = await durableSnapshot(client, thread.id)

        const failure = await failedOpen(database.url)
        expect(failure).toMatchObject({
          code: expectedCode,
          phase: 'migration',
          retryable: false,
        })
        expect(JSON.stringify(failure)).not.toContain('history refusal canary')
        expect(await durableSnapshot(client, thread.id)).toEqual(before)
      } finally {
        await storage?.close().catch(() => {})
        await client.end().catch(() => {})
        await database.close().catch(() => {})
      }
    },
    15_000,
  )
})
