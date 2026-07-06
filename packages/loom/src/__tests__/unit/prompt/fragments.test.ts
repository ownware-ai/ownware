/**
 * Unit Tests — Prompt Fragment Factories
 *
 * Tests each fragment factory: correct slot assignment, content wrapping,
 * priority defaults, cache control flags, and edge cases.
 */

import { describe, it, expect } from 'vitest'
import { createIdentityFragment } from '../../../prompt/fragments/identity.js'
import { createContextFragment } from '../../../prompt/fragments/context.js'
import { createMemoryFragment, createLayeredMemoryFragment } from '../../../prompt/fragments/memory.js'
import {
  createBehaviorFragment,
  createSafetyPrincipleFragment,
} from '../../../prompt/fragments/behavior.js'
import { createToolsFragment } from '../../../prompt/fragments/tools.js'
import { createSkillsFragment } from '../../../prompt/fragments/skills.js'
import { createThinkingFrequencyFragment } from '../../../prompt/fragments/system.js'
import type { Tool } from '../../../tools/types.js'
import type { SkillDefinition } from '../../../skills/types.js'

// ---------------------------------------------------------------------------
// Identity fragment
// ---------------------------------------------------------------------------

describe('createIdentityFragment()', () => {
  it('places content in identity slot', () => {
    const frag = createIdentityFragment('You are Cortex.')
    expect(frag.slot).toBe('identity')
  })

  it('wraps content with # Identity header', () => {
    const frag = createIdentityFragment('You are an AI agent.')
    expect(frag.content).toContain('# Identity')
    expect(frag.content).toContain('You are an AI agent.')
  })

  it('sets cacheControl to true (stable)', () => {
    const frag = createIdentityFragment('test')
    expect(frag.cacheControl).toBe(true)
  })

  it('has high priority (100)', () => {
    const frag = createIdentityFragment('test')
    expect(frag.priority).toBe(100)
  })

  it('returns empty content for blank input', () => {
    const frag = createIdentityFragment('')
    expect(frag.content).toBe('')
  })

  it('returns empty content for whitespace-only input', () => {
    const frag = createIdentityFragment('   \n\t  ')
    expect(frag.content).toBe('')
  })

  it('trims input content', () => {
    const frag = createIdentityFragment('  hello  ')
    expect(frag.content).toContain('hello')
    expect(frag.content).not.toContain('  hello  ')
  })

  it('accepts custom label', () => {
    const frag = createIdentityFragment('test', 'custom-label')
    expect(frag.label).toBe('custom-label')
  })
})

// ---------------------------------------------------------------------------
// Context fragment
// ---------------------------------------------------------------------------

describe('createContextFragment()', () => {
  it('places content in context slot', () => {
    const frag = createContextFragment()
    expect(frag.slot).toBe('context')
  })

  it('sets cacheControl to false (volatile)', () => {
    const frag = createContextFragment()
    expect(frag.cacheControl).toBe(false)
  })

  it('includes date', () => {
    const frag = createContextFragment({ date: '2026-04-02' })
    expect(frag.content).toContain('2026-04-02')
  })

  it('includes platform', () => {
    const frag = createContextFragment({ platform: 'linux' })
    expect(frag.content).toContain('linux')
  })

  it('includes working directory', () => {
    const frag = createContextFragment({ cwd: '/home/user/project' })
    expect(frag.content).toContain('/home/user/project')
  })

  it('includes git branch when provided', () => {
    const frag = createContextFragment({ gitBranch: 'feature/loom' })
    expect(frag.content).toContain('feature/loom')
  })

  it('omits git branch line when null', () => {
    const frag = createContextFragment({ gitBranch: null })
    expect(frag.content).not.toContain('Git branch')
  })

  it('includes git status when provided', () => {
    const frag = createContextFragment({ gitStatus: '3 files modified' })
    expect(frag.content).toContain('3 files modified')
  })

  it('includes extra lines', () => {
    const frag = createContextFragment({ extra: ['Node.js v22', 'TypeScript 5.7'] })
    expect(frag.content).toContain('Node.js v22')
    expect(frag.content).toContain('TypeScript 5.7')
  })

  it('uses defaults when no opts provided', () => {
    const frag = createContextFragment()
    expect(frag.content).toContain('# Environment')
    expect(frag.content).toContain('Date:')
    expect(frag.content).toContain('Platform:')
    expect(frag.content).toContain('Working directory:')
  })
})

// ---------------------------------------------------------------------------
// Memory fragment
// ---------------------------------------------------------------------------

