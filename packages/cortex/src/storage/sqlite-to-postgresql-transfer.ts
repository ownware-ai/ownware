import type { PostgreSqlClient, PostgreSqlPoolClient } from './postgresql-driver.js'
import { POSTGRESQL_MIGRATION_MANIFEST } from './postgresql-migrations.js'
import {
  canonicalPostgreSqlTransferSnapshot,
  canonicalPostgreSqlTransferSnapshotWithinTransaction,
  currentPostgreSqlLogicalColumns,
  type PostgreSqlCanonicalSnapshotReceipt,
} from './postgresql-canonical-snapshot.js'
import { encodePostgreSqlTextKey } from './postgresql-repository.js'
import {
  lockAndValidateEmptyPostgreSqlTransferTarget,
  POSTGRESQL_TRANSFER_BUSINESS_TABLES,
  preflightPostgreSqlTransferTarget,
  type PostgreSqlTransferTargetReceipt,
} from './postgresql-transfer-preflight.js'
import { openSqliteDatabase, type SqliteDatabase } from './sqlite-driver.js'
import {
  assertSqliteTransferSourceUnchanged,
  preflightOpenSqliteTransferSnapshot,
  type SqliteTransferSourceReceipt,
} from './sqlite-transfer-preflight.js'
import type { LogicalColumnDescriptor } from './logical-schema.js'
import { normalizeProjectedStorageValue } from './value-codec.js'

type SessionClient = Pick<PostgreSqlClient | PostgreSqlPoolClient, 'query'>

const TRANSFER_LOCK_NAMESPACE = 1_398_031_360
const TRANSFER_LOCK_KEY = 14
const INSERT_BATCH_SIZE = 128
const CURRENT_SCHEMA_VERSION = POSTGRESQL_MIGRATION_MANIFEST.migrations.at(-1)!.version

export type OfflineTransferErrorCode =
  | 'invalid_input'
  | 'source_fence_unavailable'
  | 'source_changed'
  | 'target_not_ready'
  | 'target_changed'
  | 'cancelled'
  | 'copy_failed'
  | 'verification_failed'
  | 'target_commit_unconfirmed'
  | 'target_rollback_unconfirmed'
  | 'target_committed_unverified'
  | 'source_release_failed'

export class OfflineTransferError extends Error {
  override readonly name = 'OfflineTransferError'

  constructor(readonly code: OfflineTransferErrorCode) {
    super(`Offline SQLite-to-PostgreSQL transfer failed (${code}).`)
  }
}

export type OfflineTransferProgress =
  | { readonly phase: 'source_fenced' }
  | { readonly phase: 'target_locked' }
  | { readonly phase: 'batch_copied'; readonly table: string; readonly rowCount: number }
  | { readonly phase: 'table_copied'; readonly table: string; readonly rowCount: number }
  | { readonly phase: 'target_verified_before_commit' }
  | { readonly phase: 'target_committed' }
  | { readonly phase: 'target_verified_after_commit' }

export interface OfflineSqliteToPostgreSqlTransferOptions {
  /** Existing source preflight; the fenced snapshot must match it exactly. */
  readonly expectedSource: SqliteTransferSourceReceipt
  /** Existing target preflight; the write-boundary preflight must still match. */
  readonly expectedTarget: PostgreSqlTransferTargetReceipt
  readonly sourcePath: string
  /** Two connected sessions, even when both use the same combined role. */
  readonly targetMigration: SessionClient
  readonly targetRuntime: SessionClient
  readonly sourceFenceTimeoutMs?: number
  readonly signal?: AbortSignal
  /** Content-free progress for a local operator UI and deterministic cancellation. */
  readonly onProgress?: (progress: OfflineTransferProgress) => void
}

export interface OfflineSqliteToPostgreSqlTransferReceipt {
  readonly status: 'ready-for-explicit-cutover'
  readonly sourceAuthority: 'sqlite-immediate-transaction'
  readonly sourceRemainsAuthoritative: true
  readonly targetCommitted: true
  readonly targetVerified: true
  readonly cutoverAutomatic: false
  readonly rollbackMode: 'reuse-unchanged-sqlite-before-target-runtime-writes'
  readonly schemaVersion: number
  readonly tableCount: number
  readonly rowCount: number
  readonly cellCount: number
  readonly contentDigest: string
  readonly sourceFingerprint: string
  readonly targetDatabaseIdentityDigest: string
}

