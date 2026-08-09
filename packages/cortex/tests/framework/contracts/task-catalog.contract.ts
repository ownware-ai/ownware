import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTestGateway, type TestGateway } from '../harness/index.js'

const ScopeSchema = z.object({
  taskPackId: z.string().min(1),
  scopeKind: z.enum(['global', 'workspace', 'agent']),
  scopeId: z.string().nullable(),
  decision: z.enum(['allow', 'deny']),
  version: z.string().nullable(),
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
}).strict()

const TaskCatalogSchema = z.object({
  taskPacks: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    availableVersions: z.array(z.string().min(1)),
    effectiveVersion: z.string().min(1).nullable(),
    display: z.object({
      category: z.string().min(1),
      accent: z.enum(['blue', 'red', 'green', 'amber', 'violet', 'slate']),
      iconSvg: z.string().min(1).max(32 * 1024),
      composerIconDataUrl: z.string().startsWith('data:image/png;base64,').nullable(),
    }).strict().nullable(),
    tasks: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      description: z.string().min(1),
      examples: z.array(z.string().min(1)),
    }).strict()),
    scopes: z.array(ScopeSchema),
  }).strict()),
}).strict()

const ScopeResponseSchema = z.object({ scope: ScopeSchema }).strict()

async function writeDocumentsTaskPack(directory: string): Promise<void> {
  await mkdir(join(directory, 'skills', 'create-document'), { recursive: true })
  await mkdir(join(directory, 'display'), { recursive: true })
  await writeFile(join(directory, 'ownware-plugin.json'), JSON.stringify({
    schemaVersion: 2,
    id: 'documents',
    version: '1.0.0',
    name: 'Documents',
    description: 'Create and revise structured documents.',
    display: { category: 'documents-files', icon: 'display/icon.svg', accent: 'blue' },
    tasks: [{
      id: 'create-document',
      label: 'Create a document',
      description: 'Plan, draft, and verify a structured document.',
      skill: 'skills/create-document',
      references: [],
      examples: ['Create a project brief.'],
    }],
    permissions: { tools: [], network: [] },
    migrations: [],
  }))
  await writeFile(join(directory, 'skills', 'create-document', 'SKILL.md'), `---
name: create-document
description: Plan, draft, and verify a structured document.
---
Clarify the audience, draft the document, and verify the saved artifact.
`)
  await writeFile(
    join(directory, 'display', 'icon.svg'),
    '<svg viewBox="0 0 24 24"><path d="M4 3h16v18H4z"/></svg>',
  )
}

describe('Contract: task catalog', () => {
  let sourceRoot: string
  let gateway: TestGateway

  beforeAll(async () => {
    sourceRoot = await mkdtemp(join(tmpdir(), 'ownware-task-pack-contract-'))
    const taskPack = join(sourceRoot, 'documents')
    await writeDocumentsTaskPack(taskPack)
    gateway = await createTestGateway({ builtinTaskPackDirs: [taskPack] })
  })

  afterAll(async () => {
    await gateway.stop()
    await rm(sourceRoot, { recursive: true, force: true })
  })

  it('boots a built-in pack and exposes only task-oriented public language', async () => {
    const response = await gateway.client.get('/api/v1/task-catalog', TaskCatalogSchema)
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toMatchObject({
      taskPacks: [{
        id: 'documents',
        availableVersions: ['1.0.0'],
        effectiveVersion: '1.0.0',
        display: {
          category: 'documents-files',
          accent: 'blue',
          iconSvg: expect.stringContaining('viewBox="0 0 24 24"'),
          composerIconDataUrl: null,
        },
        tasks: [{ id: 'create-document', label: 'Create a document' }],
        scopes: [{
          taskPackId: 'documents',
          scopeKind: 'global',
          decision: 'allow',
          version: '1.0.0',
          revision: 1,
        }],
      }],
    })
    expect(response.raw.toLowerCase()).not.toContain('plugin')
  })

  it('persists revisioned workspace control and rejects a stale overwrite', async () => {
    const created = await gateway.client.put(
      '/api/v1/task-catalog/documents/scope',
      {
        scopeKind: 'workspace',
        scopeId: 'workspace-a',
        decision: 'deny',
        version: null,
        expectedRevision: null,
      },
      ScopeResponseSchema,
    )
    expect(created.status).toBe(200)
    expect(created.body.scope).toMatchObject({
      taskPackId: 'documents',
      scopeKind: 'workspace',
      scopeId: 'workspace-a',
      decision: 'deny',
      revision: 1,
    })

    const stale = await gateway.client.put('/api/v1/task-catalog/documents/scope', {
      scopeKind: 'workspace',
      scopeId: 'workspace-a',
      decision: 'allow',
      version: '1.0.0',
      expectedRevision: null,
    })
    expect(stale.status).toBe(409)

    const listed = await gateway.client.get('/api/v1/task-catalog', TaskCatalogSchema)
    expect(listed.body.taskPacks[0]!.scopes).toContainEqual(expect.objectContaining({
      taskPackId: 'documents',
      scopeKind: 'workspace',
      scopeId: 'workspace-a',
      decision: 'deny',
      revision: 1,
    }))

    const workspaceCatalog = await gateway.client.get(
      '/api/v1/task-catalog?workspaceId=workspace-a',
      TaskCatalogSchema,
    )
    expect(workspaceCatalog.body.taskPacks[0]).toMatchObject({
      effectiveVersion: null,
      tasks: [],
    })
  })
})
