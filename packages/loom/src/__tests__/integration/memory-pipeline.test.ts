/**
 * Integration Tests — Memory Pipeline
 *
 * Tests the memory loading → layering → injection → prompt assembly pipeline.
 * Uses real CorrectionMemory + session recall with PromptBuilder.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { PromptBuilder } from '../../prompt/builder.js'
import { createIdentityFragment } from '../../prompt/fragments/identity.js'
import { injectMemory, injectRawMemory } from '../../memory/injector.js'
import { layerMemoryEntries } from '../../memory/loader.js'
import { CorrectionMemory } from '../../memory/correction.js'
import { recallRelevantSessions } from '../../memory/session-recall.js'
import type { MemoryEntry, SessionSummary } from '../../memory/types.js'

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

// ---------------------------------------------------------------------------
// Layering → Injection
// ---------------------------------------------------------------------------

describe('Memory Layering → Injection', () => {
  let builder: PromptBuilder

  beforeEach(() => {
    builder = new PromptBuilder()
    builder.addFragment(createIdentityFragment('You are an agent.'))
  })

  it('layers duplicate paths (last wins) then injects', () => {
    const entries = [
      entry('/project/AGENTS.md', 'Old rules'),
      entry('/project/AGENTS.md', 'New rules'),
    ]
    const layered = layerMemoryEntries(entries)
    expect(layered).toHaveLength(1)
    expect(layered[0].content).toBe('New rules')

    injectMemory(builder, layered)
    const text = builder.buildText()
    expect(text).toContain('New rules')
    expect(text).not.toContain('Old rules')
  })

  it('preserves entries from different paths', () => {
    const entries = [
      entry('/global/AGENTS.md', 'Global rules'),
      entry('/project/AGENTS.md', 'Project rules'),
    ]
    const layered = layerMemoryEntries(entries)
    expect(layered).toHaveLength(2)

    injectMemory(builder, layered)
    const text = builder.buildText()
    expect(text).toContain('Global rules')
    expect(text).toContain('Project rules')
  })

  it('empty entries after layering produce no memory fragment', () => {
    const layered = layerMemoryEntries([])
    injectMemory(builder, layered)
    expect(builder.has('memory')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Corrections → Prompt
// ---------------------------------------------------------------------------

describe('Corrections → Prompt Integration', () => {
  it('correction memory flows through to final prompt text', () => {
    const builder = new PromptBuilder()
    builder.addFragment(createIdentityFragment('Agent'))

    const corrections = new CorrectionMemory()
    corrections.record(
      'Used synchronous fs.readFileSync',
      'Use async fs.readFile with await',
    )

    const formatted = corrections.getCorrections()
    injectRawMemory(builder, formatted, 'session-corrections')

    const text = builder.buildText()
    expect(text).toContain('Session Corrections')
    expect(text).toContain('synchronous')
    expect(text).toContain('async')
  })

  it('no corrections = no injection', () => {
    const builder = new PromptBuilder()
    const corrections = new CorrectionMemory()

    injectRawMemory(builder, corrections.getCorrections(), 'corrections')
    expect(builder.has('memory')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Session Recall → Prompt
// ---------------------------------------------------------------------------

describe('Session Recall → Prompt Integration', () => {
  const sessions: SessionSummary[] = [
    {
      sessionId: 's1',
      summary: 'Configured TypeScript strict mode and fixed type errors',
      keywords: ['typescript', 'strict', 'types', 'configuration'],
      timestamp: '2026-03-30T10:00:00Z',
    },
    {
      sessionId: 's2',
      summary: 'Set up Vitest and wrote initial test suite',
      keywords: ['vitest', 'testing', 'setup'],
      timestamp: '2026-03-31T14:00:00Z',
    },
  ]

  it('relevant session context injected into prompt', () => {
    const builder = new PromptBuilder()
    builder.addFragment(createIdentityFragment('Agent'))

    const recall = recallRelevantSessions(
      'I need to fix TypeScript type errors',
      sessions,
    )
    if (recall) {
      injectRawMemory(builder, recall, 'session-recall')
    }

    const text = builder.buildText()
    expect(text).toContain('Relevant Past Sessions')
    expect(text).toContain('s1')
  })

  it('unrelated prompt produces no recall injection', () => {
    const builder = new PromptBuilder()

    const recall = recallRelevantSessions(
      'deploy to kubernetes cluster',
      sessions,
    )
    injectRawMemory(builder, recall, 'session-recall')
    expect(builder.has('memory')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Full memory pipeline
// ---------------------------------------------------------------------------

describe('Full Memory Pipeline', () => {
  it('combines AGENTS.md + corrections + session recall in one prompt', () => {
    const builder = new PromptBuilder()
    builder.addFragment(createIdentityFragment('Cortex Agent'))

    // 1. AGENTS.md
    const entries = [entry('/project/AGENTS.md', 'Use strict TypeScript.')]
    injectMemory(builder, entries)

    // 2. Corrections
    const corrections = new CorrectionMemory()
    corrections.record('Forgot to validate input', 'Always validate at boundaries')
    injectRawMemory(builder, corrections.getCorrections(), 'corrections')

    // 3. Session recall
    const sessions: SessionSummary[] = [{
      sessionId: 'prev',
      summary: 'Set up input validation middleware',
      keywords: ['validation', 'middleware', 'input'],
      timestamp: '2026-03-29T10:00:00Z',
    }]
    const recall = recallRelevantSessions('validate user input', sessions)
    if (recall) {
      injectRawMemory(builder, recall, 'recall')
    }

    const text = builder.buildText()

    // All three memory sources present
    expect(text).toContain('Use strict TypeScript')
    expect(text).toContain('Session Corrections')
    expect(text).toContain('Forgot to validate input')
    expect(text).toContain('Relevant Past Sessions')
  })
})
