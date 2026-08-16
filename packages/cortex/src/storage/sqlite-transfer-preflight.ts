import { createHash } from 'node:crypto'
import { MIGRATIONS } from '../gateway/db/schema.js'
import {
  assertCurrentSqliteMigrationHistory,
  MigrationSafetyError,
} from '../gateway/db/migration-safety.js'
import {
  CanonicalStorageDigestError,
  CanonicalTableDigest,
  digestCanonicalDatabase,
  type CanonicalTableDigestReceipt,
} from './canonical-storage-digest.js'
import type {
  LogicalColumnDescriptor,
  PhysicalColumnDescriptor,
} from './logical-schema.js'
import {
  SQLITE_V90_COLUMN_COUNT,
  SQLITE_V90_COLUMN_SET_HASH,
  classifyLogicalColumns,
  logicalColumnSetHash,
  physicalColumnSetHash,
} from './logical-schema.js'
import { openSqliteDatabase, type SqliteDatabase } from './sqlite-driver.js'
import {
  StorageValueError,
  normalizeProjectedStorageValue,
  type StorageValueErrorCode,
} from './value-codec.js'

export type SqliteStorageClass =
  | 'null'
  | 'integer'
  | 'real'
  | 'text'
  | 'blob'

export interface SqliteObservedCell {
  readonly name: string
  /** The result of SQLite `typeof(column)`, not the declared affinity. */
  readonly storageClass: SqliteStorageClass
  /** Read integers in safe-integer mode so int64 values arrive as bigint. */
  readonly value: unknown
  /** Exact bytes for authoritative high-level TEXT scans. */
  readonly rawTextBytes?: Uint8Array
}

export interface SqliteObservedRow {
  readonly table: string
  /** Zero-based position in the table's deterministic primary-key ordering. */
  readonly rowOrdinal: number
  readonly cells: readonly SqliteObservedCell[]
}

export type SqliteTransferPreflightErrorCode =
  | 'database_open_failed'
  | 'migration_history_mismatch'
  | 'schema_objects_mismatch'
  | 'integrity_check_failed'
  | 'foreign_key_violation'
  | 'constraint_violation'
  | 'source_changed'
  | 'source_receipt_mismatch'
  | 'source_values_invalid'
  | 'table_schema_invalid'
  | 'row_location_invalid'
  | 'table_mismatch'
  | 'cell_set_mismatch'
  | 'storage_class_mismatch'
  | 'value_invalid'

export type SqliteTransferPreflightReason =
  | StorageValueErrorCode
  | 'sqlite_integer_not_exact'
  | 'sqlite_text_not_utf8'
  | 'storage_value_inconsistent'

export interface SqliteTransferPreflightReceipt {
  readonly rowCount: number
  readonly cellCount: number
}

export interface SqliteTransferSourceReceipt {
  /** One consistent read snapshot; this does not establish writer exclusion. */
  readonly snapshotAuthority: 'sqlite-read-transaction'
  /** STO-14 must establish the offline writer fence before target writes. */
  readonly writerExclusion: 'not-proven'
  readonly authorizesTargetWrites: false
  readonly schemaVersion: number
  readonly migrationHistoryDigest: string
  readonly schemaObjectCount: number
  readonly schemaObjectDigest: string
  readonly logicalColumnCount: number
  readonly logicalColumnDigest: string
  readonly tableCount: number
  readonly rowCount: number
  readonly cellCount: number
  readonly contentDigest: string
  readonly sourceFingerprint: string
  readonly tables: readonly CanonicalTableDigestReceipt[]
}

export interface SqliteTransferFinding {
  readonly code: 'storage_class_mismatch' | 'value_invalid' | 'constraint_violation'
  readonly table: string
  readonly column: string
  readonly rowOrdinal: number
  readonly primaryKeyColumns: readonly string[]
  readonly reason?: SqliteTransferPreflightReason
}

export interface SqliteTransferSourceOptions {
  /** Called synchronously once for every invalid row/cell; values are never included. */
  readonly onFinding?: (finding: SqliteTransferFinding) => void
}

export class SqliteTransferFindingsError extends Error {
  override readonly name = 'SqliteTransferFindingsError'
  readonly code = 'source_values_invalid' as const

