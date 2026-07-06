/**
 * ComposioCatalogCache.listPage — per-page cache + concurrent-coalesce.
 *
 * The full-walk path (`listToolkits`) is exercised by the source tests;
 * this file pins the new paginated path used by the Add Tool modal's
 * `/api/v1/connectors?source=composio` branch.
 */

import { describe, it, expect, vi } from 'vitest'
import { ComposioCatalogCache } from '../../../../src/connector/composio/catalog-cache.js'
import type { ComposioClient, ListToolkitsParams } from '../../../../src/connector/composio/client.js'
import type { ComposioToolkitSummary } from '../../../../src/connector/composio/client.js'

function fakeSummary(slug: string): ComposioToolkitSummary {
  return {
    slug,
    name: slug,
    meta: { categories: [], description: '', logo: null },
  } as unknown as ComposioToolkitSummary
}

function fakeClient(opts: {
  pages: ReadonlyArray<{
    items: readonly ComposioToolkitSummary[]
    next_cursor: string | null
  }>
  recorded?: ListToolkitsParams[]
  delayMs?: number
}): ComposioClient {
  let call = 0
  return {
    async listToolkits(params: ListToolkitsParams = {}) {
      opts.recorded?.push(params)
      const idx = Math.min(call, opts.pages.length - 1)
      call++
      const page = opts.pages[idx]!
      if (opts.delayMs !== undefined) {
        await new Promise((r) => setTimeout(r, opts.delayMs))
      }
      return {
        items: page.items as ComposioToolkitSummary[],
        next_cursor: page.next_cursor,
      }
    },
  } as unknown as ComposioClient
}

describe('ComposioCatalogCache.listPage', () => {
  it('returns the first page when called with no params', async () => {
    const recorded: ListToolkitsParams[] = []
    const cache = new ComposioCatalogCache({
      client: fakeClient({
        pages: [{ items: [fakeSummary('notion'), fakeSummary('slack')], next_cursor: 'c1' }],
        recorded,
      }),
    })
    const page = await cache.listPage()
    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).toBe('c1')
    // Default limit is the cache's configured pageSize (100).
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.limit).toBe(100)
    expect(recorded[0]?.cursor).toBeUndefined()
    expect(recorded[0]?.search).toBeUndefined()
  })

  it('forwards search + cursor + limit to the client', async () => {
    const recorded: ListToolkitsParams[] = []
    const cache = new ComposioCatalogCache({
      client: fakeClient({
        pages: [{ items: [fakeSummary('gmail')], next_cursor: null }],
        recorded,
      }),
    })
    await cache.listPage({ search: 'gma', cursor: 'opaque', limit: 25 })
    expect(recorded[0]).toEqual({ search: 'gma', cursor: 'opaque', limit: 25 })
  })

  it('caches per { search, cursor, limit } key — second hit makes no client call', async () => {
    const recorded: ListToolkitsParams[] = []
    const cache = new ComposioCatalogCache({
      client: fakeClient({
        pages: [{ items: [fakeSummary('notion')], next_cursor: 'c1' }],
        recorded,
      }),
    })
    await cache.listPage({ search: 'no', limit: 10 })
    await cache.listPage({ search: 'no', limit: 10 })
    expect(recorded).toHaveLength(1)
  })

  it('different keys do not share cache — distinct calls hit the client', async () => {
    const recorded: ListToolkitsParams[] = []
    const cache = new ComposioCatalogCache({
      client: fakeClient({
        pages: [
          { items: [fakeSummary('notion')], next_cursor: null },
          { items: [fakeSummary('slack')], next_cursor: null },
        ],
        recorded,
      }),
    })
    await cache.listPage({ search: 'no' })
    await cache.listPage({ search: 'sl' })
    expect(recorded).toHaveLength(2)
  })

  it('coalesces concurrent fetches for the same key into one client call', async () => {
    const recorded: ListToolkitsParams[] = []
    const cache = new ComposioCatalogCache({
      client: fakeClient({
        pages: [{ items: [fakeSummary('notion')], next_cursor: null }],
        recorded,
        delayMs: 30,
      }),
    })
    const [a, b, c] = await Promise.all([
      cache.listPage({ search: 'no' }),
      cache.listPage({ search: 'no' }),
      cache.listPage({ search: 'no' }),
    ])
    expect(a.items).toHaveLength(1)
    expect(b.items).toHaveLength(1)
    expect(c.items).toHaveLength(1)
    expect(recorded).toHaveLength(1)
  })

  it('cache expiry: a re-fetch after the TTL hits the client again', async () => {
    const recorded: ListToolkitsParams[] = []
    let nowMs = 1_000_000
    const cache = new ComposioCatalogCache({
      client: fakeClient({
        pages: [
          { items: [fakeSummary('notion')], next_cursor: null },
          { items: [fakeSummary('notion-v2')], next_cursor: null },
        ],
        recorded,
      }),
      ttlMs: 60_000,
      now: () => nowMs,
    })
    await cache.listPage({ search: 'no' })
    nowMs += 70_000 // past the 60s TTL
    await cache.listPage({ search: 'no' })
    expect(recorded).toHaveLength(2)
  })

  it('upstream error returns an empty page (does not throw)', async () => {
    const cache = new ComposioCatalogCache({
      client: {
        listToolkits: vi.fn(async () => {
          throw new Error('Composio 503')
        }),
      } as unknown as ComposioClient,
    })
    const page = await cache.listPage({ search: 'gma' })
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  it('invalidate() clears the per-page cache', async () => {
    const recorded: ListToolkitsParams[] = []
    const cache = new ComposioCatalogCache({
      client: fakeClient({
        pages: [
          { items: [fakeSummary('notion')], next_cursor: null },
          { items: [fakeSummary('notion')], next_cursor: null },
        ],
        recorded,
      }),
    })
    await cache.listPage({ search: 'no' })
    cache.invalidate()
    await cache.listPage({ search: 'no' })
    expect(recorded).toHaveLength(2)
  })
})

