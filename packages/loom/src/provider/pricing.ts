/**
 * Model Pricing
 *
 * Pricing and capability data is sourced from models.dev (MIT-licensed open
 * database, https://github.com/sst/models.dev). The catalog is fetched at
 * build time via `bun run scripts/sync-models.ts` and committed to
 * `models.dev.json` next to this file. Loom does no runtime network I/O for
 * pricing — the JSON is loaded once at module init.
 *
 * The public surface (getModelPricing, calculateCost, estimateCostFallback,
 * warnIfFallbackPricing) is preserved from the previous manual-table version
 * so existing call sites in loop.ts and the provider adapters keep working.
 *
 * When a model isn't in the catalog, getModelPricing returns null and the
 * caller falls back to estimateCostFallback (Sonnet-tier rates). The first
 * fallback for a given (provider, model) emits a one-time console.warn so
 * silent miscounting becomes visible.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Public types — unchanged from the previous manual-table version so the
// rest of the codebase doesn't have to change.
// ---------------------------------------------------------------------------

export interface ModelPricing {
  /** Input token rate ($/MTok) */
  readonly input: number
  /** Output token rate ($/MTok) */
  readonly output: number
  /** Cache read rate ($/MTok). Null = caching not priced for this model. */
  readonly cacheRead: number | null
  /** Cache write rate ($/MTok). Null = no separate cache-write cost. */
  readonly cacheWrite: number | null
}

/**
 * Extended model metadata. Available when the model is found in models.dev;
 * surfaces capabilities (tool_call, vision, context size) so consumers can
 * make routing decisions without their own model tables.
 */
export interface ModelInfo {
  readonly id: string
  readonly name: string
  readonly family: string | null
  readonly pricing: ModelPricing
  readonly contextWindow: number | null
  readonly maxOutput: number | null
  readonly supportsToolCall: boolean
  readonly supportsReasoning: boolean
  readonly supportsStructuredOutput: boolean
  readonly inputModalities: readonly string[]
  readonly outputModalities: readonly string[]
}

// ---------------------------------------------------------------------------
// Catalog loading — read the committed models.dev snapshot once.
// ---------------------------------------------------------------------------

interface RawModel {
  readonly id: string
  readonly name?: string
  readonly family?: string
  readonly tool_call?: boolean
  readonly reasoning?: boolean
  readonly structured_output?: boolean
  readonly modalities?: { input?: string[]; output?: string[] }
  readonly cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
  }
  readonly limit?: { context?: number; output?: number }
}

interface RawProvider {
  readonly id: string
  readonly name: string
  readonly models: Readonly<Record<string, RawModel>>
}

interface RawCatalog {
  readonly _generated_at: string
  readonly _source: string
  readonly providers: Readonly<Record<string, RawProvider>>
}

const CATALOG_PATH = resolve(
  fileURLToPath(new URL('./models.dev.json', import.meta.url)),
)

let catalogCache: RawCatalog | null = null

