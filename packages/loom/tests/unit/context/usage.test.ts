/**
 * Unit Tests — measureContextUsage (Phase 9)
 */

import { describe, it, expect } from 'vitest'

import { measureContextUsage } from '../../../src/context/usage.js'
import { defineTool } from '../../../src/tools/types.js'

import type { Tool } from '../../../src/tools/types.js'
import type { Message } from '../../../src/messages/types.js'

const MODEL = 'anthropic:claude-sonnet-4'  // 200k context window

function noopTool(name = 'sample'): Tool {
  return defineTool({
    name,
    description: `${name} tool description`,
    isReadOnly: true,
    requiresPermission: false,
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'string', description: 'an input' } },
      required: ['x'],
    },
    async execute() {
      return { content: 'ok', isError: false }
    },
  })
}

describe('measureContextUsage — empty inputs', () => {
  it('returns zero used and full contextWindow free for an empty session', async () => {
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: '',
      messages: [],
      tools: [],
    })

    expect(out.contextWindow).toBe(200_000)
    expect(out.used).toBe(0)
    expect(out.free).toBe(200_000)
    expect(out.utilization).toBe(0)
    expect(out.breakdown).toEqual({
      systemPrompt: 0,
      tools: 0,
      memory: 0,
      skills: 0,
      messages: 0,
    })
    expect(out.method).toBe('estimate')
  })
})

describe('measureContextUsage — categories sum to used', () => {
  it('summing the breakdown equals `used`', async () => {
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: 'you are a helpful assistant',
      messages: [{ role: 'user', content: 'hello world' }],
      tools: [noopTool('a'), noopTool('b')],
    })

    const sum = out.breakdown.systemPrompt
      + out.breakdown.tools
      + out.breakdown.memory
      + out.breakdown.skills
      + out.breakdown.messages
    expect(sum).toBe(out.used)
  })
})

describe('measureContextUsage — system prompt', () => {
  it('counts an empty prompt as zero', async () => {
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: '',
      messages: [],
      tools: [],
    })
    expect(out.breakdown.systemPrompt).toBe(0)
  })

  it('counts a non-empty prompt above the empty case', async () => {
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: 'You are an extremely helpful general-purpose assistant who answers concisely.',
      messages: [],
      tools: [],
    })
    expect(out.breakdown.systemPrompt).toBeGreaterThan(10)
  })

  it('accepts the block-array form of SystemPrompt', async () => {
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: [
        { text: 'block one with content', cacheControl: true },
        { text: 'block two with more content here', cacheControl: false },
      ],
      messages: [],
      tools: [],
    })
    expect(out.breakdown.systemPrompt).toBeGreaterThan(0)
  })
})

describe('measureContextUsage — tools', () => {
  it('counts tools roughly in proportion to their description size', async () => {
    const small = await measureContextUsage({
      model: MODEL,
      systemPrompt: '',
      messages: [],
      tools: [noopTool('s')],
    })
    const big = await measureContextUsage({
      model: MODEL,
      systemPrompt: '',
      messages: [],
      tools: [noopTool('s'), noopTool('m'), noopTool('l')],
    })
    expect(big.breakdown.tools).toBeGreaterThan(small.breakdown.tools)
  })

  it('accepts the empty-tools case', async () => {
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: '',
      messages: [],
      tools: [],
    })
    expect(out.breakdown.tools).toBe(0)
  })
})

describe('measureContextUsage — messages', () => {
  it('counts user messages', async () => {
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: '',
      messages: [{ role: 'user', content: 'a fairly substantial user message of some length' }],
      tools: [],
    })
    expect(out.breakdown.messages).toBeGreaterThan(5)
  })

  it('counts assistant content and tool results', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'do thing' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'planning the approach' },
          { type: 'tool_use', id: 't1', name: 'shell', input: { cmd: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 't1', content: 'foo bar baz', isError: false }],
      },
    ]
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: '',
      messages,
      tools: [],
    })
    expect(out.breakdown.messages).toBeGreaterThan(10)
    expect(out.breakdown.skills).toBe(0)  // no `skill` tool_use here
  })
})