  constructor(
    readonly findingCount: number,
    readonly categoryCounts: Readonly<Record<string, number>>,
  ) {
    super(`SQLite transfer preflight found ${findingCount} incompatible value(s).`)
  }
}

export const SQLITE_V91_SCHEMA_OBJECT_COUNT = 228
export const SQLITE_V91_SCHEMA_OBJECT_HASH =
  'sha256:1fa2468ebe2ed0e986f24f234a29a3120f4f0630517adb7477bd4cec62d06dd1'
/** @deprecated Internal compatibility alias; current schema is v91. */
export const SQLITE_V90_SCHEMA_OBJECT_COUNT = SQLITE_V91_SCHEMA_OBJECT_COUNT
/** @deprecated Internal compatibility alias; current schema is v91. */
export const SQLITE_V90_SCHEMA_OBJECT_HASH = SQLITE_V91_SCHEMA_OBJECT_HASH
/** @deprecated Internal compatibility alias; current schema is v91. */
export const SQLITE_V89_SCHEMA_OBJECT_COUNT = SQLITE_V91_SCHEMA_OBJECT_COUNT
/** @deprecated Internal compatibility alias; current schema is v91. */
export const SQLITE_V89_SCHEMA_OBJECT_HASH = SQLITE_V91_SCHEMA_OBJECT_HASH
/** @deprecated Internal compatibility alias; current schema is v91. */
export const SQLITE_V88_SCHEMA_OBJECT_COUNT = SQLITE_V91_SCHEMA_OBJECT_COUNT
/** @deprecated Internal compatibility alias; current schema is v91. */
export const SQLITE_V88_SCHEMA_OBJECT_HASH = SQLITE_V91_SCHEMA_OBJECT_HASH
/** @deprecated Internal compatibility alias; current schema is v91. */
export const SQLITE_V87_SCHEMA_OBJECT_COUNT = SQLITE_V91_SCHEMA_OBJECT_COUNT
/** @deprecated Internal compatibility alias; current schema is v91. */
export const SQLITE_V87_SCHEMA_OBJECT_HASH = SQLITE_V91_SCHEMA_OBJECT_HASH

const SOURCE_RECEIPT_FORMAT = 'ownware-sqlite-transfer-source-v1'
const MIGRATION_HISTORY_FORMAT = 'ownware-sqlite-transfer-history-v1'
const TRANSFER_EXCLUDED_TABLES: ReadonlySet<string> = new Set(['_migrations'])

/**
 * A content-free transfer diagnostic. Table, column and primary-key *names*
 * come from the certified schema; rowOrdinal identifies the row in the
 * quiescent, deterministically ordered snapshot. Customer values are never
 * attached to the error or interpolated into its message.
 */
export class SqliteTransferPreflightError extends Error {
  override readonly name = 'SqliteTransferPreflightError'
  readonly primaryKeyColumns: readonly string[]

  constructor(
    readonly code: SqliteTransferPreflightErrorCode,
    readonly table: string,
    readonly column: string,
    readonly rowOrdinal: number,
    primaryKeyColumns: readonly string[],
    readonly reason?: SqliteTransferPreflightReason,
  ) {
    const primaryKey = primaryKeyColumns.length === 0
      ? '<none>'
      : primaryKeyColumns.join(',')
    super(
      `SQLite transfer preflight failed (${code}; table=${table}; ` +
      `column=${column}; row=${rowOrdinal}; primary-key=${primaryKey}).`,
    )
    this.primaryKeyColumns = [...primaryKeyColumns]
  }
}

interface TableSchema {
  readonly table: string
  readonly columns: readonly LogicalColumnDescriptor[]
  readonly byName: ReadonlyMap<string, LogicalColumnDescriptor>
  readonly primaryKeyColumns: readonly string[]
}

interface CellLocation {
  readonly table: string
  readonly column: string
  readonly rowOrdinal: number
  readonly primaryKeyColumns: readonly string[]
}

