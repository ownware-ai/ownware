/**
 * Unit Tests — SkillRegistry
 *
 * Tests registration, lookup, listing, and removal of skills.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SkillRegistry } from '../../../skills/registry.js'
import type { SkillDefinition } from '../../../skills/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const commitSkill: SkillDefinition = {
  name: 'commit',
  description: 'Create a git commit',
  trigger: '/commit',
  content: 'Help the user create a commit...',
}

const reviewSkill: SkillDefinition = {
  name: 'review-pr',
  description: 'Review a pull request',
  trigger: /\/review-pr\s+\d+/,
  content: 'Review the pull request...',
  allowedTools: ['read_file', 'grep'],
}

const testSkill: SkillDefinition = {
  name: 'test',
  description: 'Run tests',
  trigger: '/test',
  content: 'Run the test suite...',
}

describe('SkillRegistry', () => {
  let registry: SkillRegistry

  beforeEach(() => {
    registry = new SkillRegistry()
  })

  // -----------------------------------------------------------------------
  // Initial state
  // -----------------------------------------------------------------------

  describe('initial state', () => {
    it('starts empty', () => {
      expect(registry.size).toBe(0)
      expect(registry.list()).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // register()
  // -----------------------------------------------------------------------

  describe('register()', () => {
    it('adds a skill', () => {
      registry.register(commitSkill)
      expect(registry.size).toBe(1)
      expect(registry.has('commit')).toBe(true)
    })

    it('returns this for chaining', () => {
      const result = registry.register(commitSkill)
      expect(result).toBe(registry)
    })

    it('overwrites existing skill with same name', () => {
      const updated = { ...commitSkill, description: 'Updated description' }
      registry.register(commitSkill)
      registry.register(updated)
      expect(registry.size).toBe(1)
      expect(registry.get('commit')?.description).toBe('Updated description')
    })
  })

  // -----------------------------------------------------------------------
  // registerAll()
  // -----------------------------------------------------------------------

  describe('registerAll()', () => {
    it('registers multiple skills at once', () => {
      registry.registerAll([commitSkill, reviewSkill, testSkill])
      expect(registry.size).toBe(3)
    })

    it('returns this for chaining', () => {
      const result = registry.registerAll([commitSkill])
      expect(result).toBe(registry)
    })
  })

  // -----------------------------------------------------------------------
  // get()
  // -----------------------------------------------------------------------

  describe('get()', () => {
    it('returns skill by name', () => {
      registry.register(commitSkill)
      const skill = registry.get('commit')
      expect(skill).toBeDefined()
      expect(skill?.name).toBe('commit')
      expect(skill?.description).toBe('Create a git commit')
    })

    it('returns undefined for unknown name', () => {
      expect(registry.get('nonexistent')).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // has()
  // -----------------------------------------------------------------------

  describe('has()', () => {
    it('returns true for registered skill', () => {
      registry.register(commitSkill)
      expect(registry.has('commit')).toBe(true)
    })

    it('returns false for unregistered skill', () => {
      expect(registry.has('commit')).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // list()
  // -----------------------------------------------------------------------

  describe('list()', () => {
    it('returns all registered skills', () => {
      registry.registerAll([commitSkill, reviewSkill])
      const skills = registry.list()
      expect(skills).toHaveLength(2)
      expect(skills.map(s => s.name).sort()).toEqual(['commit', 'review-pr'])
    })

    it('returns new array each time', () => {
      registry.register(commitSkill)
      const first = registry.list()
      const second = registry.list()
      expect(first).not.toBe(second)
      expect(first).toEqual(second)
    })
  })

  // -----------------------------------------------------------------------
  // remove()
  // -----------------------------------------------------------------------

  describe('remove()', () => {
    it('removes a registered skill', () => {
      registry.register(commitSkill)
      const result = registry.remove('commit')
      expect(result).toBe(true)
      expect(registry.has('commit')).toBe(false)
      expect(registry.size).toBe(0)
    })

    it('returns false for unknown skill', () => {
      expect(registry.remove('nonexistent')).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // clear()
  // -----------------------------------------------------------------------

  describe('clear()', () => {
    it('removes all skills', () => {
      registry.registerAll([commitSkill, reviewSkill, testSkill])
      registry.clear()
      expect(registry.size).toBe(0)
      expect(registry.list()).toEqual([])
    })
  })
})
