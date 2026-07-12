/**
 * OwnwareBundle service tests — uses temp fixture dirs as the bundle.
 * No real bundled profiles, no network, real filesystem.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OwnwareBundle,
  readBuiltinsManifest,
  readMarketplaceSkipSet,
} from '../../../src/profile/ownware-bundle.js'
import { recoverInterruptedProfileUpdates } from '../../../src/profile/update/index.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(async () => {
    try { await rm(dir, { recursive: true, force: true }) } catch { /* */ }
  })
  return dir
}

async function makeBundle(opts: {
  core: readonly string[]
  marketplace: readonly string[]
  profiles?: Record<string, Record<string, string>>
}): Promise<{ bundleDir: string; userDir: string }> {
  const root = await makeTempDir('cortex-bundle-')
  const bundleDir = join(root, 'bundle')
  const userDir = join(root, 'user')
  await mkdir(bundleDir, { recursive: true })
  await mkdir(userDir, { recursive: true })

  const manifest = { core: opts.core, marketplace: opts.marketplace }
  await writeFile(join(bundleDir, 'BUILTINS.json'), JSON.stringify(manifest, null, 2))

  const allProfiles = [...opts.core, ...opts.marketplace]
  for (const name of allProfiles) {
    const profileDir = join(bundleDir, name)
    await mkdir(profileDir, { recursive: true })
    const files = opts.profiles?.[name] ?? { 'agent.json': JSON.stringify({ name }) }
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(profileDir, rel)
      await mkdir(join(abs, '..'), { recursive: true })
      await writeFile(abs, content)
    }
  }

  return { bundleDir, userDir }
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

// ---------------------------------------------------------------------------
// readBuiltinsManifest / readMarketplaceSkipSet
// ---------------------------------------------------------------------------

describe('readBuiltinsManifest', () => {
  it('parses a valid manifest', async () => {
    const { bundleDir } = await makeBundle({
      core: ['default', 'coder'],
      marketplace: ['finance-analyst'],
    })
    const got = await readBuiltinsManifest(bundleDir)
    expect(got).not.toBeNull()
    expect(got!.core).toEqual(['default', 'coder'])
    expect(got!.marketplace).toEqual(['finance-analyst'])
  })

  it('returns null when file is missing', async () => {
    const dir = await makeTempDir('cortex-no-manifest-')
    expect(await readBuiltinsManifest(dir)).toBeNull()
  })

  it('returns null on malformed JSON', async () => {
    const dir = await makeTempDir('cortex-bad-')
    await writeFile(join(dir, 'BUILTINS.json'), '{ not valid')
    expect(await readBuiltinsManifest(dir)).toBeNull()
  })

  it('passes through unknown top-level fields (passthrough)', async () => {
    const dir = await makeTempDir('cortex-extra-')
    await writeFile(join(dir, 'BUILTINS.json'), JSON.stringify({
      core: ['x'], marketplace: [], comment: 'whatever',
    }))
    const got = await readBuiltinsManifest(dir)
    expect(got).not.toBeNull()
  })
})

describe('readMarketplaceSkipSet', () => {
  it('returns the marketplace names as a Set', async () => {
    const { bundleDir } = await makeBundle({
      core: ['a'],
      marketplace: ['x', 'y', 'z'],
    })
    const set = await readMarketplaceSkipSet(bundleDir)
    expect(set.has('x')).toBe(true)
    expect(set.has('y')).toBe(true)
    expect(set.has('a')).toBe(false)
  })

  it('returns empty when no manifest', async () => {
    const dir = await makeTempDir('cortex-no-')
    expect(await readMarketplaceSkipSet(dir)).toEqual(new Set())
  })
})

// ---------------------------------------------------------------------------
// OwnwareBundle.list
// ---------------------------------------------------------------------------

