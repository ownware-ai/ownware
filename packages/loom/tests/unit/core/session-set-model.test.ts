/**
 * Unit Tests — Session.setModel swaps the provider mid-session WITHOUT
 * losing conversation history. Backs the gateway fix for "changing the
 * model on a thread that already has a cached session keeps using the
 * old model."
 */

import { describe, it, expect } from 'vitest'
import { Session } from '../../../src/core/session.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import type {
  ProviderAdapter,
  ProviderChunk,
  ProviderFeature,
  ProviderRequest,
  ToolDefinition,
} from '../../../src/provider/types.js'

/** A minimal text-completing provider that counts how many turns it ran. */
function makeTextProvider(): { provider: ProviderAdapter; calls: () => number } {
  let n = 0
  const provider = {
    name: 'mock',
    async *stream(_req: ProviderRequest): AsyncGenerator<ProviderChunk> {
      n++
      yield {
        type: 'message_complete',
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      } as ProviderChunk
    },
    async countTokens() { return 1 },
    supportsFeature(_f: ProviderFeature) { return true },
    formatTools(tools: ToolDefinition[]) { return tools },
    getModelPricing() { return null },
  } as unknown as ProviderAdapter
  return { provider, calls: () => n }
}

async function drain(session: Session, prompt: string): Promise<void> {
  const gen = session.submitMessage(prompt)
  let next = await gen.next()
  while (!next.done) next = await gen.next()
}

describe('Session.setModel', () => {
  it('preserves history and runs the next turn on the new provider', async () => {
    const a = makeTextProvider()
    const b = makeTextProvider()
    const session = new Session({
      config: { ...createDefaultConfig('mock:a'), maxTurns: 1, maxTokens: 100 },
      provider: a.provider,
      tools: [],
    })

    await drain(session, 'first')
    const afterFirst = session.getMessages().length
    expect(a.calls()).toBe(1)
    expect(afterFirst).toBeGreaterThan(0)

    session.setModel('mock:b', b.provider)

    // History is intact — no message dropped by the swap.
    expect(session.getMessages().length).toBe(afterFirst)

    await drain(session, 'second')
    // The new provider ran; the old one was NOT used again.
    expect(b.calls()).toBe(1)
    expect(a.calls()).toBe(1)
    // The conversation grew on top of the preserved history.
    expect(session.getMessages().length).toBeGreaterThan(afterFirst)
  })

  it('is a no-op when the model and provider are unchanged', () => {
    const a = makeTextProvider()
    const session = new Session({
      config: { ...createDefaultConfig('mock:a'), maxTurns: 1 },
      provider: a.provider,
      tools: [],
    })
    expect(() => session.setModel('mock:a', a.provider)).not.toThrow()
  })
})
