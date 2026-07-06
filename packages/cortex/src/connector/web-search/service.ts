/**
 * Web-search service — impure wrapper around the pure resolver.
 *
 * Responsibilities:
 *   - Load/save the user's persisted provider choice (user_settings).
 *   - Load/save per-provider API keys (CredentialVault under
 *     `builtin:web_search:<providerId>`).
 *   - Build the Loom `SearchStrategy` instance for the active provider.
 *   - Emit a one-shot startup diagnostic on first resolution per process.
 *
 * This module is the ONLY write path to the web-search credential vault
 * ids. The MCP credential endpoint does not allow `builtin:*` writes
 * because it validates the server id against the MCP registry first.
 */

import {
  BraveStrategy,
  DuckDuckGoStrategy,
  PerplexityOpenRouterStrategy,
  TavilyStrategy,
  type SearchStrategy,
} from '@ownware/loom'
import type { CredentialVault } from '../credentials/vault.js'
import { credentialVault as defaultVault } from '../credentials/vault.js'
import {
  DEFAULT_PROVIDER_ID,
  WEB_SEARCH_PROVIDERS,
  getWebSearchProvider,
  vaultIdFor,
  type WebSearchProvider,
} from './providers.js'
import {
  resolveWebSearchProvider,
  type WebSearchResolveResult,
} from './resolver.js'

/** Settings key for the user's persisted web-search provider choice. */
export const WEB_SEARCH_SETTING_KEY = 'connector.web_search.providerId'

/**
 * Narrow storage contract — only the methods the service needs. This keeps
 * the service unit-testable with a tiny in-memory stub (no DB required).
 */
export interface WebSearchSettingsStore {
  getSetting(key: string): { value: string } | undefined
  setSetting(key: string, value: string): unknown
}

export interface WebSearchServiceOptions {
  readonly settings: WebSearchSettingsStore
  readonly vault?: CredentialVault
}

/** Once-per-process startup diagnostic guard. */
const loggedOnce = new Set<string>()

export class WebSearchService {
  private readonly settings: WebSearchSettingsStore
  private readonly vault: CredentialVault

  constructor(opts: WebSearchServiceOptions) {
    this.settings = opts.settings
    this.vault = opts.vault ?? defaultVault
  }

  listProviders(): readonly WebSearchProvider[] {
    return WEB_SEARCH_PROVIDERS
  }

  getDefaultProviderId(): string {
    return DEFAULT_PROVIDER_ID
  }

  /** Load the user's persisted choice, if any. */
  getUserChoice(): string | null {
    const row = this.settings.getSetting(WEB_SEARCH_SETTING_KEY)
    return row?.value ?? null
  }

  /**
   * Persist the user's choice. Does NOT validate that the provider is
   * usable — resolution will fall through if the key is missing.
   * Validation of the provider id (known) happens at the handler layer.
   */
  setUserChoice(providerId: string): void {
    if (!getWebSearchProvider(providerId)) {
      throw new Error(`Unknown web-search provider: ${providerId}`)
    }
    this.settings.setSetting(WEB_SEARCH_SETTING_KEY, providerId)
  }

  /** Persist an API key for a provider into the vault under the reserved id. */
  async saveApiKey(providerId: string, apiKey: string): Promise<void> {
    const p = getWebSearchProvider(providerId)
    if (!p) throw new Error(`Unknown web-search provider: ${providerId}`)
    if (p.auth.mode !== 'api_key') {
      throw new Error(`Provider "${providerId}" does not accept an API key`)
    }
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      throw new Error('API key must be a non-empty string')
    }
    await this.vault.save(vaultIdFor(providerId), { [p.auth.envVar]: apiKey })
  }

  /** Resolve active provider, honouring user / env / default precedence. */
  async resolve(): Promise<WebSearchResolveResult> {
    // Build env + vault snapshots. Only pull the envVars we care about so
    // we never leak unrelated secrets into the resolver closure.
    const env: Record<string, string | undefined> = {}
    const vaultKeys: Record<string, string | undefined> = {}
    for (const p of WEB_SEARCH_PROVIDERS) {
      if (p.auth.mode === 'api_key') {
        env[p.auth.envVar] = process.env[p.auth.envVar]
        const creds = await this.vault.load(vaultIdFor(p.id))
        vaultKeys[p.id] = creds?.env[p.auth.envVar]
      }
    }

    const result = resolveWebSearchProvider({
      userSetting: this.getUserChoice(),
      env,
      vaultKeys,
    })

    this.logOnce(result)
    return result
  }

  /** Build the Loom SearchStrategy for the active provider. */
  buildStrategy(providerId: string): SearchStrategy {
    switch (providerId) {
      case 'duckduckgo':
        return new DuckDuckGoStrategy()
      case 'brave':
        return new BraveStrategy()
      case 'tavily':
        return new TavilyStrategy()
      case 'perplexity-openrouter':
        return new PerplexityOpenRouterStrategy()
      default:
        throw new Error(`No strategy implementation for provider "${providerId}"`)
    }
  }

  private logOnce(result: WebSearchResolveResult): void {
    const key = `web_search:${result.providerId}:${result.status}:${result.source}`
    if (loggedOnce.has(key)) return
    loggedOnce.add(key)
    // Matches other ownware logs: `[ownware] <subsystem>: k=v k=v`.
    // No secrets, no query text.
    console.log(
      `[ownware] web_search: provider=${result.providerId} status=${result.status} source=${result.source}`,
    )
  }
}

/** Test-only: reset the once-per-process log guard. */
export function __resetWebSearchStartupLogForTests(): void {
  loggedOnce.clear()
}
