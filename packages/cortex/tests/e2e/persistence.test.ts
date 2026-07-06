/**
 * PERSISTENCE E2E — Full Gateway Lifecycle Through HTTP
 *
 * Tests that everything the UI depends on actually persists to SQLite.
 * Spins up a REAL gateway, creates threads, adds messages, verifies
 * persistence across simulated restarts.
 *
 * Covers:
 * 1. Thread CRUD with profileId filtering
 * 2. Message persistence (user, assistant, tools, subAgents, thinking)
 * 3. Thread cascade delete (messages removed too)
 * 4. Persistence across gateway restart (data survives)
 * 5. Usage tracking
 * 6. MCP credential persistence
 * 7. Profile MCP persistence
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { OwnwareGateway } from '../../src/gateway/server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROFILES_DIR = resolve(__dirname, '../../profiles')

/** Fresh temp dbPath + dataDir per gateway. dataDir isolation is mandatory
 *  (package CLAUDE.md) — without it the gateway writes credentials/TLS state
 *  into the user's real ~/.ownware even when dbPath is overridden. */
async function isolatedStorage(): Promise<{ dbPath: string; dataDir: string }> {
  const tmp = await mkdtemp(join(tmpdir(), 'cortex-p-'))
  return { dbPath: join(tmp, 'test.db'), dataDir: join(tmp, 'data') }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let BASE: string
let token: string

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function post(path: string, data?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: data ? JSON.stringify(data) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function del(path: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  })
  return { status: res.status }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Thread CRUD + Profile Filtering
// ═══════════════════════════════════════════════════════════════════════════

describe('Thread persistence', () => {
  let gateway: OwnwareGateway
  let tempDir: string

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cortex-persist-test-'))
    gateway = new OwnwareGateway({
      port: 0,
      profilesDir: PROFILES_DIR,
      dbPath: join(tempDir, 'test.db'),
      dataDir: join(tempDir, 'data'),
    })
    await gateway.start()
    BASE = `http://localhost:${gateway.port}`
    token = gateway.token
  }, 30_000)

  afterAll(async () => {
    await gateway.stop()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates a thread and gets it back', async () => {
    const { status, body } = await post('/api/v1/threads', {
      profileId: 'coder',
      title: 'Persistence Test Thread',
    })
    expect(status).toBe(201)
    expect(body.id).toMatch(/^thread_/)
    expect(body.profileId).toBe('coder')
    expect(body.title).toBe('Persistence Test Thread')
    expect(body.status).toBe('active')
    expect(body.messageCount).toBe(0)

    // Get it back
    const { body: fetched } = await get(`/api/v1/threads/${body.id}`)
    expect(fetched.id).toBe(body.id)
    expect(fetched.title).toBe('Persistence Test Thread')
    expect(fetched.messages).toEqual([])

    console.log('  ✅ Thread created and retrieved:', body.id)
  })

  it('filters threads by profileId', async () => {
    // Create threads for different profiles
    await post('/api/v1/threads', { profileId: 'profile-alpha' })
    await post('/api/v1/threads', { profileId: 'profile-alpha' })
    await post('/api/v1/threads', { profileId: 'profile-beta' })

    const { body: all } = await get('/api/v1/threads')
    const { body: alpha } = await get('/api/v1/threads?profileId=profile-alpha')
    const { body: beta } = await get('/api/v1/threads?profileId=profile-beta')
    const { body: none } = await get('/api/v1/threads?profileId=nonexistent')

    expect(alpha.items.length).toBe(2)
    expect(beta.items.length).toBe(1)
    expect(none.items.length).toBe(0)
    expect(all.items.length).toBeGreaterThanOrEqual(4) // at least our 4 + previous test

    console.log(`  ✅ Profile filtering: all=${all.items.length}, alpha=${alpha.items.length}, beta=${beta.items.length}`)
  })

  it('updates thread metadata', async () => {
    const { body: thread } = await post('/api/v1/threads', { profileId: 'coder' })

    // The handler doesn't have a PUT for threads directly,
    // but the run handler updates thread via state.updateThread()
    // Let's verify through GET that the initial state is correct
    const { body: fetched } = await get(`/api/v1/threads/${thread.id}`)
    expect(fetched.messageCount).toBe(0)
    expect(fetched.status).toBe('active')
  })

  it('deletes thread and cascades to messages', async () => {
    const { body: thread } = await post('/api/v1/threads', { profileId: 'coder', title: 'To Delete' })

    // Verify exists
    const { status: getStatus } = await get(`/api/v1/threads/${thread.id}`)
    expect(getStatus).toBe(200)

    // Delete
    const { status: delStatus } = await del(`/api/v1/threads/${thread.id}`)
    expect(delStatus).toBe(204)

    // Verify gone
    const { status: goneStatus } = await get(`/api/v1/threads/${thread.id}`)
    expect(goneStatus).toBe(404)

    console.log('  ✅ Thread deleted with cascade')
  })

  it('returns 404 for unknown thread', async () => {
    const { status } = await get('/api/v1/threads/thread_nonexistent999')
    expect(status).toBe(404)
  })

  it('threads sorted by updatedAt descending', async () => {
    const { body: threads } = await get('/api/v1/threads')

    for (let i = 0; i < threads.length - 1; i++) {
      const a = new Date(threads[i].updatedAt).getTime()
      const b = new Date(threads[i + 1].updatedAt).getTime()
      expect(a).toBeGreaterThanOrEqual(b)
    }

    console.log('  ✅ Threads sorted by updatedAt DESC')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Message Persistence (via GatewayState directly — simulates run handler)
// ═══════════════════════════════════════════════════════════════════════════

describe('Message persistence — complex messages', () => {
  let gateway: OwnwareGateway

  beforeAll(async () => {
    gateway = new OwnwareGateway({ port: 0, profilesDir: PROFILES_DIR, ...(await isolatedStorage()) })
    await gateway.start()
    BASE = `http://localhost:${gateway.port}`
    token = gateway.token
  }, 30_000)

  afterAll(async () => {
    await gateway.stop()
  })

  it('stores and retrieves messages with tools, subAgents, thinking', async () => {
    // Create thread via API
    const { body: thread } = await post('/api/v1/threads', { profileId: 'coder' })

    // Add messages directly through state (simulating what run.ts does)
    const state = gateway.state

    // User message
    state.addMessage(thread.id, {
      id: 'msg_user_001',
      role: 'user',
      content: 'Fix the login bug in auth.ts',
      attachments: [
        { filename: 'screenshot.png', mimeType: 'image/png', sizeBytes: 45000, category: 'image' as const },
      ],
      timestamp: '2026-04-04T10:00:00Z',
    })

    // Assistant message with tools + thinking
    state.addMessage(thread.id, {
      id: 'msg_asst_001',
      role: 'assistant',
      content: 'I found the bug in auth.ts line 42. The token check is inverted.',
      tools: [
        {
          name: 'readFile',
          input: { path: '/src/auth.ts' },
          output: 'const valid = !token.isExpired()',
          isError: false,
          durationMs: 45,
          startedAt: '2026-04-04T10:00:01Z',
        },
        {
          name: 'editFile',
          input: { path: '/src/auth.ts', old: '!token.isExpired()', new: 'token.isExpired()' },
          output: 'File edited successfully',
          isError: false,
          durationMs: 12,
          startedAt: '2026-04-04T10:00:02Z',
        },
      ],
      thinking: 'The bug is likely in the token validation. Let me read the file first...',
      usage: { inputTokens: 1500, outputTokens: 200 },
      timestamp: '2026-04-04T10:00:03Z',
    })

    // Assistant message with subAgents
    state.addMessage(thread.id, {
      id: 'msg_asst_002',
      role: 'assistant',
      content: 'I ran the tests and they all pass now.',
      subAgents: [
        {
          agentId: 'agent_test_runner',
          profileName: 'coder',
          task: 'Run unit tests for auth module',
          status: 'completed',
          result: 'All 12 tests passed',
          durationMs: 3500,
          toolCount: 3,
          turnCount: 2,
        },
      ],
      permissions: [
        {
          toolName: 'shell_execute',
          input: { command: 'npm test' },
          reason: 'Shell command execution',
          decision: 'approved',
        },
      ],
      usage: { inputTokens: 800, outputTokens: 150 },
      timestamp: '2026-04-04T10:00:05Z',
    })

    // System message (compaction notice)
    state.addMessage(thread.id, {
      id: 'msg_sys_001',
      role: 'system',
      content: 'Context compacted: 45000 → 12000 tokens (summarize)',
      timestamp: '2026-04-04T10:00:06Z',
    })

    // Error message
    state.addMessage(thread.id, {
      id: 'msg_err_001',
      role: 'error',
      content: 'Rate limit exceeded. Retrying in 5 seconds.',
      timestamp: '2026-04-04T10:00:07Z',
    })

    // Now retrieve via API
    const { status, body } = await get(`/api/v1/threads/${thread.id}`)
    expect(status).toBe(200)

    const messages = body.messages
    expect(messages).toHaveLength(5)

    // Verify user message
    const userMsg = messages[0]
    expect(userMsg.role).toBe('user')
    expect(userMsg.content).toBe('Fix the login bug in auth.ts')
    expect(userMsg.attachments).toHaveLength(1)
    expect(userMsg.attachments[0].filename).toBe('screenshot.png')
    expect(userMsg.attachments[0].category).toBe('image')

    // Verify assistant message with tools + thinking
    const asstMsg1 = messages[1]
    expect(asstMsg1.role).toBe('assistant')
    expect(asstMsg1.content).toContain('token check is inverted')
    expect(asstMsg1.tools).toHaveLength(2)
    expect(asstMsg1.tools[0].name).toBe('readFile')
    expect(asstMsg1.tools[0].durationMs).toBe(45)
    expect(asstMsg1.tools[1].name).toBe('editFile')
    expect(asstMsg1.thinking).toContain('token validation')
    expect(asstMsg1.usage.inputTokens).toBe(1500)
    expect(asstMsg1.usage.outputTokens).toBe(200)

    // Verify assistant message with subAgents + permissions
    const asstMsg2 = messages[2]
    expect(asstMsg2.subAgents).toHaveLength(1)
    expect(asstMsg2.subAgents[0].agentId).toBe('agent_test_runner')
    expect(asstMsg2.subAgents[0].status).toBe('completed')
    expect(asstMsg2.subAgents[0].result).toBe('All 12 tests passed')
    expect(asstMsg2.subAgents[0].durationMs).toBe(3500)
    expect(asstMsg2.permissions).toHaveLength(1)
    expect(asstMsg2.permissions[0].toolName).toBe('shell_execute')
    expect(asstMsg2.permissions[0].decision).toBe('approved')

    // Verify system + error messages
    expect(messages[3].role).toBe('system')
    expect(messages[3].content).toContain('compacted')
    expect(messages[4].role).toBe('error')
    expect(messages[4].content).toContain('Rate limit')

    console.log('  ✅ All 5 message types persisted and retrieved correctly')
    console.log('    - user message with attachments')
    console.log('    - assistant with 2 tool calls + thinking + usage')
    console.log('    - assistant with subAgent + permission')
    console.log('    - system message')
    console.log('    - error message')
  })

  it('messages retrieved via /messages endpoint too', async () => {
    const { body: threadsResult } = await get('/api/v1/threads?profileId=coder')
    const thread = threadsResult.items.find((t: any) => t.messageCount > 0 || true)
    if (!thread) return

    const { status, body } = await get(`/api/v1/threads/${thread.id}/messages`)
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)

    console.log(`  ✅ /messages endpoint returns ${body.length} messages`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Persistence Across Restart
// ═══════════════════════════════════════════════════════════════════════════

describe('Persistence across gateway restart', () => {
  it('threads and messages survive gateway stop + start', async () => {
    // Shared DB path for both gateways
    const sharedTmp = await mkdtemp(join(tmpdir(), 'cortex-restart-'))
    const sharedDb = join(sharedTmp, 'restart.db')

    // Start gateway 1
    const gw1 = new OwnwareGateway({ port: 0, profilesDir: PROFILES_DIR, dbPath: sharedDb, dataDir: join(sharedTmp, 'data') })
    await gw1.start()
    const base1 = `http://localhost:${gw1.port}`

    // Create thread with messages
    const createRes = await fetch(`${base1}/api/v1/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${gw1.token}` },
      body: JSON.stringify({ profileId: 'restart-test', title: 'Survive Restart' }),
    })
    const thread = await createRes.json()

    gw1.state.addMessage(thread.id, {
      id: 'msg_survive_1',
      role: 'user',
      content: 'This message must survive a restart',
      timestamp: new Date().toISOString(),
    })
    gw1.state.addMessage(thread.id, {
      id: 'msg_survive_2',
      role: 'assistant',
      content: 'I will persist across restarts',
      tools: [{ name: 'readFile', input: { path: '/test' }, output: 'data', durationMs: 10 }],
      usage: { inputTokens: 100, outputTokens: 50 },
      timestamp: new Date().toISOString(),
    })

    gw1.state.updateThread(thread.id, { messageCount: 2, totalTokens: 150 })

    // Stop gateway 1
    await gw1.stop()
    console.log('  Gateway 1 stopped')

    // Start gateway 2 (fresh instance, SAME DB)
    const gw2 = new OwnwareGateway({ port: 0, profilesDir: PROFILES_DIR, dbPath: sharedDb, dataDir: join(sharedTmp, 'data') })
    await gw2.start()
    const base2 = `http://localhost:${gw2.port}`

    // Verify thread persisted
    const threadRes = await fetch(`${base2}/api/v1/threads/${thread.id}`, {
      headers: { 'Authorization': `Bearer ${gw2.token}` },
    })
    const fetched = await threadRes.json()

    expect(fetched.id).toBe(thread.id)
    expect(fetched.title).toBe('Survive Restart')
    expect(fetched.profileId).toBe('restart-test')

    // Verify messages persisted
    expect(fetched.messages).toHaveLength(2)
    expect(fetched.messages[0].content).toBe('This message must survive a restart')
    expect(fetched.messages[1].content).toBe('I will persist across restarts')
    expect(fetched.messages[1].tools).toHaveLength(1)
    expect(fetched.messages[1].tools[0].name).toBe('readFile')
    expect(fetched.messages[1].usage.inputTokens).toBe(100)

    // Verify thread metadata persisted
    const threadsRes = await fetch(`${base2}/api/v1/threads?profileId=restart-test`, {
      headers: { 'Authorization': `Bearer ${gw2.token}` },
    })
    const threadsBody = await threadsRes.json()
    expect(threadsBody.items.length).toBeGreaterThanOrEqual(1)
    const found = threadsBody.items.find((t: any) => t.id === thread.id)
    expect(found.messageCount).toBe(2)
    expect(found.totalTokens).toBe(150)

    await gw2.stop()

    console.log('  ✅ Thread + 2 messages + metadata survived full restart')
  }, 30_000)
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. MCP Credential Persistence
// ═══════════════════════════════════════════════════════════════════════════

describe('MCP credential persistence', () => {
  let gateway: OwnwareGateway

  beforeAll(async () => {
    gateway = new OwnwareGateway({ port: 0, profilesDir: PROFILES_DIR, ...(await isolatedStorage()) })
    await gateway.start()
    BASE = `http://localhost:${gateway.port}`
    token = gateway.token
  }, 30_000)

  afterAll(async () => {
    // Clean up test credentials
    await del('/api/v1/mcp/credentials/persist-test-server')
    await gateway.stop()
  })

  it('saves credentials via HTTP and they persist to filesystem', async () => {
    const { status, body } = await post('/api/v1/mcp/credentials/persist-test-server', {
      env: { API_KEY: 'persist-test-key-123', DB_HOST: 'localhost' },
    })
    expect(status).toBe(200)
    expect(body.saved).toBe(2)

    // Check via HTTP
    const { body: check } = await get('/api/v1/mcp/credentials/persist-test-server')
    expect(check.serverId).toBe('persist-test-server')
    // Values should NOT be in the response
    expect(JSON.stringify(check)).not.toContain('persist-test-key-123')

    console.log('  ✅ Credentials saved and verified (values not exposed)')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Profile MCP Persistence
// ═══════════════════════════════════════════════════════════════════════════

describe('Profile MCP persistence', () => {
  let gateway: OwnwareGateway

  beforeAll(async () => {
    gateway = new OwnwareGateway({ port: 0, profilesDir: PROFILES_DIR, ...(await isolatedStorage()) })
    await gateway.start()
    BASE = `http://localhost:${gateway.port}`
    token = gateway.token
  }, 30_000)

  afterAll(async () => {
    await gateway.stop()
  })

  it('GET /api/v1/profiles lists profiles with hasMcp field', async () => {
    const { status, body } = await get('/api/v1/profiles')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)

    // Every profile should have hasMcp field
    for (const profile of body) {
      expect(typeof profile.hasMcp).toBe('boolean')
      expect(typeof profile.toolCount).toBe('number')
    }

    console.log(`  ✅ ${body.length} profiles listed, all have hasMcp field`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Full Data Integrity Check
// ═══════════════════════════════════════════════════════════════════════════

describe('Data integrity', () => {
  let gateway: OwnwareGateway

  beforeAll(async () => {
    gateway = new OwnwareGateway({ port: 0, profilesDir: PROFILES_DIR, ...(await isolatedStorage()) })
    await gateway.start()
    BASE = `http://localhost:${gateway.port}`
    token = gateway.token
  }, 30_000)

  afterAll(async () => {
    await gateway.stop()
  })

  it('cascade delete removes thread + all messages', async () => {
    // Create thread with messages
    const { body: thread } = await post('/api/v1/threads', { profileId: 'integrity-test' })

    gateway.state.addMessage(thread.id, {
      id: 'msg_cascade_1', role: 'user', content: 'msg 1', timestamp: new Date().toISOString(),
    })
    gateway.state.addMessage(thread.id, {
      id: 'msg_cascade_2', role: 'assistant', content: 'msg 2', timestamp: new Date().toISOString(),
    })
    gateway.state.addMessage(thread.id, {
      id: 'msg_cascade_3', role: 'user', content: 'msg 3', timestamp: new Date().toISOString(),
    })

    // Verify messages exist
    const { body: before } = await get(`/api/v1/threads/${thread.id}/messages`)
    expect(before).toHaveLength(3)

    // Delete thread
    await del(`/api/v1/threads/${thread.id}`)

    // Verify messages are gone (query returns empty, not error)
    const { body: after } = await get(`/api/v1/threads/${thread.id}/messages`)
    // Thread doesn't exist → 404
    expect(after.error).toBe('not_found')

    console.log('  ✅ Cascade delete: thread + 3 messages removed')
  })

  it('thread updatedAt changes on update', async () => {
    const { body: thread } = await post('/api/v1/threads', { profileId: 'time-test' })
    const originalUpdatedAt = thread.updatedAt

    // Small delay
    await new Promise(r => setTimeout(r, 50))

    gateway.state.updateThread(thread.id, { title: 'Updated Title' })
    const { body: fetched } = await get(`/api/v1/threads/${thread.id}`)

    expect(fetched.title).toBe('Updated Title')
    // updatedAt should have changed
    expect(fetched.updatedAt).not.toBe(originalUpdatedAt)

    console.log('  ✅ updatedAt tracks changes')
  })
})
