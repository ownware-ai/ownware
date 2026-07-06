/**
 * Migration #30 — rename marketplace profiles to the ownware-* prefix.
 *
 * Seeds a DB at migration 29, populates rows referencing each of the 7
 * old marketplace names, then applies migration 30 and asserts every
 * row was renamed in every place that carries a profile_id.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

let tempDir: string
let db: Database.Database

const RENAME_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['counsel', 'ownware-law'],
  ['finance', 'ownware-finance'],
  ['marketing', 'ownware-marketing'],
  ['researcher', 'ownware-research'],
  ['sentinel', 'ownware-security'],
  ['trading-coach', 'ownware-trade-coach'],
  ['trading-research', 'ownware-trade-research'],
]

function applyMigrationsThrough(handle: Database.Database, lastVersion: number): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version     INTEGER     PRIMARY KEY,
      name        TEXT        NOT NULL,
      applied_at  TEXT        NOT NULL DEFAULT (datetime('now'))
    );
  `)
  for (const m of MIGRATIONS) {
    if (m.version > lastVersion) break
    handle.exec(m.sql)
    handle.prepare(
      'INSERT OR IGNORE INTO _migrations (version, name) VALUES (?, ?)',
    ).run(m.version, m.name)
  }
}

function applySingleMigration(handle: Database.Database, version: number): void {
  const m = MIGRATIONS.find((x) => x.version === version)
  if (!m) throw new Error(`Migration ${version} not found`)
  handle.exec(m.sql)
  handle.prepare(
    'INSERT INTO _migrations (version, name) VALUES (?, ?)',
  ).run(m.version, m.name)
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cortex-mig30-test-'))
  db = new Database(join(tempDir, 'test.db'))
  db.exec('PRAGMA foreign_keys = ON')
  applyMigrationsThrough(db, 29)
})

afterEach(async () => {
  db.close()
  await rm(tempDir, { recursive: true, force: true })
})

describe('migration 030 — rename marketplace profile ids', () => {
  it('renames threads.profile_id for every marketplace profile', () => {
    const insert = db.prepare('INSERT INTO threads (id, profile_id) VALUES (?, ?)')
    RENAME_PAIRS.forEach(([oldName], i) => insert.run(`t${i}`, oldName))
    insert.run('tX', 'unrelated')

    applySingleMigration(db, 30)

    const rows = db.prepare('SELECT id, profile_id FROM threads ORDER BY id').all() as Array<{ id: string; profile_id: string }>
    expect(rows).toEqual([
      ...RENAME_PAIRS.map(([, newName], i) => ({ id: `t${i}`, profile_id: newName })),
      { id: 'tX', profile_id: 'unrelated' },
    ])
  })

  it('renames usage_records.profile_id', () => {
    const insert = db.prepare(
      'INSERT INTO usage_records (id, profile_id, model, provider) VALUES (?, ?, ?, ?)',
    )
    RENAME_PAIRS.forEach(([oldName], i) => insert.run(`u${i}`, oldName, 'm', 'p'))

    applySingleMigration(db, 30)

    const got = db.prepare(
      'SELECT profile_id FROM usage_records ORDER BY id',
    ).all().map((r) => (r as { profile_id: string }).profile_id)
    expect(got).toEqual(RENAME_PAIRS.map(([, n]) => n))
  })

  it('renames workspaces.last_profile_id', () => {
    const insert = db.prepare(
      'INSERT INTO workspaces (id, name, path, last_profile_id) VALUES (?, ?, ?, ?)',
    )
    RENAME_PAIRS.forEach(([oldName], i) => insert.run(`w${i}`, `n${i}`, `/p${i}`, oldName))

    applySingleMigration(db, 30)

    const rows = db.prepare(
      'SELECT id, last_profile_id FROM workspaces ORDER BY id',
    ).all() as Array<{ id: string; last_profile_id: string }>
    expect(rows.map((r) => r.last_profile_id)).toEqual(RENAME_PAIRS.map(([, n]) => n))
  })

  it('renames workspace_profiles composite-PK rows', () => {
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES ('w1', 'a', '/a')").run()
    const insert = db.prepare(
      'INSERT INTO workspace_profiles (workspace_id, profile_id, thread_count) VALUES (?, ?, ?)',
    )
    RENAME_PAIRS.forEach(([oldName], i) => insert.run('w1', oldName, i + 1))

    applySingleMigration(db, 30)

    const rows = db.prepare(
      'SELECT profile_id, thread_count FROM workspace_profiles ORDER BY thread_count',
    ).all() as Array<{ profile_id: string; thread_count: number }>
    expect(rows.map((r) => r.profile_id)).toEqual(RENAME_PAIRS.map(([, n]) => n))
  })

  it('renames profile_metadata PK rows', () => {
    const insert = db.prepare(
      'INSERT INTO profile_metadata (profile_id, icon) VALUES (?, ?)',
    )
    RENAME_PAIRS.forEach(([oldName], i) => insert.run(oldName, `i${i}`))

    applySingleMigration(db, 30)

    const ids = db.prepare(
      'SELECT profile_id FROM profile_metadata ORDER BY icon',
    ).all().map((r) => (r as { profile_id: string }).profile_id)
    expect(ids).toEqual(RENAME_PAIRS.map(([, n]) => n))
  })

  it('updates workspace_panes.config_json profileId for chat panes', () => {
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES ('w1', 'a', '/a')").run()
    const insert = db.prepare(`
      INSERT INTO workspace_panes (id, workspace_id, kind, zone, title, config_json, metadata_json)
      VALUES (?, 'w1', 'chat', 'tabs', 'Chat', ?, '{}')
    `)
    RENAME_PAIRS.forEach(([oldName], i) => {
      insert.run(`p${i}`, JSON.stringify({ profileId: oldName, threadId: `t${i}` }))
    })

    applySingleMigration(db, 30)

    const rows = db.prepare(
      'SELECT id, config_json FROM workspace_panes ORDER BY id',
    ).all() as Array<{ id: string; config_json: string }>
    const profileIds = rows.map((r) => (JSON.parse(r.config_json) as { profileId: string }).profileId)
    expect(profileIds).toEqual(RENAME_PAIRS.map(([, n]) => n))
  })

  it('is idempotent — re-running the migration body leaves the renamed rows alone', () => {
    db.prepare("INSERT INTO threads (id, profile_id) VALUES ('t1', 'counsel')").run()
    applySingleMigration(db, 30)
    db.exec(MIGRATIONS.find((m) => m.version === 30)!.sql)

    const row = db.prepare("SELECT profile_id FROM threads WHERE id = 't1'").get() as { profile_id: string }
    expect(row.profile_id).toBe('ownware-law')
  })
})
