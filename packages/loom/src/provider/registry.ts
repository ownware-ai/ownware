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

/** One actionable sentence for a provider that isn't configured. */
function notConfiguredMessage(providerName: string): string {
  const envVar = PROVIDER_ENV_HINTS[providerName]
  const registered = [...providers.keys()]
  const available =
    registered.length > 0 ? ` Configured providers: ${registered.join(', ')}.` : ''
  if (envVar) {
    return (
      `Provider "${providerName}" is not configured — set ${envVar}, ${KEYLESS_HINT}.` +
      available
    )
  }
  return `Unknown provider "${providerName}".${available} ${KEYLESS_HINT}.`
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
