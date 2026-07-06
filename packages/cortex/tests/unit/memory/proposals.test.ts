import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import {
  SqliteMemoryStore,
  SqliteMemoryProposalsStore,
  MemoryEventBus,
  type MemoryEvent,
} from '../../../src/memory/index.js'

let tmpDir: string
let db: CortexDatabase
let bus: MemoryEventBus
let memories: SqliteMemoryStore
let proposals: SqliteMemoryProposalsStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-mem-prop-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  bus = new MemoryEventBus()
  memories = new SqliteMemoryStore(db.rawMainHandle, bus)
  proposals = new SqliteMemoryProposalsStore(db.rawMainHandle, memories, bus)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('SqliteMemoryProposalsStore — propose', () => {
  it('creates a pending row with trimmed content and emits memory.proposed', () => {
    const events: MemoryEvent[] = []
    bus.subscribe((e) => events.push(e))

    const p = proposals.propose({
      profileId: 'p1',
      threadId: 't1',
      content: '   User uses Bun   ',
    })
    expect(p.id).toMatch(/^prop_/)
    expect(p.profileId).toBe('p1')
    expect(p.threadId).toBe('t1')
    expect(p.proposedContent).toBe('User uses Bun')
    expect(p.proposedKind).toBe('fact')
    expect(p.status).toBe('pending')
    expect(p.resolvedMemoryId).toBeNull()

    const proposed = events.filter((e) => e.type === 'memory.proposed')
    expect(proposed).toHaveLength(1)
    expect(proposed[0]).toMatchObject({
      type: 'memory.proposed',
      profileId: 'p1',
      threadId: 't1',
      proposalId: p.id,
    })
  })

  it('throws on empty content', () => {
    expect(() =>
      proposals.propose({ profileId: 'p1', threadId: 't1', content: '   ' }),
    ).toThrow(/empty/i)
  })

  it('dedupes identical pending content within the same thread', () => {
    const a = proposals.propose({ profileId: 'p1', threadId: 't1', content: 'X' })
    const b = proposals.propose({ profileId: 'p1', threadId: 't1', content: 'X' })
    expect(b.id).toBe(a.id)
    expect(proposals.countPendingForProfile('p1')).toBe(1)
  })

  it('does NOT dedupe across different threads', () => {
    const a = proposals.propose({ profileId: 'p', threadId: 't1', content: 'X' })
    const b = proposals.propose({ profileId: 'p', threadId: 't2', content: 'X' })
    expect(b.id).not.toBe(a.id)
  })

  it('does NOT dedupe against resolved (non-pending) rows', () => {
    const a = proposals.propose({ profileId: 'p', threadId: 't', content: 'X' })
    proposals.reject(a.id, null)
    const b = proposals.propose({ profileId: 'p', threadId: 't', content: 'X' })
    expect(b.id).not.toBe(a.id)
    expect(b.status).toBe('pending')
  })
})

