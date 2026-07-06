/**
 * Contract: Workspaces endpoints
 *
 * GET    /api/v1/workspaces
 * POST   /api/v1/workspaces
 * GET    /api/v1/workspaces/:id
 * PUT    /api/v1/workspaces/:id
 * DELETE /api/v1/workspaces/:id
 * GET    /api/v1/workspaces/:id/threads
 * POST   /api/v1/workspaces/browse
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createTestGateway, type TestGateway } from '../harness/index.js'
import {
  WorkspaceSchema,
  PaginatedWorkspacesSchema,
  ApiErrorSchema,
} from '../harness/schema-validator.js'

describe('Contract: Workspaces', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('GET /workspaces returns valid PaginatedResult<Workspace>', async () => {
    const r = await gw.client.get('/api/v1/workspaces', PaginatedWorkspacesSchema)
    expect(r.status).toBe(200)
    expect(typeof r.body.total).toBe('number')
    expect(Array.isArray(r.body.items)).toBe(true)
  })

  it('POST /workspaces creates a workspace from real path', async () => {
    const r = await gw.client.post(
      '/api/v1/workspaces',
      { path: gw.tmpDir, name: 'Contract WS' },
      WorkspaceSchema,
    )
    expect([200, 201]).toContain(r.status)
    expect(r.body.id).toMatch(/^ws_/)
    expect(r.body.status).toBe('active')
    expect(r.body.path).toBe(gw.tmpDir)
  })

  it('POST /workspaces returns error for non-existent path', async () => {
    const r = await gw.client.post(
      '/api/v1/workspaces',
      { path: '/this/does/not/exist/at/all' },
      ApiErrorSchema,
    )
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(r.body.error).toBeDefined()
  })

  it('POST /workspaces with create:true mkdirs missing path', async () => {
    const nestedPath = join(gw.tmpDir, '.ownware', 'app', 'ownware-design', 'demo-slug')
    expect(existsSync(nestedPath)).toBe(false)
    const r = await gw.client.post(
      '/api/v1/workspaces',
      { path: nestedPath, name: 'Design demo', create: true },
      WorkspaceSchema,
    )
    expect([200, 201]).toContain(r.status)
    expect(r.body.path).toBe(nestedPath)
    expect(existsSync(nestedPath)).toBe(true)
    expect(statSync(nestedPath).isDirectory()).toBe(true)
  })

  it('GET /workspaces/:id returns WorkspaceDetail', async () => {
    const ws = gw.state.createWorkspace(gw.tmpDir + '_detail', 'Detail WS')
    const r = await gw.client.get<Record<string, unknown>>(`/api/v1/workspaces/${ws.id}`)
    expect(r.status).toBe(200)
    expect(r.body['id']).toBe(ws.id)
    expect(Array.isArray(r.body['profiles'])).toBe(true)
    expect(typeof r.body['activeThreads']).toBe('number')
    expect(typeof r.body['totalThreads']).toBe('number')
  })

  it('GET /workspaces/:id returns 404 for non-existent', async () => {
    const r = await gw.client.get('/api/v1/workspaces/ws_nonexistent', ApiErrorSchema)
    expect(r.status).toBe(404)
  })

  it('PUT /workspaces/:id updates fields', async () => {
    const ws = gw.state.createWorkspace(gw.tmpDir + '_update', 'Original')
    const r = await gw.client.put<{ name: string; pinned: boolean }>(
      `/api/v1/workspaces/${ws.id}`,
      { name: 'Updated', pinned: true },
    )
    expect(r.status).toBe(200)
    expect(r.body.name).toBe('Updated')
    expect(r.body.pinned).toBe(true)
  })

  it('DELETE /workspaces/:id removes workspace', async () => {
    const ws = gw.state.createWorkspace(gw.tmpDir + '_delete', 'Delete me')
    const del = await gw.client.delete(`/api/v1/workspaces/${ws.id}`)
    expect(del.status).toBe(204)

    const get = await gw.client.get(`/api/v1/workspaces/${ws.id}`)
    expect(get.status).toBe(404)
  })

  it('GET /workspaces/:id/threads returns thread array', async () => {
    const ws = gw.state.createWorkspace(gw.tmpDir + '_threads', 'WS with threads')
    gw.state.createThread('mini', 'T1', ws.id)
    gw.state.createThread('mini', 'T2', ws.id)

    const r = await gw.client.get<unknown[]>(`/api/v1/workspaces/${ws.id}/threads`)
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
    expect(r.body.length).toBe(2)
  })

  it('POST /workspaces/browse returns file tree for valid path', async () => {
    const r = await gw.client.post('/api/v1/workspaces/browse', { path: gw.tmpDir })
    expect(r.status).toBe(200)
  })

  it('GET /workspaces?status=active filters by status', async () => {
    const r = await gw.client.get('/api/v1/workspaces?status=active', PaginatedWorkspacesSchema)
    expect(r.status).toBe(200)
    for (const ws of r.body.items) {
      expect(ws.status).toBe('active')
    }
  })
})
