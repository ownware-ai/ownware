/**
 * OpenRouter model facts.
 *
 * Companion to pricing.ts: where pricing.ts reads the models.dev snapshot for
 * direct providers (anthropic / openai / google), this reads the committed
 * OpenRouter snapshot (`openrouter-models.json`, produced by
 * `scripts/sync-openrouter.ts`) for every model OpenRouter routes.
 *
 * Why a separate source: models.dev has NO `openrouter` provider, so it can't
 * tell us what OpenRouter actually charges or the limits it enforces. The
 * vendor's own API is the only authoritative, always-fresh source — see the
 * sync script header for the full rationale.
 *
 * Returns the SAME `ModelInfo` shape as pricing.ts so a single consumer (the
 * Cortex catalog merge) treats both sources identically. Pricing is in USD per
 * MILLION tokens, matching the models.dev convention.
 *
 * Keyed by OpenRouter slug (e.g. `deepseek/deepseek-v4-pro`,
 * `moonshotai/kimi-k2.6`), NOT by Loom's canonical `openrouter:<id>`. The
 * slug↔canonical mapping lives in the Cortex catalog (`orSlug` field) because
 * that's where the editorial model selection lives. Loom is given the slug.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ModelInfo, ModelPricing } from './pricing.js'

// ---------------------------------------------------------------------------
// Snapshot shape — mirror of what sync-openrouter.ts writes.
// ---------------------------------------------------------------------------

interface RawCost {
  readonly input: number | null
  readonly output: number | null
  readonly cache_read: number | null
  readonly cache_write: number | null
}

interface RawCapabilities {
  readonly tools: boolean
  readonly reasoning: boolean
  readonly structured: boolean
  readonly vision: boolean
  readonly pdf: boolean
}

interface RawORModel {
  readonly id: string
  readonly name: string
  readonly created: number | null
  readonly context_length: number | null
  readonly max_output_tokens: number | null
  readonly cost: RawCost
  readonly capabilities: RawCapabilities
}

interface RawORCatalog {
  readonly _generated_at: string
  readonly _source: string
  readonly _count: number
  readonly models: Readonly<Record<string, RawORModel>>
}

const CATALOG_PATH = resolve(
  fileURLToPath(new URL('./openrouter-models.json', import.meta.url)),
)

let catalogCache: RawORCatalog | null = null

function loadCatalog(): RawORCatalog {
  if (catalogCache != null) return catalogCache
  try {
    const raw = readFileSync(CATALOG_PATH, 'utf8')
    catalogCache = JSON.parse(raw) as RawORCatalog
    return catalogCache
  } catch (err) {
    // Shipped with the package; missing it means a broken install. Throwing is
    // correct — silent fallback would mask the real problem.
    throw new Error(
      `Failed to load OpenRouter catalog at ${CATALOG_PATH}. ` +
      `Run "bun run scripts/sync-openrouter.ts" to regenerate. ` +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Conversion: RawORModel → public ModelInfo (same shape as pricing.ts)
// ---------------------------------------------------------------------------

function toPricing(raw: RawORModel): ModelPricing | null {
  const c = raw.cost
  if (c.input == null || c.output == null) return null
  return {
    input: c.input,
    output: c.output,
    cacheRead: c.cache_read,
    cacheWrite: c.cache_write,
  }
}

function toInfo(raw: RawORModel): ModelInfo | null {
  const pricing = toPricing(raw)
  if (pricing == null) return null
  const inputModalities = ['text']
  if (raw.capabilities.vision) inputModalities.push('image')
  if (raw.capabilities.pdf) inputModalities.push('pdf')
  return {
    id: raw.id,
    name: raw.name,
    family: null,
    pricing,
    contextWindow: raw.context_length,
    maxOutput: raw.max_output_tokens,
    supportsToolCall: raw.capabilities.tools,
    supportsReasoning: raw.capabilities.reasoning,
    supportsStructuredOutput: raw.capabilities.structured,
    inputModalities,
    outputModalities: ['text'],
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up full model facts for an OpenRouter slug (e.g.
 * `deepseek/deepseek-v4-pro`). Returns null when the slug isn't in the
 * snapshot — the caller falls back to its own value (e.g. the catalog's
 * hand-typed numbers for a model not yet synced).
 */
export function getOpenRouterModelInfo(slug: string): ModelInfo | null {
  const raw = loadCatalog().models[slug]
  return raw == null ? null : toInfo(raw)
}

/**
 * Pricing-only view of {@link getOpenRouterModelInfo}, mirroring
 * `getModelPricing` for direct providers. Pricing is USD per million tokens.
 */
export function getOpenRouterPricing(slug: string): ModelPricing | null {
  const raw = loadCatalog().models[slug]
  return raw == null ? null : toPricing(raw)
}

/** Test-only: drop the cached catalog so tests can swap the file on disk. */
export function _resetOpenRouterCatalogCache(): void {
  catalogCache = null
}
