/**
 * Tests for config field changes:
 * - streamingToolExecution removed
 * - fallbackModel present with null default
 */

import { describe, it, expect } from 'vitest'
import { createDefaultConfig, mergeConfig } from '../../../src/core/config.js'
import type { LoomConfig } from '../../../src/core/config.js'

describe('LoomConfig after cleanup', () => {
  it('createDefaultConfig does not include streamingToolExecution', () => {
    const config = createDefaultConfig('anthropic:claude-sonnet-4-20250514')
    expect('streamingToolExecution' in config).toBe(false)
  })

  it('createDefaultConfig has fallbackModel: null by default', () => {
    const config = createDefaultConfig('anthropic:claude-sonnet-4-20250514')
    expect(config.fallbackModel).toBeNull()
  })

  it('mergeConfig accepts fallbackModel override', () => {
    const base = createDefaultConfig('anthropic:claude-sonnet-4-20250514')
    const merged = mergeConfig(base, { fallbackModel: 'openai:gpt-4o' })
    expect(merged.fallbackModel).toBe('openai:gpt-4o')
  })

  it('mergeConfig preserves fallbackModel: null when not overridden', () => {
    const base = createDefaultConfig('anthropic:claude-sonnet-4-20250514')
    const merged = mergeConfig(base, { maxTurns: 50 })
    expect(merged.fallbackModel).toBeNull()
  })

  it('mergeConfig correctly merges nested sub-configs', () => {
    const base = createDefaultConfig('anthropic:claude-sonnet-4-20250514')
    const merged = mergeConfig(base, {
      retry: { ...base.retry, maxRetries: 5 },
    })
    expect(merged.retry.maxRetries).toBe(5)
    expect(merged.retry.baseDelayMs).toBe(base.retry.baseDelayMs)
  })

  it('config works without streamingToolExecution field', () => {
    const config = createDefaultConfig('mock:test')
    // Verify the config shape is valid without the removed field
    expect(config.model).toBe('mock:test')
    expect(config.maxTurns).toBe(100)
    expect(config.maxTokens).toBe(16_384)
    expect(config.sessionId).toBeDefined()
    expect(config.agentId).toBeNull()
  })
})
