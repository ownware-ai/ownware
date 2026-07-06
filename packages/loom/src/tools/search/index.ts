/**
 * Search strategies — public exports.
 *
 * Strategies are pure (no env reads, no globals). The caller (Cortex's
 * connector resolver) injects an API key when constructing the
 * `SearchStrategyConfig` for each `search()` invocation.
 */

export type {
  SearchStrategy,
  SearchStrategyConfig,
  SearchStrategyResult,
} from './strategy.js'
export {
  normalizeMax,
  normalizeTimeout,
  sanitizeSnippet,
  withTimeout,
} from './strategy.js'

export {
  DuckDuckGoStrategy,
  DuckDuckGoBotCheckError,
  parseDuckDuckGoHtml,
  detectDuckDuckGoBotCheck,
} from './duckduckgo.js'
export { BraveStrategy } from './brave.js'
export { TavilyStrategy } from './tavily.js'
export { PerplexityOpenRouterStrategy } from './perplexity-openrouter.js'
