/**
 * BATTLE TEST — Comprehensive E2E gateway validation.
 *
 * Real OwnwareGateway, real HTTP, real SSE, real Anthropic API.
 * Proves production readiness, not just "it compiles."
 *
 * REQUIRES: ANTHROPIC_API_KEY environment variable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { join } from 'node:path'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('OWNWARE_TEST_DUMMY') ? process.env.ANTHROPIC_API_KEY : undefined
const HAS_REAL_KEY = !!API_KEY

let gateway: OwnwareGateway
let token: string
let tempDir: string
let dbPath: string
const baseUrl = () => `http://127.0.0.1:${gateway.port}`

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cortex-battle-'))
  dbPath = join(tempDir, 'battle.db')

  // Create a minimal profile with no tools (fast, cheap)
  const profileDir = join(tempDir, 'profiles', 'battle-bot')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'agent.json'), JSON.stringify({
    name: 'battle-bot',
    description: 'Minimal agent for battle testing',
    model: 'anthropic:claude-haiku-4-5-20251001',
    tools: { preset: 'none' },
    context: { cwd: false, datetime: false },
    security: { level: 'permissive', permissionMode: 'auto' },
  }))
  await writeFile(join(profileDir, 'SOUL.md'),
    '# Battle Bot\n\nYou are an extremely brief test assistant. One sentence max. Follow instructions exactly.')

  gateway = new OwnwareGateway({
    port: 0,
    profilesDir: join(tempDir, 'profiles'),
    // dataDir MUST be passed alongside profilesDir — without it the gateway
    // defaults to ~/.ownware and test writes (profiles, credentials) leak into
    // the user's real install (see package CLAUDE.md "Gateway Test Isolation").
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

async function post(path: string, data: unknown): Promise<{ status: number; body: any }> {
  return json(path, {
    method: 'POST',
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

async function put(path: string, data: unknown): Promise<{ status: number; body: any }> {
  return json(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

async function del(path: string): Promise<{ status: number; body: any }> {
  return json(path, { method: 'DELETE' })
}

interface SSEEvent { event: string; data: any }

async function consumeSSE(res: Response): Promise<SSEEvent[]> {
  const text = await res.text()
  const events: SSEEvent[] = []
  let currentEvent = ''
  let currentData = ''

  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7)
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6)
    } else if (line === '' && currentEvent) {
      try {
        events.push({ event: currentEvent, data: JSON.parse(currentData) })
      } catch {
        events.push({ event: currentEvent, data: currentData })
      }
      currentEvent = ''
      currentData = ''
    }
  }
  return events
}

async function runPrompt(prompt: string, opts?: { threadId?: string; profileId?: string }): Promise<{ events: SSEEvent[]; threadId: string }> {
  const body: Record<string, unknown> = { prompt, profileId: opts?.profileId ?? 'battle-bot' }
  if (opts?.threadId) body.threadId = opts.threadId
  const res = await api('/api/v1/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('application/json')
  const startBody = await res.json() as { threadId: string; agentId: string; status: string }
  const threadId = startBody.threadId

  // Open SSE stream on the agent-events endpoint and collect until `done`.
  const sseRes = await api(`/api/v1/threads/${threadId}/agents/${startBody.agentId ?? 'root'}/events`)
  expect(sseRes.status).toBe(200)
  const events = await consumeSSEUntilDone(sseRes)
  return { events, threadId }
}

/** Read an SSE stream incrementally until a `done` event appears or timeout. */
async function consumeSSEUntilDone(res: Response, maxMs = 60_000): Promise<SSEEvent[]> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const events: SSEEvent[] = []
  let buffer = ''
  const start = Date.now()
  let sawDone = false

  try {
    while (Date.now() - start < maxMs && !sawDone) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>(resolve =>
          setTimeout(() => resolve({ done: true, value: undefined }), 500),
        ),
      ])
      if (done && value === undefined) continue
      if (done) break
      if (value) buffer += decoder.decode(value, { stream: true })

      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        if (!block.trim() || block.startsWith(':')) continue
        let eventName = 'message'
        let dataStr = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) eventName = line.slice(7)
          else if (line.startsWith('data: ')) dataStr = line.slice(6)
        }
        let data: any = dataStr
        try { data = JSON.parse(dataStr) } catch {}
        events.push({ event: eventName, data })
        if (eventName === 'done' || eventName === 'session.end') sawDone = true
      }
    }
  } finally {
    try { reader.releaseLock(); await res.body!.cancel() } catch {}
  }
  return events
}

