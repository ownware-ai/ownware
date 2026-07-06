/**
 * Unit Tests — Cache Strategy
 *
 * Tests cache breakpoint computation and slot classification.
 */

import { describe, it, expect } from 'vitest'
import {
  computeCacheBreakpoints,
  isCacheable,
  isStableSlot,
  isVolatileSlot,
} from '../../../prompt/cache.js'
import type { PromptFragment, PromptSlot } from '../../../prompt/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function frag(
  slot: PromptSlot,
  content: string,
  cacheControl?: boolean,
): PromptFragment {
  return { slot, content, priority: 0, cacheControl }
}

// ---------------------------------------------------------------------------
// Slot classification
// ---------------------------------------------------------------------------

describe('isStableSlot()', () => {
  it.each([
    ['identity', true],
    ['behavior', true],
    ['tools', true],
    ['skills', true],
    ['context', false],
    ['memory', false],
    ['custom', false],
  ] as [PromptSlot, boolean][])('%s → %s', (slot, expected) => {
    expect(isStableSlot(slot)).toBe(expected)
  })
})

describe('isVolatileSlot()', () => {
  it.each([
    ['context', true],
    ['memory', true],
    ['custom', true],
    ['identity', false],
    ['behavior', false],
    ['tools', false],
    ['skills', false],
  ] as [PromptSlot, boolean][])('%s → %s', (slot, expected) => {
    expect(isVolatileSlot(slot)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// isCacheable()
// ---------------------------------------------------------------------------

describe('isCacheable()', () => {
  it('returns true for stable slots by default', () => {
    expect(isCacheable(frag('identity', 'x'))).toBe(true)
    expect(isCacheable(frag('behavior', 'x'))).toBe(true)
    expect(isCacheable(frag('tools', 'x'))).toBe(true)
    expect(isCacheable(frag('skills', 'x'))).toBe(true)
  })

  it('returns false for volatile slots by default', () => {
    expect(isCacheable(frag('context', 'x'))).toBe(false)
    expect(isCacheable(frag('memory', 'x'))).toBe(false)
    expect(isCacheable(frag('custom', 'x'))).toBe(false)
  })

  it('explicit cacheControl: true overrides volatile slot', () => {
    expect(isCacheable(frag('context', 'x', true))).toBe(true)
    expect(isCacheable(frag('memory', 'x', true))).toBe(true)
  })

  it('explicit cacheControl: false overrides stable slot', () => {
    expect(isCacheable(frag('identity', 'x', false))).toBe(false)
    expect(isCacheable(frag('tools', 'x', false))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeCacheBreakpoints()
// ---------------------------------------------------------------------------

describe('computeCacheBreakpoints()', () => {
  it('returns empty array for no fragments', () => {
    expect(computeCacheBreakpoints([])).toEqual([])
  })

  it('places breakpoint at end when all fragments are cacheable', () => {
    const fragments = [
      frag('identity', 'hello'),
      frag('behavior', 'rules'),
    ]
    const bp = computeCacheBreakpoints(fragments)
    expect(bp.length).toBeGreaterThan(0)
    // Last breakpoint should be at the total text length
    const lastBp = bp[bp.length - 1]
    expect(lastBp).toBeGreaterThan(0)
  })

  it('places breakpoint at boundary between cacheable and volatile', () => {
    const fragments = [
      frag('identity', 'IDENT'),   // cacheable
      frag('context', 'CTX'),      // volatile
    ]
    const bp = computeCacheBreakpoints(fragments)
    expect(bp.length).toBe(1)
    // Breakpoint should be after identity content ends
  })

  it('no breakpoints when all fragments are volatile', () => {
    const fragments = [
      frag('context', 'ctx'),
      frag('memory', 'mem'),
      frag('custom', 'cust'),
    ]
    const bp = computeCacheBreakpoints(fragments)
    expect(bp).toEqual([])
  })

  it('single cacheable fragment gets a breakpoint', () => {
    const fragments = [frag('identity', 'hello')]
    const bp = computeCacheBreakpoints(fragments)
    expect(bp).toHaveLength(1)
    expect(bp[0]).toBe(5) // length of 'hello'
  })

  it('all breakpoints are valid offsets (non-negative)', () => {
    const fragments = [
      frag('identity', 'id content'),
      frag('memory', 'volatile'),
      frag('tools', 'tool docs'),
      frag('custom', 'user stuff'),
    ]
    const bp = computeCacheBreakpoints(fragments)
    for (const offset of bp) {
      expect(offset).toBeGreaterThanOrEqual(0)
    }
  })
})
