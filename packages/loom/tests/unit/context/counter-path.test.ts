/**
 * Unit Tests — Token-counter (hybrid) path of measureContextUsage
 *
 * Verifies the production-quality behavior:
 *   - When a counter is supplied AND messages are non-empty, the
 *     hybrid path anchors system+messages+skills to the counter's
 *     reading and scales local estimates proportionally.
 *   - Sum invariant: anchored categories + tools + memory == used.
 *   - method = 'mixed' when the counter is used, 'estimate' otherwise.
 *   - Empty messages: skipped, falls back to local estimate.
 *   - Counter errors / non-finite returns: fall back gracefully.
 */

import { describe, it, expect } from 'vitest'

import {
  measureContextUsage,
  measureContextUsageWithDiagnostics,
} from '../../../src/context/usage.js'
import { defineTool } from '../../../src/tools/types.js'

import type { TokenCounter } from '../../../src/context/types.js'
import type { Message } from '../../../src/messages/types.js'

const MODEL = 'anthropic:claude-sonnet-4'

const SAMPLE_MESSAGES: Message[] = [
  { role: 'user', content: 'a fairly typical user prompt asking about something' },
  { role: 'assistant', content: [{ type: 'text', text: 'a typical assistant reply with detail' }] },
]

const SAMPLE_SYSTEM = 'You are a focused assistant. Reply briefly.'

function fixedCounter(value: number): TokenCounter {
  return { count: async () => value }
}

function recordingCounter(value: number): TokenCounter & { calls: Array<{ messages: Message[]; system?: string }> } {
  const calls: Array<{ messages: Message[]; system?: string }> = []
  return {
    calls,
    async count(messages: Message[], system?: string) {
      calls.push({ messages, ...(system !== undefined ? { system } : {}) })
      return value
    },
  }
}

describe('measureContextUsage — hybrid path (counter supplied)', () => {
  it('reports method=mixed when the counter is used', async () => {
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: SAMPLE_SYSTEM,
      messages: SAMPLE_MESSAGES,
      tools: [],
      counter: fixedCounter(120),
    })
    expect(out.method).toBe('mixed')
  })

  it('anchors the anchored-categories sum to the counter total exactly (sum invariant)', async () => {
    const counterTotal = 200
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: SAMPLE_SYSTEM,
      messages: SAMPLE_MESSAGES,
      tools: [],
      counter: fixedCounter(counterTotal),
    })
    const anchoredSum = out.breakdown.systemPrompt + out.breakdown.skills + out.breakdown.messages
    expect(anchoredSum).toBe(counterTotal)
  })

  it('keeps tools as a local estimate even on the hybrid path', async () => {
    const tool = defineTool({
      name: 'sample',
      description: 'sample tool description with enough text to estimate',
      isReadOnly: true,
      requiresPermission: false,
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'string', description: 'an input' } },
        required: ['x'],
      },
      async execute() { return { content: 'ok', isError: false } },
    })

    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: SAMPLE_SYSTEM,
      messages: SAMPLE_MESSAGES,
      tools: [tool],
      counter: fixedCounter(200),
    })
    expect(out.breakdown.tools).toBeGreaterThan(0)
    // The local tools estimate is independent of the counter's anchored value.
    const out2 = await measureContextUsage({
      model: MODEL,
      systemPrompt: SAMPLE_SYSTEM,
      messages: SAMPLE_MESSAGES,
      tools: [tool],
      counter: fixedCounter(2_000),
    })
    expect(out2.breakdown.tools).toBe(out.breakdown.tools)
  })

  it('breakdown sums to used exactly under the hybrid path', async () => {
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: SAMPLE_SYSTEM,
      messages: SAMPLE_MESSAGES,
      tools: [],
      counter: fixedCounter(417),
    })
    const sum = out.breakdown.systemPrompt
      + out.breakdown.tools
      + out.breakdown.memory
      + out.breakdown.skills
      + out.breakdown.messages
    expect(sum).toBe(out.used)
  })

  it('passes the messages and system text into the counter', async () => {
    const counter = recordingCounter(150)
    await measureContextUsage({
      model: MODEL,
      systemPrompt: SAMPLE_SYSTEM,
      messages: SAMPLE_MESSAGES,
      tools: [],
      counter,
    })
    expect(counter.calls).toHaveLength(1)
    expect(counter.calls[0]!.messages).toHaveLength(SAMPLE_MESSAGES.length)
    expect(counter.calls[0]!.system).toBe(SAMPLE_SYSTEM)
  })
})

describe('measureContextUsage — empty-messages guard', () => {
  it('skips the counter and falls back to estimate when messages is empty', async () => {
    const counter = recordingCounter(0)
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: SAMPLE_SYSTEM,
      messages: [],
      tools: [],
      counter,
    })
    expect(counter.calls).toHaveLength(0)  // counter NOT called
    expect(out.method).toBe('estimate')
    expect(out.breakdown.systemPrompt).toBeGreaterThan(0)  // local estimate kicks in
  })
})

describe('measureContextUsage — failure handling', () => {
  it('falls back to estimate when the counter throws', async () => {
    const flaky: TokenCounter = {
      async count() {
        throw new Error('Network unavailable')
      },
    }
    const { usage, diagnostics } = await measureContextUsageWithDiagnostics({
      model: MODEL,
      systemPrompt: SAMPLE_SYSTEM,
      messages: SAMPLE_MESSAGES,
      tools: [],
      counter: flaky,
    })
    expect(usage.method).toBe('estimate')
    expect(usage.breakdown.systemPrompt).toBeGreaterThan(0)
    expect(diagnostics.counterError).toContain('Network unavailable')
  })

  it('falls back to estimate when the counter returns a non-finite value', async () => {
    const broken = fixedCounter(Number.NaN)
    const { usage, diagnostics } = await measureContextUsageWithDiagnostics({
      model: MODEL,
      systemPrompt: SAMPLE_SYSTEM,
      messages: SAMPLE_MESSAGES,
      tools: [],
      counter: broken,
    })
    expect(usage.method).toBe('estimate')
    expect(diagnostics.counterError).toMatch(/non-finite/)
  })

  it('falls back to estimate when the counter returns a negative value', async () => {
    const broken = fixedCounter(-1)
    const { usage } = await measureContextUsageWithDiagnostics({
      model: MODEL,
      systemPrompt: SAMPLE_SYSTEM,
      messages: SAMPLE_MESSAGES,
      tools: [],
      counter: broken,
    })
    expect(usage.method).toBe('estimate')
  })

  it('emits diagnostics with scale and counter total on the happy path', async () => {
    const { diagnostics, usage } = await measureContextUsageWithDiagnostics({
      model: MODEL,
      systemPrompt: SAMPLE_SYSTEM,
      messages: SAMPLE_MESSAGES,
      tools: [],
      counter: fixedCounter(500),
    })
    expect(usage.method).toBe('mixed')
    expect(diagnostics.counterTotal).toBe(500)
    expect(diagnostics.localTotal).toBeGreaterThan(0)
    expect(diagnostics.scale).toBeGreaterThan(0)
    expect(diagnostics.counterError).toBeUndefined()
  })
})
