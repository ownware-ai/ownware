/**
 * Journey 03: Workspace flow
 *
 * Mirrors the Home → Workspace screen flow:
 *   1. Create workspace from real directory
 *   2. List workspaces — verify present
 *   3. Get workspace detail
 *   4. Create threads in workspace
 *   5. Pin workspace
 *   6. Archive workspace
 *   7. Reactivate by recreating with same path
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createTestGateway, type TestGateway } from '../harness/index.js'

describe('Journey: 03 Workspace Flow', () => {
  let gw: TestGateway
  let wsPath: string
  let wsId: string

  beforeAll(async () => {
    gw = await createTestGateway()
    wsPath = join(gw.tmpDir, 'project-alpha')
    await mkdir(wsPath, { recursive: true })
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('Step 1: POST /workspaces creates a workspace', async () => {
    const r = await gw.client.post<{ id: string; name: string; status: string }>('/api/v1/workspaces', {
      path: wsPath,
      name: 'Project Alpha',
    })
    expect([200, 201]).toContain(r.status)
    expect(r.body.status).toBe('active')
    wsId = r.body.id
  })

  it('Step 2: Workspace appears in active list', async () => {
    const r = await gw.client.get<{ items: Array<{ id: string }> }>('/api/v1/workspaces?status=active')
    expect(r.body.items.some(w => w.id === wsId)).toBe(true)
  })

  it('Step 3: GET /workspaces/:id returns detail with profiles + thread counts', async () => {
    const r = await gw.client.get<Record<string, unknown>>(`/api/v1/workspaces/${wsId}`)
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body['profiles'])).toBe(true)
    expect(r.body['totalThreads']).toBe(0)
    expect(r.body['activeThreads']).toBe(0)
  })

  it('Step 4: Create threads in workspace', async () => {
    await gw.client.post('/api/v1/threads', { profileId: 'mini', workspaceId: wsId })
    await gw.client.post('/api/v1/threads', { profileId: 'mini', workspaceId: wsId })

    const detail = await gw.client.get<{ totalThreads: number }>(`/api/v1/workspaces/${wsId}`)
    expect(detail.body.totalThreads).toBe(2)
  })

  it('Step 5: GET /workspaces/:id/threads returns 2 threads', async () => {
    const r = await gw.client.get<unknown[]>(`/api/v1/workspaces/${wsId}/threads`)
    expect(r.body.length).toBe(2)
  })

  it('Step 6: PUT /workspaces/:id pins it', async () => {
    const r = await gw.client.put<{ pinned: boolean }>(`/api/v1/workspaces/${wsId}`, { pinned: true })
    expect(r.body.pinned).toBe(true)
  })

  it('Step 7: PUT /workspaces/:id archives it', async () => {
    const r = await gw.client.put<{ status: string }>(`/api/v1/workspaces/${wsId}`, { status: 'archived' })
    expect(r.body.status).toBe('archived')
  })

  it('Step 8: Archived workspace not in active list', async () => {
    const r = await gw.client.get<{ items: Array<{ id: string }> }>('/api/v1/workspaces?status=active')
    expect(r.body.items.some(w => w.id === wsId)).toBe(false)
  })

  it('Step 9: POST /workspaces with same path reactivates archived', async () => {
    const r = await gw.client.post<{ id: string; status: string }>('/api/v1/workspaces', {
      path: wsPath,
    })
    expect([200, 201]).toContain(r.status)
    // Same id, status now active
    expect(r.body.id).toBe(wsId)
    expect(r.body.status).toBe('active')
  })
})
