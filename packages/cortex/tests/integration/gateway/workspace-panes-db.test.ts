/**
 * Integration tests for the workspace_panes CRUD on `CortexDatabase`.
 *
 * Exercises the API surface added by slice 1a.2:
 *   - createWorkspacePane (incl. chat-pane idempotency + focus invariant)
 *   - getWorkspacePanes / getWorkspacePane
 *   - updateWorkspacePane (replacement semantics for config / metadata)
 *   - focusWorkspacePane (transactional clear + set)
 *   - reorderWorkspacePanes (membership validation, atomic position rewrite)
 *   - deleteWorkspacePane (next-focused selection, position re-normalisation)
 *   - getWorkspacePaneLayout / setWorkspacePaneLayout (app_state round-trip)
 *
 * Goes through the actual `CortexDatabase` constructor so the tests
 * cover the same migration path the running gateway does.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { CortexDatabase } from '../../../src/gateway/db/database.js'
import type {
  PaneConfig,
  PaneMetadata,
  WorkspacePane,
} from '../../../src/gateway/types.js'

let dbDir: string
let db: CortexDatabase
let wsId: string
let wsId2: string

beforeEach(async () => {
  dbDir = await mkdtemp(join(tmpdir(), 'cortex-panes-db-'))
  db = new CortexDatabase(join(dbDir, 'test.db'))
  // Two workspaces — most tests only use the first; isolation tests
  // reach for the second.
  wsId = db.createWorkspace(`/tmp/${Math.random().toString(36).slice(2)}/a`).id
  wsId2 = db.createWorkspace(`/tmp/${Math.random().toString(36).slice(2)}/b`).id
})

afterEach(async () => {
  // CortexDatabase has no public close() — drop the temp dir, the
  // next test gets a fresh handle. better-sqlite3 finalizes on GC.
  await rm(dbDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultMetadata(overrides: Partial<PaneMetadata> = {}): PaneMetadata {
  return {
    openedBy: 'user',
    pinned: false,
    closeable: true,
    ...overrides,
  }
}

function markdownConfig(content: string): PaneConfig {
  return { kind: 'markdown', source: { origin: 'inline', content } }
}

function chatConfig(profileId: string, threadId: string): PaneConfig {
  return { kind: 'chat', profileId, threadId }
}

// ---------------------------------------------------------------------------
// create + get round-trip
// ---------------------------------------------------------------------------

describe('createWorkspacePane / getWorkspacePane', () => {
  it('round-trips a markdown pane with default title', () => {
    const created = db.createWorkspacePane(wsId, {
      config: markdownConfig('# hello'),
      metadata: defaultMetadata(),
      zone: 'tabs',
    })
    expect(created.id).toMatch(/^pane_[0-9a-f]{12}$/)
    expect(created.workspaceId).toBe(wsId)
    expect(created.kind).toBe('markdown')
    expect(created.zone).toBe('tabs')
    expect(created.title).toBe('Markdown')   // kind-derived default
    expect(created.position).toBe(0)
    expect(created.focused).toBe(true)        // tabs zone defaults focused
    expect(created.config).toEqual(markdownConfig('# hello'))
    expect(created.metadata).toEqual(defaultMetadata())

    const fetched = db.getWorkspacePane(created.id)
    expect(fetched).toEqual(created)
  })

  it('uses the explicit title when provided', () => {
    const pane = db.createWorkspacePane(wsId, {
      config: markdownConfig('x'),
      metadata: defaultMetadata(),
      zone: 'tabs',
      title: 'README.md',
    })
    expect(pane.title).toBe('README.md')
  })

  it('side zone defaults to focused (rip-dockview Phase F — single-slot side panel surface)', () => {
    const pane = db.createWorkspacePane(wsId, {
      config: { kind: 'terminal' },
      metadata: defaultMetadata(),
      zone: 'side',
    })
    expect(pane.focused).toBe(true)
    expect(pane.title).toBe('Output')   // user-facing label per DESIGN.md §6
  })

  it('side zone honours focused: false when explicitly opted out', () => {
    const pane = db.createWorkspacePane(wsId, {
      config: { kind: 'terminal' },
      metadata: defaultMetadata(),
      zone: 'side',
      focused: false,
    })
    expect(pane.focused).toBe(false)
  })

  it('auto-positions to end-of-zone, independent across zones', () => {
    const t1 = db.createWorkspacePane(wsId, {
      config: markdownConfig('a'), metadata: defaultMetadata(), zone: 'tabs',
    })
    const s1 = db.createWorkspacePane(wsId, {
      config: { kind: 'terminal' }, metadata: defaultMetadata(), zone: 'side',
    })
    const t2 = db.createWorkspacePane(wsId, {
      config: markdownConfig('b'), metadata: defaultMetadata(), zone: 'tabs',
    })
    const s2 = db.createWorkspacePane(wsId, {
      config: { kind: 'files', rootPath: '/' }, metadata: defaultMetadata(), zone: 'side',
    })
    expect([t1.position, s1.position, t2.position, s2.position]).toEqual([0, 0, 1, 1])
  })

  it('focusing a new pane defocuses the previous focused pane in the same zone', () => {
    const a = db.createWorkspacePane(wsId, {
      config: markdownConfig('a'), metadata: defaultMetadata(), zone: 'tabs',
    })
    const b = db.createWorkspacePane(wsId, {
      config: markdownConfig('b'), metadata: defaultMetadata(), zone: 'tabs',
    })
    expect(db.getWorkspacePane(a.id)?.focused).toBe(false)
    expect(db.getWorkspacePane(b.id)?.focused).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Chat-pane idempotency (reopen path)
// ---------------------------------------------------------------------------

describe('createWorkspacePane: chat idempotency', () => {
  it('second create with same threadId returns the existing pane', () => {
    const a = db.createWorkspacePane(wsId, {
      config: chatConfig('coder', 'th_1'),
      metadata: defaultMetadata(),
      zone: 'tabs',
    })
    const b = db.createWorkspacePane(wsId, {
      config: chatConfig('coder', 'th_1'),
      metadata: defaultMetadata(),
      zone: 'tabs',
    })
    expect(b.id).toBe(a.id)
    expect(db.getWorkspacePanes(wsId)).toHaveLength(1)
  })

  it('reopen with focused: true activates the existing chat pane', () => {
    const first = db.createWorkspacePane(wsId, {
      config: chatConfig('coder', 'th_1'),
      metadata: defaultMetadata(),
      zone: 'tabs',
    })
    const second = db.createWorkspacePane(wsId, {
      config: chatConfig('coder', 'th_2'),
      metadata: defaultMetadata(),
      zone: 'tabs',
    })
    expect(second.focused).toBe(true)
    expect(db.getWorkspacePane(first.id)?.focused).toBe(false)

    // Reopen the first chat with focus — should activate it.
    const reopened = db.createWorkspacePane(wsId, {
      config: chatConfig('coder', 'th_1'),
      metadata: defaultMetadata(),
      zone: 'tabs',
      focused: true,
    })
    expect(reopened.id).toBe(first.id)
    expect(reopened.focused).toBe(true)
    expect(db.getWorkspacePane(second.id)?.focused).toBe(false)
  })

  it('different workspaces with the same threadId can each have their own chat pane', () => {
    const a = db.createWorkspacePane(wsId, {
      config: chatConfig('coder', 'th_shared'),
      metadata: defaultMetadata(),
      zone: 'tabs',
    })
    const b = db.createWorkspacePane(wsId2, {
      config: chatConfig('coder', 'th_shared'),
      metadata: defaultMetadata(),
      zone: 'tabs',
    })
    expect(a.id).not.toBe(b.id)
  })
})

// ---------------------------------------------------------------------------
// updateWorkspacePane
// ---------------------------------------------------------------------------

describe('updateWorkspacePane', () => {
  let pane: WorkspacePane

  beforeEach(() => {
    pane = db.createWorkspacePane(wsId, {
      config: markdownConfig('initial'),
      metadata: defaultMetadata(),
      zone: 'tabs',
      title: 'Original',
    })
  })

  it('patches title only', () => {
    const updated = db.updateWorkspacePane(pane.id, { title: 'Renamed' })
    expect(updated?.title).toBe('Renamed')
    expect(updated?.config).toEqual(markdownConfig('initial'))
    expect(updated?.metadata).toEqual(defaultMetadata())
  })

  it('replaces config (and updates the kind column)', () => {
    const updated = db.updateWorkspacePane(pane.id, {
      config: { kind: 'image', source: { origin: 'url', url: 'https://x.com/y.png' } },
    })
    expect(updated?.kind).toBe('image')
    expect(updated?.config).toEqual({
      kind: 'image',
      source: { origin: 'url', url: 'https://x.com/y.png' },
    })
  })

  it('replaces metadata wholesale (denormalized columns re-derived)', () => {
    const updated = db.updateWorkspacePane(pane.id, {
      metadata: defaultMetadata({
        openedBy: 'agent',
        subagentId: 'sa_1',
        pinned: true,
        scopedToChatId: 'pane_chat_x',
      }),
    })
    expect(updated?.metadata.openedBy).toBe('agent')
    expect(updated?.metadata.subagentId).toBe('sa_1')
    expect(updated?.metadata.pinned).toBe(true)
    expect(updated?.metadata.scopedToChatId).toBe('pane_chat_x')
  })

  it('honours per-field overrides for groupId', () => {
    const u = db.updateWorkspacePane(pane.id, { groupId: 'group_a' })
    expect(u?.groupId).toBe('group_a')
  })

  it('clears scopedChatId / groupId when null is supplied', () => {
    db.updateWorkspacePane(pane.id, { groupId: 'g1' })
    const cleared = db.updateWorkspacePane(pane.id, { groupId: null })
    expect(cleared?.groupId).toBeNull()
  })

  it('returns undefined for an unknown pane id', () => {
    expect(db.updateWorkspacePane('pane_nope', { title: 'x' })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// focusWorkspacePane
// ---------------------------------------------------------------------------

describe('focusWorkspacePane', () => {
  it('focuses the target pane and defocuses prior focus in the same zone', () => {
    const a = db.createWorkspacePane(wsId, {
      config: markdownConfig('a'), metadata: defaultMetadata(), zone: 'tabs',
    })
    const b = db.createWorkspacePane(wsId, {
      config: markdownConfig('b'), metadata: defaultMetadata(), zone: 'tabs',
    })
    // Initially: a not focused, b focused (latest).
    db.focusWorkspacePane(a.id)
    expect(db.getWorkspacePane(a.id)?.focused).toBe(true)
    expect(db.getWorkspacePane(b.id)?.focused).toBe(false)
  })

  it('focusing a side-zone pane does not affect tab-zone focus', () => {
    const tab = db.createWorkspacePane(wsId, {
      config: markdownConfig('a'), metadata: defaultMetadata(), zone: 'tabs',
    })
    const side = db.createWorkspacePane(wsId, {
      config: { kind: 'terminal' }, metadata: defaultMetadata(), zone: 'side',
    })
    db.focusWorkspacePane(side.id)
    expect(db.getWorkspacePane(tab.id)?.focused).toBe(true)
    expect(db.getWorkspacePane(side.id)?.focused).toBe(true)
  })

  it('returns undefined on unknown id', () => {
    expect(db.focusWorkspacePane('pane_nope')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// reorderWorkspacePanes
// ---------------------------------------------------------------------------

describe('reorderWorkspacePanes', () => {
  let a: WorkspacePane
  let b: WorkspacePane
  let c: WorkspacePane

  beforeEach(() => {
    a = db.createWorkspacePane(wsId, { config: markdownConfig('a'), metadata: defaultMetadata(), zone: 'tabs' })
    b = db.createWorkspacePane(wsId, { config: markdownConfig('b'), metadata: defaultMetadata(), zone: 'tabs' })
    c = db.createWorkspacePane(wsId, { config: markdownConfig('c'), metadata: defaultMetadata(), zone: 'tabs' })
  })

  it('reorders to the supplied id sequence', () => {
    const rows = db.reorderWorkspacePanes(wsId, 'tabs', [c.id, a.id, b.id])
    expect(rows.map((r) => r.id)).toEqual([c.id, a.id, b.id])
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2])
  })

  it('throws on an alien pane id (different workspace)', () => {
    const alien = db.createWorkspacePane(wsId2, {
      config: markdownConfig('x'), metadata: defaultMetadata(), zone: 'tabs',
    })
    expect(() =>
      db.reorderWorkspacePanes(wsId, 'tabs', [a.id, alien.id]),
    ).toThrow(/not in/)
  })

  it('throws on a pane id from a different zone', () => {
    const sidePane = db.createWorkspacePane(wsId, {
      config: { kind: 'terminal' }, metadata: defaultMetadata(), zone: 'side',
    })
    expect(() =>
      db.reorderWorkspacePanes(wsId, 'tabs', [a.id, sidePane.id]),
    ).toThrow(/not in/)
  })

  it('throws on an unknown pane id', () => {
    expect(() =>
      db.reorderWorkspacePanes(wsId, 'tabs', [a.id, 'pane_nope']),
    ).toThrow(/not in/)
  })

  it('empty ids returns the current ordering, unchanged', () => {
    const rows = db.reorderWorkspacePanes(wsId, 'tabs', [])
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id, c.id])
  })
})

// ---------------------------------------------------------------------------
// deleteWorkspacePane
// ---------------------------------------------------------------------------

describe('deleteWorkspacePane', () => {
  it('returns closed: false for unknown ids', () => {
    expect(db.deleteWorkspacePane('pane_nope')).toEqual({
      closed: false, workspaceId: null, zone: null, nextFocusedPaneId: null,
    })
  })

  it('deletes a non-focused pane and renormalises positions', () => {
    const a = db.createWorkspacePane(wsId, { config: markdownConfig('a'), metadata: defaultMetadata(), zone: 'tabs' })
    const b = db.createWorkspacePane(wsId, { config: markdownConfig('b'), metadata: defaultMetadata(), zone: 'tabs' })
    const c = db.createWorkspacePane(wsId, { config: markdownConfig('c'), metadata: defaultMetadata(), zone: 'tabs' })
    // Focus is on c (latest); delete the middle one.
    const result = db.deleteWorkspacePane(b.id)
    expect(result).toEqual({
      closed: true, workspaceId: wsId, zone: 'tabs', nextFocusedPaneId: null,
    })
    const remaining = db.getWorkspacePanes(wsId)
    expect(remaining.map((p) => ({ id: p.id, position: p.position }))).toEqual([
      { id: a.id, position: 0 },
      { id: c.id, position: 1 },
    ])
  })

  it('deletes the focused pane and promotes the next-position neighbour', () => {
    const a = db.createWorkspacePane(wsId, { config: markdownConfig('a'), metadata: defaultMetadata(), zone: 'tabs' })
    const b = db.createWorkspacePane(wsId, { config: markdownConfig('b'), metadata: defaultMetadata(), zone: 'tabs' })
    const c = db.createWorkspacePane(wsId, { config: markdownConfig('c'), metadata: defaultMetadata(), zone: 'tabs' })
    // Focus c (the latest). When deleted, b takes c's old position
    // after renormalisation and is promoted to focused.
    db.focusWorkspacePane(c.id)
    const result = db.deleteWorkspacePane(c.id)
    expect(result.nextFocusedPaneId).toBe(b.id)
    expect(db.getWorkspacePane(b.id)?.focused).toBe(true)
    expect(db.getWorkspacePane(a.id)?.focused).toBe(false)
  })

  it('focused-deletion of the only pane in a zone returns nextFocusedPaneId: null', () => {
    const only = db.createWorkspacePane(wsId, {
      config: markdownConfig('lone'), metadata: defaultMetadata(), zone: 'tabs',
    })
    const result = db.deleteWorkspacePane(only.id)
    expect(result.nextFocusedPaneId).toBeNull()
    expect(db.getWorkspacePanes(wsId)).toEqual([])
  })

  it('zone-isolation: deleting a tabs-zone pane does not promote a side-zone neighbour', () => {
    const tab = db.createWorkspacePane(wsId, { config: markdownConfig('a'), metadata: defaultMetadata(), zone: 'tabs' })
    db.createWorkspacePane(wsId, { config: { kind: 'terminal' }, metadata: defaultMetadata(), zone: 'side' })
    const result = db.deleteWorkspacePane(tab.id)
    expect(result.nextFocusedPaneId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// deleteWorkspacePane — close-tab cascade for scoped panes
// (workspace-tab-architecture-2026-05-13, Slice 3b)
// ---------------------------------------------------------------------------

describe('deleteWorkspacePane: chat cascade', () => {
  it('deleting a chat pane cascades-deletes every pane scoped to it', () => {
    const chat = db.createWorkspacePane(wsId, {
      config: chatConfig('p_default', 'thread_a'),
      metadata: defaultMetadata(),
      zone: 'tabs',
    })
    const scopedMd = db.createWorkspacePane(wsId, {
      config: markdownConfig('A brief'),
      metadata: defaultMetadata({ scopedToChatId: chat.id }),
      zone: 'side',
    })
    const scopedCode = db.createWorkspacePane(wsId, {
      config: { kind: 'code', source: { origin: 'inline', content: 'console.log(1)' } },
      metadata: defaultMetadata({ scopedToChatId: chat.id }),
      zone: 'side',
    })

    const result = db.deleteWorkspacePane(chat.id)

    expect(result.closed).toBe(true)
    expect(db.getWorkspacePane(scopedMd.id)).toBeUndefined()
    expect(db.getWorkspacePane(scopedCode.id)).toBeUndefined()
    expect(db.getWorkspacePanes(wsId)).toEqual([])
  })

  it('leaves unscoped (NULL) side panes alone when a chat is closed', () => {
    const chat = db.createWorkspacePane(wsId, {
      config: chatConfig('p_default', 'thread_a'),
      metadata: defaultMetadata(),
      zone: 'tabs',
    })
    const sharedTerminal = db.createWorkspacePane(wsId, {
      config: { kind: 'terminal' },
      metadata: defaultMetadata(),
      zone: 'side',
    })

    db.deleteWorkspacePane(chat.id)

    expect(db.getWorkspacePane(sharedTerminal.id)?.id).toBe(sharedTerminal.id)
  })

  it('leaves panes scoped to a DIFFERENT chat untouched', () => {
    const chatA = db.createWorkspacePane(wsId, {
      config: chatConfig('p_default', 'thread_a'),
      metadata: defaultMetadata(),
      zone: 'tabs',
    })
    const chatB = db.createWorkspacePane(wsId, {
      config: chatConfig('p_default', 'thread_b'),
      metadata: defaultMetadata(),
      zone: 'tabs',
    })
    const scopedToA = db.createWorkspacePane(wsId, {
      config: markdownConfig('A brief'),
      metadata: defaultMetadata({ scopedToChatId: chatA.id }),
      zone: 'side',
    })
    const scopedToB = db.createWorkspacePane(wsId, {
      config: markdownConfig('B brief'),
      metadata: defaultMetadata({ scopedToChatId: chatB.id }),
      zone: 'side',
    })

    db.deleteWorkspacePane(chatA.id)

    expect(db.getWorkspacePane(scopedToA.id)).toBeUndefined()
    expect(db.getWorkspacePane(scopedToB.id)?.id).toBe(scopedToB.id)
  })

  it('repacks side-zone positions cleanly after cascading multiple deletes', () => {
    const chat = db.createWorkspacePane(wsId, {
      config: chatConfig('p_default', 'thread_a'),
      metadata: defaultMetadata(),
      zone: 'tabs',
    })
    // Insert in deterministic order — DB assigns 0, 1, 2 by openedAt /
    // creation order.
    const s0 = db.createWorkspacePane(wsId, {
      config: markdownConfig('s0'),
      metadata: defaultMetadata({ scopedToChatId: chat.id }),
      zone: 'side',
    })
    const survivor = db.createWorkspacePane(wsId, {
      config: { kind: 'terminal' },
      metadata: defaultMetadata(),
      zone: 'side',
    })
    const s2 = db.createWorkspacePane(wsId, {
      config: markdownConfig('s2'),
      metadata: defaultMetadata({ scopedToChatId: chat.id }),
      zone: 'side',
    })
    void s0
    void s2

    db.deleteWorkspacePane(chat.id)

    const remaining = db.getWorkspacePanes(wsId).filter((p) => p.zone === 'side')
    expect(remaining.map((p) => ({ id: p.id, position: p.position }))).toEqual([
      { id: survivor.id, position: 0 },
    ])
  })

  it('does NOT cascade when a non-chat pane is deleted (scoping is one-directional)', () => {
    // A scoped markdown pane should NOT cascade when deleted — only
    // chat panes propagate close-cascades. Confirms the cascade is
    // gated on `kind === 'chat'`, not on "is this referenced by
    // scoped_chat_id anywhere".
    const chat = db.createWorkspacePane(wsId, {
      config: chatConfig('p_default', 'thread_a'),
      metadata: defaultMetadata(),
      zone: 'tabs',
    })
    const scoped = db.createWorkspacePane(wsId, {
      config: markdownConfig('content'),
      metadata: defaultMetadata({ scopedToChatId: chat.id }),
      zone: 'side',
    })

    db.deleteWorkspacePane(scoped.id)

    // Chat survives; the rest of the workspace is undisturbed.
    expect(db.getWorkspacePane(chat.id)?.id).toBe(chat.id)
  })

  it('promotes the right neighbour in the tabs zone when the deleted chat had scoped side panes', () => {
    // Regression guard: the new pick-neighbour-before-delete logic must
    // exclude cascade victims from the neighbour query. Otherwise a
    // chat pane being focused alongside scoped side rows could
    // theoretically promote one of the doomed side rows (different
    // zone in practice, but the query must still be correct).
    const a = db.createWorkspacePane(wsId, {
      config: chatConfig('p_default', 'thread_a'),
      metadata: defaultMetadata(),
      zone: 'tabs',
    })
    const b = db.createWorkspacePane(wsId, {
      config: chatConfig('p_default', 'thread_b'),
      metadata: defaultMetadata(),
      zone: 'tabs',
    })
    db.createWorkspacePane(wsId, {
      config: markdownConfig('scoped'),
      metadata: defaultMetadata({ scopedToChatId: b.id }),
      zone: 'side',
    })
    db.focusWorkspacePane(b.id)

    const result = db.deleteWorkspacePane(b.id)

    expect(result.nextFocusedPaneId).toBe(a.id)
    expect(db.getWorkspacePane(a.id)?.focused).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Workspace pane layout (Dockview JSON via app_state)
// ---------------------------------------------------------------------------

describe('getWorkspacePaneLayout / setWorkspacePaneLayout', () => {
  it('returns null when no layout has been stored', () => {
    expect(db.getWorkspacePaneLayout(wsId)).toBeNull()
  })

  it('round-trips an opaque layout string', () => {
    db.setWorkspacePaneLayout(wsId, '{"groups":[]}')
    expect(db.getWorkspacePaneLayout(wsId)).toBe('{"groups":[]}')
  })

  it('overwrites on subsequent set', () => {
    db.setWorkspacePaneLayout(wsId, 'one')
    db.setWorkspacePaneLayout(wsId, 'two')
    expect(db.getWorkspacePaneLayout(wsId)).toBe('two')
  })

  it('isolates layouts per workspace', () => {
    db.setWorkspacePaneLayout(wsId, 'A')
    db.setWorkspacePaneLayout(wsId2, 'B')
    expect(db.getWorkspacePaneLayout(wsId)).toBe('A')
    expect(db.getWorkspacePaneLayout(wsId2)).toBe('B')
  })
})

// ---------------------------------------------------------------------------
// Side-track width (drag-handle persistence, FileViewer redesign slice 2)
// ---------------------------------------------------------------------------

describe('getWorkspaceSideTrackWidth / setWorkspaceSideTrackWidth', () => {
  it('returns null when nothing has been stored', () => {
    expect(db.getWorkspaceSideTrackWidth(wsId)).toBeNull()
  })

  it('round-trips a positive integer width', () => {
    db.setWorkspaceSideTrackWidth(wsId, 720)
    expect(db.getWorkspaceSideTrackWidth(wsId)).toBe(720)
  })

  it('overwrites on subsequent set', () => {
    db.setWorkspaceSideTrackWidth(wsId, 400)
    db.setWorkspaceSideTrackWidth(wsId, 880)
    expect(db.getWorkspaceSideTrackWidth(wsId)).toBe(880)
  })

  it('isolates widths per workspace', () => {
    db.setWorkspaceSideTrackWidth(wsId, 400)
    db.setWorkspaceSideTrackWidth(wsId2, 800)
    expect(db.getWorkspaceSideTrackWidth(wsId)).toBe(400)
    expect(db.getWorkspaceSideTrackWidth(wsId2)).toBe(800)
  })

  it('width and layout share a workspace but live in separate KV keys', () => {
    db.setWorkspacePaneLayout(wsId, 'L')
    db.setWorkspaceSideTrackWidth(wsId, 560)
    expect(db.getWorkspacePaneLayout(wsId)).toBe('L')
    expect(db.getWorkspaceSideTrackWidth(wsId)).toBe(560)
  })
})

// ---------------------------------------------------------------------------
// getWorkspacePanes ordering
// ---------------------------------------------------------------------------

describe('getWorkspacePanes', () => {
  it('returns rows ordered by zone then position', () => {
    const t0 = db.createWorkspacePane(wsId, { config: markdownConfig('t0'), metadata: defaultMetadata(), zone: 'tabs' })
    const s0 = db.createWorkspacePane(wsId, { config: { kind: 'terminal' }, metadata: defaultMetadata(), zone: 'side' })
    const t1 = db.createWorkspacePane(wsId, { config: markdownConfig('t1'), metadata: defaultMetadata(), zone: 'tabs' })
    const s1 = db.createWorkspacePane(wsId, { config: { kind: 'files', rootPath: '/' }, metadata: defaultMetadata(), zone: 'side' })

    const all = db.getWorkspacePanes(wsId)
    expect(all.map((p) => p.id)).toEqual([s0.id, s1.id, t0.id, t1.id])
  })

  it('returns [] for a workspace with no panes', () => {
    const ws3 = db.createWorkspace('/tmp/empty').id
    expect(db.getWorkspacePanes(ws3)).toEqual([])
  })
})
