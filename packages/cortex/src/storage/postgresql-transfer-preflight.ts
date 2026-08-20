import { createHash, randomBytes } from 'node:crypto'
import {
  postgreSqlCatalogMatchesCurrentV91,
} from './postgresql-catalog-certification.js'
import type { PostgreSqlClient, PostgreSqlPoolClient } from './postgresql-driver.js'
import {
  POSTGRESQL_CURRENT_SCHEMA_EXPECTATION,
  POSTGRESQL_MIGRATION_MANIFEST,
  type PostgreSqlMigrationHistoryRow,
  validatePostgreSqlMigrationHistory,
} from './postgresql-migrations.js'

type SessionClient = Pick<PostgreSqlClient | PostgreSqlPoolClient, 'query'>

const TARGET_RECEIPT_FORMAT = 'ownware-postgresql-transfer-target-v1'
/** Compared as an exact `ORDER BY proname` array — this order is load-bearing. */
const EXPECTED_FUNCTIONS = Object.freeze([
  '_enforce_effect_reversal_offer_update',
  '_enforce_egress_evidence_semantics',
  '_enforce_schedule_approval_lifecycle',
  '_is_iso_instant',
  '_reject_activity_ledger_mutation',
  '_reject_effect_evidence_mutation',
  '_reject_effect_reversal_mutation',
  '_reject_egress_evidence_mutation',
  '_reject_immutable_mutation',
  '_reject_permission_binding_mutation',
  '_reject_permission_decision_mutation',
  '_reject_plugin_evidence_mutation',
  '_reject_provider_usage_evidence_mutation',
  '_reject_skill_activation_receipt_mutation',
  '_validate_access_grant_head',
])

export const POSTGRESQL_TRANSFER_BUSINESS_TABLES = Object.freeze([
  ...new Set(POSTGRESQL_CURRENT_SCHEMA_EXPECTATION.manifest.columns.map(column => column.table)),
].filter((table) => table !== '_migrations').sort())

export type PostgreSqlTransferTargetState =
  | 'schema_absent_initializable'
  | 'schema_empty_owned_initializable'
  | 'schema_current_empty_ready'

export type PostgreSqlTransferRuntimeAuthority =
  | 'not-yet-provisioned'
  | 'combined-elevated'
  | 'separate-least-privilege'

export type PostgreSqlTransferPreflightErrorCode =
  | 'database_identity_mismatch'
  | 'migration_permission_denied'
  | 'schema_owner_mismatch'
  | 'schema_unrecognized'
  | 'schema_history_invalid'
  | 'schema_manifest_mismatch'
  | 'managed_object_owner_mismatch'
  | 'runtime_permission_denied'
  | 'target_not_empty'
  | 'inspection_failed'

export type PostgreSqlTransferPreflightReason =
  | 'relation_kinds'
  | 'functions'
  | 'types'
  | 'policies'

/** Content-free PostgreSQL target diagnostic safe for a local receipt. */
export class PostgreSqlTransferPreflightError extends Error {
  override readonly name = 'PostgreSqlTransferPreflightError'

  constructor(
    readonly code: PostgreSqlTransferPreflightErrorCode,
    readonly reason?: PostgreSqlTransferPreflightReason,
  ) {
    super(`PostgreSQL transfer preflight failed (${code}${reason === undefined ? '' : `; ${reason}`}).`)
  }
}

export interface PostgreSqlTransferTargetReceipt {
  readonly state: PostgreSqlTransferTargetState
  readonly runtimeAuthority: PostgreSqlTransferRuntimeAuthority
  readonly databaseIdentityDigest: string
  readonly schemaVersion: number
  readonly businessTableCount: number
  readonly nonEmptyBusinessTableCount: 0
}

interface DatabaseFactsRow {
  readonly database_oid: string
  readonly user_name: string
}

interface SchemaFactsRow {
  readonly owns_schema: boolean
  readonly relation_count: string
  readonly function_count: string
  readonly standalone_type_count: string
  readonly policy_count: string
  readonly migration_table_exists: boolean
}

function fail(
  code: PostgreSqlTransferPreflightErrorCode,
  reason?: PostgreSqlTransferPreflightReason,
): never {
  throw new PostgreSqlTransferPreflightError(code, reason)
}

function safeCount(value: string): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : fail('inspection_failed')
}

async function databaseFacts(client: SessionClient): Promise<DatabaseFactsRow> {
  const result = await client.query<DatabaseFactsRow>(`
    SELECT database_record.oid::text AS database_oid, current_user AS user_name
    FROM pg_catalog.pg_database AS database_record
    WHERE database_record.datname = current_database()
  `)
  return result.rows[0] ?? fail('inspection_failed')
}

