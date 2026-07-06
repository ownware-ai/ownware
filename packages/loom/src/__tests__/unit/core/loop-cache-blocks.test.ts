/**
 * Unit tests for the loop's wire-level cache-block plumbing.
 *
 * These functions translate a `SystemPrompt` (string or block array) into
 * the provider's `system` field shape, deciding which blocks carry a
 * `cache_control: { type: 'ephemeral' }` marker and which go out plain.
 * They also enforce the per-request marker budget so a profile with many
 * stable slots cannot starve the single marker the loop reserves for the
 * last message.
 *
 * Rules pinned here:
 *   - Empty prompt emits an empty string (field becomes a no-op on the wire).
 *   - Single string emits one marked block (preserves pre-split behaviour).
 *   - Block-form prompts emit one text block each, with cache_control only
 *     on `cacheControl: true` entries.
 *   - Exceeding `markerBudget` degrades the TRAILING blocks to plain text,
 *     never the leading ones — the prefix is the most valuable cache entry.
 *   - `countSystemBlockMarkers` reflects only what actually made it onto
 *     the wire, so the message-marker pass sees an accurate reserved count.
 */

import { describe, it, expect } from 'vitest'
import {
  applyMessageCacheMarkers,
  buildSystemRequestBlocks,
  countSystemBlockMarkers,
  CACHE_CONTROL_BLOCK_LIMIT,
} from '../../../core/loop.js'
import type { Message } from '../../../messages/types.js'

