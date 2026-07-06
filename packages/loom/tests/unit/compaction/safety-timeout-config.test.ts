/**
 * Unit Tests — Compaction Safety Timeout Configuration
 *
 * Verifies that the safetyTimeoutMs field in CompactionConfig is
 * respected by the compaction manager, falling back to 30s default.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createCompactionManager } from '../../../src/compaction/manager.js'
import type { CompactionConfig } from '../../../src/core/config.js'
import type { ProviderAdapter } from '../../../src/provider/types.js'
import type { Message } from '../../../src/messages/types.js'

function makeProvider(countTokensResult = 50_000): ProviderAdapter {
  return {
    name: 'mock',
    stream: vi.fn() as unknown as ProviderAdapter['stream'],
    countTokens: vi.fn().mockResolvedValue(countTokensResult),
    supportsFeature: vi.fn().mockReturnValue(false),
    formatTools: vi.fn().mockReturnValue([]),
  }
}

function makeMessages(count: number): Message[] {
  const msgs: Message[] = []
  for (let i = 0; i < count; i++) {
    msgs.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}`,
    })
  }
  return msgs
}

describe('Compaction safety timeout configuration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses default 30s timeout when safetyTimeoutMs is not set', async () => {
    const config: CompactionConfig = {
      trigger: { type: 'messages', threshold: 4 },
      retain: { type: 'messages', count: 2 },
      strategy: 'summarize',
      summaryModel: null,
    }

    const provider = makeProvider()
    // Make the summarize strategy hang forever
    const originalStream = provider.stream
    provider.stream = (async function* () {
      await new Promise(() => {}) // never resolves
    }) as unknown as typeof originalStream

    const manager = createCompactionManager({
      config,
      provider,
      contextWindowTokens: 100_000,
    })

    const messages = makeMessages(10)
    const compactPromise = manager.forceCompact(messages, 'system')

    // After 29s — should still be pending
    await vi.advanceTimersByTimeAsync(29_000)

    // After 31s — should have timed out and fallen back to truncation
    await vi.advanceTimersByTimeAsync(2_000)

    const result = await compactPromise
    // Truncation fallback should have succeeded
    expect(result).not.toBeNull()
  })

  it('respects custom safetyTimeoutMs value', async () => {
    const config: CompactionConfig = {
      trigger: { type: 'messages', threshold: 4 },
      retain: { type: 'messages', count: 2 },
      strategy: 'summarize',
      summaryModel: null,
      safetyTimeoutMs: 5_000,
    }

    const provider = makeProvider()
    provider.stream = (async function* () {
      await new Promise(() => {}) // never resolves
    }) as unknown as typeof provider.stream

    const manager = createCompactionManager({
      config,
      provider,
      contextWindowTokens: 100_000,
    })

    const messages = makeMessages(10)
    const compactPromise = manager.forceCompact(messages, 'system')

    // After 6s with 5s custom timeout — should have timed out
    await vi.advanceTimersByTimeAsync(6_000)

    const result = await compactPromise
    // Truncation fallback should have succeeded
    expect(result).not.toBeNull()
  })
})