interface ForeignKeyEdge {
  readonly child_table: string
  readonly parent_table: string
  readonly deferrable: boolean
}

function fail(code: OfflineTransferErrorCode): never {
  throw new OfflineTransferError(code)
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) return fail('cancelled')
}

function notify(
  options: OfflineSqliteToPostgreSqlTransferOptions,
  progress: OfflineTransferProgress,
): void {
  try {
    options.onProgress?.(Object.freeze(progress))
  } catch {
    return fail('cancelled')
  }
}

function sourceComparable(receipt: SqliteTransferSourceReceipt): object {
  return {
    schemaVersion: receipt.schemaVersion,
    logicalColumnCount: receipt.logicalColumnCount,
    logicalColumnDigest: receipt.logicalColumnDigest,
    tableCount: receipt.tableCount,
    rowCount: receipt.rowCount,
    cellCount: receipt.cellCount,
    contentDigest: receipt.contentDigest,
    tables: receipt.tables,
  }
}

function targetComparable(receipt: PostgreSqlCanonicalSnapshotReceipt): object {
  return {
    schemaVersion: receipt.schemaVersion,
    logicalColumnCount: receipt.logicalColumnCount,
    logicalColumnDigest: receipt.logicalColumnDigest,
    tableCount: receipt.tableCount,
    rowCount: receipt.rowCount,
    cellCount: receipt.cellCount,
    contentDigest: receipt.contentDigest,
    tables: receipt.tables,
  }
}

function assertCanonicalEquality(
  source: SqliteTransferSourceReceipt,
  target: PostgreSqlCanonicalSnapshotReceipt,
): void {
  if (JSON.stringify(sourceComparable(source)) !== JSON.stringify(targetComparable(target))) {
    return fail('verification_failed')
  }
}

function sameTargetPreflight(
  expected: PostgreSqlTransferTargetReceipt,
  current: PostgreSqlTransferTargetReceipt,
): boolean {
  return JSON.stringify(expected) === JSON.stringify(current)
}

function sourceOrderExpression(column: LogicalColumnDescriptor): string {
  const identifier = quoteIdentifier(column.name)
  switch (column.kind) {
    case 'text':
    case 'iso-instant':
    case 'json-value':
    case 'json-bytes':
      return `${identifier} COLLATE BINARY ASC`
    case 'safe-integer':
    case 'epoch-milliseconds':
    case 'boolean':
    case 'finite-real':
    case 'binary':
      return `${identifier} ASC`
  }
}

function sqliteLogicalValue(column: LogicalColumnDescriptor, value: unknown): unknown {
  if (column.kind === 'boolean' && typeof value === 'bigint') {
    if (value === 0n) return 0
    if (value === 1n) return 1
  }
  if (column.kind === 'finite-real' && typeof value === 'bigint') {
    const number = Number(value)
    if (!Number.isFinite(number) || BigInt(number) !== value) return fail('copy_failed')
    return number
  }
  return value
}

function targetValue(column: LogicalColumnDescriptor, raw: unknown): unknown {
  const logical = sqliteLogicalValue(column, raw)
  const normalized = normalizeProjectedStorageValue(
    column.kind,
    column.nullable,
    column.postgresqlProjection,
    logical,
  )
  if (normalized === null) return null
  if (column.postgresqlProjection === 'postgresql-text-key-v1') {
    return encodePostgreSqlTextKey(normalized as string)
  }
  switch (column.kind) {
    case 'boolean':
    case 'safe-integer':
    case 'epoch-milliseconds':
    case 'finite-real':
      return normalized
    case 'binary':
      return Buffer.from(normalized as Uint8Array)
    case 'text':
    case 'iso-instant':
    case 'json-value':
    case 'json-bytes':
      // Preserve accepted source bytes for TEXT/JSON; the codec call above is
      // validation, while canonical receipts own semantic comparison.
      return logical
  }
}

