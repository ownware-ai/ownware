/**
 * Unit tests for ProfileRegistry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ProfileRegistry } from '../../../src/profile/registry.js'
import { ProfileSchema } from '../../../src/profile/schema.js'
import { createTempProfile, PROFILES_ROOT } from '../../helpers/fixtures.js'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// Track temp dirs for cleanup
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

/**
 * Create a temp directory with multiple profile subdirectories.
 */
async function createProfilesDir(profiles: Record<string, Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cortex-registry-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))

  for (const [name, files] of Object.entries(profiles)) {
    const profileDir = join(root, name)
    await mkdir(profileDir, { recursive: true })
    for (const [filename, content] of Object.entries(files)) {
      const filePath = join(profileDir, filename)
      const parentDir = filePath.substring(0, filePath.lastIndexOf('/'))
      await mkdir(parentDir, { recursive: true })
      await writeFile(filePath, content, 'utf-8')
    }
  }

  return root
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('ProfileRegistry: discover', () => {
  it('discovers profiles with agent.json', async () => {
    const root = await createProfilesDir({
      'agent-a': { 'agent.json': JSON.stringify({ name: 'a' }) },
      'agent-b': { 'agent.json': JSON.stringify({ name: 'b' }) },
    })

    const registry = new ProfileRegistry()
    await registry.discover(root)

    expect(registry.size).toBe(2)
    expect(registry.has('agent-a')).toBe(true)
    expect(registry.has('agent-b')).toBe(true)
  })

  it('discovers profiles with agent.yaml', async () => {
    const root = await createProfilesDir({
      'yaml-profile': { 'agent.yaml': 'name: yaml-test' },
    })

    const registry = new ProfileRegistry()
    await registry.discover(root)
    expect(registry.has('yaml-profile')).toBe(true)
  })

  it('ignores directories without agent.json/yaml', async () => {
    const root = await createProfilesDir({
      'has-config': { 'agent.json': JSON.stringify({ name: 'valid' }) },
      'no-config': { 'SOUL.md': '# Just a soul' },
    })

    const registry = new ProfileRegistry()
    await registry.discover(root)
    expect(registry.size).toBe(1)
    expect(registry.has('has-config')).toBe(true)
    expect(registry.has('no-config')).toBe(false)
  })

  it('ignores directories starting with _', async () => {
    const root = await createProfilesDir({
      'valid': { 'agent.json': JSON.stringify({ name: 'valid' }) },
      '_hidden': { 'agent.json': JSON.stringify({ name: 'hidden' }) },
    })

    const registry = new ProfileRegistry()
    await registry.discover(root)
    expect(registry.size).toBe(1)
    expect(registry.has('_hidden')).toBe(false)
  })

  it('ignores directories starting with .', async () => {
    const root = await createProfilesDir({
      'valid': { 'agent.json': JSON.stringify({ name: 'valid' }) },
      '.hidden': { 'agent.json': JSON.stringify({ name: 'dotfile' }) },
    })

    const registry = new ProfileRegistry()
    await registry.discover(root)
    expect(registry.has('.hidden')).toBe(false)
  })

  it('silently skips nonexistent directory', async () => {
    const registry = new ProfileRegistry()
    await registry.discover('/nonexistent/path')
    expect(registry.size).toBe(0)
  })

  it('merges multiple discover calls (later wins)', async () => {
    const root1 = await createProfilesDir({
      'shared': { 'agent.json': JSON.stringify({ name: 'from-root1', description: 'first' }) },
      'only-in-1': { 'agent.json': JSON.stringify({ name: 'unique1' }) },
    })
    const root2 = await createProfilesDir({
      'shared': { 'agent.json': JSON.stringify({ name: 'from-root2', description: 'second' }) },
      'only-in-2': { 'agent.json': JSON.stringify({ name: 'unique2' }) },
    })

    const registry = new ProfileRegistry()
    await registry.discover(root1)
    await registry.discover(root2)

    expect(registry.size).toBe(3) // shared + only-in-1 + only-in-2

    // "shared" should come from root2 (later wins)
    const profile = await registry.get('shared')
    expect(profile.config.description).toBe('second')
  })

  it('reads quick metadata (description, tags)', async () => {
    const root = await createProfilesDir({
      'described': {
        'agent.json': JSON.stringify({
          name: 'described',
          description: 'A described profile',
          tags: ['test', 'meta'],
        }),
      },
    })

    const registry = new ProfileRegistry()
    await registry.discover(root)

    const list = registry.list()
    const entry = list.find(p => p.name === 'described')
    expect(entry).toBeDefined()
    expect(entry!.description).toBe('A described profile')
    expect(entry!.tags).toEqual(['test', 'meta'])
  })
})

// ---------------------------------------------------------------------------
// get() — lazy loading
// ---------------------------------------------------------------------------

