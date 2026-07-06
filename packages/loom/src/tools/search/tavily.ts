/**
 * Tavily Search API strategy.
 *
 * Docs: https://docs.tavily.com/
 * Auth: JSON body field `api_key`.
 * Free tier: 1000 searches/month.
 *
 * JSON response shape used: { results: [{ title, url, content }] }
 */

import type { SearchStrategy, SearchStrategyConfig, SearchStrategyResult } from './strategy.js'
import { normalizeMax, normalizeTimeout, sanitizeSnippet, withTimeout } from './strategy.js'

const ENDPOINT = 'https://api.tavily.com/search'

interface TavilyResult {
  title?: string
  url?: string
  content?: string
}
interface TavilyResponse {
  results?: TavilyResult[]
}

export class TavilyStrategy implements SearchStrategy {
  readonly id = 'tavily'
  readonly name = 'Tavily'

  async search(
    query: string,
    config: SearchStrategyConfig,
    signal: AbortSignal,
  ): Promise<SearchStrategyResult[]> {
    if (!config.apiKey) {
      throw new Error('Tavily requires an API key (TAVILY_API_KEY).')
    }

    const max = normalizeMax(config.maxResults)
    const timeoutMs = normalizeTimeout(config.timeoutMs)
    const { signal: linked, cleanup } = withTimeout(signal, timeoutMs)

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          api_key: config.apiKey,
          query,
          max_results: max,
          search_depth: 'basic',
        }),
        signal: linked,
      })

      if (res.status === 401 || res.status === 403) {
        throw new Error(`Tavily rejected the API key (HTTP ${res.status}).`)
      }
      if (res.status === 429) {
        throw new Error('Tavily rate limit reached (HTTP 429).')
      }
      if (!res.ok) {
        throw new Error(`Tavily returned HTTP ${res.status}.`)
      }

      let json: TavilyResponse
      try {
        json = (await res.json()) as TavilyResponse
      } catch (e) {
        throw new Error(
          `Tavily returned malformed JSON: ${e instanceof Error ? e.message : String(e)}`,
        )
      }

      const rows = json.results ?? []
      const out: SearchStrategyResult[] = []
      for (const r of rows) {
        if (out.length >= max) break
        if (!r.url || typeof r.url !== 'string') continue
        if (!/^https?:\/\//i.test(r.url)) continue
        out.push({
          title: sanitizeSnippet(r.title ?? r.url),
          url: r.url,
          snippet: sanitizeSnippet(r.content ?? ''),
        })
      }
      return out
    } finally {
      cleanup()
    }
  }
}
