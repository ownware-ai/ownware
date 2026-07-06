/**
 * Unit Tests — CorrectionMemory
 *
 * Tests session-scoped correction tracking: recording, eviction,
 * formatting, and state management.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { CorrectionMemory } from '../../../memory/correction.js'

describe('CorrectionMemory', () => {
  let memory: CorrectionMemory

  beforeEach(() => {
    memory = new CorrectionMemory()
  })

  // -----------------------------------------------------------------------
  // Initial state
  // -----------------------------------------------------------------------

  describe('initial state', () => {
    it('starts with zero corrections', () => {
      expect(memory.count).toBe(0)
    })

    it('hasCorrections is false', () => {
      expect(memory.hasCorrections).toBe(false)
    })

    it('getCorrections returns empty string', () => {
      expect(memory.getCorrections()).toBe('')
    })

    it('getEntries returns empty array', () => {
      expect(memory.getEntries()).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // record()
  // -----------------------------------------------------------------------

  describe('record()', () => {
    it('increments count', () => {
      memory.record('used wrong file', 'use correct file')
      expect(memory.count).toBe(1)
    })

    it('sets hasCorrections to true', () => {
      memory.record('mistake', 'fix')
      expect(memory.hasCorrections).toBe(true)
    })

    it('stores mistake and correction text', () => {
      memory.record('bad approach', 'good approach')
      const entries = memory.getEntries()
      expect(entries[0].mistake).toBe('bad approach')
      expect(entries[0].correction).toBe('good approach')
    })

    it('trims whitespace from mistake and correction', () => {
      memory.record('  mistake  ', '  fix  ')
      const entries = memory.getEntries()
      expect(entries[0].mistake).toBe('mistake')
      expect(entries[0].correction).toBe('fix')
    })

    it('stores ISO timestamp', () => {
      memory.record('m', 'f')
      const entries = memory.getEntries()
      expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('stores optional turnIndex', () => {
      memory.record('m', 'f', 5)
      const entries = memory.getEntries()
      expect(entries[0].turnIndex).toBe(5)
    })

    it('records multiple corrections', () => {
      memory.record('m1', 'f1')
      memory.record('m2', 'f2')
      memory.record('m3', 'f3')
      expect(memory.count).toBe(3)
    })
  })

  // -----------------------------------------------------------------------
  // Eviction
  // -----------------------------------------------------------------------

  describe('eviction', () => {
    it('evicts oldest when exceeding maxCorrections', () => {
      const small = new CorrectionMemory(3)
      small.record('first', 'f1')
      small.record('second', 'f2')
      small.record('third', 'f3')
      small.record('fourth', 'f4')

      expect(small.count).toBe(3)
      const entries = small.getEntries()
      expect(entries[0].mistake).toBe('second') // first was evicted
      expect(entries[2].mistake).toBe('fourth')
    })

    it('uses default maxCorrections of 20', () => {
      for (let i = 0; i < 25; i++) {
        memory.record(`mistake ${i}`, `fix ${i}`)
      }
      expect(memory.count).toBe(20)
      // First 5 should be evicted
      const entries = memory.getEntries()
      expect(entries[0].mistake).toBe('mistake 5')
    })

    it('maxCorrections of 1 keeps only the latest', () => {
      const single = new CorrectionMemory(1)
      single.record('old', 'f1')
      single.record('new', 'f2')
      expect(single.count).toBe(1)
      expect(single.getEntries()[0].mistake).toBe('new')
    })
  })

  // -----------------------------------------------------------------------
  // getCorrections() formatting
  // -----------------------------------------------------------------------

  describe('getCorrections()', () => {
    it('returns empty string when no corrections', () => {
      expect(memory.getCorrections()).toBe('')
    })

    it('includes header', () => {
      memory.record('m', 'f')
      const output = memory.getCorrections()
      expect(output).toContain('# Session Corrections')
    })

    it('includes instruction text', () => {
      memory.record('m', 'f')
      const output = memory.getCorrections()
      expect(output).toContain('Do not repeat them')
    })

    it('wraps in <corrections> XML tags', () => {
      memory.record('m', 'f')
      const output = memory.getCorrections()
      expect(output).toContain('<corrections>')
      expect(output).toContain('</corrections>')
    })

    it('wraps each correction in <correction> tags with index', () => {
      memory.record('mistake1', 'fix1')
      memory.record('mistake2', 'fix2')
      const output = memory.getCorrections()
      expect(output).toContain('<correction index="1">')
      expect(output).toContain('<correction index="2">')
    })

    it('includes mistake and fix in XML', () => {
      memory.record('bad thing', 'good thing')
      const output = memory.getCorrections()
      expect(output).toContain('<mistake>bad thing</mistake>')
      expect(output).toContain('<fix>good thing</fix>')
    })
  })

  // -----------------------------------------------------------------------
  // clear()
  // -----------------------------------------------------------------------

  describe('clear()', () => {
    it('removes all corrections', () => {
      memory.record('m1', 'f1')
      memory.record('m2', 'f2')
      memory.clear()
      expect(memory.count).toBe(0)
      expect(memory.hasCorrections).toBe(false)
      expect(memory.getCorrections()).toBe('')
    })

    it('allows new recordings after clear', () => {
      memory.record('old', 'f')
      memory.clear()
      memory.record('new', 'f')
      expect(memory.count).toBe(1)
      expect(memory.getEntries()[0].mistake).toBe('new')
    })
  })
})
