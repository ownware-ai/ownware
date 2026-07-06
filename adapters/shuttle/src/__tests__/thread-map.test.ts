import { describe, it, expect } from 'vitest'
import { InMemoryThreadMap } from '../thread-map.js'
import { sessionKey } from '../session-key.js'

describe('InMemoryThreadMap', () => {
  it('returns undefined for an unseen key (first contact → new thread upstream)', async () => {
    const map = new InMemoryThreadMap()
    expect(await map.get('ownware:acme:telegram:dm:1')).toBeUndefined()
  })

  it('remembers the threadId bound to a key (conversation continuity)', async () => {
    const map = new InMemoryThreadMap()
    const key = sessionKey({ profile: 'acme', channel: 'telegram', chatType: 'dm', chatId: '1' })
    await map.set(key, 'thread_abc')
    expect(await map.get(key)).toBe('thread_abc')
  })

  it('keeps two customers on separate threads', async () => {
    const map = new InMemoryThreadMap()
    const a = sessionKey({ profile: 'acme', channel: 'telegram', chatType: 'dm', chatId: '1' })
    const b = sessionKey({ profile: 'acme', channel: 'telegram', chatType: 'dm', chatId: '2' })
    await map.set(a, 'thread_a')
    await map.set(b, 'thread_b')
    expect(await map.get(a)).toBe('thread_a')
    expect(await map.get(b)).toBe('thread_b')
    expect(map.size).toBe(2)
  })

  it('forgets a key on delete (e.g. /new)', async () => {
    const map = new InMemoryThreadMap()
    const key = 'ownware:acme:telegram:dm:1'
    await map.set(key, 'thread_abc')
    await map.delete(key)
    expect(await map.get(key)).toBeUndefined()
  })
})