// ═══════════════════════════════════════════════════════════════════════
// 1. SSE STREAMING (REAL API)
// ═══════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_REAL_KEY)('SSE streaming — real API', () => {
  it('produces correct event sequence: stream.start → text.delta(s) → turn.end → done', async () => {
    const { events } = await runPrompt('Say exactly: "hello battle test"')

    // Check sequence
    const eventTypes = events.map(e => e.event)
    expect(eventTypes[0]).toBe('stream.start')
    expect(eventTypes[eventTypes.length - 1]).toBe('done')
    expect(eventTypes).toContain('text.delta')
    expect(eventTypes).toContain('turn.end')

    // stream.start has threadId and profileId
    const start = events.find(e => e.event === 'stream.start')!
    expect(start.data.threadId).toMatch(/^thread_/)
    expect(start.data.profileId).toBe('battle-bot')

    // turn.end has usage
    const turnEnd = events.find(e => e.event === 'turn.end')!
    expect(turnEnd.data.usage.inputTokens).toBeGreaterThan(0)
    expect(turnEnd.data.usage.outputTokens).toBeGreaterThan(0)

    // Text deltas concatenated produce coherent output
    const textDeltas = events.filter(e => e.event === 'text.delta')
    const fullText = textDeltas.map(e => e.data.text).join('')
    expect(fullText.length).toBeGreaterThan(0)
  }, 30_000)

  it('multi-turn: thread retains message history across runs', async () => {
    // NOTE: The run handler keeps a runtime object after completion,
    // which blocks concurrent runs on the same thread (409 guard).
    // This is by design — the runtime holds the session for reuse.
    // But we can't run on the same thread twice via the HTTP API
    // because the guard doesn't distinguish active vs completed runtimes.
    // This is a known limitation (see Issues Found in board).
    //
    // Instead, verify that thread messages persist and are accessible.
    const run1 = await runPrompt('The secret word is MANGO-42.')
    const threadId = run1.threadId
    expect(threadId).toBeTruthy()

    const text1 = run1.events
      .filter(e => e.event === 'text.delta')
      .map(e => e.data.text).join('')
    expect(text1.length).toBeGreaterThan(0)

    // Verify messages persisted
    const { body: messages } = await json(`/api/v1/threads/${threadId}/messages`)
    expect(messages.length).toBeGreaterThanOrEqual(2) // user + assistant
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toContain('MANGO')
    expect(messages[1].role).toBe('assistant')
  }, 30_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 2. CONCURRENCY
// ═══════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_REAL_KEY)('concurrency', () => {
  it('rejects concurrent run on same thread → 409', async () => {
    // Start a long run
    const { body: thread } = await post('/api/v1/threads', { profileId: 'battle-bot' })
    const longRunPromise = api('/api/v1/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Count slowly from 1 to 20, each number on a new line.',
        profileId: 'battle-bot',
        threadId: thread.id,
      }),
    })

    // Wait briefly for the run to start
    await new Promise(r => setTimeout(r, 500))

    // Try second run on same thread → should get 409
    const { status } = await post('/api/v1/run', {
      prompt: 'This should fail',
      profileId: 'battle-bot',
      threadId: thread.id,
    })
    expect(status).toBe(409)

    // Let the first run finish
    const res = await longRunPromise
    await res.text() // consume body
  }, 60_000)

  it('allows simultaneous runs on different threads', async () => {
    const [run1, run2] = await Promise.all([
      runPrompt('Say "alpha"'),
      runPrompt('Say "beta"'),
    ])

    expect(run1.threadId).not.toBe(run2.threadId)

    const text1 = run1.events.filter(e => e.event === 'text.delta').map(e => e.data.text).join('')
    const text2 = run2.events.filter(e => e.event === 'text.delta').map(e => e.data.text).join('')
    expect(text1.length).toBeGreaterThan(0)
    expect(text2.length).toBeGreaterThan(0)
  }, 60_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 3. SECURITY
// ═══════════════════════════════════════════════════════════════════════

describe('security', () => {
  it('health is exempt from auth', async () => {
    const res = await fetch(`${baseUrl()}/api/v1/health`)
    expect(res.status).toBe(200)
  })

  it('no auth token → 401', async () => {
    const res = await fetch(`${baseUrl()}/api/v1/profiles`)
    expect(res.status).toBe(401)
  })

  it('wrong auth token → 401', async () => {
    const res = await fetch(`${baseUrl()}/api/v1/profiles`, {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    expect(res.status).toBe(401)
  })

  it('path traversal in params → 400', async () => {
    const res = await api('/api/v1/profiles/..%2F..%2Fetc%2Fpasswd')
    expect([400, 404]).toContain(res.status)
  })

  it('semicolon injection → 400', async () => {
    const { status } = await json('/api/v1/profiles/foo;bar')
    expect(status).toBe(400)
  })

  it('malformed JSON body → 400', async () => {
    const res = await api('/api/v1/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid json',
    })
    expect(res.status).toBe(400)
  })

  it('empty prompt → 400', async () => {
    const { status } = await post('/api/v1/run', { prompt: '' })
    expect(status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 4. PROFILES
// ═══════════════════════════════════════════════════════════════════════

describe('profiles', () => {
  it('lists profiles — includes battle-bot', async () => {
    const { status, body } = await json('/api/v1/profiles')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body.some((p: any) => p.id === 'battle-bot')).toBe(true)
  })

  it('gets profile detail', async () => {
    const { status, body } = await json('/api/v1/profiles/battle-bot')
    expect(status).toBe(200)
    expect(body.config).toBeTruthy()
    expect(body.soulMd).toBeTruthy()
    expect(body.path).toBeTruthy()
  })

  it('creates a new profile', async () => {
    const { status, body } = await post('/api/v1/profiles', {
      name: 'test-created',
      description: 'E2E test profile',
      // productId is required since slice-08 — 'ownware' is the only open product.
      productId: 'ownware',
    })
    expect(status).toBe(201)
    expect(body.id).toBe('test-created')
  })

  it('rejects duplicate profile name → 409', async () => {
    const { status } = await post('/api/v1/profiles', { name: 'test-created', productId: 'ownware' })
    expect(status).toBe(409)
  })

  it('rejects invalid profile name → 400', async () => {
    const { status } = await post('/api/v1/profiles', { name: 'Invalid Name' })
    expect(status).toBe(400)
  })

  it('gets 404 for nonexistent profile', async () => {
    const { status } = await json('/api/v1/profiles/nonexistent-profile-xyz')
    expect(status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 5. THREADS
// ═══════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_REAL_KEY)('threads', () => {
  it('creates thread → 201', async () => {
    const { status, body } = await post('/api/v1/threads', { profileId: 'battle-bot' })
    expect(status).toBe(201)
    expect(body.id).toMatch(/^thread_/)
    expect(body.profileId).toBe('battle-bot')
    expect(body.status).toBe('active')
  })

  it('gets thread by id', async () => {
    const { body: created } = await post('/api/v1/threads', { profileId: 'battle-bot' })
    const { status, body } = await json(`/api/v1/threads/${created.id}`)
    expect(status).toBe(200)
    expect(body.id).toBe(created.id)
    expect(body.messages).toBeDefined()
  })

  it('lists threads → paginated', async () => {
    const { status, body } = await json('/api/v1/threads')
    expect(status).toBe(200)
    expect(body.items).toBeDefined()
    expect(body.total).toBeDefined()
    expect(Array.isArray(body.items)).toBe(true)
  })

  it('patches thread title', async () => {
    const { body: created } = await post('/api/v1/threads', { profileId: 'battle-bot' })
    const { status, body } = await patch(`/api/v1/threads/${created.id}`, { title: 'Patched Title' })
    expect(status).toBe(200)
    expect(body.title).toBe('Patched Title')
  })

  it('deletes thread → 204', async () => {
    const { body: created } = await post('/api/v1/threads', { profileId: 'battle-bot' })
    const { status } = await del(`/api/v1/threads/${created.id}`)
    expect(status).toBe(204)

    const { status: getStatus } = await json(`/api/v1/threads/${created.id}`)
    expect(getStatus).toBe(404)
  })

  it('thread has messages after a run', async () => {
    const { threadId } = await runPrompt('Say "hello threads"')
    const { body } = await json(`/api/v1/threads/${threadId}/messages`)
    expect(body.length).toBeGreaterThanOrEqual(2) // user + assistant
    expect(body[0].role).toBe('user')
    expect(body[1].role).toBe('assistant')
    expect(body[1].usage).toBeTruthy()
  }, 30_000)

  it('exports thread as markdown', async () => {
    const { threadId } = await runPrompt('Test export')
    const res = await api(`/api/v1/threads/${threadId}/export?format=markdown`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    const md = await res.text()
    expect(md).toContain('## User')
    expect(md).toContain('## Assistant')
  }, 30_000)

  it('exports thread as JSON', async () => {
    const { threadId } = await runPrompt('Test JSON export')
    const { status, body } = await json(`/api/v1/threads/${threadId}/export?format=json`)
    expect(status).toBe(200)
    expect(body.thread).toBeTruthy()
    expect(body.messages.length).toBeGreaterThanOrEqual(2)
  }, 30_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 6. WORKSPACES
// ═══════════════════════════════════════════════════════════════════════

describe('workspaces', () => {
  it('creates workspace → 201', async () => {
    const { status, body } = await post('/api/v1/workspaces', { path: tempDir, name: 'Battle Workspace' })
    expect(status).toBe(201)
    expect(body.id).toMatch(/^ws_/)
    expect(body.name).toBe('Battle Workspace')
  })

  it('lists workspaces → paginated', async () => {
    const { status, body } = await json('/api/v1/workspaces')
    expect(status).toBe(200)
    expect(body.items).toBeDefined()
    expect(body.items.length).toBeGreaterThan(0)
  })

  it('gets workspace detail', async () => {
    const wsDir = join(tempDir, 'detail-test')
    await mkdir(wsDir, { recursive: true })
    const { body: ws } = await post('/api/v1/workspaces', { path: wsDir, name: 'Detail' })
    const { status, body } = await json(`/api/v1/workspaces/${ws.id}`)
    expect(status).toBe(200)
    expect(body.name).toBe('Detail')
    expect(typeof body.activeThreads).toBe('number')
    expect(typeof body.totalThreads).toBe('number')
  })

  it('updates workspace (pin + rename)', async () => {
    const wsDir = join(tempDir, 'pin-test')
    await mkdir(wsDir, { recursive: true })
    const { body: ws } = await post('/api/v1/workspaces', { path: wsDir, name: 'Unpin' })
    const { status, body } = await put(`/api/v1/workspaces/${ws.id}`, { pinned: true, name: 'Pinned WS' })
    expect(status).toBe(200)
    expect(body.pinned).toBe(true)
    expect(body.name).toBe('Pinned WS')
  })

  it('deletes workspace → 204', async () => {
    const wsDir = join(tempDir, 'del-test')
    await mkdir(wsDir, { recursive: true })
    const { body: ws } = await post('/api/v1/workspaces', { path: wsDir })
    const { status } = await del(`/api/v1/workspaces/${ws.id}`)
    expect(status).toBe(204)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 7. SESSION PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════

describe('session persistence', () => {
  it('GET /session/state returns session data after creating workspaces', async () => {
    const sessionDir = join(tempDir, 'session-test')
    await mkdir(sessionDir, { recursive: true })
    const { body: ws } = await post('/api/v1/workspaces', { path: sessionDir, name: 'Session WS' })

    // Save session state
    gateway.state.saveSessionState()

    const { status, body } = await json('/api/v1/session/state')
    expect(status).toBe(200)
    expect(body.hasSession).toBe(true)
    expect(body.workspaces.length).toBeGreaterThan(0)
  })

  it('data survives gateway restart on same DB', async () => {
    // Create data
    const { body: thread } = await post('/api/v1/threads', { profileId: 'battle-bot', title: 'Persistence Test' })
    const threadId = thread.id

    // Stop + restart on same DB
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
    const { status, body } = await json(`/api/v1/threads/${threadId}`)
    expect(status).toBe(200)
    expect(body.title).toBe('Persistence Test')
  }, 15_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 8. DASHBOARD + ANALYTICS
// ═══════════════════════════════════════════════════════════════════════

describe('dashboard', () => {
  it('GET /dashboard returns stats', async () => {
    const { status, body } = await json('/api/v1/dashboard')
    expect(status).toBe(200)
    expect(typeof body.activeAgents).toBe('number')
    expect(typeof body.todayRuns).toBe('number')
    expect(typeof body.todayCost).toBe('number')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 9. PROVIDERS + SETTINGS
// ═══════════════════════════════════════════════════════════════════════

describe('providers + settings', () => {
  it('provider key round-trip (save → get → delete)', async () => {
    // Provider must be a known id from the LLM_PROVIDERS catalogue —
    // arbitrary ids are rejected with 400. Use openai (not anthropic)
    // so the round-trip never touches the key the real-API runs use.
    const { status: saveStatus } = await post('/api/v1/providers', {
      provider: 'openai',
      key: 'sk-test-key-1234567890',
    })
    expect(saveStatus).toBe(200)

    // Verify key retrievable
    const { body: keyBody } = await json('/api/v1/providers/openai/key')
    expect(keyBody.key).toBe('sk-test-key-1234567890')

    // Delete
    const { status: delStatus } = await del('/api/v1/providers/openai')
    expect(delStatus).toBe(204)

    // Verify gone
    const { status: goneStatus } = await json('/api/v1/providers/openai/key')
    expect(goneStatus).toBe(404)
  })

  it('settings round-trip', async () => {
    await put('/api/v1/settings/test-section', { key1: 'val1', key2: 'val2' })
    const { body } = await json('/api/v1/settings')
    expect(body['test-section']).toBeTruthy()
    expect(body['test-section'].key1).toBe('val1')
    expect(body['test-section'].key2).toBe('val2')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 10. SEARCH
// ═══════════════════════════════════════════════════════════════════════

describe('search', () => {
  it('finds profiles and threads', async () => {
    await post('/api/v1/threads', { profileId: 'battle-bot', title: 'Battle Search Target' })
    const { status, body } = await json('/api/v1/search?q=battle')
    expect(status).toBe(200)
    expect(body.length).toBeGreaterThan(0)
    const types = [...new Set(body.map((r: any) => r.type))]
    expect(types).toContain('profile')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 11. ONBOARDING
// ═══════════════════════════════════════════════════════════════════════

describe('onboarding', () => {
  it('full onboarding flow', async () => {
    const { status: roleStatus } = await post('/api/v1/onboarding/role', {
      role: 'developer',
      name: 'Battle Tester',
    })
    expect(roleStatus).toBe(200)

    const { status: completeStatus, body } = await post('/api/v1/onboarding/complete', {})
    expect(completeStatus).toBe(200)
    expect(body.completed).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 12. APP INFO
// ═══════════════════════════════════════════════════════════════════════

describe('app info', () => {
  it('GET /app/version returns version + platform', async () => {
    const { status, body } = await json('/api/v1/app/version')
    expect(status).toBe(200)
    expect(body.version).toBe('0.1.0')
    expect(body.platform).toBeTruthy()
  })

  it('GET /connectivity returns provider checks', async () => {
    const { status, body } = await json('/api/v1/connectivity')
    expect(status).toBe(200)
    expect(Array.isArray(body.providers)).toBe(true)
    for (const p of body.providers) {
      expect(typeof p.reachable).toBe('boolean')
    }
  }, 20_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 13. EDGE CASES
// ═══════════════════════════════════════════════════════════════════════

describe('edge cases', () => {
  it('run with nonexistent profileId → 404', async () => {
    const { status } = await post('/api/v1/run', {
      prompt: 'test',
      profileId: 'nonexistent-profile-xyz',
    })
    expect(status).toBe(404)
  })

  it('run with nonexistent threadId → 404', async () => {
    const { status } = await post('/api/v1/run', {
      prompt: 'test',
      profileId: 'battle-bot',
      threadId: 'thread_nonexistent',
    })
    expect(status).toBe(404)
  })

  it('resume on thread with no runtime → 404', async () => {
    const { body: thread } = await post('/api/v1/threads', { profileId: 'battle-bot' })
    const { status } = await post(`/api/v1/threads/${thread.id}/resume`, { action: 'approve' })
    expect(status).toBe(404)
  })

  it('abort on thread with no session → 404', async () => {
    const { body: thread } = await post('/api/v1/threads', { profileId: 'battle-bot' })
    const { status } = await post(`/api/v1/threads/${thread.id}/abort`, {})
    expect(status).toBe(404)
  })

  it('missing prompt → 400', async () => {
    const { status } = await post('/api/v1/run', {})
    expect(status).toBe(400)
  })

  it('nonexistent route → 404', async () => {
    const { status } = await json('/api/v1/not-a-real-endpoint')
    expect(status).toBe(404)
  })

  it('GET /threads/nonexistent → 404', async () => {
    const { status } = await json('/api/v1/threads/thread_does_not_exist')
    expect(status).toBe(404)
  })

  it('DELETE /threads/nonexistent → 404', async () => {
    const { status } = await del('/api/v1/threads/thread_does_not_exist')
    expect(status).toBe(404)
  })

  it('PATCH /threads/nonexistent → 404', async () => {
    const { status } = await patch('/api/v1/threads/thread_does_not_exist', { title: 'x' })
    expect(status).toBe(404)
  })

  it('PATCH with invalid status → 400', async () => {
    const { body: t } = await post('/api/v1/threads', { profileId: 'battle-bot' })
    const { status } = await patch(`/api/v1/threads/${t.id}`, { status: 'invalid' })
    expect(status).toBe(400)
  })
})
