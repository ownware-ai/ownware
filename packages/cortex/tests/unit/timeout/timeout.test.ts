/**
 * Unit tests for timeout parser.
 */

import { describe, it, expect } from 'vitest'
import { parseTimeout } from '../../../src/profile/timeout.js'

describe('parseTimeout', () => {
  // ── Seconds ────────────────────────────────────────────────────────────
  describe('seconds', () => {
    it('parses "1s"', () => expect(parseTimeout('1s')).toBe(1_000))
    it('parses "5s"', () => expect(parseTimeout('5s')).toBe(5_000))
    it('parses "60s"', () => expect(parseTimeout('60s')).toBe(60_000))
    it('parses "0.5s"', () => expect(parseTimeout('0.5s')).toBe(500))
    it('is case insensitive "5S"', () => expect(parseTimeout('5S')).toBe(5_000))
  })

  // ── Minutes ────────────────────────────────────────────────────────────
  describe('minutes', () => {
    it('parses "1m"', () => expect(parseTimeout('1m')).toBe(60_000))
    it('parses "5m"', () => expect(parseTimeout('5m')).toBe(300_000))
    it('parses "30m"', () => expect(parseTimeout('30m')).toBe(1_800_000))
    it('parses "1.5m"', () => expect(parseTimeout('1.5m')).toBe(90_000))
  })

  // ── Hours ──────────────────────────────────────────────────────────────
  describe('hours', () => {
    it('parses "1h"', () => expect(parseTimeout('1h')).toBe(3_600_000))
    it('parses "2h"', () => expect(parseTimeout('2h')).toBe(7_200_000))
    it('parses "0.5h"', () => expect(parseTimeout('0.5h')).toBe(1_800_000))
    it('parses "24h"', () => expect(parseTimeout('24h')).toBe(86_400_000))
  })

  // ── Days ───────────────────────────────────────────────────────────────
  describe('days', () => {
    it('parses "1d"', () => expect(parseTimeout('1d')).toBe(86_400_000))
    it('parses "7d"', () => expect(parseTimeout('7d')).toBe(604_800_000))
    it('parses "0.5d"', () => expect(parseTimeout('0.5d')).toBe(43_200_000))
  })

  // ── Raw milliseconds ──────────────────────────────────────────────────
  describe('raw milliseconds', () => {
    it('parses "500"', () => expect(parseTimeout('500')).toBe(500))
    it('parses "1000"', () => expect(parseTimeout('1000')).toBe(1_000))
    it('parses "120000"', () => expect(parseTimeout('120000')).toBe(120_000))
  })

  // ── Whitespace ─────────────────────────────────────────────────────────
  describe('whitespace handling', () => {
    it('trims leading whitespace', () => expect(parseTimeout('  5s')).toBe(5_000))
    it('trims trailing whitespace', () => expect(parseTimeout('5s  ')).toBe(5_000))
    it('trims both sides', () => expect(parseTimeout('  5s  ')).toBe(5_000))
  })

  // ── Error cases ────────────────────────────────────────────────────────
  describe('error cases', () => {
    it('throws on empty string', () => {
      expect(() => parseTimeout('')).toThrow('Invalid timeout')
    })

    it('throws on only whitespace', () => {
      expect(() => parseTimeout('   ')).toThrow('Invalid timeout')
    })

    it('throws on no unit no number', () => {
      expect(() => parseTimeout('abc')).toThrow('Invalid timeout')
    })

    it('throws on unknown unit', () => {
      expect(() => parseTimeout('5w')).toThrow('Invalid timeout')
    })

    it('throws on negative with unit', () => {
      expect(() => parseTimeout('-5s')).toThrow('Invalid timeout')
    })

    it('throws on unit without number', () => {
      expect(() => parseTimeout('m')).toThrow('Invalid timeout')
    })

    it('throws on mixed units', () => {
      expect(() => parseTimeout('5m30s')).toThrow('Invalid timeout')
    })

    it('error message includes the input', () => {
      expect(() => parseTimeout('bad')).toThrow('bad')
    })

    it('error message suggests valid formats', () => {
      try {
        parseTimeout('bad')
      } catch (e) {
        expect((e as Error).message).toMatch(/s.*m.*h.*d/i)
      }
    })
  })
})
