/**
 * Pure resolver for the active web-search provider.
 *
 * Precedence (authoritative):
 *   1. User setting   — persisted provider id, IF resolvable (key present
 *                        for api_key providers). Stale choice falls through.
 *   2. Env auto-detect — first provider in PAID_PROVIDER_ORDER whose env
 *                        var is present in `env`.
 *   3. Default         — data-declared key-free default.
 *
 * This function has NO I/O. Callers pass snapshots of user setting, env,
 * and vault-resolved keys; the resolver returns a decision. Makes it
 * trivial to unit-test every precedence path in isolation.
 */

import {
  DEFAULT_PROVIDER_ID,
  PAID_PROVIDER_ORDER,
  WEB_SEARCH_PROVIDERS,
  getWebSearchProvider,
  type WebSearchProvider,
} from './providers.js'

/** Source that produced the active provider. Used for telemetry + UI. */
export type WebSearchResolveSource = 'user' | 'env' | 'default'

export type WebSearchStatus = 'ready' | 'needs_setup' | 'error'

export interface WebSearchResolveInput {
  /** User's persisted provider id. Null/undefined if never set. */
  readonly userSetting?: string | null
  /** Snapshot of relevant env vars (envVar → value). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Snapshot of vault-resolved keys per provider id (providerId → key). */
  readonly vaultKeys: Readonly<Record<string, string | undefined>>
}

export interface WebSearchResolveResult {
  readonly providerId: string
  readonly provider: WebSearchProvider
  readonly source: WebSearchResolveSource
  readonly status: WebSearchStatus
  /**
   * When status !== 'ready', a human-readable reason explaining why. Empty
   * string when ready.
   */
  readonly reason: string
  /**
   * The resolved api key, if any. Callers pass this into the strategy.
   * Never logged. Absent for key-free providers.
   */
  readonly apiKey?: string
}

function keyFor(
  provider: WebSearchProvider,
  input: WebSearchResolveInput,
): string | undefined {
  if (provider.auth.mode === 'none') return undefined
  const fromVault = input.vaultKeys[provider.id]
  if (fromVault && fromVault.length > 0) return fromVault
  const fromEnv = input.env[provider.auth.envVar]
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return undefined
}

function tryProvider(
  provider: WebSearchProvider,
  input: WebSearchResolveInput,
  source: WebSearchResolveSource,
): WebSearchResolveResult | null {
  if (provider.auth.mode === 'none') {
    return {
      providerId: provider.id,
      provider,
      source,
      status: 'ready',
      reason: '',
    }
  }
  const key = keyFor(provider, input)
  if (key) {
    return {
      providerId: provider.id,
      provider,
      source,
      status: 'ready',
      reason: '',
      apiKey: key,
    }
  }
  return null
}

export function resolveWebSearchProvider(
  input: WebSearchResolveInput,
): WebSearchResolveResult {
  // 1. User setting — honour only if the chosen provider exists AND is
  //    usable right now. A stale choice (user picked Brave, deleted the
  //    key later) must NOT leave the agent with a broken connector.
  if (input.userSetting) {
    const chosen = getWebSearchProvider(input.userSetting)
    if (chosen) {
      const r = tryProvider(chosen, input, 'user')
      if (r) return r
      // Fall through to env detection.
    }
    // Unknown id in setting — ignore, fall through.
  }

  // 2. Env auto-detect — first paid provider whose env var is present.
  for (const pid of PAID_PROVIDER_ORDER) {
    const p = getWebSearchProvider(pid)
    if (!p) continue
    const r = tryProvider(p, input, 'env')
    if (r) return r
  }

  // 3. Default provider (must be key-free — enforced at module load).
  const def = getWebSearchProvider(DEFAULT_PROVIDER_ID)
  if (!def) {
    // Should be impossible — DEFAULT_PROVIDER_ID is derived from the list.
    return {
      providerId: 'none',
      provider: WEB_SEARCH_PROVIDERS[0]!,
      source: 'default',
      status: 'error',
      reason: 'No web-search providers are registered.',
    }
  }
  // Default is key-free by invariant, so this always succeeds.
  return tryProvider(def, input, 'default')!
}
