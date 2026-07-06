/**
 * End-to-end: `Session.querySide` against a real Anthropic Haiku.
 *
 * Proves the side-call surface works on the wire:
 *   - The provider returns text we can read.
 *   - Usage is reported and rolled into session totals.
 *   - The main session's message history is untouched.
 *
 * Skips without `ANTHROPIC_API_KEY`. Uses `claude-haiku-4-5` because
 * that is the canonical small/fast tier this primitive was designed
 * to call — running it on Sonnet would prove the same wiring but
 * defeat the purpose.
 */

import { describe, it, expect, beforeAll } from 'vitest'
// Deep imports so we don't drag every provider's eager construction.
import { Session } from '../../core/session.js'
import { createDefaultConfig, mergeConfig } from '../../core/config.js'
import { AnthropicProvider } from '../../provider/anthropic.js'
import { registerProvider, getProvider } from '../../provider/registry.js'

beforeAll(() => {
  // querySide resolves the provider via the registry. Deep imports
  // skip the registry self-registration that happens on `index.js`
  // load, so we register Anthropic explicitly before any call.
  if (!getProvider('anthropic')) {
    registerProvider(new AnthropicProvider())
  }
})

const apiKey =
  process.env['ANTHROPIC_API_KEY'] &&
  !process.env['ANTHROPIC_API_KEY'].includes('OWNWARE_TEST_DUMMY')
    ? process.env['ANTHROPIC_API_KEY']
    : undefined

function skipIfNoKey(): boolean {
  if (!apiKey) {
    console.log('⏭ Skipping querySide e2e: ANTHROPIC_API_KEY not set')
    return true
  }
  return false
}

describe('e2e: Session.querySide on real Haiku', () => {
  it('returns a short text answer and accounts cost', async () => {
    if (skipIfNoKey()) return

    // Main session uses Sonnet to mimic the real pairing. The
    // side-call uses Haiku.
    const config = mergeConfig(
      createDefaultConfig('anthropic:claude-sonnet-4-5'),
      {},
    )
    const session = new Session({
      config,
      provider: new AnthropicProvider(),
      tools: [],
    })

    const messagesBefore = session.getMessages().length
    const usageBefore = session.getState().totalUsage

    const result = await session.querySide({
      model: 'anthropic:claude-haiku-4-5',
      systemPrompt:
        'You generate short thread titles. Reply with ONLY the title — 3 to 7 words, no quotes, no trailing punctuation.',
      prompt: 'User wants help fixing a bug in baz.ts at line 42 that causes a null reference.',
      maxTokens: 32,
    })

    expect(result.text.trim().length).toBeGreaterThan(0)
    // Sanity check: short titles only — guards against the model
    // ignoring the system prompt and writing a paragraph.
    expect(result.text.trim().length).toBeLessThan(120)

    // Usage was reported.
    expect(result.usage.inputTokens).toBeGreaterThan(0)
    expect(result.usage.outputTokens).toBeGreaterThan(0)
    expect(result.usage.costUsd).toBeGreaterThan(0)

    // Side call did NOT pollute the main session's history.
    expect(session.getMessages().length).toBe(messagesBefore)

    // But it DID roll into total usage.
    const usageAfter = session.getState().totalUsage
    expect(usageAfter.inputTokens).toBe(usageBefore.inputTokens + result.usage.inputTokens)
    expect(usageAfter.outputTokens).toBe(usageBefore.outputTokens + result.usage.outputTokens)
    expect(usageAfter.costUsd).toBeCloseTo(usageBefore.costUsd + result.usage.costUsd, 8)

    /* eslint-disable no-console */
    console.log('\n──── QUERYSIDE E2E REPORT ────')
    console.log(`title produced: "${result.text.trim()}"`)
    console.log(`input=${result.usage.inputTokens} output=${result.usage.outputTokens} cost=$${result.usage.costUsd.toFixed(6)}`)
    console.log('───────────────────────────────\n')
    /* eslint-enable no-console */
  }, 60_000)
})
