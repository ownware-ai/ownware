import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import { runMigrationsSafely } from '../../../src/gateway/db/migration-safety.js'
import {
  LogicalSchemaError,
  SQLITE_V93_COLUMN_COUNT,
  SQLITE_V93_COLUMN_SET_HASH,
  classifyLogicalColumns,
  physicalColumnSetHash,
  type PhysicalColumnDescriptor,
} from '../../../src/storage/logical-schema.js'
import {
  encodeCanonicalStorageValue,
  type LogicalValueKind,
} from '../../../src/storage/value-codec.js'

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

describe('v93 logical storage schema', () => {
  let dir: string
  let db: Database.Database
  let columns: PhysicalColumnDescriptor[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortex-logical-schema-'))
    const dbPath = join(dir, 'schema.db')
    db = new Database(dbPath)
    db.pragma('foreign_keys = ON')
    runMigrationsSafely(db, dbPath, MIGRATIONS)
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>
    columns = tables.flatMap(({ name: table }) => (
      db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).all() as Array<{
        name: string
        type: string
        notnull: number
        dflt_value: unknown
        pk: number
        hidden: number
      }>
    ).map((column) => ({
      table,
      name: column.name,
      declaredType: column.type,
      notNull: column.notnull === 1,
      defaultValue: column.dflt_value,
      pkPosition: column.pk,
      hidden: column.hidden,
    })))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('classifies every live column against an exact structural receipt', () => {
    expect(columns).toHaveLength(SQLITE_V93_COLUMN_COUNT)
    expect(physicalColumnSetHash(columns)).toBe(SQLITE_V93_COLUMN_SET_HASH)
    const classified = classifyLogicalColumns(columns)
    expect(classified).toHaveLength(SQLITE_V93_COLUMN_COUNT)
    expect(new Set(classified.map((column) => column.key)).size).toBe(
      SQLITE_V93_COLUMN_COUNT,
    )

    const counts = Object.fromEntries(
      [...Map.groupBy(classified, (column) => column.kind)]
        .map(([kind, entries]) => [kind, entries.length])
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    )
    expect(counts).toEqual({
      boolean: 10,
      'epoch-milliseconds': 103,
      'finite-real': 11,
      'iso-instant': 54,
      'json-value': 41,
      'safe-integer': 95,
      text: 556,
    })
  })

  it('maps logical kinds to an explicit PostgreSQL type without using jsonb', () => {
    const classified = classifyLogicalColumns(columns)
    const counts = Object.fromEntries(
      [...Map.groupBy(classified, (column) => column.postgresqlType)]
        .map(([type, entries]) => [type, entries.length])
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    )
    expect(counts).toEqual({
      BIGINT: 198,
      BOOLEAN: 10,
      'DOUBLE PRECISION': 11,
      TEXT: 651,
    })
    expect(classified.find((column) => column.key === 'agent_events.payload'))
      .toMatchObject({ kind: 'json-value', postgresqlType: 'TEXT' })
    expect(classified.find((column) => column.key === 'audit_log.detail'))
      .toMatchObject({ kind: 'text', postgresqlType: 'TEXT' })
    expect(classified.find((column) => column.key === 'messages.message_seq'))
      .toMatchObject({ kind: 'safe-integer', nullable: false, postgresqlType: 'BIGINT' })
    expect(classified.filter(
      (column) => column.postgresqlProjection === 'postgresql-text-key-v1',
    ).map((column) => column.key)).toEqual([
      'run_idempotency.principal_key',
      'source_upload_sessions.principal_key',
    ])
  })

  it('drives every live column through its declared canonical value codec', () => {
    const examples: Record<LogicalValueKind, unknown> = {
      text: 'value',
      'safe-integer': Number.MAX_SAFE_INTEGER,
      'epoch-milliseconds': 1_785_662_400_123,
      boolean: true,
      'finite-real': 1.25,
      'iso-instant': '2026-08-02T00:00:00.000Z',
      'json-value': '{ "z": 1, "a": [true, null] }',
      'json-bytes': '{ "exact": true }',
      binary: new Uint8Array([0, 255]),
    }
    const classified = classifyLogicalColumns(columns)
    const encoded = classified.map((column) => encodeCanonicalStorageValue(
      column.kind,
      column.nullable,
      examples[column.kind],
      column.postgresqlProjection,
    ))
    expect(encoded).toHaveLength(SQLITE_V93_COLUMN_COUNT)
    expect(encoded.every((value) => value.length > 0)).toBe(true)
  })

  it('makes primary keys logically non-null even where SQLite omits NOT NULL', () => {
    const classified = classifyLogicalColumns(columns)
    expect(classified.find((column) => column.key === 'threads.id'))
      .toMatchObject({ pkPosition: 1, notNull: false, nullable: false })
    expect(classified.find((column) => column.key === 'threads.title'))
      .toMatchObject({ pkPosition: 0, notNull: false, nullable: true })
  })

  it('fails closed for an added, removed, renamed, or retyped column', () => {
    const added = [...columns, {
      table: 'future_table',
      name: 'unknown_value',
      declaredType: 'TEXT',
      notNull: false,
      defaultValue: null,
      pkPosition: 0,
      hidden: 0,
    }]
    expect(() => classifyLogicalColumns(added)).toThrow(
      expect.objectContaining<Partial<LogicalSchemaError>>({ code: 'column_count_mismatch' }),
    )
    expect(() => classifyLogicalColumns(columns.slice(1))).toThrow(LogicalSchemaError)

    const renamed = columns.map((column, index) => (
      index === 0 ? { ...column, name: 'unknown_column' } : column
    ))
    expect(() => classifyLogicalColumns(renamed)).toThrow(
      expect.objectContaining<Partial<LogicalSchemaError>>({ code: 'column_set_mismatch' }),
    )

    const retyped = columns.map((column) => (
      column.table === 'agent_events' && column.name === 'payload'
        ? { ...column, declaredType: 'INTEGER' }
        : column
    ))
    expect(() => classifyLogicalColumns(retyped)).toThrow(LogicalSchemaError)
  })
})