async function proveSameDatabase(
  migration: SessionClient,
  runtime: SessionClient,
): Promise<{
  readonly migration: DatabaseFactsRow
  readonly runtime: DatabaseFactsRow
  readonly identityDigest: string
}> {
  const [migrationFacts, runtimeFacts] = await Promise.all([
    databaseFacts(migration),
    databaseFacts(runtime),
  ])
  if (migrationFacts.database_oid !== runtimeFacts.database_oid) {
    return fail('database_identity_mismatch')
  }

  const first = randomBytes(4).readInt32BE(0)
  const second = randomBytes(4).readInt32BE(0)
  let migrationLocked = false
  let runtimeLocked = false
  try {
    const acquired = await migration.query<{ readonly acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [first, second],
    )
    migrationLocked = acquired.rows[0]?.acquired === true
    if (!migrationLocked) return fail('database_identity_mismatch')
    const blocked = await runtime.query<{ readonly acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [first, second],
    )
    if (blocked.rows[0]?.acquired !== false) {
      runtimeLocked = blocked.rows[0]?.acquired === true
      return fail('database_identity_mismatch')
    }
    await migration.query('SELECT pg_advisory_unlock($1, $2)', [first, second])
    migrationLocked = false
    const acquiredAfterRelease = await runtime.query<{ readonly acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [first, second],
    )
    runtimeLocked = acquiredAfterRelease.rows[0]?.acquired === true
    if (!runtimeLocked) return fail('database_identity_mismatch')
  } finally {
    if (migrationLocked) {
      await migration.query('SELECT pg_advisory_unlock($1, $2)', [first, second])
        .catch(() => {})
    }
    if (runtimeLocked) {
      await runtime.query('SELECT pg_advisory_unlock($1, $2)', [first, second])
        .catch(() => {})
    }
  }

  return {
    migration: migrationFacts,
    runtime: runtimeFacts,
    identityDigest: `sha256:${createHash('sha256')
      .update(JSON.stringify([TARGET_RECEIPT_FORMAT, migrationFacts.database_oid]))
      .digest('hex')}`,
  }
}

async function schemaFacts(client: SessionClient): Promise<SchemaFactsRow | undefined> {
  const result = await client.query<SchemaFactsRow>(`
    SELECT
      pg_catalog.pg_get_userbyid(namespace.nspowner) = current_user AS owns_schema,
      (SELECT count(*)::text FROM pg_catalog.pg_class AS relation
        WHERE relation.relnamespace = namespace.oid) AS relation_count,
      (SELECT count(*)::text FROM pg_catalog.pg_proc AS procedure
        WHERE procedure.pronamespace = namespace.oid) AS function_count,
      (SELECT count(*)::text FROM pg_catalog.pg_type AS type_record
        WHERE type_record.typnamespace = namespace.oid
          AND type_record.typrelid = 0 AND type_record.typelem = 0) AS standalone_type_count,
      (SELECT count(*)::text FROM pg_catalog.pg_policy AS policy
        JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
        WHERE relation.relnamespace = namespace.oid) AS policy_count,
      pg_catalog.to_regclass('ownware._migrations') IS NOT NULL AS migration_table_exists
    FROM pg_catalog.pg_namespace AS namespace
    WHERE namespace.nspname = 'ownware'
  `)
  return result.rows[0]
}

async function canCreateSchema(client: SessionClient): Promise<boolean> {
  const result = await client.query<{ readonly allowed: boolean }>(`
    SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS allowed
  `)
  return result.rows[0]?.allowed === true
}

async function exactNamespaceAndOwnership(client: SessionClient): Promise<boolean> {
  const result = await client.query<{
    readonly supported_relation_kinds: boolean
    readonly functions_exact: boolean
    readonly no_standalone_types: boolean
    readonly no_policies_or_rls: boolean
    readonly all_objects_owned: boolean
  }>(`
    SELECT
      NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'ownware' AND relation.relkind NOT IN ('r', 'i', 'S')
      ) AND (
        SELECT count(*) FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'ownware' AND relation.relkind = 'S'
      ) = 1 AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_class AS relation
        WHERE relation.oid = pg_catalog.pg_get_serial_sequence(
          'ownware._migrations', 'version'
        )::regclass AND relation.relkind = 'S'
      ) AS supported_relation_kinds,
      ARRAY(
        SELECT procedure.proname::text FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'ownware' ORDER BY procedure.proname
      ) = $1::text[] AS functions_exact,
      NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_type AS type_record
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_record.typnamespace
        WHERE namespace.nspname = 'ownware'
          AND type_record.typrelid = 0 AND type_record.typelem = 0
      ) AS no_standalone_types,
      NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'ownware'
          AND (relation.relrowsecurity OR relation.relforcerowsecurity)
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy AS policy
        JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'ownware'
      ) AS no_policies_or_rls,
      NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'ownware' AND relation.relowner <> current_user::regrole
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'ownware' AND procedure.proowner <> current_user::regrole
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_type AS type_record
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_record.typnamespace
        WHERE namespace.nspname = 'ownware' AND type_record.typowner <> current_user::regrole
      ) AS all_objects_owned
  `, [EXPECTED_FUNCTIONS])
  const row = result.rows[0]
  if (row === undefined) return false
  if (!row.all_objects_owned) return fail('managed_object_owner_mismatch')
  if (!row.supported_relation_kinds) return fail('schema_unrecognized', 'relation_kinds')
  if (!row.functions_exact) return fail('schema_unrecognized', 'functions')
  if (!row.no_standalone_types) return fail('schema_unrecognized', 'types')
  if (!row.no_policies_or_rls) return fail('schema_unrecognized', 'policies')
  return true
}

