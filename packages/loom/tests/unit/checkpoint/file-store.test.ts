import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FileCheckpointStore } from '../../../src/checkpoint/file-store.js'
import type { Checkpoint } from '../../../src/checkpoint/types.js'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

function makeCheckpoint(sessionId: string, timestamp = Date.now()): Checkpoint {
  return {
    sessionId,
    messages: [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
    ],
    turnIndex: 2,
    usage: {
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 50,
      cacheCreationTokens: 10,
      costUsd: 0.05,
    },
    timestamp,
  }
}

describe('FileCheckpointStore', () => {
  let dir: string
  let store: FileCheckpointStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-checkpoint-test-'))
    store = new FileCheckpointStore(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('save writes file and returns session ID', async () => {
    const cp = makeCheckpoint('sess-1')
    const id = await store.save(cp)
    expect(id).toBe('sess-1')
  })

  it('load returns saved checkpoint', async () => {
    const cp = makeCheckpoint('sess-1', 1700000000000)
    await store.save(cp)

    const loaded = await store.load('sess-1')
    expect(loaded).not.toBeNull()
    expect(loaded!.sessionId).toBe('sess-1')
    expect(loaded!.messages).toHaveLength(3)
    expect(loaded!.turnIndex).toBe(2)
    expect(loaded!.usage.inputTokens).toBe(200)
    expect(loaded!.timestamp).toBe(1700000000000)
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
  })

  it('list returns all sessions', async () => {
    await store.save(makeCheckpoint('sess-a'))
    await store.save(makeCheckpoint('sess-b'))
    await store.save(makeCheckpoint('sess-c'))

    const list = await store.list()
    expect(list).toHaveLength(3)
    const ids = list.map(e => e.sessionId).sort()
    expect(ids).toEqual(['sess-a', 'sess-b', 'sess-c'])
  })

  it('list returns empty for empty directory', async () => {
    const list = await store.list()
    expect(list).toEqual([])
  })

  it('list returns empty when directory does not exist', async () => {
    const nonexistent = new FileCheckpointStore('/tmp/loom-nonexistent-dir-test')
    const list = await nonexistent.list()
    expect(list).toEqual([])
  })

  it('delete removes checkpoint file', async () => {
    await store.save(makeCheckpoint('sess-1'))
    await store.delete('sess-1')

    const loaded = await store.load('sess-1')
    expect(loaded).toBeNull()
  })

  it('delete is no-op for unknown session', async () => {
    await expect(store.delete('nonexistent')).resolves.toBeUndefined()
  })

  it('creates directory on first save if not exists', async () => {
    const nested = join(dir, 'deep', 'nested', 'dir')
    const nestedStore = new FileCheckpointStore(nested)

    await nestedStore.save(makeCheckpoint('sess-1'))
    const loaded = await nestedStore.load('sess-1')
    expect(loaded).not.toBeNull()
  })

  it('sanitizes session IDs to prevent path traversal', async () => {
    const cp = makeCheckpoint('../../etc/passwd')
    await store.save(cp)

    // Should be saved as a safe filename, not traversing directories
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.sessionId).not.toContain('/')
  })

  it('handles corrupt JSON gracefully', async () => {
    // Write corrupt data directly
    const { writeFile } = await import('fs/promises')
    await writeFile(join(dir, 'corrupt.json'), 'not valid json', 'utf-8')

    const loaded = await store.load('corrupt')
    expect(loaded).toBeNull()
  })
})
