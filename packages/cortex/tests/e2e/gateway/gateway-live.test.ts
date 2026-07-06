/**
 * End-to-end gateway tests with REAL API calls.
 *
 * These tests start the gateway, POST /api/v1/run with a real prompt,
 * then attach to the agent-events SSE stream to verify the full pipeline works.
 *
 * Requires ANTHROPIC_API_KEY. Skipped automatically if not set.
 *
 * Run: ANTHROPIC_API_KEY=sk-... npx vitest run tests/e2e/gateway/
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { resolve, join } from 'path'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const apiKey = process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('OWNWARE_TEST_DUMMY') ? process.env.ANTHROPIC_API_KEY : undefined

let gateway: OwnwareGateway
let baseUrl: string
let token: string
let tempDir: string

function skipIfNoKey(): boolean {
  if (!apiKey) {
    console.log('⏭ Skipping e2e gateway test: ANTHROPIC_API_KEY not set')
    return true
  }
  return false
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cortex-gw-e2e-'))
  const profileDir = join(tempDir, 'mini')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'agent.json'), JSON.stringify({
    name: 'mini',
    description: 'Minimal agent for e2e',
    model: 'anthropic:claude-sonnet-4-20250514',
    tools: { preset: 'none' },
    context: { cwd: false, datetime: false },
  }))
  await writeFile(join(profileDir, 'SOUL.md'), '# Mini Agent\n\nBe extremely brief. One sentence max.')

  gateway = new OwnwareGateway({
    port: 0,
    profilesDir: tempDir,
    dataDir: join(tempDir, 'data'),
  })
  await gateway.start()
  baseUrl = `http://localhost:${gateway.port}`
  token = gateway.token
}, 10_000)

afterAll(async () => {
  await gateway?.stop()
  await rm(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers — SSE parsing
// ---------------------------------------------------------------------------

interface SSEEvent {
  event: string
  data: unknown
}

async function parseSSEResponse(res: Response): Promise<SSEEvent[]> {
  const text = await readSSEUntilDone(res, 120_000)
  const events: SSEEvent[] = []

  const lines = text.split('\n')
  let currentEvent = ''
  let currentData = ''

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7)
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6)
    } else if (line === '') {
      if (currentEvent && currentData) {
        try {
          events.push({ event: currentEvent, data: JSON.parse(currentData) })
        } catch {
          events.push({ event: currentEvent, data: currentData })
        }
      }
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
  const runRes = await fetch(`${baseUrl}/api/v1/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  })

  expect(runRes.status).toBe(200)
  expect(runRes.headers.get('content-type')).toContain('application/json')
  const start = await runRes.json() as { threadId: string; agentId: string; status: string }

  const sseRes = await fetch(
    `${baseUrl}/api/v1/threads/${start.threadId}/agents/${start.agentId ?? 'root'}/events`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  expect(sseRes.status).toBe(200)
  expect(sseRes.headers.get('content-type')).toContain('text/event-stream')

  return {
    start,
    events: await parseSSEResponse(sseRes),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e: gateway SSE streaming with real API', () => {
  it('streams a simple response via /run + /events', async () => {
    if (skipIfNoKey()) return

    const { start, events } = await runAndCollectEvents({
        prompt: 'What is 2+2? Reply with just the number.',
        profileId: 'mini',
    })

    // Should have stream.start
    const streamStart = events.find(e => e.event === 'stream.start')
    expect(streamStart).toBeDefined()
    expect((streamStart!.data as any).agentId).toBe(start.agentId)
    expect((streamStart!.data as any).threadId).toBe(start.threadId)

    // Should have text.delta events
    const textDeltas = events.filter(e => e.event === 'text.delta')
    expect(textDeltas.length).toBeGreaterThan(0)

    // Should have turn.end with usage
    const turnEnd = events.find(e => e.event === 'turn.end')
    expect(turnEnd).toBeDefined()
    expect((turnEnd!.data as any).usage.inputTokens).toBeGreaterThan(0)

    // Should have done event
    const done = events.find(e => e.event === 'done')
    expect(done).toBeDefined()
  }, 60_000)

  it('creates a thread and saves messages', async () => {
    if (skipIfNoKey()) return

    // Run without threadId — gateway creates one
    const { start, events } = await runAndCollectEvents({
        prompt: 'Say hello.',
        profileId: 'mini',
    })
    const threadId = start.threadId

    expect(threadId).toMatch(/^thread_/)

    // Verify thread exists
    const threadRes = await fetch(`${baseUrl}/api/v1/threads/${threadId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    const thread = await threadRes.json()
    expect(thread.id).toBe(threadId)
    expect(thread.messages.length).toBeGreaterThanOrEqual(2) // user + assistant

    // User message
    const userMsg = thread.messages.find((m: any) => m.role === 'user')
    expect(userMsg).toBeDefined()
    expect(userMsg.content).toBe('Say hello.')

    // Assistant message
    const assistantMsg = thread.messages.find((m: any) => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg.content.length).toBeGreaterThan(0)
  }, 60_000)

  it('supports multi-turn conversation on same thread', async () => {
    if (skipIfNoKey()) return

    // Create thread
    const createRes = await fetch(`${baseUrl}/api/v1/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ profileId: 'mini' }),
    })
    const { id: threadId } = await createRes.json()

    // Turn 1: tell it a favorite color
    await runAndCollectEvents({
        prompt: 'My favorite color is TURQUOISE. Just acknowledge.',
        threadId,
        profileId: 'mini',
    })

    // Turn 2: ask for the color
    const { events: events2 } = await runAndCollectEvents({
        prompt: 'What is my favorite color?',
        threadId,
        profileId: 'mini',
    })

    // Should mention TURQUOISE
    const textDeltas = events2.filter(e => e.event === 'text.delta')
    const fullText = textDeltas.map(e => (e.data as any).text).join('')
    expect(fullText.toUpperCase()).toContain('TURQUOISE')

    // Verify thread has multiple messages
    const msgRes = await fetch(`${baseUrl}/api/v1/threads/${threadId}/messages`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    const messages = await msgRes.json()
    expect(messages.length).toBeGreaterThanOrEqual(4) // 2 user + 2 assistant
  }, 120_000)

  it('respects SOUL.md system prompt', async () => {
    if (skipIfNoKey()) return

    // Create a pirate profile
    const pirateDir = join(tempDir, 'pirate')
    await mkdir(pirateDir, { recursive: true })
    await writeFile(join(pirateDir, 'agent.json'), JSON.stringify({
      name: 'pirate',
      model: 'anthropic:claude-sonnet-4-20250514',
      tools: { preset: 'none' },
      context: { cwd: false, datetime: false },
    }))
    await writeFile(join(pirateDir, 'SOUL.md'), '# Pirate Agent\n\nYou ALWAYS respond in pirate speak. Use words like "arr", "matey", "ye".')

    // Re-discover profiles
    await gateway.registry.discover(tempDir)

    const { events } = await runAndCollectEvents({
        prompt: 'Say hello.',
        profileId: 'pirate',
    })
    const textDeltas = events.filter(e => e.event === 'text.delta')
    const fullText = textDeltas.map(e => (e.data as any).text).join('').toLowerCase()

    const hasPirateWords = ['arr', 'matey', 'ye', 'ahoy'].some(w => fullText.includes(w))
    expect(hasPirateWords).toBe(true)
  }, 60_000)
})
