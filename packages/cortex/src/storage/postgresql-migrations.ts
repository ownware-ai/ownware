import { createHash } from 'node:crypto'
import {
  STORAGE_ADAPTER_BASELINE_VERSION,
  STORAGE_LOGICAL_MIGRATIONS,
  assertStorageMigrationAlignment,
  type StorageMigrationIdentity,
} from './migration-manifest.js'
import {
  POSTGRESQL_BASELINE_DDL_HASH,
  POSTGRESQL_BASELINE_MANIFEST,
  POSTGRESQL_BASELINE_NAME,
  POSTGRESQL_BASELINE_SQL,
  POSTGRESQL_BASELINE_SUMMARY,
  POSTGRESQL_BASELINE_VERSION,
} from './postgresql-baseline.js'
import { PostgreSqlStorageError } from './contracts.js'
import type { PostgreSqlClient, PostgreSqlPoolClient } from './postgresql-driver.js'
import {
  postgreSqlBaselineMatches,
  postgreSqlSchemaMatches,
  type PostgreSqlSchemaExpectation,
} from './postgresql-schema.js'

type QueryClient = Pick<PostgreSqlClient | PostgreSqlPoolClient, 'query'>

export interface PostgreSqlMigration {
  readonly version: number
  readonly name: string
  readonly sql: string
  /** Authoritative effect check run immediately after this migration's SQL. */
  readonly verifyApplied: (client: QueryClient) => Promise<boolean>
}

export interface PostgreSqlMigrationManifest {
  readonly migrations: readonly PostgreSqlMigration[]
  readonly logicalMigrations: readonly StorageMigrationIdentity[]
  /** Exact current-schema certification, including every applied migration. */
  readonly verifyCurrentSchema: (client: QueryClient) => Promise<boolean>
}

export interface PostgreSqlMigrationHistoryRow {
  readonly version: string
  readonly name: string
  readonly fingerprint: string | null
}

const BASELINE_MIGRATION: PostgreSqlMigration = Object.freeze({
  version: POSTGRESQL_BASELINE_VERSION,
  name: POSTGRESQL_BASELINE_NAME,
  sql: POSTGRESQL_BASELINE_SQL,
  verifyApplied: postgreSqlBaselineMatches,
})

const MESSAGE_SEQUENCE_SQL = `
ALTER TABLE ownware.messages ADD COLUMN message_seq BIGINT;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY thread_id
      ORDER BY created_at ASC, id ASC
    ) AS message_seq
  FROM ownware.messages
)
UPDATE ownware.messages AS message
SET message_seq = ranked.message_seq
FROM ranked
WHERE ranked.id = message.id;

ALTER TABLE ownware.messages ALTER COLUMN message_seq SET NOT NULL;
ALTER TABLE ownware.messages ADD CONSTRAINT ck_messages_message_seq_positive
  CHECK (message_seq BETWEEN 1 AND 9007199254740991);
CREATE UNIQUE INDEX idx_messages_thread_sequence
  ON ownware.messages(thread_id, message_seq ASC);
`

export const POSTGRESQL_CURRENT_SCHEMA_EXPECTATION: PostgreSqlSchemaExpectation = Object.freeze({
  summary: Object.freeze({
    ...POSTGRESQL_BASELINE_SUMMARY,
    columnCount: POSTGRESQL_BASELINE_SUMMARY.columnCount + 1,
    explicitIndexCount: POSTGRESQL_BASELINE_SUMMARY.explicitIndexCount + 1,
  }),
  manifest: Object.freeze({
    columns: Object.freeze([
      ...POSTGRESQL_BASELINE_MANIFEST.columns,
      {
        table: 'messages',
        name: 'message_seq',
        type: 'BIGINT',
        nullable: false,
        pkPosition: 0,
      },
    ].sort((left, right) => (
      left.table.localeCompare(right.table) || left.name.localeCompare(right.name)
    ))),
    uniqueConstraints: POSTGRESQL_BASELINE_MANIFEST.uniqueConstraints,
    foreignKeys: POSTGRESQL_BASELINE_MANIFEST.foreignKeys,
    explicitIndexes: Object.freeze([
      ...POSTGRESQL_BASELINE_MANIFEST.explicitIndexes,
      {
        table: 'messages',
        name: 'idx_messages_thread_sequence',
        unique: true,
        columns: [
          { name: 'thread_id', descending: false },
          { name: 'message_seq', descending: false },
        ],
        predicate: null,
      },
    ].sort((left, right) => left.name.localeCompare(right.name))),
  }),
})

