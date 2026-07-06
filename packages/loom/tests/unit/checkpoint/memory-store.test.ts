import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryCheckpointStore } from '../../../src/checkpoint/memory-store.js'
import type { Checkpoint } from '../../../src/checkpoint/types.js'

function makeCheckpoint(sessionId: string, timestamp = Date.now()): Checkpoint {
  return {
    sessionId,
    messages: [{ role: 'user', content: 'Hello' }],
    turnIndex: 1,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.01,
    },
    timestamp,
  }
}

describe('MemoryCheckpointStore', () => {
  let store: MemoryCheckpointStore

  beforeEach(() => {
    store = new MemoryCheckpointStore()
  })

  it('save returns session ID', async () => {
    const cp = makeCheckpoint('sess-1')
    const id = await store.save(cp)
    expect(id).toBe('sess-1')
  })

  it('load returns saved checkpoint', async () => {
    const cp = makeCheckpoint('sess-1')
    await store.save(cp)

    const loaded = await store.load('sess-1')
    expect(loaded).toEqual(cp)
  })

  it('load returns null for unknown session', async () => {
    const loaded = await store.load('nonexistent')
    expect(loaded).toBeNull()
  })

  it('save overwrites existing checkpoint', async () => {
    await store.save(makeCheckpoint('sess-1', 1000))
    await store.save(makeCheckpoint('sess-1', 2000))

    const loaded = await store.load('sess-1')
    expect(loaded!.timestamp).toBe(2000)
    expect(store.size).toBe(1)
  })

  it('list returns all sessions sorted by timestamp descending', async () => {
    await store.save(makeCheckpoint('sess-old', 1000))
    await store.save(makeCheckpoint('sess-new', 3000))
    await store.save(makeCheckpoint('sess-mid', 2000))

    const list = await store.list()
    expect(list).toHaveLength(3)
    expect(list[0]!.sessionId).toBe('sess-new')
    expect(list[1]!.sessionId).toBe('sess-mid')
    expect(list[2]!.sessionId).toBe('sess-old')
  })

  it('list returns empty for fresh store', async () => {
    const list = await store.list()
    expect(list).toEqual([])
  })

  it('delete removes checkpoint', async () => {
    await store.save(makeCheckpoint('sess-1'))
    await store.delete('sess-1')

    const loaded = await store.load('sess-1')
    expect(loaded).toBeNull()
    expect(store.size).toBe(0)
  })

  it('delete is no-op for unknown session', async () => {
    await expect(store.delete('nonexistent')).resolves.toBeUndefined()
  })

  it('clear removes all checkpoints', async () => {
    await store.save(makeCheckpoint('sess-1'))
    await store.save(makeCheckpoint('sess-2'))
    store.clear()
    expect(store.size).toBe(0)
  })
})
