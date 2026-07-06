/**
 * E2E tests — Real OwnwareGateway, real HTTP requests.
 *
 * Starts the gateway on a random port and tests all workspace + MCP
 * endpoints with actual HTTP calls. No mocks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { OwnwareGateway } from '../../src/gateway/server.js'

const API = (port: number) => `http://localhost:${port}/api/v1`

let authHeader: string

async function get(url: string) {
  const res = await fetch(url, {
    headers: { 'Authorization': authHeader },
  })
  return { status: res.status, data: await res.json() as any }
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() as any }
}

async function put(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() as any }
}

async function del(url: string) {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': authHeader },
  })
  return { status: res.status }
}

describe('Workspace Gateway E2E', () => {
  let gateway: OwnwareGateway
  let port: number
  let tmpDir: string
  let projectDir: string
  let profilesDir: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-e2e-'))
    projectDir = join(tmpDir, 'test-project')
    mkdirSync(projectDir)
    mkdirSync(join(projectDir, 'src'))
    mkdirSync(join(projectDir, '.git'))
    writeFileSync(join(projectDir, 'package.json'), '{"name":"test-project"}')

    // Create a minimal profile for testing
    profilesDir = join(tmpDir, 'profiles')
    mkdirSync(join(profilesDir, 'test-agent'), { recursive: true })
    writeFileSync(join(profilesDir, 'test-agent', 'agent.json'), JSON.stringify({
      name: 'test-agent',
      description: 'Test agent for E2E',
      model: 'anthropic:claude-sonnet-4-20250514',
      tools: { preset: 'none', allow: [], deny: [], custom: [], mcp: {} },
      security: { level: 'standard', permissionMode: 'ask' },
    }))

    // Use random port to avoid conflicts
    port = 30000 + Math.floor(Math.random() * 10000)
    gateway = new OwnwareGateway({
      port,
      profilesDir,
      dataDir: join(tmpDir, '.ownware-data'),
      cors: true,
    })
    await gateway.start()
    authHeader = `Bearer ${gateway.token}`
  }, 15000)

  afterAll(async () => {
    await gateway.stop()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Health ─────────────────────────────────────────────────────────

  it('health endpoint works', async () => {
    const { status, data } = await get(`${API(port)}/health`)
    expect(status).toBe(200)
    expect(data.status).toBe('ok')
  })

  // ── Workspace CRUD ─────────────────────────────────────────────────

  describe('Workspace endpoints', () => {
    let workspaceId: string

    it('POST /workspaces — create from directory', async () => {
      const { status, data } = await post(`${API(port)}/workspaces`, {
        path: projectDir,
        name: 'Test Project',
      })
      expect(status).toBe(201)
      expect(data.name).toBe('Test Project')
      expect(data.path).toBe(projectDir)
      expect(data.status).toBe('active')
      workspaceId = data.id
    })

    it('POST /workspaces — duplicate path returns existing', async () => {
      const { status, data } = await post(`${API(port)}/workspaces`, {
        path: projectDir,
      })
      expect(status).toBe(200) // not 201
      expect(data.id).toBe(workspaceId)
    })

    it('POST /workspaces — invalid path returns 400', async () => {
      const { status } = await post(`${API(port)}/workspaces`, {
        path: '/nonexistent/path/that/does/not/exist',
      })
      expect(status).toBe(400)
    })

    it('GET /workspaces — lists all', async () => {
      const { status, data } = await get(`${API(port)}/workspaces`)
      expect(status).toBe(200)
      expect(Array.isArray(data.items)).toBe(true)
      expect(data.items.length).toBeGreaterThanOrEqual(1)
      expect(data.items.some((w: any) => w.id === workspaceId)).toBe(true)
    })

    it('GET /workspaces/:id — returns detail', async () => {
      const { status, data } = await get(`${API(port)}/workspaces/${workspaceId}`)
      expect(status).toBe(200)
      expect(data.id).toBe(workspaceId)
      expect(data).toHaveProperty('profiles')
      expect(data).toHaveProperty('totalThreads')
    })

    it('PUT /workspaces/:id — update name and pin', async () => {
      const { status, data } = await put(`${API(port)}/workspaces/${workspaceId}`, {
        name: 'Renamed Project',
        pinned: true,
      })
      expect(status).toBe(200)
      expect(data.name).toBe('Renamed Project')
      expect(data.pinned).toBe(true)
    })

    it('GET /workspaces/:id — not found', async () => {
      const { status } = await get(`${API(port)}/workspaces/ws_nonexistent`)
      expect(status).toBe(404)
    })
  })

  // ── Browse ─────────────────────────────────────────────────────────

  describe('Browse endpoint', () => {
    it('POST /workspaces/browse — lists directories', async () => {
      const { status, data } = await post(`${API(port)}/workspaces/browse`, {
        path: tmpDir,
      })
      expect(status).toBe(200)
      expect(data.path).toBe(tmpDir)
      expect(Array.isArray(data.entries)).toBe(true)
      // Should find our test-project directory
      const found = data.entries.find((e: any) => e.name === 'test-project')
      expect(found).toBeDefined()
      expect(found.isGitRepo).toBe(true)
    })

    it('POST /workspaces/browse — invalid path returns 400', async () => {
      const { status } = await post(`${API(port)}/workspaces/browse`, {
        path: '/nonexistent/directory',
      })
      expect(status).toBe(400)
    })
  })

  // ── Threads in workspace ───────────────────────────────────────────

  describe('Threads in workspace', () => {
    let workspaceId: string
    let threadId: string

    it('create workspace + thread', async () => {
      const proj2 = join(tmpDir, 'thread-test-proj')
      mkdirSync(proj2)
      const { data: ws } = await post(`${API(port)}/workspaces`, { path: proj2 })
      workspaceId = ws.id

      const { status, data } = await post(`${API(port)}/threads`, {
        profileId: 'test-agent',
        title: 'E2E Thread',
        workspaceId,
      })
      expect(status).toBe(201)
      expect(data.workspaceId).toBe(workspaceId)
      threadId = data.id
    })

    it('GET /workspaces/:id/threads — returns workspace threads', async () => {
      const { status, data } = await get(`${API(port)}/workspaces/${workspaceId}/threads`)
      expect(status).toBe(200)
      expect(data).toHaveLength(1)
      expect(data[0].id).toBe(threadId)
    })

    it('GET /workspaces/:id — detail shows thread count', async () => {
      const { data } = await get(`${API(port)}/workspaces/${workspaceId}`)
      expect(data.totalThreads).toBe(1)
      expect(data.activeThreads).toBe(1)
      expect(data.profiles).toHaveLength(1)
      expect(data.profiles[0].profileId).toBe('test-agent')
    })
  })

  // ── Dashboard ──────────────────────────────────────────────────────

  describe('Dashboard endpoint', () => {
    it('GET /dashboard — returns stats', async () => {
      const { status, data } = await get(`${API(port)}/dashboard`)
      expect(status).toBe(200)
      expect(data).toHaveProperty('activeAgents')
      expect(data).toHaveProperty('todayRuns')
      expect(data).toHaveProperty('todayCost')
      expect(data).toHaveProperty('workspaceCount')
      expect(data).toHaveProperty('byProfile')
      expect(data).toHaveProperty('byWorkspace')
      expect(data.workspaceCount).toBeGreaterThanOrEqual(1)
    })
  })

  // ── Profiles ───────────────────────────────────────────────────────

  describe('Profile endpoints', () => {
    it('GET /profiles — lists discovered profiles', async () => {
      const { status, data } = await get(`${API(port)}/profiles`)
      expect(status).toBe(200)
      expect(Array.isArray(data)).toBe(true)
      const testProfile = data.find((p: any) => p.id === 'test-agent' || p.name === 'test-agent')
      expect(testProfile).toBeDefined()
    })
  })

  // ── Workspace delete ───────────────────────────────────────────────

  describe('Workspace deletion', () => {
    it('DELETE /workspaces/:id — removes workspace, threads survive', async () => {
      const proj = join(tmpDir, 'delete-test')
      mkdirSync(proj)
      const { data: ws } = await post(`${API(port)}/workspaces`, { path: proj })
      const { data: thread } = await post(`${API(port)}/threads`, {
        profileId: 'test-agent',
        workspaceId: ws.id,
      })

      const { status } = await del(`${API(port)}/workspaces/${ws.id}`)
      expect(status).toBe(204)

      // Workspace gone
      const { status: wsStatus } = await get(`${API(port)}/workspaces/${ws.id}`)
      expect(wsStatus).toBe(404)

      // Thread still exists, workspace link nullified
      const { data: survivedThread } = await get(`${API(port)}/threads/${thread.id}`)
      expect(survivedThread.workspaceId).toBeNull()
    })
  })
})
