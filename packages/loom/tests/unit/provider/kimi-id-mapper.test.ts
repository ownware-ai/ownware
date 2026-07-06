/**
 * Unit tests for `kimi-id-mapper.ts`.
 *
 * The mapper is the stateless bridge between Loom-internal tool-call
 * IDs and the canonical `functions.<name>:<idx>` format Kimi requires
 * on the wire. The contract is small but load-bearing:
 *
 *   - mint  : produce a Loom-internal ID encoding (name, idx)
 *   - parse : recover (name, idx) from a previously-minted ID
 *   - canon : translate a Loom-internal ID to wire format
 *
 * All three must round-trip without state. These tests pin that
 * round-trip and the pass-through behaviour for non-Kimi-minted IDs.
 */

import { describe, expect, it } from 'vitest'
import {
  mintKimiId,
  parseKimiId,
  toCanonicalKimiId,
} from '../../../src/provider/quirks/kimi-id-mapper.js'

describe('mintKimiId', () => {
  it('produces a uniquely-prefixed id encoding name and idx', () => {
    const id = mintKimiId('writeFile', 3)
    expect(id).toMatch(/^call_kimi_writeFile_3_[a-f0-9]{24}$/)
  })

  it('strips non-alphanumeric characters from the name', () => {
    const id = mintKimiId('read_file', 0)
    expect(id).toMatch(/^call_kimi_readfile_0_[a-f0-9]{24}$/)
  })

  it('strips dashes and dots from the name', () => {
    const id = mintKimiId('get-weather.v2', 7)
    expect(id).toMatch(/^call_kimi_getweatherv2_7_[a-f0-9]{24}$/)
  })

  it('produces a different id for the same inputs (entropy on every mint)', () => {
    const a = mintKimiId('writeFile', 0)
    const b = mintKimiId('writeFile', 0)
    expect(a).not.toBe(b)
  })

  it('throws on negative idx', () => {
    expect(() => mintKimiId('writeFile', -1)).toThrow(/non-negative integer/)
  })

  it('throws on non-integer idx', () => {
    expect(() => mintKimiId('writeFile', 1.5)).toThrow(/non-negative integer/)
  })

  it('throws when name sanitizes to empty', () => {
    expect(() => mintKimiId('___', 0)).toThrow(/sanitizes to empty/)
  })
})

describe('parseKimiId', () => {
  it('round-trips a minted id back to (name, idx)', () => {
    const id = mintKimiId('writeFile', 42)
    expect(parseKimiId(id)).toEqual({ name: 'writeFile', idx: 42 })
  })

  it('round-trips with idx=0', () => {
    const id = mintKimiId('readFile', 0)
    expect(parseKimiId(id)).toEqual({ name: 'readFile', idx: 0 })
  })

  it('returns null for legacy ids (call_<hex32> from before this fix)', () => {
    expect(parseKimiId('call_abcdef0123456789abcdef0123456789')).toBeNull()
  })

  it('returns null for non-string inputs (defensive)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseKimiId(null as any)).toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseKimiId(undefined as any)).toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseKimiId(123 as any)).toBeNull()
  })

  it('returns null when the suffix is the wrong length', () => {
    expect(parseKimiId('call_kimi_writeFile_0_short')).toBeNull()
    expect(parseKimiId('call_kimi_writeFile_0_' + 'a'.repeat(32))).toBeNull()
  })

  it('returns null when idx contains non-digits', () => {
    expect(parseKimiId('call_kimi_writeFile_abc_' + '0'.repeat(24))).toBeNull()
  })

  it('returns null for the empty string', () => {
    expect(parseKimiId('')).toBeNull()
  })
})

describe('toCanonicalKimiId', () => {
  it('translates a minted id to canonical Kimi format', () => {
    const id = mintKimiId('writeFile', 0)
    expect(toCanonicalKimiId(id)).toBe('functions.writeFile:0')
  })

  it('preserves the idx counter', () => {
    const id = mintKimiId('readFile', 17)
    expect(toCanonicalKimiId(id)).toBe('functions.readFile:17')
  })

  it('is idempotent — translating an already-canonical id returns it unchanged', () => {
    // Already-canonical IDs don't match the Kimi-mint pattern, so they
    // pass through (the canonicalizer is a no-op on the wire form).
    expect(toCanonicalKimiId('functions.writeFile:0')).toBe('functions.writeFile:0')
  })

  it('passes legacy ids through unchanged', () => {
    const legacy = 'call_abcdef0123456789abcdef0123456789'
    expect(toCanonicalKimiId(legacy)).toBe(legacy)
  })

  it('passes Anthropic-style ids through unchanged (cross-provider safety)', () => {
    const anthropic = 'toolu_01ABCdefGhij'
    expect(toCanonicalKimiId(anthropic)).toBe(anthropic)
  })

  it('passes OpenAI-style ids through unchanged (cross-provider safety)', () => {
    const openai = 'call_FjA7B3xY1QqW2rT'
    expect(toCanonicalKimiId(openai)).toBe(openai)
  })

  it('round-trips through mint → canon for many name/idx combinations', () => {
    const cases: Array<[string, number]> = [
      ['writeFile', 0],
      ['readFile', 1],
      ['glob', 99],
      ['get_weather', 0],   // name gets sanitized at mint
      ['SearchEverywhere', 50],
    ]
    for (const [name, idx] of cases) {
      const minted = mintKimiId(name, idx)
      const canon = toCanonicalKimiId(minted)
      const sanitized = name.replace(/[^A-Za-z0-9]/g, '')
      expect(canon).toBe(`functions.${sanitized}:${idx}`)
    }
  })
})
