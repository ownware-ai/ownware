import { createHash, type Hash } from 'node:crypto'
import type { LogicalColumnDescriptor } from './logical-schema.js'
import {
  encodeCanonicalStorageValue,
  StorageValueError,
  type StorageValueErrorCode,
} from './value-codec.js'

const TABLE_FORMAT = 'ownware-storage-table-v1'
const ROW_FORMAT = 'ownware-storage-row-v1'
const DATABASE_FORMAT = 'ownware-storage-database-v1'

export type CanonicalStorageDigestErrorCode =
  | 'table_schema_invalid'
  | 'row_ordinal_invalid'
  | 'cell_count_mismatch'
  | 'value_invalid'
  | 'table_set_invalid'

/** Content-free canonicalization failure safe for a transfer receipt. */
export class CanonicalStorageDigestError extends Error {
  override readonly name = 'CanonicalStorageDigestError'

  constructor(
    readonly code: CanonicalStorageDigestErrorCode,
    readonly table: string,
    readonly column: string,
    readonly rowOrdinal: number,
    readonly reason?: StorageValueErrorCode,
  ) {
    super(
      `Canonical storage digest failed (${code}; table=${table}; ` +
      `column=${column}; row=${rowOrdinal}).`,
    )
  }
}

export interface CanonicalTableDigestReceipt {
  readonly table: string
  readonly rowCount: number
  readonly cellCount: number
  readonly digest: string
}

export interface CanonicalDatabaseDigestReceipt {
  readonly tableCount: number
  readonly rowCount: number
  readonly cellCount: number
  readonly digest: string
}

function writeFrame(hash: Hash, value: string): void {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.allocUnsafe(8)
  length.writeBigUInt64BE(BigInt(bytes.byteLength))
  hash.update(length)
  hash.update(bytes)
}

function sha256(hash: Hash): string {
  return `sha256:${hash.digest('hex')}`
}

function tableSchema(
  columns: readonly LogicalColumnDescriptor[],
): { readonly table: string; readonly columns: readonly LogicalColumnDescriptor[] } {
  const first = columns[0]
  const table = first?.table ?? '<schema>'
  if (
    first === undefined ||
    columns.some((column) => column.table !== table) ||
    new Set(columns.map((column) => column.name)).size !== columns.length ||
    columns.filter((column) => column.pkPosition > 0).length === 0
  ) {
    throw new CanonicalStorageDigestError(
      'table_schema_invalid',
      table,
      '<schema>',
      -1,
    )
  }
  return { table, columns }
}

/**
 * Incremental digest for rows already supplied in the adapter's canonical
 * primary-key order. Only one row is retained while it is encoded.
 */
export class CanonicalTableDigest {
  private readonly table: string
  private readonly columns: readonly LogicalColumnDescriptor[]
  private readonly hash = createHash('sha256')
  private rowCount = 0
  private finished: CanonicalTableDigestReceipt | null = null

  constructor(columns: readonly LogicalColumnDescriptor[]) {
    const schema = tableSchema(columns)
    this.table = schema.table
    this.columns = schema.columns
    writeFrame(this.hash, JSON.stringify([
      TABLE_FORMAT,
      this.table,
      this.columns.map((column) => [
        column.name,
        column.kind,
        column.nullable,
        column.pkPosition,
        column.postgresqlProjection,
      ]),
    ]))
  }

  append(rowOrdinal: number, values: readonly unknown[]): void {
    if (this.finished !== null) {
      throw new CanonicalStorageDigestError(
        'row_ordinal_invalid',
        this.table,
        '<row>',
        rowOrdinal,
      )
    }
    if (!Number.isSafeInteger(rowOrdinal) || rowOrdinal !== this.rowCount) {
      throw new CanonicalStorageDigestError(
        'row_ordinal_invalid',
        this.table,
        '<row>',
        Number.isSafeInteger(rowOrdinal) ? rowOrdinal : -1,
      )
    }
    if (values.length !== this.columns.length) {
      throw new CanonicalStorageDigestError(
        'cell_count_mismatch',
        this.table,
        '<column-set>',
        rowOrdinal,
      )
    }

    const cells: Array<readonly [string, string]> = []
    for (let index = 0; index < this.columns.length; index += 1) {
      const column = this.columns[index]!
      try {
        cells.push([
          column.name,
          encodeCanonicalStorageValue(
            column.kind,
            column.nullable,
            values[index],
            column.postgresqlProjection,
          ),
        ])
      } catch (error) {
        if (error instanceof StorageValueError) {
          throw new CanonicalStorageDigestError(
            'value_invalid',
            this.table,
            column.name,
            rowOrdinal,
            error.code,
          )
        }
        throw error
      }
    }
    writeFrame(this.hash, JSON.stringify([ROW_FORMAT, cells]))
    this.rowCount += 1
  }

  finish(): CanonicalTableDigestReceipt {
    if (this.finished === null) {
      this.finished = Object.freeze({
        table: this.table,
        rowCount: this.rowCount,
        cellCount: this.rowCount * this.columns.length,
        digest: sha256(this.hash),
      })
    }
    return this.finished
  }
}

/** Digest content-free table receipts in exact table-name order. */
export function digestCanonicalDatabase(
  tables: readonly CanonicalTableDigestReceipt[],
): CanonicalDatabaseDigestReceipt {
  const ordered = [...tables].sort((left, right) => (
    left.table < right.table ? -1 : left.table > right.table ? 1 : 0
  ))
  if (
    ordered.some((table, index) => (
      table.table.length === 0 ||
      table.rowCount < 0 ||
      table.cellCount < 0 ||
      !/^sha256:[0-9a-f]{64}$/.test(table.digest) ||
      (index > 0 && table.table === ordered[index - 1]?.table)
    ))
  ) {
    throw new CanonicalStorageDigestError(
      'table_set_invalid',
      '<database>',
      '<table-set>',
      -1,
    )
  }

  const hash = createHash('sha256')
  writeFrame(hash, DATABASE_FORMAT)
  let rowCount = 0
  let cellCount = 0
  for (const table of ordered) {
    writeFrame(hash, JSON.stringify([
      table.table,
      table.rowCount,
      table.cellCount,
      table.digest,
    ]))
    rowCount += table.rowCount
    cellCount += table.cellCount
    if (!Number.isSafeInteger(rowCount) || !Number.isSafeInteger(cellCount)) {
      throw new CanonicalStorageDigestError(
        'table_set_invalid',
        '<database>',
        '<count>',
        -1,
      )
    }
  }
  return Object.freeze({
    tableCount: ordered.length,
    rowCount,
    cellCount,
    digest: sha256(hash),
  })
}
