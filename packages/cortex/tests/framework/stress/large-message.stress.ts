/**
 * Stress: Large message handling
 *
 * Send a 10KB message, verify no truncation in DB or response.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'

describe('Stress: Large message', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('10KB message content stored without truncation', () => {
    const t = gw.state.createThread('mini', 'large-msg')
    const content = 'A'.repeat(10_000)
    gw.state.addMessage(t.id, {
      id: 'msg_large',
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    })

    const messages = gw.state.getMessages(t.id)
    expect(messages.length).toBe(1)
    expect(messages[0]!.content.length).toBe(10_000)
  })

  it('lastMessagePreview is truncated to 200 chars', () => {
    const t = gw.state.createThread('mini', 'large-preview')
    const content = 'B'.repeat(5_000)
    gw.state.addMessage(t.id, {
      id: 'msg_preview',
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    })

    const updated = gw.state.getThread(t.id)!
    expect(updated.lastMessagePreview?.length).toBe(200)
  })

  it('100 messages each 1KB on same thread accumulate correctly', () => {
    const t = gw.state.createThread('mini', 'many-large')
    for (let i = 0; i < 100; i++) {
      gw.state.addMessage(t.id, {
        id: `msg_many_${i}`,
        role: 'user',
        content: 'X'.repeat(1_000),
        timestamp: new Date().toISOString(),
      })
    }
    const updated = gw.state.getThread(t.id)!
    expect(updated.messageCount).toBe(100)
    const messages = gw.state.getMessages(t.id)
    expect(messages.length).toBe(100)
    for (const m of messages) {
      expect(m.content.length).toBe(1_000)
    }
  })
})
