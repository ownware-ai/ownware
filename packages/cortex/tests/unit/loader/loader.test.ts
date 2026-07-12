/**
 * Unit tests for profile loader.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProfile } from '../../../src/profile/loader.js'
import {
  createTempProfile,
  createMinimalProfile,
  createYamlProfile,
  createProfileWithSkills,
  createProfileWithNestedSkills,
  createProfileWithDisabledSkill,
  createProfileWithMCP,
  EXAMPLE_PROFILE_DIR,
} from '../../helpers/fixtures.js'

// Track temp profiles for cleanup
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

function track<T extends { cleanup: () => Promise<void> }>(p: T): T {
  cleanups.push(p.cleanup)
  return p
}

// ---------------------------------------------------------------------------
// Config file detection
// ---------------------------------------------------------------------------

describe('loadProfile: config file detection', () => {
  it('loads agent.json', async () => {
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    expect(profile.config.name).toBe('test-agent')
  })

  it('loads agent.yaml', async () => {
    const { dir } = track(await createYamlProfile(
      'name: yaml-agent\ndescription: Configured via YAML',
    ))
    const profile = await loadProfile(dir)
    expect(profile.config.name).toBe('yaml-agent')
    expect(profile.config.description).toBe('Configured via YAML')
  })

  it('prefers agent.json over agent.yaml', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'json-wins' }),
      'agent.yaml': 'name: yaml-loses',
    }))
    const profile = await loadProfile(dir)
    expect(profile.config.name).toBe('json-wins')
  })

  it('supports agent.yml extension', async () => {
    const { dir } = track(await createTempProfile({
      'agent.yml': 'name: yml-agent',
    }))
    const profile = await loadProfile(dir)
    expect(profile.config.name).toBe('yml-agent')
  })

  it('throws on missing config file', async () => {
    const { dir } = track(await createTempProfile({
      'SOUL.md': '# No config',
    }))
    await expect(loadProfile(dir)).rejects.toThrow('No agent.json')
  })

  it('throws on invalid JSON', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': '{ invalid json }',
    }))
    await expect(loadProfile(dir)).rejects.toThrow('Invalid JSON')
  })

  it('throws on invalid YAML', async () => {
    const { dir } = track(await createTempProfile({
      'agent.yaml': ':\n  :\n    :\n      : [[[',
    }))
    await expect(loadProfile(dir)).rejects.toThrow()
  })

  it('throws on nonexistent directory', async () => {
    await expect(loadProfile('/nonexistent/dir')).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('loadProfile: schema validation', () => {
  it('throws on empty name', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: '' }),
    }))
    await expect(loadProfile(dir)).rejects.toThrow('Invalid profile config')
  })

  it('throws on invalid temperature', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test', temperature: 10 }),
    }))
    await expect(loadProfile(dir)).rejects.toThrow('Invalid profile config')
  })

  it('includes field path in error message', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test', tools: { preset: 'invalid' } }),
    }))
    try {
      await loadProfile(dir)
      expect.fail('should have thrown')
    } catch (e) {
      expect((e as Error).message).toContain('tools.preset')
    }
  })
})

// ---------------------------------------------------------------------------
// SOUL.md + AGENTS.md loading
// ---------------------------------------------------------------------------

describe('loadProfile: auxiliary files', () => {
  it('loads SOUL.md', async () => {
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    expect(profile.soulMd).toContain('Test Agent')
  })

  it('soulMd is null when SOUL.md missing', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'no-soul' }),
    }))
    const profile = await loadProfile(dir)
    expect(profile.soulMd).toBeNull()
  })

  it('loads AGENTS.md', async () => {
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    expect(profile.agentsMd).toContain('Test memory')
  })

  it('agentsMd is null when AGENTS.md missing', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'no-memory' }),
    }))
    const profile = await loadProfile(dir)
    expect(profile.agentsMd).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Skills loading
// ---------------------------------------------------------------------------

describe('loadProfile: skills', () => {
  it('discovers skills from skills/ directory', async () => {
    const { dir } = track(await createProfileWithSkills())
    const profile = await loadProfile(dir)
    expect(profile.skills).toHaveLength(2)
  })

  it('parses skill frontmatter', async () => {
    const { dir } = track(await createProfileWithSkills())
    const profile = await loadProfile(dir)

    const commitSkill = profile.skills.find(s => s.name === 'commit')
    expect(commitSkill).toBeDefined()
    expect(commitSkill!.description).toBe('Create a git commit')
    expect(commitSkill!.trigger).toBe('/commit')
    expect(commitSkill!.content).toContain('well-formatted git commit')
  })

  it('returns empty skills when no skills/ dir', async () => {
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    expect(profile.skills).toEqual([])
  })

  it('discovers nested skills (skills/<slug>/SKILL.md layout)', async () => {
    const { dir } = track(await createProfileWithNestedSkills())
    const profile = await loadProfile(dir)
    expect(profile.skills).toHaveLength(2)
    const names = profile.skills.map(s => s.name).sort()
    expect(names).toEqual(['competitive-research', 'tax-planning'])
  })

  it('parses frontmatter from nested SKILL.md', async () => {
    const { dir } = track(await createProfileWithNestedSkills())
    const profile = await loadProfile(dir)
    const swot = profile.skills.find(s => s.name === 'competitive-research')
    expect(swot).toBeDefined()
    expect(swot!.description).toBe('Run a structured competitor SWOT')
    expect(swot!.trigger).toBe('/competitive-research')
    expect(swot!.content).toContain('Body of the skill')
  })

  it('marks disabled skills with active=false but still loads them', async () => {
    const { dir } = track(await createProfileWithDisabledSkill())
    const profile = await loadProfile(dir)
    expect(profile.skills).toHaveLength(2)
    const active = profile.skills.find(s => s.name === 'active-one')
    const disabled = profile.skills.find(s => s.name === 'disabled-one')
    expect(active?.active).toBe(true)
    expect(disabled?.active).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Custom tool path validation
// ---------------------------------------------------------------------------

describe('loadProfile: custom tool paths', () => {
  it('throws on missing custom tool file', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'test',
        tools: { custom: [{ path: 'tools/missing.ts' }] },
      }),
    }))
    await expect(loadProfile(dir)).rejects.toThrow('not found')
  })

  it('accepts existing custom tool file', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'test',
        tools: { custom: [{ path: 'tools/search.js' }] },
      }),
      'tools/search.js': 'export const tool = { name: "search" }',
    }))
    // Should not throw for file existence check
    const profile = await loadProfile(dir)
    expect(profile.config.tools.custom).toHaveLength(1)
  })

  it('rejects an existing absolute custom-tool reference outside the profile', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ownware-loader-outside-'))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    const outsideTool = join(outside, 'outside.js')
    await writeFile(outsideTool, 'export const outside = true')
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'test',
        tools: { custom: [{ path: outsideTool }] },
      }),
    }))

    await expect(loadProfile(dir)).rejects.toThrow(/inside the profile directory|relative/i)
  })

  it('rejects a custom-tool symlink whose real target is outside the profile', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ownware-loader-outside-'))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    const outsideTool = join(outside, 'outside.js')
    await writeFile(outsideTool, 'export const outside = true')
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'test',
        tools: { custom: [{ path: 'tools/escape.js' }] },
      }),
    }))
    await mkdir(join(dir, 'tools'), { recursive: true })
    await symlink(outsideTool, join(dir, 'tools/escape.js'))

    await expect(loadProfile(dir)).rejects.toThrow(/inside the profile directory|symlink/i)
  })
})

describe('loadProfile: skill directory containment', () => {
  it('rejects an absolute skill directory outside the profile', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ownware-skills-outside-'))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    await writeFile(join(outside, 'outside.md'), '---\nname: outside\n---\nprivate')
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test', skills: { dirs: [outside] } }),
    }))

    await expect(loadProfile(dir)).rejects.toThrow(/inside the profile directory|relative/i)
  })

  it('rejects a skill directory symlink whose real target is outside', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ownware-skills-outside-'))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    await writeFile(join(outside, 'outside.md'), '---\nname: outside\n---\nprivate')
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'test', skills: { dirs: ['skills'] } }),
    }))
    await symlink(outside, join(dir, 'skills'))

    await expect(loadProfile(dir)).rejects.toThrow(/inside the profile directory|symlink/i)
  })
})

// ---------------------------------------------------------------------------
// MCP env var validation
// ---------------------------------------------------------------------------

describe('loadProfile: MCP env vars', () => {
  it('passes when env var is set', async () => {
    process.env['OWNWARE_TEST_MCP_KEY'] = 'test-value'
    const { dir } = track(await createProfileWithMCP('OWNWARE_TEST_MCP_KEY'))
    const profile = await loadProfile(dir)
    expect(profile.config.tools.mcp['test-server']).toBeDefined()
    delete process.env['OWNWARE_TEST_MCP_KEY']
  })

  it('does NOT throw when an MCP env var is missing — defers to assembler', async () => {
    // 2026-04-11 audit fix (Hazard 1 / finding 31): a single missing
    // MCP credential must NOT take down the entire profile load. The
    // resolution moved to the assembler, which skips that one server
    // and lets the rest of the profile run. This test locks the
    // behavior change so we don't regress to the old throw-on-load.
    delete process.env['MISSING_MCP_KEY_XYZ']
    const { dir } = track(await createProfileWithMCP('MISSING_MCP_KEY_XYZ'))
    const profile = await loadProfile(dir)
    // The MCP entry is preserved on the parsed config — resolution is
    // deferred. The assembler is what decides which servers to spawn.
    expect(profile.config.tools.mcp['test-server']).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Timeout parsing
// ---------------------------------------------------------------------------

describe('loadProfile: timeout', () => {
  it('parses default 30m timeout', async () => {
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    expect(profile.timeoutMs).toBe(1_800_000)
  })

  it('parses custom timeout', async () => {
    const { dir } = track(await createMinimalProfile({
      execution: { timeout: '5m' },
    }))
    const profile = await loadProfile(dir)
    expect(profile.timeoutMs).toBe(300_000)
  })
})

// ---------------------------------------------------------------------------
// basePath
// ---------------------------------------------------------------------------

describe('loadProfile: basePath', () => {
  it('returns absolute path', async () => {
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    expect(profile.basePath).toBe(dir)
    expect(profile.basePath.startsWith('/')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Example profile
// ---------------------------------------------------------------------------

describe('loadProfile: example profile', () => {
  it('loads the example profile successfully', async () => {
    const profile = await loadProfile(EXAMPLE_PROFILE_DIR)

    // Asserted values mirror tests/fixtures/example-profile/agent.json
    // verbatim. The fixture is the source of truth — when changing
    // these expectations, change the fixture first.
    expect(profile.config.name).toBe('example')
    expect(profile.config.model).toBe('anthropic:claude-sonnet-4-20250514')
    expect(profile.config.tools.preset).toBe('full')
    expect(profile.config.tools.deny).toContain('shell_execute')
    expect(profile.soulMd).toContain('Example Agent')
    expect(profile.agentsMd).toContain('Memory')
    expect(profile.basePath).toBe(EXAMPLE_PROFILE_DIR)
  })
})
