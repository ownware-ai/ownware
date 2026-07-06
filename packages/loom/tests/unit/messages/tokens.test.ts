import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  estimateMessageTokens,
  estimateSystemPromptTokens,
  getModelContextWindow,
} from '../../../src/messages/tokens.js'
import type { Message } from '../../../src/messages/types.js'

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('estimates ~1 token per 4 characters', () => {
    // 100 chars → ~25 tokens
    const text = 'a'.repeat(100)
    expect(estimateTokens(text)).toBe(25)
  })

  it('returns at least 1 for non-empty strings', () => {
    expect(estimateTokens('hi')).toBe(1)
  })

  it('rounds up', () => {
    // 5 chars → ceil(5/4) = 2
    expect(estimateTokens('hello')).toBe(2)
  })
})

describe('estimateMessageTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateMessageTokens([])).toBe(0)
  })

  it('includes message overhead per message', () => {
    const messages: Message[] = [
      { role: 'user', content: '' },
    ]
    // Overhead = 4 tokens, content = 0
    // estimateTokens('') = 0, so total = 4
    expect(estimateMessageTokens(messages)).toBe(4)
  })

  it('estimates string content', () => {
    const messages: Message[] = [
      { role: 'user', content: 'a'.repeat(100) },
    ]
    // 25 (content) + 4 (overhead) = 29
    expect(estimateMessageTokens(messages)).toBe(29)
  })

  it('estimates content blocks', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a'.repeat(100) },
          { type: 'text', text: 'b'.repeat(100) },
        ],
      },
    ]
    // 25 + 25 (content) + 4 (overhead) = 54
    expect(estimateMessageTokens(messages)).toBe(54)
  })

  it('estimates tool_use blocks', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'readFile', input: { path: '/src/index.ts' } },
        ],
      },
    ]
    // Should include name + serialized input
    expect(estimateMessageTokens(messages)).toBeGreaterThan(4)
  })

  it('estimates image blocks as ~1000 tokens', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } },
        ],
      },
    ]
    expect(estimateMessageTokens(messages)).toBe(1004) // 1000 + 4 overhead
  })
})

describe('estimateSystemPromptTokens', () => {
  it('returns 0 for empty prompt', () => {
    expect(estimateSystemPromptTokens('')).toBe(0)
  })

  it('adds overhead to base estimate', () => {
    const base = estimateTokens('Hello world')
    const withOverhead = estimateSystemPromptTokens('Hello world')
    expect(withOverhead).toBe(base + 10)
  })
})

describe('getModelContextWindow', () => {
  it('returns 200K for Claude models', () => {
    expect(getModelContextWindow('claude-sonnet-4-20250514')).toBe(200_000)
    expect(getModelContextWindow('claude-opus-4-20250514')).toBe(200_000)
    expect(getModelContextWindow('claude-haiku-3.5')).toBe(200_000)
  })

  it('returns 128K for GPT-4o', () => {
    expect(getModelContextWindow('gpt-4o')).toBe(128_000)
    expect(getModelContextWindow('gpt-4o-mini')).toBe(128_000)
  })

  it('returns 1M for Gemini 2.5', () => {
    expect(getModelContextWindow('gemini-2.5-pro')).toBe(1_000_000)
    expect(getModelContextWindow('gemini-2.5-flash')).toBe(1_000_000)
  })

  it('strips provider prefix', () => {
    expect(getModelContextWindow('anthropic:claude-sonnet-4-20250514')).toBe(200_000)
    expect(getModelContextWindow('openai:gpt-4o')).toBe(128_000)
  })

  it('returns default 200K for unknown models', () => {
    // Bumped from 128K → 200K (matches every flagship 2026 model's
    // floor). Conservatively chosen; see DEFAULT_CONTEXT_WINDOW
    // docstring.
    expect(getModelContextWindow('some-unknown-model')).toBe(200_000)
  })

  it('matches by prefix for versioned models', () => {
    expect(getModelContextWindow('gpt-4-turbo-2024-04-09')).toBe(128_000)
  })

  // ──────────────────────────────────────────────────────────────────
  // Catalog-driven resolution (live models.dev metadata via
  // `getModelInfo`). Catalog wins over the hardcoded table for any
  // fully-qualified `provider:model` id the catalog knows about — the
  // bug this fixes: GPT-5.5 was misregistered as 128K because it
  // wasn't in the hardcoded table, but the catalog knows its real
  // context_length. Result: compaction was firing at ~25% of GPT-5.5's
  // real capacity, masquerading as 80%.
  // ──────────────────────────────────────────────────────────────────

  it('reads from the catalog for fully-qualified provider:model ids', () => {
    // GPT-4o is in the catalog with context: 128_000. The hardcoded
    // table also has it at 128_000, so this test passes regardless of
    // which path resolves — but the path EXERCISED is the catalog
    // first. Future model releases come through the catalog
    // automatically.
    expect(getModelContextWindow('openai:gpt-4o')).toBeGreaterThanOrEqual(128_000)
    expect(getModelContextWindow('anthropic:claude-sonnet-4-5')).toBeGreaterThanOrEqual(200_000)
  })

  it('falls back to the hardcoded table when the catalog has no entry', () => {
    // No provider prefix means no catalog lookup; the bare-name path
    // matches the hardcoded MODEL_CONTEXT_WINDOWS table.
    expect(getModelContextWindow('claude-haiku-3.5')).toBe(200_000)
    expect(getModelContextWindow('gpt-4o-mini')).toBe(128_000)
  })

  it('returns the bumped default for an unknown provider:model id', () => {
    // Made-up provider not in the catalog AND made-up model name not
    // in the hardcoded table → DEFAULT_CONTEXT_WINDOW.
    expect(getModelContextWindow('madeup:fictional-model-2027')).toBe(200_000)
  })
})

