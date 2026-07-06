/**
 * Unit Tests — PromptBuilder
 *
 * Tests the core builder logic: fragment management, slot ordering,
 * priority sorting, fluent API, and assembled output structure.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { PromptBuilder } from '../../../prompt/builder.js'
import type { PromptSlot, AssembledPrompt } from '../../../prompt/types.js'
import { SLOT_ORDER } from '../../../prompt/types.js'

describe('PromptBuilder', () => {
  let builder: PromptBuilder

  beforeEach(() => {
    builder = new PromptBuilder()
  })

  // -----------------------------------------------------------------------
  // Construction & basic state
  // -----------------------------------------------------------------------

  describe('initial state', () => {
    it('starts with zero fragments', () => {
      expect(builder.size).toBe(0)
    })

    it('has() returns false for all slots', () => {
      for (const slot of SLOT_ORDER) {
        expect(builder.has(slot)).toBe(false)
      }
    })

    it('build() returns empty prompt when no fragments added', () => {
      const result = builder.build()
      expect(result.text).toBe('')
      expect(result.cacheBreakpoints).toEqual([])
      expect(result.fragmentCount).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // add()
  // -----------------------------------------------------------------------

  describe('add()', () => {
    it('adds a fragment to the specified slot', () => {
      builder.add('identity', 'You are an agent.')
      expect(builder.has('identity')).toBe(true)
      expect(builder.size).toBe(1)
    })

    it('returns this for fluent chaining', () => {
      const result = builder.add('identity', 'test')
      expect(result).toBe(builder)
    })

    it('supports method chaining across multiple adds', () => {
      const result = builder
        .add('identity', 'I am an agent')
        .add('context', 'Date: today')
        .add('behavior', 'Be helpful')

      expect(result).toBe(builder)
      expect(builder.size).toBe(3)
    })

    it('ignores empty content', () => {
      builder.add('identity', '')
      builder.add('identity', '   ')
      builder.add('identity', '\n\t')
      expect(builder.size).toBe(0)
      expect(builder.has('identity')).toBe(false)
    })

    it('trims content before storing', () => {
      builder.add('identity', '  hello world  ')
      const text = builder.buildText()
      expect(text).toBe('hello world')
    })

    it('allows multiple fragments in the same slot', () => {
      builder.add('behavior', 'Rule 1')
      builder.add('behavior', 'Rule 2')
      expect(builder.size).toBe(2)
    })

    it('accepts priority option', () => {
      builder.add('identity', 'low priority', { priority: 1 })
      builder.add('identity', 'high priority', { priority: 100 })
      const text = builder.buildText()
      // Higher priority comes first
      expect(text.indexOf('high priority')).toBeLessThan(text.indexOf('low priority'))
    })

    it('accepts label option', () => {
      builder.add('identity', 'content', { label: 'my-label' })
      const fragments = builder.getOrderedFragments()
      expect(fragments[0].label).toBe('my-label')
    })

    it('accepts cacheControl option', () => {
      builder.add('identity', 'content', { cacheControl: true })
      const fragments = builder.getOrderedFragments()
      expect(fragments[0].cacheControl).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // addFragment()
  // -----------------------------------------------------------------------

  describe('addFragment()', () => {
    it('adds a pre-built fragment', () => {
      builder.addFragment({
        slot: 'identity',
        content: 'You are Cortex.',
        priority: 50,
        cacheControl: true,
      })
      expect(builder.size).toBe(1)
      expect(builder.has('identity')).toBe(true)
    })

    it('returns this for chaining', () => {
      const result = builder.addFragment({
        slot: 'identity',
        content: 'test',
        priority: 0,
      })
      expect(result).toBe(builder)
    })

    it('ignores fragments with empty content', () => {
      builder.addFragment({ slot: 'identity', content: '  ', priority: 0 })
      expect(builder.size).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // remove()
  // -----------------------------------------------------------------------

  describe('remove()', () => {
    it('removes all fragments from a slot', () => {
      builder.add('identity', 'A').add('identity', 'B')
      expect(builder.size).toBe(2)

      builder.remove('identity')
      expect(builder.size).toBe(0)
      expect(builder.has('identity')).toBe(false)
    })

    it('returns this for chaining', () => {
      expect(builder.remove('identity')).toBe(builder)
    })

    it('does not throw when removing from empty slot', () => {
      expect(() => builder.remove('identity')).not.toThrow()
    })

    it('only removes the specified slot', () => {
      builder.add('identity', 'I').add('behavior', 'B')
      builder.remove('identity')
      expect(builder.has('identity')).toBe(false)
      expect(builder.has('behavior')).toBe(true)
      expect(builder.size).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // clear()
  // -----------------------------------------------------------------------

  describe('clear()', () => {
    it('removes all fragments from all slots', () => {
      builder
        .add('identity', 'I')
        .add('context', 'C')
        .add('behavior', 'B')
      expect(builder.size).toBe(3)

      builder.clear()
      expect(builder.size).toBe(0)
    })

    it('returns this for chaining', () => {
      expect(builder.clear()).toBe(builder)
    })
  })

  // -----------------------------------------------------------------------
  // Slot ordering
  // -----------------------------------------------------------------------

  describe('slot ordering', () => {
    it('assembles slots in canonical order regardless of insertion order', () => {
      // Insert in reverse order
      builder
        .add('custom', 'CUSTOM')
        .add('skills', 'SKILLS')
        .add('behavior', 'BEHAVIOR')
        .add('tools', 'TOOLS')
        .add('context', 'CONTEXT')
        .add('memory', 'MEMORY')
        .add('identity', 'IDENTITY')

      const text = builder.buildText()
      const positions = {
        identity: text.indexOf('IDENTITY'),
        memory: text.indexOf('MEMORY'),
        context: text.indexOf('CONTEXT'),
        tools: text.indexOf('TOOLS'),
        behavior: text.indexOf('BEHAVIOR'),
        skills: text.indexOf('SKILLS'),
        custom: text.indexOf('CUSTOM'),
      }

      expect(positions.tools).toBeLessThan(positions.behavior)
      expect(positions.behavior).toBeLessThan(positions.identity)
      expect(positions.identity).toBeLessThan(positions.memory)
      expect(positions.memory).toBeLessThan(positions.context)
      expect(positions.context).toBeLessThan(positions.skills)
      expect(positions.skills).toBeLessThan(positions.custom)
    })

    it('skips empty slots without extra separators', () => {
      builder.add('identity', 'IDENTITY').add('behavior', 'BEHAVIOR')
      const text = builder.buildText()

      // Should NOT have triple+ newlines from skipped slots
      expect(text).not.toMatch(/\n{3,}/)
      expect(text).toBe('BEHAVIOR\n\nIDENTITY')
    })
  })

  // -----------------------------------------------------------------------
  // Priority sorting
  // -----------------------------------------------------------------------

  describe('priority sorting within a slot', () => {
    it('sorts higher priority fragments first', () => {
      builder
        .add('behavior', 'LOW', { priority: 1 })
        .add('behavior', 'HIGH', { priority: 100 })
        .add('behavior', 'MED', { priority: 50 })

      const text = builder.buildText()
      expect(text.indexOf('HIGH')).toBeLessThan(text.indexOf('MED'))
      expect(text.indexOf('MED')).toBeLessThan(text.indexOf('LOW'))
    })

    it('preserves insertion order for equal priorities', () => {
      builder
        .add('behavior', 'FIRST')
        .add('behavior', 'SECOND')
        .add('behavior', 'THIRD')

      const text = builder.buildText()
      expect(text.indexOf('FIRST')).toBeLessThan(text.indexOf('SECOND'))
      expect(text.indexOf('SECOND')).toBeLessThan(text.indexOf('THIRD'))
    })

    it('defaults priority to 0', () => {
      builder.add('behavior', 'content')
      const fragments = builder.getOrderedFragments()
      expect(fragments[0].priority).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // Fragment separation
  // -----------------------------------------------------------------------

  describe('fragment separation', () => {
    it('separates fragments within a slot with double newlines', () => {
      builder.add('behavior', 'Rule A').add('behavior', 'Rule B')
      const text = builder.buildText()
      expect(text).toBe('Rule A\n\nRule B')
    })

    it('separates different slots with double newlines', () => {
      builder.add('identity', 'WHO').add('behavior', 'HOW')
      const text = builder.buildText()
      expect(text).toBe('HOW\n\nWHO')
    })

    it('single fragment has no separators', () => {
      builder.add('identity', 'Only fragment')
      const text = builder.buildText()
      expect(text).toBe('Only fragment')
    })
  })

  // -----------------------------------------------------------------------
  // build() output shape
  // -----------------------------------------------------------------------

  describe('build() output', () => {
    it('returns correct fragment count', () => {
      builder
        .add('identity', 'A')
        .add('context', 'B')
        .add('behavior', 'C')

      const result = builder.build()
      expect(result.fragmentCount).toBe(3)
    })

    it('returns AssembledPrompt shape', () => {
      builder.add('identity', 'test')
      const result = builder.build()

      expect(result).toHaveProperty('text')
      expect(result).toHaveProperty('cacheBreakpoints')
      expect(result).toHaveProperty('fragmentCount')
      expect(typeof result.text).toBe('string')
      expect(Array.isArray(result.cacheBreakpoints)).toBe(true)
      expect(typeof result.fragmentCount).toBe('number')
    })

    it('cacheBreakpoints is an array of numbers', () => {
      builder
        .add('identity', 'stable content', { cacheControl: true })
        .add('context', 'volatile content', { cacheControl: false })

      const result = builder.build()
      for (const bp of result.cacheBreakpoints) {
        expect(typeof bp).toBe('number')
        expect(bp).toBeGreaterThanOrEqual(0)
        expect(bp).toBeLessThanOrEqual(result.text.length)
      }
    })
  })

  // -----------------------------------------------------------------------
  // buildText() convenience
  // -----------------------------------------------------------------------

  describe('buildText()', () => {
    it('returns just the text string', () => {
      builder.add('identity', 'hello')
      expect(builder.buildText()).toBe('hello')
    })

    it('matches build().text', () => {
      builder.add('identity', 'test').add('behavior', 'rules')
      expect(builder.buildText()).toBe(builder.build().text)
    })
  })

  // -----------------------------------------------------------------------
  // getOrderedFragments()
  // -----------------------------------------------------------------------

  describe('getOrderedFragments()', () => {
    it('returns empty array when no fragments', () => {
      expect(builder.getOrderedFragments()).toEqual([])
    })

    it('returns fragments in slot order then priority order', () => {
      builder
        .add('behavior', 'B-low', { priority: 1 })
        .add('identity', 'I', { priority: 50 })
        .add('behavior', 'B-high', { priority: 100 })

      const ordered = builder.getOrderedFragments()
      expect(ordered).toHaveLength(3)
      expect(ordered[0].content).toBe('B-high')      // behavior slot first (new order)
      expect(ordered[1].content).toBe('B-low')       // behavior low priority
      expect(ordered[2].content).toBe('I')            // identity slot after behavior
    })

    it('does not mutate internal state', () => {
      builder.add('identity', 'A')
      const first = builder.getOrderedFragments()
      const second = builder.getOrderedFragments()
      expect(first).not.toBe(second) // different array instances
      expect(first).toEqual(second)  // same content
    })
  })

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles very long content', () => {
      const longContent = 'x'.repeat(100_000)
      builder.add('identity', longContent)
      expect(builder.buildText()).toBe(longContent)
    })

    it('handles special characters in content', () => {
      const special = '{{template}} <xml/> $var "quotes" \'single\' `backtick`'
      builder.add('identity', special)
      expect(builder.buildText()).toBe(special)
    })

    it('handles unicode content', () => {
      builder.add('identity', 'Hello 世界 🌍 مرحبا')
      expect(builder.buildText()).toBe('Hello 世界 🌍 مرحبا')
    })

    it('can rebuild after clear', () => {
      builder.add('identity', 'first')
      expect(builder.buildText()).toBe('first')

      builder.clear()
      builder.add('identity', 'second')
      expect(builder.buildText()).toBe('second')
    })

    it('can rebuild after remove and re-add', () => {
      builder.add('identity', 'old')
      builder.remove('identity')
      builder.add('identity', 'new')
      expect(builder.buildText()).toBe('new')
    })
  })
})