async function postgreSqlMessageSequenceMatches(client: QueryClient): Promise<boolean> {
  const result = await client.query<{
    readonly constraint_valid: boolean
    readonly constraint_definition: string | null
    readonly data_valid: boolean
  }>(`
    SELECT
      COALESCE((
        SELECT constraint_record.convalidated
        FROM pg_catalog.pg_constraint AS constraint_record
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = constraint_record.connamespace
        WHERE namespace.nspname = 'ownware'
          AND constraint_record.conrelid = 'ownware.messages'::regclass
          AND constraint_record.conname = 'ck_messages_message_seq_positive'
          AND constraint_record.contype = 'c'
      ), FALSE) AS constraint_valid,
      (
        SELECT pg_catalog.pg_get_constraintdef(constraint_record.oid)
        FROM pg_catalog.pg_constraint AS constraint_record
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = constraint_record.connamespace
        WHERE namespace.nspname = 'ownware'
          AND constraint_record.conrelid = 'ownware.messages'::regclass
          AND constraint_record.conname = 'ck_messages_message_seq_positive'
          AND constraint_record.contype = 'c'
      ) AS constraint_definition,
      NOT EXISTS (
        SELECT 1 FROM ownware.messages
        WHERE message_seq NOT BETWEEN 1 AND 9007199254740991
      ) AS data_valid
  `)
  const row = result.rows[0]
  return row?.constraint_valid === true &&
    row.constraint_definition ===
      "CHECK (((message_seq >= 1) AND (message_seq <= '9007199254740991'::bigint)))" &&
    row.data_valid === true
}

async function postgreSqlCurrentSchemaMatches(client: QueryClient): Promise<boolean> {
  return await postgreSqlSchemaMatches(client, POSTGRESQL_CURRENT_SCHEMA_EXPECTATION) &&
    await postgreSqlMessageSequenceMatches(client)
}

const MESSAGE_SEQUENCE_MIGRATION: PostgreSqlMigration = Object.freeze({
  version: 83,
  name: '083_message_sequence',
  sql: MESSAGE_SEQUENCE_SQL,
  verifyApplied: postgreSqlCurrentSchemaMatches,
})

/** Immutable production PostgreSQL dialect manifest. */
export const POSTGRESQL_MIGRATION_MANIFEST: PostgreSqlMigrationManifest = Object.freeze({
  migrations: Object.freeze([BASELINE_MIGRATION, MESSAGE_SEQUENCE_MIGRATION]),
  logicalMigrations: STORAGE_LOGICAL_MIGRATIONS,
  verifyCurrentSchema: postgreSqlCurrentSchemaMatches,
})

/** Fingerprint the exact dialect SQL that the migration client executes. */
export function postgreSqlMigrationFingerprint(migration: PostgreSqlMigration): string {
  return `sha256:${createHash('sha256').update(migration.sql).digest('hex')}`
}

function manifestFailure(): PostgreSqlStorageError {
  return new PostgreSqlStorageError('schema_history_diverged', 'migration', false)
}

