import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Migration } from '../../../../src/gateway/db/schema.js'
import {
  openDatabaseSafely,
  snapshotDatabase,
  findLatestBackup,
  isDatabaseCorruptError,
  MigrationSafetyError,
} from '../../../../src/gateway/db/migration-safety.js'

const V1: Migration = {
  version: 1,
  name: '001_init',
  sql: `
    CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);
    INSERT INTO notes (id, body) VALUES (1, 'precious user data');
  `,
}
const V2: Migration = {
  version: 2,
  name: '002_add_col',
  sql: `ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;`,
}

const configure = (db: Database.Database): void => {
  // The WAL pragma is the first real touch of the file — a malformed file
  // throws SQLITE_NOTADB here, which is exactly the corrupt-open path.
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
}

describe('database corruption recovery (B3 / E8)', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortex-corrupt-'))
    dbPath = join(dir, 'ownware.db')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('isDatabaseCorruptError distinguishes corruption from ordinary errors', () => {
    expect(isDatabaseCorruptError({ code: 'SQLITE_NOTADB' })).toBe(true)
    expect(isDatabaseCorruptError({ code: 'SQLITE_CORRUPT_VTAB' })).toBe(true)
    expect(isDatabaseCorruptError(new Error('database disk image is malformed'))).toBe(true)
    expect(isDatabaseCorruptError(new Error('file is not a database'))).toBe(true)
    expect(isDatabaseCorruptError(new Error('no such table: notes'))).toBe(false)
    expect(isDatabaseCorruptError(new Error('SQLITE_BUSY'))).toBe(false)
    expect(isDatabaseCorruptError(null)).toBe(false)
  })

  it('opens + migrates a brand-new database (no recovery, no corrupt files)', () => {
    const db = openDatabaseSafely(dbPath, configure, [V1, V2])
    const max = db.prepare('SELECT MAX(version) v FROM _migrations').get() as { v: number }
    expect(max.v).toBe(2)
    db.close()
    expect(readdirSync(dir).some((f) => f.includes('.corrupt.'))).toBe(false)
  })

  it('reopens a healthy existing database without setting anything aside', () => {
    openDatabaseSafely(dbPath, configure, [V1, V2]).close()
    const db = openDatabaseSafely(dbPath, configure, [V1, V2])
    const row = db.prepare('SELECT body FROM notes WHERE id = 1').get() as { body: string }
    expect(row.body).toBe('precious user data')
    db.close()
    expect(readdirSync(dir).some((f) => f.includes('.corrupt.'))).toBe(false)
  })

  it('auto-recovers a corrupt file from the latest backup', () => {
    // 1. Healthy DB at v1 with data, and a real snapshot in backups/.
    const db = openDatabaseSafely(dbPath, configure, [V1])
    const version = db.prepare('SELECT MAX(version) v FROM _migrations').get() as { v: number }
    snapshotDatabase(db, dbPath, version.v)
    db.close()
    // Drop WAL sidecars so the corruption is unambiguously on the main file.
    for (const s of ['-wal', '-shm']) rmSync(`${dbPath}${s}`, { force: true })

    // 2. Corrupt the live DB file.
    writeFileSync(dbPath, Buffer.from('this is definitely not a sqlite database'))
    expect(findLatestBackup(dbPath)).not.toBeNull()

    // 3. Open with a NEWER migration set — recovery restores the backup, then
    //    migrates the restored data forward to v2.
    const recovered = openDatabaseSafely(dbPath, configure, [V1, V2])
    const row = recovered.prepare('SELECT body, pinned FROM notes WHERE id = 1').get() as {
      body: string
      pinned: number
    }
    expect(row.body).toBe('precious user data') // data preserved from backup
    expect(row.pinned).toBe(0) // v2 migration applied to the restored DB
    expect(
      (recovered.prepare('SELECT MAX(version) v FROM _migrations').get() as { v: number }).v,
    ).toBe(2)
    recovered.close()

    // The corrupt original was set aside (not deleted), not silently dropped.
    expect(readdirSync(dir).some((f) => f.startsWith('ownware.db.corrupt.'))).toBe(true)
  })

  it('throws a clear, actionable error when corrupt AND no backup exists', () => {
    writeFileSync(dbPath, Buffer.from('garbage, and there is no backup to fall back to'))
    expect(() => openDatabaseSafely(dbPath, configure, [V1, V2])).toThrow(MigrationSafetyError)
    try {
      openDatabaseSafely(dbPath, configure, [V1, V2])
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationSafetyError)
      expect((err as MigrationSafetyError).category).toBe('sqlite')
      expect((err as Error).message).toMatch(/damaged/i)
      expect((err as Error).message).toMatch(/no automatic backup/i)
    }
  })
})
