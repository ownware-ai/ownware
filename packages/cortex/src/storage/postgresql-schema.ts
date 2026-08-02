import {
  POSTGRESQL_BASELINE_MANIFEST,
  POSTGRESQL_BASELINE_SUMMARY,
} from './postgresql-baseline.js'
import type { PostgreSqlClient, PostgreSqlPoolClient } from './postgresql-driver.js'

type QueryClient = Pick<PostgreSqlClient | PostgreSqlPoolClient, 'query'>

export interface PostgreSqlSchemaSummary {
  readonly tableCount: number
  readonly columnCount: number
  readonly foreignKeyCount: number
  readonly uniqueConstraintCount: number
  readonly explicitIndexCount: number
  readonly triggerCount: number
}

export interface PostgreSqlSchemaManifest {
  readonly columns: readonly {
    readonly table: string
    readonly name: string
    readonly type: string
    readonly nullable: boolean
    readonly pkPosition: number
  }[]
  readonly uniqueConstraints: readonly {
    readonly table: string
    readonly columns: readonly string[]
  }[]
  readonly foreignKeys: readonly {
    readonly table: string
    readonly columns: readonly string[]
    readonly referencedTable: string
    readonly referencedColumns: readonly string[]
    readonly onUpdate: string
    readonly onDelete: string
    readonly deferred: boolean
  }[]
  readonly explicitIndexes: readonly {
    readonly table: string
    readonly name: string
    readonly unique: boolean
    readonly columns: readonly { readonly name: string; readonly descending: boolean }[]
    readonly predicate: string | null
  }[]
}

export interface PostgreSqlSchemaExpectation {
  readonly summary: PostgreSqlSchemaSummary
  readonly manifest: PostgreSqlSchemaManifest
}

const BASELINE_EXPECTATION: PostgreSqlSchemaExpectation = Object.freeze({
  summary: POSTGRESQL_BASELINE_SUMMARY,
  manifest: POSTGRESQL_BASELINE_MANIFEST,
})

interface CountRow {
  readonly tables: string
  readonly columns: string
  readonly foreign_keys: string
  readonly unique_constraints: string
  readonly explicit_indexes: string
  readonly triggers: string
}

interface ColumnRow {
  readonly table_name: string
  readonly column_name: string
  readonly data_type: string
  readonly not_null: boolean
  readonly pk_position: number
}

interface UniqueRow {
  readonly table_name: string
  readonly columns: string[]
}

interface ForeignKeyRow {
  readonly table_name: string
  readonly columns: string[]
  readonly referenced_table: string
  readonly referenced_columns: string[]
  readonly on_update: string
  readonly on_delete: string
  readonly deferred: boolean
}

interface IndexRow {
  readonly table_name: string
  readonly index_name: string
  readonly is_unique: boolean
  readonly columns: string[]
  readonly descending: boolean[]
  readonly predicate: string | null
  readonly access_method: string
  readonly uses_default_semantics: boolean
  readonly structurally_usable: boolean
}

const ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
})

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function integer(value: string): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : -1
}

/**
 * PostgreSQL's stable catalog deparser form for the deliberately narrow
 * partial-index expressions emitted by the baseline generator. Unsupported
 * syntax is a compiled-schema error, never a wildcard match.
 */
function postgreSqlIndexPredicate(predicate: string | null): string | null {
  if (predicate === null) return null
  const notNull = /^([a-z_][a-z0-9_]*) IS NOT NULL$/.exec(predicate)
  if (notNull !== null) return `(${notNull[1]} IS NOT NULL)`
  const isNull = /^([a-z_][a-z0-9_]*) IS NULL$/.exec(predicate)
  if (isNull !== null) return `(${isNull[1]} IS NULL)`
  const equals = /^([a-z_][a-z0-9_]*) = '([^']*)'$/.exec(predicate)
  if (equals !== null) return `(${equals[1]} = '${equals[2]}'::text)`
  const inList = /^([a-z_][a-z0-9_]*) IN \((.*)\)$/.exec(predicate)
  if (inList !== null) {
    const identifier = inList[1]
    const source = inList[2]
    if (identifier === undefined || source === undefined) {
      throw new TypeError('Unsupported compiled PostgreSQL index predicate.')
    }
    const values = [...source.matchAll(/'([^']*)'/g)].map((match) => match[1])
    const compact = values.map((value) => `'${value}'`).join(',')
    if (values.length > 0 && compact === source.replaceAll(' ', '')) {
      return `(${identifier} = ANY (ARRAY[${values.map((value) => `'${value}'::text`).join(', ')}]))`
    }
  }
  throw new TypeError('Unsupported compiled PostgreSQL index predicate.')
}

/**
 * Compare PostgreSQL's authoritative catalog to the generated logical
 * baseline. No SQL text or row value escapes when a comparison fails.
 */
export async function postgreSqlBaselineMatches(client: QueryClient): Promise<boolean> {
  return await inspectPostgreSqlBaseline(client) === 'matches'
}