async function runtimeAuthority(
  client: SessionClient,
  combined: boolean,
): Promise<PostgreSqlTransferRuntimeAuthority> {
  const result = await client.query<{
    readonly schema_usage: boolean
    readonly schema_create: boolean
    readonly tables_allowed: boolean
    readonly migration_writes_denied: boolean
    readonly sequences_allowed: boolean
    readonly functions_allowed: boolean
  }>(`
    SELECT
      has_schema_privilege(current_user, 'ownware', 'USAGE') AS schema_usage,
      has_schema_privilege(current_user, 'ownware', 'CREATE') AS schema_create,
      NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'ownware' AND relation.relkind = 'r'
          AND NOT (
            has_table_privilege(current_user, relation.oid, 'SELECT') AND
            (relation.relname = '_migrations' OR (
              has_table_privilege(current_user, relation.oid, 'INSERT') AND
              has_table_privilege(current_user, relation.oid, 'UPDATE') AND
              has_table_privilege(current_user, relation.oid, 'DELETE')
            ))
          )
      ) AS tables_allowed,
      NOT (
        has_table_privilege(current_user, 'ownware._migrations', 'INSERT') OR
        has_table_privilege(current_user, 'ownware._migrations', 'UPDATE') OR
        has_table_privilege(current_user, 'ownware._migrations', 'DELETE')
      ) AS migration_writes_denied,
      NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'ownware' AND relation.relkind = 'S'
          AND NOT has_sequence_privilege(current_user, relation.oid, 'USAGE')
      ) AS sequences_allowed,
      NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'ownware'
          AND NOT has_function_privilege(current_user, procedure.oid, 'EXECUTE')
      ) AS functions_allowed
  `)
  const row = result.rows[0]
  if (
    row === undefined || !row.schema_usage || !row.tables_allowed ||
    !row.sequences_allowed || !row.functions_allowed
  ) {
    return fail('runtime_permission_denied')
  }
  if (combined) return 'combined-elevated'
  if (row.schema_create || !row.migration_writes_denied) {
    return fail('runtime_permission_denied')
  }
  return 'separate-least-privilege'
}

