/**
 * Tests for migration 025 — drops the legacy workspace_tabs table.
 *
 * Sets up the post-024 state (workspace_panes back-fill has run on the
 * pre-existing workspace_tabs rows), then runs 025 and asserts:
 *   - the table is gone
 *   - the three indices are gone
 *   - workspace_panes (the canonical store) is untouched
 *   - the migration is idempotent (DROP IF EXISTS handles re-runs)
 *   - cleanly applying 1..25 from scratch on an empty DB succeeds
 *
 * Pairs with migration-024 — together they prove the cutover is safe.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

let dbPath: string
let dbDir: string
let db: Database.Database

beforeEach(async () => {
  dbDir = await mkdtemp(join(tmpdir(), 'cortex-mig025-'))
  dbPath = join(dbDir, 'test.db')
  db = new Database(dbPath)
  // Apply 1..24 to set up the post-024 baseline (workspace_tabs +
  // workspace_panes both exist, back-fill has run).
  for (const m of MIGRATIONS) {
    if (m.version >= 25) break
    db.exec(m.sql)
    db.prepare(
      'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
    ).run(m.version, m.name, Date.now())
  }
})

afterEach(async () => {
  db.close()
  await rm(dbDir, { recursive: true, force: true })
})

function applyMigration025(): void {
  const m = MIGRATIONS.find((x) => x.version === 25)
  if (!m) throw new Error('migration 025 not found in MIGRATIONS')
  db.exec(m.sql)
}

function tableExists(name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { name?: string } | undefined
  return row?.name === name
}

function indexExists(name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(name) as { name?: string } | undefined
  return row?.name === name
}

describe('migration 025 — drop workspace_tabs', () => {
  it('removes the workspace_tabs table', () => {
    expect(tableExists('workspace_tabs')).toBe(true)
    applyMigration025()
    expect(tableExists('workspace_tabs')).toBe(false)
  })

  it('removes all three workspace_tabs indices', () => {
    expect(indexExists('idx_workspace_tabs_ws')).toBe(true)
    expect(indexExists('idx_workspace_tabs_thread_unique')).toBe(true)
    expect(indexExists('idx_workspace_tabs_one_active')).toBe(true)
    applyMigration025()
    expect(indexExists('idx_workspace_tabs_ws')).toBe(false)
    expect(indexExists('idx_workspace_tabs_thread_unique')).toBe(false)
    expect(indexExists('idx_workspace_tabs_one_active')).toBe(false)
  })

  it('leaves workspace_panes untouched', () => {
    expect(tableExists('workspace_panes')).toBe(true)
    applyMigration025()
    expect(tableExists('workspace_panes')).toBe(true)
    // The pane indices should still be there.
    expect(indexExists('idx_workspace_panes_zone')).toBe(true)
    expect(indexExists('idx_workspace_panes_one_focused')).toBe(true)
    expect(indexExists('idx_workspace_panes_chat_thread')).toBe(true)
  })

  it('preserves the back-filled chat panes when the legacy table is dropped', () => {
    // Seed a workspace + thread + workspace_tab so migration 024's
    // back-fill produced one workspace_panes row of kind='chat'.
    db.prepare(`INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)`)
      .run('ws_x', 'X', '/tmp/ws_x')
    db.prepare(`INSERT INTO threads (id, profile_id, workspace_id) VALUES (?, ?, ?)`)
      .run('th_x', 'coder', 'ws_x')
    db.prepare(`
      INSERT INTO workspace_tabs (id, workspace_id, thread_id, label, kind, position, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('tab_x', 'ws_x', 'th_x', 'New chat', 'thread', 0, 1, '2026-05-10T00:00:00Z')

    // Re-apply 024 so the back-fill picks up our seed (24 ran before
    // we inserted; the INSERT...SELECT is idempotent so re-running is
    // safe). This mirrors what would happen on a real user's DB:
    // their tabs were back-filled at first 024 run, panes already
    // exist, and 025 just drops the legacy table out from under them.
    const m024 = MIGRATIONS.find((x) => x.version === 24)!
    db.exec(m024.sql)

    const paneCountBefore = (
      db.prepare(`SELECT COUNT(*) AS c FROM workspace_panes WHERE workspace_id = ?`)
        .get('ws_x') as { c: number }
    ).c
    expect(paneCountBefore).toBe(1)

    applyMigration025()

    const paneCountAfter = (
      db.prepare(`SELECT COUNT(*) AS c FROM workspace_panes WHERE workspace_id = ?`)
        .get('ws_x') as { c: number }
    ).c
    expect(paneCountAfter).toBe(1)
    // The chat pane survived the legacy drop — its threadId still
    // references th_x even though workspace_tabs is gone.
    const pane = db.prepare(`SELECT config_json FROM workspace_panes WHERE workspace_id = ?`)
      .get('ws_x') as { config_json: string }
    const config = JSON.parse(pane.config_json) as { kind: string; threadId: string }
    expect(config.kind).toBe('chat')
    expect(config.threadId).toBe('th_x')
  })

  it('is idempotent — second run is a no-op', () => {
    applyMigration025()
    // Running it again would only fail if the DROP wasn't IF EXISTS.
    expect(() => applyMigration025()).not.toThrow()
    expect(tableExists('workspace_tabs')).toBe(false)
  })

  it('applies cleanly from an empty DB through 1..25', async () => {
    // Fresh DB, run every migration in order. This proves a brand-new
    // install (never had workspace_tabs) finishes in the same end state
    // as an upgraded DB.
    db.close()
    const freshPath = join(dbDir, 'fresh.db')
    db = new Database(freshPath)
    for (const m of MIGRATIONS) {
      db.exec(m.sql)
      db.prepare(
        'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(m.version, m.name, Date.now())
    }
    expect(tableExists('workspace_tabs')).toBe(false)
    expect(tableExists('workspace_panes')).toBe(true)
  })
})