describe('OwnwareBundle.list', () => {
  it('returns one entry per marketplace profile, with installed: false initially', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: ['default'],
      marketplace: ['finance-analyst', 'legal-analyst'],
    })
    const bundle = new OwnwareBundle({ bundleDir, userDir, bundleVersion: 'abc' })
    const entries = await bundle.list()
    expect(entries).toHaveLength(2)
    const fa = entries.find((e) => e.name === 'finance-analyst')!
    expect(fa.installed).toBe(false)
    expect(fa.hasUpdate).toBe(false)
    expect(fa.bundleVersion).toBe('abc')
  })

  it('returns empty when no manifest is present', async () => {
    const root = await makeTempDir('cortex-empty-')
    const bundleDir = join(root, 'bundle')
    const userDir = join(root, 'user')
    await mkdir(bundleDir, { recursive: true })
    await mkdir(userDir, { recursive: true })
    const bundle = new OwnwareBundle({ bundleDir, userDir })
    expect(await bundle.list()).toEqual([])
  })

  it('skips broken bundle entries instead of crashing', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: [],
      marketplace: ['good'],
      profiles: { 'good': { 'agent.json': JSON.stringify({ name: 'good' }) } },
    })
    // Add a marketplace entry to manifest that doesn't exist on disk.
    await writeFile(join(bundleDir, 'BUILTINS.json'), JSON.stringify({
      core: [], marketplace: ['good', 'missing'],
    }))
    const bundle = new OwnwareBundle({ bundleDir, userDir })
    const entries = await bundle.list()
    expect(entries.map((e) => e.name)).toEqual(['good'])
  })
})

// ---------------------------------------------------------------------------
// OwnwareBundle.install / update / uninstall lifecycle
// ---------------------------------------------------------------------------

describe('OwnwareBundle.install', () => {
  it('removes a placed target when sidecar creation fails', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: [],
      marketplace: ['x'],
      profiles: { 'x': {
        'agent.json': JSON.stringify({ name: 'x' }),
        '.ownware-origin.json/blocker': 'reserved',
      } },
    })
    const bundle = new OwnwareBundle({ bundleDir, userDir })

    await expect(bundle.install('x')).rejects.toBeDefined()
    expect(await fileExists(join(userDir, 'x'))).toBe(false)
  })

  it('copies the profile to user dir + writes a ownware-marketplace sidecar', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: [],
      marketplace: ['finance-analyst'],
      profiles: {
        'finance-analyst': {
          'agent.json': JSON.stringify({ name: 'finance-analyst' }),
          'SOUL.md': '# v1',
        },
      },
    })
    const bundle = new OwnwareBundle({ bundleDir, userDir, bundleVersion: 'v1', bundledFrom: 'ownware-profiles' })
    const result = await bundle.install('finance-analyst')

    expect(await fileExists(join(userDir, 'finance-analyst', 'agent.json'))).toBe(true)
    expect(await fileExists(join(userDir, 'finance-analyst', 'SOUL.md'))).toBe(true)

    const sidecarRaw = await readFile(join(userDir, 'finance-analyst', '.ownware-origin.json'), 'utf-8')
    const sidecar = JSON.parse(sidecarRaw)
    expect(sidecar.kind).toBe('ownware-marketplace')
    expect(sidecar.profileName).toBe('finance-analyst')
    expect(sidecar.bundleVersion).toBe('v1')
    expect(sidecar.bundledFrom).toBe('ownware-profiles')
    expect(typeof sidecar.installedHash).toBe('string')
    expect(result.sidecar.kind).toBe('ownware-marketplace')
  })

  it('rejects unknown names with a clear message', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: ['default'], marketplace: ['x'],
    })
    const bundle = new OwnwareBundle({ bundleDir, userDir })
    await expect(bundle.install('not-listed')).rejects.toThrow(/not a Ownware marketplace bundle entry/)
  })

  it('refuses to install a name that is in core (not marketplace)', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: ['default'], marketplace: ['x'],
    })
    const bundle = new OwnwareBundle({ bundleDir, userDir })
    await expect(bundle.install('default')).rejects.toThrow(/not a Ownware marketplace bundle entry/)
  })

  it('rejects a second install at the same name (collision)', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: [], marketplace: ['x'],
    })
    const bundle = new OwnwareBundle({ bundleDir, userDir })
    await bundle.install('x')
    await expect(bundle.install('x')).rejects.toThrow(/already installed/)
  })
})

