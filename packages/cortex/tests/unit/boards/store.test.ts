import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { SqliteBoardStore } from '../../../src/boards/store.js'
import { BoardEventBus, type BoardUpdatedEvent } from '../../../src/boards/event-bus.js'

let tmpDir: string
let db: CortexDatabase
let bus: BoardEventBus
let store: SqliteBoardStore
let events: BoardUpdatedEvent[]

const WS = 'ws_board_1'

function seedWorkspace(id = WS, path = '/tmp/arvo-api'): string {
  db.rawMainHandle
    .prepare(`INSERT INTO workspaces (id, name, path) VALUES (?, 'arvo', ?)`)
    .run(id, path)
  return id
}

function sampleStructure(slug = 'login-hardening') {
  return {
    workspaceId: WS,
    slug,
    title: 'Harden login',
    goal: 'Stop credential stuffing',
    approach: 'Limiter first, then alerts.',
    slices: [
      { title: 'Rate-limit login', summary: '5/15m per IP', status: 'done' as const },
      { title: 'Email alerts', summary: 'once per lockout' },
      { title: 'Timing audit', summary: 'constant-time compare' },
    ],
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-boards-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  bus = new BoardEventBus()
  events = []
  bus.subscribe((e) => events.push(e))
  store = new SqliteBoardStore(db.rawMainHandle, bus)
  seedWorkspace()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('replaceStructure', () => {
  it('creates a board with ordered slices and emits one event', () => {
    const board = store.replaceStructure(sampleStructure())
    expect(board.id).toMatch(/^board_/)
    expect(board.workspaceId).toBe(WS)
    expect(board.status).toBe('draft')
    expect(board.slices).toHaveLength(3)
    expect(board.slices.map((s) => s.order)).toEqual([0, 1, 2])
    expect(board.slices[0]?.status).toBe('done')
    expect(board.slices[1]?.status).toBe('queued')
    expect(events).toHaveLength(1)
    expect(events[0]?.board.slices).toHaveLength(3)
  })

  it('is idempotent on (workspace, slug): same id, slices replaced', () => {
    const first = store.replaceStructure(sampleStructure())
    const second = store.replaceStructure({
      ...sampleStructure(),
      title: 'Harden login v2',
      slices: [{ title: 'Only one slice now' }],
    })
    expect(second.id).toBe(first.id)
    expect(second.title).toBe('Harden login v2')
    expect(second.slices).toHaveLength(1)
    expect(second.slices[0]?.title).toBe('Only one slice now')
    expect(store.listForWorkspace(WS)).toHaveLength(1)
  })

  it('getByWorkspaceSlug round-trips', () => {
    store.replaceStructure(sampleStructure('checkout'))
    const got = store.getByWorkspaceSlug(WS, 'checkout')
    expect(got?.slug).toBe('checkout')
    expect(store.getByWorkspaceSlug(WS, 'nope')).toBeNull()
  })
})

describe('atomic updates', () => {
  it('updateSliceStatus flips one slice and emits', () => {
    const board = store.replaceStructure(sampleStructure())
    const sliceId = board.slices[1]!.id
    events.length = 0
    const updated = store.updateSliceStatus(board.id, sliceId, 'running')
    expect(updated?.slices[1]?.status).toBe('running')
    expect(events).toHaveLength(1)
    expect(store.updateSliceStatus(board.id, 'nope', 'done')).toBeNull()
  })

  it('setBoardStatus moves the lifecycle', () => {
    const board = store.replaceStructure(sampleStructure())
    expect(store.setBoardStatus(board.id, 'running')?.status).toBe('running')
    expect(store.setBoardStatus(board.id, 'paused')?.status).toBe('paused')
    expect(store.setBoardStatus('nope', 'done')).toBeNull()
  })

  it('addFinding appends and survives a re-draft (findings preserved)', () => {
    const board = store.replaceStructure(sampleStructure())
    store.addFinding(board.id, {
      title: 'double-send race',
      detail: 'block() fires twice',
      sliceId: board.slices[1]!.id,
    })
    store.addFinding(board.id, { title: 'limiter resets on restart', status: 'deferred' })
    let fresh = store.getById(board.id)!
    expect(fresh.findings).toHaveLength(2)
    expect(fresh.findings.map((f) => f.order)).toEqual([0, 1])
    expect(fresh.findings[1]?.status).toBe('deferred')

    // Re-draft the structure — findings must remain.
    store.replaceStructure({ ...sampleStructure(), slices: [{ title: 'new slice' }] })
    fresh = store.getById(board.id)!
    expect(fresh.findings).toHaveLength(2)
    expect(fresh.slices).toHaveLength(1)
  })

  it('updateFindingStatus resolves a finding', () => {
    const board = store.replaceStructure(sampleStructure())
    const withFinding = store.addFinding(board.id, { title: 'bug' })!
    const findingId = withFinding.findings[0]!.id
    const resolved = store.updateFindingStatus(board.id, findingId, 'resolved')
    expect(resolved?.findings[0]?.status).toBe('resolved')
  })
})

describe('listForWorkspace', () => {
  it('summarizes boards with slice + done counts, newest first', () => {
    store.replaceStructure(sampleStructure('a'))
    store.replaceStructure(sampleStructure('b'))
    const list = store.listForWorkspace(WS)
    expect(list).toHaveLength(2)
    const a = list.find((b) => b.slug === 'a')!
    expect(a.sliceCount).toBe(3)
    expect(a.doneCount).toBe(1) // first slice seeded as 'done'
    expect(store.listForWorkspace('other')).toEqual([])
  })
})
