import { describe, expect, it } from 'vitest'
import { OwnwareClient } from '../client.js'

describe('task catalog client contract', () => {
  it('uses the owner bearer and exact revisioned scope body', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new OwnwareClient({
      baseUrl: 'http://127.0.0.1:3011/',
      token: 'fixture-token',
      fetch: (async (input, init) => {
        calls.push({ url: String(input), init })
        const body = init?.method === 'PUT'
          ? {
              scope: {
                taskPackId: 'documents',
                scopeKind: 'workspace',
                scopeId: 'workspace-1',
                decision: 'allow',
                version: '1.1.0',
                revision: 3,
                updatedAt: '2026-08-09T00:00:00.000Z',
              },
            }
          : { taskPacks: [] }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
    })

    await expect(client.taskCatalog()).resolves.toEqual({ taskPacks: [] })
    await expect(client.taskCatalog({
      workspaceId: 'workspace 1',
      agentId: 'writer/primary',
    })).resolves.toEqual({ taskPacks: [] })
    await expect(client.setTaskPackScope('documents', {
      scopeKind: 'workspace',
      scopeId: 'workspace-1',
      decision: 'allow',
      version: '1.1.0',
      expectedRevision: 2,
    })).resolves.toMatchObject({ scope: { revision: 3 } })

    expect(calls.map(call => call.url)).toEqual([
      'http://127.0.0.1:3011/api/v1/task-catalog',
      'http://127.0.0.1:3011/api/v1/task-catalog?workspaceId=workspace+1&agentId=writer%2Fprimary',
      'http://127.0.0.1:3011/api/v1/task-catalog/documents/scope',
    ])
    expect(calls[0]?.init?.headers).toEqual({ Authorization: 'Bearer fixture-token' })
    expect(calls[2]?.init).toMatchObject({
      method: 'PUT',
      headers: {
        Authorization: 'Bearer fixture-token',
        'Content-Type': 'application/json',
      },
    })
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      scopeKind: 'workspace',
      scopeId: 'workspace-1',
      decision: 'allow',
      version: '1.1.0',
      expectedRevision: 2,
    })
  })
})