function buildTableSchema(columns: readonly LogicalColumnDescriptor[]): TableSchema {
  const first = columns[0]
  const table = first?.table ?? '<schema>'
  const primaryKeyColumns = columns
    .filter((column) => column.pkPosition > 0)
    .sort((left, right) => left.pkPosition - right.pkPosition)
    .map((column) => column.name)

  if (
    first === undefined ||
    columns.some((column) => column.table !== first.table) ||
    new Set(columns.map((column) => column.name)).size !== columns.length
  ) {
    throw new SqliteTransferPreflightError(
      'table_schema_invalid',
      table,
      '<schema>',
      -1,
      primaryKeyColumns,
    )
  }

  return {
    table,
    columns,
    byName: new Map(columns.map((column) => [column.name, column])),
    primaryKeyColumns,
  }
}

function expectedStorageClasses(
  column: LogicalColumnDescriptor,
): ReadonlySet<SqliteStorageClass> {
  switch (column.kind) {
    case 'text':
    case 'iso-instant':
    case 'json-value':
    case 'json-bytes':
      return new Set(['text'])
    case 'safe-integer':
    case 'epoch-milliseconds':
    case 'boolean':
      return new Set(['integer'])
    case 'finite-real':
      // SQLite REAL affinity can retain an exactly representable integer.
      return new Set(['integer', 'real'])
    case 'binary':
      return new Set(['blob'])
  }
}

function valueForCodec(
  column: LogicalColumnDescriptor,
  cell: SqliteObservedCell,
  location: CellLocation,
): unknown {
  if (cell.storageClass === 'null') {
    if (cell.value !== null) return inconsistent(location)
    return null
  }

  if (!expectedStorageClasses(column).has(cell.storageClass)) {
    return invalid(location, 'storage_class_mismatch')
  }

  if (cell.storageClass === 'text' && cell.rawTextBytes !== undefined) {
    let decoded: string
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(cell.rawTextBytes)
    } catch {
      return invalid(location, 'value_invalid', 'sqlite_text_not_utf8')
    }
    if (decoded !== cell.value) return inconsistent(location)
  }

  if (column.kind === 'boolean' && typeof cell.value === 'bigint') {
    if (cell.value === 0n) return 0
    if (cell.value === 1n) return 1
  }

  if (column.kind === 'finite-real' && cell.storageClass === 'integer') {
    if (typeof cell.value === 'bigint') {
      const number = Number(cell.value)
      if (!Number.isFinite(number) || BigInt(number) !== cell.value) {
        return invalid(location, 'value_invalid', 'sqlite_integer_not_exact')
      }
      return number
    }
    // A driver-returned unsafe Number cannot prove which int64 SQLite stored.
    if (typeof cell.value === 'number' && !Number.isSafeInteger(cell.value)) {
      return invalid(location, 'value_invalid', 'sqlite_integer_not_exact')
    }
  }

  return cell.value
}

function invalid(
  location: CellLocation,
  code: SqliteTransferPreflightErrorCode,
  reason?: SqliteTransferPreflightReason,
): never {
  throw new SqliteTransferPreflightError(
    code,
    location.table,
    location.column,
    location.rowOrdinal,
    location.primaryKeyColumns,
    reason,
  )
}

function inconsistent(location: CellLocation): never {
  return invalid(location, 'value_invalid', 'storage_value_inconsistent')
}

