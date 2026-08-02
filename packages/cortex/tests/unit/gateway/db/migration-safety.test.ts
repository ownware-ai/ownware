import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import type { Migration } from '../../../../src/gateway/db/schema.js'
import {
  runMigrationsSafely,
  snapshotDatabase,
  restoreSnapshot,
  pruneBackups,
  MigrationSafetyError,
  migrationFingerprint,
  validateMigrationManifest,
  openDatabaseSafely,
  sqliteMigrationLockPath,
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
const FINGERPRINT_V3: Migration = {
  version: 3,
  name: '003_migration_fingerprints',
  recordsFingerprint: true,
  sql: `ALTER TABLE _migrations ADD COLUMN fingerprint TEXT;`,
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

  it('refuses a competing process before opening the main DB and recovers after its crash', async () => {
    const fixture = fileURLToPath(new URL(
      '../../../fixtures/hold-sqlite-migration-lock.cjs',
      import.meta.url,
    ))
    const holder = spawn(process.execPath, [fixture, sqliteMigrationLockPath(dbPath)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    holder.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject)
      holder.once('exit', (code) => {
        reject(new Error(`lock holder exited before ready (${String(code)}): ${stderr}`))
      })
      holder.stdout?.once('data', (chunk: Buffer) => {
        if (chunk.toString().includes('locked')) resolve()
        else reject(new Error(`unexpected lock-holder output: ${chunk.toString()}`))
      })
    })

    try {
      expect(() => openDatabaseSafely(
        dbPath,
        (database) => database.pragma('foreign_keys = ON'),
        [GOOD_V1],
        { migrationLockTimeoutMs: 25 },
      )).toThrow(/another ownware process/i)
      expect(existsSync(dbPath)).toBe(false)
    } finally {
      holder.kill('SIGKILL')
      await once(holder, 'exit')
    }

    const reopened = openDatabaseSafely(
      dbPath,
      (database) => database.pragma('foreign_keys = ON'),
      [GOOD_V1],
      { migrationLockTimeoutMs: 250 },
    )
    expect(reopened.prepare('SELECT body FROM notes WHERE id = 1').get())
      .toEqual({ body: 'precious user data' })
    reopened.close()
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

  it('refuses a divergent applied migration name before snapshot or pending writes', () => {
    openAndMigrate([GOOD_V1]).close()
    const tamper = new Database(dbPath)
    tamper.prepare(`UPDATE _migrations SET name = '001_other_branch' WHERE version = 1`).run()
    tamper.close()

    const db = new Database(dbPath)
    let thrown: unknown
    try {
      runMigrationsSafely(db, dbPath, [GOOD_V1, GOOD_V2])
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(MigrationSafetyError)
    expect((thrown as MigrationSafetyError).userAction).toBe('contact-support')
    expect((thrown as Error).message).toMatch(/history does not match/i)
    expect(existsSync(join(dir, 'backups'))).toBe(false)
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('notes') WHERE name = 'pinned'`).get(),
    ).toEqual({ n: 0 })
    expect(db.prepare(`SELECT body FROM notes WHERE id = 1`).get()).toEqual({
      body: 'precious user data',
    })
    db.close()
  })

  it('refuses a blank, gapped, or duplicate compiled manifest before DB writes', () => {
    expect(() => validateMigrationManifest([
      GOOD_V1,
      { version: 3, name: '003_gap', sql: 'SELECT 1;' },
    ])).toThrow(MigrationSafetyError)
    expect(() => validateMigrationManifest([
      GOOD_V1,
      { version: 2, name: GOOD_V1.name, sql: 'SELECT 1;' },
    ])).toThrow(MigrationSafetyError)
    expect(() => validateMigrationManifest([
      { version: 1, name: '', sql: 'SELECT 1;' },
    ])).toThrow(MigrationSafetyError)
    expect(existsSync(dbPath)).toBe(false)
  })

  it('refuses an existing empty or malformed applied-history table', () => {
    for (const [index, sql] of [
      `CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL)`,
      `CREATE TABLE _migrations (version INTEGER PRIMARY KEY)`,
    ].entries()) {
      const path = join(dir, `malformed-${index}.db`)
      const db = new Database(path)
      db.exec(sql)
      expect(() => runMigrationsSafely(db, path, [GOOD_V1])).toThrow(MigrationSafetyError)
      expect(existsSync(join(dir, 'backups'))).toBe(false)
      db.close()
    }
  })

  it.each([
    ['gapped', [[1, GOOD_V1.name], [3, '003_other']]],
    ['duplicate', [[1, GOOD_V1.name], [1, GOOD_V1.name]]],
  ] as const)('refuses %s applied-history rows', (_label, rows) => {
    const db = new Database(dbPath)
    db.exec(`CREATE TABLE _migrations (version INTEGER, name TEXT NOT NULL)`)
    const insert = db.prepare(`INSERT INTO _migrations (version, name) VALUES (?, ?)`)
    for (const row of rows) insert.run(...row)
    expect(() => runMigrationsSafely(db, dbPath, [GOOD_V1, GOOD_V2])).toThrow(
      MigrationSafetyError,
    )
    db.close()
  })

  it('rolls back an opt-in migration that does not establish its fingerprint column', () => {
    const invalidOptIn: Migration = {
      ...FINGERPRINT_V3,
      sql: `ALTER TABLE notes ADD COLUMN category TEXT;`,
    }
    const db = openAndMigrate([GOOD_V1, GOOD_V2])
    expect(() => runMigrationsSafely(db, dbPath, [GOOD_V1, GOOD_V2, invalidOptIn])).toThrow(
      MigrationSafetyError,
    )
    const restored = new Database(dbPath)
    expect(
      restored.prepare(
        `SELECT COUNT(*) AS n FROM pragma_table_info('notes') WHERE name = 'category'`,
      ).get(),
    ).toEqual({ n: 0 })
    expect(restored.prepare(`SELECT MAX(version) AS version FROM _migrations`).get())
      .toEqual({ version: 2 })
    restored.close()
  })

  it('records fingerprints from the opt-in migration and rejects later drift', () => {
    const migrations = [GOOD_V1, GOOD_V2, FINGERPRINT_V3]
    const db = openAndMigrate(migrations)
    const rows = db.prepare(
      `SELECT version, fingerprint FROM _migrations ORDER BY version`,
    ).all() as Array<{ version: number; fingerprint: string | null }>
    expect(rows).toEqual([
      { version: 1, fingerprint: null },
      { version: 2, fingerprint: null },
      { version: 3, fingerprint: migrationFingerprint(FINGERPRINT_V3) },
    ])

    db.prepare(`UPDATE _migrations SET fingerprint = 'sha256:tampered' WHERE version = 3`).run()
    expect(() => runMigrationsSafely(db, dbPath, migrations)).toThrow(/history does not match/i)
    db.close()
  })

  it('requires a fingerprint for every applied migration at or after opt-in', () => {
    const migrations = [GOOD_V1, GOOD_V2, FINGERPRINT_V3]
    const db = openAndMigrate(migrations)
    db.prepare(`UPDATE _migrations SET fingerprint = NULL WHERE version = 3`).run()
    expect(() => runMigrationsSafely(db, dbPath, migrations)).toThrow(/history does not match/i)
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
