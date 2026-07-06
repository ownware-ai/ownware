/**
 * Unit Tests — Profile Validator
 *
 * Tests config validation: required fields, type checking, defaults,
 * nested objects, and error messages with field paths.
 */

import { describe, it, expect } from 'vitest'
import { validateProfile } from '../../../profile/validator.js'
import { ProfileError } from '../../../profile/types.js'

// ---------------------------------------------------------------------------
// Minimal valid config
// ---------------------------------------------------------------------------

const minimal = { name: 'test-agent' }

const full = {
  name: 'cortex',
  description: 'A production agent',
  model: 'anthropic:claude-sonnet-4-20250514',
  temperature: 0.7,
  maxTurns: 50,
  maxTokens: 8192,
  systemPrompt: 'You are Cortex.',
  tools: { builtin: ['read_file', 'write_file'], deny: ['bash'] },
  skills: ['./skills'],
  memory: ['./AGENTS.md'],
  workspace: { root: '/tmp/ws', mode: 'isolated' },
  sandbox: { enabled: true },
  mcpServers: [{
    name: 'chrome',
    command: 'chrome-devtools-mcp',
    args: ['--port=9222'],
    transport: 'stdio',
  }],
  subagents: [{
    name: 'researcher',
    description: 'Researches topics',
    model: 'anthropic:claude-haiku-4-5-20251001',
  }],
}

// ---------------------------------------------------------------------------
// Valid configs
// ---------------------------------------------------------------------------

describe('validateProfile() — valid configs', () => {
  it('accepts minimal config (just name)', () => {
    const config = validateProfile(minimal)
    expect(config.name).toBe('test-agent')
  })

  it('accepts full config', () => {
    const config = validateProfile(full)
    expect(config.name).toBe('cortex')
    expect(config.model).toBe('anthropic:claude-sonnet-4-20250514')
    expect(config.temperature).toBe(0.7)
    expect(config.maxTurns).toBe(50)
    expect(config.tools?.builtin).toEqual(['read_file', 'write_file'])
    expect(config.tools?.deny).toEqual(['bash'])
    expect(config.workspace?.mode).toBe('isolated')
    expect(config.sandbox?.enabled).toBe(true)
    expect(config.mcpServers).toHaveLength(1)
    expect(config.subagents).toHaveLength(1)
  })

  it('trims name', () => {
    const config = validateProfile({ name: '  my-agent  ' })
    expect(config.name).toBe('my-agent')
  })

  it('defaults optional fields to undefined', () => {
    const config = validateProfile(minimal)
    expect(config.model).toBeUndefined()
    expect(config.temperature).toBeUndefined()
    expect(config.tools).toBeUndefined()
    expect(config.skills).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Invalid configs
// ---------------------------------------------------------------------------

describe('validateProfile() — invalid configs', () => {
  it('rejects non-object', () => {
    expect(() => validateProfile('string')).toThrow(ProfileError)
    expect(() => validateProfile(42)).toThrow(ProfileError)
    expect(() => validateProfile(null)).toThrow(ProfileError)
    expect(() => validateProfile([])).toThrow(ProfileError)
  })

  it('rejects missing name', () => {
    expect(() => validateProfile({})).toThrow(ProfileError)
    expect(() => validateProfile({ description: 'no name' })).toThrow(/name/)
  })

  it('rejects empty name', () => {
    expect(() => validateProfile({ name: '' })).toThrow(ProfileError)
    expect(() => validateProfile({ name: '   ' })).toThrow(ProfileError)
  })

  it('rejects non-string name', () => {
    expect(() => validateProfile({ name: 42 })).toThrow(ProfileError)
  })

  it('rejects non-string model', () => {
    expect(() => validateProfile({ name: 'x', model: 42 })).toThrow(/model/)
  })

  it('rejects temperature out of range', () => {
    expect(() => validateProfile({ name: 'x', temperature: -1 })).toThrow(/temperature/)
    expect(() => validateProfile({ name: 'x', temperature: 3 })).toThrow(/temperature/)
  })

  it('rejects non-integer maxTurns', () => {
    expect(() => validateProfile({ name: 'x', maxTurns: 1.5 })).toThrow(/maxTurns/)
  })

  it('rejects maxTurns < 1', () => {
    expect(() => validateProfile({ name: 'x', maxTurns: 0 })).toThrow(/maxTurns/)
  })

  it('rejects tools as non-object', () => {
    expect(() => validateProfile({ name: 'x', tools: 'bad' })).toThrow(/tools/)
  })

  it('rejects invalid workspace mode', () => {
    expect(() => validateProfile({ name: 'x', workspace: { mode: 'bad' } })).toThrow(/workspace\.mode/)
  })

  it('rejects mcpServers without name', () => {
    expect(() => validateProfile({
      name: 'x',
      mcpServers: [{ command: 'test' }],
    })).toThrow(/mcpServers/)
  })

  it('rejects mcpServers without command', () => {
    expect(() => validateProfile({
      name: 'x',
      mcpServers: [{ name: 'test' }],
    })).toThrow(/mcpServers/)
  })

  it('rejects subagents without description', () => {
    expect(() => validateProfile({
      name: 'x',
      subagents: [{ name: 'sub' }],
    })).toThrow(/subagents/)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('validateProfile() — edge cases', () => {
  it('ignores unknown fields', () => {
    const config = validateProfile({ name: 'x', unknownField: 'ignored' })
    expect(config.name).toBe('x')
  })

  it('handles middleware as string array', () => {
    const config = validateProfile({ name: 'x', middleware: ['mw1', 'mw2'] })
    expect(config.middleware).toEqual(['mw1', 'mw2'])
  })

  it('defaults mcpServer transport to stdio', () => {
    const config = validateProfile({
      name: 'x',
      mcpServers: [{ name: 's', command: 'cmd' }],
    })
    expect(config.mcpServers![0].transport).toBe('stdio')
  })
})
