/**
 * LIVE E2E: Real agent run → dashboard reflects the data.
 *
 * This test does a REAL agent run with ANTHROPIC_API_KEY,
 * then verifies the dashboard/activity/storage endpoints
 * reflect that real run. No mocks. No seeding. No shortcuts.
 *
 * Requires ANTHROPIC_API_KEY.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { join } from 'node:path'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const apiKey = process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('OWNWARE_TEST_DUMMY') ? process.env.ANTHROPIC_API_KEY : undefined

let gateway: OwnwareGateway
let token: string
let tempDir: string
let dbPath: string
const baseUrl = () => `http://127.0.0.1:${gateway.port}`

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cortex-live-dash-'))
  dbPath = join(tempDir, 'test.db')

  const profileDir = join(tempDir, 'profiles', 'live-test')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'agent.json'), JSON.stringify({
    name: 'live-test',
    description: 'Live test agent',
    model: 'anthropic:claude-sonnet-4-20250514',
    tools: { preset: 'none' },
    context: { cwd: false, datetime: false },
  }))
  await writeFile(join(profileDir, 'SOUL.md'), '# Live Test\nRespond with one word only.')

  gateway = new OwnwareGateway({
    port: 0,
    profilesDir: join(tempDir, 'profiles'),
    dbPath,
    dataDir: join(tempDir, 'data'),
  })
  await gateway.start()
  token = gateway.token
}, 15_000)

afterAll(async () => {
  await gateway?.stop()
  await rm(tempDir, { recursive: true, force: true })
})

async function api(path: string, opts?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...opts?.headers },
  })
}

interface SSEEvent { event: string; data: unknown }

function parseSSE(text: string): SSEEvent[] {
  const events: SSEEvent[] = []
  let currentEvent = ''
  let currentData = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) currentEvent = line.slice(7)
    else if (line.startsWith('data: ')) currentData = line.slice(6)
    else if (line === '' && currentEvent && currentData) {
      try { events.push({ event: currentEvent, data: JSON.parse(currentData) }) }
      catch { events.push({ event: currentEvent, data: currentData }) }
      currentEvent = ''
      currentData = ''
    }
  }
  return events
}

async function readSSEUntilDone(res: Response, maxMs: number): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let buffer = ''
  const start = Date.now()
  let sawDone = false

  try {
    while (Date.now() - start < maxMs && !sawDone) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 500),
        ),
      ])
      if (done && value === undefined) continue
      if (done) break
      if (!value) continue

      const chunk = decoder.decode(value, { stream: true })
      text += chunk
      buffer += chunk

      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) {
            const name = line.slice(7).trim()
            if (name === 'done' || name === 'session.end') sawDone = true
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
      await res.body!.cancel()
    } catch {}
  }

  return text
}

async function runAndCollectEvents(body: Record<string, unknown>): Promise<{
  start: { threadId: string; agentId: string; status: string }
  events: SSEEvent[]
}> {
  const runRes = await api('/api/v1/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(runRes.status).toBe(200)
  expect(runRes.headers.get('content-type')).toContain('application/json')
  const start = await runRes.json() as { threadId: string; agentId: string; status: string }

  const sseRes = await api(`/api/v1/threads/${start.threadId}/agents/${start.agentId ?? 'root'}/events`)
  expect(sseRes.status).toBe(200)
  expect(sseRes.headers.get('content-type')).toContain('text/event-stream')

  return {
    start,
    events: parseSSE(await readSSEUntilDone(sseRes, 120_000)),
  }
}

// ---------------------------------------------------------------------------

describe.skipIf(!apiKey)('LIVE: real run → dashboard reflects it', () => {
  let threadId: string

  it('/run starts a real API run and /events streams it', async () => {
    // Create workspace first
    const wsRes = await api('/api/v1/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tempDir, name: 'Live Test WS' }),
    })
    expect(wsRes.status).toBe(201)
    const ws = await wsRes.json() as { id: string }

    // Run agent
    const { start, events } = await runAndCollectEvents({
        prompt: 'Say "hello" and nothing else.',
        profileId: 'live-test',
        workspaceId: ws.id,
    })

    // Verify event ordering
    const types = events.map(e => e.event)
    expect(types[0]).toBe('stream.start')
    expect(types).toContain('text.delta')
    expect(types).toContain('turn.end')
    expect(types[types.length - 1]).toBe('done')

    // Extract threadId
    threadId = start.threadId
    expect(threadId).toBeTruthy()

    // Verify turn.end has real usage data
    const turnEnd = events.find(e => e.event === 'turn.end')
    const usage = (turnEnd!.data as any).usage
    expect(usage.inputTokens).toBeGreaterThan(0)
    expect(usage.outputTokens).toBeGreaterThan(0)
  }, 30_000)

  it('GET /dashboard/kpis reflects the real run', async () => {
    const res = await api('/api/v1/dashboard/kpis?range=24h')
    expect(res.status).toBe(200)
    const body = await res.json() as { cards: Array<{ label: string; value: number }> }

    const runsCard = body.cards.find(c => c.label === 'Runs')
    expect(runsCard).toBeDefined()
    expect(runsCard!.value).toBeGreaterThanOrEqual(1)

    const tokensCard = body.cards.find(c => c.label === 'Tokens')
    expect(tokensCard).toBeDefined()
    expect(tokensCard!.value).toBeGreaterThan(0)
  })

  it('GET /dashboard/usage-chart reflects the real run', async () => {
    const res = await api('/api/v1/dashboard/usage-chart?range=24h')
    expect(res.status).toBe(200)
    const body = await res.json() as { total: { runs: number; tokens: number } }
    expect(body.total.runs).toBeGreaterThanOrEqual(1)
    expect(body.total.tokens).toBeGreaterThan(0)
  })

  it('GET /dashboard/profile-breakdown includes live-test profile', async () => {
    const res = await api('/api/v1/dashboard/profile-breakdown')
    expect(res.status).toBe(200)
    const body = await res.json() as Array<{ profileId: string; runs: number }>
    const entry = body.find(r => r.profileId === 'live-test')
    expect(entry).toBeDefined()
    expect(entry!.runs).toBeGreaterThanOrEqual(1)
  })

  it('GET /dashboard/recent-activity includes the run', async () => {
    const res = await api('/api/v1/dashboard/recent-activity?limit=5')
    expect(res.status).toBe(200)
    const body = await res.json() as Array<{ profileId: string; totalTokens: number; success: boolean }>
    expect(body.length).toBeGreaterThanOrEqual(1)
    const entry = body.find(r => r.profileId === 'live-test')
    expect(entry).toBeDefined()
    expect(entry!.totalTokens).toBeGreaterThan(0)
    expect(entry!.success).toBe(true)
  })

  it('GET /activity includes the thread', async () => {
    const res = await api('/api/v1/activity')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ threadId: string; profileId: string }> }
    const entry = body.data.find(a => a.threadId === threadId)
    expect(entry).toBeDefined()
    expect(entry!.profileId).toBe('live-test')
  })

  it('GET /storage/stats reflects the run data', async () => {
    const res = await api('/api/v1/storage/stats')
    expect(res.status).toBe(200)
    const body = await res.json() as { threadCount: number; messageCount: number; usageRecordCount: number }
    expect(body.threadCount).toBeGreaterThanOrEqual(1)
    expect(body.messageCount).toBeGreaterThanOrEqual(2) // user + assistant
    expect(body.usageRecordCount).toBeGreaterThanOrEqual(1)
  })

  it('POST /data/export includes the thread and messages', async () => {
    const res = await api('/api/v1/data/export', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      threads: Array<{ id: string }>
      messages: Record<string, Array<{ role: string }>>
      usage: { recordCount: number }
    }
    expect(body.threads.some(t => t.id === threadId)).toBe(true)
    expect(body.messages[threadId]).toBeDefined()
    expect(body.messages[threadId]!.length).toBeGreaterThanOrEqual(2)
    expect(body.usage.recordCount).toBeGreaterThanOrEqual(1)
  })

  it('GET /dashboard backward-compat reflects the run', async () => {
    const res = await api('/api/v1/dashboard')
    expect(res.status).toBe(200)
    const body = await res.json() as { todayRuns: number; todayTokens: number; workspaceCount: number }
    expect(body.todayRuns).toBeGreaterThanOrEqual(1)
    expect(body.todayTokens).toBeGreaterThan(0)
    expect(body.workspaceCount).toBeGreaterThanOrEqual(1)
  })

  it('session state saved on shutdown and survives restart', async () => {
    await gateway.stop()

    // Restart with same DB
    gateway = new OwnwareGateway({
      port: 0,
      profilesDir: join(tempDir, 'profiles'),
      dbPath,
      dataDir: join(tempDir, 'data'),
    })
    await gateway.start()
    token = gateway.token

    // Dashboard data persisted in SQLite — should survive restart
    const res = await api('/api/v1/dashboard/kpis?range=24h')
    expect(res.status).toBe(200)
    const body = await res.json() as { cards: Array<{ label: string; value: number }> }
    const runsCard = body.cards.find(c => c.label === 'Runs')
    expect(runsCard!.value).toBeGreaterThanOrEqual(1)
  }, 15_000)
})
