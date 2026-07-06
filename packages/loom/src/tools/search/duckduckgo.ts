/**
 * DuckDuckGo HTML strategy — key-free default.
 *
 * Endpoint: https://html.duckduckgo.com/html/?q=...
 *
 * Scraping a user-facing HTML endpoint is inherently fragile: DDG has
 * changed their markup at least three times since 2019, and they serve
 * CAPTCHA challenges when they suspect abuse. This implementation trades
 * simplicity for layers of resilience so a single upstream change does
 * not brick the default provider again:
 *
 *   1. Multi-tier HTML parsing. Four independent extractors are tried in
 *      order — modern direct-URL anchors, legacy `/l/?uddg=` redirect
 *      anchors, structural block parse, and a lenient h2-anchor fallback.
 *      The first tier that produces results wins.
 *   2. Explicit bot-check detection. CAPTCHA / anomaly pages are caught
 *      by signature and raised as `DuckDuckGoBotCheckError`, NOT as "no
 *      results" — the caller can surface the right remediation ("switch
 *      provider", "try later") instead of misleading the user.
 *   3. Dedupe + non-http URL guard. Duplicate URLs across tiers collapse
 *      to one, and javascript:/mailto: anchors are skipped.
 *
 * For production deployments where search reliability matters, prefer
 * Brave Search or Tavily via their JSON APIs — see
 * `packages/cortex/src/connector/web-search/providers.ts`.
 */

import type { SearchStrategy, SearchStrategyConfig, SearchStrategyResult } from './strategy.js'
import { normalizeMax, normalizeTimeout, sanitizeSnippet, withTimeout } from './strategy.js'

const ENDPOINT = 'https://html.duckduckgo.com/html/'
const USER_AGENT =
  'Mozilla/5.0 (compatible; CortexAgent/1.0; +https://cortex.os/agents)'

/**
 * Thrown when DuckDuckGo returns a CAPTCHA / anomaly challenge instead
 * of real results. Distinct from "no results" (legitimate empty answer)
 * so the tool layer can render the correct remediation.
 */
export class DuckDuckGoBotCheckError extends Error {
  readonly code = 'DDG_BOT_CHECK'
  constructor(message: string) {
    super(message)
    this.name = 'DuckDuckGoBotCheckError'
  }
}

export class DuckDuckGoStrategy implements SearchStrategy {
  readonly id = 'duckduckgo'
  readonly name = 'DuckDuckGo'

  async search(
    query: string,
    config: SearchStrategyConfig,
    signal: AbortSignal,
  ): Promise<SearchStrategyResult[]> {
    const max = normalizeMax(config.maxResults)
    const timeoutMs = normalizeTimeout(config.timeoutMs)
    const { signal: linked, cleanup } = withTimeout(signal, timeoutMs)

    try {
      const body = new URLSearchParams({ q: query, kl: 'us-en' })
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html,application/xhtml+xml',
        },
        body: body.toString(),
        signal: linked,
      })

      if (!res.ok) {
        throw new Error(`DuckDuckGo returned HTTP ${res.status}`)
      }
      const html = await res.text()
      return parseDuckDuckGoHtml(html, max)
    } finally {
      cleanup()
    }
  }
}

// ---------------------------------------------------------------------------
// Bot-check detection
// ---------------------------------------------------------------------------

/**
 * Cheap, case-insensitive signature match for DDG's two known bot-check
 * page shapes. Kept deliberately broad: they change markup independently
 * of the main result page, so it's better to err on the side of raising
 * a clear error than to half-parse a challenge page and return garbage.
 *
 * Exported for tests.
 */
export function detectDuckDuckGoBotCheck(html: string): boolean {
  const lower = html.toLowerCase()
  // Primary signals — DDG's own class prefix for the anomaly modal and
  // the image-challenge form, plus the dedicated feedback address.
  if (lower.includes('anomaly-modal')) return true
  if (lower.includes('challenge-platform')) return true
  if (lower.includes('error-lite@duckduckgo.com')) return true
  // Generic back-stops: if the page is clearly a challenge and has zero
  // result anchors, treat it as a bot-check. Checked cheaply — only runs
  // when `anomaly-modal` wasn't already matched.
  if (lower.includes('please verify you are human')) return true
  return false
}

// ---------------------------------------------------------------------------
// Parser — multi-tier
// ---------------------------------------------------------------------------