function loadCatalog(): RawCatalog {
  if (catalogCache != null) return catalogCache
  try {
    const raw = readFileSync(CATALOG_PATH, 'utf8')
    catalogCache = JSON.parse(raw) as RawCatalog
    return catalogCache
  } catch (err) {
    // The catalog is shipped with the package; missing it means a broken
    // install. Throwing here is correct — silent fallback would mask the
    // real problem (corrupt build, wrong working dir).
    throw new Error(
      `Failed to load model catalog at ${CATALOG_PATH}. ` +
      `Run "bun run scripts/sync-models.ts" to regenerate. ` +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// ID normalization
// ---------------------------------------------------------------------------

/**
 * Anthropic publishes model IDs in two forms:
 *   - bare:  "claude-sonnet-4-6"
 *   - dated: "claude-sonnet-4-6-20260101"
 * models.dev catalogs many IDs in BOTH forms, but new dated releases may not
 * be in the snapshot yet. If an exact lookup misses, strip a trailing
 * "-YYYYMMDD" and retry — that pattern is unique to Anthropic and unambiguous
 * (no OpenAI/Google model ID ends in 8 consecutive digits).
 */
const DATED_SUFFIX_RE = /-\d{8}$/

function findModel(provider: string, modelId: string): RawModel | null {
  const catalog = loadCatalog()
  const providerEntry = catalog.providers[provider]
  if (!providerEntry) return null

  const direct = providerEntry.models[modelId]
  if (direct) return direct

  if (DATED_SUFFIX_RE.test(modelId)) {
    const stripped = modelId.replace(DATED_SUFFIX_RE, '')
    return providerEntry.models[stripped] ?? null
  }
  return null
}

// ---------------------------------------------------------------------------
// Conversion: RawModel → public ModelPricing / ModelInfo
// ---------------------------------------------------------------------------

function toPricing(raw: RawModel): ModelPricing | null {
  const c = raw.cost
  if (c == null || c.input == null || c.output == null) return null
  return {
    input: c.input,
    output: c.output,
    cacheRead: c.cache_read ?? null,
    cacheWrite: c.cache_write ?? null,
  }
}

function toInfo(raw: RawModel): ModelInfo | null {
  const pricing = toPricing(raw)
  if (pricing == null) return null
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    family: raw.family ?? null,
    pricing,
    contextWindow: raw.limit?.context ?? null,
    maxOutput: raw.limit?.output ?? null,
    supportsToolCall: raw.tool_call === true,
    supportsReasoning: raw.reasoning === true,
    supportsStructuredOutput: raw.structured_output === true,
    inputModalities: raw.modalities?.input ?? [],
    outputModalities: raw.modalities?.output ?? [],
  }
}

// ---------------------------------------------------------------------------
// Public API — unchanged signatures from the manual-table era
// ---------------------------------------------------------------------------

/**
 * Strip a leading `provider:` prefix from a model string, if present.
 * Defensive normalization at the pricing boundary so that callers passing
 * the full Loom model string (`anthropic:claude-haiku-4-5-20251001`)
 * don't double up to a missing `anthropic:anthropic:...` cache key. The
 * documented contract is "bare model ID", but production callers in
 * loop.ts have historically passed the full string — fixing every call
 * site is fragile, so we normalize here instead.
 */
function stripProviderPrefix(provider: string, model: string): string {
  const prefix = `${provider}:`
  return model.startsWith(prefix) ? model.slice(prefix.length) : model
}

/**
 * Look up pricing for a model within a provider's catalog.
 *
 * @param provider - Provider name ("anthropic", "openai", "google")
 * @param model - Model ID. Either bare ("claude-haiku-4-5-20251001") or
 *                fully-qualified ("anthropic:claude-haiku-4-5-20251001")
 *                — the function strips a matching `provider:` prefix
 *                so both forms resolve identically.
 * @returns Pricing rates or null if the model isn't in the catalog
 */
export function getModelPricing(provider: string, model: string): ModelPricing | null {
  const raw = findModel(provider, stripProviderPrefix(provider, model))
  return raw == null ? null : toPricing(raw)
}

/**
 * Look up full model metadata (capabilities, limits, pricing). Useful for
 * routing decisions — e.g. "does this model support tool calls?" — without
 * a separate model table on the consumer side.
 *
 * Accepts either a bare model ID or a fully-qualified `provider:model`
 * string; see `getModelPricing` for the normalization rationale.
 */
export function getModelInfo(provider: string, model: string): ModelInfo | null {
  const raw = findModel(provider, stripProviderPrefix(provider, model))
  return raw == null ? null : toInfo(raw)
}

/**
 * List every cataloged model for a provider. Order is not guaranteed.
 * Returns an empty array for unknown providers.
 */
export function listModels(provider: string): ModelInfo[] {
  const catalog = loadCatalog()
  const entry = catalog.providers[provider]
  if (!entry) return []
  const result: ModelInfo[] = []
  for (const raw of Object.values(entry.models)) {
    const info = toInfo(raw)
    if (info != null) result.push(info)
  }
  return result
}

/**
 * Calculate USD cost from token counts and pricing.
 *
 * @param pricing - Model pricing rates
 * @param inputTokens - Regular (uncached) input tokens
 * @param outputTokens - Output tokens
 * @param cacheReadTokens - Tokens served from cache (cheap)
 * @param cacheCreationTokens - Tokens written to cache (slightly more expensive)
 */
export function calculateCost(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): number {
  const input = (inputTokens / 1_000_000) * pricing.input
  const output = (outputTokens / 1_000_000) * pricing.output
  const cacheRead = pricing.cacheRead != null
    ? (cacheReadTokens / 1_000_000) * pricing.cacheRead
    : 0
  const cacheWrite = pricing.cacheWrite != null
    ? (cacheCreationTokens / 1_000_000) * pricing.cacheWrite
    : 0
  return input + output + cacheRead + cacheWrite
}

/** The pricing used when no model entry matches. Sonnet-tier conservative. */
export const FALLBACK_PRICING: ModelPricing = {
  input: 3.0,
  output: 15.0,
  cacheRead: 0.30,
  cacheWrite: 3.75,
}

/**
 * Fallback cost estimation when the model isn't in any pricing table.
 * Uses Sonnet-tier rates as a conservative default.
 */
export function estimateCostFallback(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): number {
  return calculateCost(
    FALLBACK_PRICING,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  )
}

// ---------------------------------------------------------------------------
// Fallback warning — surface silent miscounting
// ---------------------------------------------------------------------------

const warnedFallbackModels = new Set<string>()

/**
 * Emit a one-time `console.warn` when a model resolves to FALLBACK_PRICING.
 * This makes silent cost miscounting visible: the moment a new model ID is
 * used that isn't in the models.dev snapshot (or whose dated alias hasn't
 * been backfilled), the operator sees a single line in the log telling them
 * which model needs a refresh.
 *
 * Returns true when the warning fires (useful for tests).
 */
export function warnIfFallbackPricing(provider: string, model: string): boolean {
  const bare = stripProviderPrefix(provider, model)
  const key = `${provider}:${bare}`
  if (warnedFallbackModels.has(key)) return false
  if (getModelPricing(provider, bare) != null) return false
  warnedFallbackModels.add(key)
  console.warn(
    `[loom/pricing] No pricing entry for "${key}" — falling back to Sonnet ` +
    `rates ($${FALLBACK_PRICING.input}/$${FALLBACK_PRICING.output} per MTok). ` +
    `Reported cost will be approximate. Run "bun run scripts/sync-models.ts" ` +
    `to refresh the catalog from models.dev.`,
  )
  return true
}

/**
 * Test-only: clear the warned-models set so a single test can re-trigger
 * the warn path without leaking state to sibling tests.
 */
export function _resetFallbackWarnings(): void {
  warnedFallbackModels.clear()
}

/**
 * Resolved cost for a turn, plus provenance.
 *
 * The previous shape (a bare `number`) erased whether the value came from
 * an authoritative catalog hit or the Sonnet-tier fallback. The status bar
 * then rendered exact `$X.XXXX` for both — false precision. This object
 * shape carries the boolean so the emit point in `loop.ts` can stamp
 * `TurnUsage.isFallbackPricing` and a client's status bar can render
 * `≈ $X.XXXX` for estimated values.
 *
 * BUG #24 (accuracy-audit, 2026-05-16).
 */
export interface ComputedCost {
  readonly costUsd: number
  /** True when the model wasn't in the catalog and Sonnet-tier rates were used. */
  readonly isFallback: boolean
}

/**
 * Compute cost using the provider catalog when possible, falling back to
 * Sonnet-tier rates when the model isn't catalogued. Returns the resolved
 * USD cost along with a boolean flag the emit point uses to mark the
 * turn's `TurnUsage.isFallbackPricing`.
 *
 * Side effect: emits the same one-time `console.warn` as the bare
 * `warnIfFallbackPricing` (operators still get a single visible log line
 * the first time a new model ID lands without a catalog entry).
 */
export function computeCostWithFallback(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): ComputedCost {
  const pricing = getModelPricing(provider, model)
  if (pricing != null) {
    return {
      costUsd: calculateCost(pricing, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens),
      isFallback: false,
    }
  }
  warnIfFallbackPricing(provider, model)
  return {
    costUsd: estimateCostFallback(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens),
    isFallback: true,
  }
}

/**
 * Test-only: drop the cached catalog so tests that swap the file on disk
 * see the new contents on the next call. Production code never needs this.
 */
export function _resetCatalogCache(): void {
  catalogCache = null
}
