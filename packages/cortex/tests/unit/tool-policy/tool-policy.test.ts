/**
 * Unit tests for tool policy (allow/deny filtering).
 */

import { describe, it, expect } from 'vitest'
import { applyToolPolicy, countResolvedTools, matchesGlob, resolvePresetTools } from '../../../src/profile/tool-policy.js'
import { builtinTools } from '@ownware/loom'
import { createMockTools } from '../../helpers/fixtures.js'

// ---------------------------------------------------------------------------
// matchesGlob
// ---------------------------------------------------------------------------

describe('matchesGlob', () => {
  describe('exact match', () => {
    it('matches identical strings', () => {
      expect(matchesGlob('readFile', 'readFile')).toBe(true)
    })

    it('does not match different strings', () => {
      expect(matchesGlob('readFile', 'writeFile')).toBe(false)
    })
  })

  describe('wildcard *', () => {
    it('matches everything', () => {
      expect(matchesGlob('anything', '*')).toBe(true)
      expect(matchesGlob('', '*')).toBe(true)
    })
  })

  describe('prefix patterns', () => {
    it('"filesystem.*" matches filesystem_read', () => {
      expect(matchesGlob('filesystem_read', 'filesystem.*')).toBe(true)
    })

    it('"filesystem.*" matches filesystem.readFile', () => {
      expect(matchesGlob('filesystem.readFile', 'filesystem.*')).toBe(true)
    })

    it('"filesystem.*" does not match shell_execute', () => {
      expect(matchesGlob('shell_execute', 'filesystem.*')).toBe(false)
    })

    it('"shell_*" matches shell_execute', () => {
      expect(matchesGlob('shell_execute', 'shell_*')).toBe(true)
    })

    it('"shell_*" does not match filesystem_read', () => {
      expect(matchesGlob('filesystem_read', 'shell_*')).toBe(false)
    })
  })

  describe('suffix patterns', () => {
    it('"*_read" matches filesystem_read', () => {
      expect(matchesGlob('filesystem_read', '*_read')).toBe(true)
    })

    it('"*_read" does not match filesystem_write', () => {
      expect(matchesGlob('filesystem_write', '*_read')).toBe(false)
    })
  })

  describe('middle patterns', () => {
    it('"file*write" matches filesystem_write', () => {
      expect(matchesGlob('filesystem_write', 'file*write')).toBe(true)
    })
  })

  describe('dot-underscore equivalence', () => {
    it('dot in pattern matches underscore in name', () => {
      expect(matchesGlob('filesystem_read', 'filesystem.read')).toBe(true)
    })

    it('dot in pattern matches dot in name', () => {
      expect(matchesGlob('filesystem.read', 'filesystem.read')).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// applyToolPolicy
// ---------------------------------------------------------------------------

describe('applyToolPolicy', () => {
  const allTools = createMockTools([
    'filesystem_read',
    'filesystem_write',
    'filesystem_list',
    'shell_execute',
    'shell_spawn',
    'browser_navigate',
    'browser_screenshot',
    'agent_spawn',
  ])

  describe('no filters', () => {
    it('returns all tools when allow and deny are empty', () => {
      const result = applyToolPolicy(allTools, [], [])
      expect(result).toHaveLength(8)
    })
  })

  describe('deny only', () => {
    it('removes single denied tool', () => {
      const result = applyToolPolicy(allTools, [], ['shell_execute'])
      expect(result).toHaveLength(7)
      expect(result.find(t => t.name === 'shell_execute')).toBeUndefined()
    })

    it('removes multiple denied tools', () => {
      const result = applyToolPolicy(allTools, [], ['shell_execute', 'shell_spawn'])
      expect(result).toHaveLength(6)
    })

    it('removes tools matching deny glob', () => {
      const result = applyToolPolicy(allTools, [], ['shell.*'])
      expect(result).toHaveLength(6)
      expect(result.every(t => !t.name.startsWith('shell_'))).toBe(true)
    })

    it('deny * removes everything', () => {
      const result = applyToolPolicy(allTools, [], ['*'])
      expect(result).toHaveLength(0)
    })
  })

  describe('allow only', () => {
    it('keeps only tools matching allow glob', () => {
      const result = applyToolPolicy(allTools, ['filesystem.*'], [])
      expect(result).toHaveLength(3)
      expect(result.every(t => t.name.startsWith('filesystem_'))).toBe(true)
    })

    it('keeps tools matching multiple allow patterns', () => {
      const result = applyToolPolicy(allTools, ['filesystem.*', 'browser.*'], [])
      expect(result).toHaveLength(5)
    })

    it('allow * keeps everything', () => {
      const result = applyToolPolicy(allTools, ['*'], [])
      expect(result).toHaveLength(8)
    })

    it('exact allow', () => {
      const result = applyToolPolicy(allTools, ['shell_execute'], [])
      expect(result).toHaveLength(1)
      expect(result[0]!.name).toBe('shell_execute')
    })
  })

  describe('allow + deny interaction', () => {
    it('deny wins over allow for same tool', () => {
      const result = applyToolPolicy(
        allTools,
        ['shell_execute'],
        ['shell_execute'],
      )
      expect(result.find(t => t.name === 'shell_execute')).toBeUndefined()
    })

    it('deny wins over wildcard allow', () => {
      const result = applyToolPolicy(allTools, ['*'], ['shell.*'])
      expect(result).toHaveLength(6)
      expect(result.every(t => !t.name.startsWith('shell_'))).toBe(true)
    })

    it('allow + deny narrows correctly', () => {
      // Allow filesystem and shell, deny shell_execute specifically
      const result = applyToolPolicy(
        allTools,
        ['filesystem.*', 'shell.*'],
        ['shell_execute'],
      )
      expect(result).toHaveLength(4) // 3 filesystem + 1 shell_spawn
      expect(result.find(t => t.name === 'shell_execute')).toBeUndefined()
      expect(result.find(t => t.name === 'shell_spawn')).toBeDefined()
    })
  })

  describe('empty tools', () => {
    it('returns empty for empty tool list', () => {
      const result = applyToolPolicy([], ['*'], [])
      expect(result).toHaveLength(0)
    })
  })

  describe('no mutations', () => {
    it('does not mutate the original tools array', () => {
      const original = [...allTools]
      applyToolPolicy(allTools, ['filesystem.*'], ['shell.*'])
      expect(allTools).toHaveLength(original.length)
    })
  })
})

// ---------------------------------------------------------------------------
// resolvePresetTools
// ---------------------------------------------------------------------------

describe('resolvePresetTools', () => {
  it('returns all built-in tools for "full"', () => {
    expect(resolvePresetTools('full').length).toBe(builtinTools.length)
  })

  it('returns no tools for "none"', () => {
    expect(resolvePresetTools('none')).toHaveLength(0)
  })

  it('returns only read-only tools for "readonly"', () => {
    const readonly = resolvePresetTools('readonly')
    expect(readonly.length).toBeGreaterThan(0)
    expect(readonly.every((t) => t.isReadOnly === true)).toBe(true)
  })

  it('falls back to all built-ins for an unknown preset', () => {
    expect(resolvePresetTools('mystery').length).toBe(builtinTools.length)
  })

  it('falls back to all built-ins for undefined', () => {
    expect(resolvePresetTools(undefined).length).toBe(builtinTools.length)
  })
})

// ---------------------------------------------------------------------------
// countResolvedTools
// ---------------------------------------------------------------------------

describe('countResolvedTools', () => {
  it('returns 0 when preset is "none" (allow does not enable, only filters)', () => {
    // Mirrors assembler semantics: allow filters the preset's base set.
    // With preset "none" the base is empty, so allow has nothing to keep.
    expect(
      countResolvedTools({
        preset: 'none',
        allow: ['readFile', 'listFiles', 'glob', 'grep'],
        deny: [],
        custom: [],
        mcp: {},
      }),
    ).toBe(0)
  })

  it('returns 0 when preset is "none" with no allow list', () => {
    expect(
      countResolvedTools({
        preset: 'none',
        allow: [],
        deny: [],
        custom: [],
        mcp: {},
      }),
    ).toBe(0)
  })

  it('counts the readonly preset (4 read-only filesystem tools)', () => {
    expect(
      countResolvedTools({
        preset: 'readonly',
        allow: [],
        deny: [],
        custom: [],
        mcp: {},
      }),
    ).toBe(4)
  })

  it('narrows the readonly preset via allow', () => {
    expect(
      countResolvedTools({
        preset: 'readonly',
        allow: ['readFile', 'listFiles'],
        deny: [],
        custom: [],
        mcp: {},
      }),
    ).toBe(2)
  })

  it('counts MCP servers and custom tools alongside built-ins', () => {
    expect(
      countResolvedTools({
        preset: 'readonly',
        allow: ['readFile'],
        deny: [],
        custom: [{ name: 'one' }, { name: 'two' }],
        mcp: { github: {}, weather: {} },
      }),
    ).toBe(1 + 2 + 2)
  })

  it('respects deny over allow', () => {
    expect(
      countResolvedTools({
        preset: 'readonly',
        allow: ['readFile', 'glob'],
        deny: ['glob'],
        custom: [],
        mcp: {},
      }),
    ).toBe(1)
  })

  it('counts the full preset when no allow/deny is given', () => {
    expect(
      countResolvedTools({
        preset: 'full',
        allow: [],
        deny: [],
        custom: [],
        mcp: {},
      }),
    ).toBe(builtinTools.length)
  })
})
