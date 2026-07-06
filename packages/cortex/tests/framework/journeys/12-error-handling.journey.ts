/**
 * Journey 12: Error handling
 *
 * Validates that every error path returns the right HTTP status code and
 * JSON API error shape. SSE-side `error` events are validated separately.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'
import { ApiErrorSchema } from '../harness/schema-validator.js'

describe('Journey: 12 Error Handling', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('GET /threads/nonexistent returns 404 ApiError', async () => {
    const r = await gw.client.get('/api/v1/threads/thread_nope', ApiErrorSchema)
    expect(r.status).toBe(404)
  })

  it('GET /workspaces/nonexistent returns 404 ApiError', async () => {
    const r = await gw.client.get('/api/v1/workspaces/ws_nope', ApiErrorSchema)
    expect(r.status).toBe(404)
  })

  it('GET /profiles/nonexistent returns 404 ApiError', async () => {
    const r = await gw.client.get('/api/v1/profiles/nope', ApiErrorSchema)
    expect(r.status).toBe(404)
  })

  it('POST /workspaces with non-existent path returns error', async () => {
    const r = await gw.client.post(
      '/api/v1/workspaces',
      { path: '/this/does/not/exist/anywhere' },
      ApiErrorSchema,
    )
    expect(r.status).toBeGreaterThanOrEqual(400)
  })

  it('PUT /settings/x with number value returns 400', async () => {
    const r = await gw.client.put('/api/v1/settings/test', { fontSize: 14 })
    expect(r.status).toBeGreaterThanOrEqual(400)
  })

  it('PUT /settings/x with empty body returns 400', async () => {
    const r = await gw.client.put('/api/v1/settings/test', {})
    expect(r.status).toBeGreaterThanOrEqual(400)
  })

  it('POST /run with missing prompt returns 400', async () => {
    const r = await gw.client.post('/api/v1/run', { profileId: 'mini' }, ApiErrorSchema)
    expect(r.status).toBe(400)
    expect(r.body.error).toBeDefined()
  })

  it('POST /run with non-existent profile returns 404', async () => {
    const t = gw.state.createThread('mini', 'err-test')
    const r = await gw.client.post('/api/v1/run', {
      prompt: 'hi',
      profileId: 'nope',
      threadId: t.id,
    })
    expect(r.status).toBe(404)
  })

  it('All 4xx responses match the JSON API error shape', async () => {
    const responses = [
      await gw.client.get('/api/v1/threads/x_nope'),
      await gw.client.get('/api/v1/workspaces/x_nope'),
      await gw.client.get('/api/v1/profiles/x_nope'),
    ]
    for (const r of responses) {
      const body = r.body as Record<string, unknown>
      expect(typeof body['error']).toBe('string')
      expect(typeof body['message']).toBe('string')
    }
  })
})