function valuesForRow(
  schema: TableSchema,
  row: SqliteObservedRow,
  onFinding?: (finding: SqliteTransferFinding) => void,
): readonly unknown[] | null {
  if (!Number.isSafeInteger(row.rowOrdinal) || row.rowOrdinal < 0) {
    throw new SqliteTransferPreflightError(
      'row_location_invalid',
      schema.table,
      '<row>',
      -1,
      schema.primaryKeyColumns,
    )
  }
  if (row.table !== schema.table) {
    throw new SqliteTransferPreflightError(
      'table_mismatch',
      schema.table,
      '<table>',
      row.rowOrdinal,
      schema.primaryKeyColumns,
    )
  }

  const cellNames = row.cells.map((cell) => cell.name)
  if (
    row.cells.length !== schema.columns.length ||
    new Set(cellNames).size !== row.cells.length ||
    cellNames.some((name) => !schema.byName.has(name))
  ) {
    throw new SqliteTransferPreflightError(
      'cell_set_mismatch',
      schema.table,
      '<column-set>',
      row.rowOrdinal,
      schema.primaryKeyColumns,
    )
  }

  const byName = new Map(row.cells.map((cell) => [cell.name, cell]))
  const values: unknown[] = []
  let valid = true
  for (const column of schema.columns) {
    const cell = byName.get(column.name)
    if (cell === undefined) {
      throw new SqliteTransferPreflightError(
        'cell_set_mismatch',
        schema.table,
        '<column-set>',
        row.rowOrdinal,
        schema.primaryKeyColumns,
      )
    }
    const location: CellLocation = {
      table: schema.table,
      column: column.name,
      rowOrdinal: row.rowOrdinal,
      primaryKeyColumns: schema.primaryKeyColumns,
    }
    try {
      const value = valueForCodec(column, cell, location)
      normalizeProjectedStorageValue(
        column.kind,
        column.nullable,
        column.postgresqlProjection,
        value,
      )
      values.push(value)
    } catch (error) {
      if (error instanceof SqliteTransferPreflightError) {
        if (
          onFinding !== undefined &&
          (error.code === 'storage_class_mismatch' || error.code === 'value_invalid')
        ) {
          onFinding(Object.freeze({
            code: error.code,
            table: error.table,
            column: error.column,
            rowOrdinal: error.rowOrdinal,
            primaryKeyColumns: Object.freeze([...error.primaryKeyColumns]),
            ...(error.reason === undefined ? {} : { reason: error.reason }),
          }))
          valid = false
          continue
        }
        throw error
      }
      if (error instanceof StorageValueError) {
        if (onFinding !== undefined) {
          onFinding(Object.freeze({
            code: 'value_invalid',
            table: location.table,
            column: location.column,
            rowOrdinal: location.rowOrdinal,
            primaryKeyColumns: Object.freeze([...location.primaryKeyColumns]),
            reason: error.code,
          }))
          valid = false
          continue
        }
        return invalid(location, 'value_invalid', error.code)
      }
      throw error
    }
  }
  return valid ? values : null
}

function validateRow(schema: TableSchema, row: SqliteObservedRow): void {
  valuesForRow(schema, row)
}

/**
 * Validates one complete, already-quiescent table snapshot before callers open
 * a target write transaction. This intentionally accepts a materialized array:
 * a streaming copy must perform a separate full preflight pass rather than
 * interleave validation with target writes.
 */
export function assertSqliteTransferSnapshot(
  columns: readonly LogicalColumnDescriptor[],
  rows: readonly SqliteObservedRow[],
): SqliteTransferPreflightReceipt {
  const schema = buildTableSchema(columns)
  for (const row of rows) validateRow(schema, row)
  return {
    rowCount: rows.length,
    cellCount: rows.length * columns.length,
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function physicalColumns(db: SqliteDatabase): readonly PhysicalColumnDescriptor[] {
  const tables = db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ readonly name: string }>
  return tables.flatMap(({ name: table }) => (
    db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).all() as Array<{
      readonly name: string
      readonly type: string
      readonly notnull: number | bigint
      readonly dflt_value: unknown
      readonly pk: number | bigint
      readonly hidden: number | bigint
    }>
  ).map((column) => ({
    table,
    name: column.name,
    declaredType: column.type,
    notNull: Number(column.notnull) === 1,
    defaultValue: column.dflt_value,
    pkPosition: Number(column.pk),
    hidden: Number(column.hidden),
  })))
}

interface SqliteSchemaObject {
  readonly type: string
  readonly name: string
  readonly tableName: string
  readonly sql: string | null
}

export function sqliteSchemaObjectReceipt(
  db: SqliteDatabase,
): { readonly count: number; readonly digest: string } {
  const objects = db.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name, tbl_name
  `).all() as SqliteSchemaObject[]
  return {
    count: objects.length,
    digest: `sha256:${createHash('sha256')
      .update(JSON.stringify(objects))
      .digest('hex')}`,
  }
}

function migrationHistoryDigest(db: SqliteDatabase): string {
  const rows = db.prepare(`
    SELECT version, name, fingerprint
    FROM _migrations
    ORDER BY version
  `).all() as Array<{
    readonly version: number | bigint
    readonly name: string
    readonly fingerprint: string | null
  }>
  const normalized = rows.map((row) => ({
    version: Number(row.version),
    name: row.name,
    fingerprint: row.fingerprint,
  }))
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([MIGRATION_HISTORY_FORMAT, normalized]))
    .digest('hex')}`
}

