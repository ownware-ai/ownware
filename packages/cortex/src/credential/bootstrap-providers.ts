/**
 * Wires every loom LLM provider to the unified credential resolver via
 * `apiKeyProvider` closures. Each chat call flows through:
 *
 *   provider.stream() → apiKeyProvider() → resolver.resolve()
 *     → status / spend / trust gates → audit row → injector
 *     → SDK client constructed with the resolved key
 *
 * The resolver needs per-call ctx (agentId, sessionId, threadId) for
 * audit correlation. Until session-runner threads its live ctx through
 * the closure, the placeholder `agentId='gateway-llm'` lets a SQL query
 * filter LLM resolves distinct from tool resolves.
 */

import {
  AnthropicProvider,
  GoogleProvider,
  OpenAIProvider,
  OpenRouterProvider,
  registerProvider,
  type ProviderAdapter,
  type ResolveContext,
} from '@ownware/loom'
import type { CredentialInjector } from './injector.js'
import { makeApiKeyProvider } from './provider-binding.js'
import type { GatewayCredentialResolver } from './resolver.js'
import type { CredentialStore } from './store/index.js'
import { LLM_PROVIDERS } from '../gateway/llm-providers.js'

const PROVIDER_FACTORY: Record<
  string,
  (apiKeyProvider: () => Promise<string>) => ProviderAdapter
> = {
  anthropic: (apiKeyProvider) => new AnthropicProvider({ apiKeyProvider }),
  openai: (apiKeyProvider) => new OpenAIProvider({ apiKeyProvider }),
  google: (apiKeyProvider) => new GoogleProvider({ apiKeyProvider }),
  openrouter: (apiKeyProvider) => new OpenRouterProvider({ apiKeyProvider }),
}

/**
 * Set of provider IDs whose Loom adapter is present in this build.
 * Sourced from the same factory map the bootstrap walks, so a future
 * build that drops (say) the Google adapter and removes its row above
 * will automatically stop reporting `available: true` for Google
 * through `GET /api/v1/providers`. Read-only — exposed for the
 * `providers` handler to annotate the wire response.
 */
export const PROVIDER_ADAPTER_IDS: ReadonlySet<string> = new Set(
  Object.keys(PROVIDER_FACTORY),
)

/** True when Loom exports an adapter for this provider in this build. */
export function isProviderAdapterAvailable(providerId: string): boolean {
  return PROVIDER_ADAPTER_IDS.has(providerId)
}

// ---------------------------------------------------------------------------
// Per-LLM-call context placeholder
// ---------------------------------------------------------------------------

/**
 * Phase-8 placeholder. The resolver writes one audit row per
 * `apiKeyProvider()` call; the ctx fields below land in that row.
 * `agentId='gateway-llm'` is a deliberate marker so a SQL query like
 * `SELECT * FROM credential_audit_log WHERE agent_id = 'gateway-llm'`
 * pulls every LLM call audit row even though the per-session id
 * threading hasn't shipped.
 */
const PLACEHOLDER_LLM_CTX: ResolveContext = {
  agentId: 'gateway-llm',
  sessionId: 'gateway-llm',
  threadId: 'gateway-llm',
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export interface ProviderBootstrapResult {
  /** Provider IDs that got a resolver-backed registration. */
  readonly registered: readonly string[]
  /** Provider IDs whose variableName was missing from the credential store. */
  readonly skipped: readonly string[]
}

export interface BootstrapDeps {
  readonly store: CredentialStore
  readonly resolver: GatewayCredentialResolver
  readonly injector: CredentialInjector
  /** Optional log sink. Defaults to no-op. */
  readonly log?: (message: string) => void
  /**
   * Override the per-call ctx (tests). Production callers omit and
   * accept the `gateway-llm` placeholder.
   */
  readonly contextProvider?: () => ResolveContext
}

/**
 * Walk the provider catalogue. For each provider whose canonical
 * credential exists in the unified store, register a fresh loom
 * provider with an `apiKeyProvider` closure that resolves through
 * the gateway on every LLM call.
 *
 * Idempotent — safe to call multiple times. Each call replaces the
 * registered provider with a fresh closure.
 *
 * Async because the credential lookup hits the store. The store's
 * SQLite reads are synchronous under the hood so the await is
 * cheap, but kept async to match every other store consumer.
 */
export async function bootstrapProvidersFromUnifiedStore(
  deps: BootstrapDeps,
): Promise<ProviderBootstrapResult> {
  const { store, resolver, injector, log = () => {}, contextProvider } = deps
  const registered: string[] = []
  const skipped: string[] = []

  const llmCredentials = await store.list({ category: 'llm' })

  for (const entry of LLM_PROVIDERS) {
    const found = llmCredentials.find((c) => c.variableName === entry.variableName)
    if (!found) {
      skipped.push(entry.providerId)
      continue
    }
    const factory = PROVIDER_FACTORY[entry.providerId]
    if (!factory) continue
    const binding = makeApiKeyProvider({
      resolver,
      injector,
      variableName: entry.variableName,
      context: contextProvider ?? (() => PLACEHOLDER_LLM_CTX),
    })
    registerProvider(factory(binding.apiKeyProvider))
    registered.push(entry.providerId)
  }

  if (registered.length > 0) {
    log(
      `[credentials] wired resolver-backed LLM providers (${registered.join(', ')}) — every chat call now flows through resolve → audit → spend gate before the SDK request`,
    )
  }
  if (skipped.length > 0) {
    log(
      `[credentials] no credential found for ${skipped.join(', ')} — legacy provider registration kept as fallback`,
    )
  }

  return { registered, skipped }
}
