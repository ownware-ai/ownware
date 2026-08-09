import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { PluginPackageIntegrityError, PluginPackageStore } from '../../../src/plugin/package-store.js'
import { SqliteStorageAdapter } from '../../../src/storage/sqlite-adapter.js'
import { createSqlitePluginRepository } from '../../../src/storage/sqlite-plugin-repository.js'
import type { PluginRepository } from '../../../src/storage/plugin-repository.js'

async function writePackage(directory: string): Promise<void> {
  await mkdir(join(directory, 'skills', 'create-document'), { recursive: true })
  await writeFile(join(directory, 'ownware-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'documents',
    version: '1.0.0',
    name: 'Documents',
    description: 'Create and revise structured documents.',
    tasks: [{
      id: 'create-document',
      label: 'Create a document',
      description: 'Plan, draft, and verify a structured document.',
      skill: 'skills/create-document',
      examples: ['Create a project brief.'],
    }],
    permissions: { tools: ['filesystem_*'], network: [] },
    migrations: [],
  }))
  await writeFile(join(directory, 'skills', 'create-document', 'SKILL.md'), `---
name: create-document
description: Create a carefully structured document
trigger: /create-document
---
Plan the document, draft it, then verify the saved artifact.
`)
}

async function addReference(directory: string, bytes: Uint8Array): Promise<void> {
  const manifestPath = join(directory, 'ownware-plugin.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    tasks: Array<{ references?: string[] }>
  }
  manifest.tasks[0]!.references = ['references/workflow.md']
  await writeFile(manifestPath, JSON.stringify(manifest))
  await mkdir(join(directory, 'references'), { recursive: true })
  await writeFile(join(directory, 'references', 'workflow.md'), bytes)
}

