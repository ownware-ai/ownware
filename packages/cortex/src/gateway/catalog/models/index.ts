/**
 * Editorial model policies retained for stable Ownware IDs, aliases and
 * recommendations. Provider Hub is the sole model-discovery authority and
 * overlays these opinions onto its Models.dev generation. Nothing here is an
 * independent availability or pricing source. Narrow historical/local limit
 * fallbacks are inputs to Hub only, never another consumer-facing catalogue.
 */

import type { ModelInfo } from '../../types.js'
import { ANTHROPIC_MODELS } from './anthropic.js'
import { OPENAI_MODELS } from './openai.js'
import { GOOGLE_MODELS } from './google.js'
import { OPENROUTER_MODELS } from './openrouter.js'
import { OLLAMA_MODELS } from './ollama.js'

export { ANTHROPIC_MODELS, OPENAI_MODELS, GOOGLE_MODELS, OPENROUTER_MODELS, OLLAMA_MODELS }

/** Stable editorial policies applied by Provider Hub. */
export const MODEL_POLICIES: readonly ModelInfo[] = [
  ...ANTHROPIC_MODELS,
  ...OPENAI_MODELS,
  ...GOOGLE_MODELS,
  ...OPENROUTER_MODELS,
  ...OLLAMA_MODELS,
] as const

/**
 * Find a single model by its canonical ID (e.g. `anthropic:claude-sonnet-4-6`).
 * Returns undefined if not found.
 */
export function findModelById(id: string): ModelInfo | undefined {
  return MODEL_POLICIES.find((m) => m.id === id)
}

/**
 * Find a model by alias (e.g. `sonnet` → Claude Sonnet 4.6).
 * Case-insensitive, checks both the canonical ID and every alias.
 * Returns undefined if not found.
 */
export function findModelByAlias(alias: string): ModelInfo | undefined {
  const needle = alias.toLowerCase()
  for (const model of MODEL_POLICIES) {
    if (model.id.toLowerCase() === needle) return model
    for (const a of model.aliases) {
      if (a.toLowerCase() === needle) return model
    }
  }
  return undefined
}

/**
 * All models from a single provider, preserving catalog order (newest first).
 */
export function modelsByProvider(provider: string): readonly ModelInfo[] {
  return MODEL_POLICIES.filter((m) => m.provider === provider)
}

/**
 * Canonicalize any user-supplied model string into the `provider:id` form
 * the runtime actually sends to the API.
 *
 * Accepts three input shapes:
 *
 *   - **Canonical id** (`anthropic:claude-haiku-4-5-20251001`) → returned
 *     unchanged when it exists in the catalog. An unknown canonical id is
 *     also returned unchanged — we trust operators to run newer models we
 *     haven't catalogued yet rather than silently downgrading them.
 *   - **Bare alias or id without prefix** (`haiku`, `claude-sonnet-4-6`,
 *     `gpt-5.4-mini`) → resolved via `findModelByAlias` and returned as
 *     the catalog's canonical id.
 *   - **Unknown bare string** → returned unchanged so the caller can
 *     decide how strict to be (usually: let the provider raise a 404).
 *
 * This fixes a class of "404 model: haiku" errors where a profile or API
 * caller wrote a short alias that was never resolved before hitting the
 * provider. Keep this path pure/synchronous — both assembler and request
 * handlers call it on every run.
 */
export function normalizeModelId(input: string): string {
  const trimmed = input.trim()
  if (trimmed.length === 0) return input
  if (trimmed.includes(':')) {
    // Already provider-qualified — trust it. An alias with the provider
    // prefix (e.g. `anthropic:haiku`) is still ambiguous to the API, so
    // try the alias lookup as a rescue.
    if (findModelById(trimmed) != null) return trimmed
    const [, local] = trimmed.split(':', 2)
    if (local != null && local.length > 0) {
      const resolved = findModelByAlias(local)
      if (resolved != null) return resolved.id
    }
    return trimmed
  }
  const resolved = findModelByAlias(trimmed)
  if (resolved != null) return resolved.id
  // Friendly display NAME (e.g. "Deepseek V4 Flash") → canonical id. Profiles
  // sometimes persist the human label instead of the id (a builder or hand-edit
  // mistake); heal it so the run resolves to the right model instead of dying
  // on "Cannot resolve provider". Exact, case-insensitive — an unrecognized
  // string still passes through so the provider raises a clear error.
  const byName = MODEL_POLICIES.find((m) => m.name.toLowerCase() === trimmed.toLowerCase())
  if (byName != null) return byName.id
  return trimmed
}
