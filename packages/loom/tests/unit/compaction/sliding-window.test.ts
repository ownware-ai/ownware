import { describe, it, expect } from 'vitest'
import { slidingWindow } from '../../../src/compaction/sliding-window.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import { systemMsg, userMsg, assistantMsg, createConversation } from '../../helpers/fixtures.js'

describe('sliding-window strategy', () => {
  it('returns unchanged when conversation fits in window', async () => {
    const conv = createConversation(3) // 6 messages
    const provider = createMockProvider({ tokenCount: 500 })

    const result = await slidingWindow(conv, '', { type: 'messages', count: 10 }, provider)

    expect(result.messages).toEqual(conv)
    expect(result.preTokenCount).toBe(result.postTokenCount)
  })

  it('keeps window + overlap messages', async () => {
    const conv = createConversation(10) // 20 messages
    const provider = createMockProvider({ tokenCount: (msgs) => msgs.length * 100 })

    const result = await slidingWindow(
      conv, '', { type: 'messages', count: 6 }, provider, { overlap: 2 },
    )

    // Should have: context bridge (1) + window (6) = 7 messages
    expect(result.messages).toHaveLength(7)
    // First message should be the context bridge
    expect(result.messages[0]!.role).toBe('user')
    expect(typeof result.messages[0]!.content === 'string' &&
      result.messages[0]!.content.includes('[Prior context')).toBe(true)
    // Last 6 should be the window
    expect(result.messages.slice(-6)).toEqual(conv.slice(-6))
  })

  it('preserves system messages', async () => {
    const messages = [systemMsg('System'), ...createConversation(8)]
    const provider = createMockProvider({ tokenCount: (msgs) => msgs.length * 100 })

    const result = await slidingWindow(
      messages, '', { type: 'messages', count: 4 }, provider,
    )

    expect(result.messages[0]).toEqual(systemMsg('System'))
  })

  it('uses default overlap of 2', async () => {
    const conv = createConversation(10) // 20 messages
    const provider = createMockProvider({ tokenCount: (msgs) => msgs.length * 100 })

    const result = await slidingWindow(
      conv, '', { type: 'messages', count: 4 }, provider,
    )

    // Context bridge should mention 2 messages (default overlap)
    const bridge = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('[Prior context'),
    )
    expect(bridge).toBeDefined()
    expect(typeof bridge!.content === 'string' &&
      bridge!.content.includes('2 messages')).toBe(true)
  })

  it('handles custom overlap option', async () => {
    const conv = createConversation(10) // 20 messages
    const provider = createMockProvider({ tokenCount: (msgs) => msgs.length * 100 })

    const result = await slidingWindow(
      conv, '', { type: 'messages', count: 4 }, provider, { overlap: 5 },
    )

    const bridge = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('[Prior context'),
    )
    expect(bridge).toBeDefined()
    expect(typeof bridge!.content === 'string' &&
      bridge!.content.includes('5 messages')).toBe(true)
  })

  it('works with fraction retain type', async () => {
    const conv = createConversation(10) // 20 messages
    const provider = createMockProvider({ tokenCount: (msgs) => msgs.length * 100 })

    // 0.3 * 20 = 6 messages
    const result = await slidingWindow(
      conv, '', { type: 'fraction', amount: 0.3 }, provider,
    )

    // Window of 6 + context bridge
    expect(result.messages.length).toBeLessThan(conv.length)
    expect(result.messages.slice(-6)).toEqual(conv.slice(-6))
  })

  it('reports strategy as "sliding_window"', async () => {
    const conv = createConversation(5)
    const provider = createMockProvider({ tokenCount: 500 })

    const result = await slidingWindow(
      conv, '', { type: 'messages', count: 4 }, provider,
    )

    expect(result.strategy).toBe('sliding_window')
  })

  it('does not include summaryUsage (no LLM call)', async () => {
    const conv = createConversation(10)
    const provider = createMockProvider({ tokenCount: 1000 })

    const result = await slidingWindow(
      conv, '', { type: 'messages', count: 4 }, provider,
    )

    expect(result.summaryUsage).toBeUndefined()
  })
})
