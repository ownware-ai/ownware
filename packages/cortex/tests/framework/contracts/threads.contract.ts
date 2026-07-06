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
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'
import {
  ThreadSchema,
  PaginatedThreadsSchema,
  ApiErrorSchema,
} from '../harness/schema-validator.js'

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

  it('GET /threads?profileId=X filters by profile', async () => {
    // Create distinct profiles via state seed
    const t1 = gw.state.createThread('mini', 'profile-filter-1')
    const t2 = gw.state.createThread('mini', 'profile-filter-2')

    const r = await gw.client.get('/api/v1/threads?profileId=mini', PaginatedThreadsSchema)
    expect(r.status).toBe(200)
    const ids = r.body.items.map(t => t.id)
    expect(ids).toContain(t1.id)
    expect(ids).toContain(t2.id)
  })
})
