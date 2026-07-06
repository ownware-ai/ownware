/**
 * Unit tests for the SystemPrompt helpers.
 *
 * These cover the three public helpers — `normalizeSystemPrompt`,
 * `systemPromptToText`, `countCacheMarkers` — and the constant
 * `CACHE_CONTROL_MARKER_LIMIT`. Both the legacy-string and the new block
 * shape go through each helper, with edge cases (empty string, empty
 * array, empty-text blocks) pinned explicitly so a future refactor
 * cannot silently drop the defensive handling.
 */

import { describe, it, expect } from 'vitest'
import {
  normalizeSystemPrompt,
  systemPromptToText,
  countCacheMarkers,
  CACHE_CONTROL_MARKER_LIMIT,
} from '../../../core/system-prompt.js'

describe('CACHE_CONTROL_MARKER_LIMIT', () => {
  it('is 4 — matches the provider cap', () => {
    // The provider enforces a 4-marker hard limit across system, tools, and
    // messages. If this constant ever changes, every call site that budgets
    // markers needs review.
    expect(CACHE_CONTROL_MARKER_LIMIT).toBe(4)
  })
})

describe('normalizeSystemPrompt', () => {
  it('empty string → empty array (no blocks on the wire)', () => {
    expect(normalizeSystemPrompt('')).toEqual([])
  })

  it('non-empty string → single cache-marked block', () => {
    const blocks = normalizeSystemPrompt('hello world')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.text).toBe('hello world')
    expect(blocks[0]!.cacheControl).toBe(true)
  })

  it('array passes through with explicit cacheControl flags', () => {
    const input = [
      { text: 'stable', cacheControl: true },
      { text: 'volatile', cacheControl: false },
    ]
    const blocks = normalizeSystemPrompt(input)
    expect(blocks).toEqual([
      { text: 'stable', cacheControl: true },
      { text: 'volatile', cacheControl: false },
    ])
  })

  it('array with implicit cacheControl normalizes to false', () => {
    const blocks = normalizeSystemPrompt([{ text: 'plain' }])
    expect(blocks).toEqual([{ text: 'plain', cacheControl: false }])
  })

  it('filters out empty-text blocks', () => {
    const blocks = normalizeSystemPrompt([
      { text: '' },
      { text: 'kept', cacheControl: true },
      { text: '', cacheControl: true },
    ])
    expect(blocks).toEqual([{ text: 'kept', cacheControl: true }])
  })

  it('empty array → empty array', () => {
    expect(normalizeSystemPrompt([])).toEqual([])
  })
})

describe('systemPromptToText', () => {
  it('string passes through unchanged', () => {
    expect(systemPromptToText('hello')).toBe('hello')
  })

  it('empty string stays empty', () => {
    expect(systemPromptToText('')).toBe('')
  })

  it('array is concatenated block-by-block with no extra separator', () => {
    // No separator is intentional: the block array already encodes the
    // intended text layout, and the assembler is responsible for putting
    // the separators inside block.text if it wants them. Adding a
    // separator here would drift from the concatenated-equals-build-text
    // invariant the PromptBuilder's buildBlocks relies on.
    const text = systemPromptToText([
      { text: 'aaa' },
      { text: 'bbb', cacheControl: true },
    ])
    expect(text).toBe('aaabbb')
  })

  it('empty array → empty string', () => {
    expect(systemPromptToText([])).toBe('')
  })
})

describe('countCacheMarkers', () => {
  it('empty string → 0', () => {
    expect(countCacheMarkers('')).toBe(0)
  })

  it('non-empty string → 1 (treated as a single marked block)', () => {
    expect(countCacheMarkers('anything')).toBe(1)
  })

  it('array counts only cacheControl=true non-empty blocks', () => {
    const sp = [
      { text: 'a', cacheControl: true },
      { text: 'b', cacheControl: false },
      { text: '', cacheControl: true }, // empty → ignored
      { text: 'c', cacheControl: true },
    ]
    expect(countCacheMarkers(sp)).toBe(2)
  })

  it('array with no cacheControl flags → 0', () => {
    expect(countCacheMarkers([{ text: 'a' }, { text: 'b' }])).toBe(0)
  })

  it('empty array → 0', () => {
    expect(countCacheMarkers([])).toBe(0)
  })
})