/** Validate compiled identity before it can interpret or mutate a database. */
export function validatePostgreSqlMigrationManifest(
  manifest: PostgreSqlMigrationManifest,
): void {
  const migrations = manifest.migrations
  if (!Array.isArray(migrations) || typeof manifest.verifyCurrentSchema !== 'function') {
    throw manifestFailure()
  }
  const baseline = migrations[0]
  if (
    baseline === undefined ||
    baseline.version !== STORAGE_ADAPTER_BASELINE_VERSION ||
    baseline.version !== POSTGRESQL_BASELINE_VERSION ||
    baseline.name !== POSTGRESQL_BASELINE_NAME ||
    baseline.sql !== POSTGRESQL_BASELINE_SQL ||
    postgreSqlMigrationFingerprint(baseline) !== POSTGRESQL_BASELINE_DDL_HASH
  ) {
    throw manifestFailure()
  }

  const names = new Set<string>()
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index]!
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version !== POSTGRESQL_BASELINE_VERSION + index ||
      migration.name.trim().length === 0 ||
      migration.sql.trim().length === 0 ||
      typeof migration.verifyApplied !== 'function' ||
      names.has(migration.name)
    ) {
      throw manifestFailure()
    }
    names.add(migration.name)
  }

  try {
    assertStorageMigrationAlignment(
      manifest.logicalMigrations,
      manifest.logicalMigrations,
      migrations.slice(1),
    )
  } catch {
    throw manifestFailure()
  }
}

/**
 * Validate the exact applied prefix and return the first pending manifest row.
 * A clean contiguous next version beyond this binary is distinguished from a
 * malformed/gapped history so operators receive an honest newer-schema signal.
 */
export function validatePostgreSqlMigrationHistory(
  rows: readonly PostgreSqlMigrationHistoryRow[],
  manifest: PostgreSqlMigrationManifest,
): number {
  validatePostgreSqlMigrationManifest(manifest)
  if (rows.length === 0) throw manifestFailure()

  const comparable = Math.min(rows.length, manifest.migrations.length)
  for (let index = 0; index < comparable; index += 1) {
    const row = rows[index]!
    const expected = manifest.migrations[index]!
    if (
      row.version !== String(expected.version) ||
      row.name !== expected.name ||
      row.fingerprint !== postgreSqlMigrationFingerprint(expected)
    ) {
      throw manifestFailure()
    }
  }

  if (rows.length > manifest.migrations.length) {
    const firstUnknown = rows[manifest.migrations.length]!
    const targetVersion = manifest.migrations.at(-1)!.version
    if (
      firstUnknown.version === String(targetVersion + 1) &&
      firstUnknown.name.trim().length > 0 &&
      /^sha256:[0-9a-f]{64}$/.test(firstUnknown.fingerprint ?? '')
    ) {
      throw new PostgreSqlStorageError('schema_version_newer', 'migration', false)
    }
    throw manifestFailure()
  }
  return rows.length
}

/**
 * Apply a fresh manifest or the pending suffix of a validated existing prefix.
 * The caller owns the surrounding transaction and migration lock.
 */
export async function applyPostgreSqlMigrationManifest(
  client: QueryClient,
  manifest: PostgreSqlMigrationManifest,
  history: readonly PostgreSqlMigrationHistoryRow[] | null,
): Promise<void> {
  validatePostgreSqlMigrationManifest(manifest)
  const firstPending = history === null
    ? 0
    : validatePostgreSqlMigrationHistory(history, manifest)

  for (let index = firstPending; index < manifest.migrations.length; index += 1) {
    const migration = manifest.migrations[index]!
    await client.query(migration.sql)
    if (!await migration.verifyApplied(client)) {
      throw new PostgreSqlStorageError('schema_manifest_mismatch', 'migration', false)
    }
    await client.query(
      'INSERT INTO ownware._migrations (version, name, fingerprint) VALUES ($1, $2, $3)',
      [migration.version, migration.name, postgreSqlMigrationFingerprint(migration)],
    )
  }

  if (!await manifest.verifyCurrentSchema(client)) {
    throw new PostgreSqlStorageError('schema_manifest_mismatch', 'migration', false)
  }
}
