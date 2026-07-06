import { describe, it, expect } from 'vitest'
import { ToolResultCache } from '../result-cache.js'
import type { ToolResult } from '../types.js'

const ok = (content: string): ToolResult => ({ content, isError: false })
const err = (content: string): ToolResult => ({ content, isError: true })

describe('ToolResultCache', () => {
  it('returns null on miss and increments miss counter', () => {
    const c = new ToolResultCache()
    expect(c.get('readFile', 'foo:1')).toBeNull()
    expect(c.stats().misses).toBe(1)
    expect(c.stats().hits).toBe(0)
  })

  it('returns the stored result on hit and counts bytes saved', () => {
    const c = new ToolResultCache()
    c.set('readFile', 'foo:1', ok('hello world'))
    const got = c.get('readFile', 'foo:1')
    expect(got?.content).toBe('hello world')
    expect(c.stats().hits).toBe(1)
    expect(c.stats().bytesSaved).toBe(Buffer.byteLength('hello world', 'utf8'))
  })

  it('does not cache errors (transient failures must be retryable)', () => {
    const c = new ToolResultCache()
    c.set('readFile', 'foo:1', err('ENOENT'))
    expect(c.get('readFile', 'foo:1')).toBeNull()
    expect(c.stats().entries).toBe(0)
  })

  it('separates caches by tool name (no key collisions)', () => {
    const c = new ToolResultCache()
    c.set('readFile', 'k', ok('A'))
    c.set('grep', 'k', ok('B'))
    expect(c.get('readFile', 'k')?.content).toBe('A')
    expect(c.get('grep', 'k')?.content).toBe('B')
  })

  it('replaces the entry on duplicate set (and reconciles byte total)', () => {
    const c = new ToolResultCache()
    c.set('readFile', 'k', ok('AAAAA'))
    c.set('readFile', 'k', ok('BB'))
    expect(c.get('readFile', 'k')?.content).toBe('BB')
    expect(c.stats().bytes).toBe(2)
    expect(c.stats().entries).toBe(1)
  })

  it('LRU-evicts oldest entries when maxEntries is exceeded', () => {
    const c = new ToolResultCache({ maxEntries: 3 })
    c.set('t', 'a', ok('1'))
    c.set('t', 'b', ok('2'))
    c.set('t', 'c', ok('3'))
    c.set('t', 'd', ok('4'))
    expect(c.get('t', 'a')).toBeNull()
    expect(c.get('t', 'd')?.content).toBe('4')
  })

  it('LRU-evicts when total bytes exceeds maxBytes', () => {
    const c = new ToolResultCache({ maxBytes: 10 })
    c.set('t', 'a', ok('AAAAA'))   // 5 bytes
    c.set('t', 'b', ok('BBBBB'))   // 5 bytes — total 10, fits
    c.set('t', 'c', ok('CC'))      // 2 bytes — pushes total to 12, evicts oldest
    expect(c.get('t', 'a')).toBeNull()
    expect(c.get('t', 'b')?.content).toBe('BBBBB')
    expect(c.get('t', 'c')?.content).toBe('CC')
    expect(c.stats().bytes).toBeLessThanOrEqual(10)
  })

  it('touching an entry on get moves it to the LRU tail', () => {
    const c = new ToolResultCache({ maxEntries: 2 })
    c.set('t', 'a', ok('A'))
    c.set('t', 'b', ok('B'))
    c.get('t', 'a')               // touch a — now b is oldest
    c.set('t', 'c', ok('C'))      // evicts b, not a
    expect(c.get('t', 'a')?.content).toBe('A')
    expect(c.get('t', 'b')).toBeNull()
    expect(c.get('t', 'c')?.content).toBe('C')
  })

  it('clear() drops all entries and resets stats', () => {
    const c = new ToolResultCache()
    c.set('t', 'a', ok('hello'))
    c.get('t', 'a')
    c.get('t', 'missing')
    c.clear()
    const s = c.stats()
    expect(s.hits).toBe(0)
    expect(s.misses).toBe(0)
    expect(s.entries).toBe(0)
    expect(s.bytes).toBe(0)
    expect(s.bytesSaved).toBe(0)
  })
})
