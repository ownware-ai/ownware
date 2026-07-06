/**
 * Brave Search API strategy.
 *
 * Docs: https://api.search.brave.com/app/documentation/web-search/get-started
 * Auth: header `X-Subscription-Token: <api_key>`.
 * Free tier: 2000 queries/month on the "Data for Search" plan.
 *
 * JSON response shape used:
 *   { web: { results: [{ title, url, description }] } }
 */

import type { SearchStrategy, SearchStrategyConfig, SearchStrategyResult } from './strategy.js'
import { normalizeMax, normalizeTimeout, sanitizeSnippet, withTimeout } from './strategy.js'

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

interface BraveResult {
  title?: string
  url?: string
  description?: string
}
interface BraveResponse {
  web?: { results?: BraveResult[] }
}

export class BraveStrategy implements SearchStrategy {
  readonly id = 'brave'
  readonly name = 'Brave Search'

  async search(
    query: string,
    config: SearchStrategyConfig,
    signal: AbortSignal,
  ): Promise<SearchStrategyResult[]> {
    if (!config.apiKey) {
      throw new Error('Brave Search requires an API key (BRAVE_SEARCH_API_KEY).')
    }

    const max = normalizeMax(config.maxResults)
    const timeoutMs = normalizeTimeout(config.timeoutMs)
    const { signal: linked, cleanup } = withTimeout(signal, timeoutMs)

    try {
      const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&count=${max}`
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': config.apiKey,
        },
        signal: linked,
      })

      if (res.status === 401 || res.status === 403) {
        throw new Error(`Brave Search rejected the API key (HTTP ${res.status}).`)
      }
      if (res.status === 429) {
        throw new Error('Brave Search rate limit reached (HTTP 429).')
      }
      if (!res.ok) {
        throw new Error(`Brave Search returned HTTP ${res.status}.`)
      }

      let json: BraveResponse
      try {
        json = (await res.json()) as BraveResponse
      } catch (e) {
        throw new Error(
          `Brave Search returned malformed JSON: ${e instanceof Error ? e.message : String(e)}`,
        )
      }

      const rows = json.web?.results ?? []
      const out: SearchStrategyResult[] = []
      for (const r of rows) {
        if (out.length >= max) break
        if (!r.url || typeof r.url !== 'string') continue
        if (!/^https?:\/\//i.test(r.url)) continue
        out.push({
          title: sanitizeSnippet(r.title ?? r.url),
          url: r.url,
          snippet: sanitizeSnippet(r.description ?? ''),
        })
      }
      return out
    } finally {
      cleanup()
    }
  }
}
