import { createHash } from 'node:crypto'
import type { PostgreSqlClient, PostgreSqlPoolClient } from './postgresql-driver.js'

type QueryClient = Pick<PostgreSqlClient | PostgreSqlPoolClient, 'query'>
const CATALOG_FORMAT = 'ownware-postgresql-catalog-v1'

/**
 * Catalog receipts generated from the immutable v82 baseline and its current
 * migration on PostgreSQL 16.14, 17.10, and 18.4. The projection uses catalog
 * fields available throughout the supported PostgreSQL 16-18 envelope; an
 * unfamiliar deparser result fails closed until its major-version lane is
 * certified.
 */
const POSTGRESQL_BASELINE_V82_CATALOG_DIGESTS: Readonly<Record<number, string>> =
  Object.freeze({
    16: 'sha256:e1eb2410738e8cc813fab7c56f6f839b1200e9fa792d1af0be7b4185b38bd72b',
    17: 'sha256:e1eb2410738e8cc813fab7c56f6f839b1200e9fa792d1af0be7b4185b38bd72b',
    18: 'sha256:c4ec4e9ae3914cb6a430042ab027d014043d52e8e80c53cc6e97508df5aeb5fd',
  })
const POSTGRESQL_CURRENT_V86_CATALOG_DIGESTS: Readonly<Record<number, string>> =
  Object.freeze({
    16: 'sha256:887f53e4b2baa1e9d84b42682e08cd05610dab2d58a674a5dc7a5dacbfcb91cc',
    17: 'sha256:887f53e4b2baa1e9d84b42682e08cd05610dab2d58a674a5dc7a5dacbfcb91cc',
    18: 'sha256:e05aedc0242d713cbc316769f79e5255d4ce6ffd1f0394dea382694c77955c15',
  })

interface RelationRow {
  readonly name: string
  readonly kind: string
  readonly persistence: string
  readonly row_security: boolean
  readonly force_row_security: boolean
  readonly is_partition: boolean
  readonly replica_identity: string
}

interface ColumnRow {
  readonly table_name: string
  readonly ordinal: number
  readonly column_name: string
  readonly data_type: string
  readonly not_null: boolean
  readonly identity_kind: string
  readonly generated_kind: string
  readonly collation_name: string | null
  readonly default_expression: string | null
}

interface ConstraintRow {
  readonly table_name: string
  readonly constraint_name: string
  readonly constraint_type: string
  readonly validated: boolean
  readonly deferrable: boolean
  readonly deferred: boolean
  readonly no_inherit: boolean
  readonly definition: string
}

interface IndexRow {
  readonly table_name: string
  readonly index_name: string
  readonly access_method: string
  readonly is_unique: boolean
  readonly is_primary: boolean
  readonly is_exclusion: boolean
  readonly is_immediate: boolean
  readonly is_valid: boolean
  readonly is_ready: boolean
  readonly is_live: boolean
  readonly nulls_not_distinct: boolean
  readonly key_count: number
  readonly attribute_count: number
  readonly definition: string
}

interface TriggerRow {
  readonly table_name: string
  readonly trigger_name: string
  readonly enabled: string
  readonly definition: string
}

interface FunctionRow {
  readonly function_name: string
  readonly argument_types: string
  readonly result_type: string
  readonly language_name: string
  readonly function_kind: string
  readonly volatility: string
  readonly is_strict: boolean
  readonly security_definer: boolean
  readonly leakproof: boolean
  readonly parallel_kind: string
  readonly body: string
}

interface SequenceRow {
  readonly sequence_name: string
  readonly data_type: string
  readonly start_value: string
  readonly increment_by: string
  readonly maximum_value: string
  readonly minimum_value: string
  readonly cache_size: string
  readonly cycles: boolean
  readonly dependent_table: string
  readonly dependent_column: string
  readonly dependency_kind: string
}

