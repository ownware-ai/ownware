/**
 * E2E tests for new CRUD endpoints.
 *
 * Starts a REAL OwnwareGateway and makes REAL HTTP requests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { join } from 'node:path'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let gateway: OwnwareGateway
let token: string
let tempDir: string
const baseUrl = () => `http://127.0.0.1:${gateway.port}`

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cortex-endpoints-e2e-'))
  const dbPath = join(tempDir, 'test.db')

  const profileDir = join(tempDir, 'profiles', 'test-agent')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'agent.json'), JSON.stringify({
    name: 'test-agent',
    description: 'Test agent for endpoints',
    model: 'anthropic:claude-sonnet-4-20250514',
    tools: { preset: 'none' },
    context: { cwd: false, datetime: false },
  }))
  await writeFile(join(profileDir, 'SOUL.md'), '# Test Agent\nYou are a test agent.')

  gateway = new OwnwareGateway({
    port: 0,
    profilesDir: join(tempDir, 'profiles'),
    // dataDir MUST be passed alongside profilesDir — without it the gateway
    // defaults to ~/.ownware and test writes (profiles, credentials) leak into
    // the user's real install (see package CLAUDE.md "Gateway Test Isolation").
    dataDir: join(tempDir, 'data'),
    dbPath,
  })
  await gateway.start()
  token = gateway.token
}, 15_000)

afterAll(async () => {
  await gateway?.stop()
  await rm(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function api(path: string, opts?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...opts?.headers },
  })
}

async function json(path: string, opts?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await api(path, opts)
  if (res.status === 204) return { status: 204, body: null }
  const body = await res.json()
  return { status: res.status, body }
}

async function post(path: string, data: unknown): Promise<{ status: number; body: any }> {
  return json(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

async function put(path: string, data: unknown): Promise<{ status: number; body: any }> {
  return json(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

async function patch(path: string, data: unknown): Promise<{ status: number; body: any }> {
  return json(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

async function del(path: string): Promise<{ status: number; body: any }> {
  return json(path, { method: 'DELETE' })
}

// ---------------------------------------------------------------------------
// Thread PATCH
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/threads/:threadId', () => {
  it('updates thread title', async () => {
    const { body: thread } = await post('/api/v1/threads', { profileId: 'test-agent' })
    const { status, body } = await patch(`/api/v1/threads/${thread.id}`, { title: 'Updated Title' })
    expect(status).toBe(200)
    expect(body.title).toBe('Updated Title')
  })

  it('updates thread status', async () => {
    const { body: thread } = await post('/api/v1/threads', { profileId: 'test-agent' })
    const { status, body } = await patch(`/api/v1/threads/${thread.id}`, { status: 'completed' })
    expect(status).toBe(200)
    expect(body.status).toBe('completed')
  })

  it('returns 404 for nonexistent thread', async () => {
    const { status } = await patch('/api/v1/threads/nonexistent', { title: 'X' })
    expect(status).toBe(404)
  })

  it('returns 400 for invalid body', async () => {
    const { body: thread } = await post('/api/v1/threads', { profileId: 'test-agent' })
    const { status } = await patch(`/api/v1/threads/${thread.id}`, { status: 'invalid-status' })
    expect(status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Thread Export
// ---------------------------------------------------------------------------

describe('GET /api/v1/threads/:threadId/export', () => {
  it('exports as markdown', async () => {
    const { body: thread } = await post('/api/v1/threads', { profileId: 'test-agent', title: 'Export Test' })
    const res = await api(`/api/v1/threads/${thread.id}/export?format=markdown`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    const text = await res.text()
    expect(text).toContain('# Export Test')
    expect(text).toContain('test-agent')
  })

  it('exports as JSON', async () => {
    const { body: thread } = await post('/api/v1/threads', { profileId: 'test-agent' })
    const { status, body } = await json(`/api/v1/threads/${thread.id}/export?format=json`)
    expect(status).toBe(200)
    expect(body.thread).toBeTruthy()
    expect(Array.isArray(body.messages)).toBe(true)
  })

  it('defaults to markdown', async () => {
    const { body: thread } = await post('/api/v1/threads', { profileId: 'test-agent' })
    const res = await api(`/api/v1/threads/${thread.id}/export`)
    expect(res.headers.get('content-type')).toContain('text/markdown')
  })

  it('returns 404 for nonexistent thread', async () => {
    const res = await api('/api/v1/threads/nonexistent/export')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('Settings endpoints', () => {
  it('PUT /settings/appearance → stores settings', async () => {
    const { status, body } = await put('/api/v1/settings/appearance', { theme: 'dark' })
    expect(status).toBe(200)
    expect(body.section).toBe('appearance')
    expect(body.settings.theme).toBe('dark')
  })

  it('GET /settings → returns grouped settings', async () => {
    const { status, body } = await json('/api/v1/settings')
    expect(status).toBe(200)
    expect(body.appearance).toBeTruthy()
    expect(body.appearance.theme).toBe('dark')
  })

  it('PUT /settings/appearance with more keys → preserves existing', async () => {
    await put('/api/v1/settings/appearance', { density: 'compact' })
    const { body } = await json('/api/v1/settings')
    expect(body.appearance.theme).toBe('dark')
    expect(body.appearance.density).toBe('compact')
  })
})

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

describe('Provider endpoints', () => {
  it('POST /providers → stores encrypted key', async () => {
    const { status, body } = await post('/api/v1/providers', {
      provider: 'anthropic',
      key: 'sk-ant-test-12345678',
    })
    expect(status).toBe(200)
    expect(body.provider).toBe('anthropic')
    expect(body.keyHint).toBeTruthy()
  })

  it('GET /providers → lists with keyHint', async () => {
    const { status, body } = await json('/api/v1/providers')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    const anthropic = body.find((p: any) => p.provider === 'anthropic')
    expect(anthropic).toBeTruthy()
    expect(anthropic.keyHint).toBeTruthy()
  })

  it('GET /providers/:provider/key → returns full decrypted key', async () => {
    const { status, body } = await json('/api/v1/providers/anthropic/key')
    expect(status).toBe(200)
    expect(body.key).toBe('sk-ant-test-12345678')
  })

  it('DELETE /providers/:provider → removes key', async () => {
    const { status } = await del('/api/v1/providers/anthropic')
    expect(status).toBe(204)

    // GET /providers always returns one row per known provider; a deleted
    // credential shows up as configured: false with no keyHint.
    const { body } = await json('/api/v1/providers')
    const anthropic = body.find((p: any) => p.provider === 'anthropic')
    expect(anthropic.configured).toBe(false)
    expect(anthropic.keyHint).toBeUndefined()
  })

  it('DELETE /providers/:provider → 404 for nonexistent', async () => {
    const { status } = await del('/api/v1/providers/nonexistent')
    expect(status).toBe(404)
  })

  it('GET /providers/:provider/key → 404 for nonexistent', async () => {
    const { status } = await json('/api/v1/providers/nonexistent/key')
    expect(status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe('GET /api/v1/search', () => {
  it('finds threads by title', async () => {
    await post('/api/v1/threads', { profileId: 'test-agent', title: 'Searchable Thread' })
    const { status, body } = await json('/api/v1/search?q=searchable')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    const threadResult = body.find((r: any) => r.type === 'thread' && r.name === 'Searchable Thread')
    expect(threadResult).toBeTruthy()
  })

  it('finds profiles by name', async () => {
    const { status, body } = await json('/api/v1/search?q=test-agent')
    expect(status).toBe(200)
    const profileResult = body.find((r: any) => r.type === 'profile')
    expect(profileResult).toBeTruthy()
  })

  it('returns empty for nonexistent query', async () => {
    const { status, body } = await json('/api/v1/search?q=zzzznonexistent99999')
    expect(status).toBe(200)
    expect(body).toHaveLength(0)
  })

  it('respects scope filter', async () => {
    const { status, body } = await json('/api/v1/search?q=test&scope=threads')
    expect(status).toBe(200)
    for (const r of body) {
      expect(r.type).toBe('thread')
    }
  })

  it('returns empty array for empty query', async () => {
    const { status, body } = await json('/api/v1/search?q=')
    expect(status).toBe(200)
    expect(body).toHaveLength(0)
  })
})

// (Onboarding-wizard endpoint tests removed — the legacy desktop first-run
// endpoints /api/v1/onboarding/{role,complete} were deleted from the gateway.)

// ---------------------------------------------------------------------------
// App Version
// ---------------------------------------------------------------------------

describe('GET /api/v1/app/version', () => {
  it('returns version info', async () => {
    const { status, body } = await json('/api/v1/app/version')
    expect(status).toBe(200)
    expect(body.version).toBe('0.1.0')
    expect(body.platform).toBeTruthy()
    expect(body.runtime).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

describe('GET /api/v1/connectivity', () => {
  it('returns providers array', async () => {
    const { status, body } = await json('/api/v1/connectivity')
    expect(status).toBe(200)
    expect(Array.isArray(body.providers)).toBe(true)
    expect(body.providers.length).toBeGreaterThan(0)
    for (const p of body.providers) {
      expect(p.provider).toBeTruthy()
      expect(typeof p.reachable).toBe('boolean')
    }
  })
})
