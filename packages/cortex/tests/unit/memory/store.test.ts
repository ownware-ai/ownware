import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import {
  SqliteMemoryStore,
  MemoryEventBus,
  type MemoryEvent,
} from '../../../src/memory/index.js'

let tmpDir: string
let db: CortexDatabase
let bus: MemoryEventBus
let store: SqliteMemoryStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-mem-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  bus = new MemoryEventBus()
  store = new SqliteMemoryStore(db.rawMainHandle, bus)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('migration 018', () => {
  it('creates the memories table with the expected columns', () => {
    const row = db.rawMainHandle.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories'`,
    ).get() as { sql: string } | undefined
    expect(row).not.toBeUndefined()
    expect(row!.sql).toMatch(/profile_id/)
    expect(row!.sql).toMatch(/scope/)
    expect(row!.sql).toMatch(/source/)
    expect(row!.sql).toMatch(/superseded_by/)
    expect(row!.sql).toMatch(/pinned/)
    expect(row!.sql).toMatch(/last_referenced_at/)
  })

  it('creates the memory_proposals and user_identity tables', () => {
    const tables = db.rawMainHandle.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
        ('memories','memory_proposals','user_identity')`,
    ).all() as Array<{ name: string }>
    expect(tables.map((t) => t.name).sort()).toEqual([
      'memories',
      'memory_proposals',
      'user_identity',
    ])
  })

  it('user_identity CHECK constraint pins id to "singleton"', () => {
    expect(() =>
      db.rawMainHandle.prepare(
        `INSERT INTO user_identity (id, created_at, updated_at)
         VALUES ('not-singleton', '2026-04-26', '2026-04-26')`,
      ).run(),
    ).toThrow(/CHECK/i)
  })
})

describe('SqliteMemoryStore — create / get', () => {
  it('returns the row it inserted with defaults applied', () => {
    const m = store.create({
      profileId: 'p1',
      content: 'User uses Bun, not npm',
      source: 'user_pinned',
    })
    expect(m.id).toMatch(/^mem_/)
    expect(m.profileId).toBe('p1')
    expect(m.scope).toBe('agent')
    expect(m.kind).toBe('fact')
    expect(m.source).toBe('user_pinned')
    expect(m.confidence).toBe(1.0)
    expect(m.status).toBe('active')
    expect(m.pinned).toBe(false)
    expect(m.referenceCount).toBe(0)

    const got = store.getById(m.id)
    expect(got).toEqual(m)
  })

  it('agent_proposed defaults confidence to 0.8', () => {
    const m = store.create({
      profileId: 'p1',
      content: 'User likes serif type',
      source: 'agent_proposed',
    })
    expect(m.confidence).toBe(0.8)
  })

  it('emits memory.changed on create', () => {
    const events: MemoryEvent[] = []
    bus.subscribe((e) => events.push(e))
    const m = store.create({
      profileId: 'p1',
      content: 'X',
      source: 'user_pinned',
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'memory.changed',
      profileId: 'p1',
      memoryId: m.id,
    })
  })
})

describe('SqliteMemoryStore — ranking (loadActiveForPrompt)', () => {
  it('returns pinned rows first regardless of recency', () => {
    const a = store.create({ profileId: 'p1', content: 'A — recent unpinned', source: 'user_pinned' })
    void a
    // Force last_referenced_at on a non-pinned row.
    store.recordReferences([a.id])
    const b = store.create({ profileId: 'p1', content: 'B — pinned, never referenced', source: 'user_pinned', pinned: true })

    const top = store.loadActiveForPrompt('p1', 10)
    expect(top.map((m) => m.id)).toEqual([b.id, a.id])
  })

  it('orders unpinned by last_referenced_at DESC, then confidence DESC, then created_at DESC', async () => {
    const oldRow = store.create({ profileId: 'p', content: 'old', source: 'user_pinned' })
    await new Promise((r) => setTimeout(r, 10))
    const lowConf = store.create({ profileId: 'p', content: 'low conf newer', source: 'agent_proposed', confidence: 0.5 })
    await new Promise((r) => setTimeout(r, 10))
    const highConf = store.create({ profileId: 'p', content: 'high conf newest', source: 'user_pinned', confidence: 1.0 })
    // Reference oldRow → bumps it to top of recency order
    store.recordReferences([oldRow.id])

    const top = store.loadActiveForPrompt('p', 10)
    // oldRow has the only non-null last_referenced_at, so it should
    // come first among unpinned rows. Then highConf (newer + higher
    // confidence) before lowConf.
    expect(top.map((m) => m.id)).toEqual([oldRow.id, highConf.id, lowConf.id])
  })

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.create({ profileId: 'p', content: `m${i.toString()}`, source: 'user_pinned' })
    }
    expect(store.loadActiveForPrompt('p', 2)).toHaveLength(2)
    expect(store.loadActiveForPrompt('p', 0)).toHaveLength(0)
  })

  it('excludes superseded and archived rows', () => {
    const a = store.create({ profileId: 'p', content: 'still active', source: 'user_pinned' })
    const b = store.create({ profileId: 'p', content: 'will be archived', source: 'user_pinned' })
    store.update(b.id, { status: 'archived' })
    const top = store.loadActiveForPrompt('p', 10)
    expect(top.map((m) => m.id)).toEqual([a.id])
  })

  it('does not leak rows from another profile', () => {
    store.create({ profileId: 'p1', content: 'p1', source: 'user_pinned' })
    store.create({ profileId: 'p2', content: 'p2', source: 'user_pinned' })
    expect(store.loadActiveForPrompt('p1', 10)).toHaveLength(1)
    expect(store.loadActiveForPrompt('p2', 10)).toHaveLength(1)
  })
})

describe('SqliteMemoryStore — recordReferences', () => {
  it('increments reference_count and stamps last_referenced_at', () => {
    const m = store.create({ profileId: 'p', content: 'x', source: 'user_pinned' })
    store.recordReferences([m.id])
    const after = store.getById(m.id)!
    expect(after.referenceCount).toBe(1)
    expect(after.lastReferencedAt).not.toBeNull()
  })

  it('does not emit a bus event (silent usage signal)', () => {
    const m = store.create({ profileId: 'p', content: 'x', source: 'user_pinned' })
    const spy = vi.fn()
    bus.subscribe(spy)
    store.recordReferences([m.id])
    expect(spy).not.toHaveBeenCalled()
  })

  it('is a no-op for empty input', () => {
    expect(() => store.recordReferences([])).not.toThrow()
  })
})

describe('SqliteMemoryStore — update', () => {
  it('merges partial fields and stamps updated_at', async () => {
    const m = store.create({ profileId: 'p', content: 'before', source: 'user_pinned' })
    await new Promise((r) => setTimeout(r, 5))
    const updated = store.update(m.id, { content: 'after', pinned: true })
    expect(updated).not.toBeNull()
    expect(updated!.content).toBe('after')
    expect(updated!.pinned).toBe(true)
    expect(updated!.updatedAt).not.toBe(m.updatedAt)
  })

  it('returns null for missing id', () => {
    expect(store.update('nope', { content: 'x' })).toBeNull()
  })

  it('returns existing row when no fields change', () => {
    const m = store.create({ profileId: 'p', content: 'x', source: 'user_pinned' })
    const r = store.update(m.id, {})
    expect(r?.id).toBe(m.id)
  })
})

describe('SqliteMemoryStore — supersede', () => {
  it('marks old row superseded and inserts new active row pointing to it', () => {
    const old = store.create({ profileId: 'p', content: 'old fact', source: 'user_pinned' })
    const next = store.supersede(old.id, {
      profileId: 'p',
      content: 'new fact',
      source: 'user_pinned',
    })

    const oldAfter = store.getById(old.id)!
    expect(oldAfter.status).toBe('superseded')
    expect(oldAfter.supersededBy).toBe(next.id)
    expect(next.status).toBe('active')
    // Active load must only see the new row.
    expect(store.loadActiveForPrompt('p', 10).map((m) => m.id)).toEqual([next.id])
  })
})

describe('SqliteMemoryStore — remove + listForProfile', () => {
  it('listForProfile filters by status', () => {
    const a = store.create({ profileId: 'p', content: 'a', source: 'user_pinned' })
    const b = store.create({ profileId: 'p', content: 'b', source: 'user_pinned' })
    store.update(b.id, { status: 'archived' })

    expect(store.listForProfile('p').map((m) => m.id)).toEqual([a.id])
    expect(store.listForProfile('p', { status: 'archived' }).map((m) => m.id)).toEqual([b.id])
    expect(store.listForProfile('p', { status: 'all' }).map((m) => m.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('countForProfile honours status filter', () => {
    store.create({ profileId: 'p', content: 'a', source: 'user_pinned' })
    const b = store.create({ profileId: 'p', content: 'b', source: 'user_pinned' })
    store.update(b.id, { status: 'archived' })

    expect(store.countForProfile('p')).toBe(1)
    expect(store.countForProfile('p', 'archived')).toBe(1)
    expect(store.countForProfile('p', 'all')).toBe(2)
  })

  it('remove returns true and deletes the row', () => {
    const m = store.create({ profileId: 'p', content: 'x', source: 'user_pinned' })
    expect(store.remove(m.id)).toBe(true)
    expect(store.getById(m.id)).toBeNull()
    expect(store.remove(m.id)).toBe(false)
  })
})
