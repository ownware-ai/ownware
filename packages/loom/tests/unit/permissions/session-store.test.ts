import { describe, it, expect, beforeEach } from 'vitest'
import { SessionPermissionStore } from '../../../src/permissions/session-store.js'

describe('SessionPermissionStore', () => {
  let store: SessionPermissionStore

  beforeEach(() => {
    store = new SessionPermissionStore()
  })

  it('starts empty', () => {
    expect(store.size).toBe(0)
    expect(store.check('shell')).toBeNull()
  })

  it('remembers a decision', () => {
    store.remember('shell', 'allow')
    expect(store.check('shell')).toBe('allow')
  })

  it('remembers deny decisions', () => {
    store.remember('browser', 'deny')
    expect(store.check('browser')).toBe('deny')
  })

  it('remembers ask decisions', () => {
    store.remember('filesystem.write', 'ask')
    expect(store.check('filesystem.write')).toBe('ask')
  })

  it('overwrites a previous decision', () => {
    store.remember('shell', 'deny')
    store.remember('shell', 'allow')
    expect(store.check('shell')).toBe('allow')
  })

  it('returns null for unknown tools', () => {
    store.remember('shell', 'allow')
    expect(store.check('unknown_tool')).toBeNull()
  })

  it('forgets a decision', () => {
    store.remember('shell', 'allow')
    store.forget('shell')
    expect(store.check('shell')).toBeNull()
    expect(store.size).toBe(0)
  })

  it('forget on nonexistent tool is a no-op', () => {
    store.forget('nonexistent')
    expect(store.size).toBe(0)
  })

  it('clears all decisions', () => {
    store.remember('shell', 'allow')
    store.remember('browser', 'deny')
    store.remember('filesystem.read', 'allow')
    expect(store.size).toBe(3)

    store.clear()
    expect(store.size).toBe(0)
    expect(store.check('shell')).toBeNull()
    expect(store.check('browser')).toBeNull()
  })

  it('tracks size correctly', () => {
    expect(store.size).toBe(0)
    store.remember('a', 'allow')
    expect(store.size).toBe(1)
    store.remember('b', 'deny')
    expect(store.size).toBe(2)
    store.remember('a', 'deny') // overwrite, not new
    expect(store.size).toBe(2)
  })

  it('returns entries as ReadonlyMap', () => {
    store.remember('shell', 'allow')
    store.remember('browser', 'deny')
    const entries = store.entries()
    expect(entries.get('shell')).toBe('allow')
    expect(entries.get('browser')).toBe('deny')
    expect(entries.size).toBe(2)
  })
})
