/**
 * Default-model auto-pick for keyless-friendly onboarding.
 *
 * Order (first match wins):
 *   1. A cloud key in the environment — that provider's balanced default.
 *      Checked in the same order providers auto-register (anthropic,
 *      openai, google, openrouter).
 *   2. A reachable local Ollama — its first installed model.
 *   3. null — the caller shows one actionable instruction (see
 *      `NO_PROVIDER_INSTRUCTION`) instead of crashing.
 *
 * Deliberately NOT a wizard: no prompts, no writes, deterministic from
 * the environment — safe for CI and scripts.
 */

import { resolveOllamaHost, ollamaInstallHint } from './ollama.js'

// Kept in sync with each provider catalog's `default: true` entry in
// packages/cortex/src/gateway/catalog/models/*.
const CLOUD_DEFAULTS: ReadonlyArray<{ envVar: string; model: string }> = [
  { envVar: 'ANTHROPIC_API_KEY', model: 'anthropic:claude-sonnet-4-6' },
  { envVar: 'OPENAI_API_KEY', model: 'openai:gpt-5.5' },
  { envVar: 'GOOGLE_API_KEY', model: 'google:gemini-2.5-flash' },
  { envVar: 'OPENROUTER_API_KEY', model: 'openrouter:kimi-k2.7-code' },
]

/** The one sentence shown when nothing is configured. */
export const NO_PROVIDER_INSTRUCTION =
  'No model provider is configured. Set one of ANTHROPIC_API_KEY / OPENAI_API_KEY / ' +
  'GOOGLE_API_KEY / OPENROUTER_API_KEY — or run keyless with a local model: ' +
  `${ollamaInstallHint()}.`

/**
 * List the models installed in a local Ollama, or null when no server
 * answers within `timeoutMs`. Never throws.
 */
export async function listOllamaModels(
  host?: string,
  timeoutMs = 300,
): Promise<string[] | null> {
  try {
    const res = await fetch(`${resolveOllamaHost(host)}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { models?: Array<{ name?: string }> }
    const names = (body.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
    return names
  } catch {
    return null
  }
}

/**
 * Pick a default model from the environment, or null when nothing is
 * available. `probe` is injectable for tests; it defaults to the live
 * Ollama tags listing.
 */
export async function pickDefaultModel(opts?: {
  readonly probe?: () => Promise<string[] | null>
}): Promise<string | null> {
  for (const { envVar, model } of CLOUD_DEFAULTS) {
    if (process.env[envVar]) return model
  }
  const probe = opts?.probe ?? (() => listOllamaModels())
  const localModels = await probe()
  if (localModels && localModels.length > 0) {
    return `ollama:${localModels[0]}`
  }
  return null
}
