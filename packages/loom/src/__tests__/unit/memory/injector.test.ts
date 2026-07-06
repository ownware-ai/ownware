/**
 * Unit Tests — Memory Injector
 *
 * Tests injection of memory entries into the PromptBuilder,
 * including XML wrapping, single vs multi-source, and raw injection.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { PromptBuilder } from '../../../prompt/builder.js'
import { injectMemory, injectRawMemory } from '../../../memory/injector.js'
import type { MemoryEntry } from '../../../memory/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(path: string, content: string): MemoryEntry {
  return {
    source: { path, format: 'markdown' },
    content,
    loadedAt: Date.now(),
  }
}

describe('injectMemory()', () => {
  let builder: PromptBuilder

  beforeEach(() => {
    builder = new PromptBuilder()
  })

  it('does nothing for empty entries', () => {
    injectMemory(builder, [])
    expect(builder.size).toBe(0)
  })

  it('does nothing when all entries have empty content', () => {
    injectMemory(builder, [entry('/path/AGENTS.md', ''), entry('/path/other.md', '  ')])
    expect(builder.size).toBe(0)
  })

  it('injects single entry with agent-memory tag', () => {
    injectMemory(builder, [entry('/project/AGENTS.md', 'Be careful with prod.')])
    const text = builder.buildText()
    expect(text).toContain('<agent-memory')
    expect(text).toContain('Be careful with prod.')
    expect(text).toContain('</agent-memory>')
  })

  it('includes source filename in single-entry tag', () => {
    injectMemory(builder, [entry('/project/AGENTS.md', 'content')])
    const text = builder.buildText()
    expect(text).toContain('AGENTS.md')
  })

  it('wraps multiple entries in memory-source tags', () => {
    injectMemory(builder, [
      entry('/global/AGENTS.md', 'Global rules'),
      entry('/project/AGENTS.md', 'Project rules'),
    ])
    const text = builder.buildText()
    expect(text).toContain('<memory-source name="AGENTS.md">')
    expect(text).toContain('Global rules')
    expect(text).toContain('Project rules')
  })

  it('includes # Memory header', () => {
    injectMemory(builder, [entry('/path/AGENTS.md', 'content')])
    const text = builder.buildText()
    expect(text).toContain('# Memory')
  })

  it('sets cacheControl to false on injected fragment', () => {
    injectMemory(builder, [entry('/path/AGENTS.md', 'content')])
    const fragments = builder.getOrderedFragments()
    expect(fragments[0].cacheControl).toBe(false)
  })

  it('places content in memory slot', () => {
    injectMemory(builder, [entry('/path/AGENTS.md', 'content')])
    expect(builder.has('memory')).toBe(true)
  })
})

describe('injectRawMemory()', () => {
  let builder: PromptBuilder

  beforeEach(() => {
    builder = new PromptBuilder()
  })

  it('does nothing for empty content', () => {
    injectRawMemory(builder, '')
    expect(builder.size).toBe(0)
  })

  it('does nothing for whitespace-only content', () => {
    injectRawMemory(builder, '   \n\t  ')
    expect(builder.size).toBe(0)
  })

  it('injects raw content into memory slot', () => {
    injectRawMemory(builder, 'Some correction context')
    expect(builder.has('memory')).toBe(true)
    expect(builder.buildText()).toContain('Some correction context')
  })

  it('uses lower priority (10) than main memory', () => {
    injectRawMemory(builder, 'raw content')
    const fragments = builder.getOrderedFragments()
    expect(fragments[0].priority).toBe(10)
  })

  it('accepts custom label', () => {
    injectRawMemory(builder, 'content', 'corrections')
    const fragments = builder.getOrderedFragments()
    expect(fragments[0].label).toBe('corrections')
  })
})
