import { createHash, randomUUID } from 'node:crypto'
import type { StopReason, TurnUsage } from '@ownware/loom'
import type { ProviderUsageSinkInput } from '../gateway/session-runner.js'
import type { UsageEvidenceRepository } from '../storage/usage-evidence-repository.js'
import type {
  BillingKind,
  PricebookEntry,
  UsageLedgerEntry,
} from './schema.js'
import type { ProviderHubService, ProviderHubUsageModel } from './service.js'
import { calculateUsageCostUsd, selectUsagePrice } from './usage-pricing.js'

/** Turns one authoritative runtime/provider completion into immutable evidence. */
export class ProviderUsageRecorder {
  constructor(
    private readonly hub: Pick<ProviderHubService, 'resolveUsageModel'>,
    private readonly repository: UsageEvidenceRepository,
  ) {}

  async record(input: ProviderUsageSinkInput): Promise<UsageLedgerEntry> {
    if (input.usage.usageAuthority === undefined) {
      throw new TypeError('Provider usage authority is required.')
    }
    const resolved = input.usage.providerFacts?.servedModelId === undefined
      ? null
      : await this.hub.resolveUsageModel(input.usage.providerFacts.servedModelId)
    const effectiveResolution = resolved ?? await this.hub.resolveUsageModel(input.usage.model)
      ?? await this.hub.resolveUsageModel(input.requestedModel)
    const billingKind = resolveBillingKind(effectiveResolution, input.usage)
    const tokens = normalizedTokens(input.usage)
    const units = { requests: 1 }
    const priced = resolveCost(
      effectiveResolution,
      billingKind,
      input.usage,
      input.occurredAt,
      tokens,
      units,
      input.usage.providerFacts?.servedTier,
    )
    const identity = effectiveResolution === null
      ? unknownIdentity(input.usage.model || input.requestedModel)
      : {
          providerFamilyId: effectiveResolution.family.id,
          providerRouteId: effectiveResolution.route.id,
          modelRouteId: effectiveResolution.model.id,
          wireModelId: effectiveResolution.model.wireModelId,
          ...(effectiveResolution.connections.length === 1
            ? { connectionId: effectiveResolution.connections[0]!.id }
            : {}),
          ...(effectiveResolution.route.region === undefined
            ? {}
            : { region: effectiveResolution.route.region }),
        }
    const entry: UsageLedgerEntry = {
      id: `usage:${randomUUID()}`,
      occurredAt: input.occurredAt,
      threadId: input.threadId,
      profileId: input.profileId,
      ...identity,
      billingKind,
      tokens,
      units,
      cost: priced.cost,
      providerFacts: {
        ...input.usage.providerFacts,
        finishReason: input.stopReason,
        usagePayloadHash: usagePayloadHash(input.usage),
      },
      success: successFromStopReason(input.stopReason),
      ...(priced.contextTier === undefined ? {} : { contextTier: priced.contextTier }),
      ...(input.usage.providerFacts?.servedTier === undefined
        ? {}
        : { serviceTier: input.usage.providerFacts.servedTier }),
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    }
    return this.repository.record(entry, priced.pricebook)
  }
}

function normalizedTokens(usage: TurnUsage): UsageLedgerEntry['tokens'] {
  const reasoningTokens = usage.reasoningTokens ?? 0
  return {
    inputTextTokens: usage.inputTokens,
    outputTextTokens: Math.max(0, usage.outputTokens - reasoningTokens),
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheCreationTokens,
    ...(reasoningTokens === 0 ? {} : { reasoningTokens }),
  }
}

function resolveBillingKind(
  resolved: ProviderHubUsageModel | null,
  usage: TurnUsage,
): BillingKind {
  if (usage.costBasis === 'subscription_allowance') return 'subscription'
  if (usage.costBasis === 'unknown') return 'unknown'
  if (usage.costClassification === 'provider_reported') return 'provider_reported'
  return resolved?.model.billingKind ?? 'unknown'
}

function resolveCost(
  resolved: ProviderHubUsageModel | null,
  billingKind: BillingKind,
  usage: TurnUsage,
  occurredAt: string,
  tokens: UsageLedgerEntry['tokens'],
  units: UsageLedgerEntry['units'],
  servedTier?: string,
): {
  readonly cost: UsageLedgerEntry['cost']
  readonly pricebook?: PricebookEntry
  readonly contextTier?: string
} {
  if (billingKind === 'subscription' || billingKind === 'local' || billingKind === 'unknown') {
    return {
      cost: {
        classification: billingKind,
        amountUsd: null,
        currency: 'USD',
        observedAt: occurredAt,
      },
    }
  }
  if (usage.costClassification === 'provider_reported') {
    return {
      cost: {
        classification: 'provider_reported',
        amountUsd: usage.costUsd,
        currency: 'USD',
        observedAt: occurredAt,
      },
    }
  }
  if (resolved !== null) {
    const selected = selectUsagePrice(resolved.prices, {
      occurredAt,
      inputTokens: totalInputTokens(tokens),
      ...(resolved.route.region === undefined ? {} : { region: resolved.route.region }),
      ...(servedTier === undefined ? {} : { serviceTier: servedTier }),
    })
    if (selected !== null) {
      return {
        cost: {
          classification: 'estimated',
          amountUsd: calculateUsageCostUsd(selected.pricebook, tokens, units),
          currency: 'USD',
          pricebookEntryId: selected.pricebook.id,
          pricebookVersion: selected.pricebook.version,
          observedAt: occurredAt,
        },
        pricebook: selected.pricebook,
        ...(selected.contextTier === undefined ? {} : { contextTier: selected.contextTier }),
      }
    }
  }
  // Loom's local fallback price is a signal, not Hub-owned evidence. Without
  // an exact effective Hub price, the amount remains unknown rather than
  // being promoted into a durable estimate.
  return {
    cost: {
      classification: 'unknown',
      amountUsd: null,
      currency: 'USD',
      observedAt: occurredAt,
    },
  }
}

function totalInputTokens(tokens: UsageLedgerEntry['tokens']): number {
  return (tokens.inputTextTokens ?? 0) +
    (tokens.cacheReadTokens ?? 0) +
    (tokens.cacheWriteTokens ?? 0) +
    (tokens.inputAudioTokens ?? 0)
}

function unknownIdentity(model: string): Pick<
  UsageLedgerEntry,
  'providerFamilyId' | 'providerRouteId' | 'modelRouteId' | 'wireModelId'
> {
  const digest = createHash('sha256').update(model).digest('hex')
  return {
    providerFamilyId: 'unknown',
    providerRouteId: `unknown:route:${digest}`,
    modelRouteId: `unknown:model:${digest}`,
    wireModelId: 'unknown',
  }
}

function usagePayloadHash(usage: TurnUsage): string {
  return `sha256:${createHash('sha256').update(canonicalJson(usage)).digest('hex')}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Usage contains a non-finite number.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(',')}}`
  }
  throw new TypeError('Usage contains an unsupported value.')
}

function successFromStopReason(stopReason: StopReason): boolean {
  return stopReason !== 'error' && stopReason !== 'aborted'
}
