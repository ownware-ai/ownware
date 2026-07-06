/**
 * Live integration tests for the DuckDuckGo search strategy.
 *
 * These tests hit the real `https://html.duckduckgo.com/html/` endpoint
 * and assert that the parser still finds results against CURRENT markup.
 * They exist specifically to catch markup drift — the exact class of bug
 * that slipped into production and returned zero results for every query
 * after DDG silently swapped their anchor shape in early 2026.
 *
 * Skipped by default so CI doesn't depend on outbound internet or get
 * throttled by DDG's bot-check. Run locally / in canary workflows with:
 *
 *   LOOM_SEARCH_LIVE=1 bun run test
 *
 * When DDG serves a CAPTCHA challenge (common from data-center IPs) the
 * parser throws `DuckDuckGoBotCheckError`. We treat that as "inconclusive,
 * not failing" rather than a test failure — the parser behaved correctly,
 * the network just couldn't verify the happy path. A sustained streak of
 * bot-checks in a canary environment is what paging thresholds are for,
 * not unit tests.
 */

import { describe, it, expect } from 'vitest'
import {
  DuckDuckGoStrategy,
  DuckDuckGoBotCheckError,
} from '../../tools/search/duckduckgo.js'

const LIVE = process.env.LOOM_SEARCH_LIVE === '1'

describe.skipIf(!LIVE)('DuckDuckGoStrategy (live)', () => {
  /**
   * Generic stable query. "mozilla firefox" has results that have existed
   * for decades and appear in every locale, so a zero-result response
   * indicates a real parser or endpoint regression, not query drift.
   */
  it('returns at least 3 http(s) results for a stable query', async () => {
    const strat = new DuckDuckGoStrategy()
    let results
    try {
      results = await strat.search(
        'mozilla firefox',
        { maxResults: 5, timeoutMs: 15_000 },
        new AbortController().signal,
      )
    } catch (err) {
      if (err instanceof DuckDuckGoBotCheckError) {
        // Bot-check from this IP. Not a test failure — the strategy did
        // the right thing by raising, and the real happy path just can't
        // be exercised from here right now.
        console.warn('[ddg-live] bot-check returned; parser behaved correctly, happy path not exercised')
        return
      }
      throw err
    }

    expect(results.length).toBeGreaterThanOrEqual(3)
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//)
      expect(r.title.length).toBeGreaterThan(0)
      // URL must not self-reference DDG (guards against nav/footer leaks).
      expect(r.url).not.toMatch(/\bduckduckgo\.com/i)
    }

    // At least one result should have a non-empty snippet — DDG populates
    // these on essentially every standard query. A systemic empty-snippet
    // regression is still a regression.
    const withSnippet = results.filter(r => r.snippet.length > 0)
    expect(withSnippet.length).toBeGreaterThan(0)
  }, 30_000)

  /**
   * Query-specific sanity check: a major domain SHOULD appear somewhere in
   * the top results. Guards against the parser returning well-formed but
   * wrong-page results (e.g. parsing a sidebar instead of the main column).
   */
  it('includes mozilla.org among top results for "mozilla firefox"', async () => {
    const strat = new DuckDuckGoStrategy()
    let results
    try {
      results = await strat.search(
        'mozilla firefox',
        { maxResults: 10, timeoutMs: 15_000 },
        new AbortController().signal,
      )
    } catch (err) {
      if (err instanceof DuckDuckGoBotCheckError) {
        console.warn('[ddg-live] bot-check returned; skipping content-shape assertion')
        return
      }
      throw err
    }

    const hasMozilla = results.some(r => /\bmozilla\.org\b/i.test(r.url))
    expect(hasMozilla).toBe(true)
  }, 30_000)

  /**
   * maxResults cap is respected against real responses. DDG returns 10
   * results per page; asking for 3 must yield exactly ≤ 3.
   */
  it('respects maxResults against the real endpoint', async () => {
    const strat = new DuckDuckGoStrategy()
    let results
    try {
      results = await strat.search(
        'mozilla firefox',
        { maxResults: 3, timeoutMs: 15_000 },
        new AbortController().signal,
      )
    } catch (err) {
      if (err instanceof DuckDuckGoBotCheckError) {
        console.warn('[ddg-live] bot-check returned; skipping cap assertion')
        return
      }
      throw err
    }
    expect(results.length).toBeLessThanOrEqual(3)
  }, 30_000)
})
