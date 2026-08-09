import type {
  PriceDimension,
  PricebookEntry,
  UsageLedgerEntry,
} from './schema.js'

export interface UsagePriceSelection {
  readonly pricebook: PricebookEntry
  readonly contextTier?: string
}

export interface UsagePriceQuery {
  readonly occurredAt: string
  readonly serviceTier?: string
  readonly region?: string
  readonly variantId?: string
  readonly plan?: string
  readonly modality?: PricebookEntry['scope']['modality']
  readonly inputTokens: number
}

/** Select the narrowest applicable, effective price scope for one request. */
export function selectUsagePrice(
  entries: readonly PricebookEntry[],
  query: UsagePriceQuery,
): UsagePriceSelection | null {
  const occurred = Date.parse(query.occurredAt)
  const candidates = entries.filter(entry => {
    const scope = entry.scope
    if (entry.effectiveFrom != null && occurred < Date.parse(entry.effectiveFrom)) return false
    if (entry.effectiveUntil != null && occurred >= Date.parse(entry.effectiveUntil)) return false
    if (scope.serviceTier != null && scope.serviceTier !== query.serviceTier) return false
    if (scope.region != null && scope.region !== query.region) return false
    if (scope.variantId != null && scope.variantId !== query.variantId) return false
    if (scope.plan != null && scope.plan !== query.plan) return false
    if (scope.modality != null && scope.modality !== query.modality) return false
    if (scope.minimumInputTokens != null && query.inputTokens < scope.minimumInputTokens) return false
    if (scope.maximumInputTokens != null && query.inputTokens >= scope.maximumInputTokens) return false
    return true
  })
  if (candidates.length === 0) return null

  const ranked = [...candidates].sort((left, right) => {
    const score = (entry: PricebookEntry) =>
      (entry.scope.serviceTier != null ? 16 : 0) +
      (entry.scope.region != null ? 8 : 0) +
      (entry.scope.variantId != null ? 4 : 0) +
      (entry.scope.minimumInputTokens != null || entry.scope.maximumInputTokens != null ? 2 : 0) +
      (entry.scope.modality != null ? 1 : 0) +
      (entry.scope.plan != null ? 1 : 0)
    return score(right) - score(left) || right.version.localeCompare(left.version)
  })
  const pricebook = ranked[0]!
  const min = pricebook.scope.minimumInputTokens
  const max = pricebook.scope.maximumInputTokens
  return {
    pricebook,
    ...((min != null || max != null)
      ? { contextTier: `${min ?? 0}-${max ?? 'unbounded'}` }
      : {}),
  }
}

/** Calculate a catalog estimate without rounding away small request costs. */
export function calculateUsageCostUsd(
  pricebook: PricebookEntry,
  tokens: UsageLedgerEntry['tokens'],
  units: UsageLedgerEntry['units'],
): number {
  const hasReasoningRate = pricebook.rates.some(rate => rate.dimension === 'reasoning_tokens')
  const quantities: Record<PriceDimension, number> = {
    input_text_tokens: tokens.inputTextTokens ?? 0,
    output_text_tokens: (tokens.outputTextTokens ?? 0) +
      (hasReasoningRate ? 0 : (tokens.reasoningTokens ?? 0)),
    cache_read_tokens: tokens.cacheReadTokens ?? 0,
    cache_write_tokens: tokens.cacheWriteTokens ?? 0,
    reasoning_tokens: tokens.reasoningTokens ?? 0,
    input_audio_tokens: tokens.inputAudioTokens ?? 0,
    output_audio_tokens: tokens.outputAudioTokens ?? 0,
    input_images: units.inputImages ?? 0,
    output_images: units.outputImages ?? 0,
    requests: units.requests ?? 0,
    tool_calls: units.toolCalls ?? 0,
  }
  return pricebook.rates.reduce(
    (total, rate) => total + (quantities[rate.dimension] / rate.unitSize) * rate.amountUsd,
    0,
  )
}
