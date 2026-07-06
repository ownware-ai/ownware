/**
 * Web-search provider catalog.
 *
 * Data, not code: this is the authoritative list of pluggable search
 * providers. Adding a new provider means adding a row here and registering
 * a strategy constructor in `./strategies.ts` — nothing else.
 *
 * Each entry is serialisable to JSON for the gateway API response.
 */

import { z } from 'zod'

/** Reserved credential-vault id prefix for built-in pluggable connectors. */
export const WEB_SEARCH_VAULT_PREFIX = 'builtin:web_search'

/**
 * Build the vault id for a given web-search provider. Used when persisting
 * API keys via `CredentialVault.save(vaultIdFor(pid), { [envName]: key })`.
 */
export function vaultIdFor(providerId: string): string {
  return `${WEB_SEARCH_VAULT_PREFIX}:${providerId}`
}

export const WebSearchAuthSchema = z.union([
  z.object({ mode: z.literal('none') }),
  z.object({
    mode: z.literal('api_key'),
    /** Env var name clients should set as the one-click alternative. */
    envVar: z.string().min(1),
    /** URL where users can sign up for a key. */
    signupUrl: z.string().url(),
    /** Short free-tier blurb (e.g. "2000 queries/month free"). */
    freeTier: z.string().min(1),
  }),
])
export type WebSearchAuth = z.infer<typeof WebSearchAuthSchema>

export const WebSearchProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  auth: WebSearchAuthSchema,
  /** Home page / marketing site. */
  homepage: z.string().url(),
  /** Whether this is the data-declared default (at most one). */
  isDefault: z.boolean().default(false),
})
export type WebSearchProvider = z.infer<typeof WebSearchProviderSchema>

export const WEB_SEARCH_PROVIDERS: readonly WebSearchProvider[] = [
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    description:
      'Key-free default. Uses the public DuckDuckGo HTML endpoint. No API key or signup required.',
    auth: { mode: 'none' },
    homepage: 'https://duckduckgo.com',
    isDefault: true,
  },
  {
    id: 'brave',
    name: 'Brave Search',
    description:
      'Independent search index with a generous free tier. Requires an API key from the Brave Search API portal.',
    auth: {
      mode: 'api_key',
      envVar: 'BRAVE_SEARCH_API_KEY',
      signupUrl: 'https://api.search.brave.com/app/keys',
      freeTier: '2,000 queries/month free on the Data for Search plan.',
    },
    homepage: 'https://search.brave.com',
    isDefault: false,
  },
  {
    id: 'tavily',
    name: 'Tavily',
    description:
      'Search API designed for AI agents, optimised for relevance over recall. Free tier available after signup.',
    auth: {
      mode: 'api_key',
      envVar: 'TAVILY_API_KEY',
      signupUrl: 'https://tavily.com/#pricing',
      freeTier: '1,000 searches/month free.',
    },
    homepage: 'https://tavily.com',
    isDefault: false,
  },
  {
    id: 'perplexity-openrouter',
    name: 'Perplexity (via OpenRouter)',
    description:
      'AI-synthesized search that returns one grounded answer with citations instead of a list of snippets. Reuses your existing OPENROUTER_API_KEY — no separate Perplexity subscription needed.',
    auth: {
      mode: 'api_key',
      envVar: 'OPENROUTER_API_KEY',
      signupUrl: 'https://openrouter.ai/keys',
      freeTier: 'Pay-per-use. ~$1/1K Sonar queries on OpenRouter.',
    },
    homepage: 'https://perplexity.ai',
    isDefault: false,
  },
]

/**
 * Ordered list of paid providers for env-auto-detect. Order defines
 * precedence when multiple env keys are present.
 *
 * `perplexity-openrouter` sits AFTER the dedicated search keys
 * (`BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`) because those env vars
 * exclusively mean "use this for search," while `OPENROUTER_API_KEY` is
 * also the model-routing key — many users set it without intending to
 * change their search provider. Keeping it last means OpenRouter-only
 * users still get AI-synthesized search by default, and Brave/Tavily
 * users keep the behaviour they signed up for.
 */
export const PAID_PROVIDER_ORDER: readonly string[] = [
  'brave',
  'tavily',
  'perplexity-openrouter',
]

export const DEFAULT_PROVIDER_ID: string = (() => {
  const d = WEB_SEARCH_PROVIDERS.find(p => p.isDefault)
  if (!d) throw new Error('WEB_SEARCH_PROVIDERS must include exactly one default')
  if (d.auth.mode !== 'none') {
    throw new Error('Default web-search provider MUST be key-free (auth.mode === "none")')
  }
  return d.id
})()

export function getWebSearchProvider(id: string): WebSearchProvider | undefined {
  return WEB_SEARCH_PROVIDERS.find(p => p.id === id)
}
