import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { auditMigrations, runMigrationsSafely } from '../../../src/gateway/db/migration-safety.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

describe('migration 078 delegated thread principal bindings', () => {
  const cleanup: string[] = []

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true })))
  })

  it('adds a private cascade-bound digest without changing historical threads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'thread-principal-binding-migration-'))
    cleanup.push(directory)
    const path = join(directory, 'ownware.db')
    const db = new Database(path)
    runMigrationsSafely(db, path, MIGRATIONS.filter((migration) => migration.version <= 77))
    db.prepare(`
      INSERT INTO threads (
        id, profile_id, title, status, message_count, total_tokens, total_cost,
        created_at, updated_at
      ) VALUES ('thread_legacy', 'mini', NULL, 'completed', 0, 0, 0, ?, ?)
    `).run(new Date(0).toISOString(), new Date(0).toISOString())

    runMigrationsSafely(db, path, MIGRATIONS.filter((migration) => migration.version <= 78))

    const columns = db.prepare('PRAGMA table_info(thread_principal_bindings)').all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual([
      'thread_id', 'principal_scope_digest', 'created_at',
    ])
    expect(db.prepare('SELECT COUNT(*) FROM thread_principal_bindings').pluck().get()).toBe(0)
    expect(db.prepare("SELECT COUNT(*) FROM threads WHERE id = 'thread_legacy'").pluck().get()).toBe(1)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(db.pragma('user_version', { simple: true })).toBe(78)
    expect(auditMigrations(MIGRATIONS)).toEqual([])
    db.close()
  })
})
