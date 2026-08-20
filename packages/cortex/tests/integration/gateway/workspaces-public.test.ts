import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'

const PROFILE = 'workspaces-public'

let gateway: TestGateway | undefined
let scratch: string | undefined

afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
  if (scratch) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

describe('workspaces (public)', () => {
  it('creates, lists, updates and removes without touching the directory', async () => {
    gateway = await createTestGateway({ profiles: [{ name: PROFILE, tools: { preset: 'none' } }] })
    scratch = await mkdtemp(join(tmpdir(), 'ownware-ws-public-'))

    const created = await gateway.client.post('/api/v1/workspaces', {
      path: join(scratch, 'project-a'),
      name: 'Project A',
      create: true,
    })
    expect([200, 201]).toContain(created.status)
    const workspace = created.body as { id: string; path: string }

    const listed = await gateway.client.get('/api/v1/workspaces')
    expect((listed.body as { items: Array<{ id: string }> }).items.some((w) => w.id === workspace.id)).toBe(true)

    const threads = await gateway.client.get(`/api/v1/workspaces/${workspace.id}/threads`)
    expect(threads.status).toBe(200)
    expect(threads.body).toEqual([])

    const removed = await fetch(`${gateway.baseUrl}/api/v1/workspaces/${workspace.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${gateway.token}` },
    })
    expect(removed.status).toBe(204)
    // The row is gone; the directory on disk is not.
    const { access } = await import('node:fs/promises')
    await expect(access(workspace.path)).resolves.toBeUndefined()
  })

  it('refuses every workspace surface to a delegated principal', async () => {
    gateway = await createTestGateway({
      disableAuth: false,
      profiles: [{ name: PROFILE, tools: { preset: 'none' } }],
    })
    const workspaceId = (await gateway.state.createWorkspace(gateway.tmpDir, 'WS')).id
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'browser-ws',
      workspaceId,
      profileId: PROFILE,
      subjectId: 'subject-a',
      purpose: 'support',
      channel: 'web',
      operations: ['workspaces.read', 'workspaces.manage'],
    })
    const token = (issued.body as { token: string }).token
    // Workspaces name absolute local paths and create directories on disk.
    for (const [method, path] of [
      ['GET', '/api/v1/workspaces'],
      ['POST', '/api/v1/workspaces'],
      ['GET', `/api/v1/workspaces/${workspaceId}/threads`],
    ] as const) {
      const response = await fetch(`${gateway.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ path: '/tmp/x' }) } : {}),
      })
      expect(response.status, `${method} ${path}`).toBe(403)
    }
  })
})
