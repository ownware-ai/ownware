/**
 * Provider Registry
 *
 * Register and resolve provider adapters by name.
 * Model strings like "anthropic:claude-sonnet-4-20250514" are parsed
 * to find the right provider.
 */

import type { ProviderAdapter } from './types.js'
import { resolveAlias } from './router.js'
import { ollamaInstallHint } from './ollama.js'

const providers = new Map<string, ProviderAdapter>()

/** Env var that unlocks each cloud provider — used in actionable errors. */
export const PROVIDER_ENV_HINTS: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

const KEYLESS_HINT =
  `or run keyless with a local model: ${ollamaInstallHint()}, then use model "ollama:llama3.2"`

/**
 * What went wrong, then the ways forward — one per line.
 *
 * This is the first thing many people ever see from the product, so it
 * has to be scannable rather than merely complete: the single-paragraph
 * version carried two alternatives, an install command, a URL and a
 * pull command in one run-on sentence, and a first-time reader had to
 * parse prose to find the one thing to type (CLI FINDINGS F2).
 *
 * When Ollama is already registered we say so instead of pitching an
 * install — that is read off the registry, not assumed. We still cannot
 * know WHICH models have been pulled, so the model name stays an
 * example rather than a promise.
 */
function notConfiguredMessage(providerName: string): string {
  const envVar = PROVIDER_ENV_HINTS[providerName]
  const registered = [...providers.keys()]
  const lines: string[] = [
    envVar
      ? `Provider "${providerName}" is not configured.`
      : `Unknown provider "${providerName}".`,
  ]
  if (envVar) lines.push(`  · set ${envVar} to use it`)
  lines.push(
    registered.includes('ollama')
      ? '  · or run keyless against your local Ollama, e.g. model "ollama:llama3.2"'
      : `  · ${KEYLESS_HINT}`,
  )
  if (registered.length > 0) lines.push(`  · configured right now: ${registered.join(', ')}`)
  return lines.join('\n')
}

export function registerProvider(adapter: ProviderAdapter): void {
  providers.set(adapter.name, adapter)
}

export function unregisterProvider(name: string): boolean {
  return providers.delete(name)
}

export function getProvider(name: string): ProviderAdapter | undefined {
  return providers.get(name)
}

export function resolveProvider(modelString: string): {
  provider: ProviderAdapter
  model: string
} {
  // Resolve aliases first (e.g. "sonnet" → "anthropic:claude-sonnet-4-20250514")
  const resolved = resolveAlias(modelString)

  // Parse "provider:model" format
  const colonIndex = resolved.indexOf(':')
  if (colonIndex > 0) {
    const providerName = resolved.slice(0, colonIndex)
    const model = resolved.slice(colonIndex + 1)
    const provider = providers.get(providerName)
    if (!provider) {
      throw new Error(notConfiguredMessage(providerName))
    }
    return { provider, model }
  }

  // No prefix — try to infer from model name
  if (resolved.startsWith('claude') || resolved.startsWith('claude-')) {
    const provider = providers.get('anthropic')
    if (provider) return { provider, model: resolved }
    throw new Error(notConfiguredMessage('anthropic'))
  }
  if (resolved.startsWith('gpt-') || resolved.startsWith('o1') || resolved.startsWith('o3')) {
    const provider = providers.get('openai')
    if (provider) return { provider, model: resolved }
    throw new Error(notConfiguredMessage('openai'))
  }
  if (resolved.startsWith('gemini')) {
    const provider = providers.get('google')
    if (provider) return { provider, model: resolved }
    throw new Error(notConfiguredMessage('google'))
  }

  throw new Error(
    `Cannot resolve provider for model "${modelString}". Use "provider:model" format (e.g., "anthropic:claude-sonnet-4-20250514").`,
  )
}

export function listProviders(): string[] {
  return [...providers.keys()]
}
