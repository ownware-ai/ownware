import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS } from '../../../../src/gateway/db/schema.js'
import {
  MigrationSafetyError,
  migrationFingerprint,
  runMigrationsSafely,
} from '../../../../src/gateway/db/migration-safety.js'

describe('migration 082 — authoritative migration fingerprints', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortex-migration-082-'))
    dbPath = join(dir, 'ownware.db')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function open(): Database.Database {
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    return db
  }

  it('upgrades a populated v81 DB without inventing fingerprints for legacy rows', () => {
    const before = open()
    runMigrationsSafely(before, dbPath, MIGRATIONS.filter((migration) => migration.version <= 81))
    before.prepare(
      `INSERT INTO threads (id, profile_id, title) VALUES ('thread_m082', 'test-agent', 'preserve me')`,
    ).run()
    before.close()

    const upgraded = open()
    runMigrationsSafely(upgraded, dbPath, MIGRATIONS)
    const fingerprintMigration = MIGRATIONS.find((migration) => migration.version === 82)!
    expect(upgraded.prepare(
      `SELECT version, name, fingerprint FROM _migrations WHERE version IN (1, 81, 82)
       ORDER BY version`,
    ).all()).toEqual([
      { version: 1, name: MIGRATIONS[0]!.name, fingerprint: null },
      { version: 81, name: MIGRATIONS[80]!.name, fingerprint: null },
      {
        version: 82,
        name: fingerprintMigration.name,
        fingerprint: migrationFingerprint(fingerprintMigration),
      },
    ])
    expect(upgraded.prepare(`SELECT title FROM threads WHERE id = 'thread_m082'`).get())
      .toEqual({ title: 'preserve me' })
    upgraded.close()
  })

  it('reproduces the real failure class: matching max version but divergent history', () => {
    const db = open()
    runMigrationsSafely(db, dbPath, MIGRATIONS.filter((migration) => migration.version <= 81))
    db.prepare(
      `UPDATE _migrations SET name = '079_alternate_branch_history' WHERE version = 79`,
    ).run()

    expect(() => runMigrationsSafely(db, dbPath, MIGRATIONS)).toThrow(MigrationSafetyError)
    try {
      runMigrationsSafely(db, dbPath, MIGRATIONS)
    } catch (error) {
      expect((error as MigrationSafetyError).userAction).toBe('contact-support')
      expect((error as Error).message).not.toContain('alternate_branch_history')
    }
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('_migrations')
                  WHERE name = 'fingerprint'`).get(),
    ).toEqual({ n: 0 })
    expect(readdirSync(dir).filter((name) => name === 'backups')).toEqual([])
    db.close()
  })

  it('rejects a changed v82 definition after it has been recorded', () => {
    const db = open()
    runMigrationsSafely(db, dbPath, MIGRATIONS)
    const changed = MIGRATIONS.map((migration) => (
      migration.version === 82
        ? { ...migration, sql: `${migration.sql}\n-- changed after application` }
        : migration
    ))
    expect(() => runMigrationsSafely(db, dbPath, changed)).toThrow(/history does not match/i)
    db.close()
  })
})
