import { describe, it, expect, beforeEach } from 'vitest'

import {
  loadKnownApps,
  lookupKnownAppByLogicalKey,
  lookupKnownAppByPlatformId,
  knownAppCategoryToConnectorCategory,
  __resetKnownAppsCacheForTests,
} from '../../../src/connector/known-apps.js'

beforeEach(() => {
  __resetKnownAppsCacheForTests()
})

describe('loadKnownApps', () => {
  it('loads the file and indexes by logical key + platform id', async () => {
    const idx = await loadKnownApps()
    // The known-apps.json catalog ships with at least Figma + Slack + Notion.
    // The exact set may grow; pin only the ones we know are stable.
    expect(idx.byLogicalKey.size).toBeGreaterThan(0)
    expect(idx.byPlatformId.size).toBeGreaterThan(0)
  })

  it('returns the same index on repeated calls (cached)', async () => {
    const a = await loadKnownApps()
    const b = await loadKnownApps()
    expect(a).toBe(b)
  })

  it('coalesces concurrent loads into a single in-flight promise', async () => {
    __resetKnownAppsCacheForTests()
    const [a, b, c] = await Promise.all([
      loadKnownApps(),
      loadKnownApps(),
      loadKnownApps(),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)
  })
})

describe('lookupKnownAppByLogicalKey', () => {
  it('returns null before the catalog is loaded', () => {
    expect(lookupKnownAppByLogicalKey('figma')).toBeNull()
  })

  it('returns the entry for a known logical key once loaded', async () => {
    await loadKnownApps()
    const figma = lookupKnownAppByLogicalKey('figma')
    expect(figma).not.toBeNull()
    expect(figma!.name).toBe('Figma')
    expect(figma!.category).toBe('design')
  })

  it('returns null for an unknown logical key', async () => {
    await loadKnownApps()
    expect(lookupKnownAppByLogicalKey('does-not-exist-xyz')).toBeNull()
  })
})

describe('lookupKnownAppByPlatformId', () => {
  it('returns null before the catalog is loaded', () => {
    expect(lookupKnownAppByPlatformId('com.figma.Desktop')).toBeNull()
  })

  it('returns the entry for a known macOS bundle id', async () => {
    await loadKnownApps()
    const figma = lookupKnownAppByPlatformId('com.figma.Desktop')
    expect(figma).not.toBeNull()
    expect(figma!.name).toBe('Figma')
  })

  it('returns null for an unknown platform id', async () => {
    await loadKnownApps()
    expect(lookupKnownAppByPlatformId('com.fake.NotARealApp')).toBeNull()
  })
})

describe('knownAppCategoryToConnectorCategory', () => {
  it('maps every known-app category to a connector category', () => {
    const all = [
      'design',
      'communication',
      'productivity',
      'dev-tools',
      'browser',
      'security',
      'media',
      'data',
      'research',
      'finance',
      'ai',
      'cloud',
      'other',
    ] as const
    for (const c of all) {
      expect(knownAppCategoryToConnectorCategory(c)).toBe(c)
    }
  })
})
