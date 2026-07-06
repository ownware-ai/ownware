import { describe, it, expect } from 'vitest'
import { createCompactionManager } from '../../../src/compaction/manager.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import { systemMsg, createConversation } from '../../helpers/fixtures.js'
import type { CompactionConfig } from '../../../src/core/config.js'

/**
 * Integration tests: manager wired to real strategies.
 * These test the full flow from trigger evaluation through strategy execution.
 */

function makeConfig(overrides: Partial<CompactionConfig> = {}): CompactionConfig {
  return {
    trigger: { type: 'tokens', threshold: 1000 },
    retain: { type: 'messages', count: 4 },
    strategy: 'truncate',
    summaryModel: null,
    ...overrides,
  }
}

describe('manager + strategies integration', () => {
  it('manager + summarize: full flow from trigger → LLM call → result', async () => {
    const provider = createMockProvider({
      tokenCount: (msgs) => msgs.length * 200,
      summaryResponse: 'Integration test summary of the conversation.',
    })

    const manager = createCompactionManager({
      config: makeConfig({ strategy: 'summarize' }),
      provider,
      contextWindowTokens: 50_000,
    })

    const messages = [systemMsg('System'), ...createConversation(8)]
    const result = await manager.compactIfNeeded(messages, 'system')

    expect(result).not.toBeNull()
    expect(result!.strategy).toBe('summarize')
    // system + summary + 4 retained
    expect(result!.messages[0]!.role).toBe('system')
    expect(result!.messages[1]!.role).toBe('user')
    const summaryContent = result!.messages[1]!.content as string
    expect(summaryContent).toContain('Integration test summary')
    expect(result!.messages.slice(-4)).toEqual(messages.slice(-4))
    expect(result!.summaryUsage).toBeDefined()
    expect(result!.preTokenCount).toBeGreaterThan(result!.postTokenCount)
  })

  it('manager + truncate: full flow without LLM', async () => {
    const provider = createMockProvider({
      tokenCount: (msgs) => msgs.length * 200,
    })

    const manager = createCompactionManager({
      config: makeConfig({ strategy: 'truncate' }),
      provider,
      contextWindowTokens: 50_000,
    })

    const messages = createConversation(8) // 16 messages
    const result = await manager.compactIfNeeded(messages, '')

    expect(result).not.toBeNull()
    expect(result!.strategy).toBe('truncate')
    expect(result!.messages).toHaveLength(4) // retain count
    expect(result!.messages).toEqual(messages.slice(-4))
    expect(result!.summaryUsage).toBeUndefined()
    expect(provider.streamCallCount).toBe(0) // No LLM calls
  })

  it('manager + hierarchical: multiple LLM calls through manager', async () => {
    const provider = createMockProvider({
      tokenCount: (msgs) => msgs.length * 200,
      summaryResponse: 'Hierarchical summary chunk.',
    })

    const manager = createCompactionManager({
      config: makeConfig({ strategy: 'hierarchical' }),
      provider,
      contextWindowTokens: 50_000,
    })

    const messages = createConversation(12) // 24 messages
    const result = await manager.compactIfNeeded(messages, '')

    expect(result).not.toBeNull()
    expect(result!.strategy).toBe('hierarchical')
    expect(result!.summaryUsage).toBeDefined()
    // Multiple LLM calls (topic summaries + session summary)
    expect(provider.streamCallCount).toBeGreaterThan(1)
  })

  it('fallback chain: summarize fails → truncate succeeds', async () => {
    const provider = createMockProvider({
      tokenCount: (msgs) => msgs.length * 200,
      failOnStreamCall: 1, // First stream call (summarization) fails
      streamError: new Error('LLM unavailable'),
    })

    const manager = createCompactionManager({
      config: makeConfig({ strategy: 'summarize' }),
      provider,
      contextWindowTokens: 50_000,
    })

    const messages = createConversation(8)
    const result = await manager.compactIfNeeded(messages, '')

    // Should fall back to truncate
    expect(result).not.toBeNull()
    expect(result!.strategy).toBe('truncate')
    expect(result!.messages).toHaveLength(4)
  })

  it('different retain types produce different results', async () => {
    const messages = createConversation(10) // 20 messages
    const provider = createMockProvider({
      tokenCount: (msgs) => msgs.length * 200,
    })

    const managerByCount = createCompactionManager({
      config: makeConfig({
        strategy: 'truncate',
        retain: { type: 'messages', count: 6 },
      }),
      provider,
      contextWindowTokens: 50_000,
    })

    const managerByFraction = createCompactionManager({
      config: makeConfig({
        strategy: 'truncate',
        retain: { type: 'fraction', amount: 0.5 },
      }),
      provider,
      contextWindowTokens: 50_000,
    })

    const r1 = await managerByCount.compactIfNeeded(messages, '')
    const r2 = await managerByFraction.compactIfNeeded(messages, '')

    expect(r1!.messages).toHaveLength(6)
    expect(r2!.messages).toHaveLength(10) // 50% of 20
    expect(r1!.messages).not.toEqual(r2!.messages)
  })

  it('circuit breaker persists across multiple compactIfNeeded calls', async () => {
    // Use message-based trigger (no countTokens call in trigger check)
    // and a provider whose countTokens always throws (fails inside strategy)
    const provider = createMockProvider({
      tokenCount: () => { throw new Error('countTokens fail') },
    })

    const manager = createCompactionManager({
      config: makeConfig({
        strategy: 'truncate',
        trigger: { type: 'messages', threshold: 3 },
      }),
      provider,
      contextWindowTokens: 10_000,
    })

    const conv = createConversation(5)

    // 3 failures (truncate calls countTokens which throws)
    for (let i = 0; i < 3; i++) {
      try { await manager.compactIfNeeded(conv, '') } catch { /* expected */ }
    }

    // Should be null now (circuit breaker tripped)
    const result = await manager.compactIfNeeded(conv, '')
    expect(result).toBeNull()
  })
})
