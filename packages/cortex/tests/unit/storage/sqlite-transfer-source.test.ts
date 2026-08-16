import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import { runMigrationsSafely } from '../../../src/gateway/db/migration-safety.js'
import {
  assertSqliteTransferSnapshot,
  SQLITE_V89_SCHEMA_OBJECT_COUNT,
  SQLITE_V89_SCHEMA_OBJECT_HASH,
  SqliteTransferPreflightError,
  SqliteTransferFindingsError,
  assertSqliteTransferSourceUnchanged,
  preflightSqliteTransferSource,
  sqliteSchemaObjectReceipt,
} from '../../../src/storage/sqlite-transfer-preflight.js'
import {
  classifyLogicalColumns,
  SQLITE_V89_COLUMN_COUNT,
  type LogicalColumnDescriptor,
  type PhysicalColumnDescriptor,
} from '../../../src/storage/logical-schema.js'

function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function representativeCell(column: LogicalColumnDescriptor): {
  readonly name: string
  readonly storageClass: 'text' | 'integer' | 'real' | 'blob'
  readonly value: unknown
} {
  switch (column.kind) {
    case 'text':
      return {
        name: column.name,
        storageClass: 'text',
        value: column.postgresqlProjection === 'postgresql-text-key-v1'
          ? 'part-a\0part-b'
          : 'text-value',
      }
    case 'iso-instant':
      return {
        name: column.name,
        storageClass: 'text',
        value: '2026-08-02T00:00:00.000Z',
      }
    case 'json-value':
      return { name: column.name, storageClass: 'text', value: '{"ok":true}' }
    case 'json-bytes':
      return { name: column.name, storageClass: 'text', value: '{ "ok": true }' }
    case 'safe-integer':
    case 'epoch-milliseconds':
      return { name: column.name, storageClass: 'integer', value: 1 }
    case 'boolean':
      return { name: column.name, storageClass: 'integer', value: 1 }
    case 'finite-real':
      return { name: column.name, storageClass: 'real', value: 1.25 }
    case 'binary':
      return { name: column.name, storageClass: 'blob', value: Buffer.from([0, 1, 255]) }
  }
}

