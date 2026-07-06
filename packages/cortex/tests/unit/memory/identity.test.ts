import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { SqliteUserIdentityStore, MemoryEventBus } from '../../../src/memory/index.js'

let tmpDir: string
let db: CortexDatabase
let bus: MemoryEventBus
let store: SqliteUserIdentityStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-id-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  bus = new MemoryEventBus()
  store = new SqliteUserIdentityStore(db.rawMainHandle, bus)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('SqliteUserIdentityStore', () => {
  it('returns an empty record before first set', () => {
    expect(store.get()).toEqual({
      name: null,
      role: null,
      company: null,
      timezone: null,
      pronouns: null,
      preferences: null,
      updatedAt: null,
    })
  })

  it('upserts on first set and returns the saved row', () => {
    const r = store.set({ name: 'Sam', role: 'CEO' })
    expect(r.name).toBe('Sam')
    expect(r.role).toBe('CEO')
    expect(r.company).toBeNull()
    expect(r.updatedAt).not.toBeNull()
  })

  it('partial set leaves other fields untouched', () => {
    store.set({ name: 'A', role: 'B', company: 'C' })
    const r = store.set({ name: 'A2' })
    expect(r.name).toBe('A2')
    expect(r.role).toBe('B')
    expect(r.company).toBe('C')
  })

  it('null clears a field; undefined leaves it', () => {
    store.set({ name: 'A', role: 'B' })
    const r = store.set({ role: null })
    expect(r.name).toBe('A')
    expect(r.role).toBeNull()
  })

  it('emits memory.identity.changed on set', () => {
    let count = 0
    bus.subscribe((e) => {
      if (e.type === 'memory.identity.changed') count++
    })
    store.set({ name: 'A' })
    store.set({ role: 'B' })
    expect(count).toBe(2)
  })

  it('renderForPrompt returns null when empty', () => {
    expect(store.renderForPrompt()).toBeNull()
  })

  it('renderForPrompt produces a labelled markdown fragment', () => {
    store.set({
      name: 'Sam',
      role: 'Founder',
      company: 'Ownware',
      timezone: 'PST',
      preferences: 'Prefers concise responses\nUses Bun, not npm',
    })
    const fragment = store.renderForPrompt()
    expect(fragment).not.toBeNull()
    expect(fragment).toContain('## About the user')
    expect(fragment).toContain('Sam')
    expect(fragment).toContain('Founder')
    expect(fragment).toContain('Ownware')
    expect(fragment).toContain('Prefers concise responses')
    expect(fragment).toContain('Uses Bun')
  })
})