function failDatabase(code: SqliteTransferPreflightErrorCode): never {
  throw new SqliteTransferPreflightError(
    code,
    '<database>',
    '<database>',
    -1,
    [],
  )
}

function numericPragma(db: SqliteDatabase, name: 'data_version'): number {
  const value = db.pragma(name, { simple: true })
  const numeric = typeof value === 'bigint'
    ? Number(value)
    : typeof value === 'number' ? value : Number.NaN
  if (!Number.isSafeInteger(numeric) || numeric < 0) return failDatabase('source_changed')
  return numeric
}

function orderExpression(column: LogicalColumnDescriptor): string {
  const name = quoteIdentifier(column.name)
  switch (column.kind) {
    case 'text':
    case 'iso-instant':
    case 'json-value':
    case 'json-bytes':
      return `${name} COLLATE BINARY ASC`
    case 'safe-integer':
    case 'epoch-milliseconds':
    case 'boolean':
    case 'finite-real':
    case 'binary':
      return `${name} ASC`
  }
}

function scanTable(
  db: SqliteDatabase,
  constraintValidator: SqliteDatabase,
  columns: readonly LogicalColumnDescriptor[],
  onFinding: (finding: SqliteTransferFinding) => void,
): CanonicalTableDigestReceipt | null {
  const schema = buildTableSchema(columns)
  const values = columns.map((column, index) => (
    `${quoteIdentifier(column.name)} AS ${quoteIdentifier(`value_${index}`)}`
  ))
  const types = columns.map((column, index) => (
    `typeof(${quoteIdentifier(column.name)}) AS ${quoteIdentifier(`type_${index}`)}`
  ))
  const rawText = columns.map((column, index) => (
    column.declaredType === 'TEXT'
      ? `CAST(${quoteIdentifier(column.name)} AS BLOB) AS ${quoteIdentifier(`raw_text_${index}`)}`
      : `NULL AS ${quoteIdentifier(`raw_text_${index}`)}`
  ))
  const primaryKey = columns
    .filter((column) => column.pkPosition > 0)
    .sort((left, right) => left.pkPosition - right.pkPosition)
  if (primaryKey.length === 0) return invalid({
    table: schema.table,
    column: '<primary-key>',
    rowOrdinal: -1,
    primaryKeyColumns: [],
  }, 'table_schema_invalid')

  const statement = db.prepare(`
    SELECT ${[...values, ...types, ...rawText].join(', ')}
    FROM ${quoteIdentifier(schema.table)}
    ORDER BY ${primaryKey.map(orderExpression).join(', ')}
  `)
  const constraintInsert = constraintValidator.prepare(`
    INSERT INTO ${quoteIdentifier(schema.table)} (
      ${columns.map((column) => quoteIdentifier(column.name)).join(', ')}
    ) VALUES (${columns.map(() => '?').join(', ')})
  `)
  const constraintClear = constraintValidator.prepare(
    `DELETE FROM ${quoteIdentifier(schema.table)}`,
  )
  const digest = new CanonicalTableDigest(columns)
  let digestValid = true
  let rowOrdinal = 0
  for (const raw of statement.iterate() as Iterable<Record<string, unknown>>) {
    const observed: SqliteObservedRow = {
      table: schema.table,
      rowOrdinal,
      cells: columns.map((column, index) => ({
        name: column.name,
        storageClass: raw[`type_${index}`] as SqliteStorageClass,
        value: raw[`value_${index}`],
        ...(raw[`type_${index}`] === 'text'
          ? { rawTextBytes: raw[`raw_text_${index}`] as Uint8Array }
          : {}),
      })),
    }
    const canonicalValues = valuesForRow(schema, observed, onFinding)
    if (canonicalValues === null) {
      digestValid = false
      rowOrdinal += 1
      continue
    }
    try {
      constraintInsert.run(...canonicalValues)
      constraintClear.run()
    } catch {
      onFinding(Object.freeze({
        code: 'constraint_violation',
        table: schema.table,
        column: '<constraint>',
        rowOrdinal,
        primaryKeyColumns: Object.freeze([...schema.primaryKeyColumns]),
      }))
      digestValid = false
      rowOrdinal += 1
      continue
    }
    if (digestValid) digest.append(rowOrdinal, canonicalValues)
    rowOrdinal += 1
  }
  return digestValid ? digest.finish() : null
}