function columnsByTable(): ReadonlyMap<string, readonly LogicalColumnDescriptor[]> {
  const currentColumns = currentPostgreSqlLogicalColumns()
  const grouped = new Map<string, LogicalColumnDescriptor[]>()
  for (const column of currentColumns) {
    if (column.table === '_migrations') continue
    const columns = grouped.get(column.table)
    if (columns === undefined) grouped.set(column.table, [column])
    else columns.push(column)
  }
  const names = [...grouped.keys()].sort()
  if (
    JSON.stringify(names) !== JSON.stringify(POSTGRESQL_TRANSFER_BUSINESS_TABLES) ||
    [...grouped.values()].reduce((count, columns) => count + columns.length, 0) !==
      currentColumns.filter((column) => column.table !== '_migrations').length
  ) {
    return fail('target_changed')
  }
  return grouped
}

async function foreignKeySafeOrder(client: SessionClient): Promise<readonly string[]> {
  const result = await client.query<ForeignKeyEdge>(`
    SELECT
      child.relname::text AS child_table,
      parent.relname::text AS parent_table,
      constraint_record.condeferrable AS deferrable
    FROM pg_catalog.pg_constraint AS constraint_record
    JOIN pg_catalog.pg_class AS child ON child.oid = constraint_record.conrelid
    JOIN pg_catalog.pg_class AS parent ON parent.oid = constraint_record.confrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = child.relnamespace
    JOIN pg_catalog.pg_namespace AS parent_namespace
      ON parent_namespace.oid = parent.relnamespace
    WHERE constraint_record.contype = 'f'
      AND namespace.nspname = 'ownware'
      AND parent_namespace.nspname = 'ownware'
    ORDER BY child.relname, parent.relname, constraint_record.conname
  `)
  const tables = new Set<string>(POSTGRESQL_TRANSFER_BUSINESS_TABLES)
  const outgoing = new Map<string, Set<string>>()
  const indegree = new Map<string, number>(
    POSTGRESQL_TRANSFER_BUSINESS_TABLES.map((table) => [table, 0]),
  )
  for (const edge of result.rows) {
    if (!tables.has(edge.child_table) || !tables.has(edge.parent_table)) {
      return fail('target_changed')
    }
    if (edge.deferrable) continue
    if (edge.child_table === edge.parent_table) return fail('target_changed')
    const children = outgoing.get(edge.parent_table) ?? new Set<string>()
    if (!children.has(edge.child_table)) {
      children.add(edge.child_table)
      outgoing.set(edge.parent_table, children)
      indegree.set(edge.child_table, (indegree.get(edge.child_table) ?? 0) + 1)
    }
  }

  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([table]) => table)
    .sort()
  const ordered: string[] = []
  while (ready.length > 0) {
    const table = ready.shift()!
    ordered.push(table)
    for (const child of [...(outgoing.get(table) ?? [])].sort()) {
      const remaining = (indegree.get(child) ?? 0) - 1
      indegree.set(child, remaining)
      if (remaining === 0) {
        ready.push(child)
        ready.sort()
      }
    }
  }
  if (ordered.length !== POSTGRESQL_TRANSFER_BUSINESS_TABLES.length) {
    return fail('target_changed')
  }
  return ordered
}

async function insertBatch(
  target: SessionClient,
  table: string,
  columns: readonly LogicalColumnDescriptor[],
  rows: readonly (readonly unknown[])[],
): Promise<void> {
  if (rows.length === 0) return
  const parameters: unknown[] = []
  const tuples = rows.map((row) => {
    if (row.length !== columns.length) return fail('copy_failed')
    const placeholders = row.map((value) => {
      parameters.push(value)
      return `$${parameters.length}`
    })
    return `(${placeholders.join(', ')})`
  })
  await target.query(`
    INSERT INTO ownware.${quoteIdentifier(table)} (
      ${columns.map((column) => quoteIdentifier(column.name)).join(', ')}
    ) VALUES ${tuples.join(', ')}
  `, parameters)
}

