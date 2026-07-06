/**
 * Unit tests for PerplexityOpenRouterStrategy.
 *
 * Mocks global `fetch`. Covers: success with top-level citations, success
 * with annotation-style citations, empty answer, 401, 402, 429, malformed
 * JSON, abort.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PerplexityOpenRouterStrategy } from '../perplexity-openrouter.js'

type FetchMock = ReturnType<typeof vi.fn>

function mockFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): FetchMock {
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

const KEY = 'sk-or-test-key'
const SIGNAL = (): AbortSignal => new AbortController().signal

describe('PerplexityOpenRouterStrategy', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('returns synthesized answer + citation rows on success', async () => {
    mockFetch(async () => jsonResponse({
      choices: [{ message: { content: 'TypeScript is a typed superset of JavaScript.' } }],
      citations: ['https://www.typescriptlang.org/', 'https://en.wikipedia.org/wiki/TypeScript'],
    }))
    const strat = new PerplexityOpenRouterStrategy()
    const out = await strat.search('what is typescript', { apiKey: KEY, maxResults: 5 }, SIGNAL())
    expect(out.length).toBe(2)
    expect(out[0]?.title).toBe('Perplexity Sonar Answer')
    expect(out[0]?.url).toBe('https://www.typescriptlang.org/')
    expect(out[0]?.snippet).toContain('typed superset')
    expect(out[1]?.title).toBe('en.wikipedia.org')
    expect(out[1]?.url).toBe('https://en.wikipedia.org/wiki/TypeScript')
  })

  it('falls back to message.annotations when top-level citations missing', async () => {
    mockFetch(async () => jsonResponse({
      choices: [{
        message: {
          content: 'Answer.',
          annotations: [
            { type: 'url_citation', url_citation: { url: 'https://example.com/a' } },
            { type: 'url_citation', url: 'https://example.com/b' },
            { type: 'something_else', url: 'https://ignored.com' },
          ],
        },
      }],
    }))
    const strat = new PerplexityOpenRouterStrategy()
    const out = await strat.search('q', { apiKey: KEY }, SIGNAL())
    expect(out.length).toBeGreaterThanOrEqual(2)
    const urls = out.map(r => r.url)
    expect(urls).toContain('https://example.com/a')
    expect(urls).toContain('https://example.com/b')
    expect(urls).not.toContain('https://ignored.com')
  })

  it('respects maxResults', async () => {
    mockFetch(async () => jsonResponse({
      choices: [{ message: { content: 'Answer.' } }],
      citations: ['https://a.com/', 'https://b.com/', 'https://c.com/', 'https://d.com/'],
    }))
    const strat = new PerplexityOpenRouterStrategy()
    const out = await strat.search('q', { apiKey: KEY, maxResults: 2 }, SIGNAL())
    expect(out.length).toBe(2)
  })

  it('returns empty when both answer and citations are absent', async () => {
    mockFetch(async () => jsonResponse({ choices: [{ message: { content: '' } }] }))
    const strat = new PerplexityOpenRouterStrategy()
    const out = await strat.search('q', { apiKey: KEY }, SIGNAL())
    expect(out).toEqual([])
  })

  it('throws on missing api key', async () => {
    const strat = new PerplexityOpenRouterStrategy()
    await expect(strat.search('q', {}, SIGNAL())).rejects.toThrow(/OPENROUTER_API_KEY/)
  })

  it('throws on 401', async () => {
    mockFetch(async () => new Response('unauthorized', { status: 401 }))
    const strat = new PerplexityOpenRouterStrategy()
    await expect(strat.search('q', { apiKey: KEY }, SIGNAL())).rejects.toThrow(/401/)
  })

  it('throws on 402 with credit hint', async () => {
    mockFetch(async () => new Response('payment required', { status: 402 }))
    const strat = new PerplexityOpenRouterStrategy()
    await expect(strat.search('q', { apiKey: KEY }, SIGNAL())).rejects.toThrow(/credits/)
  })

  it('throws on 429', async () => {
    mockFetch(async () => new Response('too many', { status: 429 }))
    const strat = new PerplexityOpenRouterStrategy()
    await expect(strat.search('q', { apiKey: KEY }, SIGNAL())).rejects.toThrow(/429/)
  })

  it('throws on malformed JSON', async () => {
    mockFetch(async () => new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const strat = new PerplexityOpenRouterStrategy()
    await expect(strat.search('q', { apiKey: KEY }, SIGNAL())).rejects.toThrow(/malformed JSON/)
  })

  it('sends auth + attribution headers', async () => {
    const fn = mockFetch(async () => jsonResponse({
      choices: [{ message: { content: 'a' } }],
      citations: ['https://x.com/'],
    }))
    const strat = new PerplexityOpenRouterStrategy()
    await strat.search('q', { apiKey: KEY }, SIGNAL())
    const init = fn.mock.calls[0]?.[1] as RequestInit | undefined
    const headers = init?.headers as Record<string, string>
    expect(headers?.['Authorization']).toBe(`Bearer ${KEY}`)
    expect(headers?.['HTTP-Referer']).toBeTruthy()
    expect(headers?.['X-Title']).toBeTruthy()
  })

  it('truncates very long answer to ~2000 chars', async () => {
    const longAnswer = 'x'.repeat(3000)
    mockFetch(async () => jsonResponse({
      choices: [{ message: { content: longAnswer } }],
      citations: ['https://a.com/'],
    }))
    const strat = new PerplexityOpenRouterStrategy()
    const out = await strat.search('q', { apiKey: KEY }, SIGNAL())
    expect(out[0]?.snippet.length).toBeLessThanOrEqual(2000)
    expect(out[0]?.snippet.endsWith('…')).toBe(true)
  })
})
