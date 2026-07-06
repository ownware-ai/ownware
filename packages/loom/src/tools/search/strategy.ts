/**
 * Search ProviderStrategy — pluggable web-search backends for the built-in
 * `web_search` tool.
 *
 * Naming note: this is deliberately search-specific for Milestone 1.5. A
 * later milestone generalizes it into a cross-domain `ProviderStrategy` for
 * image generation, transcription, etc. Keeping the name tight for now so
 * the abstraction doesn't pretend to be more general than it is.
 *
 * Contract:
 *   - PURE. No env reads, no globals, no side effects other than `fetch`.
 *   - The caller (Cortex resolver) injects `config` containing the resolved
 *     api key (if any) and runtime caps. A strategy MUST NOT fall back to
 *     `process.env` to "find" a key it wasn't given.
 *   - Strategies return a bounded number of results (<= maxResults, cap 20).
 *   - Strategies honour the provided AbortSignal.
 *   - Strategies never throw on empty results; they return `[]`.
 *   - Strategies throw on transport-level failures (HTTP 4xx/5xx, network
 *     error, timeout). Callers translate to ToolResult.
 */

export interface SearchStrategyResult {
  readonly title: string
  readonly url: string
  readonly snippet: string
}

export interface SearchStrategyConfig {
  /** Resolved API key (omit for key-free providers). */
  readonly apiKey?: string
  /** Per-request timeout in ms. Default 10_000. */
  readonly timeoutMs?: number
  /** Max results (hard-capped at 20). Default 5. */
  readonly maxResults?: number
}

export interface SearchStrategy {
  /** Machine id: `duckduckgo`, `brave`, `tavily`. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /**
   * Execute a query. Throws on transport failure, returns `[]` on empty.
   */
  search(
    query: string,
    config: SearchStrategyConfig,
    signal: AbortSignal,
  ): Promise<SearchStrategyResult[]>
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RESULTS = 5
const MAX_MAX_RESULTS = 20
const MAX_SNIPPET_LEN = 500

export function normalizeMax(n: number | undefined): number {
  const v = n ?? DEFAULT_MAX_RESULTS
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_MAX_RESULTS
  return Math.min(Math.floor(v), MAX_MAX_RESULTS)
}

export function normalizeTimeout(n: number | undefined): number {
  const v = n ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.floor(v), 30_000)
}

/**
 * Decode the HTML entities we actually see from search-result HTML + strip
 * tags. Not a general-purpose sanitizer — bounded, regex-based, zero deps.
 * Output truncated to MAX_SNIPPET_LEN.
 */
export function sanitizeSnippet(s: string): string {
  if (!s) return ''
  const decoded = s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10)
      return Number.isFinite(code) && code < 0x110000 ? String.fromCodePoint(code) : ''
    })
    .replace(/\s+/g, ' ')
    .trim()
  return decoded.length > MAX_SNIPPET_LEN
    ? decoded.slice(0, MAX_SNIPPET_LEN - 1) + '…'
    : decoded
}

/**
 * Compose an AbortSignal that fires on caller abort OR after timeoutMs.
 * `AbortSignal.timeout` + `AbortSignal.any` would be cleaner but `any` isn't
 * universal in our target Node versions yet — use a linked controller.
 */
export function withTimeout(
  parent: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController()
  const onParent = (): void => ctrl.abort(parent.reason)
  if (parent.aborted) {
    ctrl.abort(parent.reason)
  } else {
    parent.addEventListener('abort', onParent, { once: true })
  }
  const timer = setTimeout(() => ctrl.abort(new Error('search timeout')), timeoutMs)
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer)
      parent.removeEventListener('abort', onParent)
    },
  }
}
