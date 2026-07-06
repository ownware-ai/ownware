/**
 * Built-in Web Search Tool
 *
 * Searches the web via a pluggable provider strategy. Cortex's connector
 * layer injects the resolved strategy (DuckDuckGo, Brave, Tavily, ...) at
 * profile-assembly time via `config.webSearchStrategy`.
 *
 * Back-compat (pre-M1.5): the old `config.searchProvider` shape
 * (`{ search(query, max) }`) is still honoured so existing tests and
 * downstream consumers don't break.
 *
 * External contract (tool name + input schema) is stable.
 *
 * @security Snippets are tag-stripped + entity-decoded inside the strategy;
 *   output-sanitizer still runs over the final string to redact any
 *   secrets that may have been leaked into a snippet.
 */

import { defineTool } from '../types.js'
import type { Tool } from '../types.js'
import type {
  SearchStrategy,
  SearchStrategyConfig,
  SearchStrategyResult,
} from '../search/index.js'

/**
 * Legacy provider interface — kept for backward compatibility with
 * pre-M1.5 consumers. New code should inject a `SearchStrategy` via
 * `config.webSearchStrategy` instead.
 *
 * @deprecated Prefer `SearchStrategy` from `@ownware/loom`.
 */
export interface SearchProvider {
  search(query: string, maxResults?: number): Promise<SearchResult[]>
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * Runtime config injected by Cortex at assembly time. Separate from
 * `SearchStrategyConfig` because the tool reads `maxResults` from the
 * agent's call, not from this config.
 */
export interface WebSearchStrategyBinding {
  readonly strategy: SearchStrategy
  /** Resolved API key for the active strategy, if any. */
  readonly apiKey?: string
  /** Optional per-request timeout override. */
  readonly timeoutMs?: number
}

function toStrategyResults(rs: SearchResult[]): SearchStrategyResult[] {
  return rs.map(r => ({ title: r.title, url: r.url, snippet: r.snippet }))
}

export const webSearch: Tool = defineTool({
  name: 'web_search',
  description:
    'Search the web for current information.\n' +
    '- Use for information beyond your knowledge cutoff.\n' +
    '- Use for looking up documentation, APIs, error messages, packages.\n' +
    '- Include the current year in queries about recent events.\n' +
    '- After using results, always cite your sources with URLs.\n' +
    '- Do NOT use for information you already know confidently.',
  category: 'search',
  isReadOnly: true,
  requiresPermission: true,
  uiDescriptor: {
    kind: 'search',
    summary: { verb: 'Searched web', primaryField: 'query' },
    preview: { contentField: 'results', format: 'markdown', truncateAtLines: 10 },
  },
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query. Be specific and include relevant context.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return. Default: 5.',
      },
    },
    required: ['query'],
  },
  async execute(input, context) {
    const { query, max_results = 5 } = input as {
      query: string
      max_results?: number
    }

    if (typeof query !== 'string' || query.length === 0) {
      return {
        content: 'web_search requires a non-empty `query` string.',
        isError: true,
        metadata: { reason: 'invalid_input' },
      }
    }

    const cfg = context.config as Record<string, unknown>
    const strategyBinding = cfg['webSearchStrategy'] as
      | WebSearchStrategyBinding
      | undefined
    const legacyProvider = cfg['searchProvider'] as SearchProvider | undefined

    // Resolve provider: prefer injected strategy; fall back to legacy.
    let results: SearchStrategyResult[]
    let providerName: string

    try {
      if (strategyBinding?.strategy) {
        providerName = strategyBinding.strategy.name
        const searchCfg: SearchStrategyConfig = {
          maxResults: max_results,
        }
        if (strategyBinding.apiKey !== undefined) {
          ;(searchCfg as { apiKey?: string }).apiKey = strategyBinding.apiKey
        }
        if (strategyBinding.timeoutMs !== undefined) {
          ;(searchCfg as { timeoutMs?: number }).timeoutMs = strategyBinding.timeoutMs
        }
        results = await strategyBinding.strategy.search(query, searchCfg, context.signal)
      } else if (legacyProvider) {
        providerName = 'search-provider'
        const legacy = await legacyProvider.search(query, max_results)
        results = toStrategyResults(legacy)
      } else {
        return {
          content:
            'Web search is not configured in this session. ' +
            'No search provider is available. ' +
            'Try using web_fetch with a specific URL instead, or proceed with your existing knowledge.',
          isError: true,
          metadata: { reason: 'no_provider' },
        }
      }
    } catch (e) {
      // Never log the raw query — it may carry PII.
      const msg = e instanceof Error ? e.message : String(e)
      // DuckDuckGo CAPTCHA challenges surface as DDG_BOT_CHECK. Route them
      // to a dedicated reason so the UI / agent can distinguish "DDG is
      // rate-limiting you" from generic network failure.
      const code = (e as { code?: string })?.code
      if (code === 'DDG_BOT_CHECK') {
        return {
          content: msg,
          isError: true,
          metadata: {
            reason: 'rate_limited',
            provider: 'duckduckgo',
            queryLength: query.length,
          },
        }
      }
      return {
        content: `Search failed: ${msg}`,
        isError: true,
        metadata: {
          reason: 'strategy_error',
          queryLength: query.length,
          error: msg,
        },
      }
    }

    if (results.length === 0) {
      // Honest 0-result message. When the active provider is DuckDuckGo,
      // point the caller at the paid providers — DDG has no SLA and this
      // is the one case where "0 results" most often means "markup drift
      // or soft rate-limit" rather than "no matches exist."
      const isDdg = providerName.toLowerCase() === 'duckduckgo'
      const hint = isDdg
        ? ' DuckDuckGo (key-free default) sometimes returns empty under soft rate-limiting.' +
          ' If this keeps happening, set BRAVE_SEARCH_API_KEY or TAVILY_API_KEY for reliable production search.'
        : ''
      return {
        content: `No results found for: "${query}".${hint}`,
        isError: false,
        metadata: {
          resultCount: 0,
          provider: providerName,
          queryLength: query.length,
          ...(isDdg ? { hint: 'consider_paid_provider' } : {}),
        },
      }
    }

    const formatted = results.map((r, i) =>
      `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`,
    ).join('\n\n')

    const content =
      `Search results for "${query}":\n\n${formatted}\n\n` +
      `Sources: ${results.map(r => `[${r.title}](${r.url})`).join(', ')}`

    return {
      content,
      isError: false,
      metadata: {
        resultCount: results.length,
        provider: providerName,
        queryLength: query.length,
      },
    }
  },
})

export const webSearchTools: Tool[] = [webSearch]