async function copyTable(
  source: SqliteDatabase,
  target: SessionClient,
  table: string,
  columns: readonly LogicalColumnDescriptor[],
  options: OfflineSqliteToPostgreSqlTransferOptions,
): Promise<number> {
  const primaryKey = columns
    .filter((column) => column.pkPosition > 0)
    .sort((left, right) => left.pkPosition - right.pkPosition)
  if (primaryKey.length === 0) return fail('target_changed')
  const statement = source.prepare(`
    SELECT ${columns.map((column, index) => (
      `${quoteIdentifier(column.name)} AS ${quoteIdentifier(`value_${index}`)}`
    )).join(', ')}
    FROM ${quoteIdentifier(table)}
    ORDER BY ${primaryKey.map(sourceOrderExpression).join(', ')}
  `)
  const pending: unknown[][] = []
  let copied = 0
  for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
    assertNotCancelled(options.signal)
    pending.push(columns.map((column, index) => (
      targetValue(column, row[`value_${index}`])
    )))
    if (pending.length === INSERT_BATCH_SIZE) {
      await insertBatch(target, table, columns, pending)
      copied += pending.length
      pending.length = 0
      notify(options, { phase: 'batch_copied', table, rowCount: copied })
      assertNotCancelled(options.signal)
    }
  }
  if (pending.length > 0) {
    await insertBatch(target, table, columns, pending)
    copied += pending.length
    pending.length = 0
    notify(options, { phase: 'batch_copied', table, rowCount: copied })
    assertNotCancelled(options.signal)
  }
  notify(options, { phase: 'table_copied', table, rowCount: copied })
  return copied
}

function validOptions(options: OfflineSqliteToPostgreSqlTransferOptions): boolean {
  const timeout = options.sourceFenceTimeoutMs ?? 5_000
  return typeof options.sourcePath === 'string' && options.sourcePath.length > 0 &&
    Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 60_000 &&
    options.expectedTarget.state === 'schema_current_empty_ready' &&
    options.expectedTarget.schemaVersion === CURRENT_SCHEMA_VERSION &&
    options.expectedSource.schemaVersion === CURRENT_SCHEMA_VERSION &&
    options.expectedSource.tableCount === POSTGRESQL_TRANSFER_BUSINESS_TABLES.length
}

/**
 * Copy one fenced SQLite snapshot into one exact empty PostgreSQL target.
 * PostgreSQL receives all business rows in one SERIALIZABLE transaction. The
 * source transaction is always rolled back and SQLite remains authoritative;
 * success emits a cutover plan, never changes gateway configuration.
 */
