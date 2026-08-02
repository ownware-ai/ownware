import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SqliteTransferPreflightError,
  assertSqliteTransferSnapshot,
  type SqliteObservedRow,
  type SqliteStorageClass,
} from '../../../src/storage/sqlite-transfer-preflight.js'
import type {
  LogicalColumnDescriptor,
} from '../../../src/storage/logical-schema.js'
import type { LogicalValueKind } from '../../../src/storage/value-codec.js'

const postgresqlTypes: Record<LogicalValueKind, LogicalColumnDescriptor['postgresqlType']> = {
  text: 'TEXT',
  'safe-integer': 'BIGINT',
  'epoch-milliseconds': 'BIGINT',
  boolean: 'BOOLEAN',
  'finite-real': 'DOUBLE PRECISION',
  'iso-instant': 'TEXT',
  'json-value': 'TEXT',
  'json-bytes': 'TEXT',
  binary: 'BYTEA',
}

function column(
  name: string,
  kind: LogicalValueKind,
  options: { nullable?: boolean; pkPosition?: number } = {},
): LogicalColumnDescriptor {
  const nullable = options.nullable ?? false
  const pkPosition = options.pkPosition ?? 0
  return {
    table: 'probe',
    name,
    key: `probe.${name}`,
    declaredType: kind === 'finite-real'
      ? 'REAL'
      : kind === 'safe-integer' || kind === 'epoch-milliseconds' || kind === 'boolean'
        ? 'INTEGER'
        : kind === 'binary' ? 'BLOB' : 'TEXT',
    notNull: !nullable,
    nullable,
    defaultValue: null,
    pkPosition,
    hidden: 0,
    kind,
    postgresqlType: postgresqlTypes[kind],
    postgresqlProjection: 'identity',
  }
}

const columns = [
  column('id', 'text', { pkPosition: 1 }),
  column('ordinal', 'safe-integer'),
  column('flag', 'boolean'),
  column('epoch', 'epoch-milliseconds'),
  column('amount', 'finite-real'),
  column('instant', 'iso-instant'),
  column('payload', 'json-value'),
  column('exact_json', 'json-bytes'),
  column('bytes', 'binary'),
  column('note', 'text', { nullable: true }),
] as const

interface RawProbeRow extends Record<string, unknown> {
  readonly id: string
}

function observe(db: Database.Database): SqliteObservedRow[] {
  const valueExpressions = columns.map((entry) => `"${entry.name}"`).join(', ')
  const typeExpressions = columns
    .map((entry) => `typeof("${entry.name}") AS "type_${entry.name}"`)
    .join(', ')
  const rows = db.prepare(`
    SELECT ${valueExpressions}, ${typeExpressions}
    FROM probe
    ORDER BY id ASC
  `).all() as RawProbeRow[]
  return rows.map((row, rowOrdinal) => ({
    table: 'probe',
    rowOrdinal,
    cells: columns.map((entry) => ({
      name: entry.name,
      storageClass: row[`type_${entry.name}`] as SqliteStorageClass,
      value: row[entry.name],
    })),
  }))
}

describe('SQLite transfer preflight', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    // int64 values must be observed exactly, not after Number rounding.
    db.defaultSafeIntegers(true)
    db.exec(`
      CREATE TABLE probe (
        id TEXT PRIMARY KEY,
        ordinal INTEGER NOT NULL,
        flag INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        amount REAL NOT NULL,
        instant TEXT NOT NULL,
        payload TEXT NOT NULL,
        exact_json TEXT NOT NULL,
        bytes BLOB NOT NULL,
        note TEXT
      )
    `)
  })

  afterEach(() => db.close())

  it('accepts every declared SQLite storage class and reports content-free counts', () => {
    db.prepare(`
      INSERT INTO probe VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'row-a',
      BigInt(Number.MAX_SAFE_INTEGER),
      1n,
      1_785_662_400_123n,
      1.25,
      '2026-08-02T04:05:06.123Z',
      '{ "z": 1, "a": true }',
      '{ "signature_input": true }',
      Buffer.from([0, 1, 255]),
      null,
    )
    expect(assertSqliteTransferSnapshot(columns, observe(db))).toEqual({
      rowCount: 1,
      cellCount: columns.length,
    })
  })

  it('rejects affinity-compatible malformed text before any target write', () => {
    const canary = 'customer-secret-canary'
    db.prepare(`
      INSERT INTO probe VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'row-secret',
      canary,
      1n,
      1n,
      1.5,
      '2026-08-02T00:00:00Z',
      '{}',
      '{}',
      Buffer.from([1]),
      null,
    )
    const writeTarget = vi.fn()

    let error: unknown
    try {
      assertSqliteTransferSnapshot(columns, observe(db))
      writeTarget()
    } catch (caught) {
      error = caught
    }

    expect(writeTarget).not.toHaveBeenCalled()
    expect(error).toMatchObject({
      code: 'storage_class_mismatch',
      table: 'probe',
      column: 'ordinal',
      rowOrdinal: 0,
      primaryKeyColumns: ['id'],
    })
    expect(String(error)).not.toContain(canary)
    expect(String(error)).not.toContain('row-secret')
  })

  it('rejects invalid values inside a valid storage class', () => {
    db.prepare(`
      INSERT INTO probe VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'row-a',
      1n,
      2n,
      1n,
      1.5,
      '2026-08-02T00:00:00Z',
      '{}',
      '{}',
      Buffer.from([1]),
      null,
    )
    expect(() => assertSqliteTransferSnapshot(columns, observe(db))).toThrow(
      expect.objectContaining<Partial<SqliteTransferPreflightError>>({
        code: 'value_invalid',
        column: 'flag',
        reason: 'type_mismatch',
      }),
    )
  })

  it('fails closed for unknown, missing, duplicate, or cross-table cells', () => {
    const valid = {
      table: 'probe',
      rowOrdinal: 0,
      cells: columns.map((entry) => ({
        name: entry.name,
        storageClass: 'null' as const,
        value: null,
      })),
    }
    for (const row of [
      { ...valid, cells: valid.cells.slice(1) },
      { ...valid, cells: [...valid.cells.slice(1), { ...valid.cells[0]!, name: 'future' }] },
      { ...valid, cells: [...valid.cells.slice(1), valid.cells[1]!] },
      { ...valid, table: 'future_table' },
    ]) {
      expect(() => assertSqliteTransferSnapshot(columns, [row])).toThrow(
        SqliteTransferPreflightError,
      )
    }
  })

  it('rejects an int64 that cannot cross a JavaScript safe-integer boundary', () => {
    db.prepare(`
      INSERT INTO probe VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'row-a',
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      1n,
      1n,
      1.5,
      '2026-08-02T00:00:00Z',
      '{}',
      '{}',
      Buffer.from([1]),
      null,
    )
    expect(() => assertSqliteTransferSnapshot(columns, observe(db))).toThrow(
      expect.objectContaining<Partial<SqliteTransferPreflightError>>({
        code: 'value_invalid',
        column: 'ordinal',
        reason: 'integer_out_of_range',
      }),
    )
  })
})
