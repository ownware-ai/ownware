/**
 * OpenAI reasoning_effort support — validation + request-shape tests.
 * Network-free; captures params passed to chat.completions.create().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenAIProvider } from '../../../src/provider/openai.js'
import type { ProviderRequest } from '../../../src/provider/types.js'

const cap: { lastParams: Record<string, unknown> | null } = { lastParams: null }

vi.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          cap.lastParams = params
          async function* iterate() {
            yield {
              choices: [{ delta: { content: 'ok' }, finish_reason: null }],
              usage: null,
            }
            yield {
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                prompt_tokens_details: { cached_tokens: 0 },
              },
            }
          }
          const it = iterate()
          return {
            [Symbol.asyncIterator]: () => it,
          }
        },
      },
    }
  }
  return { default: MockOpenAI }
})

function makeRequest(overrides?: Partial<ProviderRequest>): ProviderRequest {
  return {
    model: 'gpt-4o',
    system: 'You are helpful.',
    messages: [{ role: 'user', content: 'Hi' }],
    tools: [],
    maxTokens: 512,
    temperature: null,
    ...overrides,
  }
}

async function drain(gen: AsyncGenerator<unknown>) {
  for await (const _ of gen) { /* drain */ }
}

describe('OpenAIProvider — reasoning_effort', () => {
  let provider: OpenAIProvider

  beforeEach(() => {
    cap.lastParams = null
    provider = new OpenAIProvider({ apiKey: 'test' })
  })

  // ── Validation ───────────────────────────────────────────────────────────

  it('silently ignores thinking.enabled on a non-reasoning model', async () => {
    // Per core/config.ts, providers that can't honor `thinking` must
    // ignore it — not throw. Turns stay alive when a profile-wide
    // thinking setting is paired with a model that can't reason.
    await drain(provider.stream(makeRequest({
      model: 'gpt-4o',
      thinking: { enabled: true, budgetTokens: 2048 },
    })))
    expect(cap.lastParams).not.toBeNull()
    expect(cap.lastParams!.reasoning_effort).toBeUndefined()
  })

  it('does not throw when thinking.enabled on a reasoning model (o4-mini)', async () => {
    await drain(provider.stream(makeRequest({
      model: 'o4-mini',
      thinking: { enabled: true, budgetTokens: 2048 },
    })))
    expect(cap.lastParams).not.toBeNull()
  })

  // ── reasoning_effort wiring ──────────────────────────────────────────────

  it('passes reasoning_effort from explicit effort field', async () => {
    await drain(provider.stream(makeRequest({
      model: 'o4-mini',
      thinking: { enabled: true, budgetTokens: 2048, effort: 'high' },
    })))
    expect(cap.lastParams!.reasoning_effort).toBe('high')
  })

  it('derives low effort from small budget (<= 4096)', async () => {
    await drain(provider.stream(makeRequest({
      model: 'o4-mini',
      thinking: { enabled: true, budgetTokens: 2048 },
    })))
    expect(cap.lastParams!.reasoning_effort).toBe('low')
  })

  it('derives medium effort from mid budget (<= 16384)', async () => {
    await drain(provider.stream(makeRequest({
      model: 'o4-mini',
      thinking: { enabled: true, budgetTokens: 10_000 },
    })))
    expect(cap.lastParams!.reasoning_effort).toBe('medium')
  })

  it('derives high effort from large budget (> 16384)', async () => {
    await drain(provider.stream(makeRequest({
      model: 'o4-mini',
      thinking: { enabled: true, budgetTokens: 32_000 },
    })))
    expect(cap.lastParams!.reasoning_effort).toBe('high')
  })

  it('omits reasoning_effort when thinking is null', async () => {
    await drain(provider.stream(makeRequest({ model: 'o4-mini' })))
    expect(cap.lastParams!.reasoning_effort).toBeUndefined()
  })

  it('omits reasoning_effort when thinking.enabled is false', async () => {
    await drain(provider.stream(makeRequest({
      model: 'o4-mini',
      thinking: { enabled: false, budgetTokens: 2048 },
    })))
    expect(cap.lastParams!.reasoning_effort).toBeUndefined()
  })

  // ── Parameter stripping on reasoning models ──────────────────────────────

  it('omits temperature on reasoning models even when supplied', async () => {
    await drain(provider.stream(makeRequest({
      model: 'o4-mini',
      temperature: 0.5,
    })))
    expect(cap.lastParams!.temperature).toBeUndefined()
  })

  it('honors temperature on non-reasoning models', async () => {
    await drain(provider.stream(makeRequest({
      model: 'gpt-4o',
      temperature: 0.5,
    })))
    expect(cap.lastParams!.temperature).toBe(0.5)
  })

  // ── System → developer role ──────────────────────────────────────────────

  it('uses developer role for reasoning models', async () => {
    await drain(provider.stream(makeRequest({
      model: 'o4-mini',
      system: 'be brief',
    })))
    const messages = cap.lastParams!.messages as Array<{ role: string; content: string }>
    expect(messages[0].role).toBe('developer')
    expect(messages[0].content).toBe('be brief')
  })

  it('uses system role for non-reasoning models', async () => {
    await drain(provider.stream(makeRequest({
      model: 'gpt-4o',
      system: 'be brief',
    })))
    const messages = cap.lastParams!.messages as Array<{ role: string; content: string }>
    expect(messages[0].role).toBe('system')
  })

  // ── max_tokens handling ──────────────────────────────────────────────────

  it('always uses max_completion_tokens (not max_tokens)', async () => {
    await drain(provider.stream(makeRequest({ model: 'o4-mini', maxTokens: 1024 })))
    expect(cap.lastParams!.max_completion_tokens).toBe(1024)
    expect(cap.lastParams!.max_tokens).toBeUndefined()
  })

  // ── gpt-5 family ─────────────────────────────────────────────────────────

  it('accepts thinking on gpt-5-mini (reasoning-capable)', async () => {
    await drain(provider.stream(makeRequest({
      model: 'gpt-5-mini',
      thinking: { enabled: true, budgetTokens: 4096 },
    })))
    expect(cap.lastParams!.reasoning_effort).toBe('low')
  })

  // ── reasoning_effort + tools (chat/completions rejects the combo) ────────

  it('omits reasoning_effort when tools are present on a reasoning model', async () => {
    // OpenAI 400s on gpt-5.x when `tools` + `reasoning_effort` are both
    // sent to /v1/chat/completions. The provider must drop the effort
    // knob so the request still goes through (default reasoning engages).
    await drain(provider.stream(makeRequest({
      model: 'gpt-5-mini',
      thinking: { enabled: true, budgetTokens: 16_000, effort: 'high' },
      tools: [{
        name: 'lookup',
        description: 'Look something up',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
      }],
    })))
    expect(cap.lastParams!.reasoning_effort).toBeUndefined()
    expect(cap.lastParams!.tools).toBeDefined()
  })

  it('still passes reasoning_effort when no tools are present', async () => {
    await drain(provider.stream(makeRequest({
      model: 'gpt-5-mini',
      thinking: { enabled: true, budgetTokens: 16_000, effort: 'high' },
      tools: [],
    })))
    expect(cap.lastParams!.reasoning_effort).toBe('high')
  })
})
