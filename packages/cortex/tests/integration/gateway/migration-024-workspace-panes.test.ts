/**
 * Tests for migration 024 — workspace_panes substrate.
 *
 * Sets up the pre-024 state (workspace + thread + workspace_tabs rows
 * of various kinds), runs the migration, and asserts:
 *   - the new table + indices land
 *   - the back-fill converts thread tabs → chat panes with correct
 *     PaneConfig JSON, preserving position / focused / opened_at
 *   - non-thread tabs are NOT back-filled
 *   - the migration is idempotent (NOT EXISTS guard against the
 *     chat-thread uniqueness index)
 *   - focused / chat-thread uniqueness invariants are enforced
 *   - CASCADE on workspaces deletes panes
 *
 * Pairs with cortex/src/gateway/db/schema.ts (migration 024). Both
 * stay in sync — this file is the regression net.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

interface PaneRow {
  readonly id: string
  readonly workspace_id: string
  readonly kind: string
  readonly zone: string
  readonly title: string
  readonly config_json: string
  readonly metadata_json: string
  readonly position: number
  readonly focused: number
  readonly pinned: number
  readonly scoped_chat_id: string | null
  readonly group_id: string | null
  readonly opened_by: string
  readonly subagent_id: string | null
  readonly opened_at: string
}

let dbPath: string
let dbDir: string
let db: Database.Database

beforeEach(async () => {
  dbDir = await mkdtemp(join(tmpdir(), 'cortex-mig024-'))
  dbPath = join(dbDir, 'test.db')
  db = new Database(dbPath)
  // Apply 1..23 to set up the pre-024 baseline (workspaces, threads,
  // workspace_tabs already exist; workspace_panes does not).
  for (const m of MIGRATIONS) {
    if (m.version >= 24) break
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

function applyMigration024(): void {
  const m = MIGRATIONS.find((x) => x.version === 24)
  if (!m) throw new Error('migration 024 not found in MIGRATIONS')
  db.exec(m.sql)
}

function seedWorkspace(id: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)`,
  ).run(id, id, `/tmp/${id}`)
}

function seedThread(id: string, profileId: string, workspaceId: string | null): void {
  db.prepare(
    `INSERT INTO threads (id, profile_id, workspace_id) VALUES (?, ?, ?)`,
  ).run(id, profileId, workspaceId)
}

function seedTab(opts: {
  id: string
  workspaceId: string
  threadId: string | null
  label: string
  kind: string
  position: number
  active: number
  createdAt?: string
}): void {
  db.prepare(`
    INSERT INTO workspace_tabs (id, workspace_id, thread_id, label, kind, position, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.workspaceId,
    opts.threadId,
    opts.label,
    opts.kind,
    opts.position,
    opts.active,
    opts.createdAt ?? '2026-01-01 00:00:00',
  )
}

function listPanes(workspaceId?: string): PaneRow[] {
  return workspaceId != null
    ? (db
        .prepare('SELECT * FROM workspace_panes WHERE workspace_id = ? ORDER BY position ASC')
        .all(workspaceId) as PaneRow[])
    : (db
        .prepare('SELECT * FROM workspace_panes ORDER BY workspace_id, position ASC')
        .all() as PaneRow[])
}

// ---------------------------------------------------------------------------
// Schema lands
// ---------------------------------------------------------------------------

describe('migration 024 — schema', () => {
  it('creates the workspace_panes table', () => {
    applyMigration024()
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_panes'")
      .get() as { name: string } | undefined
    expect(row?.name).toBe('workspace_panes')
  })

  it('creates the five supporting indices', () => {
    applyMigration024()
    // Filter out SQLite's auto-generated PK index (sqlite_autoindex_*).
    const indices = (db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workspace_panes' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as { name: string }[]).map((r) => r.name)
    expect(indices).toEqual([
      'idx_workspace_panes_chat_thread',
      'idx_workspace_panes_one_focused',
      'idx_workspace_panes_scoped_chat',
      'idx_workspace_panes_subagent',
      'idx_workspace_panes_zone',
    ])
  })

  it('runs cleanly against an empty database (zero workspace_tabs rows)', () => {
    expect(() => applyMigration024()).not.toThrow()
    expect(listPanes()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Back-fill
// ---------------------------------------------------------------------------

describe('migration 024 — back-fill', () => {
  it('converts a single thread tab into a chat pane', () => {
    seedWorkspace('ws_1')
    seedThread('th_1', 'coder', 'ws_1')
    seedTab({
      id: 'tab_1',
      workspaceId: 'ws_1',
      threadId: 'th_1',
      label: 'Main thread',
      kind: 'thread',
      position: 0,
      active: 1,
      createdAt: '2026-04-01 12:00:00',
    })

    applyMigration024()
    const panes = listPanes('ws_1')

    expect(panes).toHaveLength(1)
    const p = panes[0]!
    expect(p.kind).toBe('chat')
    expect(p.zone).toBe('tabs')
    expect(p.title).toBe('Main thread')
    expect(p.position).toBe(0)
    expect(p.focused).toBe(1)
    expect(p.pinned).toBe(0)
    expect(p.opened_by).toBe('user')
    expect(p.opened_at).toBe('2026-04-01 12:00:00')
    expect(p.id).toMatch(/^pane_[0-9a-f]{16}$/)

    const config = JSON.parse(p.config_json)
    expect(config).toEqual({ kind: 'chat', profileId: 'coder', threadId: 'th_1' })

    const metadata = JSON.parse(p.metadata_json)
    expect(metadata).toEqual({ openedBy: 'user', pinned: false, closeable: true })
  })

  it('preserves position + focused across multiple tabs in one workspace', () => {
    seedWorkspace('ws_1')
    seedThread('th_a', 'coder', 'ws_1')
    seedThread('th_b', 'frontend', 'ws_1')
    seedThread('th_c', 'researcher', 'ws_1')

    seedTab({ id: 'tab_a', workspaceId: 'ws_1', threadId: 'th_a', label: 'A', kind: 'thread', position: 0, active: 0 })
    seedTab({ id: 'tab_b', workspaceId: 'ws_1', threadId: 'th_b', label: 'B', kind: 'thread', position: 1, active: 1 })
    seedTab({ id: 'tab_c', workspaceId: 'ws_1', threadId: 'th_c', label: 'C', kind: 'thread', position: 2, active: 0 })

    applyMigration024()
    const panes = listPanes('ws_1')

    expect(panes.map((p) => ({ title: p.title, position: p.position, focused: p.focused }))).toEqual([
      { title: 'A', position: 0, focused: 0 },
      { title: 'B', position: 1, focused: 1 },
      { title: 'C', position: 2, focused: 0 },
    ])

    expect(panes.map((p) => JSON.parse(p.config_json).profileId)).toEqual([
      'coder',
      'frontend',
      'researcher',
    ])
  })

  it('isolates panes per workspace (CASCADE-able)', () => {
    seedWorkspace('ws_a')
    seedWorkspace('ws_b')
    seedThread('th_a', 'coder', 'ws_a')
    seedThread('th_b', 'coder', 'ws_b')
    seedTab({ id: 'tab_a', workspaceId: 'ws_a', threadId: 'th_a', label: 'A', kind: 'thread', position: 0, active: 1 })
    seedTab({ id: 'tab_b', workspaceId: 'ws_b', threadId: 'th_b', label: 'B', kind: 'thread', position: 0, active: 1 })

    applyMigration024()
    expect(listPanes('ws_a')).toHaveLength(1)
    expect(listPanes('ws_b')).toHaveLength(1)
  })

  it('does NOT back-fill kind="profile" / "settings" / "welcome" tabs', () => {
    seedWorkspace('ws_1')
    seedThread('th_real', 'coder', 'ws_1')
    seedTab({ id: 'tab_thread', workspaceId: 'ws_1', threadId: 'th_real', label: 'Chat', kind: 'thread', position: 0, active: 1 })
    // Non-thread kinds — schema allows them, no current code path creates
    // them, but the migration must defensively skip.
    seedTab({ id: 'tab_p', workspaceId: 'ws_1', threadId: null, label: 'P', kind: 'profile', position: 1, active: 0 })
    seedTab({ id: 'tab_s', workspaceId: 'ws_1', threadId: null, label: 'S', kind: 'settings', position: 2, active: 0 })
    seedTab({ id: 'tab_w', workspaceId: 'ws_1', threadId: null, label: 'W', kind: 'welcome', position: 3, active: 0 })

    applyMigration024()
    const panes = listPanes('ws_1')
    expect(panes).toHaveLength(1)
    expect(JSON.parse(panes[0]!.config_json).threadId).toBe('th_real')
  })

  it('skips a thread-kind tab whose thread_id is NULL (defensive)', () => {
    // Migration 007 already deletes these, but the predicate must hold
    // regardless. Insert directly into a fresh db where 007 hasn't fired
    // its DELETE — by manually setting kind+thread_id we simulate the
    // pathological case.
    seedWorkspace('ws_1')
    db.prepare(`
      INSERT INTO workspace_tabs (id, workspace_id, thread_id, label, kind, position, active)
      VALUES ('tab_orphan', 'ws_1', NULL, 'Orphan', 'thread', 0, 0)
    `).run()
    applyMigration024()
    expect(listPanes('ws_1')).toEqual([])
  })

  it('leaves the legacy workspace_tabs table untouched (read-only fallback)', () => {
    seedWorkspace('ws_1')
    seedThread('th_1', 'coder', 'ws_1')
    seedTab({ id: 'tab_1', workspaceId: 'ws_1', threadId: 'th_1', label: 'Chat', kind: 'thread', position: 0, active: 1 })

    applyMigration024()

    // Legacy row still there — the client's existing useWorkspaceTabs path
    // continues to read it during wave 1a.
    const tabs = db
      .prepare('SELECT id, label FROM workspace_tabs WHERE workspace_id = ?')
      .all('ws_1') as { id: string; label: string }[]
    expect(tabs).toEqual([{ id: 'tab_1', label: 'Chat' }])
  })
})

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('migration 024 — idempotency', () => {
  it('second run does not duplicate chat panes', () => {
    seedWorkspace('ws_1')
    seedThread('th_1', 'coder', 'ws_1')
    seedTab({ id: 'tab_1', workspaceId: 'ws_1', threadId: 'th_1', label: 'Chat', kind: 'thread', position: 0, active: 1 })

    applyMigration024()
    expect(listPanes('ws_1')).toHaveLength(1)
    applyMigration024()
    expect(listPanes('ws_1')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Invariants enforced by the indices
// ---------------------------------------------------------------------------

describe('migration 024 — invariants', () => {
  beforeEach(() => {
    applyMigration024()
    seedWorkspace('ws_1')
  })

  function insertPane(overrides: Partial<PaneRow>): void {
    const row: PaneRow = {
      id: 'pane_x',
      workspace_id: 'ws_1',
      kind: 'markdown',
      zone: 'tabs',
      title: 't',
      config_json: '{"kind":"markdown","source":{"origin":"inline","content":"x"}}',
      metadata_json: '{"openedBy":"user","pinned":false,"closeable":true}',
      position: 0,
      focused: 0,
      pinned: 0,
      scoped_chat_id: null,
      group_id: null,
      opened_by: 'user',
      subagent_id: null,
      opened_at: '2026-01-01 00:00:00',
      ...overrides,
    }
    db.prepare(`
      INSERT INTO workspace_panes (id, workspace_id, kind, zone, title, config_json, metadata_json, position, focused, pinned, scoped_chat_id, group_id, opened_by, subagent_id, opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.workspace_id, row.kind, row.zone, row.title,
      row.config_json, row.metadata_json, row.position, row.focused,
      row.pinned, row.scoped_chat_id, row.group_id, row.opened_by,
      row.subagent_id, row.opened_at,
    )
  }

  it('blocks two focused panes in the same (workspace, zone)', () => {
    insertPane({ id: 'pane_a', focused: 1, position: 0 })
    expect(() => insertPane({ id: 'pane_b', focused: 1, position: 1 })).toThrow(
      /UNIQUE constraint failed/,
    )
  })

  it('allows two focused panes in different zones of the same workspace', () => {
    insertPane({ id: 'pane_tabs', zone: 'tabs', focused: 1, position: 0 })
    expect(() =>
      insertPane({ id: 'pane_side', zone: 'side', focused: 1, position: 0 }),
    ).not.toThrow()
  })

  it('allows zero focused panes in a zone (empty workspace)', () => {
    insertPane({ id: 'pane_a', focused: 0, position: 0 })
    insertPane({ id: 'pane_b', focused: 0, position: 1 })
    expect(listPanes('ws_1')).toHaveLength(2)
  })

  it('blocks two chat panes for the same (workspace, threadId)', () => {
    insertPane({
      id: 'pane_chat_1',
      kind: 'chat',
      config_json: '{"kind":"chat","profileId":"coder","threadId":"th_x"}',
      position: 0,
    })
    expect(() =>
      insertPane({
        id: 'pane_chat_2',
        kind: 'chat',
        config_json: '{"kind":"chat","profileId":"coder","threadId":"th_x"}',
        position: 1,
      }),
    ).toThrow(/UNIQUE constraint failed/)
  })

  it('allows two chat panes for different threads in the same workspace', () => {
    insertPane({
      id: 'pane_chat_1',
      kind: 'chat',
      config_json: '{"kind":"chat","profileId":"coder","threadId":"th_a"}',
      position: 0,
    })
    expect(() =>
      insertPane({
        id: 'pane_chat_2',
        kind: 'chat',
        config_json: '{"kind":"chat","profileId":"coder","threadId":"th_b"}',
        position: 1,
      }),
    ).not.toThrow()
  })

  it('CASCADE: deleting a workspace removes all its panes', () => {
    insertPane({ id: 'pane_a', position: 0 })
    insertPane({ id: 'pane_b', position: 1 })
    expect(listPanes('ws_1')).toHaveLength(2)

    db.prepare('DELETE FROM workspaces WHERE id = ?').run('ws_1')
    expect(listPanes('ws_1')).toEqual([])
  })
})
