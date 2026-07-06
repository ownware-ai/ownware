/**
 * Integration Tests — Full Prompt Assembly
 *
 * Tests the complete prompt construction pipeline: fragments are created,
 * memory is injected, skills are listed, and the builder produces a
 * correctly ordered, well-formatted system prompt.
 *
 * These tests exercise real module interactions (no mocks).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { PromptBuilder } from '../../prompt/builder.js'
import { createIdentityFragment } from '../../prompt/fragments/identity.js'
import { createContextFragment } from '../../prompt/fragments/context.js'
import { createBehaviorFragment } from '../../prompt/fragments/behavior.js'
import { createToolsFragment } from '../../prompt/fragments/tools.js'
import { createSkillsFragment } from '../../prompt/fragments/skills.js'
import { injectMemory, injectRawMemory } from '../../memory/injector.js'
import { CorrectionMemory } from '../../memory/correction.js'
import type { MemoryEntry } from '../../memory/types.js'
import type { Tool } from '../../tools/types.js'
import type { SkillDefinition } from '../../skills/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOUL_MD = `You are Cortex, an AI agent operating system.
You help developers with code, debugging, and architecture.`

const AGENTS_MD = `# Project Memory
- This project uses TypeScript with strict mode
- Tests use Vitest
- Prefer functional patterns over classes`

const BEHAVIOR_RULES = `- Be concise and direct
- Show code, not explanations
- Ask before making destructive changes`

const mockTool: Tool = {
  name: 'read_file',
  description: 'Read a file from disk',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: async () => ({ content: '', isError: false }),
  isReadOnly: true,
  category: 'filesystem',
}

const mockSkill: SkillDefinition = {
  name: 'commit',
  description: 'Create a git commit',
  trigger: '/commit',
  content: 'Help create a commit...',
}

// ---------------------------------------------------------------------------
// Full assembly pipeline
// ---------------------------------------------------------------------------

describe('Full Prompt Assembly', () => {
  let builder: PromptBuilder

  beforeEach(() => {
    builder = new PromptBuilder()
  })

  it('assembles a complete system prompt from all fragment types', () => {
    // 1. Add identity
    builder.addFragment(createIdentityFragment(SOUL_MD))

    // 2. Inject memory
    const entries: MemoryEntry[] = [{
      source: { path: '/project/AGENTS.md', format: 'markdown' },
      content: AGENTS_MD,
      loadedAt: Date.now(),
    }]
    injectMemory(builder, entries)

    // 3. Add context
    builder.addFragment(createContextFragment({
      date: '2026-04-02',
      platform: 'darwin',
      cwd: '/Users/dev/project',
      gitBranch: 'main',
    }))

    // 4. Add tools
    builder.addFragment(createToolsFragment([mockTool]))

    // 5. Add behavior
    builder.addFragment(createBehaviorFragment(BEHAVIOR_RULES))

    // 6. Add skills
    builder.addFragment(createSkillsFragment([mockSkill]))

    // Build
    const result = builder.build()

    // Verify non-empty
    expect(result.text.length).toBeGreaterThan(0)
    expect(result.fragmentCount).toBe(6)

    // Verify slot ordering
    const text = result.text
    const identityPos = text.indexOf('# Identity')
    const memoryPos = text.indexOf('# Memory')
    const envPos = text.indexOf('# Environment')
    const toolsPos = text.indexOf('# Available Tools')
    const behaviorPos = text.indexOf('# Behavior')
    const skillsPos = text.indexOf('# Available Skills')

    // New slot order: tools → behavior → identity → memory → context → skills
    expect(toolsPos).toBeLessThan(behaviorPos)
    expect(behaviorPos).toBeLessThan(identityPos)
    expect(identityPos).toBeLessThan(memoryPos)
    expect(memoryPos).toBeLessThan(envPos)
    expect(envPos).toBeLessThan(skillsPos)

    // Verify content present
    expect(text).toContain('Cortex')
    expect(text).toContain('TypeScript with strict mode')
    expect(text).toContain('2026-04-02')
    expect(text).toContain('read_file')
    expect(text).toContain('Be concise')
    expect(text).toContain('commit')
  })

  it('works with minimal fragments (just identity)', () => {
    builder.addFragment(createIdentityFragment(SOUL_MD))
    const result = builder.build()
    expect(result.text).toContain('Cortex')
    expect(result.fragmentCount).toBe(1)
  })

  it('works with identity + context only', () => {
    builder
      .addFragment(createIdentityFragment(SOUL_MD))
      .addFragment(createContextFragment({ date: '2026-04-02' }))

    const result = builder.build()
    expect(result.text).toContain('Cortex')
    expect(result.text).toContain('2026-04-02')
    expect(result.fragmentCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Memory + Correction integration
// ---------------------------------------------------------------------------

describe('Memory + Correction Pipeline', () => {
  it('injects both AGENTS.md memory and session corrections', () => {
    const builder = new PromptBuilder()

    // Add identity first
    builder.addFragment(createIdentityFragment('You are an agent.'))

    // Inject AGENTS.md memory
    const entries: MemoryEntry[] = [{
      source: { path: '/project/AGENTS.md', format: 'markdown' },
      content: 'Use TypeScript.',
      loadedAt: Date.now(),
    }]
    injectMemory(builder, entries)

    // Record corrections and inject them
    const corrections = new CorrectionMemory()
    corrections.record('Used var instead of const', 'Always use const or let')
    corrections.record('Forgot error handling', 'Add try/catch around async ops')
    injectRawMemory(builder, corrections.getCorrections(), 'corrections')

    const text = builder.buildText()

    // Both memory sources should be present
    expect(text).toContain('Use TypeScript')
    expect(text).toContain('Session Corrections')
    expect(text).toContain('Used var instead of const')
    expect(text).toContain('Forgot error handling')
  })

  it('main memory has higher priority than corrections', () => {
    const builder = new PromptBuilder()

    // Inject raw corrections first (priority 10)
    injectRawMemory(builder, 'CORRECTIONS', 'corrections')

    // Inject main memory (priority 50 default from injectMemory)
    const entries: MemoryEntry[] = [{
      source: { path: '/AGENTS.md', format: 'markdown' },
      content: 'MAIN MEMORY',
      loadedAt: Date.now(),
    }]
    injectMemory(builder, entries)

    const text = builder.buildText()
    // Main memory should come before corrections due to higher priority
    expect(text.indexOf('MAIN MEMORY')).toBeLessThan(text.indexOf('CORRECTIONS'))
  })
})

// ---------------------------------------------------------------------------
// Cache breakpoints integration
// ---------------------------------------------------------------------------

describe('Cache Breakpoints Integration', () => {
  it('produces breakpoints when stable + volatile fragments mix', () => {
    const builder = new PromptBuilder()

    // Stable
    builder.addFragment(createIdentityFragment(SOUL_MD))
    // Volatile
    builder.addFragment(createContextFragment({ date: '2026-04-02' }))

    const result = builder.build()

    // Should have at least one breakpoint (between stable identity and volatile context)
    expect(result.cacheBreakpoints.length).toBeGreaterThan(0)
  })

  it('all breakpoints are valid offsets within text', () => {
    const builder = new PromptBuilder()
    builder.addFragment(createIdentityFragment(SOUL_MD))
    builder.addFragment(createBehaviorFragment(BEHAVIOR_RULES))
    builder.addFragment(createContextFragment({ date: '2026-04-02' }))

    const result = builder.build()
    for (const bp of result.cacheBreakpoints) {
      expect(bp).toBeGreaterThanOrEqual(0)
      expect(bp).toBeLessThanOrEqual(result.text.length)
    }
  })
})

// ---------------------------------------------------------------------------
// Rebuild / mutation safety
// ---------------------------------------------------------------------------

describe('Rebuild Safety', () => {
  it('can modify builder and rebuild without stale state', () => {
    const builder = new PromptBuilder()
    builder.addFragment(createIdentityFragment('Version 1'))

    const v1 = builder.buildText()
    expect(v1).toContain('Version 1')

    builder.remove('identity')
    builder.addFragment(createIdentityFragment('Version 2'))

    const v2 = builder.buildText()
    expect(v2).toContain('Version 2')
    expect(v2).not.toContain('Version 1')
  })

  it('builder.build() is idempotent', () => {
    const builder = new PromptBuilder()
    builder.addFragment(createIdentityFragment(SOUL_MD))
    builder.addFragment(createContextFragment({ date: '2026-04-02' }))

    const first = builder.build()
    const second = builder.build()

    expect(first.text).toBe(second.text)
    expect(first.fragmentCount).toBe(second.fragmentCount)
    expect(first.cacheBreakpoints).toEqual(second.cacheBreakpoints)
  })
})
