import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginService } from '../../../src/plugin/service.js'
import { SqliteStorageAdapter } from '../../../src/storage/sqlite-adapter.js'
import { createSqlitePluginRepository } from '../../../src/storage/sqlite-plugin-repository.js'
import type { PluginRepository } from '../../../src/storage/plugin-repository.js'

async function fixture(
  directory: string,
  version = '1.0.0',
  taskId = 'create-document',
): Promise<void> {
  await mkdir(join(directory, 'skills', taskId), { recursive: true })
  await writeFile(join(directory, 'ownware-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'documents',
    version,
    name: 'Documents',
    description: 'Create and revise structured documents.',
    tasks: [{
      id: taskId,
      label: taskId,
      description: 'Plan, draft, and verify a structured document.',
      skill: `skills/${taskId}`,
      examples: ['Create a project brief.'],
    }],
    permissions: { tools: [], network: [] },
    migrations: [],
  }))
  await writeFile(join(directory, 'skills', taskId, 'SKILL.md'), `---
name: ${taskId}
description: Create a carefully structured document
trigger: /${taskId}
---
Plan, draft, and verify the requested document.
`)
}

describe('plugin service', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  it('reconciles built-ins, enables a global default and honors workspace deny', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ownware-plugin-service-'))
    const source = join(directory, 'builtin')
    await fixture(source)
    type Root = { readonly plugins: PluginRepository }
    const adapter = new SqliteStorageAdapter<Root, object>({
      dbPath: join(directory, 'ownware.db'),
      openMode: 'eager',
      repositories: {
        createRoot: context => ({ plugins: createSqlitePluginRepository(context) }),
        createTransaction: () => ({}),
      },
    })
    cleanups.push(async () => {
      await adapter.close()
      rmSync(directory, { recursive: true, force: true })
    })
    const service = new PluginService(join(directory, 'data'), adapter.repositories.plugins)
    await service.initialize([source])
    expect((await service.resolveSkills({ agentId: 'writer' })).skills.map(skill => skill.name))
      .toEqual(['create-document'])

    await service.setGrant({
      pluginId: 'documents',
      scopeKind: 'workspace',
      scopeId: 'restricted',
      decision: 'deny',
      version: null,
    }, null)
    expect(await service.resolveSkills({ agentId: 'writer', workspaceId: 'restricted' }))
      .toEqual({ skills: [], versions: [] })
    expect((await service.catalog())[0]).toMatchObject({
      id: 'documents',
      name: 'Documents',
      availableVersions: ['1.0.0'],
      effectiveVersion: '1.0.0',
      scopes: expect.arrayContaining([
        expect.objectContaining({ taskPackId: 'documents', scopeKind: 'global' }),
      ]),
    })

    await writeFile(
      join(directory, 'data', 'plugins', 'packages', 'documents', '1.0.0',
        'skills', 'create-document', 'SKILL.md'),
      'corrupt',
    )
    await expect(service.catalog()).rejects.toMatchObject({
      name: 'PluginPackageIntegrityError',
      code: 'corrupt',
    })
  })

  it('installs an update without changing the pinned version, then updates and rolls back by revision', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ownware-plugin-update-'))
    const versionOne = join(directory, 'v1')
    const versionTwo = join(directory, 'v2')
    await fixture(versionOne, '1.0.0', 'old-task')
    await fixture(versionTwo, '2.0.0', 'new-task')
    type Root = { readonly plugins: PluginRepository }
    const adapter = new SqliteStorageAdapter<Root, object>({
      dbPath: join(directory, 'ownware.db'),
      openMode: 'eager',
      repositories: {
        createRoot: context => ({ plugins: createSqlitePluginRepository(context) }),
        createTransaction: () => ({}),
      },
    })
    cleanups.push(async () => {
      await adapter.close()
      rmSync(directory, { recursive: true, force: true })
    })
    const service = new PluginService(join(directory, 'data'), adapter.repositories.plugins)

    await service.initialize([versionOne])
    await service.initialize([versionTwo])
    expect((await service.resolveSkills({ agentId: 'writer' })).versions[0]?.version)
      .toBe('1.0.0')
    expect((await service.catalog())[0]).toMatchObject({
      effectiveVersion: '1.0.0',
      tasks: [{ id: 'old-task' }],
    })

    await service.setGrant({
      pluginId: 'documents',
      scopeKind: 'agent',
      scopeId: 'preview-writer',
      decision: 'allow',
      version: '2.0.0',
    }, null)
    expect((await service.catalog({ agentId: 'preview-writer' }))[0]).toMatchObject({
      effectiveVersion: '2.0.0',
      tasks: [{ id: 'new-task' }],
    })

    await service.setGrant({
      pluginId: 'documents',
      scopeKind: 'workspace',
      scopeId: 'disabled-workspace',
      decision: 'deny',
      version: null,
    }, null)
    expect((await service.catalog({ workspaceId: 'disabled-workspace' }))[0]).toMatchObject({
      effectiveVersion: null,
      tasks: [],
    })

    const updated = await service.setGrant({
      pluginId: 'documents',
      scopeKind: 'global',
      scopeId: null,
      decision: 'allow',
      version: '2.0.0',
    }, 1)
    expect(updated.revision).toBe(2)
    expect((await service.resolveSkills({ agentId: 'writer' })).versions[0]?.version)
      .toBe('2.0.0')
    expect((await service.catalog())[0]).toMatchObject({
      effectiveVersion: '2.0.0',
      tasks: [{ id: 'new-task' }],
    })

    const rolledBack = await service.setGrant({
      pluginId: 'documents',
      scopeKind: 'global',
      scopeId: null,
      decision: 'allow',
      version: '1.0.0',
    }, 2)
    expect(rolledBack).toMatchObject({ revision: 3, version: '1.0.0' })
    expect((await service.resolveSkills({ agentId: 'writer' })).versions[0]?.version)
      .toBe('1.0.0')
    expect((await service.catalog())[0]).toMatchObject({
      availableVersions: ['2.0.0', '1.0.0'],
      effectiveVersion: '1.0.0',
      tasks: [{ id: 'old-task' }],
      scopes: expect.arrayContaining([
        expect.objectContaining({ scopeKind: 'global', version: '1.0.0', revision: 3 }),
      ]),
    })
  })
})