async function assertBusinessTablesEmpty(client: SessionClient): Promise<void> {
  const projections = POSTGRESQL_TRANSFER_BUSINESS_TABLES.map((table, index) => (
    `EXISTS (SELECT 1 FROM ownware.${quoteIdentifier(table)} LIMIT 1) AS ${quoteIdentifier(`table_${index}`)}`
  ))
  const result = await client.query<Record<string, boolean>>(
    `SELECT ${projections.join(', ')}`,
  )
  const row = result.rows[0]
  if (
    row === undefined ||
    POSTGRESQL_TRANSFER_BUSINESS_TABLES.some((_, index) => row[`table_${index}`] !== false)
  ) {
    return fail('target_not_empty')
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * Read-only target classification. It does not initialize, migrate, grant,
 * delete, truncate or otherwise authorize a later transfer write. STO-14 must
 * repeat these checks while holding its transfer transaction and locks.
 */
export async function preflightPostgreSqlTransferTarget(
  migration: SessionClient,
  runtime: SessionClient,
): Promise<PostgreSqlTransferTargetReceipt> {
  try {
    const identity = await proveSameDatabase(migration, runtime)
    const schema = await schemaFacts(migration)
    if (schema === undefined) {
      if (!await canCreateSchema(migration)) return fail('migration_permission_denied')
      return Object.freeze({
        state: 'schema_absent_initializable',
        runtimeAuthority: 'not-yet-provisioned',
        databaseIdentityDigest: identity.identityDigest,
        schemaVersion: 0,
        businessTableCount: POSTGRESQL_TRANSFER_BUSINESS_TABLES.length,
        nonEmptyBusinessTableCount: 0,
      })
    }
    if (!schema.owns_schema) return fail('schema_owner_mismatch')

    const relationCount = safeCount(schema.relation_count)
    const functionCount = safeCount(schema.function_count)
    const standaloneTypeCount = safeCount(schema.standalone_type_count)
    const policyCount = safeCount(schema.policy_count)
    if (!schema.migration_table_exists) {
      if (
        relationCount !== 0 || functionCount !== 0 ||
        standaloneTypeCount !== 0 || policyCount !== 0
      ) {
        return fail('schema_unrecognized')
      }
      return Object.freeze({
        state: 'schema_empty_owned_initializable',
        runtimeAuthority: 'not-yet-provisioned',
        databaseIdentityDigest: identity.identityDigest,
        schemaVersion: 0,
        businessTableCount: POSTGRESQL_TRANSFER_BUSINESS_TABLES.length,
        nonEmptyBusinessTableCount: 0,
      })
    }

    const history = await migration.query<PostgreSqlMigrationHistoryRow>(`
      SELECT version::text, name, fingerprint
      FROM ownware._migrations ORDER BY version
    `)
    let applied: number
    try {
      applied = validatePostgreSqlMigrationHistory(
        history.rows,
        POSTGRESQL_MIGRATION_MANIFEST,
      )
    } catch {
      return fail('schema_history_invalid')
    }
    if (applied !== POSTGRESQL_MIGRATION_MANIFEST.migrations.length) {
      return fail('schema_history_invalid')
    }
    if (!await POSTGRESQL_MIGRATION_MANIFEST.verifyCurrentSchema(migration)) {
      return fail('schema_manifest_mismatch')
    }
    if (!await exactNamespaceAndOwnership(migration)) {
      return fail('schema_unrecognized')
    }
    if (!await postgreSqlCatalogMatchesCurrentV91(migration)) {
      return fail('schema_manifest_mismatch')
    }
    await assertBusinessTablesEmpty(migration)
    const authority = await runtimeAuthority(
      runtime,
      identity.migration.user_name === identity.runtime.user_name,
    )
    return Object.freeze({
      state: 'schema_current_empty_ready',
      runtimeAuthority: authority,
      databaseIdentityDigest: identity.identityDigest,
      schemaVersion: POSTGRESQL_MIGRATION_MANIFEST.migrations.at(-1)!.version,
      businessTableCount: POSTGRESQL_TRANSFER_BUSINESS_TABLES.length,
      nonEmptyBusinessTableCount: 0,
    })
  } catch (error) {
    if (error instanceof PostgreSqlTransferPreflightError) throw error
    return fail('inspection_failed')
  }
}

/**
 * Acquire exclusive table locks and repeat exact current/empty validation at
 * the target write boundary. A SAVEPOINT proves the caller opened an explicit
 * transaction; SERIALIZABLE prevents a weaker caller from presenting this as
 * the STO-14 write fence.
 */
export async function lockAndValidateEmptyPostgreSqlTransferTarget(
  client: SessionClient,
): Promise<void> {
  try {
    await client.query('SAVEPOINT ownware_transfer_transaction_guard')
    await client.query('RELEASE SAVEPOINT ownware_transfer_transaction_guard')
    const settings = await client.query<{
      readonly isolation: string
      readonly read_only: boolean
    }>(`
      SELECT
        current_setting('transaction_isolation') AS isolation,
        current_setting('transaction_read_only')::boolean AS read_only
    `)
    const transaction = settings.rows[0]
    if (
      transaction?.isolation !== 'serializable' ||
      transaction.read_only !== false
    ) {
      return fail('inspection_failed')
    }

    await client.query(`
      LOCK TABLE ${POSTGRESQL_TRANSFER_BUSINESS_TABLES
        .map((table) => `ownware.${quoteIdentifier(table)}`)
        .join(', ')}
      IN ACCESS EXCLUSIVE MODE
    `)

    const schema = await schemaFacts(client)
    if (schema === undefined || !schema.owns_schema || !schema.migration_table_exists) {
      return fail('schema_owner_mismatch')
    }
    const history = await client.query<PostgreSqlMigrationHistoryRow>(`
      SELECT version::text, name, fingerprint
      FROM ownware._migrations ORDER BY version
    `)
    let applied: number
    try {
      applied = validatePostgreSqlMigrationHistory(
        history.rows,
        POSTGRESQL_MIGRATION_MANIFEST,
      )
    } catch {
      return fail('schema_history_invalid')
    }
    if (
      applied !== POSTGRESQL_MIGRATION_MANIFEST.migrations.length ||
      !await POSTGRESQL_MIGRATION_MANIFEST.verifyCurrentSchema(client) ||
      !await exactNamespaceAndOwnership(client) ||
      !await postgreSqlCatalogMatchesCurrentV91(client)
    ) {
      return fail('schema_manifest_mismatch')
    }
    await assertBusinessTablesEmpty(client)
  } catch (error) {
    if (error instanceof PostgreSqlTransferPreflightError) throw error
    return fail('inspection_failed')
  }
}