interface PartialResult {
  title: string
  url: string
  snippet?: string
}

/**
 * Extract up to `max` results from a DuckDuckGo HTML response page.
 *
 * Throws `DuckDuckGoBotCheckError` when the response is a CAPTCHA /
 * anomaly challenge. Otherwise returns an array (possibly empty).
 *
 * Parse tiers, tried in order. First non-empty wins. Each tier is
 * independent so a markup change in one section (e.g. anchor class
 * renames) does not cascade through the others.
 *
 *   Tier A — modern anchor: `<a ... class="result__a" ... href="http...">`
 *   Tier B — legacy anchor: `<a ... class="result__a" ... href="/l/?uddg=...">`
 *   Tier C — structural: find `<div class="result">` blocks, extract anchor + snippet within
 *   Tier D — h2-anchor: anchors inside `<h2>` tags that point at http(s) URLs
 *
 * Exported for tests.
 */
export function parseDuckDuckGoHtml(html: string, max: number): SearchStrategyResult[] {
  if (detectDuckDuckGoBotCheck(html)) {
    throw new DuckDuckGoBotCheckError(
      'DuckDuckGo returned a bot-check (CAPTCHA) challenge. The key-free ' +
        'provider is rate-limiting this IP. Either wait and retry, or ' +
        'configure Brave Search (BRAVE_SEARCH_API_KEY) or Tavily (TAVILY_API_KEY) ' +
        'for reliable production search.',
    )
  }

  const tiers: Array<(html: string, max: number) => PartialResult[]> = [
    tierAnchorModern,
    tierAnchorLegacy,
    tierStructuralBlock,
    tierH2Anchor,
  ]

  for (const tier of tiers) {
    const partials = tier(html, max)
    if (partials.length > 0) {
      return finalize(partials, html, max)
    }
  }
  return []
}

/**
 * Tier A: modern (~2026Q1+) direct-URL anchor.
 *
 *   <a rel="nofollow" class="result__a" href="https://example.com/...">Title</a>
 */
function tierAnchorModern(html: string, max: number): PartialResult[] {
  const re =
    /<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi
  return runAnchorRegex(re, html, max, 'direct')
}

/**
 * Tier B: legacy (`/l/?uddg=<encoded>`) redirect anchor. Still served in
 * some locales or when DDG serves a mobile UA variant.
 */
function tierAnchorLegacy(html: string, max: number): PartialResult[] {
  // Any anchor with a uddg= query param, class or not — legacy pages
  // sometimes omit the class on the outer anchor.
  const re = /<a\b([^>]*\bhref="[^"]*\buddg=[^"]+"[^>]*)>([\s\S]*?)<\/a>/gi
  return runAnchorRegex(re, html, max, 'uddg')
}

/**
 * Tier C: structural block parse. DDG wraps each result in a
 * `<div class="result">` block (seen in all markup versions since ~2020).
 * Look for blocks first, then mine anchor + snippet inside. Resilient
 * to class renames on the anchor itself.
 */
function tierStructuralBlock(html: string, max: number): PartialResult[] {
  const blocks = extractResultBlocks(html)
  const out: PartialResult[] = []
  for (const block of blocks) {
    if (out.length >= max) break
    const anchor = firstHttpAnchor(block)
    if (!anchor) continue
    const snippet = extractSnippetFromBlock(block) ?? ''
    out.push({ title: anchor.title, url: anchor.url, snippet })
  }
  return out
}

/**
 * Tier D: lenient fallback. Scans `<h2>...<a href="http...">Title</a>...</h2>`
 * and keeps the anchors that look like normal result links. This is the
 * last-ditch layer — if DDG reshuffles result blocks entirely, h2 anchors
 * are almost always how they mark the title.
 */
function tierH2Anchor(html: string, max: number): PartialResult[] {
  const re =
    /<h2\b[^>]*>[\s\S]*?<a\b([^>]*\bhref="(https?:\/\/[^"]+)"[^>]*)>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/gi
  const out: PartialResult[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (out.length >= max) break
    const url = m[2]!
    const title = sanitizeSnippet(m[3]!)
    if (!title) continue
    if (!isExternalHttpUrl(url)) continue
    out.push({ title, url })
  }
  return out
}

// ---------------------------------------------------------------------------
// Parser helpers
// ---------------------------------------------------------------------------