describe('createMemoryFragment()', () => {
  it('places content in memory slot', () => {
    const frag = createMemoryFragment('Agent instructions here')
    expect(frag.slot).toBe('memory')
  })

  it('wraps content in agent-memory XML tags', () => {
    const frag = createMemoryFragment('Remember this.')
    expect(frag.content).toContain('<agent-memory>')
    expect(frag.content).toContain('Remember this.')
    expect(frag.content).toContain('</agent-memory>')
  })

  it('sets cacheControl to false (volatile)', () => {
    const frag = createMemoryFragment('test')
    expect(frag.cacheControl).toBe(false)
  })

  it('returns empty content for blank input', () => {
    const frag = createMemoryFragment('')
    expect(frag.content).toBe('')
  })
})

describe('createLayeredMemoryFragment()', () => {
  it('combines multiple sources with memory-source tags', () => {
    const frag = createLayeredMemoryFragment([
      { label: 'global', content: 'Global rules' },
      { label: 'project', content: 'Project rules' },
    ])
    expect(frag.content).toContain('<memory-source name="global">')
    expect(frag.content).toContain('Global rules')
    expect(frag.content).toContain('<memory-source name="project">')
    expect(frag.content).toContain('Project rules')
  })

  it('skips empty sources', () => {
    const frag = createLayeredMemoryFragment([
      { label: 'empty', content: '' },
      { label: 'valid', content: 'Has content' },
    ])
    expect(frag.content).not.toContain('empty')
    expect(frag.content).toContain('valid')
  })

  it('returns empty content when all sources are empty', () => {
    const frag = createLayeredMemoryFragment([
      { label: 'a', content: '' },
      { label: 'b', content: '  ' },
    ])
    expect(frag.content).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Behavior fragment
// ---------------------------------------------------------------------------

describe('createBehaviorFragment()', () => {
  it('places content in behavior slot', () => {
    const frag = createBehaviorFragment('Be concise.')
    expect(frag.slot).toBe('behavior')
  })

  it('wraps content with # Behavior header', () => {
    const frag = createBehaviorFragment('Follow rules.')
    expect(frag.content).toContain('# Behavior')
    expect(frag.content).toContain('Follow rules.')
  })

  it('sets cacheControl to true (stable)', () => {
    const frag = createBehaviorFragment('test')
    expect(frag.cacheControl).toBe(true)
  })

  it('returns empty content for blank input', () => {
    const frag = createBehaviorFragment('')
    expect(frag.content).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Tools fragment
// ---------------------------------------------------------------------------

describe('createToolsFragment()', () => {
  const mockTool: Tool = {
    name: 'read_file',
    description: 'Read a file from disk',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
      },
      required: ['path'],
    },
    execute: async () => ({ content: '', isError: false }),
    isReadOnly: true,
    category: 'filesystem',
  }

  it('places content in tools slot', () => {
    const frag = createToolsFragment([mockTool])
    expect(frag.slot).toBe('tools')
  })

  it('includes tool name', () => {
    const frag = createToolsFragment([mockTool])
    expect(frag.content).toContain('read_file')
  })

  it('includes tool description', () => {
    const frag = createToolsFragment([mockTool])
    expect(frag.content).toContain('Read a file from disk')
  })

  it('includes tool count', () => {
    const frag = createToolsFragment([mockTool])
    expect(frag.content).toContain('1 tool')
  })

  it('pluralizes tool count', () => {
    const frag = createToolsFragment([mockTool, { ...mockTool, name: 'write_file' }])
    expect(frag.content).toContain('2 tools')
  })

  it('includes parameter documentation', () => {
    const frag = createToolsFragment([mockTool])
    expect(frag.content).toContain('path')
    expect(frag.content).toContain('required')
    expect(frag.content).toContain('File path to read')
  })

  it('shows read-only flag', () => {
    const frag = createToolsFragment([mockTool])
    expect(frag.content).toContain('read-only')
  })

  it('does not include category in output (kept internal)', () => {
    const frag = createToolsFragment([mockTool])
    expect(frag.content).not.toContain('Category:')
  })

  it('sets cacheControl to true (stable)', () => {
    const frag = createToolsFragment([mockTool])
    expect(frag.cacheControl).toBe(true)
  })

  it('returns empty content for empty tools array', () => {
    const frag = createToolsFragment([])
    expect(frag.content).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Skills fragment
// ---------------------------------------------------------------------------

describe('createSkillsFragment()', () => {
  const mockSkill: SkillDefinition = {
    name: 'commit',
    description: 'Create a git commit',
    trigger: '/commit',
    content: 'You are a commit helper...',
  }

  const regexSkill: SkillDefinition = {
    name: 'review',
    description: 'Review a PR',
    trigger: /\/review-pr\s+\d+/,
    content: 'Review the PR...',
    allowedTools: ['read_file', 'grep'],
  }

  it('places content in skills slot', () => {
    const frag = createSkillsFragment([mockSkill])
    expect(frag.slot).toBe('skills')
  })

  it('includes skill name and description', () => {
    const frag = createSkillsFragment([mockSkill])
    expect(frag.content).toContain('commit')
    expect(frag.content).toContain('Create a git commit')
  })

  it('shows string trigger', () => {
    const frag = createSkillsFragment([mockSkill])
    expect(frag.content).toContain('/commit')
  })

  it('shows regex trigger', () => {
    const frag = createSkillsFragment([regexSkill])
    expect(frag.content).toContain('/\\/review-pr\\s+\\d+/')
  })

  it('shows allowed tools', () => {
    const frag = createSkillsFragment([regexSkill])
    expect(frag.content).toContain('read_file')
    expect(frag.content).toContain('grep')
  })

  it('sets cacheControl to true (stable)', () => {
    const frag = createSkillsFragment([mockSkill])
    expect(frag.cacheControl).toBe(true)
  })

  it('returns empty content for empty skills array', () => {
    const frag = createSkillsFragment([])
    expect(frag.content).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Thinking-frequency fragment
// ---------------------------------------------------------------------------

describe('createThinkingFrequencyFragment()', () => {
  it('lands in the behavior slot', () => {
    expect(createThinkingFrequencyFragment().slot).toBe('behavior')
  })

  it('explains how to treat <system-reminder> tags', () => {
    const frag = createThinkingFrequencyFragment()
    expect(frag.content).toContain('<system-reminder>')
    expect(frag.content).toContain('harness instructions')
    expect(frag.content).toContain('not authored by the user')
  })

  it('includes calibration guidance for reasoning depth', () => {
    const frag = createThinkingFrequencyFragment()
    expect(frag.content.toLowerCase()).toContain('calibrate')
    expect(frag.content.toLowerCase()).toMatch(/over-thinking|under-thinking/)
  })

  it('sets cacheControl true — content is stable per session', () => {
    expect(createThinkingFrequencyFragment().cacheControl).toBe(true)
  })

  it('has mid-priority (80) inside the behavior slot', () => {
    expect(createThinkingFrequencyFragment().priority).toBe(80)
  })

  it('accepts an optional label', () => {
    expect(createThinkingFrequencyFragment('custom-label').label).toBe('custom-label')
  })
})

// ---------------------------------------------------------------------------
// Safety-principle fragment (universal, no domain examples)
// ---------------------------------------------------------------------------

describe('createSafetyPrincipleFragment()', () => {
  it('lands in the behavior slot', () => {
    expect(createSafetyPrincipleFragment().slot).toBe('behavior')
  })

  it('teaches reversibility / blast-radius framing', () => {
    const frag = createSafetyPrincipleFragment()
    expect(frag.content.toLowerCase()).toContain('reversibility')
    expect(frag.content.toLowerCase()).toContain('blast radius')
  })

  it('covers the universal third-party-upload concern', () => {
    const frag = createSafetyPrincipleFragment()
    expect(frag.content.toLowerCase()).toContain('third-party')
  })

  it('does NOT include coding-specific examples — those belong in profile SOUL.md', () => {
    const frag = createSafetyPrincipleFragment()
    // The whole point of this fragment is to be domain-neutral.
    expect(frag.content.toLowerCase()).not.toContain('rm -rf')
    expect(frag.content.toLowerCase()).not.toContain('git push')
    expect(frag.content.toLowerCase()).not.toContain('git reset')
    expect(frag.content.toLowerCase()).not.toContain('force-push')
    expect(frag.content.toLowerCase()).not.toContain('ci/cd')
    expect(frag.content.toLowerCase()).not.toContain('database tables')
  })

  it('keeps the authorization-scope clause', () => {
    const frag = createSafetyPrincipleFragment()
    expect(frag.content.toLowerCase()).toContain('authorization')
    expect(frag.content.toLowerCase()).toContain('measure twice')
  })

  it('sets cacheControl true', () => {
    expect(createSafetyPrincipleFragment().cacheControl).toBe(true)
  })

  it('has priority 100 inside the behavior slot', () => {
    expect(createSafetyPrincipleFragment().priority).toBe(100)
  })

  it('accepts an optional label', () => {
    expect(createSafetyPrincipleFragment('custom').label).toBe('custom')
  })
})
