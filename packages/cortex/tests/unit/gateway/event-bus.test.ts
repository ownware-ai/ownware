/**
 * Unit tests — EventBus + EventIngestor
 *
 * Fast, in-process tests for the subagent-streaming plumbing. No API
 * calls, no real gateway — just the bus, the ingestor, and a sqlite
 * file in a temp dir.
 *
 * These cover the machinery that the E2E test cannot cheaply verify:
 *
 *   1. Bus fan-out — multiple subscribers get the same event
 *   2. Unsubscribe cleanup — no stale listeners after callback returns
 *   3. Ingestor writes to DB before publishing to bus
 *   4. Monotonic seq numbering per (thread, agent)
 *   5. The lifecycle rewrite rule: agent.spawn/complete from a subagent
 *      generator re-tag onto the parent's agent_id stream
 *   6. Subscribe-before-read race — if the handler subscribes first, no
 *      events are lost even if a write races between subscribe and read
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { LoomEvent } from '@ownware/loom'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { EventBus, ROOT_AGENT_ID } from '../../../src/gateway/event-bus.js'
import { EventIngestor } from '../../../src/gateway/event-ingestor.js'

function makeTextDelta(text: string): LoomEvent {
  return { type: 'text.delta', text, turnIndex: 0 } as LoomEvent
}

function makeAgentSpawn(agentId: string, parentAgentId: string | null): LoomEvent {
  return {
    type: 'agent.spawn',
    agentId,
    profileName: 'test',
    parentAgentId,
    turnIndex: 0,
  } as unknown as LoomEvent
}

function makeAgentComplete(agentId: string): LoomEvent {
  return {
    type: 'agent.complete',
    agentId,
    result: 'done',
    durationMs: 10,
    turnIndex: 1,
  } as unknown as LoomEvent
}

describe('EventBus', () => {
  let bus: EventBus

  beforeEach(() => {
    bus = new EventBus()
  })

  afterEach(() => {
    bus.clear()
  })

  it('publishes to subscribers on the matching channel only', () => {
    const a: string[] = []
    const b: string[] = []
    const c: string[] = []

    bus.subscribe('t1', 'root', e => a.push((e.event as { text: string }).text))
    bus.subscribe('t1', 'root', e => b.push((e.event as { text: string }).text))
    bus.subscribe('t1', 'agent_x', e => c.push((e.event as { text: string }).text))

    bus.publish('t1', 'root', { seq: 1, event: makeTextDelta('hello') })
    bus.publish('t1', 'agent_x', { seq: 1, event: makeTextDelta('other') })
    bus.publish('t2', 'root', { seq: 1, event: makeTextDelta('different thread') })

    expect(a).toEqual(['hello'])
    expect(b).toEqual(['hello'])
    expect(c).toEqual(['other'])
  })

  it('unsubscribe removes the listener and closes the channel when empty', () => {
    expect(bus.channelCount).toBe(0)
    const unsub = bus.subscribe('t1', 'root', () => {})
    expect(bus.channelCount).toBe(1)
    expect(bus.hasSubscribers('t1', 'root')).toBe(true)
    unsub()
    expect(bus.hasSubscribers('t1', 'root')).toBe(false)
    expect(bus.channelCount).toBe(0)
  })

  it('unsubscribe is idempotent — calling twice does not crash', () => {
    const unsub = bus.subscribe('t1', 'root', () => {})
    unsub()
    expect(() => unsub()).not.toThrow()
  })

  it('publish to a channel with no subscribers is a silent no-op', () => {
    expect(() => {
      bus.publish('nonexistent', 'root', { seq: 1, event: makeTextDelta('x') })
    }).not.toThrow()
  })

  it('clear() removes every listener from every channel', () => {
    bus.subscribe('t1', 'root', () => {})
    bus.subscribe('t2', 'agent_x', () => {})
    bus.subscribe('t2', 'agent_y', () => {})
    expect(bus.channelCount).toBe(3)
    bus.clear()
    expect(bus.channelCount).toBe(0)
  })
})

describe('EventIngestor', () => {
  let tmpDir: string
  let db: CortexDatabase
  let bus: EventBus
  let ingestor: EventIngestor
  let threadId: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-ing-'))
    db = new CortexDatabase(join(tmpDir, 'test.db'))
    bus = new EventBus()
    ingestor = new EventIngestor(db, bus)
    // Need a real thread row — foreign keys not enforced on agent_events
    // but the parent event path expects the thread to exist via gateway
    // state. The ingestor itself only touches agent_events so it's fine.
    const thread = db.createThread('test-profile')
    threadId = thread.id
  })

  afterEach(() => {
    bus.clear()
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('assigns monotonic seq numbers per (thread, agent) stream', () => {
    const seq1 = ingestor.ingestParentEvent(threadId, makeTextDelta('a'))
    const seq2 = ingestor.ingestParentEvent(threadId, makeTextDelta('b'))
    const seq3 = ingestor.ingestParentEvent(threadId, makeTextDelta('c'))
    expect(seq1).toBe(1)
    expect(seq2).toBe(2)
    expect(seq3).toBe(3)
  })

  it('seq numbers are per-agent, not per-thread', () => {
    const parentSeq = ingestor.ingestParentEvent(threadId, makeTextDelta('root'))
    const childSeq = ingestor.ingestSubagentEvent(threadId, 'agent_x', makeTextDelta('child'))
    // Both should be seq 1 — they're on different (thread, agent) streams.
    expect(parentSeq).toBe(1)
    expect(childSeq).toBe(1)

    const parentSeq2 = ingestor.ingestParentEvent(threadId, makeTextDelta('root2'))
    expect(parentSeq2).toBe(2) // still increments the parent stream
  })

  it('writes to DB and publishes to bus in order', () => {
    const received: Array<{ seq: number; text: string }> = []
    bus.subscribe(threadId, ROOT_AGENT_ID, entry => {
      received.push({
        seq: entry.seq,
        text: (entry.event as { text: string }).text,
      })
    })

    ingestor.ingestParentEvent(threadId, makeTextDelta('first'))
    ingestor.ingestParentEvent(threadId, makeTextDelta('second'))

    expect(received).toEqual([
      { seq: 1, text: 'first' },
      { seq: 2, text: 'second' },
    ])

    // And the same events are also on disk — the bus is a mirror, not
    // the source of truth.
    const rows = db.listAgentEvents({ threadId, agentId: ROOT_AGENT_ID })
    expect(rows).toHaveLength(2)
    expect(rows[0]!.seq).toBe(1)
    expect(rows[1]!.seq).toBe(2)
  })

  it('lifecycle rewrite: subagent-emitted agent.spawn lands on parent stream', () => {
    // A sub-agent's createGenerator yields an agent.spawn event tagged
    // with its own handle id. The ingestor must rewrite this onto the
    // parent stream so the client's main chat shows the "card" marker.
    ingestor.ingestSubagentEvent(threadId, 'agent_child', makeAgentSpawn('agent_child', ROOT_AGENT_ID))

    const parentRows = db.listAgentEvents({ threadId, agentId: ROOT_AGENT_ID })
    const childRows = db.listAgentEvents({ threadId, agentId: 'agent_child' })

    expect(parentRows).toHaveLength(1)
    expect(parentRows[0]!.type).toBe('agent.spawn')
    // The subagent's own stream does NOT have its own spawn event.
    expect(childRows).toHaveLength(0)
  })

  it('lifecycle rewrite: subagent-emitted agent.complete lands on parent stream', () => {
    ingestor.ingestSubagentEvent(threadId, 'agent_child', makeAgentComplete('agent_child'))

    const parentRows = db.listAgentEvents({ threadId, agentId: ROOT_AGENT_ID })
    const childRows = db.listAgentEvents({ threadId, agentId: 'agent_child' })

    expect(parentRows).toHaveLength(1)
    expect(parentRows[0]!.type).toBe('agent.complete')
    expect(childRows).toHaveLength(0)
  })

  it('non-lifecycle subagent events stay on the child stream', () => {
    // text.delta and tool events must stay on the subagent's own stream
    // — they are the content the "View thread" modal needs.
    ingestor.ingestSubagentEvent(threadId, 'agent_child', makeTextDelta('child text'))
    ingestor.ingestSubagentEvent(threadId, 'agent_child', makeTextDelta(' more'))

    const parentRows = db.listAgentEvents({ threadId, agentId: ROOT_AGENT_ID })
    const childRows = db.listAgentEvents({ threadId, agentId: 'agent_child' })

    expect(parentRows).toHaveLength(0)
    expect(childRows).toHaveLength(2)
    const texts = childRows.map(r => (r.payload as { text: string }).text)
    expect(texts).toEqual(['child text', ' more'])
  })

  it('full subagent lifecycle: spawn → content → complete splits correctly', () => {
    // Simulates the full event order a Loom subagent generator emits.
    ingestor.ingestSubagentEvent(threadId, 'agent_x', makeAgentSpawn('agent_x', ROOT_AGENT_ID))
    ingestor.ingestSubagentEvent(threadId, 'agent_x', makeTextDelta('hello '))
    ingestor.ingestSubagentEvent(threadId, 'agent_x', makeTextDelta('world'))
    ingestor.ingestSubagentEvent(threadId, 'agent_x', makeAgentComplete('agent_x'))

    const parentRows = db.listAgentEvents({ threadId, agentId: ROOT_AGENT_ID })
    const childRows = db.listAgentEvents({ threadId, agentId: 'agent_x' })

    // Parent sees two cards-worth of lifecycle markers.
    expect(parentRows.map(r => r.type)).toEqual(['agent.spawn', 'agent.complete'])

    // Child sees just the conversational content.
    expect(childRows.map(r => r.type)).toEqual(['text.delta', 'text.delta'])
    expect(childRows.map(r => (r.payload as { text: string }).text)).toEqual(['hello ', 'world'])
  })

  it('listAgentEvents respects the `since` cursor for resume', () => {
    for (let i = 0; i < 10; i++) {
      ingestor.ingestParentEvent(threadId, makeTextDelta(`chunk-${i}`))
    }

    const firstHalf = db.listAgentEvents({ threadId, agentId: ROOT_AGENT_ID, since: 0, limit: 5 })
    expect(firstHalf).toHaveLength(5)
    expect(firstHalf[0]!.seq).toBe(1)
    expect(firstHalf[4]!.seq).toBe(5)

    const secondHalf = db.listAgentEvents({ threadId, agentId: ROOT_AGENT_ID, since: 5 })
    expect(secondHalf).toHaveLength(5)
    expect(secondHalf[0]!.seq).toBe(6)
    expect(secondHalf[4]!.seq).toBe(10)
  })

  it('subscribe-before-read race: no events lost between subscribe and DB read', async () => {
    // This simulates the SSE handler's exact flow:
    //   1. subscribe — buffer events
    //   2. producer writes events 1..N to DB (and they hit the bus)
    //   3. reader reads DB up to current max
    //   4. drain buffer, skipping seq <= last-replayed
    //
    // If the subscribe happens AFTER the read, events written between
    // the read and the subscribe vanish. The handler's correctness is
    // guaranteed by this order.

    const buffered: Array<{ seq: number; text: string }> = []
    let draining = true

    bus.subscribe(threadId, ROOT_AGENT_ID, entry => {
      if (draining) {
        buffered.push({
          seq: entry.seq,
          text: (entry.event as { text: string }).text,
        })
      }
    })

    // Now the "producer" writes. In a real run this is another async
    // context; here we run sequentially since it's all in-process.
    for (let i = 0; i < 5; i++) {
      ingestor.ingestParentEvent(threadId, makeTextDelta(`p${i}`))
    }

    // Now the "reader" does a DB read. Simulates replay.
    const replayed = db.listAgentEvents({ threadId, agentId: ROOT_AGENT_ID })
    expect(replayed).toHaveLength(5)

    // Everything in the buffer is a duplicate of the DB because we
    // subscribed BEFORE the writes. The drain step skips all 5.
    const lastReplayedSeq = replayed[replayed.length - 1]!.seq
    const toForward = buffered.filter(e => e.seq > lastReplayedSeq)
    expect(toForward).toHaveLength(0)

    // Now a late write lands — the drain hasn't completed yet but
    // we've already noted lastReplayedSeq. The subscribe callback is
    // still buffering (draining=true), so the late write is captured.
    ingestor.ingestParentEvent(threadId, makeTextDelta('late-arrival'))
    const lateInBuffer = buffered.filter(e => e.seq > lastReplayedSeq)
    expect(lateInBuffer).toHaveLength(1)
    expect(lateInBuffer[0]!.text).toBe('late-arrival')

    // Now flip to live mode — future events forward directly.
    draining = false
  })

  it('subscribers survive writes from multiple ingestors simultaneously', () => {
    // Verifies that seq assignment is atomic and doesn't collide
    // when two ingestors share the same bus + DB. This is a cheap
    // stand-in for the future case where a subagent and its parent
    // both write to the same thread concurrently.
    const ing2 = new EventIngestor(db, bus)

    const received: Array<{ seq: number; text: string }> = []
    bus.subscribe(threadId, ROOT_AGENT_ID, entry => {
      received.push({
        seq: entry.seq,
        text: (entry.event as { text: string }).text,
      })
    })

    for (let i = 0; i < 5; i++) {
      ingestor.ingestParentEvent(threadId, makeTextDelta(`a${i}`))
      ing2.ingestParentEvent(threadId, makeTextDelta(`b${i}`))
    }

    // 10 total writes, seq 1..10, no collisions, no gaps.
    const seqs = received.map(r => r.seq)
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
})