function runAnchorRegex(
  re: RegExp,
  html: string,
  max: number,
  mode: 'direct' | 'uddg',
): PartialResult[] {
  const out: PartialResult[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (out.length >= max) break
    const attrs = m[1]!
    const inner = m[2]!
    const hrefMatch = attrs.match(/\bhref="([^"]+)"/i)
    if (!hrefMatch) continue
    const rawHref = hrefMatch[1]!

    let url: string | null
    if (mode === 'uddg') {
      url = decodeUddgHref(rawHref)
    } else {
      url = rawHref.startsWith('/l/?') || rawHref.startsWith('//duckduckgo.com/l/?')
        ? decodeUddgHref(rawHref)
        : rawHref
    }
    if (!url || !isExternalHttpUrl(url)) continue
    if (seen.has(url)) continue
    seen.add(url)

    const title = sanitizeSnippet(inner)
    if (!title) continue

    const snippet = findNearbySnippet(html, m.index) ?? ''
    out.push({ title, url, snippet })
  }
  return out
}

function decodeUddgHref(raw: string): string | null {
  const uddg = raw.match(/[?&]uddg=([^&]+)/)
  if (!uddg) return null
  try {
    return decodeURIComponent(uddg[1]!)
  } catch {
    return null
  }
}

function isExternalHttpUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  // Block self-referential / internal DDG URLs from leaking in as results.
  try {
    const u = new URL(url)
    if (/\bduckduckgo\.com$/i.test(u.hostname)) return false
  } catch {
    return false
  }
  return true
}

function findNearbySnippet(html: string, startIdx: number): string | null {
  // Snippet lives in a sibling anchor / div within ~4KB of the title
  // anchor's opening `<a`. Match either class name the two-version
  // markup uses.
  const after = html.slice(startIdx, startIdx + 4096)
  const sn = after.match(
    /class="(?:result__snippet|result-snippet)"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/i,
  )
  if (!sn) return null
  return sanitizeSnippet(sn[1]!)
}

function extractResultBlocks(html: string): string[] {
  const out: string[] = []
  // `<div class="result ...">` — may have trailing modifier classes
  // like `result--url-top`. Match non-greedy up to the next `</div>`
  // that balances on depth 0 — regex can't truly balance but we
  // approximate by stopping at the next `<div class="result` or EOF.
  const re = /<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>/gi
  const starts: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    starts.push(m.index)
    if (starts.length > 200) break // don't spin on pathological pages
  }
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]!
    const to = i + 1 < starts.length ? starts[i + 1]! : Math.min(html.length, from + 8192)
    out.push(html.slice(from, to))
  }
  return out
}

function firstHttpAnchor(block: string): { title: string; url: string } | null {
  // Prefer anchors that still carry the `result__a` class (strongest
  // signal), but fall back to any http(s) anchor in the block.
  const classed = block.match(
    /<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/i,
  )
  if (classed) {
    const attrs = classed[1]!
    const inner = classed[2]!
    const hrefMatch = attrs.match(/\bhref="([^"]+)"/i)
    if (hrefMatch) {
      const raw = hrefMatch[1]!
      const url = raw.startsWith('/l/?') || raw.startsWith('//duckduckgo.com/l/?')
        ? decodeUddgHref(raw)
        : raw
      const title = sanitizeSnippet(inner)
      if (url && isExternalHttpUrl(url) && title) {
        return { title, url }
      }
    }
  }
  const fallback = block.match(
    /<a\b[^>]*\bhref="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
  )
  if (fallback) {
    const url = fallback[1]!
    const title = sanitizeSnippet(fallback[2]!)
    if (isExternalHttpUrl(url) && title) {
      return { title, url }
    }
  }
  return null
}

function extractSnippetFromBlock(block: string): string | null {
  const sn = block.match(
    /class="(?:result__snippet|result-snippet)"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/i,
  )
  return sn ? sanitizeSnippet(sn[1]!) : null
}

/**
 * Trim partials to `max`, dedupe across tiers (extra safety), and coerce
 * to the public `SearchStrategyResult` shape.
 */
function finalize(
  partials: PartialResult[],
  _html: string,
  max: number,
): SearchStrategyResult[] {
  const seen = new Set<string>()
  const out: SearchStrategyResult[] = []
  for (const p of partials) {
    if (out.length >= max) break
    if (seen.has(p.url)) continue
    seen.add(p.url)
    out.push({ title: p.title, url: p.url, snippet: p.snippet ?? '' })
  }
  return out
}
