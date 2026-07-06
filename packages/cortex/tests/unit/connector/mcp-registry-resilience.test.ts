/**
 * Registry walk resilience (BUGS #15, 2026-07-03).
 *
 * The public registry outgrew all-or-nothing walking (12k+ servers).
 * These tests pin the hardened behaviour:
 *   - a mid-walk page failure returns the pages already fetched
 *     (partial) instead of throwing everything away;
 *   - each page gets exactly one retry before the walk gives up;
 *   - a partial catalog is cached with a SHORT retry window, not the
 *     full TTL;
 *   - `getRegistryEntry` never triggers a full walk: cache hit first
 *     (any freshness), then ONE targeted `?search=` fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fetchMCPRegistry,
  getRegistryEntry,
  clearRegistryCache,
  clearDiskRegistryCache,
} from '../../../src/connector/mcp/registry.js'

let tempDir: string
let originalEnv: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mcp-registry-resilience-'))
  originalEnv = process.env['OWNWARE_REGISTRY_CACHE_PATH']
  process.env['OWNWARE_REGISTRY_CACHE_PATH'] = join(tempDir, 'cache.json')
  clearRegistryCache()
  // The per-page retry pauses 2s between attempts — collapse timers so
  // failure-path tests stay fast.
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(async () => {
  vi.useRealTimers()
  await clearDiskRegistryCache()
  clearRegistryCache()
  rmSync(tempDir, { recursive: true, force: true })
  if (originalEnv === undefined) delete process.env['OWNWARE_REGISTRY_CACHE_PATH']
  else process.env['OWNWARE_REGISTRY_CACHE_PATH'] = originalEnv
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function page(
  names: readonly string[],
  nextCursor?: string,
): Response {
  const body = {
    servers: names.map((name) => ({
      server: { name, title: name, description: 'stub', version: '1.0.0' },
    })),
    metadata: nextCursor ? { nextCursor } : {},
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('partial walks', () => {
  it('a mid-walk failure keeps the pages already fetched', async () => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++
      if (call === 1) return page(['a.vendor/one', 'a.vendor/two'], 'cursor-2')
      // Page 2 fails on the first attempt AND its retry.
      return new Response('upstream sad', { status: 503 })
    }))

    const promise = fetchMCPRegistry()
    await vi.advanceTimersByTimeAsync(3_000) // cover the retry pause
    const entries = await promise

    expect(entries.map((e) => e.id)).toEqual(['a.vendor/one', 'a.vendor/two'])
  })

  it('retries a failed page once and continues when the retry succeeds', async () => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++
      if (call === 1) return page(['a.vendor/one'], 'cursor-2')
      if (call === 2) return new Response('blip', { status: 500 }) // page 2, attempt 1
      if (call === 3) return page(['b.vendor/two']) // page 2, retry succeeds
      throw new Error(`unexpected call ${call}`)
    }))

    const promise = fetchMCPRegistry()
    await vi.advanceTimersByTimeAsync(3_000)
    const entries = await promise

    expect(entries.map((e) => e.id)).toEqual(['a.vendor/one', 'b.vendor/two'])
    expect(call).toBe(3)
  })

  it('a first-page failure still throws (nothing gathered → stale/error path)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))
    const promise = fetchMCPRegistry().catch((e) => e)
    await vi.advanceTimersByTimeAsync(3_000)
    const result = await promise
    expect(result).toBeInstanceOf(Error)
  })

  it('a partial catalog re-fetches on the next call instead of serving for a full TTL', async () => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++
      // Walk 1: page ok, page 2 fails twice → partial.
      if (call === 1) return page(['a.vendor/one'], 'cursor-2')
      if (call === 2 || call === 3) return new Response('sad', { status: 503 })
      // Walk 2 (after the short retry window): complete single page.
      return page(['a.vendor/one', 'b.vendor/two'])
    }))

    const p1 = fetchMCPRegistry()
    await vi.advanceTimersByTimeAsync(3_000)
    expect((await p1)).toHaveLength(1)

    // Within the short retry window the partial is served as-is…
    expect(await fetchMCPRegistry()).toHaveLength(1)

    // …but once the window passes, the next call re-walks.
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
    const p2 = fetchMCPRegistry()
    await vi.advanceTimersByTimeAsync(3_000)
    expect((await p2)).toHaveLength(2)
  })
})

describe('getRegistryEntry — no full walks for one id', () => {
  it('serves from the cached catalog without touching the network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page(['a.vendor/one'])))
    await fetchMCPRegistry() // warm the cache (1 network call)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const hit = await getRegistryEntry('a.vendor/one')
    expect(hit?.id).toBe('a.vendor/one')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fresh + complete cache answers a miss with null, no network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page(['a.vendor/one'])))
    await fetchMCPRegistry()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(await getRegistryEntry('z.vendor/nope')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cold cache does ONE targeted search — not a catalog walk', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      urls.push(String(url))
      return page(['other.vendor/gmail-ish', 'ai.waystation/gmail'])
    }))

    const hit = await getRegistryEntry('ai.waystation/gmail')
    expect(hit?.id).toBe('ai.waystation/gmail')
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('search=gmail')
  })

  it('targeted search failure degrades to null, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))
    const promise = getRegistryEntry('a.vendor/one')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await promise).toBeNull()
  })
})