export async function transferOfflineSqliteToPostgreSql(
  options: OfflineSqliteToPostgreSqlTransferOptions,
): Promise<OfflineSqliteToPostgreSqlTransferReceipt> {
  if (!validOptions(options)) return fail('invalid_input')
  assertNotCancelled(options.signal)

  let currentTarget: PostgreSqlTransferTargetReceipt
  try {
    currentTarget = await preflightPostgreSqlTransferTarget(
      options.targetMigration,
      options.targetRuntime,
    )
  } catch {
    return fail('target_not_ready')
  }
  if (
    currentTarget.state !== 'schema_current_empty_ready' ||
    !sameTargetPreflight(options.expectedTarget, currentTarget)
  ) {
    return fail('target_changed')
  }

  const timeout = options.sourceFenceTimeoutMs ?? 5_000
  let source: SqliteDatabase | undefined
  try {
    source = openSqliteDatabase(options.sourcePath, {
      fileMustExist: true,
      timeout,
    })
    source.pragma(`busy_timeout = ${timeout}`)
    source.exec('BEGIN IMMEDIATE')
  } catch {
    try {
      source?.close()
    } catch {
      // The content-free fence failure below remains authoritative.
    }
    return fail('source_fence_unavailable')
  }

  let targetTransactionOpen = false
  let targetCommitted = false
  let receipt: OfflineSqliteToPostgreSqlTransferReceipt | undefined
  let failure: OfflineTransferError | undefined
  try {
    let fencedSource: SqliteTransferSourceReceipt
    try {
      fencedSource = preflightOpenSqliteTransferSnapshot(source)
      assertSqliteTransferSourceUnchanged(options.expectedSource, fencedSource)
    } catch {
      return fail('source_changed')
    }
    notify(options, { phase: 'source_fenced' })
    assertNotCancelled(options.signal)

    try {
      await options.targetMigration.query(
        'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE READ WRITE',
      )
      targetTransactionOpen = true
      await options.targetMigration.query(
        'SELECT pg_advisory_xact_lock($1, $2)',
        [TRANSFER_LOCK_NAMESPACE, TRANSFER_LOCK_KEY],
      )
      await lockAndValidateEmptyPostgreSqlTransferTarget(options.targetMigration)
    } catch {
      return fail('target_changed')
    }
    notify(options, { phase: 'target_locked' })
    assertNotCancelled(options.signal)

    try {
      await options.targetMigration.query('SET CONSTRAINTS ALL DEFERRED')
      const grouped = columnsByTable()
      const order = await foreignKeySafeOrder(options.targetMigration)
      for (const table of order) {
        const columns = grouped.get(table)
        if (columns === undefined) return fail('target_changed')
        await copyTable(source, options.targetMigration, table, columns, options)
      }
      await options.targetMigration.query('SET CONSTRAINTS ALL IMMEDIATE')
    } catch (error) {
      if (error instanceof OfflineTransferError) throw error
      return fail('copy_failed')
    }

    let beforeCommit: PostgreSqlCanonicalSnapshotReceipt
    try {
      beforeCommit = await canonicalPostgreSqlTransferSnapshotWithinTransaction(
        options.targetMigration,
      )
      assertCanonicalEquality(fencedSource, beforeCommit)
      const sourceAtCommit = preflightOpenSqliteTransferSnapshot(source)
      assertSqliteTransferSourceUnchanged(fencedSource, sourceAtCommit)
    } catch (error) {
      if (error instanceof OfflineTransferError) throw error
      return fail('verification_failed')
    }
    notify(options, { phase: 'target_verified_before_commit' })

    try {
      await options.targetMigration.query('COMMIT')
      targetTransactionOpen = false
      targetCommitted = true
    } catch {
      // A driver failure at COMMIT cannot prove whether the server committed.
      // SQLite remains authoritative and the target requires fresh inspection.
      return fail('target_commit_unconfirmed')
    }
    notify(options, { phase: 'target_committed' })

    try {
      const committed = await canonicalPostgreSqlTransferSnapshot(options.targetRuntime)
      assertCanonicalEquality(fencedSource, committed)
    } catch {
      return fail('target_committed_unverified')
    }
    notify(options, { phase: 'target_verified_after_commit' })

    receipt = Object.freeze({
      status: 'ready-for-explicit-cutover' as const,
      sourceAuthority: 'sqlite-immediate-transaction' as const,
      sourceRemainsAuthoritative: true as const,
      targetCommitted: true as const,
      targetVerified: true as const,
      cutoverAutomatic: false as const,
      rollbackMode: 'reuse-unchanged-sqlite-before-target-runtime-writes' as const,
      schemaVersion: fencedSource.schemaVersion,
      tableCount: fencedSource.tableCount,
      rowCount: fencedSource.rowCount,
      cellCount: fencedSource.cellCount,
      contentDigest: fencedSource.contentDigest,
      sourceFingerprint: fencedSource.sourceFingerprint,
      targetDatabaseIdentityDigest: currentTarget.databaseIdentityDigest,
    })
  } catch (error) {
    failure = error instanceof OfflineTransferError
      ? error
      : new OfflineTransferError(targetCommitted ? 'target_committed_unverified' : 'copy_failed')
  } finally {
    if (targetTransactionOpen) {
      try {
        await options.targetMigration.query('ROLLBACK')
        targetTransactionOpen = false
      } catch {
        failure = new OfflineTransferError('target_rollback_unconfirmed')
      }
    }
    try {
      if (source.inTransaction) source.exec('ROLLBACK')
      source.close()
    } catch {
      failure ??= new OfflineTransferError('source_release_failed')
    }
  }

  if (failure !== undefined) throw failure
  if (receipt !== undefined) return receipt
  return fail(targetCommitted ? 'target_committed_unverified' : 'copy_failed')
}