function digest(sections: readonly unknown[]): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([CATALOG_FORMAT, ...sections]))
    .digest('hex')}`
}

/**
 * Content-free digest of the authoritative managed-schema catalog. It excludes
 * owners and ACLs because combined and split-role deployments legitimately
 * differ there; target preflight proves those authorities separately.
 */
export async function postgreSqlCatalogDigest(client: QueryClient): Promise<string> {
  const relations = await client.query<RelationRow>(`
    SELECT
      relation.relname AS name,
      relation.relkind::text AS kind,
      relation.relpersistence::text AS persistence,
      relation.relrowsecurity AS row_security,
      relation.relforcerowsecurity AS force_row_security,
      relation.relispartition AS is_partition,
      relation.relreplident::text AS replica_identity
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'ownware'
    ORDER BY relation.relkind, relation.relname
  `)
  const columns = await client.query<ColumnRow>(`
    SELECT
      relation.relname AS table_name,
      attribute.attnum AS ordinal,
      attribute.attname AS column_name,
      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
      attribute.attnotnull AS not_null,
      attribute.attidentity::text AS identity_kind,
      attribute.attgenerated::text AS generated_kind,
      collation_record.collname AS collation_name,
      pg_catalog.pg_get_expr(default_record.adbin, default_record.adrelid) AS default_expression
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef AS default_record
      ON default_record.adrelid = attribute.attrelid
      AND default_record.adnum = attribute.attnum
    LEFT JOIN pg_catalog.pg_collation AS collation_record
      ON collation_record.oid = attribute.attcollation
    WHERE namespace.nspname = 'ownware' AND relation.relkind = 'r'
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
    ORDER BY relation.relname, attribute.attnum
  `)
  const constraints = await client.query<ConstraintRow>(`
    SELECT
      relation.relname AS table_name,
      constraint_record.conname AS constraint_name,
      constraint_record.contype::text AS constraint_type,
      constraint_record.convalidated AS validated,
      constraint_record.condeferrable AS deferrable,
      constraint_record.condeferred AS deferred,
      constraint_record.connoinherit AS no_inherit,
      pg_catalog.pg_get_constraintdef(constraint_record.oid, FALSE) AS definition
    FROM pg_catalog.pg_constraint AS constraint_record
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = constraint_record.connamespace
    JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_record.conrelid
    WHERE namespace.nspname = 'ownware'
    ORDER BY relation.relname, constraint_record.conname
  `)
  const indexes = await client.query<IndexRow>(`
    SELECT
      table_relation.relname AS table_name,
      index_relation.relname AS index_name,
      access_method.amname AS access_method,
      index_record.indisunique AS is_unique,
      index_record.indisprimary AS is_primary,
      index_record.indisexclusion AS is_exclusion,
      index_record.indimmediate AS is_immediate,
      index_record.indisvalid AS is_valid,
      index_record.indisready AS is_ready,
      index_record.indislive AS is_live,
      index_record.indnullsnotdistinct AS nulls_not_distinct,
      index_record.indnkeyatts AS key_count,
      index_record.indnatts AS attribute_count,
      pg_catalog.pg_get_indexdef(index_record.indexrelid, 0, FALSE) AS definition
    FROM pg_catalog.pg_index AS index_record
    JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_record.indexrelid
    JOIN pg_catalog.pg_class AS table_relation ON table_relation.oid = index_record.indrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
    JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_relation.relam
    WHERE namespace.nspname = 'ownware'
    ORDER BY table_relation.relname, index_relation.relname
  `)
  const triggers = await client.query<TriggerRow>(`
    SELECT
      relation.relname AS table_name,
      trigger_record.tgname AS trigger_name,
      trigger_record.tgenabled::text AS enabled,
      pg_catalog.pg_get_triggerdef(trigger_record.oid, FALSE) AS definition
    FROM pg_catalog.pg_trigger AS trigger_record
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_record.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'ownware' AND NOT trigger_record.tgisinternal
    ORDER BY relation.relname, trigger_record.tgname
  `)
  const functions = await client.query<FunctionRow>(`
    SELECT
      procedure.proname AS function_name,
      pg_catalog.pg_get_function_identity_arguments(procedure.oid) AS argument_types,
      pg_catalog.pg_get_function_result(procedure.oid) AS result_type,
      language.lanname AS language_name,
      procedure.prokind::text AS function_kind,
      procedure.provolatile::text AS volatility,
      procedure.proisstrict AS is_strict,
      procedure.prosecdef AS security_definer,
      procedure.proleakproof AS leakproof,
      procedure.proparallel::text AS parallel_kind,
      procedure.prosrc AS body
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    JOIN pg_catalog.pg_language AS language ON language.oid = procedure.prolang
    WHERE namespace.nspname = 'ownware'
    ORDER BY procedure.proname, pg_catalog.pg_get_function_identity_arguments(procedure.oid)
  `)
  const sequences = await client.query<SequenceRow>(`
    SELECT
      sequence_relation.relname AS sequence_name,
      pg_catalog.format_type(sequence_record.seqtypid, NULL) AS data_type,
      sequence_record.seqstart::text AS start_value,
      sequence_record.seqincrement::text AS increment_by,
      sequence_record.seqmax::text AS maximum_value,
      sequence_record.seqmin::text AS minimum_value,
      sequence_record.seqcache::text AS cache_size,
      sequence_record.seqcycle AS cycles,
      dependent_relation.relname AS dependent_table,
      dependent_attribute.attname AS dependent_column,
      dependency.deptype::text AS dependency_kind
    FROM pg_catalog.pg_sequence AS sequence_record
    JOIN pg_catalog.pg_class AS sequence_relation ON sequence_relation.oid = sequence_record.seqrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = sequence_relation.relnamespace
    JOIN pg_catalog.pg_depend AS dependency
      ON dependency.classid = 'pg_catalog.pg_class'::regclass
      AND dependency.objid = sequence_relation.oid
      AND dependency.objsubid = 0
      AND dependency.refclassid = 'pg_catalog.pg_class'::regclass
      AND dependency.deptype IN ('a', 'i')
    JOIN pg_catalog.pg_class AS dependent_relation ON dependent_relation.oid = dependency.refobjid
    JOIN pg_catalog.pg_attribute AS dependent_attribute
      ON dependent_attribute.attrelid = dependent_relation.oid
      AND dependent_attribute.attnum = dependency.refobjsubid
    WHERE namespace.nspname = 'ownware'
    ORDER BY sequence_relation.relname
  `)

  return digest([
    relations.rows.map((row) => Object.values(row)),
    columns.rows.map((row) => Object.values(row)),
    constraints.rows.map((row) => Object.values(row)),
    indexes.rows.map((row) => Object.values(row)),
    triggers.rows.map((row) => Object.values(row)),
    functions.rows.map((row) => Object.values(row)),
    sequences.rows.map((row) => Object.values(row)),
  ])
}

async function serverMajor(client: QueryClient): Promise<number | undefined> {
  const result = await client.query<{ readonly version_number: string }>(`
    SELECT current_setting('server_version_num') AS version_number
  `)
  const version = Number(result.rows[0]?.version_number)
  if (!Number.isSafeInteger(version) || version < 0) return undefined
  const major = Math.floor(version / 10_000)
  return major >= 16 && major <= 18 ? major : undefined
}

async function matchesGeneration(
  client: QueryClient,
  expected: Readonly<Record<number, string>>,
): Promise<boolean> {
  const major = await serverMajor(client)
  if (major === undefined) return false
  const expectedDigest = expected[major]
  return expectedDigest !== undefined && await postgreSqlCatalogDigest(client) === expectedDigest
}

export async function postgreSqlCatalogMatchesBaselineV82(
  client: QueryClient,
): Promise<boolean> {
  return matchesGeneration(client, POSTGRESQL_BASELINE_V82_CATALOG_DIGESTS)
}

export async function postgreSqlCatalogMatchesCurrentV86(
  client: QueryClient,
): Promise<boolean> {
  return matchesGeneration(client, POSTGRESQL_CURRENT_V86_CATALOG_DIGESTS)
}