describe('ComposioCatalogCache.listToolkits — stale-while-revalidate', () => {
  const slugs = (a: readonly ComposioToolkitSummary[]) => a.map((t) => t.slug)

  it('warm() populates; reads then serve from cache without another walk', async () => {
    const recorded: ListToolkitsParams[] = []
    const cache = new ComposioCatalogCache({
      client: fakeClient({ pages: [{ items: [fakeSummary('notion')], next_cursor: null }], recorded }),
      now: () => 1_000,
    })
    await cache.warm()
    expect(slugs(await cache.listToolkits())).toEqual(['notion'])
    expect(slugs(await cache.listToolkits())).toEqual(['notion'])
    expect(recorded).toHaveLength(1) // only the warm walk
  })

  it('serves the LAST-GOOD list immediately when stale, then refreshes in the background', async () => {
    const recorded: ListToolkitsParams[] = []
    let nowMs = 1_000_000
    const cache = new ComposioCatalogCache({
      client: fakeClient({
        pages: [
          { items: [fakeSummary('notion')], next_cursor: null },
          { items: [fakeSummary('notion'), fakeSummary('slack')], next_cursor: null },
        ],
        recorded,
      }),
      ttlMs: 60_000,
      now: () => nowMs,
    })
    await cache.warm() // walk #1 → [notion]
    nowMs += 70_000 // expire
    // Stale read returns the OLD list immediately — never blocks on Composio.
    expect(slugs(await cache.listToolkits())).toEqual(['notion'])
    await new Promise((r) => setTimeout(r, 0)) // let the bg refresh settle
    expect(slugs(await cache.listToolkits())).toEqual(['notion', 'slack'])
    expect(recorded).toHaveLength(2)
  })

  it('does NOT clobber a good catalogue with an empty/failed walk', async () => {
    const recorded: ListToolkitsParams[] = []
    let nowMs = 1_000_000
    const cache = new ComposioCatalogCache({
      client: fakeClient({
        pages: [
          { items: [fakeSummary('notion'), fakeSummary('slack')], next_cursor: null },
          { items: [], next_cursor: null }, // simulated failed/empty walk
        ],
        recorded,
      }),
      ttlMs: 60_000,
      now: () => nowMs,
    })
    await cache.warm() // good: [notion, slack]
    nowMs += 70_000
    expect(await cache.listToolkits()).toHaveLength(2) // serves last-good
    await new Promise((r) => setTimeout(r, 0)) // bg refresh returns empty
    expect(await cache.listToolkits()).toHaveLength(2) // KEPT, not clobbered to empty
  })

  it('invalidate() serves last-good immediately (no blocking cold walk)', async () => {
    const recorded: ListToolkitsParams[] = []
    const cache = new ComposioCatalogCache({
      client: fakeClient({
        pages: [{ items: [fakeSummary('notion'), fakeSummary('slack')], next_cursor: null }],
        recorded,
      }),
      now: () => 2_000,
    })
    await cache.warm()
    cache.invalidate()
    expect(await cache.listToolkits()).toHaveLength(2) // stale → last-good, instant
  })
})
