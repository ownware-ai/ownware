/**
 * Unified model catalog — re-exports every provider's list + union.
 *
 * To add a new provider:
 *   1. Create `models/<provider>.ts` following the anthropic.ts template
 *   2. Import it here and add to the `ALL_MODELS` union
 *   3. The gateway's `/api/v1/models` handler picks it up automatically
 *
 * To add a new model within an existing provider:
 *   1. Add the entry at the top of that provider's array (newest first)
 *   2. If it's the new flagship, move the `default: true` flag onto it
 *   3. Run the catalog tests — they verify no duplicate IDs, every default
 *      exists per provider, every alias is unique
 */

import { listProviders, listOllamaModels } from '@ownware/loom'
import type { ModelInfo } from '../../types.js'
import { ANTHROPIC_MODELS } from './anthropic.js'
import { OPENAI_MODELS } from './openai.js'
import { GOOGLE_MODELS } from './google.js'
import { OPENROUTER_MODELS } from './openrouter.js'
import { OLLAMA_MODELS } from './ollama.js'

export { ANTHROPIC_MODELS, OPENAI_MODELS, GOOGLE_MODELS, OPENROUTER_MODELS, OLLAMA_MODELS }

/** Flat union of every model in every provider catalog. */
export const ALL_MODELS: readonly ModelInfo[] = [
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
  return ALL_MODELS.find((m) => m.id === id)
}

/**
 * Find a model by alias (e.g. `sonnet` → Claude Sonnet 4.6).
 * Case-insensitive, checks both the canonical ID and every alias.
 * Returns undefined if not found.
 */
export function findModelByAlias(alias: string): ModelInfo | undefined {
  const needle = alias.toLowerCase()
  for (const model of ALL_MODELS) {
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
  return ALL_MODELS.filter((m) => m.provider === provider)
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
  const byName = ALL_MODELS.find((m) => m.name.toLowerCase() === trimmed.toLowerCase())
  if (byName != null) return byName.id
  return trimmed
}

/**
 * Pick a model that can actually answer on THIS install, or null when
 * nothing is available.
 *
 * Order (first match wins):
 *   1. A provider already registered in Loom's registry — covers both
 *      env-var keys (registered at boot) and vault-saved keys
 *      (registered by the store→loom bootstrap). Returns that
 *      provider's catalog default.
 *   2. A reachable local Ollama — its first *installed* model (the
 *      catalog can't know what the user has pulled, so ask the server).
 *   3. null — the caller falls through to the provider's actionable
 *      "set a key or install Ollama" error instead of guessing.
 *
 * This is the server-side twin of Loom's `pickDefaultModel` (which only
 * sees env vars). The gateway must consult the live registry, or a key
 * added via `ownware key add` / the Settings UI would be invisible here.
 */
export async function pickRunnableDefaultModel(opts?: {
  /** Injectable Ollama probe (tests). Defaults to the live tags listing. */
  readonly probe?: () => Promise<string[] | null>
}): Promise<string | null> {
  for (const providerId of listProviders()) {
    if (providerId === 'ollama') continue
    const models = modelsByProvider(providerId)
    const pick = models.find((m) => m.default) ?? models[0]
    if (pick != null) return pick.id
  }
  const probe = opts?.probe ?? (() => listOllamaModels())
  const installed = await probe()
  if (installed != null && installed.length > 0) return `ollama:${installed[0]}`
  return null
}
