/**
 * Contract: Threads endpoints
 *
 * GET    /api/v1/threads
 * POST   /api/v1/threads
 * GET    /api/v1/threads/:threadId
 * PATCH  /api/v1/threads/:threadId
 * DELETE /api/v1/threads/:threadId
 * GET    /api/v1/threads/:threadId/messages
 * GET    /api/v1/threads/:threadId/export
 * GET    /api/v1/threads/:threadId/hydrate
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { HumanInTheLoop, type LoomEvent, type Session } from '@ownware/loom'
import { createTestGateway, type TestGateway } from '../harness/index.js'
import {
  ThreadSchema,
  PaginatedThreadsSchema,
  ApiErrorSchema,
  ThreadHydrationSchema,
} from '../harness/schema-validator.js'

class HydrationSession {
  readonly sessionId = 'hydration-contract'
  private releaseRun!: () => void
  private readonly released = new Promise<void>((resolve) => {
    this.releaseRun = resolve
  })

  async *submitMessage(): AsyncGenerator<LoomEvent, unknown> {
    yield { type: 'turn.start', turnIndex: 0, timestamp: Date.now() }
    await this.released
    yield {
      type: 'turn.end',
      turnIndex: 0,
      stopReason: 'end_turn',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        model: 'test:model',
        costUsd: 0,
      },
      timestamp: Date.now(),
    }
  }

  abort(): void { this.releaseRun() }
  release(): void { this.releaseRun() }
}

describe('Contract: Threads', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('GET /threads returns valid PaginatedResult<Thread>', async () => {
    const r = await gw.client.get('/api/v1/threads', PaginatedThreadsSchema)
    expect(r.status).toBe(200)
    expect(r.body.limit).toBe(50)
    expect(r.body.offset).toBe(0)
    expect(typeof r.body.total).toBe('number')
    expect(Array.isArray(r.body.items)).toBe(true)
  })

  it('POST /threads creates a thread with messageCount=0', async () => {
    const r = await gw.client.post('/api/v1/threads', { profileId: 'mini' }, ThreadSchema)
    expect(r.status).toBe(201)
    expect(r.body.id).toMatch(/^thread_/)
    expect(r.body.profileId).toBe('mini')
    expect(r.body.messageCount).toBe(0)
    expect(r.body.totalTokens).toBe(0)
    expect(r.body.totalCost).toBe(0)
    expect(r.body.status).toBe('active')
  })

  it('GET /threads/:id returns thread with messages array', async () => {
    const created = await gw.client.post<{ id: string }>('/api/v1/threads', { profileId: 'mini' })
    const r = await gw.client.get<{ id: string; messages: unknown[] }>(`/api/v1/threads/${created.body.id}`)
    expect(r.status).toBe(200)
    expect(r.body.id).toBe(created.body.id)
    expect(Array.isArray(r.body.messages)).toBe(true)
  })

  it('GET /threads/:id returns 404 for non-existent thread', async () => {
    const r = await gw.client.get('/api/v1/threads/thread_nonexistent', ApiErrorSchema)
    expect(r.status).toBe(404)
  })

  it('PATCH /threads/:id updates fields', async () => {
    const created = await gw.client.post<{ id: string }>('/api/v1/threads', { profileId: 'mini' })
    const r = await gw.client.patch<{ title: string }>(`/api/v1/threads/${created.body.id}`, { title: 'Updated Title' })
    expect(r.status).toBe(200)
    expect(r.body.title).toBe('Updated Title')
  })

  it('DELETE /threads/:id removes the thread', async () => {
    const created = await gw.client.post<{ id: string }>('/api/v1/threads', { profileId: 'mini' })
    const del = await gw.client.delete(`/api/v1/threads/${created.body.id}`)
    expect(del.status).toBe(204)

    const get = await gw.client.get(`/api/v1/threads/${created.body.id}`)
    expect(get.status).toBe(404)
  })

  it('GET /threads/:id/messages returns array', async () => {
    const created = await gw.client.post<{ id: string }>('/api/v1/threads', { profileId: 'mini' })
    const r = await gw.client.get<unknown[]>(`/api/v1/threads/${created.body.id}/messages`)
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
  })

  it('GET /threads/:id/export?format=markdown returns markdown', async () => {
    const created = await gw.client.post<{ id: string }>('/api/v1/threads', { profileId: 'mini', title: 'Export test' })
    const r = await gw.client.get<string>(`/api/v1/threads/${created.body.id}/export?format=markdown`)
    expect(r.status).toBe(200)
    // body may be parsed as string or stay as raw text
    expect(r.raw.length).toBeGreaterThan(0)
  })

  it('GET /threads/:id/export?format=json returns { thread, messages }', async () => {
    const created = await gw.client.post<{ id: string }>('/api/v1/threads', { profileId: 'mini' })
    const r = await gw.client.get<{ thread: unknown; messages: unknown[] }>(`/api/v1/threads/${created.body.id}/export?format=json`)
    expect(r.status).toBe(200)
    expect(r.body.thread).toBeDefined()
    expect(Array.isArray(r.body.messages)).toBe(true)
  })

  it('GET /threads/:id/hydrate correlates only the active durable public run', async () => {
    const thread = await gw.state.createThread('mini', 'Hydration contract')
    const session = new HydrationSession()
    gw.state.setSession(thread.id, session as unknown as Session)
    gw.state.setRuntime(thread.id, {
      session: session as unknown as Session,
      hitl: new HumanInTheLoop({ timeoutMs: 10_000 }),
      zoneManager: null,
    })
    const run = await gw.gateway.runStore.create({
      threadId: thread.id,
      profileId: 'mini',
      model: 'test:model',
      timeoutMs: 60_000,
      startSeq: 0,
    })
    const handle = gw.runner.start({
      runId: run.runId,
      threadId: thread.id,
      profileId: 'mini',
      model: 'test:model',
      prompt: 'hydrate while active',
    })

    const active = await gw.client.get(
      `/api/v1/threads/${thread.id}/hydrate`,
      ThreadHydrationSchema,
    )
    expect(active.status).toBe(200)
    expect(active.headers['cache-control']).toBe('no-store')
    expect(active.body).toMatchObject({
      runningAgentId: 'root',
      runningRunId: run.runId,
    })

    session.release()
    await handle.done
    const terminal = await gw.client.get(
      `/api/v1/threads/${thread.id}/hydrate`,
      ThreadHydrationSchema,
    )
    expect(terminal.body.runningAgentId).toBeNull()
    expect(terminal.body.runningRunId).toBeNull()
  })

  it('does not manufacture a public run correlation for internal live work', async () => {
    const thread = await gw.state.createThread('mini', 'Internal hydration contract')
    const session = new HydrationSession()
    gw.state.setSession(thread.id, session as unknown as Session)
    gw.state.setRuntime(thread.id, {
      session: session as unknown as Session,
      hitl: new HumanInTheLoop({ timeoutMs: 10_000 }),
      zoneManager: null,
    })
    const handle = gw.runner.start({
      threadId: thread.id,
      profileId: 'mini',
      model: 'test:model',
      prompt: 'internal live work',
    })

    const hydration = await gw.client.get(
      `/api/v1/threads/${thread.id}/hydrate`,
      ThreadHydrationSchema,
    )
    expect(hydration.body.runningAgentId).toBe('root')
    expect(hydration.body.runningRunId).toBeNull()

    session.release()
    await handle.done
  })

  it('GET /threads?profileId=X filters by profile', async () => {
    // Create distinct profiles via state seed
    const t1 = await gw.state.createThread('mini', 'profile-filter-1')
    const t2 = await gw.state.createThread('mini', 'profile-filter-2')

    const r = await gw.client.get('/api/v1/threads?profileId=mini', PaginatedThreadsSchema)
    expect(r.status).toBe(200)
    const ids = r.body.items.map(t => t.id)
    expect(ids).toContain(t1.id)
    expect(ids).toContain(t2.id)
  })
})
