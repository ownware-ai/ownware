/**
 * Provider Fallback Chain — E2E Test
 *
 * Tests the FallbackProviderAdapter with real API calls.
 * Verifies that:
 * 1. Primary provider works normally when available
 * 2. Fallback kicks in when primary fails
 * 3. Non-retryable errors (401) are not retried
 * 4. Attempt tracking works correctly
 */

import { describe, it, expect } from 'vitest'
import {
  resolveProvider,
  createFallbackProvider,
} from '../../../src/index.js'
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderChunk,
  ProviderFeature,
  ToolDefinition,
} from '../../../src/provider/types.js'
import type { Message } from '../../../src/messages/types.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

// ---------------------------------------------------------------------------
// Mock failing provider (simulates rate limiting)
// ---------------------------------------------------------------------------

class FailingProvider implements ProviderAdapter {
  readonly name = 'failing'
  private errorMessage: string

  constructor(errorMessage = '429 rate_limit_exceeded') {
    this.errorMessage = errorMessage
  }

  async *stream(_request: ProviderRequest): AsyncGenerator<ProviderChunk> {
    throw new Error(this.errorMessage)
  }

  async countTokens(_messages: Message[], _system?: string): Promise<number> {
    return 100
  }

  supportsFeature(_feature: ProviderFeature): boolean {
    return false
  }

  formatTools(tools: ToolDefinition[]): unknown[] {
    return tools
  }
}

// ---------------------------------------------------------------------------
// Unit tests (no API key needed)
// ---------------------------------------------------------------------------

describe('FallbackProvider (unit)', () => {
  it('attempts fallback when primary fails with retryable error', async () => {
    const failing = new FailingProvider('429 rate_limit_exceeded')
    const fallback = createFallbackProvider(failing, ['anthropic:claude-haiku-4-5-20251001'], {
      maxAttempts: 2,
    })

    // Without a real API key, the fallback will also fail — but we can verify attempts were tracked
    try {
      const gen = fallback.stream({
        model: 'fake-model',
        system: 'test',
        messages: [{ role: 'user', content: 'test' }],
        tools: [],
        maxTokens: 100,
        temperature: 0,
      })
      for await (const _ of gen) { /* drain */ }
    } catch {
      // Expected to fail since we have no real API key
    }

    const attempts = fallback.attempts
    expect(attempts.length).toBeGreaterThanOrEqual(1)
    expect(attempts[0]!.provider).toBe('failing')
    expect(attempts[0]!.error).toContain('rate_limit')
  })

  it('does NOT fallback on auth errors (401)', async () => {
    const failing = new FailingProvider('401 authentication error invalid_api_key')

    const fallback = createFallbackProvider(failing, ['anthropic:claude-haiku-4-5-20251001'], {
      maxAttempts: 3,
    })

    try {
      const gen = fallback.stream({
        model: 'fake-model',
        system: 'test',
        messages: [{ role: 'user', content: 'test' }],
        tools: [],
        maxTokens: 100,
        temperature: 0,
      })
      for await (const _ of gen) { /* drain */ }
      throw new Error('Should have thrown')
    } catch (e) {
      const err = e as Error
      // Should throw immediately without fallback attempts
      expect(err.message).toContain('authentication')
      // Only 1 attempt (the primary), no fallback
      expect(fallback.attempts).toHaveLength(0) // Auth errors don't get recorded as "attempts" — they throw immediately
    }
  })

  it('respects maxAttempts limit', async () => {
    const failing = new FailingProvider('500 server error')

    const fallback = createFallbackProvider(failing, [
      'anthropic:model-1',
      'anthropic:model-2',
      'anthropic:model-3',
    ], {
      maxAttempts: 2,
    })

    try {
      const gen = fallback.stream({
        model: 'fake-model',
        system: 'test',
        messages: [{ role: 'user', content: 'test' }],
        tools: [],
        maxTokens: 100,
        temperature: 0,
      })
      for await (const _ of gen) { /* drain */ }
    } catch {
      // Expected
    }

    // Should have at most maxAttempts records
    expect(fallback.attempts.length).toBeLessThanOrEqual(2)
  })

  it('tracks attempt timestamps', async () => {
    const failing = new FailingProvider('500 internal server error')

    const fallback = createFallbackProvider(failing, ['anthropic:haiku'], {
      maxAttempts: 2,
    })

    const before = Date.now()

    try {
      const gen = fallback.stream({
        model: 'fake-model',
        system: 'test',
        messages: [{ role: 'user', content: 'test' }],
        tools: [],
        maxTokens: 100,
        temperature: 0,
      })
      for await (const _ of gen) { /* drain */ }
    } catch {
      // Expected
    }

    for (const attempt of fallback.attempts) {
      expect(attempt.timestamp).toBeGreaterThanOrEqual(before)
      expect(attempt.timestamp).toBeLessThanOrEqual(Date.now())
    }
  })
})

// ---------------------------------------------------------------------------
// E2E tests (real API)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_KEY)('FallbackProvider (E2E)', () => {
  it('primary succeeds without fallback', async () => {
    const { provider } = resolveProvider('anthropic:claude-haiku-4-5-20251001')
    const fallback = createFallbackProvider(provider, ['anthropic:claude-haiku-4-5-20251001'])

    let text = ''
    const gen = fallback.stream({
      model: 'claude-haiku-4-5-20251001',
      system: 'You are a test assistant. Reply with exactly one word.',
      messages: [{ role: 'user', content: 'Say "hello".' }],
      tools: [],
      maxTokens: 50,
      temperature: 0,
    })

    for await (const chunk of gen) {
      if (chunk.type === 'text_delta') text += chunk.text
    }

    expect(text.toLowerCase()).toContain('hello')
    expect(fallback.attempts).toHaveLength(0) // No failures → no attempts logged
  }, 30_000)

  it('falls back to secondary when primary fails with retryable error', async () => {
    // Use a mock provider that fails with a retryable error, then fall back to real Haiku
    const failing = new FailingProvider('529 overloaded')
    const fallback = createFallbackProvider(failing, ['anthropic:claude-haiku-4-5-20251001'], {
      maxAttempts: 2,
    })

    let text = ''
    const gen = fallback.stream({
      model: 'fake-overloaded-model',
      system: 'Reply with one word.',
      messages: [{ role: 'user', content: 'Say "working".' }],
      tools: [],
      maxTokens: 50,
      temperature: 0,
    })

    for await (const chunk of gen) {
      if (chunk.type === 'text_delta') text += chunk.text
    }

    // The fallback should have succeeded via real Haiku
    expect(text.toLowerCase()).toContain('working')
    expect(fallback.attempts.length).toBeGreaterThanOrEqual(1)
    expect(fallback.attempts[0]!.error).toContain('overloaded')
  }, 30_000)
})
