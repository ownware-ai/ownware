/**
 * Unit Tests — Profile Loader
 *
 * Tests profile loading from directories with agent.json, SOUL.md, AGENTS.md.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadProfile } from '../../../profile/loader.js'
import { ProfileError } from '../../../profile/types.js'

describe('loadProfile()', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'loom-profile-'))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // JSON config
  // -----------------------------------------------------------------------

  describe('agent.json', () => {
    it('loads profile with all files', async () => {
      await writeFile(join(tmp, 'agent.json'), JSON.stringify({ name: 'test-agent', model: 'anthropic:claude-sonnet-4-20250514' }))
      await writeFile(join(tmp, 'SOUL.md'), 'You are a test agent.')
      await writeFile(join(tmp, 'AGENTS.md'), 'Project uses TypeScript.')
      await mkdir(join(tmp, 'skills'))

      const profile = await loadProfile(tmp)

      expect(profile.config.name).toBe('test-agent')
      expect(profile.config.model).toBe('anthropic:claude-sonnet-4-20250514')
      expect(profile.soulMd).toContain('test agent')
      expect(profile.agentsMd).toContain('TypeScript')
      expect(profile.skillsDir).toBeDefined()
      expect(profile.basePath).toBe(tmp)
    })

    it('loads profile without optional files', async () => {
      await writeFile(join(tmp, 'agent.json'), JSON.stringify({ name: 'minimal' }))

      const profile = await loadProfile(tmp)
      expect(profile.config.name).toBe('minimal')
      expect(profile.soulMd).toBe('')
      expect(profile.agentsMd).toBe('')
      expect(profile.skillsDir).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // YAML config
  // -----------------------------------------------------------------------

  describe('agent.yaml', () => {
    it('loads profile from YAML', async () => {
      await writeFile(join(tmp, 'agent.yaml'), 'name: yaml-agent\nmodel: anthropic:claude-sonnet-4-20250514')

      const profile = await loadProfile(tmp)
      expect(profile.config.name).toBe('yaml-agent')
    })

    it('prefers agent.json over agent.yaml', async () => {
      await writeFile(join(tmp, 'agent.json'), JSON.stringify({ name: 'json-wins' }))
      await writeFile(join(tmp, 'agent.yaml'), 'name: yaml-loses')

      const profile = await loadProfile(tmp)
      expect(profile.config.name).toBe('json-wins')
    })
  })

  // -----------------------------------------------------------------------
  // Error cases
  // -----------------------------------------------------------------------

  describe('errors', () => {
    it('throws when no config file exists', async () => {
      await expect(loadProfile(tmp)).rejects.toThrow(ProfileError)
      await expect(loadProfile(tmp)).rejects.toThrow(/No agent\.json/)
    })

    it('throws for invalid JSON', async () => {
      await writeFile(join(tmp, 'agent.json'), 'not valid json{{{')
      await expect(loadProfile(tmp)).rejects.toThrow(ProfileError)
    })

    it('throws for invalid config (missing name)', async () => {
      await writeFile(join(tmp, 'agent.json'), JSON.stringify({ model: 'test' }))
      await expect(loadProfile(tmp)).rejects.toThrow(ProfileError)
    })
  })

  // -----------------------------------------------------------------------
  // Skills directory detection
  // -----------------------------------------------------------------------

  describe('skills directory', () => {
    it('detects default skills/ subdirectory', async () => {
      await writeFile(join(tmp, 'agent.json'), JSON.stringify({ name: 'x' }))
      await mkdir(join(tmp, 'skills'))

      const profile = await loadProfile(tmp)
      expect(profile.skillsDir).toBe(join(tmp, 'skills'))
    })

    it('returns undefined when no skills dir', async () => {
      await writeFile(join(tmp, 'agent.json'), JSON.stringify({ name: 'x' }))

      const profile = await loadProfile(tmp)
      expect(profile.skillsDir).toBeUndefined()
    })
  })
})
