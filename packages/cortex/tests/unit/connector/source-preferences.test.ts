/**
 * Tests for SourcePreferences — persistence of user per-alias source choice.
 *
 * Uses a trivial in-memory stub of SourcePreferencesStore so we never
 * touch SQLite; the underlying better-sqlite3-backed store is tested
 * elsewhere (user-settings CRUD in database.test.ts).
 *
 * STATE: The behavioural suite is skipped as of 2026-05-06 because the
 * `CONNECTOR_ALIASES` table is empty (Composio dropped from Tier 1).
 * `SourcePreferences.set()` validates against the alias table and
 * throws "Unknown alias logical key" for every key while the table is
 * empty, which makes round-trip tests untestable without mocking the
 * alias module. Re-enable the skipped block when the Advanced →
 * BYO-Composio surface re-populates the alias table — the tests
 * themselves don't need to change.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import {
  SourcePreferences,
  sourcePreferenceKey,
  type SourcePreferencesStore,
} from '../../../src/connector/source-preferences.js'

class MemStore implements SourcePreferencesStore {
  readonly data = new Map<string, string>()
  getSetting(key: string): { value: string } | undefined {
    const v = this.data.get(key)
    return v === undefined ? undefined : { value: v }
  }
  setSetting(key: string, value: string): unknown {
    this.data.set(key, value)
    return { value }
  }
  deleteSetting(key: string): boolean {
    return this.data.delete(key)
  }
}

describe('sourcePreferenceKey', () => {
  it('namespaces under connector.alias.<key>.source', () => {
    expect(sourcePreferenceKey('notion')).toBe('connector.alias.notion.source')
    expect(sourcePreferenceKey('github')).toBe('connector.alias.github.source')
  })
})

describe('SourcePreferences (alias-key-dependent paths — dormant while CONNECTOR_ALIASES is empty)', () => {
  let store: MemStore
  let prefs: SourcePreferences

  beforeEach(() => {
    store = new MemStore()
    prefs = new SourcePreferences(store)
  })

  it.skip('get returns null when nothing persisted', () => {
    expect(prefs.get('notion')).toBeNull()
  })

  it.skip('set + get round-trips', () => {
    prefs.set('notion', 'composio')
    expect(prefs.get('notion')).toBe('composio')
    expect(store.data.get('connector.alias.notion.source')).toBe('composio')
  })

  it.skip('set trims whitespace', () => {
    prefs.set('notion', '  composio  ')
    expect(prefs.get('notion')).toBe('composio')
  })

  it.skip('multiple keys are independent', () => {
    prefs.set('notion', 'composio')
    prefs.set('github', 'mcp')
    expect(prefs.get('notion')).toBe('composio')
    expect(prefs.get('github')).toBe('mcp')
    expect(prefs.get('slack')).toBeNull()
  })

  it.skip('clear removes the persisted value', () => {
    prefs.set('notion', 'composio')
    expect(prefs.clear('notion')).toBe(true)
    expect(prefs.get('notion')).toBeNull()
    // Second clear is a no-op.
    expect(prefs.clear('notion')).toBe(false)
  })

  it.skip('set throws on empty source', () => {
    expect(() => prefs.set('notion', '')).toThrow(/non-empty/)
    expect(() => prefs.set('notion', '   ')).toThrow(/non-empty/)
  })
})

describe('SourcePreferences (no-alias paths — testable while CONNECTOR_ALIASES is empty)', () => {
  let store: MemStore
  let prefs: SourcePreferences

  beforeEach(() => {
    store = new MemStore()
    prefs = new SourcePreferences(store)
  })

  it('set throws for an unknown logical key', () => {
    expect(() => prefs.set('not-a-key', 'mcp')).toThrow(/Unknown alias logical key/)
  })

  it('get for an unknown logical key returns null without hitting the store', () => {
    // Pre-seed a stray row under an unrelated key.
    store.data.set('connector.alias.unknown.source', 'mcp')
    expect(prefs.get('unknown')).toBeNull()
  })

  it('clear for an unknown logical key returns false', () => {
    expect(prefs.clear('unknown')).toBe(false)
  })
})
