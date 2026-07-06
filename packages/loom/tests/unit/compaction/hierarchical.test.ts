import { describe, it, expect } from 'vitest'
import { hierarchical } from '../../../src/compaction/hierarchical.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import { systemMsg, userMsg, assistantMsg, createConversation } from '../../helpers/fixtures.js'
import type { Message } from '../../../src/messages/types.js'

describe('hierarchical strategy', () => {
  it('groups messages by topic (user message after assistant = new topic)', async () => {
    // Create a conversation with clear topic boundaries:
    // Topic 1: 5 turns, Topic 2: 5 turns
    const topic1 = createConversation(5)
    const topic2 = createConversation(5)
    const all = [...topic1, ...topic2]

    const provider = createMockProvider({
      summaryResponse: 'Topic summary.',
      tokenCount: (msgs) => msgs.length * 100,
    })

    const result = await hierarchical(
      all, '', { type: 'messages', count: 2 }, provider,
    )

    // Should have made multiple stream calls (topic summaries + session summary)
    expect(provider.streamCallCount).toBeGreaterThan(1)
    expect(result.strategy).toBe('hierarchical')
  })

  it('makes N+1 LLM calls (N topic groups + 1 session summary)', async () => {
    // Create a long conversation with topic shifts
    const messages: Message[] = []
    // 3 topic groups, each with 5+ messages
    for (let topic = 0; topic < 3; topic++) {
      for (let turn = 0; turn < 3; turn++) {
        messages.push(userMsg(`Topic ${topic} question ${turn}`))
        messages.push(assistantMsg(`Topic ${topic} answer ${turn}`))
      }
    }
    // Add retained messages
    messages.push(userMsg('Final question'))
    messages.push(assistantMsg('Final answer'))

    const provider = createMockProvider({
      summaryResponse: 'Summary.',
      tokenCount: (msgs) => msgs.length * 100,
    })

    await hierarchical(
      messages, '', { type: 'messages', count: 2 }, provider,
    )

    // At least 2 calls: some topic summaries + 1 session summary
    // (small groups < 4 messages get text extraction, not LLM calls)
    expect(provider.streamCallCount).toBeGreaterThanOrEqual(2)
    // Last call should be the session summary
    const lastReq = provider.streamRequests.at(-1)!
    const content = lastReq.messages[0]!.content as string
    expect(content).toContain('topic summaries')
  })

  it('session summary includes all topic summaries', async () => {
    const conv = createConversation(10)
    const provider = createMockProvider({
      summaryResponse: 'A detailed topic summary.',
      tokenCount: (msgs) => msgs.length * 100,
    })

    const result = await hierarchical(
      conv, '', { type: 'messages', count: 2 }, provider,
    )

    // The summary message should contain topic details
    const summaryContent = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('Topic Details'),
    )
    expect(summaryContent).toBeDefined()
  })

  it('accumulates total usage across all calls', async () => {
    const conv = createConversation(10)
    const provider = createMockProvider({
      summaryResponse: 'Summary.',
      tokenCount: (msgs) => msgs.length * 100,
    })

    const result = await hierarchical(
      conv, '', { type: 'messages', count: 2 }, provider,
    )

    expect(result.summaryUsage).toBeDefined()
    // Each call returns 100 input + 50 output from mock
    // Total should be multiples of those
    expect(result.summaryUsage!.inputTokens).toBeGreaterThanOrEqual(100)
    expect(result.summaryUsage!.outputTokens).toBeGreaterThanOrEqual(50)
  })

  it('throws on empty session summary', async () => {
    const conv = createConversation(10)
    let callCount = 0
    const provider = createMockProvider({
      summaryResponse: () => {
        callCount++
        // Topic summaries succeed, session summary returns empty
        // The last call is the session summary
        if (callCount > 2) return ''
        return 'Topic summary.'
      },
      tokenCount: (msgs) => msgs.length * 100,
    })

    await expect(
      hierarchical(conv, '', { type: 'messages', count: 2 }, provider),
    ).rejects.toThrow()
  })

  it('preserves system messages', async () => {
    const messages = [systemMsg('Be helpful'), ...createConversation(8)]
    const provider = createMockProvider({
      summaryResponse: 'Summary.',
      tokenCount: (msgs) => msgs.length * 100,
    })

    const result = await hierarchical(
      messages, '', { type: 'messages', count: 2 }, provider,
    )

    expect(result.messages[0]).toEqual(systemMsg('Be helpful'))
  })

  it('result format: [system, hierarchical_summary, ...retained]', async () => {
    const messages = [systemMsg('System'), ...createConversation(8)]
    const provider = createMockProvider({
      summaryResponse: 'Summary.',
      tokenCount: (msgs) => msgs.length * 100,
    })

    const result = await hierarchical(
      messages, '', { type: 'messages', count: 4 }, provider,
    )

    // System + summary + 4 retained
    expect(result.messages[0]!.role).toBe('system')
    expect(result.messages[1]!.role).toBe('user')
    const summaryContent = result.messages[1]!.content as string
    expect(summaryContent).toContain('hierarchical summary')
    // Last 4 should be retained
    expect(result.messages.slice(-4)).toEqual(messages.slice(-4))
  })

  it('no-ops when nothing to summarize', async () => {
    const conv = createConversation(2) // 4 messages
    const provider = createMockProvider({ tokenCount: 200 })

    const result = await hierarchical(
      conv, '', { type: 'messages', count: 10 }, provider,
    )

    expect(result.messages).toEqual(conv)
    expect(provider.streamCallCount).toBe(0)
  })

  it('reports strategy as "hierarchical"', async () => {
    const conv = createConversation(8)
    const provider = createMockProvider({
      summaryResponse: 'Summary.',
      tokenCount: (msgs) => msgs.length * 100,
    })

    const result = await hierarchical(
      conv, '', { type: 'messages', count: 2 }, provider,
    )

    expect(result.strategy).toBe('hierarchical')
  })
})
