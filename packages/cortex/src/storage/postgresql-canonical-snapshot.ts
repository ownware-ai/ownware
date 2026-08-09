import {
  CanonicalTableDigest,
  digestCanonicalDatabase,
  type CanonicalTableDigestReceipt,
} from './canonical-storage-digest.js'
import type { PostgreSqlClient, PostgreSqlPoolClient } from './postgresql-driver.js'
import {
  postgreSqlCatalogMatchesCurrentV85,
} from './postgresql-catalog-certification.js'
import {
  POSTGRESQL_CURRENT_SCHEMA_EXPECTATION,
  POSTGRESQL_MIGRATION_MANIFEST,
  type PostgreSqlMigrationHistoryRow,
  validatePostgreSqlMigrationHistory,
} from './postgresql-migrations.js'
import {
  logicalColumnSetHash,
  logicalKindForColumn,
  postgresqlProjectionForColumn,
  postgresqlTypeForLogicalKind,
  type LogicalColumnDescriptor,
} from './logical-schema.js'
import { decodePostgreSqlTextKey } from './postgresql-repository.js'

type SessionClient = Pick<PostgreSqlClient | PostgreSqlPoolClient, 'query'>
const CURSOR_NAME = 'ownware_transfer_canonical_cursor'
const CURSOR_BATCH_SIZE = 128

export type PostgreSqlCanonicalSnapshotErrorCode =
  | 'history_invalid'
  | 'schema_invalid'
  | 'logical_schema_invalid'
  | 'row_invalid'
  | 'read_failed'

export class PostgreSqlCanonicalSnapshotError extends Error {
  override readonly name = 'PostgreSqlCanonicalSnapshotError'

  constructor(readonly code: PostgreSqlCanonicalSnapshotErrorCode) {
    super(`PostgreSQL canonical snapshot failed (${code}).`)
  }
}

export interface PostgreSqlCanonicalSnapshotReceipt {
  readonly schemaVersion: number
  readonly logicalColumnCount: number
  readonly logicalColumnDigest: string
  readonly tableCount: number
  readonly rowCount: number
  readonly cellCount: number
  readonly contentDigest: string
  readonly tables: readonly CanonicalTableDigestReceipt[]
}

function fail(code: PostgreSqlCanonicalSnapshotErrorCode): never {
  throw new PostgreSqlCanonicalSnapshotError(code)
}

function fallbackKind(type: string): 'text' | 'safe-integer' | 'finite-real' | 'boolean' | 'binary' {
  switch (type) {
    case 'TEXT': return 'text'
    case 'BIGINT': return 'safe-integer'
    case 'DOUBLE PRECISION': return 'finite-real'
    case 'BOOLEAN': return 'boolean'
    case 'BYTEA': return 'binary'
    default: return fail('logical_schema_invalid')
  }
}

