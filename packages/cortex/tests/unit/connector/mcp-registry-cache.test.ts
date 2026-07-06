/**
 * Unit tests — fetchMCPRegistry persistent disk cache + stale-on-failure
 * + singleflight (Phase: registry resilience, 2026-05-07).
 *
 * Scenarios:
 *   - Successful fetch writes to disk; subsequent cold load picks
 *     up the disk cache instead of hitting the network.
 *   - Network failure with a non-empty cache → stale fallback wins
 *     (no [] returned).
 *   - Network failure with an empty cache → throws (caller decides
 *     whether to surface or default to []).
 *   - Concurrent calls share a single in-flight network round-trip
 *     (singleflight).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fetchMCPRegistry,
  clearRegistryCache,
  clearDiskRegistryCache,
} from '../../../src/connector/mcp/registry.js'

let tempDir: string
let cachePath: string
let originalEnv: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mcp-registry-cache-test-'))
  cachePath = join(tempDir, 'cache.json')
  originalEnv = process.env['OWNWARE_REGISTRY_CACHE_PATH']
  process.env['OWNWARE_REGISTRY_CACHE_PATH'] = cachePath
  clearRegistryCache()
})

afterEach(async () => {
  await clearDiskRegistryCache()
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
  if (originalEnv === undefined) {
    delete process.env['OWNWARE_REGISTRY_CACHE_PATH']
  } else {
    process.env['OWNWARE_REGISTRY_CACHE_PATH'] = originalEnv
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Build a fake registry HTTP response payload (one page, no cursor). */
function jsonResponse(servers: ReadonlyArray<{ name: string; title?: string }>): Response {
  const body = {
    servers: servers.map((s) => ({
      server: {
        name: s.name,
        title: s.title ?? s.name,
        description: 'stub',
        version: '1.0.0',
      },
    })),
    metadata: {},
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('fetchMCPRegistry — persistent disk cache', () => {
  it('successful fetch writes the catalog to disk', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([{ name: 'io.github.user/foo', title: 'Foo' }]),
    )
    vi.stubGlobal('fetch', fetchMock)
    const list = await fetchMCPRegistry()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('io.github.user/foo')
    // Disk file now exists with the entry.
    const onDisk = JSON.parse(await fsPromises.readFile(cachePath, 'utf8'))
    expect(onDisk.version).toBe(1)
    expect(onDisk.entries).toHaveLength(1)
    expect(onDisk.entries[0].id).toBe('io.github.user/foo')
  })

  it('cold start loads from disk without hitting the network', async () => {
    // Pre-seed disk cache directly.
    const seed = {
      version: 1,
      timestamp: Date.now(),
      entries: [
        {
          id: 'io.github.user/cached',
          title: 'Cached',
          description: 'from-disk',
          icon: null,
          category: 'data',
          transport: 'stdio',
          package: '@user/cached',
          runtime: 'npx',
          requiredEnv: [],
          optionalEnv: [],
          remoteUrl: null,
          repository: null,
          websiteUrl: null,
          packageArgs: [],
          version: '1.0.0',
        },
      ],
    }
    await fsPromises.writeFile(cachePath, JSON.stringify(seed), 'utf8')
    // Network mock that, if called, would fail the test.
    const fetchMock = vi.fn(async () => {
      throw new Error('should not have been called — disk cache should win')
    })
    vi.stubGlobal('fetch', fetchMock)
    const list = await fetchMCPRegistry()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('io.github.user/cached')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stale-on-failure: fetch error with cached entries returns the cache, not []', async () => {
    // First call succeeds → in-memory + disk cache populated.
    const okFetch = vi.fn(async () =>
      jsonResponse([{ name: 'io.github.user/foo', title: 'Foo' }]),
    )
    vi.stubGlobal('fetch', okFetch)
    const first = await fetchMCPRegistry()
    expect(first).toHaveLength(1)

    // Now force a refresh, but make the network fail (e.g. 429).
    // Stale fallback: returns the previous catalog instead of
    // throwing or returning [].
    const failFetch = vi.fn(
      async () =>
        new Response('rate limit', {
          status: 429,
          statusText: 'Too Many Requests',
        }),
    )
    vi.stubGlobal('fetch', failFetch)
    const second = await fetchMCPRegistry({ forceRefresh: true })
    expect(second).toHaveLength(1)
    expect(second[0]?.id).toBe('io.github.user/foo')
    expect(failFetch).toHaveBeenCalled()
  })

  it('cold start with no cache + network failure throws (caller handles empty path)', async () => {
    const failFetch = vi.fn(
      async () =>
        new Response('rate limit', {
          status: 429,
          statusText: 'Too Many Requests',
        }),
    )
    vi.stubGlobal('fetch', failFetch)
    await expect(fetchMCPRegistry()).rejects.toThrow(/429/)
  })

  it('singleflight: concurrent calls share one network round-trip', async () => {
    // A slow fetch that hangs until we manually resolve it. If
    // singleflight works, all three callers await the same promise
    // and the network mock fires exactly once.
    let resolveFetch: (r: Response) => void = () => {}
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const promises = [
      fetchMCPRegistry({ forceRefresh: true }),
      fetchMCPRegistry({ forceRefresh: true }),
      fetchMCPRegistry({ forceRefresh: true }),
    ]
    // Yield once so all three calls register.
    await Promise.resolve()
    await Promise.resolve()

    resolveFetch(
      jsonResponse([{ name: 'io.github.user/coalesced', title: 'Coalesced' }]),
    )
    const results = await Promise.all(promises)
    expect(results.every((r) => r.length === 1)).toBe(true)
    // Singleflight: ONE network call regardless of N concurrent
    // callers.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('tolerates a corrupt disk cache file by starting fresh', async () => {
    await fsPromises.writeFile(cachePath, 'not-valid-json{{{', 'utf8')
    const fetchMock = vi.fn(async () =>
      jsonResponse([{ name: 'io.github.user/fresh', title: 'Fresh' }]),
    )
    vi.stubGlobal('fetch', fetchMock)
    const list = await fetchMCPRegistry()
    // Corrupt cache ignored; network fetched.
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('io.github.user/fresh')
    expect(fetchMock).toHaveBeenCalled()
  })
})
