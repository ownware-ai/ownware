import { describe, expect, it } from 'vitest'
import {
  FEATURED_COMPOSIO_TOOLKITS,
  getFeaturedComposioToolkits,
  getFeaturedComposioToolkit,
  featuredComposioSlugSet,
} from '../../../../src/connector/composio/featured.js'

/**
 * Composio is dropped from the Tier 1 catalog as of 2026-05-06
 * (Phase 0 — Decision 2). The list is intentionally empty in v1 so the
 * default lobby never asks a non-tech user for a Composio API key.
 *
 * The TYPES and HELPERS are preserved on purpose: the Advanced →
 * BYO-Composio surface (post-launch) will repopulate the list and reuse
 * this same module shape.
 *
 * If a future phase repopulates `FEATURED_COMPOSIO_TOOLKITS`, expand
 * these tests to assert the new contents.
 */

describe('FEATURED_COMPOSIO_TOOLKITS', () => {
  it('is empty for v1 (Composio dropped from default catalog)', () => {
    expect(FEATURED_COMPOSIO_TOOLKITS.length).toBe(0)
  })

  it('every entry (when present) is tagged source="composio" and verified=false', () => {
    // Vacuously true on an empty list, but encoded so the contract
    // survives intact when the Advanced surface refills the list.
    for (const t of FEATURED_COMPOSIO_TOOLKITS) {
      expect(t.source).toBe('composio')
      expect(t.verified).toBe(false)
    }
  })

  it('slugs are unique (vacuously true on empty list)', () => {
    const slugs = FEATURED_COMPOSIO_TOOLKITS.map(t => t.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('getFeaturedComposioToolkit returns undefined for any slug while list is empty', () => {
    expect(getFeaturedComposioToolkit('notion')).toBeUndefined()
    expect(getFeaturedComposioToolkit('no-such-slug')).toBeUndefined()
  })

  it('getFeaturedComposioToolkits returns empty list with or without category filter', () => {
    expect(getFeaturedComposioToolkits()).toEqual([])
    expect(getFeaturedComposioToolkits('communication')).toEqual([])
    expect(getFeaturedComposioToolkits('productivity')).toEqual([])
  })

  it('featuredComposioSlugSet is empty and matches the list', () => {
    const set = featuredComposioSlugSet()
    expect(set.size).toBe(0)
    expect(set.size).toBe(FEATURED_COMPOSIO_TOOLKITS.length)
  })
})