async function addDisplayIcon(
  directory: string,
  svg: string,
  iconPath = 'display/icon.svg',
): Promise<void> {
  const manifestPath = join(directory, 'ownware-plugin.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  manifest['schemaVersion'] = 2
  manifest['display'] = {
    category: 'documents-files',
    icon: iconPath,
    accent: 'blue',
  }
  await writeFile(manifestPath, JSON.stringify(manifest))
  await mkdir(join(directory, 'display'), { recursive: true })
  await writeFile(join(directory, ...iconPath.split('/')), svg)
}

async function addV3Resources(directory: string): Promise<void> {
  const manifestPath = join(directory, 'ownware-plugin.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    schemaVersion: number
    display?: Record<string, string>
    tasks: Array<Record<string, unknown>>
  }
  manifest.schemaVersion = 3
  manifest.display = {
    category: 'documents-files',
    icon: 'display/icon.svg',
    composerIcon: 'display/icon.png',
    accent: 'blue',
  }
  manifest.tasks[0]!['references'] = ['references/workflow.md']
  manifest.tasks[0]!['resources'] = [
    { kind: 'script', path: 'scripts/inspect.py', description: 'Inspect a document.' },
    { kind: 'template', path: 'assets/templates/brief.md', description: 'Brief outline.' },
    { kind: 'schema', path: 'schemas/plan.json', description: 'Document plan schema.' },
  ]
  await writeFile(manifestPath, JSON.stringify(manifest))
  await mkdir(join(directory, 'display'), { recursive: true })
  await mkdir(join(directory, 'references'), { recursive: true })
  await mkdir(join(directory, 'scripts'), { recursive: true })
  await mkdir(join(directory, 'assets', 'templates'), { recursive: true })
  await mkdir(join(directory, 'schemas'), { recursive: true })
  await writeFile(
    join(directory, 'display', 'icon.svg'),
    '<svg viewBox="0 0 24 24"><path d="M4 3h16v18H4z"/></svg>',
  )
  await writeFile(join(directory, 'display', 'icon.png'), await sharp({
    create: { width: 256, height: 256, channels: 4, background: '#2563eb' },
  }).png().toBuffer())
  await writeFile(join(directory, 'references', 'workflow.md'), 'Render and verify the result.')
  await writeFile(join(directory, 'scripts', 'inspect.py'), 'print("inspected")\n')
  await writeFile(join(directory, 'assets', 'templates', 'brief.md'), '# Brief\n')
  await writeFile(join(directory, 'schemas', 'plan.json'), '{"type":"object"}')
}

describe('plugin package store', () => {
  let directory: string
  let adapter: SqliteStorageAdapter<{ readonly plugins: PluginRepository }, object>
  let repository: PluginRepository

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ownware-plugin-package-'))
    adapter = new SqliteStorageAdapter({
      dbPath: join(directory, 'ownware.db'),
      openMode: 'eager',
      repositories: {
        createRoot: context => ({ plugins: createSqlitePluginRepository(context) }),
        createTransaction: () => ({}),
      },
    })
    repository = adapter.repositories.plugins
  })

  afterEach(async () => {
    await adapter.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('publishes atomically, registers immutable identity and loads one verified skill', async () => {
    const source = join(directory, 'source')
    await writePackage(source)
    const store = new PluginPackageStore(join(directory, 'data'), repository)
    const installed = await store.installFromDirectory(source, 'builtin', 'builtin')
    expect(installed.version.packageSha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect((await store.loadSkills(installed.version))[0]).toMatchObject({
      name: 'create-document',
      content: expect.stringContaining('verify the saved artifact'),
    })
    expect(await readFile(join(installed.directory, 'ownware-plugin.json'), 'utf8'))
      .toContain('create-document')
  })

  it('converges concurrent publication of the same immutable identity', async () => {
    const source = join(directory, 'source')
    await writePackage(source)
    const store = new PluginPackageStore(join(directory, 'data'), repository)
    const installed = await Promise.all(Array.from(
      { length: 4 },
      () => store.installFromDirectory(source, 'builtin', 'builtin'),
    ))
    expect(new Set(installed.map(item => item.version.packageSha256)).size).toBe(1)
    expect(await repository.listVersions('documents')).toHaveLength(1)
  })

  it('detects post-install mutation before a package can enter an agent', async () => {
    const source = join(directory, 'source')
    await writePackage(source)
    const store = new PluginPackageStore(join(directory, 'data'), repository)
    const installed = await store.installFromDirectory(source, 'builtin', 'builtin')
    await writeFile(
      join(installed.directory, 'skills', 'create-document', 'SKILL.md'),
      'mutated',
    )
    await expect(store.loadSkills(installed.version))
      .rejects.toBeInstanceOf(PluginPackageIntegrityError)
  })

  it('rejects a bundled reference that is not valid UTF-8', async () => {
    const source = join(directory, 'source')
    await writePackage(source)
    await addReference(source, Uint8Array.from([0xc3, 0x28]))
    const store = new PluginPackageStore(join(directory, 'data'), repository)
    await expect(store.installFromDirectory(source, 'builtin', 'builtin')).rejects.toMatchObject({
      name: 'PluginPackageIntegrityError',
      code: 'corrupt',
    })
  })

  it('rejects skill metadata large enough to inflate every agent prompt', async () => {
    const source = join(directory, 'source')
    await writePackage(source)
    await writeFile(join(source, 'skills', 'create-document', 'SKILL.md'), `---
name: create-document
description: ${'x'.repeat(1_025)}
trigger: /create-document
---
Draft the document.
`)
    const store = new PluginPackageStore(join(directory, 'data'), repository)
    await expect(store.installFromDirectory(source, 'builtin', 'builtin')).rejects.toMatchObject({
      name: 'PluginPackageIntegrityError',
      code: 'limit_exceeded',
    })
  })

  it('rejects combined skill and reference content beyond the invoked prompt budget', async () => {
    const source = join(directory, 'source')
    await writePackage(source)
    await addReference(source, new TextEncoder().encode('x'.repeat(128 * 1024)))
    const store = new PluginPackageStore(join(directory, 'data'), repository)
    await expect(store.installFromDirectory(source, 'builtin', 'builtin')).rejects.toMatchObject({
      name: 'PluginPackageIntegrityError',
      code: 'limit_exceeded',
    })
  })

  it('accepts only the passive geometry subset for 24px display icons', async () => {
    const source = join(directory, 'source')
    await writePackage(source)
    await addDisplayIcon(source, '<svg viewBox="0 0 24 24"><path d="M4 3h16v18H4z"/></svg>')
    const store = new PluginPackageStore(join(directory, 'data'), repository)
    const installed = await store.installFromDirectory(source, 'builtin', 'builtin')
    expect(installed).toMatchObject({
      manifest: { schemaVersion: 2, display: { icon: 'display/icon.svg' } },
    })
    await expect(store.loadDisplay(installed.version)).resolves.toMatchObject({
      category: 'documents-files',
      accent: 'blue',
      iconSvg: expect.stringContaining('<path'),
    })

    const unsafeIcons = [
      '<svg viewBox="0 0 24 24"><script>alert(1)</script><path d="M0 0h1v1z"/></svg>',
      '<svg viewBox="0 0 24 24"><a><animate attributeName="href" values="javascript:alert(1)"/></a></svg>',
      '<svg viewBox="0 0 24 24"><path d="M0 0h1v1z"/>',
    ]
    for (const [index, svg] of unsafeIcons.entries()) {
      const unsafe = join(directory, `unsafe-${index}`)
      await writePackage(unsafe)
      await addDisplayIcon(unsafe, svg)
      await expect(store.installFromDirectory(unsafe, 'builtin', 'builtin')).rejects.toMatchObject({
        name: 'PluginPackageIntegrityError',
        code: 'corrupt',
      })
    }

    const wrongExtension = join(directory, 'wrong-extension')
    await writePackage(wrongExtension)
    await addDisplayIcon(
      wrongExtension,
      '<svg viewBox="0 0 24 24"><path d="M0 0h1v1z"/></svg>',
      'display/icon.txt',
    )
    await expect(store.installFromDirectory(wrongExtension, 'builtin', 'builtin'))
      .rejects.toMatchObject({ code: 'corrupt' })
  })

  it('loads canonical composer art and exposes verified v3 resource paths lazily', async () => {
    const source = join(directory, 'source')
    await writePackage(source)
    await addV3Resources(source)
    const store = new PluginPackageStore(join(directory, 'data'), repository)
    const installed = await store.installFromDirectory(source, 'builtin', 'builtin')
    await expect(store.loadDisplay(installed.version)).resolves.toMatchObject({
      composerIconDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
    })
    const [skill] = await store.loadSkills(installed.version)
    expect(skill?.content).toContain('## Verified package resources')
    expect(skill?.content).toContain(join(installed.directory, 'scripts', 'inspect.py'))
    expect(skill?.content).toContain(join(installed.directory, 'assets', 'templates', 'brief.md'))

    const wrongSize = join(directory, 'wrong-composer-size')
    await writePackage(wrongSize)
    await addV3Resources(wrongSize)
    await writeFile(
      join(wrongSize, 'display', 'icon.png'),
      await sharp({
        create: { width: 128, height: 128, channels: 4, background: '#2563eb' },
      }).png().toBuffer(),
    )
    await expect(store.installFromDirectory(wrongSize, 'builtin', 'builtin'))
      .rejects.toMatchObject({ code: 'corrupt' })
  })
})
