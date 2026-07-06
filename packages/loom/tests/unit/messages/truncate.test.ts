import { describe, it, expect } from 'vitest'
import {
  byteSafePrefix,
  byteSafeSuffix,
  capBytes,
  headTailTruncate,
} from '../../../src/messages/truncate.js'

const utf8 = (s: string) => Buffer.byteLength(s, 'utf8')

describe('byteSafePrefix', () => {
  it('returns the input unchanged when under budget', () => {
    expect(byteSafePrefix('hello', 100)).toBe('hello')
  })

  it('returns empty for non-positive budgets', () => {
    expect(byteSafePrefix('hello', 0)).toBe('')
    expect(byteSafePrefix('hello', -5)).toBe('')
  })

  it('never exceeds maxBytes for ASCII', () => {
    const out = byteSafePrefix('hello world', 5)
    expect(utf8(out)).toBeLessThanOrEqual(5)
    expect(out).toBe('hello')
  })

  it('never exceeds maxBytes for multi-byte UTF-8 (no U+FFFD)', () => {
    // 'é' is 2 bytes. Budget 3 → 1 char (2 bytes) fits, 2 chars (4 bytes) does not.
    const out = byteSafePrefix('éééé', 3)
    expect(utf8(out)).toBeLessThanOrEqual(3)
    expect(out).toBe('é')
    expect(out.includes('�')).toBe(false)
  })

  it('does not split a UTF-16 surrogate pair', () => {
    // 😀 = U+1F600 = 2 UTF-16 code units, 4 UTF-8 bytes
    const input = 'a😀b'
    const out = byteSafePrefix(input, 4) // 'a' (1) + '😀' (4) = 5 → won't fit, just 'a'
    expect(utf8(out)).toBeLessThanOrEqual(4)
    expect(out.includes('�')).toBe(false)
    // Either ends cleanly at 'a' or includes the full emoji — never half of it.
    expect(out === 'a' || out === 'a😀').toBe(true)
  })
})

describe('byteSafeSuffix', () => {
  it('returns input unchanged when under budget', () => {
    expect(byteSafeSuffix('hello', 100)).toBe('hello')
  })

  it('returns empty for non-positive budgets', () => {
    expect(byteSafeSuffix('hello', 0)).toBe('')
  })

  it('returns the trailing slice within budget', () => {
    const out = byteSafeSuffix('hello world', 5)
    expect(utf8(out)).toBeLessThanOrEqual(5)
    expect(out).toBe('world')
  })

  it('does not split a surrogate pair on the leading edge', () => {
    const input = 'ab😀cd'
    const out = byteSafeSuffix(input, 5)
    expect(utf8(out)).toBeLessThanOrEqual(5)
    expect(out.includes('�')).toBe(false)
  })
})

describe('capBytes', () => {
  it('returns input unchanged when under budget', () => {
    expect(capBytes('hello', 100)).toBe('hello')
  })

  it('appends marker when truncating', () => {
    const out = capBytes('a'.repeat(1000), 100)
    expect(utf8(out)).toBeLessThanOrEqual(100)
    expect(out).toContain('[truncated]')
  })

  it('respects custom marker', () => {
    const out = capBytes('a'.repeat(1000), 100, '<<cut>>')
    expect(utf8(out)).toBeLessThanOrEqual(100)
    expect(out.endsWith('<<cut>>')).toBe(true)
  })

  it('byte-safe even with degenerate budget smaller than marker', () => {
    const out = capBytes('a'.repeat(1000), 5)
    expect(utf8(out)).toBeLessThanOrEqual(5)
  })
})

describe('headTailTruncate', () => {
  it('returns input unchanged when under budget', () => {
    expect(headTailTruncate('short', 1000)).toBe('short')
  })

  it('preserves both head and tail content', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const out = headTailTruncate(lines, 300)
    expect(utf8(out)).toBeLessThanOrEqual(300)
    expect(out.startsWith('line 0')).toBe(true)
    expect(out).toContain('line 99')
  })

  it('reports dropped line count in marker', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const out = headTailTruncate(lines, 300)
    expect(out).toMatch(/\d+ lines/)
    expect(out).toMatch(/truncated/)
  })

  it('snaps to line boundaries (no mid-line cuts)', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `aaaaaaaaaaaaaa-${i}`).join('\n')
    const out = headTailTruncate(lines, 400, { snapToLines: true })
    const beforeMarker = out.split('...')[0] ?? ''
    // The last char before the marker block should be a newline (clean line end)
    // OR the head may have been cut before any line — but we asserted snap, so:
    expect(beforeMarker.endsWith('\n') || beforeMarker.length === 0).toBe(true)
  })

  it('preserves error tail (the whole point)', () => {
    const setup = Array.from({ length: 200 }, (_, i) => `setup line ${i}`).join('\n')
    const errorTail = '\nFATAL: database unreachable\nexit code: 1'
    const out = headTailTruncate(setup + errorTail, 500)
    expect(out).toContain('FATAL: database unreachable')
    expect(out).toContain('exit code: 1')
  })

  it('honors headFraction', () => {
    const big = 'A'.repeat(5000) + '\n' + 'B'.repeat(5000)
    const headHeavy = headTailTruncate(big, 1000, { headFraction: 0.9 })
    const tailHeavy = headTailTruncate(big, 1000, { headFraction: 0.1 })
    const aCount = (s: string) => (s.match(/A/g) ?? []).length
    const bCount = (s: string) => (s.match(/B/g) ?? []).length
    expect(aCount(headHeavy)).toBeGreaterThan(aCount(tailHeavy))
    expect(bCount(tailHeavy)).toBeGreaterThan(bCount(headHeavy))
  })

  it('clamps absurd headFractions to safe range', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const out1 = headTailTruncate(lines, 400, { headFraction: 5 })
    const out2 = headTailTruncate(lines, 400, { headFraction: -1 })
    expect(utf8(out1)).toBeLessThanOrEqual(400)
    expect(utf8(out2)).toBeLessThanOrEqual(400)
  })

  it('falls back to capBytes for tiny budgets', () => {
    const out = headTailTruncate('a'.repeat(1000), 50)
    expect(utf8(out)).toBeLessThanOrEqual(50)
  })

  it('never exceeds maxBytes (UTF-8 multi-byte content)', () => {
    const lines = Array.from({ length: 100 }, () => 'évérÿ wéird línë').join('\n')
    const out = headTailTruncate(lines, 200)
    expect(utf8(out)).toBeLessThanOrEqual(200)
    expect(out.includes('�')).toBe(false)
  })
})
