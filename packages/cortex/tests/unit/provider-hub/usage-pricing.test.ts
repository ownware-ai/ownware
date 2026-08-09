import { describe, expect, it } from 'vitest'
import {
  calculateUsageCostUsd,
  selectUsagePrice,
  type PricebookEntry,
} from '../../../src/provider-hub/index.js'

const OCCURRED_AT = '2026-08-09T08:00:00.000Z'

function price(overrides: Partial<PricebookEntry> = {}): PricebookEntry {
  return {
    id: 'price:base',
    version: 'v1',
    currency: 'USD',
    scope: {
      providerRouteId: 'openai:api',
      modelRouteId: 'openai:gpt-test',
    },
    rates: [
      { dimension: 'input_text_tokens', unitSize: 1_000, amountUsd: 1 },
      { dimension: 'output_text_tokens', unitSize: 1_000, amountUsd: 2 },
    ],
    effectiveFrom: null,
    effectiveUntil: null,
    source: {
      kind: 'official',
      sourceRef: 'https://example.com/pricing',
      retrievedAt: OCCURRED_AT,
    },
    ...overrides,
  }
}

describe('Provider Hub usage pricing', () => {
  it('selects only effective entries whose specialized scope is known to match', () => {
    const base = price()
    const plan = price({
      id: 'price:plan',
      scope: { ...base.scope, plan: 'batch' },
      rates: [{ dimension: 'input_text_tokens', unitSize: 1_000, amountUsd: 0.5 }],
    })
    const audio = price({
      id: 'price:audio',
      scope: { ...base.scope, modality: 'audio' },
      rates: [{ dimension: 'input_audio_tokens', unitSize: 1_000, amountUsd: 3 }],
    })
    const expired = price({
      id: 'price:expired',
      effectiveUntil: '2026-08-09T07:59:59.000Z',
    })

    expect(selectUsagePrice([base, plan, audio, expired], {
      occurredAt: OCCURRED_AT,
      inputTokens: 1_000,
    })?.pricebook.id).toBe('price:base')
    expect(selectUsagePrice([base, plan], {
      occurredAt: OCCURRED_AT,
      inputTokens: 1_000,
      plan: 'batch',
    })?.pricebook.id).toBe('price:plan')
    expect(selectUsagePrice([base, audio], {
      occurredAt: OCCURRED_AT,
      inputTokens: 1_000,
      modality: 'audio',
    })?.pricebook.id).toBe('price:audio')
  })

  it('uses exact context-tier boundaries and reports the selected tier', () => {
    const base = price({ scope: { ...price().scope, maximumInputTokens: 200_001 } })
    const long = price({
      id: 'price:long',
      scope: { ...price().scope, minimumInputTokens: 200_001 },
    })

    expect(selectUsagePrice([base, long], {
      occurredAt: OCCURRED_AT,
      inputTokens: 200_000,
    })).toMatchObject({ pricebook: { id: 'price:base' }, contextTier: '0-200001' })
    expect(selectUsagePrice([base, long], {
      occurredAt: OCCURRED_AT,
      inputTokens: 200_001,
    })).toMatchObject({ pricebook: { id: 'price:long' }, contextTier: '200001-unbounded' })
  })

  it('prices all recorded dimensions and avoids double-counting reasoning output', () => {
    const separateReasoning = price({
      rates: [
        { dimension: 'input_text_tokens', unitSize: 1_000, amountUsd: 1 },
        { dimension: 'output_text_tokens', unitSize: 1_000, amountUsd: 2 },
        { dimension: 'reasoning_tokens', unitSize: 1_000, amountUsd: 4 },
        { dimension: 'cache_read_tokens', unitSize: 1_000, amountUsd: 0.1 },
        { dimension: 'requests', unitSize: 1, amountUsd: 0.25 },
      ],
    })
    const tokens = {
      inputTextTokens: 1_000,
      outputTextTokens: 500,
      reasoningTokens: 250,
      cacheReadTokens: 2_000,
    }

    expect(calculateUsageCostUsd(separateReasoning, tokens, { requests: 1 })).toBeCloseTo(3.45)
    expect(calculateUsageCostUsd(price(), tokens, { requests: 1 })).toBeCloseTo(2.5)
  })
})