describe('OwnwareBundle.update', () => {
  it('restores a bundle backup after a simulated process restart', async () => {
    const { bundleDir } = await makeBundle({
      core: [], marketplace: ['x'],
      profiles: { 'x': {
        'agent.json': JSON.stringify({ name: 'x' }),
        'SOUL.md': '# v1',
      } },
    })
    const dataDir = await makeTempDir('cortex-data-')
    const userDir = join(dataDir, 'profiles')
    await mkdir(userDir, { recursive: true })
    const bundle = new OwnwareBundle({ bundleDir, userDir, bundleVersion: 'v1' })
    await bundle.install('x')
    await (await import('node:fs/promises')).rename(join(userDir, 'x'), join(userDir, 'x.bak-123'))

    expect(await recoverInterruptedProfileUpdates(dataDir))
      .toEqual({ restored: 1, finalized: 0 })
    expect(await readFile(join(userDir, 'x', 'SOUL.md'), 'utf-8')).toBe('# v1')
    expect(await fileExists(join(userDir, 'x.bak-123'))).toBe(false)
  })

  it('replaces the installed dir with a fresh bundle copy', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: [], marketplace: ['x'],
      profiles: { 'x': {
        'agent.json': JSON.stringify({ name: 'x' }),
        'SOUL.md': '# v1',
      } },
    })
    const bundle = new OwnwareBundle({ bundleDir, userDir, bundleVersion: 'v1' })
    await bundle.install('x')
    expect(await readFile(join(userDir, 'x', 'SOUL.md'), 'utf-8')).toBe('# v1')

    // Mutate the bundle (simulate a Cortex release with new content)
    await writeFile(join(bundleDir, 'x', 'SOUL.md'), '# v2')
    const bundle2 = new OwnwareBundle({ bundleDir, userDir, bundleVersion: 'v2' })
    await bundle2.update('x')
    expect(await readFile(join(userDir, 'x', 'SOUL.md'), 'utf-8')).toBe('# v2')
    const sidecar = JSON.parse(await readFile(join(userDir, 'x', '.ownware-origin.json'), 'utf-8'))
    expect(sidecar.bundleVersion).toBe('v2')
  })

  it('rolls back when the fresh install fails', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: [], marketplace: ['x'],
      profiles: { 'x': {
        'agent.json': JSON.stringify({ name: 'x' }),
        'SOUL.md': '# v1',
      } },
    })
    const bundle = new OwnwareBundle({ bundleDir, userDir, bundleVersion: 'v1' })
    await bundle.install('x')

    // Break the bundle (remove agent.json) so loadProfile throws.
    await rm(join(bundleDir, 'x', 'agent.json'))
    await expect(bundle.update('x')).rejects.toThrow()

    // Old version restored from backup.
    expect(await readFile(join(userDir, 'x', 'SOUL.md'), 'utf-8')).toBe('# v1')
  })
})

describe('OwnwareBundle.uninstall', () => {
  it('removes the installed dir', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: [], marketplace: ['x'],
    })
    const bundle = new OwnwareBundle({ bundleDir, userDir })
    await bundle.install('x')
    expect(await fileExists(join(userDir, 'x'))).toBe(true)

    const result = await bundle.uninstall('x')
    expect(result.removed).toBe(true)
    expect(await fileExists(join(userDir, 'x'))).toBe(false)
  })

  it('returns removed:false when not installed', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: [], marketplace: ['x'],
    })
    const bundle = new OwnwareBundle({ bundleDir, userDir })
    expect(await bundle.uninstall('x')).toEqual({ removed: false })
  })

  it('refuses to uninstall a dir whose sidecar is not ownware-marketplace', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: [], marketplace: ['x'],
    })
    // Place a dir at user/x with NO sidecar (or a different one).
    await mkdir(join(userDir, 'x'), { recursive: true })
    await writeFile(join(userDir, 'x', 'agent.json'), '{"name":"x"}')

    const bundle = new OwnwareBundle({ bundleDir, userDir })
    await expect(bundle.uninstall('x')).rejects.toThrow(/no Ownware marketplace sidecar/)
  })
})

// ---------------------------------------------------------------------------
// OwnwareBundle.detail
// ---------------------------------------------------------------------------

