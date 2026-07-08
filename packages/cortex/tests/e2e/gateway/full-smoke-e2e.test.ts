/**
 * FULL SMOKE TEST — Integration verification for ALL gateway endpoints.
 *
 * Hits every registered route with a real OwnwareGateway, real SQLite,
 * real HTTP. Verifies status codes and response shapes.
 *
 * Does NOT test SSE streaming with real LLM calls — those are in
 * battle-test.test.ts which uses ANTHROPIC_API_KEY.
 *
 * This test is deterministic and fast (no external API calls).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { join } from 'node:path'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let gateway: OwnwareGateway
let token: string
let tempDir: string
let dbPath: string
let workspaceDir: string
const baseUrl = () => `http://127.0.0.1:${gateway.port}`

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cortex-smoke-'))
  dbPath = join(tempDir, 'smoke.db')

  // Create profile
  const profileDir = join(tempDir, 'profiles', 'smoke-bot')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'agent.json'), JSON.stringify({
    name: 'smoke-bot',
    description: 'Smoke test agent',
    model: 'anthropic:claude-haiku-4-5-20251001',
    tools: { preset: 'none' },
    context: { cwd: false, datetime: false },
  }))
  await writeFile(join(profileDir, 'SOUL.md'), '# Smoke Bot\nTest agent.')

  // Create a workspace dir with files
  workspaceDir = join(tempDir, 'workspace')
  await mkdir(join(workspaceDir, 'src'), { recursive: true })
  await writeFile(join(workspaceDir, 'README.md'), '# Smoke Test Workspace')
  await writeFile(join(workspaceDir, 'src', 'index.ts'), 'export {}')

  // Gateway Test Isolation (package CLAUDE.md): pass BOTH profilesDir AND
  // dataDir. Without dataDir the gateway defaults to ~/.ownware and every
  // profile created via the API leaks into the user's real system.
  gateway = new OwnwareGateway({
    port: 0,
    profilesDir: join(tempDir, 'profiles'),
    dataDir: join(tempDir, 'data'),
    dbPath,
    disableAuth: false,
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

async function post(path: string, data?: unknown): Promise<{ status: number; body: any }> {
  return json(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: data !== undefined ? JSON.stringify(data) : undefined,
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

// ═══════════════════════════════════════════════════════════════════════
// AUTH ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════

describe('auth enforcement', () => {
  const protectedRoutes = [
    '/api/v1/profiles',
    '/api/v1/threads',
    '/api/v1/workspaces',
    '/api/v1/dashboard',
    '/api/v1/settings',
    '/api/v1/providers',
    '/api/v1/search?q=test',
    '/api/v1/app/version',
    '/api/v1/connectivity',
    '/api/v1/storage/stats',
    // T21 (2026-04-22): /api/v1/tools/catalog removed — replaced by
    // /api/v1/catalog?source=builtin (which is also auth-protected).
    '/api/v1/catalog?source=builtin',
    '/api/v1/models',
  ]

  it('all protected routes return 401 without token', async () => {
    for (const path of protectedRoutes) {
      const res = await fetch(`${baseUrl()}${path}`)
      expect(res.status, `${path} should require auth`).toBe(401)
    }
  })

  it('all protected routes return 401 with wrong token', async () => {
    for (const path of protectedRoutes) {
      const res = await fetch(`${baseUrl()}${path}`, {
        headers: { Authorization: 'Bearer wrong-token' },
      })
      expect(res.status, `${path} should reject wrong token`).toBe(401)
    }
  })

  it('/api/v1/health is exempt from auth', async () => {
    const res = await fetch(`${baseUrl()}/api/v1/health`)
    expect(res.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// HEALTH & META
// ═══════════════════════════════════════════════════════════════════════

describe('health & meta endpoints', () => {
  it('GET /health → 200 with status field', async () => {
    const { status, body } = await json('/api/v1/health')
    expect(status).toBe(200)
    expect(body.status).toBe('ok')
    expect(typeof body.uptime).toBe('number')
  })

  it('GET /app/version → 200 with version + runtime + platform', async () => {
    const { status, body } = await json('/api/v1/app/version')
    expect(status).toBe(200)
    expect(body.version).toBeTruthy()
    expect(body.runtime).toMatch(/^(node|bun)$/)
    expect(body.platform).toBeTruthy()
  })

  it('GET /connectivity → 200 with providers array', async () => {
    const { status, body } = await json('/api/v1/connectivity')
    expect(status).toBe(200)
    expect(Array.isArray(body.providers)).toBe(true)
    expect(body.providers.length).toBeGreaterThan(0)
    for (const p of body.providers) {
      expect(p.provider).toBeTruthy()
      expect(typeof p.reachable).toBe('boolean')
    }
  }, 15_000)
})

// ═══════════════════════════════════════════════════════════════════════
// PROFILES
// ═══════════════════════════════════════════════════════════════════════

describe('profiles endpoints', () => {
  it('GET /profiles → 200 array including smoke-bot with metadata fields', async () => {
    const { status, body } = await json('/api/v1/profiles')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    const smoke = body.find((p: any) => p.id === 'smoke-bot')
    expect(smoke).toBeTruthy()
    // Metadata fields exist
    expect('icon' in smoke).toBe(true)
    expect('color' in smoke).toBe(true)
    expect('category' in smoke).toBe(true)
    expect('useCount' in smoke).toBe(true)
    expect('totalCost' in smoke).toBe(true)
    expect('lastUsedAt' in smoke).toBe(true)
    expect('isLive' in smoke).toBe(true)
    expect('helperCount' in smoke).toBe(true)
  })

  it('GET /profiles/:id → 200 with full ProfileDetail', async () => {
    const { status, body } = await json('/api/v1/profiles/smoke-bot')
    expect(status).toBe(200)
    expect(body.id).toBe('smoke-bot')
    expect(body.config).toBeTruthy()
    expect(body.soulMd).toBeTruthy()
    expect(body.path).toBeTruthy()
    expect(Array.isArray(body.skills)).toBe(true)
  })

  it('GET /profiles/nonexistent → 404', async () => {
    const { status } = await json('/api/v1/profiles/no-such-profile')
    expect(status).toBe(404)
  })

  it('POST /profiles → 201 + DELETE → 204 + GET → 404', async () => {
    // productId is required since slice-08 of product-base-shift; only the
    // 'ownware' product is profilePolicy 'open' (closed products 403 creates).
    const { status: createStatus } = await post('/api/v1/profiles', {
      name: 'temp-smoke-profile',
      description: 'Will be deleted',
      productId: 'ownware',
    })
    expect(createStatus).toBe(201)

    const { status: delStatus } = await del('/api/v1/profiles/temp-smoke-profile')
    expect(delStatus).toBe(204)

    const { status: goneStatus } = await json('/api/v1/profiles/temp-smoke-profile')
    expect(goneStatus).toBe(404)
  })

  it('POST /profiles with invalid name → 400', async () => {
    const { status } = await post('/api/v1/profiles', { name: 'Invalid Name' })
    expect(status).toBe(400)
  })

  it('POST /profiles with duplicate name → 409', async () => {
    // productId must be present + valid so the request reaches the
    // name-conflict check (missing productId 400s first).
    const { status } = await post('/api/v1/profiles', { name: 'smoke-bot', productId: 'ownware' })
    expect(status).toBe(409)
  })

  it('PUT /profiles/:id with metadata → 200 (saves icon, color, category)', async () => {
    const { status } = await put('/api/v1/profiles/smoke-bot', {
      icon: 'star',
      color: '#7C5CFC',
      category: 'testing',
    })
    expect(status).toBe(200)

    // Verify metadata persisted
    const { body } = await json('/api/v1/profiles')
    const smoke = body.find((p: any) => p.id === 'smoke-bot')
    expect(smoke.icon).toBe('star')
    expect(smoke.color).toBe('#7C5CFC')
    expect(smoke.category).toBe('testing')
  })

  it('POST /profiles/:id/duplicate → 201 with copy', async () => {
    // Create a profile to duplicate (in the open 'ownware' product — closed
    // products reject both creates and duplicates with 403)
    await post('/api/v1/profiles', { name: 'dupe-source', description: 'src', productId: 'ownware' })

    const { status, body } = await post('/api/v1/profiles/dupe-source/duplicate', {})
    expect(status).toBe(201)
    expect(body.id).toBe('dupe-source-copy')

    // Cleanup
    await del('/api/v1/profiles/dupe-source')
    await del('/api/v1/profiles/dupe-source-copy')
  })

  it('GET /profiles/:id/files → 200 array', async () => {
    const { status, body } = await json('/api/v1/profiles/smoke-bot/files')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body.some((f: any) => f.name === 'agent.json')).toBe(true)
  })

  it('POST /profiles/:id/files → uploads file', async () => {
    const { status } = await post('/api/v1/profiles/smoke-bot/files', {
      type: 'skill',
      skillName: 'test-skill',
      content: '---\nname: test-skill\ndescription: A test\n---\nDo the thing.',
    })
    expect(status).toBe(200)
  })

  it('POST /profiles/:id/reload → 200', async () => {
    const { status, body } = await post('/api/v1/profiles/smoke-bot/reload', {})
    expect(status).toBe(200)
    expect(body.reloaded).toBe(true)
  })

  it('GET /profiles/:id/tools → 200', async () => {
    const { status, body } = await json('/api/v1/profiles/smoke-bot/tools')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
  })

  // T21 (2026-04-22): GET /api/v1/profiles/:id/mcp removed.
  //   → exercised through GET /api/v1/connectors?profileId=X&source=mcp.
})

// ═══════════════════════════════════════════════════════════════════════
// THREADS
// ═══════════════════════════════════════════════════════════════════════

describe('threads endpoints', () => {
  let threadId: string

  it('POST /threads → 201 returns full Thread', async () => {
    const { status, body } = await post('/api/v1/threads', {
      profileId: 'smoke-bot',
      title: 'Smoke Thread',
    })
    expect(status).toBe(201)
    expect(body.id).toMatch(/^thread_/)
    expect(body.profileId).toBe('smoke-bot')
    expect(body.title).toBe('Smoke Thread')
    expect(body.status).toBe('active')
    expect('lastMessagePreview' in body).toBe(true)
    threadId = body.id
  })

  it('GET /threads → 200 paginated { items, total, offset, limit }', async () => {
    const { status, body } = await json('/api/v1/threads')
    expect(status).toBe(200)
    expect(Array.isArray(body.items)).toBe(true)
    expect(typeof body.total).toBe('number')
    expect(typeof body.offset).toBe('number')
    expect(typeof body.limit).toBe('number')
  })

  it('GET /threads?profileId=smoke-bot → filtered', async () => {
    const { status, body } = await json('/api/v1/threads?profileId=smoke-bot')
    expect(status).toBe(200)
    expect(body.items.length).toBeGreaterThan(0)
    for (const t of body.items) {
      expect(t.profileId).toBe('smoke-bot')
    }
  })

  it('GET /threads/:id → 200 with messages array', async () => {
    const { status, body } = await json(`/api/v1/threads/${threadId}`)
    expect(status).toBe(200)
    expect(body.id).toBe(threadId)
    expect(Array.isArray(body.messages)).toBe(true)
  })

  it('GET /threads/:id/messages → 200 array', async () => {
    const { status, body } = await json(`/api/v1/threads/${threadId}/messages`)
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
  })

  it('PATCH /threads/:id → 200 updates fields', async () => {
    const { status, body } = await patch(`/api/v1/threads/${threadId}`, { title: 'Updated Smoke' })
    expect(status).toBe(200)
    expect(body.title).toBe('Updated Smoke')
  })

  it('GET /threads/:id/export?format=markdown → 200 text/markdown', async () => {
    const res = await api(`/api/v1/threads/${threadId}/export?format=markdown`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    const text = await res.text()
    expect(text).toContain('Updated Smoke')
  })

  it('GET /threads/:id/export?format=json → 200 with thread + messages', async () => {
    const { status, body } = await json(`/api/v1/threads/${threadId}/export?format=json`)
    expect(status).toBe(200)
    expect(body.thread).toBeTruthy()
    expect(Array.isArray(body.messages)).toBe(true)
  })

  it('PATCH /threads/:id with invalid status → 400', async () => {
    const { status } = await patch(`/api/v1/threads/${threadId}`, { status: 'bogus' })
    expect(status).toBe(400)
  })

  it('PATCH /threads/nonexistent → 404', async () => {
    const { status } = await patch('/api/v1/threads/thread_nonexistent', { title: 'x' })
    expect(status).toBe(404)
  })

  it('DELETE /threads/:id → 204', async () => {
    const { status } = await del(`/api/v1/threads/${threadId}`)
    expect(status).toBe(204)
  })

  it('DELETE /threads/nonexistent → 404', async () => {
    const { status } = await del('/api/v1/threads/thread_nonexistent')
    expect(status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// WORKSPACES
// ═══════════════════════════════════════════════════════════════════════

describe('workspaces endpoints', () => {
  let wsId: string

  it('POST /workspaces → 201 returns full Workspace', async () => {
    const { status, body } = await post('/api/v1/workspaces', {
      path: workspaceDir,
      name: 'Smoke WS',
    })
    expect(status).toBe(201)
    expect(body.id).toMatch(/^ws_/)
    expect(body.name).toBe('Smoke WS')
    wsId = body.id
  })

  it('POST /workspaces with nonexistent path → 400', async () => {
    const { status } = await post('/api/v1/workspaces', { path: '/nonexistent/path/abc' })
    expect(status).toBe(400)
  })

  it('GET /workspaces → 200 paginated', async () => {
    const { status, body } = await json('/api/v1/workspaces')
    expect(status).toBe(200)
    expect(Array.isArray(body.items)).toBe(true)
    expect(typeof body.total).toBe('number')
  })

  it('GET /workspaces/:id → 200 WorkspaceDetail with profiles + counts', async () => {
    const { status, body } = await json(`/api/v1/workspaces/${wsId}`)
    expect(status).toBe(200)
    expect(body.id).toBe(wsId)
    expect(Array.isArray(body.profiles)).toBe(true)
    expect(typeof body.activeThreads).toBe('number')
    expect(typeof body.totalThreads).toBe('number')
  })

  it('PUT /workspaces/:id → 200 updates fields', async () => {
    const { status, body } = await put(`/api/v1/workspaces/${wsId}`, {
      name: 'Renamed WS',
      pinned: true,
    })
    expect(status).toBe(200)
    expect(body.name).toBe('Renamed WS')
    expect(body.pinned).toBe(true)
  })

  it('GET /workspaces/:id/threads → 200 array', async () => {
    const { status, body } = await json(`/api/v1/workspaces/${wsId}/threads`)
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
  })

  // (browse removed with the legacy desktop shell)
})

// (The desktop pane + file-tree e2e section was removed with the legacy
// desktop shell.)

// ═══════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════

describe('dashboard endpoints', () => {
  it('GET /dashboard → 200 backward-compat stats', async () => {
    const { status, body } = await json('/api/v1/dashboard')
    expect(status).toBe(200)
    expect(typeof body.activeAgents).toBe('number')
    expect(typeof body.todayRuns).toBe('number')
    expect(typeof body.todayCost).toBe('number')
  })

  it('GET /dashboard/kpis → 200', async () => {
    const { status, body } = await json('/api/v1/dashboard/kpis')
    expect(status).toBe(200)
    expect(body.range).toBeTruthy()
    expect(Array.isArray(body.cards)).toBe(true)
  })

  it('GET /dashboard/usage-chart → 200', async () => {
    const { status, body } = await json('/api/v1/dashboard/usage-chart')
    expect(status).toBe(200)
    expect(Array.isArray(body.buckets) || Array.isArray(body.points) || Array.isArray(body)).toBe(true)
  })

  it('GET /dashboard/profile-breakdown → 200 array', async () => {
    const { status, body } = await json('/api/v1/dashboard/profile-breakdown')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
  })

  it('GET /dashboard/recent-activity → 200 array', async () => {
    const { status, body } = await json('/api/v1/dashboard/recent-activity')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
  })

  it('GET /activity → 200', async () => {
    const { status, body } = await json('/api/v1/activity')
    expect(status).toBe(200)
    expect(body).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// SETTINGS, PROVIDERS, SEARCH, ONBOARDING
// ═══════════════════════════════════════════════════════════════════════

describe('settings + providers + search + onboarding', () => {
  it('PUT /settings/appearance → 200', async () => {
    const { status } = await put('/api/v1/settings/appearance', { theme: 'dark', density: 'compact' })
    expect(status).toBe(200)
  })

  it('GET /settings → 200 grouped by section', async () => {
    const { status, body } = await json('/api/v1/settings')
    expect(status).toBe(200)
    expect(body.appearance).toBeTruthy()
    expect(body.appearance.theme).toBe('dark')
    expect(body.appearance.density).toBe('compact')
  })

  // Providers are a fixed catalog now (anthropic / openai / google /
  // openrouter — see gateway/llm-providers.ts); arbitrary provider names
  // 400 on save. Keys land in the credentials vault of the isolated test
  // DB, never the user's real store.
  it('POST /providers → 200 + GET /providers → has it', async () => {
    const { status: postStatus } = await post('/api/v1/providers', {
      provider: 'openrouter',
      key: 'sk-smoke-test-12345678',
    })
    expect(postStatus).toBe(200)

    const { body } = await json('/api/v1/providers')
    expect(body.find((p: any) => p.provider === 'openrouter')).toBeTruthy()
  })

  it('GET /providers/:provider/key → 200 returns full key', async () => {
    const { status, body } = await json('/api/v1/providers/openrouter/key')
    expect(status).toBe(200)
    expect(body.key).toBe('sk-smoke-test-12345678')
  })

  it('DELETE /providers/:provider → 204', async () => {
    const { status } = await del('/api/v1/providers/openrouter')
    expect(status).toBe(204)
  })

  it('GET /search?q=smoke → 200 array', async () => {
    const { status, body } = await json('/api/v1/search?q=smoke')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
  })

  // Onboarding-wizard endpoint tests removed — the legacy desktop first-run
  // endpoints /api/v1/onboarding/{role,complete} were deleted from the gateway.
})

// ═══════════════════════════════════════════════════════════════════════
// MCP, CATALOG, SESSION
// ═══════════════════════════════════════════════════════════════════════

describe('mcp + catalog + session', () => {
  // T21 (2026-04-22): /mcp/featured, /mcp/servers, /tools/catalog removed.
  //   → all three replaced by /api/v1/catalog (with source/featured filters)
  //     and /api/v1/connectors (per-profile + cross-profile).

  it('GET /catalog → 200 with items array', async () => {
    const { status, body } = await json('/api/v1/catalog?source=builtin')
    expect(status).toBe(200)
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.items.length).toBeGreaterThan(0)
  })

  it('GET /models → 200', async () => {
    const { status, body } = await json('/api/v1/models')
    expect(status).toBe(200)
    expect(body).toBeTruthy()
  })

  // /session/{state,restore} tests removed — the legacy desktop
  // crash-restore endpoints were deleted from the gateway.
})

// ═══════════════════════════════════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════════════════════════════════

describe('storage endpoints', () => {
  it('GET /storage/stats → 200 with sizes', async () => {
    const { status, body } = await json('/api/v1/storage/stats')
    expect(status).toBe(200)
    expect(body).toBeTruthy()
  })

  it('POST /storage/clear-cache → 200', async () => {
    const { status } = await post('/api/v1/storage/clear-cache', {})
    expect(status).toBe(200)
  })

  it('POST /data/export → 200', async () => {
    const { status } = await post('/api/v1/data/export', {})
    expect(status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// EDGE CASES + ERROR CONSISTENCY
// ═══════════════════════════════════════════════════════════════════════

describe('edge cases + error format', () => {
  it('GET nonexistent route → 404', async () => {
    const { status } = await json('/api/v1/no-such-endpoint')
    expect(status).toBe(404)
  })

  it('error responses have { error, message } format', async () => {
    const { body } = await json('/api/v1/profiles/nonexistent-xyz')
    expect(body.error).toBeTruthy()
    expect(body.message).toBeTruthy()
  })

  it('POST /run with empty prompt → 400', async () => {
    const { status } = await post('/api/v1/run', { prompt: '' })
    expect(status).toBe(400)
  })

  it('POST /run with nonexistent profileId → 404', async () => {
    const { status } = await post('/api/v1/run', {
      prompt: 'test',
      profileId: 'no-such-profile-xyz',
    })
    expect(status).toBe(404)
  })

  it('malformed JSON → 400', async () => {
    const res = await api('/api/v1/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })

  it('path traversal in profile id → 400', async () => {
    const { status } = await json('/api/v1/profiles/foo;bar')
    expect(status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// SQLITE INTEGRITY
// ═══════════════════════════════════════════════════════════════════════

describe('SQLite integrity', () => {
  it('database file exists', () => {
    expect(existsSync(dbPath)).toBe(true)
  })

  it('integrity_check returns ok', () => {
    const db = new Database(dbPath, { readonly: true })
    const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>
    db.close()
    expect(result[0]!.integrity_check).toBe('ok')
  })

  it('all expected tables exist', () => {
    const db = new Database(dbPath, { readonly: true })
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>).map(r => r.name)
    db.close()

    // Provider keys live in the credentials vault (migration 015), not a
    // dedicated provider_keys table. Legacy desktop tables (workspace_panes,
    // designs, boards, thread_edits…) were dropped by migrations 049/050.
    const expectedTables = [
      '_migrations',
      'app_state',
      'audit_log',
      'credentials',
      'local_profile',
      'mcp_servers',
      'messages',
      'profile_mcp_servers',
      'profile_metadata',
      'threads',
      'usage_records',
      'user_settings',
      'workspace_profiles',
      'workspaces',
    ]

    for (const t of expectedTables) {
      expect(tables, `table ${t} should exist`).toContain(t)
    }
  })

  it('migrations applied (version >= 4)', () => {
    const db = new Database(dbPath, { readonly: true })
    const max = db.prepare('SELECT MAX(version) as v FROM _migrations').get() as { v: number }
    db.close()
    expect(max.v).toBeGreaterThanOrEqual(4)
  })

  // (The workspace_panes FK-cascade test was removed with the pane substrate
  // — the table itself was dropped by migration 050.)
})

// ═══════════════════════════════════════════════════════════════════════
// DATA PERSISTENCE ACROSS RESTART
// ═══════════════════════════════════════════════════════════════════════

describe('data persistence across restart', () => {
  it('threads, settings, and provider keys survive gateway restart', async () => {
    // Seed data
    const { body: thread } = await post('/api/v1/threads', {
      profileId: 'smoke-bot',
      title: 'Persist Test',
    })
    const threadId = thread.id

    await put('/api/v1/settings/persist-test', { key1: 'value-survives' })

    // 'google' (a real catalog provider — arbitrary names 400) so this
    // block doesn't couple to the openrouter key deleted above.
    await post('/api/v1/providers', {
      provider: 'google',
      key: 'sk-persist-test-12345',
    })

    // Stop + restart on same DB (same isolated dataDir — never ~/.ownware)
    await gateway.stop()
    gateway = new OwnwareGateway({
      port: 0,
      profilesDir: join(tempDir, 'profiles'),
      dataDir: join(tempDir, 'data'),
      dbPath,
    })
    await gateway.start()
    token = gateway.token

    // Verify thread survived
    const { status: tStatus, body: tBody } = await json(`/api/v1/threads/${threadId}`)
    expect(tStatus).toBe(200)
    expect(tBody.title).toBe('Persist Test')

    // Verify settings survived
    const { body: settings } = await json('/api/v1/settings')
    expect(settings['persist-test']?.key1).toBe('value-survives')

    // Verify provider key survived (and is decryptable)
    const { status: kStatus, body: kBody } = await json('/api/v1/providers/google/key')
    expect(kStatus).toBe(200)
    expect(kBody.key).toBe('sk-persist-test-12345')
  }, 15_000)
})
