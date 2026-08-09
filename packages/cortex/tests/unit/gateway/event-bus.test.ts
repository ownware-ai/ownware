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
import { createSqliteCoreRepositoriesFromDatabase } from '../../../src/storage/sqlite-core-repositories.js'

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
    ingestor = new EventIngestor(
      createSqliteCoreRepositoriesFromDatabase(db, db.rawMainHandle).events,
      bus,
    )
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

  it('assigns monotonic seq numbers per (thread, agent) stream', async () => {
    const seq1 = await ingestor.ingestParentEvent(threadId, makeTextDelta('a'))
    const seq2 = await ingestor.ingestParentEvent(threadId, makeTextDelta('b'))
    const seq3 = await ingestor.ingestParentEvent(threadId, makeTextDelta('c'))
    expect(seq1).toBe(1)
    expect(seq2).toBe(2)
    expect(seq3).toBe(3)
  })

  it('seq numbers are per-agent, not per-thread', async () => {
    const parentSeq = await ingestor.ingestParentEvent(threadId, makeTextDelta('root'))
    const childSeq = await ingestor.ingestSubagentEvent(threadId, 'agent_x', makeTextDelta('child'))
    // Both should be seq 1 — they're on different (thread, agent) streams.
    expect(parentSeq).toBe(1)
    expect(childSeq).toBe(1)

    const parentSeq2 = await ingestor.ingestParentEvent(threadId, makeTextDelta('root2'))
    expect(parentSeq2).toBe(2) // still increments the parent stream
  })

  it('writes to DB and publishes to bus in order', async () => {
    const received: Array<{ seq: number; text: string }> = []
    bus.subscribe(threadId, ROOT_AGENT_ID, entry => {
      received.push({
        seq: entry.seq,
        text: (entry.event as { text: string }).text,
      })
    })

    await ingestor.ingestParentEvent(threadId, makeTextDelta('first'))
    await ingestor.ingestParentEvent(threadId, makeTextDelta('second'))

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

  it('lifecycle rewrite: subagent-emitted agent.spawn lands on parent stream', async () => {
    // A sub-agent's createGenerator yields an agent.spawn event tagged
    // with its own handle id. The ingestor must rewrite this onto the
    // parent stream so the client's main chat shows the "card" marker.
    await ingestor.ingestSubagentEvent(threadId, 'agent_child', makeAgentSpawn('agent_child', ROOT_AGENT_ID))

    const parentRows = db.listAgentEvents({ threadId, agentId: ROOT_AGENT_ID })
    const childRows = db.listAgentEvents({ threadId, agentId: 'agent_child' })

    expect(parentRows).toHaveLength(1)
    expect(parentRows[0]!.type).toBe('agent.spawn')
    // The subagent's own stream does NOT have its own spawn event.
    expect(childRows).toHaveLength(0)
  })

  it('lifecycle rewrite: subagent-emitted agent.complete lands on parent stream', async () => {
    await ingestor.ingestSubagentEvent(threadId, 'agent_child', makeAgentComplete('agent_child'))

    const parentRows = db.listAgentEvents({ threadId, agentId: ROOT_AGENT_ID })
    const childRows = db.listAgentEvents({ threadId, agentId: 'agent_child' })

    expect(parentRows).toHaveLength(1)
    expect(parentRows[0]!.type).toBe('agent.complete')
    expect(childRows).toHaveLength(0)
  })

  it('non-lifecycle subagent events stay on the child stream', async () => {
    // text.delta and tool events must stay on the subagent's own stream
    // — they are the content the "View thread" modal needs.
    await ingestor.ingestSubagentEvent(threadId, 'agent_child', makeTextDelta('child text'))
    await ingestor.ingestSubagentEvent(threadId, 'agent_child', makeTextDelta(' more'))

    const parentRows = db.listAgentEvents({ threadId, agentId: ROOT_AGENT_ID })
    const childRows = db.listAgentEvents({ threadId, agentId: 'agent_child' })

    expect(parentRows).toHaveLength(0)
    expect(childRows).toHaveLength(2)
    const texts = childRows.map(r => (r.payload as { text: string }).text)
    expect(texts).toEqual(['child text', ' more'])
  })

  it('full subagent lifecycle: spawn → content → complete splits correctly', async () => {
    // Simulates the full event order a Loom subagent generator emits.
    await ingestor.ingestSubagentEvent(threadId, 'agent_x', makeAgentSpawn('agent_x', ROOT_AGENT_ID))
    await ingestor.ingestSubagentEvent(threadId, 'agent_x', makeTextDelta('hello '))
    await ingestor.ingestSubagentEvent(threadId, 'agent_x', makeTextDelta('world'))
    await ingestor.ingestSubagentEvent(threadId, 'agent_x', makeAgentComplete('agent_x'))

    const parentRows = db.listAgentEvents({ threadId, agentId: ROOT_AGENT_ID })
    const childRows = db.listAgentEvents({ threadId, agentId: 'agent_x' })

    // Parent sees two cards-worth of lifecycle markers.
    expect(parentRows.map(r => r.type)).toEqual(['agent.spawn', 'agent.complete'])

    // Child sees just the conversational content.
    expect(childRows.map(r => r.type)).toEqual(['text.delta', 'text.delta'])
    expect(childRows.map(r => (r.payload as { text: string }).text)).toEqual(['hello ', 'world'])
  })

  it('listAgentEvents respects the `since` cursor for resume', async () => {
    for (let i = 0; i < 10; i++) {
      await ingestor.ingestParentEvent(threadId, makeTextDelta(`chunk-${i}`))
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
      await ingestor.ingestParentEvent(threadId, makeTextDelta(`p${i}`))
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
    await ingestor.ingestParentEvent(threadId, makeTextDelta('late-arrival'))
    const lateInBuffer = buffered.filter(e => e.seq > lastReplayedSeq)
    expect(lateInBuffer).toHaveLength(1)
    expect(lateInBuffer[0]!.text).toBe('late-arrival')

    // Now flip to live mode — future events forward directly.
    draining = false
  })

  it('subscribers survive writes from multiple ingestors simultaneously', async () => {
    // Verifies that seq assignment is atomic and doesn't collide
    // when two ingestors share the same bus + DB. This is a cheap
    // stand-in for the future case where a subagent and its parent
    // both write to the same thread concurrently.
    const ing2 = new EventIngestor(
      createSqliteCoreRepositoriesFromDatabase(db, db.rawMainHandle).events,
      bus,
    )

    const received: Array<{ seq: number; text: string }> = []
    bus.subscribe(threadId, ROOT_AGENT_ID, entry => {
      received.push({
        seq: entry.seq,
        text: (entry.event as { text: string }).text,
      })
    })

    await Promise.all(Array.from({ length: 5 }, async (_, i) => {
      await Promise.all([
        ingestor.ingestParentEvent(threadId, makeTextDelta(`a${i}`)),
        ing2.ingestParentEvent(threadId, makeTextDelta(`b${i}`)),
      ])
    }))

    // 10 total writes, seq 1..10, no collisions, no gaps.
    const seqs = received.map(r => r.seq)
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('publishes only after a separate connection can read the committed row', async () => {
    const observer = new CortexDatabase(join(tmpDir, 'test.db'))
    try {
      const visibleAtPublish: number[] = []
      bus.subscribe(threadId, ROOT_AGENT_ID, entry => {
        const rows = observer.listAgentEvents({
          threadId,
          agentId: ROOT_AGENT_ID,
          since: entry.seq - 1,
        })
        if (rows.some(row => row.seq === entry.seq)) visibleAtPublish.push(entry.seq)
      })

      await ingestor.ingestParentEvent(threadId, makeTextDelta('committed-first'))
      expect(visibleAtPublish).toEqual([1])
    } finally {
      observer.close()
    }
  })

  it('does not publish a failed insert or consume its sequence number', async () => {
    const secretCanary = 'customer-secret-forced-storage-failure'
    const published: number[] = []
    bus.subscribe(threadId, ROOT_AGENT_ID, entry => published.push(entry.seq))
    db.rawMainHandle.exec(`
      CREATE TRIGGER fail_synthetic_agent_event
      BEFORE INSERT ON agent_events
      WHEN NEW.type = 'test.synthetic_failure'
      BEGIN
        SELECT RAISE(FAIL, '${secretCanary}');
      END
    `)

    const failure = await ingestor.ingestParentEvent(threadId, {
      type: 'test.synthetic_failure',
    } as unknown as LoomEvent).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      name: 'StorageRepositoryError',
      code: 'write_failed',
      kind: 'sqlite',
      domain: 'events',
      operation: 'append',
      retryable: false,
    })
    expect(String(failure)).not.toContain(secretCanary)
    expect(published).toEqual([])
    expect(db.getAgentEventMaxSeq(threadId, ROOT_AGENT_ID)).toBe(0)

    db.rawMainHandle.exec('DROP TRIGGER fail_synthetic_agent_event')
    await expect(
      ingestor.ingestParentEvent(threadId, makeTextDelta('after-failure')),
    ).resolves.toBe(1)
    expect(published).toEqual([1])
  })

  it('fails closed on SQLite full and read-only faults, then resumes without a gap', async () => {
    const secretCanary = 'customer-secret-storage-fault-payload'
    const published: Array<{ readonly seq: number; readonly type: string }> = []
    bus.subscribe(threadId, ROOT_AGENT_ID, ({ seq, event }) => {
      published.push({ seq, type: event.type })
    })

    const pageCount = db.rawMainHandle.pragma('page_count', { simple: true }) as number
    const pageSize = db.rawMainHandle.pragma('page_size', { simple: true }) as number
    const freePages = db.rawMainHandle.pragma('freelist_count', { simple: true }) as number
    db.rawMainHandle.pragma(`max_page_count = ${pageCount}`)
    const diskFullFailure = await ingestor.ingestParentEvent(threadId, {
      type: 'test.sqlite_full',
      turnIndex: 0,
      text: `${secretCanary}${'x'.repeat((freePages + 8) * pageSize)}`,
    } as unknown as LoomEvent).catch((error: unknown) => error)
    expect(diskFullFailure).toMatchObject({
      name: 'StorageRepositoryError',
      code: 'write_failed',
      kind: 'sqlite',
      domain: 'events',
      operation: 'append',
      retryable: false,
    })
    expect(String(diskFullFailure)).not.toContain(secretCanary)
    expect(published).toEqual([])
    expect(db.getAgentEventMaxSeq(threadId, ROOT_AGENT_ID)).toBe(0)
    db.rawMainHandle.pragma('max_page_count = 1073741823')

    db.rawMainHandle.pragma('query_only = ON')
    const readOnlyFailure = await ingestor.ingestParentEvent(threadId, {
      type: 'test.sqlite_readonly',
      turnIndex: 0,
      text: secretCanary,
    } as unknown as LoomEvent).catch((error: unknown) => error)
    expect(readOnlyFailure).toMatchObject({
      name: 'StorageRepositoryError',
      code: 'write_failed',
      kind: 'sqlite',
      domain: 'events',
      operation: 'append',
      retryable: false,
    })
    expect(String(readOnlyFailure)).not.toContain(secretCanary)
    expect(published).toEqual([])
    expect(db.getAgentEventMaxSeq(threadId, ROOT_AGENT_ID)).toBe(0)

    db.rawMainHandle.pragma('query_only = OFF')
    await expect(ingestor.ingestParentEvent(
      threadId,
      makeTextDelta('authority-restored'),
    )).resolves.toBe(1)
    expect(published).toEqual([{ seq: 1, type: 'text.delta' }])
    expect(db.getAgentEventMaxSeq(threadId, ROOT_AGENT_ID)).toBe(1)
  })
})