describe('SQLite transfer source preflight', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ownware-transfer-source-'))
    dbPath = join(dir, 'source.sqlite')
    const db = new Database(dbPath)
    db.pragma('foreign_keys = ON')
    runMigrationsSafely(db, dbPath, MIGRATIONS)
    db.close()
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('scans the exact current source read-only with bounded per-table receipts', () => {
    const db = new Database(dbPath)
    db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)')
      .run('safe-key', 'customer-secret-canary')
    db.prepare(`
      INSERT INTO run_idempotency (
        id, principal_key, operation, idempotency_key, request_salt,
        request_digest, state, lease_owner, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?)
    `).run(
      'request-a',
      'delegated\0workspace-a\0profile-a',
      'run',
      'key-a',
      'salt-a',
      'digest-a',
      'owner-a',
      1n,
      1n,
      2n,
    )
    expect(sqliteSchemaObjectReceipt(db)).toEqual({
      count: SQLITE_V89_SCHEMA_OBJECT_COUNT,
      digest: SQLITE_V89_SCHEMA_OBJECT_HASH,
    })
    db.close()
    const before = fileDigest(dbPath)

    const receipt = preflightSqliteTransferSource(dbPath)

    expect(receipt).toMatchObject({
      snapshotAuthority: 'sqlite-read-transaction',
      writerExclusion: 'not-proven',
      authorizesTargetWrites: false,
      schemaVersion: 89,
      schemaObjectCount: SQLITE_V89_SCHEMA_OBJECT_COUNT,
      schemaObjectDigest: SQLITE_V89_SCHEMA_OBJECT_HASH,
      logicalColumnCount: SQLITE_V89_COLUMN_COUNT,
      tableCount: 74,
    })
    expect(receipt.tables).toHaveLength(74)
    expect(receipt.tables.map((table) => table.table)).toEqual(
      [...receipt.tables.map((table) => table.table)].sort(),
    )
    expect(receipt.tables.some((table) => table.table === '_migrations')).toBe(false)
    expect(receipt.tables.find((table) => table.table === 'app_state'))
      .toMatchObject({ rowCount: 1, cellCount: 3 })
    expect(receipt.tables.find((table) => table.table === 'run_idempotency'))
      .toMatchObject({ rowCount: 1 })
    expect(receipt.sourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(JSON.stringify(receipt)).not.toContain('customer-secret-canary')
    expect(JSON.stringify(receipt)).not.toContain('safe-key')
    expect(fileDigest(dbPath)).toBe(before)
  })

  it('accepts one strict target-codec representative for every live source column', () => {
    const db = new Database(dbPath)
    const tables = db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ readonly name: string }>
    const physical: PhysicalColumnDescriptor[] = tables.flatMap(({ name: table }) => (
      (db.prepare(`PRAGMA table_xinfo("${table.replaceAll('"', '""')}")`).all() as Array<{
        readonly name: string
        readonly type: string
        readonly notnull: number
        readonly dflt_value: unknown
        readonly pk: number
        readonly hidden: number
      }>).map((column) => ({
        table,
        name: column.name,
        declaredType: column.type,
        notNull: column.notnull === 1,
        defaultValue: column.dflt_value,
        pkPosition: column.pk,
        hidden: column.hidden,
      }))
    ))
    db.close()
    const logical = classifyLogicalColumns(physical)
    const byTable = Map.groupBy(logical, (column) => column.table)
    let observedColumns = 0

    for (const [table, columns] of byTable) {
      const row = {
        table,
        rowOrdinal: 0,
        cells: columns.map((column) => representativeCell(column)),
      }
      expect(assertSqliteTransferSnapshot(columns, [row])).toEqual({
        rowCount: 1,
        cellCount: columns.length,
      })
      observedColumns += columns.length
    }
    expect(observedColumns).toBe(SQLITE_V89_COLUMN_COUNT)
  })

  it('blocks unknown schema objects and divergent history without reflecting them', () => {
    const canary = 'customer-secret-canary'
    const db = new Database(dbPath)
    db.exec(`CREATE INDEX "${canary}" ON app_state(value)`)
    db.close()
    let error: unknown
    try {
      preflightSqliteTransferSource(dbPath)
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: 'schema_objects_mismatch' })
    expect(String(error)).not.toContain(canary)

    const historyPath = join(dir, 'history.sqlite')
    const history = new Database(historyPath)
    history.pragma('foreign_keys = ON')
    runMigrationsSafely(history, historyPath, MIGRATIONS)
    history.prepare('UPDATE _migrations SET name = ? WHERE version = 83').run(canary)
    history.close()
    expect(() => preflightSqliteTransferSource(historyPath)).toThrow(
      expect.objectContaining<Partial<SqliteTransferPreflightError>>({
        code: 'migration_history_mismatch',
      }),
    )
  })

  it('blocks foreign-key and CHECK violations inserted with enforcement disabled', () => {
    const missingParentPath = join(dir, 'missing-parent.sqlite')
    const missingParent = new Database(missingParentPath)
    runMigrationsSafely(missingParent, missingParentPath, MIGRATIONS)
    missingParent.pragma('foreign_keys = OFF')
    missingParent.prepare(`
      INSERT INTO messages (id, thread_id, role, message_seq)
      VALUES ('message-orphan', 'thread-missing', 'user', 1)
    `).run()
    missingParent.close()
    expect(() => preflightSqliteTransferSource(missingParentPath)).toThrow(
      expect.objectContaining<Partial<SqliteTransferPreflightError>>({
        code: 'foreign_key_violation',
      }),
    )

    const checkPath = join(dir, 'bad-check.sqlite')
    const check = new Database(checkPath)
    runMigrationsSafely(check, checkPath, MIGRATIONS)
    check.pragma('foreign_keys = ON')
    check.prepare(`INSERT INTO threads (id, profile_id) VALUES ('thread-a', 'profile-a')`).run()
    check.pragma('ignore_check_constraints = ON')
    check.prepare(`
      INSERT INTO messages (id, thread_id, role, message_seq)
      VALUES ('message-a', 'thread-a', 'user', 0)
    `).run()
    check.close()
    expect(() => preflightSqliteTransferSource(checkPath)).toThrow(
      expect.objectContaining<Partial<SqliteTransferFindingsError>>({
        code: 'source_values_invalid',
        categoryCounts: { constraint_violation: 1 },
      }),
    )
  })

  it('blocks PostgreSQL-incompatible TEXT before a target callback can run', () => {
    const db = new Database(dbPath)
    db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)')
      .run('key', 'before\0after')
    db.close()
    const writeTarget = vi.fn()
    let error: unknown
    try {
      preflightSqliteTransferSource(dbPath)
      writeTarget()
    } catch (caught) {
      error = caught
    }
    expect(writeTarget).not.toHaveBeenCalled()
    expect(error).toMatchObject({ code: 'source_values_invalid', findingCount: 1 })
    expect(String(error)).not.toContain('before')
  })

  it('rejects invalid raw SQLite TEXT bytes before driver replacement can hide them', () => {
    const db = new Database(dbPath)
    db.exec(`INSERT INTO app_state (key, value) VALUES ('key', CAST(X'80' AS TEXT))`)
    db.close()
    const findings: Array<{ readonly reason?: string }> = []
    expect(() => preflightSqliteTransferSource(dbPath, {
      onFinding: (finding) => findings.push(finding),
    })).toThrow(expect.objectContaining<Partial<SqliteTransferFindingsError>>({
      code: 'source_values_invalid',
      categoryCounts: { sqlite_text_not_utf8: 1 },
    }))
    expect(findings).toEqual([
      expect.objectContaining({ reason: 'sqlite_text_not_utf8' }),
    ])
  })

  it('streams every content-free incompatibility before returning non-success', () => {
    const db = new Database(dbPath)
    db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)')
      .run('secret-key-a', 'before\0after')
    db.prepare(`INSERT INTO threads (id, profile_id, pinned) VALUES (?, ?, ?)`)
      .run('secret-thread-b', 'profile-a', 2)
    db.close()
    const findings: Array<{
      readonly table: string
      readonly column: string
      readonly reason?: string
    }> = []

    let error: unknown
    try {
      preflightSqliteTransferSource(dbPath, {
        onFinding: (finding) => findings.push(finding),
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toEqual(expect.objectContaining<Partial<SqliteTransferFindingsError>>({
      code: 'source_values_invalid',
      findingCount: 2,
      categoryCounts: { text_contains_nul: 1, type_mismatch: 1 },
    }))
    expect(findings).toEqual([
      expect.objectContaining({
        table: 'app_state',
        column: 'value',
        reason: 'text_contains_nul',
      }),
      expect.objectContaining({
        table: 'threads',
        column: 'pinned',
        reason: 'type_mismatch',
      }),
    ])
    expect(JSON.stringify(findings)).not.toContain('secret-key-a')
    expect(JSON.stringify(findings)).not.toContain('secret-thread-b')
  })

  it('refuses a source whose exact schema/history/content receipt changed', () => {
    const before = preflightSqliteTransferSource(dbPath)
    const db = new Database(dbPath)
    db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)')
      .run('changed', 'value')
    db.close()
    const after = preflightSqliteTransferSource(dbPath)
    const writeTarget = vi.fn()

    expect(() => {
      assertSqliteTransferSourceUnchanged(before, after)
      writeTarget()
    }).toThrow(expect.objectContaining<Partial<SqliteTransferPreflightError>>({
      code: 'source_receipt_mismatch',
    }))
    expect(writeTarget).not.toHaveBeenCalled()
    expect(after.contentDigest).not.toBe(before.contentDigest)
  })
})
