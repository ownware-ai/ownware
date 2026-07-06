/**
 * Unit tests for search ProviderStrategy implementations.
 *
 * Mocks global `fetch` per test. Covers: success, empty, 401/403, 429, 5xx,
 * timeout, malformed JSON/HTML.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  DuckDuckGoStrategy,
  DuckDuckGoBotCheckError,
  parseDuckDuckGoHtml,
  detectDuckDuckGoBotCheck,
} from '../duckduckgo.js'
import { BraveStrategy } from '../brave.js'
import { TavilyStrategy } from '../tavily.js'
import { sanitizeSnippet, normalizeMax, normalizeTimeout } from '../strategy.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchMock = ReturnType<typeof vi.fn>

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): FetchMock {
  const fn = vi.fn(impl) as unknown as FetchMock
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

const DDG_HTML_SAMPLE = `
  <html><body>
    <div class="result">
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Example A</a>
      <a class="result__snippet" href="https://example.com/a">A snippet about <b>examples</b></a>
    </div>
    <div class="result">
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fb&rut=x">Example B</a>
      <a class="result__snippet" href="https://example.com/b">B snippet &amp; more</a>
    </div>
  </body></html>
`

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

describe('sanitizeSnippet', () => {
  it('strips tags and decodes entities', () => {
    expect(sanitizeSnippet('Hello <b>world</b> &amp; friends')).toBe('Hello world & friends')
  })
  it('returns empty on empty input', () => {
    expect(sanitizeSnippet('')).toBe('')
  })
  it('truncates to 500 chars', () => {
    const long = 'x'.repeat(600)
    const out = sanitizeSnippet(long)
    expect(out.length).toBeLessThanOrEqual(500)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('normalize helpers', () => {
  it('normalizeMax caps at 20 and floors defaults', () => {
    expect(normalizeMax(undefined)).toBe(5)
    expect(normalizeMax(100)).toBe(20)
    expect(normalizeMax(0)).toBe(5)
    expect(normalizeMax(-3)).toBe(5)
  })
  it('normalizeTimeout caps at 30000', () => {
    expect(normalizeTimeout(undefined)).toBe(10_000)
    expect(normalizeTimeout(999_999)).toBe(30_000)
  })
})

// ---------------------------------------------------------------------------
// DuckDuckGo
// ---------------------------------------------------------------------------

describe('DuckDuckGoStrategy', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('parses HTML result page', async () => {
    mockFetch(async () => new Response(DDG_HTML_SAMPLE, { status: 200 }))
    const strat = new DuckDuckGoStrategy()
    const out = await strat.search('examples', { maxResults: 5 }, new AbortController().signal)
    expect(out.length).toBe(2)
    expect(out[0]?.url).toBe('https://example.com/a')
    expect(out[0]?.title).toBe('Example A')
    expect(out[0]?.snippet).toContain('examples')
    expect(out[1]?.url).toBe('https://example.com/b')
    expect(out[1]?.snippet).toBe('B snippet & more')
  })

  it('returns [] on genuinely empty (no matches) HTML', async () => {
    // No result markers at all — a truly empty result page.
    mockFetch(async () => new Response('<html><body>No results match your search.</body></html>', { status: 200 }))
    const out = await new DuckDuckGoStrategy().search('x', {}, new AbortController().signal)
    expect(out).toEqual([])
  })

  it('throws DuckDuckGoBotCheckError on anomaly / CAPTCHA challenge pages', async () => {
    // Signature from the real DDG "lite" CAPTCHA page — image challenge modal.
    const captchaHtml = `
      <html><body>
        <div class="anomaly-modal">
          <div class="anomaly-modal__box"></div>
          <p>error-lite@duckduckgo.com</p>
        </div>
      </body></html>
    `
    mockFetch(async () => new Response(captchaHtml, { status: 200 }))
    await expect(
      new DuckDuckGoStrategy().search('x', {}, new AbortController().signal),
    ).rejects.toBeInstanceOf(DuckDuckGoBotCheckError)
  })

  it('throws bot-check on cloud-challenge (challenge-platform) pages', async () => {
    const html = `<html><script src="/cdn-cgi/challenge-platform/h/b/pat.js"></script></html>`
    mockFetch(async () => new Response(html, { status: 200 }))
    await expect(
      new DuckDuckGoStrategy().search('x', {}, new AbortController().signal),
    ).rejects.toBeInstanceOf(DuckDuckGoBotCheckError)
  })

  it('throws bot-check on "please verify you are human" pages', async () => {
    const html = `<html><body>Please verify you are human.</body></html>`
    mockFetch(async () => new Response(html, { status: 200 }))
    await expect(
      new DuckDuckGoStrategy().search('x', {}, new AbortController().signal),
    ).rejects.toBeInstanceOf(DuckDuckGoBotCheckError)
  })

  it('throws on 5xx', async () => {
    mockFetch(async () => new Response('server error', { status: 503 }))
    await expect(
      new DuckDuckGoStrategy().search('x', {}, new AbortController().signal),
    ).rejects.toThrow(/503/)
  })

  it('throws on 4xx', async () => {
    mockFetch(async () => new Response('bad', { status: 400 }))
    await expect(
      new DuckDuckGoStrategy().search('x', {}, new AbortController().signal),
    ).rejects.toThrow(/400/)
  })

  it('respects maxResults bound', async () => {
    const many = '<div>' + Array.from({ length: 30 }, (_, i) =>
      `<a class="result__a" href="/l/?uddg=${encodeURIComponent(`https://e.com/${i}`)}">T${i}</a>`,
    ).join('') + '</div>'
    mockFetch(async () => new Response(many, { status: 200 }))
    const out = await new DuckDuckGoStrategy().search('x', { maxResults: 3 }, new AbortController().signal)
    expect(out.length).toBe(3)
  })

  it('times out', async () => {
    mockFetch(async (_url, init) => {
      const sig = init?.signal as AbortSignal
      return new Promise<Response>((_resolve, reject) => {
        sig.addEventListener('abort', () => reject(sig.reason ?? new Error('aborted')))
      })
    })
    await expect(
      new DuckDuckGoStrategy().search('x', { timeoutMs: 10 }, new AbortController().signal),
    ).rejects.toBeTruthy()
  })

  it('parseDuckDuckGoHtml dedupes URLs (legacy uddg= format)', () => {
    // DDG's result anchors always carry class="result__a" — the parser
    // anchors on the class, then extracts the href (redirect or direct).
    const html =
      `<a class="result__a" href="/l/?uddg=https%3A%2F%2Fex.com%2F">A</a>` +
      `<a class="result__a" href="/l/?uddg=https%3A%2F%2Fex.com%2F">A2</a>`
    const out = parseDuckDuckGoHtml(html, 10)
    expect(out.length).toBe(1)
  })

  // ── Format drift coverage ──────────────────────────────────────────
  //
  // DDG switched from `/l/?uddg=<encoded>` redirect hrefs to direct
  // URL hrefs in early 2026. The parser accepts both so a subsequent
  // swap back (some locales still see the old form) does not brick the
  // default provider again.

  it('parses the modern direct-URL format (2026+)', () => {
    const html = `
      <div class="result">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="https://example.com/product/widget">Example Widget</a>
        </h2>
        <a class="result__snippet" href="https://example.com/product/widget">A fictional example product.</a>
      </div>
      <div class="result">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="https://github.com/example/widget">GitHub - example/widget</a>
        </h2>
        <a class="result__snippet" href="https://github.com/example/widget">The open-source repo.</a>
      </div>
    `
    const out = parseDuckDuckGoHtml(html, 5)
    expect(out.length).toBe(2)
    expect(out[0]?.url).toBe('https://example.com/product/widget')
    expect(out[0]?.title).toBe('Example Widget')
    expect(out[0]?.snippet).toContain('fictional example product')
    expect(out[1]?.url).toBe('https://github.com/example/widget')
  })

  it('handles attribute reordering (href before class)', () => {
    // Real DDG always emits `rel="nofollow" class="result__a" href=...`,
    // but the parser must not depend on that ordering.
    const html =
      `<a href="https://a.example.com" rel="nofollow" class="result__a">A</a>`
    const out = parseDuckDuckGoHtml(html, 5)
    expect(out.length).toBe(1)
    expect(out[0]?.url).toBe('https://a.example.com')
  })

  it('dedupes when the new and legacy formats both appear', () => {
    // DDG has (very briefly, mid-rollout) served pages with both shapes
    // pointing at the same target. Result must appear once.
    const html =
      `<a class="result__a" href="https://ex.com/x">Direct</a>` +
      `<a class="result__a" href="/l/?uddg=${encodeURIComponent('https://ex.com/x')}">Redirect</a>`
    const out = parseDuckDuckGoHtml(html, 5)
    expect(out.length).toBe(1)
    expect(out[0]?.url).toBe('https://ex.com/x')
  })

  it('skips non-http(s) hrefs', () => {
    // Paranoid guard: the "direct" path now accepts any href that
    // passes the class filter. Reject mailto:, javascript:, etc.
    const html =
      `<a class="result__a" href="javascript:alert(1)">XSS attempt</a>` +
      `<a class="result__a" href="mailto:x@example.com">Mail</a>` +
      `<a class="result__a" href="https://ok.example.com">OK</a>`
    const out = parseDuckDuckGoHtml(html, 5)
    expect(out.length).toBe(1)
    expect(out[0]?.url).toBe('https://ok.example.com')
  })

  it('skips internal duckduckgo.com anchors (self-referential leak guard)', () => {
    // Navigation/footer anchors to DDG itself must not surface as results.
    const html =
      `<a class="result__a" href="https://duckduckgo.com/settings">Settings</a>` +
      `<a class="result__a" href="https://real.example.com">Real</a>`
    const out = parseDuckDuckGoHtml(html, 5)
    expect(out.length).toBe(1)
    expect(out[0]?.url).toBe('https://real.example.com')
  })

  // ── Parser resilience: multi-tier fallbacks ────────────────────────
  //
  // Tiers A (modern) and B (legacy) cover the common DDG shapes. Tiers
  // C and D catch markup drift where the anchor class was renamed or
  // removed entirely. Verifies each tier wins independently so a future
  // markup change in one section does not brick the others.

  it('falls back to structural-block tier when the anchor class is renamed', () => {
    // Anchor class is `result__link` instead of `result__a` — Tiers A and
    // B both miss. The surrounding `<div class="result">` block is still
    // there, so the structural tier finds the anchor and snippet.
    const html = `
      <div class="result">
        <a rel="nofollow" class="result__link" href="https://drift.example.com/page">Drift Title</a>
        <span class="result__snippet">Snippet text after a class rename.</span>
      </div>
    `
    const out = parseDuckDuckGoHtml(html, 5)
    expect(out.length).toBe(1)
    expect(out[0]?.url).toBe('https://drift.example.com/page')
    expect(out[0]?.title).toBe('Drift Title')
    expect(out[0]?.snippet).toContain('after a class rename')
  })

  it('falls back to h2-anchor tier when both the class AND block wrapper change', () => {
    // Neither `result__a` nor `<div class="result">` present. Only the
    // title-in-h2 idiom remains. Last-ditch tier catches it.
    const html = `
      <article class="card">
        <h2><a href="https://last.example.com/a">Last-Ditch A</a></h2>
      </article>
      <article class="card">
        <h2><a href="https://last.example.com/b">Last-Ditch B</a></h2>
      </article>
    `
    const out = parseDuckDuckGoHtml(html, 5)
    expect(out.length).toBe(2)
    expect(out[0]?.url).toBe('https://last.example.com/a')
    expect(out[1]?.title).toBe('Last-Ditch B')
  })

  it('early tiers win when multiple tiers would match', () => {
    // Block wrapper present AND modern anchor present — modern (Tier A)
    // must take precedence so snippets come through correctly.
    const html = `
      <div class="result">
        <a class="result__a" href="https://modern.example.com">Modern</a>
        <a class="result__snippet" href="https://modern.example.com">Modern snippet</a>
      </div>
    `
    const out = parseDuckDuckGoHtml(html, 5)
    expect(out.length).toBe(1)
    expect(out[0]?.snippet).toContain('Modern snippet')
  })

  // ── Bot-check helper direct tests ──────────────────────────────────

  it('detectDuckDuckGoBotCheck flags anomaly-modal pages', () => {
    expect(detectDuckDuckGoBotCheck('<div class="anomaly-modal">…</div>')).toBe(true)
  })

  it('detectDuckDuckGoBotCheck flags challenge-platform pages', () => {
    expect(
      detectDuckDuckGoBotCheck('<script src="/cdn-cgi/challenge-platform/h/b.js"></script>'),
    ).toBe(true)
  })

  it('detectDuckDuckGoBotCheck does NOT flag a normal result page', () => {
    expect(
      detectDuckDuckGoBotCheck(
        '<div class="result"><a class="result__a" href="https://x.com">T</a></div>',
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Brave
// ---------------------------------------------------------------------------

describe('BraveStrategy', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('returns results on 200', async () => {
    mockFetch(async () => jsonResponse({
      web: { results: [
        { title: 'T1', url: 'https://a.com', description: 'd1' },
        { title: 'T2', url: 'https://b.com', description: 'd<i>2</i>' },
      ] },
    }))
    const out = await new BraveStrategy().search('q', { apiKey: 'k', maxResults: 5 }, new AbortController().signal)
    expect(out.length).toBe(2)
    expect(out[1]?.snippet).toBe('d2')
  })

  it('throws when no apiKey is supplied', async () => {
    await expect(
      new BraveStrategy().search('q', {}, new AbortController().signal),
    ).rejects.toThrow(/API key/)
  })

  it('maps 401 → rejected key error', async () => {
    mockFetch(async () => new Response('no', { status: 401 }))
    await expect(
      new BraveStrategy().search('q', { apiKey: 'bad' }, new AbortController().signal),
    ).rejects.toThrow(/rejected/i)
  })

  it('maps 429 → rate limit error', async () => {
    mockFetch(async () => new Response('slow down', { status: 429 }))
    await expect(
      new BraveStrategy().search('q', { apiKey: 'k' }, new AbortController().signal),
    ).rejects.toThrow(/rate limit/i)
  })

  it('maps 5xx → generic error', async () => {
    mockFetch(async () => new Response('bad', { status: 502 }))
    await expect(
      new BraveStrategy().search('q', { apiKey: 'k' }, new AbortController().signal),
    ).rejects.toThrow(/502/)
  })

  it('maps malformed JSON → parse error', async () => {
    mockFetch(async () => new Response('not json', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    await expect(
      new BraveStrategy().search('q', { apiKey: 'k' }, new AbortController().signal),
    ).rejects.toThrow(/malformed/i)
  })

  it('returns [] on empty results', async () => {
    mockFetch(async () => jsonResponse({ web: { results: [] } }))
    const out = await new BraveStrategy().search('q', { apiKey: 'k' }, new AbortController().signal)
    expect(out).toEqual([])
  })

  it('filters non-http URLs', async () => {
    mockFetch(async () => jsonResponse({
      web: { results: [
        { title: 'ok', url: 'https://a.com' },
        { title: 'bad', url: 'javascript:alert(1)' },
      ] },
    }))
    const out = await new BraveStrategy().search('q', { apiKey: 'k' }, new AbortController().signal)
    expect(out.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Tavily
// ---------------------------------------------------------------------------

describe('TavilyStrategy', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('returns results on 200', async () => {
    mockFetch(async () => jsonResponse({
      results: [
        { title: 'T1', url: 'https://a.com', content: 'c1' },
        { title: 'T2', url: 'https://b.com', content: 'c2' },
      ],
    }))
    const out = await new TavilyStrategy().search('q', { apiKey: 'k' }, new AbortController().signal)
    expect(out.length).toBe(2)
  })

  it('throws without apiKey', async () => {
    await expect(
      new TavilyStrategy().search('q', {}, new AbortController().signal),
    ).rejects.toThrow(/API key/)
  })

  it('handles 401, 429, 5xx, malformed', async () => {
    mockFetch(async () => new Response('', { status: 403 }))
    await expect(new TavilyStrategy().search('q', { apiKey: 'x' }, new AbortController().signal))
      .rejects.toThrow(/rejected/i)

    mockFetch(async () => new Response('', { status: 429 }))
    await expect(new TavilyStrategy().search('q', { apiKey: 'x' }, new AbortController().signal))
      .rejects.toThrow(/rate limit/i)

    mockFetch(async () => new Response('', { status: 500 }))
    await expect(new TavilyStrategy().search('q', { apiKey: 'x' }, new AbortController().signal))
      .rejects.toThrow(/500/)

    mockFetch(async () => new Response('not json', { status: 200 }))
    await expect(new TavilyStrategy().search('q', { apiKey: 'x' }, new AbortController().signal))
      .rejects.toThrow(/malformed/i)
  })

  it('returns [] on empty results', async () => {
    mockFetch(async () => jsonResponse({ results: [] }))
    const out = await new TavilyStrategy().search('q', { apiKey: 'k' }, new AbortController().signal)
    expect(out).toEqual([])
  })
})
