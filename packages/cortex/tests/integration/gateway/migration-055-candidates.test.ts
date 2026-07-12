import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { runMigrationsSafely } from '../../../src/gateway/db/migration-safety.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('profile candidate migrations from v54', () => {
  it('upgrades a v54 database without changing existing thread data', () => {
    dir = mkdtempSync(join(tmpdir(), 'candidate-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 54))
    old.prepare("INSERT INTO threads (id, profile_id, status) VALUES ('thread_existing', 'mini', 'completed')").run()
    old.close()

    const upgraded = new CortexDatabase(path)
    expect(upgraded.rawMainHandle.prepare('SELECT profile_id, status FROM threads WHERE id = ?')
      .get('thread_existing')).toEqual({ profile_id: 'mini', status: 'completed' })
    expect(upgraded.rawMainHandle.prepare('SELECT MAX(version) AS version FROM _migrations').get())
      .toEqual({ version: MIGRATIONS.at(-1)!.version })
    expect(upgraded.rawMainHandle.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'profile_candidates'
    `).get()).toEqual({ name: 'profile_candidates' })
    upgraded.close()
  })
})