describe('OwnwareBundle.detail', () => {
  it('returns the rich detail payload for a marketplace entry', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: [],
      marketplace: ['finance'],
      profiles: {
        'finance': {
          'agent.json': JSON.stringify({
            name: 'finance',
            kind: 'agent',
            description: 'Finance analyst',
            version: '1.2.3',
            tags: ['finance'],
            metadata: { category: 'Finance' },
            model: 'anthropic:claude-sonnet-4-6',
            smallFastModel: 'anthropic:claude-haiku-4-5',
            tools: { preset: 'coding' },
            security: { level: 'standard', permissionMode: 'ask' },
            subagents: [{ name: 'helper-a', description: 'helper-a desc' }],
          }),
          'SOUL.md': '# Finance\n\nYou are a finance analyst.\nCite every number.',
          'AGENTS.md': '# memory seed',
        },
      },
    })
    const bundle = new OwnwareBundle({ bundleDir, userDir, bundleVersion: 'v1' })
    const detail = await bundle.detail('finance')

    expect(detail.name).toBe('finance')
    expect(detail.description).toBe('Finance analyst')
    expect(detail.version).toBe('1.2.3')
    expect(detail.bundleVersion).toBe('v1')
    expect(detail.installed).toBe(false)
    expect(detail.soulMd).toContain('Cite every number')
    expect(detail.agentsMd).toContain('memory seed')
    expect(detail.model).toBe('anthropic:claude-sonnet-4-6')
    expect(detail.smallFastModel).toBe('anthropic:claude-haiku-4-5')
    expect(detail.toolPreset).toBe('coding')
    expect(detail.securityLevel).toBe('standard')
    expect(detail.permissionMode).toBe('ask')
    expect(detail.subagents).toHaveLength(1)
    expect(detail.subagents[0]?.name).toBe('helper-a')
    expect(detail.capabilities).toContain('Reads and writes files in your workspace')
    expect(detail.capabilities).toContain('Runs shell commands (with confirmation)')
    expect(detail.capabilities.some((c) => c.includes('helper agent'))).toBe(true)
  })

  it('walks helpers/ subdirectory and returns helper metadata', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: [],
      marketplace: ['parent'],
      profiles: {
        'parent': {
          'agent.json': JSON.stringify({
            name: 'parent',
            subagents: [
              { name: 'first', description: 'first helper' },
              { name: 'second', description: 'second helper' },
            ],
          }),
          'SOUL.md': '# parent',
          'helpers/first/agent.json': JSON.stringify({
            name: 'first', kind: 'helper', description: 'First helper',
            model: 'anthropic:claude-haiku-4-5',
          }),
          'helpers/first/SOUL.md': '# First Helper\n\nFirst paragraph.\nSecond line.\nThird line.\nFourth line.',
          'helpers/second/agent.json': JSON.stringify({
            name: 'second', kind: 'helper', description: 'Second helper',
            model: 'anthropic:claude-sonnet-4-6',
          }),
          'helpers/second/SOUL.md': '# Second Helper',
        },
      },
    })
    const bundle = new OwnwareBundle({ bundleDir, userDir })
    const detail = await bundle.detail('parent')
    expect(detail.helpers).toHaveLength(2)
    const first = detail.helpers.find((h) => h.name === 'first')!
    expect(first.description).toBe('First helper')
    expect(first.model).toBe('anthropic:claude-haiku-4-5')
    // soulPreview = first 3 non-empty lines
    expect(first.soulPreview?.split('\n')).toHaveLength(3)
  })

  it('returns empty helpers array when no helpers/ dir', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: [], marketplace: ['solo'],
    })
    const bundle = new OwnwareBundle({ bundleDir, userDir })
    const detail = await bundle.detail('solo')
    expect(detail.helpers).toEqual([])
  })

  it('throws on unknown name', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: ['default'], marketplace: ['x'],
    })
    const bundle = new OwnwareBundle({ bundleDir, userDir })
    await expect(bundle.detail('not-listed')).rejects.toThrow(/not a Ownware marketplace bundle entry/)
    await expect(bundle.detail('default')).rejects.toThrow(/not a Ownware marketplace bundle entry/)
  })

  it('reflects installed=true + hasUpdate when bundle version advances', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: [], marketplace: ['x'],
    })
    const v1 = new OwnwareBundle({ bundleDir, userDir, bundleVersion: 'v1' })
    await v1.install('x')
    const v2 = new OwnwareBundle({ bundleDir, userDir, bundleVersion: 'v2' })
    const detail = await v2.detail('x')
    expect(detail.installed).toBe(true)
    expect(detail.hasUpdate).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Update detection
// ---------------------------------------------------------------------------

describe('OwnwareBundle.list — hasUpdate', () => {
  it('flags hasUpdate=true when the running bundleVersion is newer than installed', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: [], marketplace: ['x'],
    })
    const v1 = new OwnwareBundle({ bundleDir, userDir, bundleVersion: 'v1' })
    await v1.install('x')

    const v2 = new OwnwareBundle({ bundleDir, userDir, bundleVersion: 'v2' })
    const entries = await v2.list()
    expect(entries[0]!.installed).toBe(true)
    expect(entries[0]!.hasUpdate).toBe(true)
  })

  it('flags hasUpdate=false when installed at same bundleVersion', async () => {
    const { bundleDir, userDir } = await makeBundle({
      core: [], marketplace: ['x'],
    })
    const v1 = new OwnwareBundle({ bundleDir, userDir, bundleVersion: 'v1' })
    await v1.install('x')
    const entries = await v1.list()
    expect(entries[0]!.hasUpdate).toBe(false)
  })
})