describe('ProfileRegistry: get', () => {
  it('lazy-loads profile on first get()', async () => {
    const root = await createProfilesDir({
      'lazy': {
        'agent.json': JSON.stringify({ name: 'lazy-agent' }),
        'SOUL.md': '# Lazy Soul',
      },
    })

    const registry = new ProfileRegistry()
    await registry.discover(root)

    const profile = await registry.get('lazy')
    expect(profile.config.name).toBe('lazy-agent')
    expect(profile.soulMd).toContain('Lazy Soul')
  })

  it('returns cached profile on second get()', async () => {
    const root = await createProfilesDir({
      'cached': {
        'agent.json': JSON.stringify({ name: 'cached' }),
      },
    })

    const registry = new ProfileRegistry()
    await registry.discover(root)

    const first = await registry.get('cached')
    const second = await registry.get('cached')
    expect(first).toBe(second) // Same object reference
  })

  it('throws on unknown profile name', async () => {
    const registry = new ProfileRegistry()
    await expect(registry.get('nonexistent')).rejects.toThrow('not found')
  })

  it('error message lists available profiles', async () => {
    const root = await createProfilesDir({
      'alpha': { 'agent.json': JSON.stringify({ name: 'alpha' }) },
      'beta': { 'agent.json': JSON.stringify({ name: 'beta' }) },
    })

    const registry = new ProfileRegistry()
    await registry.discover(root)

    try {
      await registry.get('gamma')
      expect.fail('should throw')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('alpha')
      expect(msg).toContain('beta')
    }
  })
})

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe('ProfileRegistry: list', () => {
  it('returns all registered profiles', async () => {
    const root = await createProfilesDir({
      'a': { 'agent.json': JSON.stringify({ name: 'a' }) },
      'b': { 'agent.json': JSON.stringify({ name: 'b' }) },
    })

    const registry = new ProfileRegistry()
    await registry.discover(root)

    const list = registry.list()
    expect(list).toHaveLength(2)
    expect(list.map(p => p.name).sort()).toEqual(['a', 'b'])
  })

  it('includes path in list entries', async () => {
    const root = await createProfilesDir({
      'test': { 'agent.json': JSON.stringify({ name: 'test' }) },
    })

    const registry = new ProfileRegistry()
    await registry.discover(root)

    const list = registry.list()
    expect(list[0]!.path).toContain('test')
  })

  it('returns empty for fresh registry', () => {
    const registry = new ProfileRegistry()
    expect(registry.list()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// reload()
// ---------------------------------------------------------------------------

describe('ProfileRegistry: reload', () => {
  it('re-loads profile from disk', async () => {
    const root = await createProfilesDir({
      'mutable': {
        'agent.json': JSON.stringify({ name: 'version-1' }),
      },
    })

    const registry = new ProfileRegistry()
    await registry.discover(root)

    const first = await registry.get('mutable')
    expect(first.config.name).toBe('version-1')

    // Modify file on disk
    const { writeFile: wf } = await import('fs/promises')
    await wf(join(root, 'mutable', 'agent.json'), JSON.stringify({ name: 'version-2' }))

    const reloaded = await registry.reload('mutable')
    expect(reloaded.config.name).toBe('version-2')
  })

  it('throws on unknown profile', async () => {
    const registry = new ProfileRegistry()
    await expect(registry.reload('nonexistent')).rejects.toThrow('not found')
  })
})

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

describe('ProfileRegistry: register', () => {
  it('registers a config programmatically', () => {
    const registry = new ProfileRegistry()
    const config = ProfileSchema.parse({ name: 'programmatic' })

    registry.register('prog', config)
    expect(registry.has('prog')).toBe(true)
    expect(registry.size).toBe(1)
  })

  it('get() returns registered config without disk I/O', async () => {
    const registry = new ProfileRegistry()
    const config = ProfileSchema.parse({ name: 'in-memory', description: 'No disk' })

    registry.register('mem', config)
    const profile = await registry.get('mem')
    expect(profile.config.name).toBe('in-memory')
    expect(profile.config.description).toBe('No disk')
  })

  it('overrides existing entry', async () => {
    const root = await createProfilesDir({
      'overridden': { 'agent.json': JSON.stringify({ name: 'from-disk' }) },
    })

    const registry = new ProfileRegistry()
    await registry.discover(root)

    const config = ProfileSchema.parse({ name: 'from-code' })
    registry.register('overridden', config)

    const profile = await registry.get('overridden')
    expect(profile.config.name).toBe('from-code')
  })
})

// ---------------------------------------------------------------------------
// has() / size / clear()
// ---------------------------------------------------------------------------

describe('ProfileRegistry: utility methods', () => {
  it('has() returns false for unknown name', () => {
    expect(new ProfileRegistry().has('x')).toBe(false)
  })

  it('size returns count', async () => {
    const root = await createProfilesDir({
      'a': { 'agent.json': JSON.stringify({ name: 'a' }) },
      'b': { 'agent.json': JSON.stringify({ name: 'b' }) },
    })

    const registry = new ProfileRegistry()
    await registry.discover(root)
    expect(registry.size).toBe(2)
  })

  it('clear() removes everything', async () => {
    const root = await createProfilesDir({
      'a': { 'agent.json': JSON.stringify({ name: 'a' }) },
    })

    const registry = new ProfileRegistry()
    await registry.discover(root)
    expect(registry.size).toBe(1)

    registry.clear()
    expect(registry.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Example profiles directory
// ---------------------------------------------------------------------------

describe('ProfileRegistry: real profiles', () => {
  it('discovers shipping profiles from packages/cortex/profiles', async () => {
    // The example profile was removed from the shipping `profiles/`
    // directory. It still lives at tests/fixtures/example-
    // profile/ for fixture use. The shipping directory is asserted
    // here via the always-present `ownware` profile.
    const registry = new ProfileRegistry()
    await registry.discover(PROFILES_ROOT)

    expect(registry.has('ownware')).toBe(true)
    const profile = await registry.get('ownware')
    // Registry ids key off the folder name (`ownware`); `config.name` is
    // the profile's persona display name from agent.json.
    expect(profile.config.name).toBe('Ari')
  })
})