export function currentPostgreSqlLogicalColumns(): readonly LogicalColumnDescriptor[] {
  const columns = POSTGRESQL_CURRENT_SCHEMA_EXPECTATION.manifest.columns.map((column) => {
    const key = `${column.table}.${column.name}`
    const kind = logicalKindForColumn(key, fallbackKind(column.type))
    const postgresqlType = postgresqlTypeForLogicalKind(kind)
    if (postgresqlType !== column.type) return fail('logical_schema_invalid')
    return {
      table: column.table,
      name: column.name,
      key,
      declaredType: column.type,
      notNull: !column.nullable,
      nullable: column.nullable,
      defaultValue: null,
      pkPosition: column.pkPosition,
      hidden: 0,
      kind,
      postgresqlType,
      postgresqlProjection: postgresqlProjectionForColumn(key),
    } satisfies LogicalColumnDescriptor
  })
  if (
    columns.length !== 749 ||
    new Set(columns.map((column) => column.key)).size !== columns.length
  ) {
    return fail('logical_schema_invalid')
  }
  return Object.freeze(columns)
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function orderExpression(column: LogicalColumnDescriptor): string {
  const identifier = quoteIdentifier(column.name)
  return column.kind === 'text'
    ? `${identifier} COLLATE "C" ASC`
    : `${identifier} ASC`
}

function logicalValue(column: LogicalColumnDescriptor, value: unknown): unknown {
  return column.postgresqlProjection === 'postgresql-text-key-v1'
    ? decodePostgreSqlTextKey(value)
    : value
}

async function scanTable(
  client: SessionClient,
  columns: readonly LogicalColumnDescriptor[],
): Promise<CanonicalTableDigestReceipt> {
  const table = columns[0]?.table ?? fail('logical_schema_invalid')
  const primaryKey = columns
    .filter((column) => column.pkPosition > 0)
    .sort((left, right) => left.pkPosition - right.pkPosition)
  if (
    primaryKey.length === 0 ||
    columns.some((column) => column.table !== table)
  ) {
    return fail('logical_schema_invalid')
  }
  const projections = columns.map((column, index) => (
    `${quoteIdentifier(column.name)} AS ${quoteIdentifier(`value_${index}`)}`
  ))
  await client.query(`
    DECLARE ${CURSOR_NAME} NO SCROLL CURSOR FOR
    SELECT ${projections.join(', ')}
    FROM ownware.${quoteIdentifier(table)}
    ORDER BY ${primaryKey.map(orderExpression).join(', ')}
  `)
  const digest = new CanonicalTableDigest(columns)
  let rowOrdinal = 0
  try {
    while (true) {
      const batch = await client.query<Record<string, unknown>>(
        `FETCH FORWARD ${CURSOR_BATCH_SIZE} FROM ${CURSOR_NAME}`,
      )
      for (const row of batch.rows) {
        let values: readonly unknown[]
        try {
          values = columns.map((column, index) => (
            logicalValue(column, row[`value_${index}`])
          ))
          digest.append(rowOrdinal, values)
        } catch {
          return fail('row_invalid')
        }
        rowOrdinal += 1
      }
      if (batch.rows.length < CURSOR_BATCH_SIZE) break
    }
  } finally {
    await client.query(`CLOSE ${CURSOR_NAME}`).catch(() => {})
  }
  return digest.finish()
}

/**
 * Canonicalize every certified transferable table from one PostgreSQL
 * REPEATABLE READ, READ ONLY snapshot. The caller supplies one dedicated
 * session; arbitrary pool calls cannot escape the snapshot.
 */
export async function canonicalPostgreSqlTransferSnapshot(
  client: SessionClient,
): Promise<PostgreSqlCanonicalSnapshotReceipt> {
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try {
      const receipt = await canonicalPostgreSqlTransferSnapshotWithinTransaction(client)
      await client.query('COMMIT')
      return receipt
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (error instanceof PostgreSqlCanonicalSnapshotError) throw error
      return fail('read_failed')
    }
  } catch (error) {
    if (error instanceof PostgreSqlCanonicalSnapshotError) throw error
    return fail('read_failed')
  }
}

/**
 * Canonicalize the snapshot visible to a caller-owned transaction without
 * beginning, committing, or rolling it back. STO-14 uses this after copying
 * but before COMMIT so equality can still cause a complete target rollback.
 */
export async function canonicalPostgreSqlTransferSnapshotWithinTransaction(
  client: SessionClient,
): Promise<PostgreSqlCanonicalSnapshotReceipt> {
  try {
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
      return fail('history_invalid')
    }
    if (applied !== POSTGRESQL_MIGRATION_MANIFEST.migrations.length) {
      return fail('history_invalid')
    }
    if (!await POSTGRESQL_MIGRATION_MANIFEST.verifyCurrentSchema(client)) {
      return fail('schema_invalid')
    }
    if (!await postgreSqlCatalogMatchesCurrentV85(client)) {
      return fail('schema_invalid')
    }

    const logical = currentPostgreSqlLogicalColumns()
    const byTable = new Map<string, LogicalColumnDescriptor[]>()
    for (const column of logical) {
      if (column.table === '_migrations') continue
      const existing = byTable.get(column.table)
      if (existing === undefined) byTable.set(column.table, [column])
      else existing.push(column)
    }
    const tables: CanonicalTableDigestReceipt[] = []
    for (const table of [...byTable.keys()].sort()) {
      const columns = byTable.get(table) ?? fail('logical_schema_invalid')
      tables.push(await scanTable(client, columns))
    }
    const content = digestCanonicalDatabase(tables)
    return Object.freeze({
      schemaVersion: POSTGRESQL_MIGRATION_MANIFEST.migrations.at(-1)!.version,
      logicalColumnCount: logical.length,
      logicalColumnDigest: logicalColumnSetHash(logical),
      tableCount: content.tableCount,
      rowCount: content.rowCount,
      cellCount: content.cellCount,
      contentDigest: content.digest,
      tables: Object.freeze(tables.map((table) => Object.freeze({ ...table }))),
    })
  } catch (error) {
    if (error instanceof PostgreSqlCanonicalSnapshotError) throw error
    return fail('read_failed')
  }
}
