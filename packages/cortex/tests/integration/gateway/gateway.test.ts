/**
 * Integration tests for the Cortex Gateway.
 *
 * Starts a real HTTP server, hits every endpoint, verifies responses.
 * Tests that don't need an LLM API key run against the full server.
 * SSE streaming tests that need real model calls are in e2e/.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { resolve, join } from 'path'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// Setup — create gateway with temp profiles dir
// ---------------------------------------------------------------------------

let gateway: OwnwareGateway
let baseUrl: string
let tempProfilesDir: string
let tempDataDir: string

beforeAll(async () => {
  // Create temp profiles dir with a test profile
  tempProfilesDir = await mkdtemp(join(tmpdir(), 'cortex-gw-test-'))
  tempDataDir = await mkdtemp(join(tmpdir(), 'cortex-gw-data-'))
  const profileDir = join(tempProfilesDir, 'test-agent')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'agent.json'), JSON.stringify({
    name: 'test-agent',
    description: 'A test agent for gateway tests',
    model: 'anthropic:claude-sonnet-4-20250514',
    tools: { preset: 'coding', deny: ['shell_execute'] },
    context: { cwd: true, datetime: true },
    tags: ['test'],
  }))
  await writeFile(join(profileDir, 'SOUL.md'), '# Test Agent\n\nYou are a test agent.')
  await writeFile(join(profileDir, 'AGENTS.md'), '# Memory\n\nTest memory.')
  await mkdir(join(profileDir, 'skills'), { recursive: true })
  await writeFile(join(profileDir, 'skills', 'greet.md'), '---\nname: greet\ndescription: Greet the user\ntrigger: /greet\n---\nSay hello warmly.')

  // Also include the real example profile
  const exampleDir = resolve(import.meta.dirname, '../../../profiles')

  gateway = new OwnwareGateway({
    port: 0,
    profilesDir: tempProfilesDir,
    dataDir: tempDataDir,
    additionalProfileDirs: [exampleDir],
  })
  await gateway.start()
  baseUrl = `http://localhost:${gateway.port}`
}, 10_000)

afterAll(async () => {
  await gateway.stop()
  await rm(tempProfilesDir, { recursive: true, force: true })
  await rm(tempDataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${gateway.token}`, ...extra }
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: authHeaders() })
  const body = await res.json()
  return { status: res.status, body }
}

async function post(path: string, data?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    body: data !== undefined ? JSON.stringify(data) : undefined,
    headers: authHeaders(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
  })
  if (res.status === 204) return { status: 204, body: null }
  const body = await res.json()
  return { status: res.status, body }
}

async function put(path: string, data: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    body: JSON.stringify(data),
    headers: authHeaders({ 'Content-Type': 'application/json' }),
  })
  const body = await res.json()
  return { status: res.status, body }
}

async function del(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'DELETE', headers: authHeaders() })
  if (res.status === 204) return { status: 204, body: null }
  const body = await res.json()
  return { status: res.status, body }
}

async function patch(path: string, data: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
    headers: authHeaders({ 'Content-Type': 'application/json' }),
  })
  const body = await res.json()
  return { status: res.status, body }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('GET /api/v1/health', () => {
  it('returns ok status', async () => {
    const { status, body } = await get('/api/v1/health')
    expect(status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.version).toBe('0.1.0')
    expect(typeof body.uptime).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

describe('GET /api/v1/profiles', () => {
  it('returns list of profiles', async () => {
    const { status, body } = await get('/api/v1/profiles')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(1)

    const testAgent = body.find((p: any) => p.id === 'test-agent')
    expect(testAgent).toBeDefined()
    expect(testAgent.name).toBe('test-agent')
    expect(testAgent.description).toBe('A test agent for gateway tests')
    expect(testAgent.model).toBe('anthropic:claude-sonnet-4-20250514')
    expect(testAgent.tags).toContain('test')
  })

  it('includes profiles from additional dirs', async () => {
    // The shipping profiles/ dir is wired in as an additional dir; the
    // always-present `ownware` profile proves the extra dir was scanned.
    // (The old `example` profile no longer ships — it lives in
    // tests/fixtures/ for fixture use only.)
    const { body } = await get('/api/v1/profiles')
    const ownware = body.find((p: any) => p.id === 'ownware')
    expect(ownware).toBeDefined()
  })
})

describe('GET /api/v1/profiles/:profileId', () => {
  it('returns full profile detail', async () => {
    const { status, body } = await get('/api/v1/profiles/test-agent')
    expect(status).toBe(200)
    expect(body.id).toBe('test-agent')
    expect(body.name).toBe('test-agent')
    expect(body.soulMd).toContain('Test Agent')
    expect(body.agentsMd).toContain('Memory')
    expect(body.config).toBeDefined()
    expect(body.config.name).toBe('test-agent')
    expect(body.path).toBeTruthy()
  })

  it('includes skills', async () => {
    const { body } = await get('/api/v1/profiles/test-agent')
    expect(body.skills).toBeDefined()
    expect(body.skills.length).toBeGreaterThanOrEqual(1)
    expect(body.skills[0].name).toBe('greet')
  })

  it('returns 404 for unknown profile', async () => {
    const { status, body } = await get('/api/v1/profiles/nonexistent')
    expect(status).toBe(404)
    expect(body.error).toBe('not_found')
  })
})

describe('POST /api/v1/profiles/:profileId/reload', () => {
  it('reloads profile from disk', async () => {
    const { status, body } = await post('/api/v1/profiles/test-agent/reload')
    expect(status).toBe(200)
    expect(body.reloaded).toBe(true)
  })

  it('returns 404 for unknown profile', async () => {
    const { status } = await post('/api/v1/profiles/nonexistent/reload')
    expect(status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Profile CRUD
// ---------------------------------------------------------------------------

describe('POST /api/v1/profiles (create)', () => {
  afterEach(async () => {
    // Cleanup created profiles (POST writes to dataDir/profiles/, not profilesDir)
    try { await rm(join(tempDataDir, 'profiles', 'new-agent'), { recursive: true, force: true }) } catch {}
  })

  it('creates a new profile on disk', async () => {
    const { status, body } = await post('/api/v1/profiles', {
      name: 'new-agent',
      productId: 'ownware',
      description: 'A brand new agent',
      soulMd: '# New Agent\n\nYou are brand new.',
    })
    expect(status).toBe(201)
    expect(body.id).toBe('new-agent')
    expect(body.created).toBe(true)

    // Verify files on disk (POST writes to dataDir/profiles/)
    const agentJson = JSON.parse(await readFile(join(tempDataDir, 'profiles', 'new-agent', 'agent.json'), 'utf-8'))
    expect(agentJson.name).toBe('new-agent')
    expect(agentJson.productId).toBe('ownware')

    const soulMd = await readFile(join(tempDataDir, 'profiles', 'new-agent', 'SOUL.md'), 'utf-8')
    expect(soulMd).toContain('brand new')
  })

  it('rejects missing name', async () => {
    const { status } = await post('/api/v1/profiles', { description: 'no name' })
    expect(status).toBe(400)
  })

  it('rejects invalid name format', async () => {
    const { status } = await post('/api/v1/profiles', { name: 'Has Spaces!', productId: 'ownware' })
    expect(status).toBe(400)
  })

  it('rejects missing productId (slice-08 new requirement)', async () => {
    const { status } = await post('/api/v1/profiles', { name: 'no-pid' })
    expect(status).toBe(400)
  })

  it('rejects duplicate name', async () => {
    const { status } = await post('/api/v1/profiles', { name: 'test-agent', productId: 'ownware' })
    expect(status).toBe(409)
  })
})

describe('PUT /api/v1/profiles/:profileId (update)', () => {
  it('updates agent config on disk', async () => {
    const { status, body } = await put('/api/v1/profiles/test-agent', {
      config: { name: 'test-agent', description: 'Updated description' },
    })
    expect(status).toBe(200)
    expect(body.updated).toBe(true)

    // Verify change persisted
    const { body: detail } = await get('/api/v1/profiles/test-agent')
    expect(detail.config.description).toBe('Updated description')
  })

  it('updates SOUL.md', async () => {
    await put('/api/v1/profiles/test-agent', {
      soulMd: '# Updated Soul\n\nNew identity.',
    })

    const { body: detail } = await get('/api/v1/profiles/test-agent')
    expect(detail.soulMd).toContain('Updated Soul')

    // Restore original
    await put('/api/v1/profiles/test-agent', {
      soulMd: '# Test Agent\n\nYou are a test agent.',
    })
  })

  it('returns 404 for unknown profile', async () => {
    const { status } = await put('/api/v1/profiles/nonexistent', { config: {} })
    expect(status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Profile files
// ---------------------------------------------------------------------------

describe('POST /api/v1/profiles/:profileId/files', () => {
  it('uploads SOUL.md content', async () => {
    const { status, body } = await post('/api/v1/profiles/test-agent/files', {
      type: 'soul_md',
      content: '# File Upload Test\n\nUploaded via API.',
    })
    expect(status).toBe(200)
    expect(body.updated).toBe(true)

    // Restore
    await post('/api/v1/profiles/test-agent/files', {
      type: 'soul_md',
      content: '# Test Agent\n\nYou are a test agent.',
    })
  })

  it('uploads a skill file', async () => {
    const { status } = await post('/api/v1/profiles/test-agent/files', {
      type: 'skill',
      skillName: 'deploy',
      content: '---\nname: deploy\ndescription: Deploy app\ntrigger: /deploy\n---\nDeploy steps.',
    })
    expect(status).toBe(200)
  })

  it('rejects missing type', async () => {
    const { status } = await post('/api/v1/profiles/test-agent/files', {
      content: 'stuff',
    })
    expect(status).toBe(400)
  })

  it('rejects skill without skillName', async () => {
    const { status } = await post('/api/v1/profiles/test-agent/files', {
      type: 'skill',
      content: 'stuff',
    })
    expect(status).toBe(400)
  })
})

describe('GET /api/v1/profiles/:profileId/files', () => {
  it('lists all profile files', async () => {
    const { status, body } = await get('/api/v1/profiles/test-agent/files')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)

    const names = body.map((f: any) => f.name)
    expect(names).toContain('agent.json')
    expect(names).toContain('SOUL.md')
    expect(names).toContain('AGENTS.md')
  })

  it('returns 404 for unknown profile', async () => {
    const { status } = await get('/api/v1/profiles/nonexistent/files')
    expect(status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

describe('POST /api/v1/threads', () => {
  it('creates a thread', async () => {
    const { status, body } = await post('/api/v1/threads', { profileId: 'test-agent', title: 'Test Chat' })
    expect(status).toBe(201)
    expect(body.id).toMatch(/^thread_/)
    expect(body.profileId).toBe('test-agent')
    expect(body.title).toBe('Test Chat')
    expect(body.status).toBe('active')
    expect(body.messageCount).toBe(0)
  })

  it('creates a thread with default profile', async () => {
    const { status, body } = await post('/api/v1/threads', {})
    expect(status).toBe(201)
    expect(body.profileId).toBe('example')
  })
})

describe('GET /api/v1/threads', () => {
  it('lists threads', async () => {
    const { status, body } = await get('/api/v1/threads')
    expect(status).toBe(200)
    expect(Array.isArray(body.items)).toBe(true)
    expect(typeof body.total).toBe('number')
    expect(typeof body.offset).toBe('number')
    expect(typeof body.limit).toBe('number')
  })
})

describe('GET /api/v1/threads/:threadId', () => {
  it('returns thread with messages', async () => {
    const { body: created } = await post('/api/v1/threads', { profileId: 'test-agent' })
    const { status, body } = await get(`/api/v1/threads/${created.id}`)
    expect(status).toBe(200)
    expect(body.id).toBe(created.id)
    expect(body.messages).toEqual([])
  })

  it('returns 404 for unknown thread', async () => {
    const { status } = await get('/api/v1/threads/thread_nonexistent')
    expect(status).toBe(404)
  })
})

describe('DELETE /api/v1/threads/:threadId', () => {
  it('deletes a thread', async () => {
    const { body: created } = await post('/api/v1/threads', { profileId: 'test-agent' })
    const { status } = await del(`/api/v1/threads/${created.id}`)
    expect(status).toBe(204)

    // Verify gone
    const { status: getStatus } = await get(`/api/v1/threads/${created.id}`)
    expect(getStatus).toBe(404)
  })

  it('returns 404 for unknown thread', async () => {
    const { status } = await del('/api/v1/threads/thread_nonexistent')
    expect(status).toBe(404)
  })
})

describe('GET /api/v1/threads/:threadId/messages', () => {
  it('returns empty messages for new thread', async () => {
    const { body: created } = await post('/api/v1/threads', { profileId: 'test-agent' })
    const { status, body } = await get(`/api/v1/threads/${created.id}/messages`)
    expect(status).toBe(200)
    expect(body).toEqual([])
  })

  it('returns 404 for unknown thread', async () => {
    const { status } = await get('/api/v1/threads/thread_nope/messages')
    expect(status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe('GET /api/v1/profiles/:profileId/tools', () => {
  it('returns tools for a profile', async () => {
    const { status, body } = await get('/api/v1/profiles/test-agent/tools')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)

    // Each tool should have the right shape
    for (const tool of body) {
      expect(typeof tool.name).toBe('string')
      expect(typeof tool.description).toBe('string')
      expect(typeof tool.isReadOnly).toBe('boolean')
    }

    // shell_execute should be denied
    expect(body.find((t: any) => t.name === 'shell_execute')).toBeUndefined()
  })

  it('returns 404 for unknown profile', async () => {
    const { status } = await get('/api/v1/profiles/nonexistent/tools')
    expect(status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

// T21 (2026-04-22): GET /api/v1/tools/catalog removed.
//   → exercised via GET /api/v1/catalog?source=builtin in
//     tests/integration/gateway/catalog-endpoint.test.ts.

describe('GET /api/v1/models', () => {
  it('returns models catalog with credential status', async () => {
    const { status, body } = await get('/api/v1/models')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(5)

    for (const model of body) {
      expect(typeof model.id).toBe('string')
      expect(typeof model.name).toBe('string')
      expect(typeof model.provider).toBe('string')
      expect(typeof model.contextWindow).toBe('number')
      expect(typeof model.hasCredentials).toBe('boolean')
    }

    // `hasCredentials` counts vault keys AND env keys — loom registers
    // providers from the environment at boot, so an exported key means
    // runs genuinely work. The test env seeds dummy ANTHROPIC/OPENAI/
    // GOOGLE keys (tests/setup/env.ts), so those flag as available.
    const anthropic = body.find((m: any) => m.provider === 'anthropic')
    expect(anthropic?.hasCredentials).toBe(true)
    // OpenRouter is seeded with no dummy key by the test setup, so its
    // availability tracks the actual environment: false in a bare run,
    // true when the developer sourced a real .env for the key lane.
    const openrouter = body.find((m: any) => m.provider === 'openrouter')
    expect(openrouter?.hasCredentials).toBe(Boolean(process.env['OPENROUTER_API_KEY']))
  })
})

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

describe('MCP server management', () => {
  // T21 (2026-04-22): the cross-profile GET /api/v1/mcp/servers and the
  // per-profile GET /api/v1/profiles/:id/mcp listings were removed.
  // The client reads both surfaces through `/api/v1/connectors[?profileId]`
  // — coverage lives in tests/unit/connector/registry.test.ts and
  // tests/integration/gateway/catalog-endpoint.test.ts.

  it('checks credentials for unknown server', async () => {
    const { status, body } = await get('/api/v1/mcp/credentials/nonexistent-server')
    expect(status).toBe(200)
    expect(body.serverId).toBe('nonexistent-server')
    expect(Array.isArray(body.envStatus)).toBe(true)
  })

  it('saves and checks credentials', async () => {
    const saveResult = await post('/api/v1/mcp/credentials/test-server', {
      env: { API_KEY: 'test123' },
    })
    expect(saveResult.status).toBe(200)
    expect(saveResult.body.saved).toBe(1)

    // Clean up
    const { status } = await del('/api/v1/mcp/credentials/test-server')
    expect(status).toBe(204)
  })
})

// ---------------------------------------------------------------------------
// Run — error cases (no API key needed)
// ---------------------------------------------------------------------------

describe('POST /api/v1/run (validation)', () => {
  it('rejects missing prompt', async () => {
    const { status } = await post('/api/v1/run', { profileId: 'test-agent' })
    expect(status).toBe(400)
  })

  it('returns 404 for unknown profile', async () => {
    const { status } = await post('/api/v1/run', {
      prompt: 'hello',
      profileId: 'nonexistent-profile',
    })
    expect(status).toBe(404)
  })

  it('returns 404 for unknown thread', async () => {
    const { status } = await post('/api/v1/run', {
      prompt: 'hello',
      threadId: 'thread_nonexistent',
    })
    expect(status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe('POST /api/v1/threads/:threadId/abort', () => {
  it('returns 404 for thread with no session', async () => {
    const { body: thread } = await post('/api/v1/threads', { profileId: 'test-agent' })
    const { status } = await post(`/api/v1/threads/${thread.id}/abort`)
    expect(status).toBe(404) // No active session
  })
})

// ---------------------------------------------------------------------------
// 404 for unknown routes
// ---------------------------------------------------------------------------

describe('unknown routes', () => {
  it('returns 404 for completely unknown paths', async () => {
    const { status } = await get('/api/v1/not-a-real-endpoint')
    expect(status).toBe(404)
  })

  it('returns 404 for wrong methods', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`, { method: 'DELETE' })
    const body = await res.json()
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

describe('CORS', () => {
  it('handles preflight OPTIONS', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`, {
      method: 'OPTIONS',
      headers: { Origin: `http://localhost:${gateway.port}` },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(`http://localhost:${gateway.port}`)
  })

  it('includes CORS headers on normal responses', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { Origin: `http://localhost:${gateway.port}` },
    })
    expect(res.headers.get('access-control-allow-origin')).toBe(`http://localhost:${gateway.port}`)
  })
})

// ---------------------------------------------------------------------------
// Workspace history (post-1b.9)
//
// The legacy /workspaces/:id/tabs surface was removed in slice 1b.9
// (migration 025 dropped workspace_tabs). Open-view state now lives
// in workspace_panes — covered exhaustively by the panes contract +
// migration suites under tests/framework/contracts/panes.contract.ts
// and tests/integration/gateway/{migration-024-workspace-panes,
// workspace-panes-db,migration-025-drop-workspace-tabs}.test.ts.
//
// What survives here are the history-drawer flows that 1b.9 rewired
// to JOIN workspace_panes for the `hasOpenTab` flag.
// ---------------------------------------------------------------------------

describe('workspace history', () => {
  let wsId: string
  let wsDir: string

  beforeAll(async () => {
    wsDir = await mkdtemp(join(tmpdir(), 'cortex-history-test-'))
    const { status, body } = await post('/api/v1/workspaces', {
      path: wsDir,
      name: 'history-test',
    })
    expect([200, 201]).toContain(status)
    wsId = body.id
  })

  afterAll(async () => {
    await rm(wsDir, { recursive: true, force: true })
  })

  it('flags hasOpenTab=true while a chat pane is open and false after closing it', async () => {
    // Seed: create a thread, then open a chat pane that wraps it.
    const { body: thread } = await post('/api/v1/threads', {
      workspaceId: wsId,
      profileId: 'test-agent',
      title: 'history-flag',
    })
    const { status: sCreate, body: paneRes } = await post(
      `/api/v1/workspaces/${wsId}/panes`,
      {
        config: { kind: 'chat', profileId: 'test-agent', threadId: thread.id },
        focused: true,
      },
    )
    expect([200, 201]).toContain(sCreate)
    const paneId = paneRes.pane.id

    // History flags the thread as having an open pane.
    const { status: sH1, body: h1 } = await get(`/api/v1/workspaces/${wsId}/history`)
    expect(sH1).toBe(200)
    const open = h1.items.find((e: any) => e.id === thread.id)
    expect(open).toBeTruthy()
    expect(open.hasOpenTab).toBe(true)
    expect(open.openTabId).toBe(paneId)

    // Close the pane → flag flips back, thread itself survives.
    const { status: sDel } = await del(`/api/v1/workspaces/${wsId}/panes/${paneId}`)
    expect(sDel).toBe(200)
    const { body: h2 } = await get(`/api/v1/workspaces/${wsId}/history`)
    const closed = h2.items.find((e: any) => e.id === thread.id)
    expect(closed).toBeTruthy()
    expect(closed.hasOpenTab).toBe(false)
    expect(closed.openTabId).toBeNull()
  })

  it('history search matches on title', async () => {
    await post('/api/v1/threads', {
      workspaceId: wsId,
      profileId: 'test-agent',
      title: 'super-unique-marker',
    })
    const { status, body } = await get(
      `/api/v1/workspaces/${wsId}/history?search=super-unique`,
    )
    expect(status).toBe(200)
    expect(body.items.length).toBeGreaterThanOrEqual(1)
    expect(
      body.items.every((i: any) => (i.title ?? '').includes('super-unique')),
    ).toBe(true)
  })

  it('DELETE /threads/:id removes the thread, its chat pane, and its history entry', async () => {
    const { body: thread } = await post('/api/v1/threads', {
      workspaceId: wsId,
      profileId: 'test-agent',
      title: 'to-nuke',
    })
    await post(`/api/v1/workspaces/${wsId}/panes`, {
      config: { kind: 'chat', profileId: 'test-agent', threadId: thread.id },
      focused: true,
    })

    const { status: sDel } = await del(`/api/v1/threads/${thread.id}`)
    expect(sDel).toBe(204)

    const { status: sMissing } = await get(`/api/v1/threads/${thread.id}`)
    expect(sMissing).toBe(404)

    // The chat pane that wrapped this thread is gone too.
    const { body: panes } = await get(`/api/v1/workspaces/${wsId}/panes`)
    const stillThere = panes.items.find(
      (p: any) => p.kind === 'chat' && p.config?.threadId === thread.id,
    )
    expect(stillThere).toBeUndefined()

    // And history forgets the thread entirely.
    const { body: hist } = await get(`/api/v1/workspaces/${wsId}/history`)
    expect(hist.items.find((i: any) => i.id === thread.id)).toBeUndefined()
  })
})
