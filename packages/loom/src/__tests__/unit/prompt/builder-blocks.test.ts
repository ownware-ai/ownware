/**
 * Unit tests for `PromptBuilder.buildBlocks`.
 *
 * `buildBlocks` is the bridge between the fragment-level `cacheControl`
 * metadata the builder already tracks and the wire-level block array the
 * loop consumes. Invariants:
 *
 *   1. Empty builder → empty array.
 *   2. Consecutive fragments with the same cacheability collapse into one
 *      block (one marker instead of one per fragment).
 *   3. A change in cacheability opens a new block, so a volatile slot
 *      sitting between two stable runs produces three blocks.
 *   4. Concatenating the blocks' text produces EXACTLY the same string as
 *      `buildText()` — no trailing separator drift, no lost content. This
 *      is the contract that lets consumers treat the two methods as two
 *      views of the same assembly.
 */

import { describe, it, expect } from 'vitest'
import { PromptBuilder } from '../../../prompt/builder.js'

describe('PromptBuilder.buildBlocks', () => {
  it('empty builder returns an empty array', () => {
    const builder = new PromptBuilder()
    expect(builder.buildBlocks()).toEqual([])
  })

  it('one stable-slot fragment produces one cache-marked block', () => {
    // `behavior` is classified as stable by default in prompt/cache.ts.
    const blocks = new PromptBuilder()
      .add('behavior', 'be concise')
      .buildBlocks()
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.text).toBe('be concise')
    expect(blocks[0]!.cacheControl).toBe(true)
  })

  it('one volatile-slot fragment produces one unmarked block', () => {
    // `context` is classified as volatile by default.
    const blocks = new PromptBuilder()
      .add('context', 'today is monday')
      .buildBlocks()
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.cacheControl).toBe(false)
    expect(blocks[0]!.text).toBe('today is monday')
  })

  it('coalesces consecutive stable slots into a single block', () => {
    // tools (stable) and behavior (stable) are adjacent in SLOT_ORDER.
    const blocks = new PromptBuilder()
      .add('tools', 'USE_TOOLS')
      .add('behavior', 'RULES')
      .buildBlocks()
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.cacheControl).toBe(true)
    expect(blocks[0]!.text).toBe('USE_TOOLS\n\nRULES')
  })

  it('splits on a cacheability change', () => {
    // `identity` is stable, `context` is volatile — expect two blocks in
    // that order (identity is ordered before context in SLOT_ORDER).
    const blocks = new PromptBuilder()
      .add('identity', 'ID')
      .add('context', 'CTX')
      .buildBlocks()
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ text: 'ID', cacheControl: true })
    expect(blocks[1]).toEqual({ text: 'CTX', cacheControl: false })
  })

  it('explicit per-fragment cacheControl overrides slot default', () => {
    // `identity` is stable by default; forcing cacheControl=false makes
    // the block volatile even though it lives in a stable slot.
    const blocks = new PromptBuilder()
      .add('identity', 'overridden', { cacheControl: false })
      .buildBlocks()
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.cacheControl).toBe(false)
  })

  it('a mixed-override slot collapses to the conservative (unmarked) choice', () => {
    // If a single slot holds both a stable and a forced-volatile
    // fragment, we cannot safely mark it cacheable — the volatile
    // fragment would silently become part of the cached block and bust
    // the cache on its first change. Take the conservative path: emit
    // the block unmarked.
    const blocks = new PromptBuilder()
      .add('identity', 'core', { cacheControl: true })
      .add('identity', 'volatile-thing', { cacheControl: false })
      .buildBlocks()
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.cacheControl).toBe(false)
  })

  it('concatenated block text equals buildText() output (byte-identical)', () => {
    // Strongest invariant: two methods, two views of the same assembly.
    const builder = new PromptBuilder()
      .add('behavior', 'rule one')
      .add('behavior', 'rule two')
      .add('identity', 'who I am')
      .add('memory', 'remember X')
      .add('context', 'today')
      .add('skills', '/do')
      .add('custom', 'extra')
    const fromBlocks = builder.buildBlocks().map(b => b.text).join('\n\n')
    expect(fromBlocks).toBe(builder.buildText())
  })

  it('respects the order: stable blocks first, volatile after', () => {
    // This is what makes multi-marker caching actually work: a volatile
    // block sitting BEFORE a stable one would prevent the stable block's
    // marker from ever being read (prefix match stops at the volatile
    // block). The slot ordering in prompt/types.ts is structured to
    // avoid that; this test is a safety net that flags any SLOT_ORDER
    // change that reintroduces the problem.
    const blocks = new PromptBuilder()
      .add('tools', 'T')
      .add('behavior', 'B')
      .add('identity', 'I')
      .add('context', 'C')
      .add('memory', 'M')
      .buildBlocks()

    let sawVolatile = false
    for (const b of blocks) {
      if (b.cacheControl !== true) {
        sawVolatile = true
      } else if (sawVolatile) {
        throw new Error(
          'A cache-marked block appears AFTER a volatile block — the ' +
          'marker will never hit on subsequent requests.',
        )
      }
    }
  })
})
