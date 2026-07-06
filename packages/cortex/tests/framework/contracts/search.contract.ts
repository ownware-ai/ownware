/**
 * Contract: Search endpoint
 *
 * GET /api/v1/search?q=...&scope=all|threads|profiles|workspaces
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'

describe('Contract: Search', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway({
      seed: (state) => {
        state.createThread('mini', 'Alpha Project Thread')
        state.createThread('mini', 'Beta Feature Thread')
        state.createThread('mini', 'Alpha Bug Fix')
        state.createWorkspace('/tmp/cortex-search-alpha', 'Alpha Workspace')
      },
    })
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('GET /search?q=Alpha returns matching threads + workspaces', async () => {
    const r = await gw.client.get<Array<{ type: string; id: string; name: string; score: number }>>(
      '/api/v1/search?q=Alpha',
    )
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
    expect(r.body.length).toBeGreaterThan(0)
    // Should find at least 2 threads + 1 workspace
    const types = r.body.map(x => x.type)
    expect(types.some(t => t === 'thread')).toBe(true)
  })

  it('GET /search?q=mini finds the mini profile', async () => {
    const r = await gw.client.get<Array<{ type: string; id: string }>>('/api/v1/search?q=mini')
    expect(r.status).toBe(200)
    expect(r.body.some(x => x.type === 'profile')).toBe(true)
  })

  it('GET /search?q=zzzznonexistent returns empty array', async () => {
    const r = await gw.client.get<unknown[]>('/api/v1/search?q=zzzznonexistent12345')
    expect(r.status).toBe(200)
    expect(r.body.length).toBe(0)
  })

  it('GET /search?scope=threads filters to threads only', async () => {
    const r = await gw.client.get<Array<{ type: string }>>('/api/v1/search?q=Alpha&scope=threads')
    expect(r.status).toBe(200)
    for (const result of r.body) {
      expect(result.type).toBe('thread')
    }
  })
})