function createConstraintValidator(db: SqliteDatabase): SqliteDatabase {
  const validator = openSqliteDatabase(':memory:')
  try {
    validator.pragma('foreign_keys = OFF')
    validator.pragma('ignore_check_constraints = OFF')
    const tables = db.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ readonly sql: string | null }>
    for (const table of tables) {
      if (typeof table.sql !== 'string' || table.sql.trim().length === 0) {
        validator.close()
        return failDatabase('schema_objects_mismatch')
      }
      validator.exec(table.sql)
    }
    return validator
  } catch {
    try {
      validator.close()
    } catch {
      // Content-free failure below is authoritative.
    }
    return failDatabase('schema_objects_mismatch')
  }
}

function sourceFingerprint(input: {
  readonly schemaVersion: number
  readonly migrationHistoryDigest: string
  readonly schemaObjectDigest: string
  readonly logicalColumnDigest: string
  readonly contentDigest: string
}): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([SOURCE_RECEIPT_FORMAT, input]))
    .digest('hex')}`
}

/**
 * Preflight the snapshot visible through an already-open SQLite handle.
 * The caller owns transaction and lifecycle authority; STO-14 uses this only
 * after acquiring its `BEGIN IMMEDIATE` writer fence.
 */
export function preflightOpenSqliteTransferSnapshot(
  db: SqliteDatabase,
  options: SqliteTransferSourceOptions = {},
): SqliteTransferSourceReceipt {
  let schemaVersion: number
  try {
    // This helper is deliberately re-entrant inside STO-14's one fenced
    // transaction. History validation owns ordinary small Numbers; reset the
    // per-handle delivery mode before switching back to exact int64 rows below.
    db.defaultSafeIntegers(false)
    schemaVersion = assertCurrentSqliteMigrationHistory(db, MIGRATIONS)
  } catch (error) {
    if (error instanceof MigrationSafetyError) {
      return failDatabase('migration_history_mismatch')
    }
    throw error
  }
  // History validation above expects ordinary small migration integers. Data
  // scanning below switches to exact int64 delivery so no customer integer is
  // rounded before the safe-range codec observes it.
  db.defaultSafeIntegers(true)

  const objects = sqliteSchemaObjectReceipt(db)
  if (
    objects.count !== SQLITE_V90_SCHEMA_OBJECT_COUNT ||
    objects.digest !== SQLITE_V90_SCHEMA_OBJECT_HASH
  ) {
    return failDatabase('schema_objects_mismatch')
  }

  const physical = physicalColumns(db)
  if (
    physical.length !== SQLITE_V90_COLUMN_COUNT ||
    physicalColumnSetHash(physical) !== SQLITE_V90_COLUMN_SET_HASH
  ) {
    return failDatabase('schema_objects_mismatch')
  }
  let logical: readonly LogicalColumnDescriptor[]
  try {
    logical = classifyLogicalColumns(physical)
  } catch {
    return failDatabase('schema_objects_mismatch')
  }

  const integrity = db.pragma('integrity_check(1)', { simple: true })
  if (integrity !== 'ok') return failDatabase('integrity_check_failed')
  const foreignKeyViolation = db.prepare('PRAGMA foreign_key_check').get()
  if (foreignKeyViolation !== undefined) return failDatabase('foreign_key_violation')

  const byTable = new Map<string, LogicalColumnDescriptor[]>()
  for (const column of logical) {
    const existing = byTable.get(column.table)
    if (existing === undefined) byTable.set(column.table, [column])
    else existing.push(column)
  }
  const tables: CanonicalTableDigestReceipt[] = []
  let findingCount = 0
  const categoryCounts = new Map<string, number>()
  const onFinding = (finding: SqliteTransferFinding): void => {
    findingCount += 1
    const category = finding.reason ?? finding.code
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)
    options.onFinding?.(finding)
  }
  const constraintValidator = createConstraintValidator(db)
  try {
    for (const table of [...byTable.keys()].sort()) {
      if (TRANSFER_EXCLUDED_TABLES.has(table)) continue
      const columns = byTable.get(table)
      if (columns === undefined) return failDatabase('table_schema_invalid')
      try {
        const receipt = scanTable(db, constraintValidator, columns, onFinding)
        if (receipt !== null) tables.push(receipt)
      } catch (error) {
        if (
          error instanceof SqliteTransferPreflightError ||
          error instanceof CanonicalStorageDigestError
        ) {
          throw error
        }
        return failDatabase('value_invalid')
      }
    }
  } finally {
    constraintValidator.close()
  }
  if (findingCount > 0) {
    throw new SqliteTransferFindingsError(
      findingCount,
      Object.freeze(Object.fromEntries(
        [...categoryCounts.entries()].sort(([left], [right]) => (
          left < right ? -1 : left > right ? 1 : 0
        )),
      )),
    )
  }

  const content = digestCanonicalDatabase(tables)
  const historyDigest = migrationHistoryDigest(db)
  const receiptCore = {
    schemaVersion,
    migrationHistoryDigest: historyDigest,
    schemaObjectDigest: objects.digest,
    logicalColumnDigest: logicalColumnSetHash(logical),
    contentDigest: content.digest,
  }
  return Object.freeze({
    snapshotAuthority: 'sqlite-read-transaction' as const,
    writerExclusion: 'not-proven' as const,
    authorizesTargetWrites: false as const,
    ...receiptCore,
    schemaObjectCount: objects.count,
    logicalColumnCount: logical.length,
    tableCount: content.tableCount,
    rowCount: content.rowCount,
    cellCount: content.cellCount,
    sourceFingerprint: sourceFingerprint(receiptCore),
    tables: Object.freeze(tables.map((table) => Object.freeze({ ...table }))),
  })
}

/**
 * Open a source file read-only and preflight one consistent SQLite snapshot.
 * Re-run and compare the receipt at the STO-14 cutover fence; this function
 * never opens a target or writes a business row.
 */
export function preflightSqliteTransferSource(
  dbPath: string,
  options: SqliteTransferSourceOptions = {},
): SqliteTransferSourceReceipt {
  if (typeof dbPath !== 'string' || dbPath.length === 0) {
    return failDatabase('database_open_failed')
  }
  let db: SqliteDatabase | null = null
  try {
    db = openSqliteDatabase(dbPath, { readonly: true, fileMustExist: true })
    const before = numericPragma(db, 'data_version')
    db.exec('BEGIN')
    let receipt: SqliteTransferSourceReceipt
    try {
      receipt = preflightOpenSqliteTransferSnapshot(db, options)
      db.exec('COMMIT')
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK')
      throw error
    }
    const after = numericPragma(db, 'data_version')
    if (after !== before) return failDatabase('source_changed')
    return receipt
  } catch (error) {
    if (
      error instanceof SqliteTransferPreflightError ||
      error instanceof SqliteTransferFindingsError ||
      error instanceof CanonicalStorageDigestError
    ) {
      throw error
    }
    return failDatabase('database_open_failed')
  } finally {
    try {
      db?.close()
    } catch {
      // A handle that did not close cleanly cannot yield a success receipt.
      return failDatabase('database_open_failed')
    }
  }
}

/** Refuse a source whose canonical schema/history/content changed after preflight. */
export function assertSqliteTransferSourceUnchanged(
  expected: SqliteTransferSourceReceipt,
  current: SqliteTransferSourceReceipt,
): void {
  if (
    expected.schemaVersion !== current.schemaVersion ||
    expected.migrationHistoryDigest !== current.migrationHistoryDigest ||
    expected.schemaObjectDigest !== current.schemaObjectDigest ||
    expected.logicalColumnDigest !== current.logicalColumnDigest ||
    expected.sourceFingerprint !== current.sourceFingerprint
  ) {
    return failDatabase('source_receipt_mismatch')
  }
}
