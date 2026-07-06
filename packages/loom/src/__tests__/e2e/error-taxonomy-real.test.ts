/**
 * End-to-end tests for the typed error taxonomy against the REAL APIs.
 *
 * Proves the SDK → translateXxxError() → classifyHttpError() pipeline
 * produces the right subclass for each observable failure mode.
 *
 * Needs ANTHROPIC_API_KEY and/or OPENAI_API_KEY. Individual tests skip
 * cleanly when their key is missing.
 *
 * NOTE: these tests talk to the loop through the provider directly (not
 * via Session) because the loop catches ProviderError and emits it as an
 * `error` event rather than rethrowing — but our assertions are about the
 * class of the thrown error, not the event shape.
 */

import { describe, it, expect } from 'vitest'
import { AnthropicProvider } from '../../provider/anthropic.js'
import { OpenAIProvider } from '../../provider/openai.js'
import {
  AuthenticationError,
  NotFoundError,
  ProviderError,
} from '../../core/errors.js'
import type { ProviderRequest, ProviderChunk } from '../../provider/types.js'

async function drainThrown(gen: AsyncGenerator<ProviderChunk>): Promise<Error> {
  try {
    for await (const _ of gen) { /* drain */ }
  } catch (err) {
    return err as Error
  }
  throw new Error('expected the provider to throw, but it completed cleanly')
}

function req(overrides: Partial<ProviderRequest> & { model: string }): ProviderRequest {
  return {
    model: overrides.model,
    system: 'be brief',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxTokens: 32,
    temperature: null,
    ...overrides,
  }
}

const anthropicKey = process.env.ANTHROPIC_API_KEY
const openaiKey = process.env.OPENAI_API_KEY

describe('e2e: error taxonomy — Anthropic', () => {
  it('bad API key → AuthenticationError (instanceof + not recoverable)', async () => {
    if (!anthropicKey) {
      console.log('⏭ skipping — ANTHROPIC_API_KEY not set')
      return
    }

    const provider = new AnthropicProvider({ apiKey: 'sk-ant-invalid-key-for-testing' })
    const err = await drainThrown(provider.stream(req({ model: 'claude-sonnet-4-6' })))

    expect(err).toBeInstanceOf(AuthenticationError)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).statusCode).toBe(401)
    expect((err as ProviderError).recoverable).toBe(false)
    expect((err as ProviderError).provider).toBe('anthropic')
  }, 60_000)

  it('nonexistent model → NotFoundError (or classified 4xx, unrecoverable)', async () => {
    if (!anthropicKey) return

    const provider = new AnthropicProvider({ apiKey: anthropicKey })
    const err = await drainThrown(
      provider.stream(req({ model: 'claude-does-not-exist-xyz' })),
    )

    // Anthropic returns 404 for unknown model names.
    expect(err).toBeInstanceOf(ProviderError)
    const pe = err as ProviderError
    expect(pe.recoverable).toBe(false)
    // Anthropic returns 404 for unknown models. If the behavior ever
    // shifts to 400 (InvalidRequest), we still want to prove it surfaces
    // as a ProviderError subclass — but document the expectation.
    expect([400, 404]).toContain(pe.statusCode)
    if (pe.statusCode === 404) {
      expect(err).toBeInstanceOf(NotFoundError)
    }
  }, 60_000)
})

describe('e2e: error taxonomy — OpenAI', () => {
  it('bad API key → AuthenticationError (instanceof + not recoverable)', async () => {
    if (!openaiKey) {
      console.log('⏭ skipping — OPENAI_API_KEY not set')
      return
    }

    const provider = new OpenAIProvider({ apiKey: 'sk-invalid-key-for-testing' })
    const err = await drainThrown(provider.stream(req({ model: 'gpt-4o-mini' })))

    expect(err).toBeInstanceOf(AuthenticationError)
    expect((err as ProviderError).statusCode).toBe(401)
    expect((err as ProviderError).recoverable).toBe(false)
    expect((err as ProviderError).provider).toBe('openai')
  }, 60_000)

  it('nonexistent model → classified ProviderError, not recoverable', async () => {
    if (!openaiKey) return

    const provider = new OpenAIProvider({ apiKey: openaiKey })
    const err = await drainThrown(
      provider.stream(req({ model: 'gpt-this-model-does-not-exist-xyz' })),
    )

    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).recoverable).toBe(false)
    // OpenAI sometimes returns 404, sometimes 400 depending on the path
    // (/v1/models validation vs /v1/chat/completions). Accept either.
    expect([400, 404]).toContain((err as ProviderError).statusCode)
  }, 60_000)
})
