/**
 * Catalog fact merge.
 *
 * The catalog files (anthropic.ts / openai.ts / google.ts / openrouter.ts) own
 * the EDITORIAL layer — which models to show, their display name, tier,
 * description, aliases, and default flag. Those are opinions; nobody else can
 * decide them.
 *
 * The OBJECTIVE facts — context window, max output, pricing — are NOT
 * hand-authored truth. They come from the live snapshots Loom ships:
 *   - direct providers (anthropic/openai/google) → models.dev (`getModelInfo`)
 *   - everything on OpenRouter                    → OpenRouter's own API
 *                                                   (`getOpenRouterModelInfo`,
 *                                                    keyed by the entry's `orSlug`)
 *
 * Merge rule: the snapshot wins. The catalog's hand-typed number is used ONLY
 * as a fallback when the snapshot doesn't have the model yet (a brand-new
 * release not synced, or an OpenRouter entry missing `orSlug`). This is what
 * stops the catalog from drifting into false context/pricing claims — the only
 * way a number can be wrong now is if BOTH the snapshot lacks it AND the
 * hand-typed fallback is stale.
 *
 * Scope (deliberate): only context/output/pricing merge here. Capabilities,
 * tier, name, description, aliases stay catalog-owned — capabilities carry
 * editorial signals (code_exec, citations) that the snapshots don't model, so
 * overwriting them would drop capability icons. That merge is a separate slice.
 */

import { getModelInfo, getOpenRouterModelInfo, type ModelFacts } from '@ownware/loom'
import type { ModelInfo } from '../../types.js'

/**
 * Resolve live facts for a catalog entry from the right snapshot, or null when
 * the model isn't catalogued in the snapshot (caller falls back to the entry's
 * own values).
 */
function factsFor(model: ModelInfo): ModelFacts | null {
  if (model.provider === 'openrouter') {
    // Needs the vendor slug — the canonical id (`openrouter:deepseek-v4-pro`)
    // doesn't match OpenRouter's slug (`deepseek/deepseek-v4-pro`).
    return model.orSlug != null ? getOpenRouterModelInfo(model.orSlug) : null
  }
  // models.dev is keyed by bare model id; getModelInfo strips the `provider:`
  // prefix itself, so the canonical id is the right argument.
  return getModelInfo(model.provider, model.id)
}

/**
 * Convert a USD/MILLION-token rate (snapshot convention) to the catalog's
 * USD/1K-token convention. Rounds to strip float-division noise without losing
 * precision for cheap open-weights models.
 */
function perMillionToPer1k(perMillion: number): number {
  return Number((perMillion / 1000).toFixed(10))
}

/**
 * Overlay live facts onto a single catalog entry. Snapshot values win;
 * hand-typed catalog values are the fallback. Editorial fields are untouched.
 */
export function enrichModel(model: ModelInfo): ModelInfo {
  const facts = factsFor(model)
  if (facts == null) return model

  return {
    ...model,
    contextWindow: facts.contextWindow ?? model.contextWindow,
    maxOutputTokens: facts.maxOutput ?? model.maxOutputTokens,
    costPer1kInput:
      facts.pricing != null ? perMillionToPer1k(facts.pricing.input) : model.costPer1kInput,
    costPer1kOutput:
      facts.pricing != null ? perMillionToPer1k(facts.pricing.output) : model.costPer1kOutput,
  }
}

/** Map {@link enrichModel} over the whole catalog. */
export function enrichCatalog(models: readonly ModelInfo[]): ModelInfo[] {
  return models.map(enrichModel)
}

/**
 * Where a model's objective numbers come from:
 *   - `'snapshot'` — context/output/pricing were resolved from the live
 *     models.dev / OpenRouter snapshot. Authoritative.
 *   - `'fallback'` — the snapshot has no entry, so the catalog's hand-typed
 *     numbers are in use. These can drift; clean them up (delete the hand-typed
 *     values once the snapshot catches up) on the next sync.
 *
 * This is the visibility step 3 is really about: instead of deleting the
 * fallback (which would blank-out brand-new models not yet in any snapshot,
 * e.g. the OpenAI default the day it ships), we make the fallback set
 * queryable so it's reviewed, not silently trusted.
 */
export function factsSource(model: ModelInfo): 'snapshot' | 'fallback' {
  return factsFor(model) != null ? 'snapshot' : 'fallback'
}

/**
 * The catalog models currently relying on hand-typed numbers because no
 * snapshot covers them. Operators/CI watch this list: it should shrink toward
 * empty as snapshots catch up, and any *new* member is a signal to either run a
 * sync or accept a temporary hand-typed entry.
 */
export function modelsUsingFallback(models: readonly ModelInfo[]): readonly ModelInfo[] {
  return models.filter((m) => factsSource(m) === 'fallback')
}
