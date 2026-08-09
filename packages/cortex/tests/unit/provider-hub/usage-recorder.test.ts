import { describe, expect, it, vi } from 'vitest'
import type { ProviderUsageSinkInput } from '../../../src/gateway/session-runner.js'
import {
  ProviderUsageRecorder,
  type PricebookEntry,
  type ProviderHubUsageModel,
} from '../../../src/provider-hub/index.js'
import type { UsageEvidenceRepository } from '../../../src/storage/usage-evidence-repository.js'

const NOW = '2026-08-09T06:00:00.000Z'

function catalogPrice(): PricebookEntry {
  return {
    id: 'price:catalog:sonnet',
    version: 'catalog-v1',
    currency: 'USD',
    scope: {
      providerRouteId: 'anthropic:api',
      modelRouteId: 'anthropic:claude-sonnet',
    },
    rates: [
      { dimension: 'input_text_tokens', unitSize: 1_000_000, amountUsd: 3 },
      { dimension: 'output_text_tokens', unitSize: 1_000_000, amountUsd: 15 },
      { dimension: 'cache_read_tokens', unitSize: 1_000_000, amountUsd: 0.3 },
    ],
    effectiveFrom: null,
    effectiveUntil: null,
    source: {
      kind: 'models_dev',
      sourceRef: 'https://models.dev/api.json',
      retrievedAt: NOW,
    },
  }
}

function resolved(
  billingKind: ProviderHubUsageModel['model']['billingKind'] = 'metered',
  prices: readonly PricebookEntry[] = [catalogPrice()],
): ProviderHubUsageModel {
  return {
    family: { id: 'anthropic', name: 'Anthropic', lifecycle: 'active' },
    route: {
      id: 'anthropic:api',
      familyId: 'anthropic',
      name: 'Anthropic API',
      kind: 'direct',
      transport: { runtimeId: 'loom', adapterId: 'anthropic', protocol: 'anthropic-messages' },
      connectable: true,
      lifecycle: 'active',
    },
    model: {
      id: 'anthropic:claude-sonnet',
      providerRouteId: 'anthropic:api',
      wireModelId: 'claude-sonnet',
      name: 'Claude Sonnet',
      aliases: [],
      contextWindow: null,
      maxInputTokens: null,
      maxOutputTokens: null,
      capabilities: [],
      variants: [],
      availability: {
        catalogued: true,
        connectable: true,
        credentialed: true,
        verified: false,
        recommended: true,
        lifecycle: 'active',
        connectionIds: [],
      },
      billingKind,
      catalogSourceRef: 'models-dev:test',
    },
    connections: [],
    prices,
  }
}

function input(overrides: Partial<ProviderUsageSinkInput> = {}): ProviderUsageSinkInput {
  return {
    threadId: 'thread:test',
    profileId: 'ownware-code',
    requestedModel: 'anthropic:claude-sonnet',
    stopReason: 'end_turn',
    occurredAt: NOW,
    durationMs: 850,
    usage: {
      inputTokens: 1_000,
      outputTokens: 250,
      cacheReadTokens: 2_000,
      cacheCreationTokens: 0,
      reasoningTokens: 50,
      model: 'anthropic:claude-sonnet',
      costUsd: 99,
      costBasis: 'metered',
      costClassification: 'estimated',
      usageAuthority: 'provider_response',
    },
    ...overrides,
  }
}

function harness(resolution: ProviderHubUsageModel | null) {
  const record = vi.fn(async entry => entry)
  const repository = { record } as unknown as UsageEvidenceRepository
  const resolveUsageModel = vi.fn(async () => resolution)
  return {
    record,
    resolveUsageModel,
    recorder: new ProviderUsageRecorder({ resolveUsageModel }, repository),
  }
}

describe('ProviderUsageRecorder', () => {
  it('recalculates estimates from exact Hub evidence and separates reasoning', async () => {
    const { recorder, record } = harness(resolved())
    const entry = await recorder.record(input())
    expect(entry.tokens).toEqual({
      inputTextTokens: 1_000,
      outputTextTokens: 200,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 0,
      reasoningTokens: 50,
    })
    expect(entry.cost).toMatchObject({
      classification: 'estimated',
      amountUsd: 0.00735,
      pricebookEntryId: 'price:catalog:sonnet',
      pricebookVersion: 'catalog-v1',
    })
    expect(entry.providerFacts.usagePayloadHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(record).toHaveBeenCalledWith(entry, catalogPrice())
  })

  it('keeps explicit provider cost distinct from local price math', async () => {
    const { recorder } = harness(resolved())
    const entry = await recorder.record(input({
      usage: {
        ...input().usage,
        costUsd: 0.0042,
        costClassification: 'provider_reported',
      },
    }))
    expect(entry.billingKind).toBe('provider_reported')
    expect(entry.cost).toMatchObject({
      classification: 'provider_reported',
      amountUsd: 0.0042,
    })
  })

  it('uses provider-returned serving identity before the requested model', async () => {
    const actual = resolved('local', [])
    const actualModel = {
      ...actual,
      model: {
        ...actual.model,
        id: 'served:model',
        wireModelId: 'served-wire-model',
      },
    }
    const record = vi.fn(async entry => entry)
    const resolveUsageModel = vi.fn(async (modelId: string) => (
      modelId === 'served-alias' ? actualModel : resolved()
    ))
    const recorder = new ProviderUsageRecorder(
      { resolveUsageModel },
      { record } as unknown as UsageEvidenceRepository,
    )

    const entry = await recorder.record(input({
      usage: {
        ...input().usage,
        providerFacts: { servedModelId: 'served-alias' },
      },
    }))

    expect(resolveUsageModel).toHaveBeenCalledTimes(1)
    expect(resolveUsageModel).toHaveBeenCalledWith('served-alias')
    expect(entry).toMatchObject({
      modelRouteId: 'served:model',
      wireModelId: 'served-wire-model',
      cost: { classification: 'local', amountUsd: null },
      providerFacts: { servedModelId: 'served-alias' },
    })
  })

  it.each([
    ['subscription', 'subscription_allowance', 'subscription'],
    ['local', 'metered', 'local'],
    ['unknown', 'unknown', 'unknown'],
  ] as const)('keeps %s usage amountless', async (billingKind, costBasis, classification) => {
    const { recorder } = harness(resolved(billingKind, []))
    const entry = await recorder.record(input({
      usage: { ...input().usage, costBasis },
    }))
    expect(entry.cost).toMatchObject({ classification, amountUsd: null })
  })

  it('does not promote Loom fallback math when Hub has no effective price', async () => {
    const { recorder } = harness(resolved('metered', []))
    const entry = await recorder.record(input({
      usage: { ...input().usage, isFallbackPricing: true },
    }))
    expect(entry.cost).toEqual({
      classification: 'unknown',
      amountUsd: null,
      currency: 'USD',
      observedAt: NOW,
    })
  })

  it('fails closed without explicit provider/runtime authority', async () => {
    const { recorder, record } = harness(resolved())
    await expect(recorder.record(input({
      usage: { ...input().usage, usageAuthority: undefined },
    }))).rejects.toThrow('authority')
    expect(record).not.toHaveBeenCalled()
  })
})