describe('SqliteMemoryProposalsStore — accept', () => {
  it('accepts unedited → status="accepted", new memory created, lineage linked', () => {
    const p = proposals.propose({
      profileId: 'p1',
      threadId: 't1',
      content: 'User prefers concise responses',
      kind: 'preference',
    })
    const result = proposals.accept(p.id, {})
    expect(result).not.toBeNull()
    const { proposal, memory } = result!

    expect(proposal.status).toBe('accepted')
    expect(proposal.resolvedContent).toBe('User prefers concise responses')
    expect(proposal.resolvedMemoryId).toBe(memory.id)

    expect(memory.profileId).toBe('p1')
    expect(memory.content).toBe('User prefers concise responses')
    expect(memory.kind).toBe('preference')
    expect(memory.source).toBe('agent_proposed')
    expect(memory.sourceThreadId).toBe('t1')
    expect(memory.sourceProposalId).toBe(p.id)
    expect(memory.confidence).toBeGreaterThanOrEqual(0.9)
  })

  it('marks status="edited" when the user changed content', () => {
    const p = proposals.propose({ profileId: 'p', threadId: 't', content: 'original' })
    const { proposal, memory } = proposals.accept(p.id, { content: 'edited version' })!
    expect(proposal.status).toBe('edited')
    expect(memory.content).toBe('edited version')
  })

  it('pinned=true bumps confidence to 1.0 and pins the memory', () => {
    const p = proposals.propose({ profileId: 'p', threadId: 't', content: 'X' })
    const { memory } = proposals.accept(p.id, { pinned: true })!
    expect(memory.pinned).toBe(true)
    expect(memory.confidence).toBe(1.0)
  })

  it('emits memory.proposal.resolved on accept', () => {
    const p = proposals.propose({ profileId: 'p', threadId: 't', content: 'X' })
    const events: MemoryEvent[] = []
    bus.subscribe((e) => events.push(e))
    proposals.accept(p.id, {})
    const resolved = events.filter((e) => e.type === 'memory.proposal.resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({
      type: 'memory.proposal.resolved',
      proposalId: p.id,
      status: 'accepted',
    })
  })

  it('rejects double-accept loudly', () => {
    const p = proposals.propose({ profileId: 'p', threadId: 't', content: 'X' })
    proposals.accept(p.id, {})
    expect(() => proposals.accept(p.id, {})).toThrow(/expected "pending"/)
  })

  it('returns null for unknown id', () => {
    expect(proposals.accept('prop_nope', {})).toBeNull()
  })
})

describe('SqliteMemoryProposalsStore — reject', () => {
  it('flips to rejected with reason; emits resolved event; does not write a memory', () => {
    const p = proposals.propose({ profileId: 'p', threadId: 't', content: 'wrong' })
    const events: MemoryEvent[] = []
    bus.subscribe((e) => events.push(e))
    const r = proposals.reject(p.id, 'not relevant')
    expect(r?.status).toBe('rejected')
    expect(r?.rejectionReason).toBe('not relevant')

    expect(memories.countForProfile('p', 'all')).toBe(0)

    const resolved = events.filter((e) => e.type === 'memory.proposal.resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ status: 'rejected', proposalId: p.id })
  })

  it('does not double-reject', () => {
    const p = proposals.propose({ profileId: 'p', threadId: 't', content: 'X' })
    proposals.reject(p.id, null)
    expect(() => proposals.reject(p.id, null)).toThrow(/expected "pending"/)
  })
})

describe('SqliteMemoryProposalsStore — listing', () => {
  it('listForProfile returns most recent first; status filter works', () => {
    const a = proposals.propose({ profileId: 'p', threadId: 't', content: 'first' })
    const b = proposals.propose({ profileId: 'p', threadId: 't', content: 'second' })
    proposals.reject(a.id, null)

    const pending = proposals.listForProfile('p')
    expect(pending.map((p) => p.id)).toEqual([b.id])

    const all = proposals.listForProfile('p', { status: 'all' })
    expect(all).toHaveLength(2)
    // pending first when status=all per our ORDER BY
    expect(all[0]!.id).toBe(b.id)
  })

  it('listForThread returns only that thread', () => {
    const a = proposals.propose({ profileId: 'p', threadId: 't1', content: 'a' })
    proposals.propose({ profileId: 'p', threadId: 't2', content: 'b' })
    expect(proposals.listForThread('t1').map((p) => p.id)).toEqual([a.id])
  })

  it('countPendingForProfile only counts pending', () => {
    proposals.propose({ profileId: 'p', threadId: 't', content: 'a' })
    const b = proposals.propose({ profileId: 'p', threadId: 't', content: 'b' })
    proposals.reject(b.id, null)
    expect(proposals.countPendingForProfile('p')).toBe(1)
  })
})

describe('event bus does not break the fan-out when one listener throws', () => {
  it('subsequent listeners still receive events', () => {
    bus.subscribe(() => {
      throw new Error('boom')
    })
    const second = vi.fn()
    bus.subscribe(second)
    proposals.propose({ profileId: 'p', threadId: 't', content: 'X' })
    expect(second).toHaveBeenCalled()
  })
})
