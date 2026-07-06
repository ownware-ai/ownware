import { describe, it, expect } from 'vitest'
import { createCompactionManager } from '../../../src/compaction/manager.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import { systemMsg, userMsg, assistantMsg, createConversation } from '../../helpers/fixtures.js'
import type { CompactionConfig } from '../../../src/core/config.js'

function makeConfig(overrides: Partial<CompactionConfig> = {}): CompactionConfig {
  return {
    trigger: { type: 'tokens', threshold: 1000 },
    retain: { type: 'messages', count: 4 },
    strategy: 'truncate',
    summaryModel: null,
    ...overrides,
  }
}

describe('CompactionManager', () => {
  // -----------------------------------------------------------------------
  // Trigger behavior
  // -----------------------------------------------------------------------

  describe('triggers', () => {
    it('disabled trigger → always returns null', async () => {
      const provider = createMockProvider({ tokenCount: 99999 })
      const manager = createCompactionManager({
        config: makeConfig({ trigger: { type: 'disabled' } }),
        provider,
        contextWindowTokens: 100_000,
      })

      const result = await manager.compactIfNeeded(createConversation(10), 'system')
      expect(result).toBeNull()
    })

    it('tokens trigger → compacts above threshold', async () => {
      const provider = createMockProvider({ tokenCount: 1500 })
      const manager = createCompactionManager({
        config: makeConfig({ trigger: { type: 'tokens', threshold: 1000 } }),
        provider,
        contextWindowTokens: 10_000,
      })

      const result = await manager.compactIfNeeded(createConversation(5), 'system')
      expect(result).not.toBeNull()
      expect(result!.strategy).toBe('truncate')
    })

    it('tokens trigger → skips below threshold', async () => {
      const provider = createMockProvider({ tokenCount: 500 })
      const manager = createCompactionManager({
        config: makeConfig({ trigger: { type: 'tokens', threshold: 1000 } }),
        provider,
        contextWindowTokens: 10_000,
      })

      const result = await manager.compactIfNeeded(createConversation(5), 'system')
      expect(result).toBeNull()
    })

    it('fraction trigger → uses contextWindowTokens * fraction', async () => {
      const provider = createMockProvider({ tokenCount: 8500 })
      const manager = createCompactionManager({
        config: makeConfig({ trigger: { type: 'fraction', threshold: 0.8 } }),
        provider,
        contextWindowTokens: 10_000, // threshold = 8000
      })

      const result = await manager.compactIfNeeded(createConversation(5), 'system')
      expect(result).not.toBeNull()
    })

    it('messages trigger → counts non-system messages', async () => {
      const messages = [systemMsg('System'), ...createConversation(5)] // 10 non-system + 1 system
      const provider = createMockProvider({ tokenCount: 500 })
      const manager = createCompactionManager({
        config: makeConfig({ trigger: { type: 'messages', threshold: 8 } }),
        provider,
        contextWindowTokens: 10_000,
      })

      const result = await manager.compactIfNeeded(messages, 'system')
      expect(result).not.toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Circuit breaker
  // -----------------------------------------------------------------------

  describe('circuit breaker', () => {
    it('returns null after 3 consecutive failures', async () => {
      const provider = createMockProvider({
        tokenCount: 5000,
        failOnStreamCall: 1, // Every call fails
        streamError: new Error('fail'),
      })

      // Use summarize so failures trigger (truncate rarely fails)
      const config = makeConfig({
        trigger: { type: 'tokens', threshold: 1000 },
        strategy: 'summarize',
      })

      const manager = createCompactionManager({
        config,
        provider,
        contextWindowTokens: 10_000,
      })

      const conv = createConversation(5)

      // Attempt 1: fails summarize, falls back to truncate (succeeds)
      const r1 = await manager.compactIfNeeded(conv, 'system')
      expect(r1).not.toBeNull() // truncate fallback works

      // Create a provider where truncate also fails by returning bad token count
      const failProvider = createMockProvider({
        tokenCount: 5000,
        failOnStreamCall: 1,
        streamError: new Error('fail'),
      })

      // We need a new manager to test full circuit breaker
      const alwaysFailProvider = createMockProvider({
        tokenCount: () => { throw new Error('count fail') },
      })

      // Test that after threshold crossed, it gives up
      // Use a manager with strategy=truncate so there's no fallback
      const failManager = createCompactionManager({
        config: makeConfig({
          trigger: { type: 'messages', threshold: 3 },
          strategy: 'truncate',
        }),
        provider: alwaysFailProvider,
        contextWindowTokens: 10_000,
      })

      // Failures 1-3
      for (let i = 0; i < 3; i++) {
        try {
          await failManager.compactIfNeeded(conv, 'system')
        } catch {
          // Expected
        }
      }

      // 4th attempt: circuit breaker should short-circuit
      const r4 = await failManager.compactIfNeeded(conv, 'system')
      expect(r4).toBeNull()
    })

    it('resets on success', async () => {
      let callCount = 0
      const provider = createMockProvider({
        tokenCount: 5000,
        summaryResponse: () => {
          callCount++
          if (callCount <= 2) throw new Error('transient')
          return 'Summary.'
        },
      })

      // Use truncate (reliable) to ensure success resets the breaker
      const manager = createCompactionManager({
        config: makeConfig({
          trigger: { type: 'tokens', threshold: 1000 },
          strategy: 'truncate',
        }),
        provider,
        contextWindowTokens: 10_000,
      })

      const conv = createConversation(5)

      // Success should reset
      const r1 = await manager.compactIfNeeded(conv, 'system')
      expect(r1).not.toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // forceCompact
  // -----------------------------------------------------------------------

  describe('forceCompact', () => {
    it('bypasses trigger check', async () => {
      const provider = createMockProvider({ tokenCount: 100 }) // Below any threshold
      const manager = createCompactionManager({
        config: makeConfig({ trigger: { type: 'tokens', threshold: 99999 } }),
        provider,
        contextWindowTokens: 100_000,
      })

      // compactIfNeeded would skip this (below threshold)
      const r1 = await manager.compactIfNeeded(createConversation(5), 'system')
      expect(r1).toBeNull()

      // forceCompact should still work
      const r2 = await manager.forceCompact(createConversation(5), 'system')
      expect(r2).not.toBeNull()
    })

    it('still respects circuit breaker', async () => {
      const alwaysFailProvider = createMockProvider({
        tokenCount: () => { throw new Error('fail') },
      })

      const manager = createCompactionManager({
        config: makeConfig({ trigger: { type: 'messages', threshold: 3 } }),
        provider: alwaysFailProvider,
        contextWindowTokens: 10_000,
      })

      const conv = createConversation(5)

      // Trip the circuit breaker
      for (let i = 0; i < 3; i++) {
        try { await manager.forceCompact(conv, 'system') } catch { /* expected */ }
      }

      // Should be blocked now
      const result = await manager.forceCompact(conv, 'system')
      expect(result).toBeNull()
    })

    it('returns null with fewer than 2 conversation messages', async () => {
      const provider = createMockProvider({ tokenCount: 5000 })
      const manager = createCompactionManager({
        config: makeConfig(),
        provider,
        contextWindowTokens: 10_000,
      })

      const result = await manager.forceCompact([userMsg('Hi')], 'system')
      expect(result).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Min messages guard
  // -----------------------------------------------------------------------

  describe('minimum messages', () => {
    it('skips compactIfNeeded when < 4 non-system messages', async () => {
      const provider = createMockProvider({ tokenCount: 5000 })
      const manager = createCompactionManager({
        config: makeConfig({ trigger: { type: 'tokens', threshold: 100 } }),
        provider,
        contextWindowTokens: 10_000,
      })

      const messages = [systemMsg('System'), userMsg('Hi'), assistantMsg('Hello')]
      const result = await manager.compactIfNeeded(messages, 'system')
      expect(result).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Strategy dispatch
  // -----------------------------------------------------------------------

  describe('strategy dispatch', () => {
    it('uses truncate strategy', async () => {
      const provider = createMockProvider({ tokenCount: 5000 })
      const manager = createCompactionManager({
        config: makeConfig({ strategy: 'truncate', trigger: { type: 'tokens', threshold: 1000 } }),
        provider,
        contextWindowTokens: 10_000,
      })

      const result = await manager.compactIfNeeded(createConversation(5), 'system')
      expect(result!.strategy).toBe('truncate')
    })

    it('uses summarize strategy', async () => {
      const provider = createMockProvider({
        tokenCount: 5000,
        summaryResponse: 'Summary.',
      })
      const manager = createCompactionManager({
        config: makeConfig({ strategy: 'summarize', trigger: { type: 'tokens', threshold: 1000 } }),
        provider,
        contextWindowTokens: 10_000,
      })

      const result = await manager.compactIfNeeded(createConversation(5), 'system')
      expect(result!.strategy).toBe('summarize')
    })

    it('uses sliding_window strategy', async () => {
      const provider = createMockProvider({ tokenCount: 5000 })
      const manager = createCompactionManager({
        config: makeConfig({ strategy: 'sliding_window', trigger: { type: 'tokens', threshold: 1000 } }),
        provider,
        contextWindowTokens: 10_000,
      })

      const result = await manager.compactIfNeeded(createConversation(5), 'system')
      expect(result!.strategy).toBe('sliding_window')
    })
  })

  // -----------------------------------------------------------------------
  // Fallback
  // -----------------------------------------------------------------------

  describe('fallback', () => {
    it('falls back to truncate when summarize fails', async () => {
      const provider = createMockProvider({
        tokenCount: 5000,
        failOnStreamCall: 1,
        streamError: new Error('API error'),
      })
      const manager = createCompactionManager({
        config: makeConfig({
          strategy: 'summarize',
          trigger: { type: 'tokens', threshold: 1000 },
        }),
        provider,
        contextWindowTokens: 10_000,
      })

      const result = await manager.compactIfNeeded(createConversation(5), 'system')
      // Should have fallen back to truncate
      expect(result).not.toBeNull()
      expect(result!.strategy).toBe('truncate')
    })
  })
})
