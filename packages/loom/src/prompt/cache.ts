/**
 * Prompt Cache Strategy
 *
 * Determines which prompt fragments should receive Anthropic cache_control
 * markers. The strategy is:
 *
 * - Cache stable fragments: identity, behavior, tools, skills
 *   (these rarely change between turns)
 * - Don't cache volatile fragments: context, memory, custom
 *   (these change frequently — date, git status, session corrections)
 *
 * The returned breakpoints are character positions in the assembled text
 * where the provider serializer should insert cache_control markers.
 */

import type { PromptFragment, PromptSlot } from './types.js'

// ---------------------------------------------------------------------------
// Stable vs volatile classification
// ---------------------------------------------------------------------------

/** Slots whose content is stable across turns and benefits from caching */
const STABLE_SLOTS: ReadonlySet<PromptSlot> = new Set([
  'identity',
  'behavior',
  'tools',
  'skills',
])

/** Slots whose content changes frequently and should not be cached */
const VOLATILE_SLOTS: ReadonlySet<PromptSlot> = new Set([
  'context',
  'memory',
  'custom',
])

/**
 * Determine whether a fragment should be cached.
 *
 * A fragment is cacheable if:
 * 1. It explicitly sets cacheControl: true, OR
 * 2. It belongs to a stable slot and doesn't explicitly set cacheControl: false
 */
export function isCacheable(fragment: PromptFragment): boolean {
  // Explicit override takes precedence
  if (fragment.cacheControl !== undefined) {
    return fragment.cacheControl
  }
  // Default based on slot classification
  return STABLE_SLOTS.has(fragment.slot)
}

// ---------------------------------------------------------------------------
// Breakpoint computation
// ---------------------------------------------------------------------------

/**
 * Compute character positions where cache breakpoints should be placed.
 *
 * Breakpoints are placed at the end of each contiguous run of cacheable
 * fragments. This maximizes cache hit rates — the entire stable prefix
 * gets cached as one block.
 *
 * @param fragments - Ordered fragments (as returned by PromptBuilder.getOrderedFragments)
 * @returns Array of character offsets into the assembled text
 */
export function computeCacheBreakpoints(fragments: PromptFragment[]): number[] {
  if (fragments.length === 0) return []

  const breakpoints: number[] = []
  let charOffset = 0
  let prevSlot: string | null = null
  let inCacheableRun = false

  for (let i = 0; i < fragments.length; i++) {
    const frag = fragments[i]!
    const cacheable = isCacheable(frag)

    // Account for separator between fragments
    const separator = prevSlot !== null
      ? (frag.slot !== prevSlot ? '\n\n' : '\n\n')
      : ''
    charOffset += separator.length

    // If we were in a cacheable run and this fragment is not cacheable,
    // place a breakpoint at the boundary (end of previous fragment)
    if (inCacheableRun && !cacheable) {
      breakpoints.push(charOffset - separator.length)
    }

    charOffset += frag.content.length
    inCacheableRun = cacheable
    prevSlot = frag.slot
  }

  // If the last fragment was cacheable, place a breakpoint at the end
  if (inCacheableRun) {
    breakpoints.push(charOffset)
  }

  return breakpoints
}

/**
 * Check if a slot is classified as stable (benefits from caching).
 */
export function isStableSlot(slot: PromptSlot): boolean {
  return STABLE_SLOTS.has(slot)
}

/**
 * Check if a slot is classified as volatile (should not be cached).
 */
export function isVolatileSlot(slot: PromptSlot): boolean {
  return VOLATILE_SLOTS.has(slot)
}
