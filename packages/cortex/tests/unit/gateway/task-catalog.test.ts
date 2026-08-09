import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createTaskCatalogHandlers } from '../../../src/gateway/handlers/task-catalog.js'
import { setRequestPrincipal } from '../../../src/gateway/auth/scoped-principal.js'
import type { PluginService } from '../../../src/plugin/service.js'

function response(): {
  readonly res: ServerResponse
  readonly output: { status?: number; body?: unknown }
} {
  const output: { status?: number; body?: unknown } = {}
  const res = {
    writeHead: (status: number): unknown => {
      output.status = status
      return res
    },
    end: (body?: string): void => {
      output.body = body === undefined ? undefined : JSON.parse(body)
    },
    setHeader: (): void => {},
  } as unknown as ServerResponse
  return { res, output }
}

function request(body: unknown): IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
}

describe('task catalog handlers', () => {
  it('uses task-oriented output language for catalog discovery', async () => {
    const service = {
      catalog: vi.fn(async () => [{
        id: 'documents',
        name: 'Documents',
        description: 'Create documents.',
        availableVersions: ['1.0.0'],
        effectiveVersion: '1.0.0',
        tasks: [{ id: 'create-document', label: 'Create a document' }],
        scopes: [],
      }]),
    } as unknown as PluginService
    const handlers = createTaskCatalogHandlers(service, { authEnabled: false })
    const { res, output } = response()
    await handlers.list({} as IncomingMessage, res)
    expect(service.catalog).toHaveBeenCalledWith({})
    expect(output).toMatchObject({
      status: 200,
      body: { taskPacks: [{ id: 'documents', tasks: [{ label: 'Create a document' }] }] },
    })
    expect(JSON.stringify(output.body)).not.toContain('plugin')
  })

  it('passes a validated workspace and agent context to catalog resolution', async () => {
    const catalog = vi.fn(async () => [])
    const handlers = createTaskCatalogHandlers(
      { catalog } as unknown as PluginService,
      { authEnabled: false },
    )
    const { res, output } = response()
    await handlers.list({
      url: '/api/v1/task-catalog?workspaceId=project-a&agentId=writer',
      headers: {},
    } as IncomingMessage, res)
    expect(output.status).toBe(200)
    expect(catalog).toHaveBeenCalledWith({ workspaceId: 'project-a', agentId: 'writer' })
  })

  it('rejects duplicate, unknown, empty, and padded catalog context parameters', async () => {
    const catalog = vi.fn(async () => [])
    const handlers = createTaskCatalogHandlers(
      { catalog } as unknown as PluginService,
      { authEnabled: false },
    )
    for (const query of [
      'agentId=one&agentId=two',
      'profileId=writer',
      'workspaceId=',
      'agentId=%20writer',
    ]) {
      const { res, output } = response()
      await handlers.list({ url: `/api/v1/task-catalog?${query}`, headers: {} } as IncomingMessage, res)
      expect(output.status).toBe(400)
    }
    expect(catalog).not.toHaveBeenCalled()
  })

  it('updates one revisioned scope and maps stale writes to conflict', async () => {
    const setGrant = vi.fn(async () => ({
      pluginId: 'documents',
      scopeKind: 'agent' as const,
      scopeId: 'writer',
      decision: 'allow' as const,
      version: '1.0.0',
      revision: 2,
      updatedAt: '2026-08-09T00:00:00.000Z',
    }))
    const handlers = createTaskCatalogHandlers(
      { setGrant } as unknown as PluginService,
      { authEnabled: false },
    )
    const { res, output } = response()
    await handlers.setScope(request({
      scopeKind: 'agent',
      scopeId: 'writer',
      decision: 'allow',
      version: '1.0.0',
      expectedRevision: 1,
    }), res, { taskPackId: 'documents' })
    expect(setGrant).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'documents',
      scopeId: 'writer',
    }), 1)
    expect(output).toMatchObject({
      status: 200,
      body: { scope: { taskPackId: 'documents', revision: 2 } },
    })
    expect(JSON.stringify(output.body)).not.toContain('plugin')
  })

  it('rejects delegated task-pack control even when the delegation names the operation', async () => {
    const handlers = createTaskCatalogHandlers({} as PluginService, { authEnabled: true })
    const req = request({})
    setRequestPrincipal(req, {
      kind: 'delegated',
      tokenId: 'token',
      delegateId: 'delegate',
      workspaceId: 'workspace',
      profileId: 'writer',
      purpose: 'run',
      operations: ['task_catalog.scope'],
      issuedAt: 1,
      expiresAt: 2,
    })
    const { res, output } = response()
    await handlers.setScope(req, res, { taskPackId: 'documents' })
    expect(output).toMatchObject({
      status: 403,
      body: { error: 'owner_required' },
    })
  })
})
