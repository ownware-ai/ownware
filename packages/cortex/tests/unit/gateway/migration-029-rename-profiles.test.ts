/**
 * Migration #29 — rename core profiles 'default' → 'ownware' and
 * 'coder' → 'ownware-code'.
 *
 * Seeds a DB at migration 28, populates rows referencing the old names
 * across every table that carries profile_id (plus workspace_panes JSON),
 * then applies migration 29 and asserts every row was renamed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

let tempDir: string
let db: Database.Database

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
  tempDir = await mkdtemp(join(tmpdir(), 'cortex-mig29-test-'))
  db = new Database(join(tempDir, 'test.db'))
  db.exec('PRAGMA foreign_keys = ON')
  applyMigrationsThrough(db, 28)
})

afterEach(async () => {
  db.close()
  await rm(tempDir, { recursive: true, force: true })
})

describe('migration 029 — rename core profile ids', () => {
  it('renames threads.profile_id default → ownware and coder → ownware-code', () => {
    db.prepare(
      "INSERT INTO threads (id, profile_id) VALUES ('t1', 'default')",
    ).run()
    db.prepare(
      "INSERT INTO threads (id, profile_id) VALUES ('t2', 'coder')",
    ).run()
    db.prepare(
      "INSERT INTO threads (id, profile_id) VALUES ('t3', 'counsel')",
    ).run()

    applySingleMigration(db, 29)

    const rows = db.prepare(
      'SELECT id, profile_id FROM threads ORDER BY id',
    ).all() as Array<{ id: string; profile_id: string }>
    expect(rows).toEqual([
      { id: 't1', profile_id: 'ownware' },
      { id: 't2', profile_id: 'ownware-code' },
      { id: 't3', profile_id: 'counsel' },
    ])
  })

  it('renames usage_records.profile_id', () => {
    db.prepare(
      "INSERT INTO usage_records (id, profile_id, model, provider) VALUES ('u1', 'default', 'm', 'p')",
    ).run()
    db.prepare(
      "INSERT INTO usage_records (id, profile_id, model, provider) VALUES ('u2', 'coder', 'm', 'p')",
    ).run()

    applySingleMigration(db, 29)

    const profileIds = db.prepare(
      'SELECT profile_id FROM usage_records ORDER BY id',
    ).all().map((r) => (r as { profile_id: string }).profile_id)
    expect(profileIds).toEqual(['ownware', 'ownware-code'])
  })

  it('renames workspaces.last_profile_id (nullable)', () => {
    db.prepare(
      "INSERT INTO workspaces (id, name, path, last_profile_id) VALUES ('w1', 'a', '/a', 'default')",
    ).run()
    db.prepare(
      "INSERT INTO workspaces (id, name, path, last_profile_id) VALUES ('w2', 'b', '/b', 'coder')",
    ).run()
    db.prepare(
      "INSERT INTO workspaces (id, name, path, last_profile_id) VALUES ('w3', 'c', '/c', NULL)",
    ).run()

    applySingleMigration(db, 29)

    const rows = db.prepare(
      'SELECT id, last_profile_id FROM workspaces ORDER BY id',
    ).all() as Array<{ id: string; last_profile_id: string | null }>
    expect(rows).toEqual([
      { id: 'w1', last_profile_id: 'ownware' },
      { id: 'w2', last_profile_id: 'ownware-code' },
      { id: 'w3', last_profile_id: null },
    ])
  })

  it('renames workspace_profiles composite-PK rows', () => {
    db.prepare(
      "INSERT INTO workspaces (id, name, path) VALUES ('w1', 'a', '/a')",
    ).run()
    db.prepare(
      "INSERT INTO workspace_profiles (workspace_id, profile_id, thread_count) VALUES ('w1', 'default', 3)",
    ).run()
    db.prepare(
      "INSERT INTO workspace_profiles (workspace_id, profile_id, thread_count) VALUES ('w1', 'coder', 5)",
    ).run()

    applySingleMigration(db, 29)

    const rows = db.prepare(
      'SELECT profile_id, thread_count FROM workspace_profiles ORDER BY profile_id',
    ).all() as Array<{ profile_id: string; thread_count: number }>
    expect(rows).toEqual([
      { profile_id: 'ownware', thread_count: 3 },
      { profile_id: 'ownware-code', thread_count: 5 },
    ])
  })

  it('renames profile_metadata PK rows', () => {
    db.prepare(
      "INSERT INTO profile_metadata (profile_id, icon, color) VALUES ('default', 'D', '#fff')",
    ).run()
    db.prepare(
      "INSERT INTO profile_metadata (profile_id, icon, color) VALUES ('coder', 'C', '#0f0')",
    ).run()

    applySingleMigration(db, 29)

    const rows = db.prepare(
      'SELECT profile_id, icon, color FROM profile_metadata ORDER BY profile_id',
    ).all() as Array<{ profile_id: string; icon: string; color: string }>
    expect(rows).toEqual([
      { profile_id: 'ownware', icon: 'D', color: '#fff' },
      { profile_id: 'ownware-code', icon: 'C', color: '#0f0' },
    ])
  })

  it('updates workspace_panes.config_json profileId via json_set', () => {
    db.prepare(
      "INSERT INTO workspaces (id, name, path) VALUES ('w1', 'a', '/a')",
    ).run()
    db.prepare(`
      INSERT INTO workspace_panes (id, workspace_id, kind, zone, title, config_json, metadata_json)
      VALUES
        ('p1', 'w1', 'chat', 'tabs', 'Chat', '{"profileId":"default","threadId":"t1"}', '{}'),
        ('p2', 'w1', 'chat', 'tabs', 'Chat', '{"profileId":"coder","threadId":"t2"}', '{}'),
        ('p3', 'w1', 'chat', 'tabs', 'Chat', '{"profileId":"counsel","threadId":"t3"}', '{}'),
        ('p4', 'w1', 'markdown', 'side', 'Notes', '{}', '{}')
    `).run()

    applySingleMigration(db, 29)

    const rows = db.prepare(
      'SELECT id, config_json FROM workspace_panes ORDER BY id',
    ).all() as Array<{ id: string; config_json: string }>
    const parsed = rows.map((r) => ({
      id: r.id,
      profileId: (JSON.parse(r.config_json) as { profileId?: string }).profileId ?? null,
    }))
    expect(parsed).toEqual([
      { id: 'p1', profileId: 'ownware' },
      { id: 'p2', profileId: 'ownware-code' },
      { id: 'p3', profileId: 'counsel' },
      { id: 'p4', profileId: null },
    ])
  })

  it('is idempotent — re-applying nothing remains after second migration run', () => {
    db.prepare(
      "INSERT INTO threads (id, profile_id) VALUES ('t1', 'default')",
    ).run()

    applySingleMigration(db, 29)
    // Second application is a no-op because no row still has 'default'.
    db.exec(MIGRATIONS.find((m) => m.version === 29)!.sql)

    const row = db.prepare("SELECT profile_id FROM threads WHERE id = 't1'").get() as { profile_id: string }
    expect(row.profile_id).toBe('ownware')
  })
})