describe('buildSystemRequestBlocks', () => {
  it('empty string → empty string', () => {
    expect(buildSystemRequestBlocks('', 3)).toBe('')
  })

  it('empty array → empty string', () => {
    expect(buildSystemRequestBlocks([], 3)).toBe('')
  })

  it('single string → one marked block', () => {
    const out = buildSystemRequestBlocks('hello', 3)
    expect(Array.isArray(out)).toBe(true)
    expect(out).toEqual([
      { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
    ])
  })

  it('array with one stable and one volatile → marks only the stable one', () => {
    const out = buildSystemRequestBlocks(
      [
        { text: 'STABLE', cacheControl: true },
        { text: 'VOLATILE', cacheControl: false },
      ],
      3,
    )
    expect(out).toEqual([
      { type: 'text', text: 'STABLE', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'VOLATILE' },
    ])
  })

  it('implicit cacheControl (undefined) is treated as volatile', () => {
    const out = buildSystemRequestBlocks([{ text: 'plain' }], 3)
    expect(out).toEqual([{ type: 'text', text: 'plain' }])
  })

  it('respects markerBudget=0 — no blocks get cache_control even if requested', () => {
    const out = buildSystemRequestBlocks(
      [
        { text: 'a', cacheControl: true },
        { text: 'b', cacheControl: true },
      ],
      0,
    )
    expect(out).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])
  })

  it('downgrades trailing markers when the budget is exceeded, keeping leading markers', () => {
    // Three cacheable blocks, budget of 2 — the first two must keep their
    // markers because they are the longest-prefix cache entries. The third
    // becomes plain text.
    const out = buildSystemRequestBlocks(
      [
        { text: 'one', cacheControl: true },
        { text: 'two', cacheControl: true },
        { text: 'three', cacheControl: true },
      ],
      2,
    )
    expect(out).toEqual([
      { type: 'text', text: 'one', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'two', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'three' },
    ])
  })

  it('empty-text blocks in the array are dropped', () => {
    const out = buildSystemRequestBlocks(
      [
        { text: '', cacheControl: true },
        { text: 'kept', cacheControl: true },
      ],
      2,
    )
    expect(out).toEqual([
      { type: 'text', text: 'kept', cache_control: { type: 'ephemeral' } },
    ])
  })

  it('throws on negative markerBudget — a programmer bug, not a runtime condition', () => {
    expect(() => buildSystemRequestBlocks('hi', -1)).toThrow(/markerBudget/)
  })

  // -------------------------------------------------------------------
  // Cache-profile TTL propagation
  // -------------------------------------------------------------------
  //
  // When a session configures `{ ttl: '1h' }`, every marker emitted by
  // `buildSystemRequestBlocks` must carry that TTL. Without it, the
  // provider would store the entry under the 5-minute tier and the
  // feature would silently degrade to today's behaviour.

  it('default cache profile → markers carry no ttl (5m tier implied)', () => {
    const out = buildSystemRequestBlocks(
      [{ text: 'S', cacheControl: true }],
      3,
    )
    if (typeof out === 'string') throw new Error('expected array form')
    expect(out[0]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('{ ttl: "1h" } cache profile → every marker carries ttl="1h"', () => {
    const out = buildSystemRequestBlocks(
      [
        { text: 'S1', cacheControl: true },
        { text: 'V', cacheControl: false },
        { text: 'S2', cacheControl: true },
      ],
      3,
      { ttl: '1h' },
    )
    if (typeof out === 'string') throw new Error('expected array form')
    // Every cache-marked block gets the same TTL — the profile applies
    // uniformly across the request, not per-block.
    expect(out[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(out[1]!.cache_control).toBeUndefined()
    expect(out[2]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('{ ttl: "5m" } cache profile is indistinguishable from default', () => {
    const out = buildSystemRequestBlocks(
      [{ text: 'S', cacheControl: true }],
      3,
      { ttl: '5m' },
    )
    if (typeof out === 'string') throw new Error('expected array form')
    // Explicit 5m is collapsed to the bare marker — same wire shape as
    // passing no profile at all. Tests that care about the 5m default
    // can therefore run either path without branching.
    expect(out[0]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('null cache profile behaves like the default', () => {
    const out = buildSystemRequestBlocks(
      [{ text: 'S', cacheControl: true }],
      3,
      null,
    )
    if (typeof out === 'string') throw new Error('expected array form')
    expect(out[0]!.cache_control).toEqual({ type: 'ephemeral' })
  })
})

describe('applyMessageCacheMarkers cache-profile propagation', () => {
  const sampleMessages: Message[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'again' },
  ]

  it('default profile → message marker has no ttl', () => {
    const out = applyMessageCacheMarkers(sampleMessages, 1)
    const last = out[out.length - 1]!
    // String content gets converted to a single text block with the
    // marker attached; non-string content keeps its shape and picks up
    // the marker on its last block. Either way we can locate the marker.
    const blocks = Array.isArray(last.content) ? last.content : []
    const lastBlock = blocks[blocks.length - 1]
    expect(lastBlock && 'cache_control' in lastBlock ? lastBlock.cache_control : null)
      .toEqual({ type: 'ephemeral' })
  })

  it('{ ttl: "1h" } → message marker carries ttl="1h"', () => {
    const out = applyMessageCacheMarkers(sampleMessages, 1, { ttl: '1h' })
    const last = out[out.length - 1]!
    const blocks = Array.isArray(last.content) ? last.content : []
    const lastBlock = blocks[blocks.length - 1]
    expect(lastBlock && 'cache_control' in lastBlock ? lastBlock.cache_control : null)
      .toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('empty message list returns input untouched regardless of profile', () => {
    expect(applyMessageCacheMarkers([], 1, { ttl: '1h' })).toEqual([])
  })

  it('reservedMarkers >= cap skips marking even with 1h profile', () => {
    // When the system side already used the full 4-marker budget the
    // message side gets nothing. The TTL selection is moot at that point.
    const out = applyMessageCacheMarkers(
      sampleMessages,
      CACHE_CONTROL_BLOCK_LIMIT,
      { ttl: '1h' },
    )
    // Messages come back ref-equal in the skip path — cheaper than
    // a structural deep-equal.
    expect(out).toBe(sampleMessages)
  })
})

describe('countSystemBlockMarkers', () => {
  it('string system → 0', () => {
    expect(countSystemBlockMarkers('')).toBe(0)
    expect(countSystemBlockMarkers('some text')).toBe(0)
  })

  it('array system counts only blocks that carry cache_control', () => {
    expect(
      countSystemBlockMarkers([
        { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'b' },
        { type: 'text', text: 'c', cache_control: { type: 'ephemeral' } },
      ]),
    ).toBe(2)
  })

  it('matches what buildSystemRequestBlocks produced', () => {
    const out = buildSystemRequestBlocks(
      [
        { text: 's1', cacheControl: true },
        { text: 'v', cacheControl: false },
        { text: 's2', cacheControl: true },
      ],
      // Budget large enough that both stable blocks keep their markers.
      CACHE_CONTROL_BLOCK_LIMIT,
    )
    expect(countSystemBlockMarkers(out)).toBe(2)
  })

  it('after degrading trailing markers, the count matches the kept ones', () => {
    const out = buildSystemRequestBlocks(
      [
        { text: 's1', cacheControl: true },
        { text: 's2', cacheControl: true },
        { text: 's3', cacheControl: true },
      ],
      1,
    )
    expect(countSystemBlockMarkers(out)).toBe(1)
  })
})