describe('measureContextUsage — skills bucket', () => {
  it('moves tokens from `messages` to `skills` when a tool_result was paired with a skill tool_use', async () => {
    const skillBody = 'this is a skill body that is roughly long enough to count'
    const messages: Message[] = [
      { role: 'user', content: 'simplify' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'sk1', name: 'skill', input: { name: 'simplify' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'sk1', content: skillBody, isError: false }],
      },
    ]
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: '',
      messages,
      tools: [],
    })
    expect(out.breakdown.skills).toBeGreaterThan(0)
    // The skill body should NOT also be counted under messages — categories don't double-count.
    const baseline = await measureContextUsage({
      model: MODEL,
      systemPrompt: '',
      messages: messages.slice(0, 2),  // remove the tool_result
      tools: [],
    })
    expect(out.breakdown.messages).toBeLessThanOrEqual(baseline.breakdown.messages + 5)
  })

  it('does NOT double-count when multiple skill tool_uses + results coexist', async () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'sk1', name: 'skill', input: { name: 'a' } },
          { type: 'tool_use', id: 'sk2', name: 'skill', input: { name: 'b' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'sk1', content: 'one', isError: false },
          { type: 'tool_result', toolUseId: 'sk2', content: 'two', isError: false },
        ],
      },
    ]
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: '',
      messages,
      tools: [],
    })
    expect(out.breakdown.skills).toBeGreaterThan(0)
    // The whole-message estimate minus skills should still be sane (no negative, no NaN).
    expect(out.breakdown.messages).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(out.breakdown.messages)).toBe(true)
  })

  it('treats a non-skill tool_result as `messages`, not `skills`', async () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'sh1', name: 'shell', input: { cmd: 'ls' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'sh1', content: 'long shell output here', isError: false }],
      },
    ]
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: '',
      messages,
      tools: [],
    })
    expect(out.breakdown.skills).toBe(0)
    expect(out.breakdown.messages).toBeGreaterThan(0)
  })
})

describe('measureContextUsage — context window resolution', () => {
  it('looks up the window for known models', async () => {
    const opus = await measureContextUsage({ model: 'anthropic:claude-opus', systemPrompt: '', messages: [], tools: [] })
    expect(opus.contextWindow).toBe(200_000)

    // models.dev's authoritative value for Gemini 2.5 Flash is 1048576
    // (the precise 1024×1024 used by Google internally), not the
    // rounded 1_000_000 the hardcoded fallback table carried. Catalog-
    // driven lookup is now the primary path (loom/messages/tokens.ts),
    // so we assert the precise value.
    const flash = await measureContextUsage({ model: 'google:gemini-2.5-flash', systemPrompt: '', messages: [], tools: [] })
    expect(flash.contextWindow).toBe(1_048_576)
  })

  it('falls back to the default window for unknown models', async () => {
    const out = await measureContextUsage({
      model: 'mock:never-heard-of-this',
      systemPrompt: '',
      messages: [],
      tools: [],
    })
    expect(out.contextWindow).toBeGreaterThan(0)
    expect(out.utilization).toBe(0)
  })
})

describe('measureContextUsage — invariants', () => {
  it('utilization stays in [0, 1] even when used somehow exceeds window (clamps)', async () => {
    // Hard-clamped via Math.min(1, used/contextWindow). We can't easily
    // synthesise an over-budget case here without a 200k+ message body,
    // but we can at least confirm it's bounded above.
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: 'a'.repeat(1000),
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })
    expect(out.utilization).toBeGreaterThanOrEqual(0)
    expect(out.utilization).toBeLessThanOrEqual(1)
  })

  it('free is non-negative', async () => {
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: '',
      messages: [],
      tools: [],
    })
    expect(out.free).toBeGreaterThanOrEqual(0)
  })

  it('reports method=estimate for the default path', async () => {
    const out = await measureContextUsage({
      model: MODEL,
      systemPrompt: 'x',
      messages: [],
      tools: [],
    })
    expect(out.method).toBe('estimate')
  })
})
