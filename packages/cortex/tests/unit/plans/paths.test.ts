/**
 * Unit tests for plan path resolution + slug sanitization.
 *
 * These pin the user-visible filename contract. The slug is what the
 * user sees in `git status` and in their editor's file tree, so
 * surprises here are very visible.
 */

import { describe, it, expect } from 'vitest'
import {
  sanitizeFeatureSlug,
  formatDateStamp,
  resolvePlanPath,
  resolvePlansDir,
  PLANS_SUBDIR,
} from '../../../src/plans/paths.js'

describe('sanitizeFeatureSlug', () => {
  it('lowercases and dashes spaces', () => {
    expect(sanitizeFeatureSlug('Add OAuth')).toBe('add-oauth')
  })

  it('collapses runs of non-alphanumeric chars to a single dash', () => {
    expect(sanitizeFeatureSlug('Refactor auth/session')).toBe('refactor-auth-session')
    expect(sanitizeFeatureSlug('a   b   c')).toBe('a-b-c')
    expect(sanitizeFeatureSlug('a___b___c')).toBe('a-b-c')
  })

  it('preserves digits and removes special characters', () => {
    expect(sanitizeFeatureSlug('Fix bug #142')).toBe('fix-bug-142')
    expect(sanitizeFeatureSlug('upgrade React 18 → 19')).toBe('upgrade-react-18-19')
  })

  it('strips leading and trailing dashes', () => {
    expect(sanitizeFeatureSlug('  Padded   spaces  ')).toBe('padded-spaces')
    expect(sanitizeFeatureSlug('---hello---')).toBe('hello')
  })

  it('drops emoji and other unicode noise', () => {
    expect(sanitizeFeatureSlug('🚀 Launch the rocket')).toBe('launch-the-rocket')
  })

  it('throws on input that has no alphanumeric content', () => {
    expect(() => sanitizeFeatureSlug('')).toThrow()
    expect(() => sanitizeFeatureSlug('   ')).toThrow()
    expect(() => sanitizeFeatureSlug('---')).toThrow()
    expect(() => sanitizeFeatureSlug('🚀🚀🚀')).toThrow()
  })

  it('caps long slugs at a dash boundary, not mid-word', () => {
    const long = 'this is a very long feature name that goes on and on and on and on and on'
    const slug = sanitizeFeatureSlug(long)
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug.endsWith('-')).toBe(false)
    // The slug is a prefix of the dash-form of the input — confirms we
    // backed off at a dash boundary rather than chopping a word in two.
    const expectedDashed = long.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    expect(expectedDashed.startsWith(slug)).toBe(true)
  })

  it('hard-cuts when there is no dash within the back-off window', () => {
    // 70 char single token, no spaces — back-off window is half the cap;
    // no dash exists, so we hard-cut at MAX_SLUG_LENGTH.
    const giant = 'a'.repeat(70)
    const slug = sanitizeFeatureSlug(giant)
    expect(slug).toBe('a'.repeat(60))
  })
})

describe('formatDateStamp', () => {
  it('returns YYYYMMDD with zero-padded month and day', () => {
    expect(formatDateStamp(new Date(2026, 4, 9))).toBe('20260509')
    expect(formatDateStamp(new Date(2026, 0, 1))).toBe('20260101')
    expect(formatDateStamp(new Date(2026, 11, 31))).toBe('20261231')
  })
})

describe('resolvePlanPath', () => {
  it('joins workspace + plans subdir + <date>-<slug>.md', () => {
    const path = resolvePlanPath(
      '/work/repo',
      'Add OAuth',
      new Date(2026, 4, 9),
    )
    expect(path).toBe('/work/repo/.ownware/plans/20260509-add-oauth.md')
  })

  it('respects the slug sanitization rules', () => {
    const path = resolvePlanPath(
      '/work',
      'Refactor auth/session — phase 1',
      new Date(2026, 4, 10),
    )
    expect(path).toBe('/work/.ownware/plans/20260510-refactor-auth-session-phase-1.md')
  })

  it('throws on empty/non-alphanumeric feature names', () => {
    expect(() => resolvePlanPath('/work', '', new Date())).toThrow()
    expect(() => resolvePlanPath('/work', '!!!', new Date())).toThrow()
  })
})

describe('resolvePlansDir', () => {
  it('returns the plans subdirectory under workspace', () => {
    expect(resolvePlansDir('/work/repo')).toBe(`/work/repo/${PLANS_SUBDIR}`)
  })
})
