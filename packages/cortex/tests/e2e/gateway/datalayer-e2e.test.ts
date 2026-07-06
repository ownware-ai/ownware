/**
 * E2E tests for data layer fixes and pagination.
 *
 * Starts a REAL OwnwareGateway and makes REAL HTTP calls.
 * Verifies that fixes to addMessage, addUsageRecord, listMCPServers,
 * and pagination are visible through the HTTP API.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { join } from 'node:path'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let gateway: OwnwareGateway
let db: CortexDatabase
let tempDir: string
let dbPath: string
const baseUrl = () => `http://127.0.0.1:${gateway.port}`

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cortex-dl-e2e-'))
  dbPath = join(tempDir, 'test.db')

  // Minimal profile so the gateway can start
  const profileDir = join(tempDir, 'profiles', 'mini')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'agent.json'), JSON.stringify({
    name: 'mini',
    description: 'Minimal agent for e2e',
    model: 'anthropic:claude-sonnet-4-20250514',
    tools: { preset: 'none' },
    context: { cwd: false, datetime: false },
  }))

  gateway = new OwnwareGateway({
    port: 0,
    profilesDir: join(tempDir, 'profiles'),
    dbPath,
    dataDir: join(tempDir, 'data'),
  })
  await gateway.start()

  // Open a second handle to the same DB for direct insertions
  db = new CortexDatabase(dbPath)
}, 15_000)

afterAll(async () => {
  db?.close()
  await gateway?.stop()
  await rm(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function api<T = unknown>(path: string, opts?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${gateway.token}`,
      'Content-Type': 'application/json',
      ...opts?.headers,
    },
  })
  const body = await res.json() as T
  return { status: res.status, body }
}

function makeMsg(role: 'user' | 'assistant' = 'assistant', content = 'test content') {
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    role,
    content,
    timestamp: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Data layer E2E — message_count accuracy', () => {
  it('GET /threads shows accurate messageCount after messages are added', async () => {
    const thread = db.createThread('mini', 'count-test')

    db.addMessage(thread.id, makeMsg('user', 'Hi'))
    db.addMessage(thread.id, makeMsg('assistant', 'Hello'))
    db.addMessage(thread.id, makeMsg('user', 'Thanks'))

    const { status, body } = await api<{ items: Array<{ id: string; messageCount: number }> }>(
      '/api/v1/threads',
    )
    expect(status).toBe(200)
    const found = body.items.find(t => t.id === thread.id)
    expect(found).toBeDefined()
    expect(found!.messageCount).toBe(3)
  })

  it('GET /threads/:id shows accurate totalTokens and totalCost', async () => {
    const thread = db.createThread('mini', 'token-test')

    db.addUsageRecord({
      threadId: thread.id,
      profileId: 'mini',
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.01,
    })
    db.addUsageRecord({
      threadId: thread.id,
      profileId: 'mini',
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.02,
    })

    const { status, body } = await api<{ totalTokens: number; totalCost: number }>(
      `/api/v1/threads/${thread.id}`,
    )
    expect(status).toBe(200)
    expect(body.totalTokens).toBe(450)
    expect(body.totalCost).toBeCloseTo(0.03)
  })
})

describe('Data layer E2E — thread pagination', () => {
  let threadIds: string[]

  beforeAll(() => {
    threadIds = []
    for (let i = 0; i < 5; i++) {
      threadIds.push(db.createThread('mini', `Pagination thread ${i}`).id)
    }
  })

  it('GET /threads returns paginated result with items array', async () => {
    const { status, body } = await api<{ items: unknown[]; total: number; limit: number; offset: number }>(
      '/api/v1/threads',
    )
    expect(status).toBe(200)
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.items.length).toBeGreaterThanOrEqual(5)
    expect(body.total).toBeGreaterThanOrEqual(5)
    expect(typeof body.limit).toBe('number')
    expect(typeof body.offset).toBe('number')
  })

  it('GET /threads returns all created threads in items', async () => {
    const { body } = await api<{ items: Array<{ id: string }> }>('/api/v1/threads')

    const returnedIds = body.items.map(t => t.id)
    for (const id of threadIds) {
      expect(returnedIds).toContain(id)
    }
  })
})

describe('Data layer E2E — workspace pagination', () => {
  beforeAll(() => {
    for (let i = 0; i < 3; i++) {
      db.createWorkspace(`/e2e/workspace${i}`, `E2E WS ${i}`)
    }
  })

  it('GET /workspaces returns paginated result with all workspaces', async () => {
    const { status, body } = await api<{ items: unknown[]; total: number }>(
      '/api/v1/workspaces',
    )
    expect(status).toBe(200)
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.items.length).toBeGreaterThanOrEqual(3)
    expect(body.total).toBeGreaterThanOrEqual(3)
  })
})

describe('Data layer E2E — MCP server profileIds', () => {
  it('listMCPServers DB method returns profileIds array per server', () => {
    db.createMCPServer({ id: 'e2e-srv1', name: 'E2E Server One', transport: 'stdio' })
    db.assignServerToProfile('e2e-srv1', 'profile-alpha')
    db.assignServerToProfile('e2e-srv1', 'profile-beta')

    const result = db.listMCPServers()
    expect(Array.isArray(result.items)).toBe(true)
    const srv = result.items.find(s => s.id === 'e2e-srv1')
    expect(srv).toBeDefined()
    expect(srv!.profileIds).toContain('profile-alpha')
    expect(srv!.profileIds).toContain('profile-beta')
  })
})

describe('Data layer E2E — usage time series', () => {
  it('usage records appear in getUsageTimeSeries bucketed data', async () => {
    // Insert 5 usage records
    for (let i = 0; i < 5; i++) {
      db.addUsageRecord({
        profileId: 'mini',
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.01,
      })
    }

    const buckets = db.getUsageTimeSeries('7d')
    const today = new Date().toISOString().split('T')[0]!
    const todayBucket = buckets.find(b => b.date === today)

    expect(todayBucket).toBeDefined()
    expect(todayBucket!.runs).toBeGreaterThanOrEqual(5)
  })
})

describe('Data layer E2E — incrementProfileUsage', () => {
  it('incrementProfileUsage updates stats and is reflected in profile_metadata', async () => {
    db.incrementProfileUsage('e2e-usage', 0.05)
    db.incrementProfileUsage('e2e-usage', 0.10)
    db.incrementProfileUsage('e2e-usage', 0.15)

    const meta = db.getProfileMetadata('e2e-usage')!
    expect(meta).toBeDefined()
    expect(meta.useCount).toBe(3)
    expect(meta.totalCost).toBeCloseTo(0.30)
    expect(meta.lastUsedAt).not.toBeNull()
  })
})
