/**
 * Harness smoke test — verifies the harness itself works.
 * No real API calls. Just gateway start, basic GET, parse, stop.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from './index.js'
import { PaginatedThreadsSchema, ThreadSchema } from './schema-validator.js'

describe('Harness smoke test', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('starts a gateway with a port', () => {
    expect(gw.port).toBeGreaterThan(0)
    expect(gw.token).toBeTruthy()
  })

  it('seeds the mini profile by default', async () => {
    const r = await gw.client.get<unknown[]>('/api/v1/profiles')
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
    expect((r.body as any[]).some(p => p.name === 'mini')).toBe(true)
  })

  it('GET /threads returns valid PaginatedResult<Thread>', async () => {
    // Create one thread first
    await gw.client.post('/api/v1/threads', { profileId: 'mini' })

    const r = await gw.client.get('/api/v1/threads', PaginatedThreadsSchema)
    expect(r.status).toBe(200)
    expect(r.body.items.length).toBeGreaterThanOrEqual(1)
    expect(r.body.total).toBeGreaterThanOrEqual(1)
    expect(r.body.limit).toBe(50)
    expect(r.body.offset).toBe(0)
  })

  it('Thread schema validates', async () => {
    const create = await gw.client.post('/api/v1/threads', { profileId: 'mini' }, ThreadSchema)
    expect(create.status).toBe(201)
    expect(create.body.id).toMatch(/^thread_/)
    expect(create.body.profileId).toBe('mini')
    expect(create.body.messageCount).toBe(0)
  })

  it('direct state access works', () => {
    const before = gw.state.threadCount
    gw.state.createThread('mini', 'Direct create test')
    expect(gw.state.threadCount).toBe(before + 1)
  })
})
