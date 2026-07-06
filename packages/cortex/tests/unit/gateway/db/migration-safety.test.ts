import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Migration } from '../../../../src/gateway/db/schema.js'
import {
  runMigrationsSafely,
  snapshotDatabase,
  restoreSnapshot,
  pruneBackups,
  MigrationSafetyError,
} from '../../../../src/gateway/db/migration-safety.js'

// A migration set that creates a table and seeds a row at v1, then adds a
// column at v2. v3 is intentionally broken (references a missing table).
const GOOD_V1: Migration = {
  version: 1,
  name: '001_init',
  sql: `
    CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);
    INSERT INTO notes (id, body) VALUES (1, 'precious user data');
  `,
}
const GOOD_V2: Migration = {
  version: 2,
  name: '002_add_col',
  sql: `ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;`,
}
const BROKEN_V3: Migration = {
  version: 3,
  name: '003_broken',
  sql: `INSERT INTO table_that_does_not_exist (x) VALUES (1);`,
}

describe('migration-safety', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortex-migsafe-'))
    dbPath = join(dir, 'ownware.db')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function openAndMigrate(migrations: readonly Migration[]): Database.Database {
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    runMigrationsSafely(db, dbPath, migrations)
    return db
  }

  it('applies pending migrations and sets user_version', () => {
    const db = openAndMigrate([GOOD_V1, GOOD_V2])
    const max = db.prepare('SELECT MAX(version) v FROM _migrations').get() as { v: number }
    expect(max.v).toBe(2)
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    const note = db.prepare('SELECT body, pinned FROM notes WHERE id = 1').get() as {
      body: string
      pinned: number
    }
    expect(note.body).toBe('precious user data')
    db.close()
  })

  it('does NOT snapshot a brand-new (v0) database', () => {
    openAndMigrate([GOOD_V1]).close()
    // No backups dir / no .bak should exist for a fresh DB — nothing to lose.
    const backups = existsSync(join(dir, 'backups'))
      ? readdirSync(join(dir, 'backups'))
      : []
    expect(backups).toHaveLength(0)
  })

  it('snapshots before upgrading an existing DB, and the snapshot is a real copy', () => {
    openAndMigrate([GOOD_V1]).close() // now at v1 with data
    openAndMigrate([GOOD_V1, GOOD_V2]).close() // upgrade v1 -> v2, should snapshot first

    const backups = readdirSync(join(dir, 'backups'))
    expect(backups.some((f) => f.includes('.v1.') && f.endsWith('.bak'))).toBe(true)

    // The snapshot must be openable and contain the pre-upgrade data.
    const snap = join(dir, 'backups', backups.find((f) => f.includes('.v1.'))!)
    const snapDb = new Database(snap, { readonly: true })
    const row = snapDb.prepare('SELECT body FROM notes WHERE id = 1').get() as { body: string }
    expect(row.body).toBe('precious user data')
    snapDb.close()
  })

  it('RESTORES the database when a migration fails — data returns intact', () => {
    openAndMigrate([GOOD_V1, GOOD_V2]).close() // at v2 with data

    // Now try to go v2 -> v3 with a broken migration. It must throw AND restore.
    expect(() => openAndMigrate([GOOD_V1, GOOD_V2, BROKEN_V3])).toThrow(
      MigrationSafetyError,
    )

    // After the failed+restored migration, reopen: still at v2, data intact,
    // and v3 is NOT recorded.
    const db = new Database(dbPath)
    const max = db.prepare('SELECT MAX(version) v FROM _migrations').get() as { v: number }
    expect(max.v).toBe(2)
    const note = db.prepare('SELECT body FROM notes WHERE id = 1').get() as { body: string }
    expect(note.body).toBe('precious user data')
    db.close()
  })

  it('refuses to run on a DB newer than the code understands (downgrade guard)', () => {
    openAndMigrate([GOOD_V1, GOOD_V2, { version: 3, name: '003_ok', sql: 'SELECT 1;' }]).close()
    // Reopen with code that only knows up to v2 → must refuse.
    const db = new Database(dbPath)
    expect(() => runMigrationsSafely(db, dbPath, [GOOD_V1, GOOD_V2])).toThrow(
      /newer version of Ownware/,
    )
    db.close()
  })

  it('pruneBackups keeps only the newest N', () => {
    const db = openAndMigrate([GOOD_V1])
    // Take several snapshots, then prune to 2.
    for (let i = 0; i < 4; i++) snapshotDatabase(db, dbPath, 1)
    pruneBackups(join(dir, 'backups'), 'ownware.db', 2)
    const remaining = readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.bak'))
    expect(remaining.length).toBeLessThanOrEqual(2)
    db.close()
  })

  it('restoreSnapshot replaces the live DB and clears WAL sidecars', () => {
    const db = openAndMigrate([GOOD_V1])
    const snap = snapshotDatabase(db, dbPath, 1)
    db.prepare('UPDATE notes SET body = ? WHERE id = 1').run('mutated after snapshot')
    db.close()

    restoreSnapshot(snap, dbPath)
    expect(existsSync(`${dbPath}-wal`)).toBe(false)

    const reopened = new Database(dbPath)
    const row = reopened.prepare('SELECT body FROM notes WHERE id = 1').get() as { body: string }
    expect(row.body).toBe('precious user data') // restored, not the mutation
    reopened.close()
  })
})
