/**
 * Journey 09: Search + Thread export
 *
 *   1. Create searchable threads + workspaces
 *   2. Search by name → finds matches
 *   3. Search with no results → empty
 *   4. Export thread as markdown
 *   5. Export thread as JSON
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'

describe('Journey: 09 Search + Export', () => {
  let gw: TestGateway
  let exportThreadId: string

  beforeAll(async () => {
    gw = await createTestGateway({
      seed: (state) => {
        state.createThread('mini', 'Aurora Project Brainstorm')
        state.createThread('mini', 'Beta Bug Investigation')
        state.createThread('mini', 'Aurora Production Issues')
      },
    })
    // Create a thread we'll add a message to and export
    const t = gw.state.createThread('mini', 'Export Test Thread')
    exportThreadId = t.id
    gw.state.addMessage(exportThreadId, {
      id: 'msg_export_1',
      role: 'user',
      content: 'Hello, please summarize this',
      timestamp: new Date().toISOString(),
    })
    gw.state.addMessage(exportThreadId, {
      id: 'msg_export_2',
      role: 'assistant',
      content: 'Here is the summary you requested.',
      timestamp: new Date().toISOString(),
    })
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('Step 1: Search "Aurora" finds 2 threads', async () => {
    const r = await gw.client.get<Array<{ type: string; name: string }>>('/api/v1/search?q=Aurora')
    const threads = r.body.filter(x => x.type === 'thread')
    expect(threads.length).toBe(2)
  })

  it('Step 2: Search "mini" finds the profile', async () => {
    const r = await gw.client.get<Array<{ type: string }>>('/api/v1/search?q=mini')
    expect(r.body.some(x => x.type === 'profile')).toBe(true)
  })

  it('Step 3: Search "zzz" returns empty', async () => {
    const r = await gw.client.get<unknown[]>('/api/v1/search?q=zzznonexistent99')
    expect(r.body.length).toBe(0)
  })

  it('Step 4: Export thread as markdown contains messages', async () => {
    const r = await gw.client.get(`/api/v1/threads/${exportThreadId}/export?format=markdown`)
    expect(r.status).toBe(200)
    expect(r.raw).toContain('summary')
    expect(r.raw).toContain('Hello')
  })

  it('Step 5: Export thread as JSON returns { thread, messages }', async () => {
    const r = await gw.client.get<{ thread: unknown; messages: unknown[] }>(
      `/api/v1/threads/${exportThreadId}/export?format=json`,
    )
    expect(r.status).toBe(200)
    expect(r.body.thread).toBeDefined()
    expect(r.body.messages.length).toBe(2)
  })
})