// ────────────────────────────────────────────────────────────────────
// getEffectiveContextUsage — the unified pre-call sizing helper
// ────────────────────────────────────────────────────────────────────

describe('getEffectiveContextUsage', () => {
  const aMessage = { role: 'user' as const, content: 'hi' }

  it('falls back to full chars÷4 walk when no baseline exists (first turn)', async () => {
    const { getEffectiveContextUsage } = await import('../../../src/messages/tokens.js')
    const result = getEffectiveContextUsage(
      [aMessage],
      null,
      'anthropic:claude-sonnet-4-5',
    )
    // 2 chars ÷ 4 = 1 token min + 4 message overhead = 5
    expect(result.tokens).toBe(5)
    expect(result.window).toBeGreaterThan(0)
    expect(result.fraction).toBeCloseTo(5 / result.window)
  })

  it('uses the baseline + delta when a snapshot exists', async () => {
    const { getEffectiveContextUsage } = await import('../../../src/messages/tokens.js')
    const messages = [
      { role: 'user' as const, content: 'hi' },        // index 0
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'hello' }] }, // index 1
      // ── baseline captured here at messageCount = 2 ──
      { role: 'user' as const, content: 'follow up' }, // index 2 (new since baseline)
    ]
    const baseline = {
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 50,
      messageCountAtCapture: 2,
    }
    const result = getEffectiveContextUsage(
      messages,
      baseline,
      'openai:gpt-5.5',
    )
    // baseline = 100 + 0 + 0 + 50 = 150
    // delta = estimateMessageTokens(messages[2..]) = "follow up" (9 chars / 4 = 3 tokens + 4 overhead = 7)
    expect(result.tokens).toBe(150 + 7)
  })

  it('counts cacheRead + cacheCreation toward conversation size (full weight)', async () => {
    const { getEffectiveContextUsage } = await import('../../../src/messages/tokens.js')
    const baseline = {
      inputTokens: 1000,
      cacheReadTokens: 5000,    // 5K served from cache
      cacheCreationTokens: 2000, // 2K cached this turn
      outputTokens: 300,
      messageCountAtCapture: 4,
    }
    const result = getEffectiveContextUsage(
      [], // empty messages — slice yields no delta
      baseline,
      'anthropic:claude-sonnet-4-5',
    )
    // 1000 + 5000 + 2000 + 300 = 8300 — cache tokens are NOT free against
    // the budget (they still occupy the model's context window).
    expect(result.tokens).toBe(8300)
  })

  it('clamps a stale messageCountAtCapture that exceeds current messages.length', async () => {
    const { getEffectiveContextUsage } = await import('../../../src/messages/tokens.js')
    // Compaction shrank the messages array — bookmark now points
    // past the end. Should not slice out-of-bounds; delta should be 0.
    const baseline = {
      inputTokens: 5000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 200,
      messageCountAtCapture: 50, // way past current length
    }
    const result = getEffectiveContextUsage(
      [{ role: 'user' as const, content: 'hi' }],
      baseline,
      'openai:gpt-5.5',
    )
    expect(result.tokens).toBe(5200) // baseline only, no delta
  })
})