/** Compare the full owned schema to an exact compiled structural expectation. */
export async function postgreSqlSchemaMatches(
  client: QueryClient,
  expectation: PostgreSqlSchemaExpectation,
): Promise<boolean> {
  return await inspectPostgreSqlSchema(client, expectation) === 'matches'
}

export type PostgreSqlBaselineInspection =
  | 'matches'
  | 'counts'
  | 'columns'
  | 'unique-constraints'
  | 'foreign-keys'
  | 'indexes'

/** Content-free structural receipt used by adapter tests and diagnostics. */
export async function inspectPostgreSqlBaseline(
  client: QueryClient,
): Promise<PostgreSqlBaselineInspection> {
  return inspectPostgreSqlSchema(client, BASELINE_EXPECTATION)
}

async function inspectPostgreSqlSchema(
  client: QueryClient,
  expectation: PostgreSqlSchemaExpectation,
): Promise<PostgreSqlBaselineInspection> {
  const counts = await client.query<CountRow>(`
    SELECT
      (SELECT count(*)::text FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'ownware' AND relation.relkind = 'r') AS tables,
      (SELECT count(*)::text FROM pg_catalog.pg_attribute AS attribute
        JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'ownware' AND relation.relkind = 'r'
          AND attribute.attnum > 0 AND NOT attribute.attisdropped) AS columns,
      (SELECT count(*)::text FROM pg_catalog.pg_constraint AS constraint_record
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = constraint_record.connamespace
        WHERE namespace.nspname = 'ownware' AND constraint_record.contype = 'f') AS foreign_keys,
      (SELECT count(*)::text FROM pg_catalog.pg_constraint AS constraint_record
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = constraint_record.connamespace
        WHERE namespace.nspname = 'ownware' AND constraint_record.contype = 'u') AS unique_constraints,
      (SELECT count(*)::text FROM pg_catalog.pg_index AS index_record
        JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_record.indexrelid
        JOIN pg_catalog.pg_class AS table_relation ON table_relation.oid = index_record.indrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
        WHERE namespace.nspname = 'ownware'
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_constraint AS constraint_record
            WHERE constraint_record.conindid = index_record.indexrelid
              AND constraint_record.contype IN ('p', 'u', 'x')
          )) AS explicit_indexes,
      (SELECT count(*)::text FROM pg_catalog.pg_trigger AS trigger_record
        JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_record.tgrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'ownware' AND NOT trigger_record.tgisinternal) AS triggers
  `)
  const count = counts.rows[0]
  if (count === undefined || !same({
    tableCount: integer(count.tables),
    columnCount: integer(count.columns),
    foreignKeyCount: integer(count.foreign_keys),
    uniqueConstraintCount: integer(count.unique_constraints),
    explicitIndexCount: integer(count.explicit_indexes),
    triggerCount: integer(count.triggers),
  }, expectation.summary)) return 'counts'

  const columnResult = await client.query<ColumnRow>(`
    SELECT
      table_relation.relname AS table_name,
      attribute.attname AS column_name,
      upper(pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)) AS data_type,
      attribute.attnotnull AS not_null,
      COALESCE(array_position(primary_index.indkey::smallint[], attribute.attnum) + 1, 0) AS pk_position
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS table_relation ON table_relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
    LEFT JOIN pg_catalog.pg_index AS primary_index
      ON primary_index.indrelid = table_relation.oid AND primary_index.indisprimary
    WHERE namespace.nspname = 'ownware' AND table_relation.relkind = 'r'
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
    ORDER BY table_relation.relname, attribute.attname
  `)
  const columns = columnResult.rows.map((row) => ({
    table: row.table_name,
    name: row.column_name,
    type: row.data_type,
    nullable: !row.not_null,
    pkPosition: Number(row.pk_position),
  }))
  if (!same(columns, expectation.manifest.columns)) return 'columns'

  const uniqueResult = await client.query<UniqueRow>(`
    SELECT
      table_relation.relname AS table_name,
      array_agg(attribute.attname ORDER BY key_column.ordinality)::text[] AS columns
    FROM pg_catalog.pg_constraint AS constraint_record
    JOIN pg_catalog.pg_class AS table_relation ON table_relation.oid = constraint_record.conrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = constraint_record.connamespace
    CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = table_relation.oid AND attribute.attnum = key_column.attnum
    WHERE namespace.nspname = 'ownware' AND constraint_record.contype = 'u'
    GROUP BY table_relation.relname, constraint_record.oid
    ORDER BY table_relation.relname, array_agg(attribute.attname ORDER BY key_column.ordinality)::text
  `)
  const unique = uniqueResult.rows.map((row) => ({
    table: row.table_name,
    columns: row.columns,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  if (!same(unique, expectation.manifest.uniqueConstraints)) return 'unique-constraints'

  const foreignKeyResult = await client.query<ForeignKeyRow>(`
    SELECT
      table_relation.relname AS table_name,
      array_agg(source_attribute.attname ORDER BY source_key.ordinality)::text[] AS columns,
      referenced_relation.relname AS referenced_table,
      array_agg(referenced_attribute.attname ORDER BY source_key.ordinality)::text[] AS referenced_columns,
      constraint_record.confupdtype::text AS on_update,
      constraint_record.confdeltype::text AS on_delete,
      constraint_record.condeferrable AND constraint_record.condeferred AS deferred
    FROM pg_catalog.pg_constraint AS constraint_record
    JOIN pg_catalog.pg_class AS table_relation ON table_relation.oid = constraint_record.conrelid
    JOIN pg_catalog.pg_class AS referenced_relation ON referenced_relation.oid = constraint_record.confrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = constraint_record.connamespace
    CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY AS source_key(attnum, ordinality)
    JOIN LATERAL unnest(constraint_record.confkey) WITH ORDINALITY AS referenced_key(attnum, ordinality)
      ON referenced_key.ordinality = source_key.ordinality
    JOIN pg_catalog.pg_attribute AS source_attribute
      ON source_attribute.attrelid = table_relation.oid AND source_attribute.attnum = source_key.attnum
    JOIN pg_catalog.pg_attribute AS referenced_attribute
      ON referenced_attribute.attrelid = referenced_relation.oid AND referenced_attribute.attnum = referenced_key.attnum
    WHERE namespace.nspname = 'ownware' AND constraint_record.contype = 'f'
    GROUP BY table_relation.relname, referenced_relation.relname, constraint_record.oid
  `)
  const foreignKeys = foreignKeyResult.rows.map((row) => ({
    table: row.table_name,
    columns: row.columns,
    referencedTable: row.referenced_table,
    referencedColumns: row.referenced_columns,
    onUpdate: ACTIONS[row.on_update] ?? '<unknown>',
    onDelete: ACTIONS[row.on_delete] ?? '<unknown>',
    deferred: row.deferred,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  if (!same(foreignKeys, expectation.manifest.foreignKeys)) return 'foreign-keys'

  const indexResult = await client.query<IndexRow>(`
    SELECT
      table_relation.relname AS table_name,
      index_relation.relname AS index_name,
      index_record.indisunique AS is_unique,
      array_agg(attribute.attname ORDER BY key_column.ordinality)::text[] AS columns,
      array_agg((key_column.option_bits & 1) = 1 ORDER BY key_column.ordinality)::boolean[] AS descending,
      pg_catalog.pg_get_expr(index_record.indpred, index_record.indrelid) AS predicate,
      access_method.amname AS access_method,
      bool_and(
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_opclass AS default_opclass
          WHERE default_opclass.oid = key_column.opclass_oid
            AND default_opclass.opcmethod = access_method.oid
            AND default_opclass.opcintype = attribute.atttypid
            AND default_opclass.opcdefault
        ) AND key_column.collation_oid = attribute.attcollation
      ) AS uses_default_semantics,
      index_record.indisvalid AND index_record.indisready AND index_record.indislive AND
        index_record.indnkeyatts = index_record.indnatts AS structurally_usable
    FROM pg_catalog.pg_index AS index_record
    JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_record.indexrelid
    JOIN pg_catalog.pg_class AS table_relation ON table_relation.oid = index_record.indrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
    JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_relation.relam
    CROSS JOIN LATERAL unnest(
      index_record.indkey::smallint[],
      index_record.indoption::smallint[],
      index_record.indclass::oid[],
      index_record.indcollation::oid[]
    ) WITH ORDINALITY AS key_column(
      attnum, option_bits, opclass_oid, collation_oid, ordinality
    )
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = table_relation.oid AND attribute.attnum = key_column.attnum
    WHERE namespace.nspname = 'ownware'
      AND key_column.ordinality <= index_record.indnkeyatts
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint AS constraint_record
        WHERE constraint_record.conindid = index_record.indexrelid
          AND constraint_record.contype IN ('p', 'u', 'x')
      )
    GROUP BY table_relation.relname, index_relation.relname, index_record.indexrelid,
      index_record.indisunique, index_record.indpred, access_method.amname,
      access_method.oid, index_record.indisvalid, index_record.indisready,
      index_record.indislive, index_record.indnkeyatts,
      index_record.indnatts
    ORDER BY index_relation.relname
  `)
  const indexes = indexResult.rows.map((row) => ({
    table: row.table_name,
    name: row.index_name,
    unique: row.is_unique,
    columns: row.columns.map((name, position) => ({
      name,
      descending: row.descending[position] ?? false,
    })),
    predicate: row.predicate,
    accessMethod: row.access_method,
    usesDefaultSemantics: row.uses_default_semantics,
    structurallyUsable: row.structurally_usable,
  }))
  const expectedIndexes = expectation.manifest.explicitIndexes.map((index) => ({
    ...index,
    predicate: postgreSqlIndexPredicate(index.predicate),
    accessMethod: 'btree',
    usesDefaultSemantics: true,
    structurallyUsable: true,
  }))
  return same(indexes, expectedIndexes) ? 'matches' : 'indexes'
}
