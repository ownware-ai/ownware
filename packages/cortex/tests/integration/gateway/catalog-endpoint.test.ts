/**
 * Integration tests for T01: `GET /api/v1/catalog`.
 *
 * Real gateway with temp profilesDir + dataDir. The gateway constructs
 * its own ConnectorRegistry which includes the BuiltinSourceProvider
 * (every Loom built-in → a connector) and the MCPSourceProvider (the
 * curated featured list + any profiles' installed servers). Composio
 * is disabled in this test env (no COMPOSIO_API_KEY), so source=composio
 * filters return empty arrays — that's its own assertion below.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { OwnwareGateway } from '../../../src/gateway/server.js'

let gateway: OwnwareGateway
let baseUrl: string
let profilesDir: string
let dataDir: string

// Skip the remote MCP registry fetch — tests must be offline-safe.
// Without this, the registry provider tries to hit
// registry.modelcontextprotocol.io and fails intermittently.
const ORIGINAL_SKIP_ENV = process.env['OWNWARE_SKIP_MCP_REGISTRY']

beforeAll(async () => {
  process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'
  profilesDir = await mkdtemp(join(tmpdir(), 'cortex-catalog-profiles-'))
  dataDir = await mkdtemp(join(tmpdir(), 'cortex-catalog-data-'))

  const userProfiles = join(dataDir, 'profiles')
  await mkdir(userProfiles, { recursive: true })
  const profileDir = join(userProfiles, 'catalog-fixture')
  await mkdir(profileDir, { recursive: true })
  await writeFile(
    join(profileDir, 'agent.json'),
    JSON.stringify(
      {
        name: 'catalog-fixture',
        description: 'Fixture for T01 /catalog tests',
        model: 'anthropic:claude-haiku-4-5-20251001',
      },
      null,
      2,
    ),
  )
  await writeFile(join(profileDir, 'SOUL.md'), '# Fixture\n')
  await writeFile(join(profileDir, 'AGENTS.md'), '# Memory\n')
  await mkdir(join(profileDir, 'skills'), { recursive: true })

  gateway = new OwnwareGateway({ port: 0, profilesDir, dataDir })
  await gateway.start()
  baseUrl = `http://localhost:${gateway.port}`
}, 15_000)

afterAll(async () => {
  await gateway.stop()
  await rm(profilesDir, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
  if (ORIGINAL_SKIP_ENV === undefined) {
    delete process.env['OWNWARE_SKIP_MCP_REGISTRY']
  } else {
    process.env['OWNWARE_SKIP_MCP_REGISTRY'] = ORIGINAL_SKIP_ENV
  }
})

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${gateway.token}`, ...extra }
}

interface CatalogRes {
  status: number
  body: { items?: Array<Record<string, unknown>>; error?: string } | null
  etag: string | null
}

async function fetchCatalog(
  path: string,
  extraHeaders?: Record<string, string>,
): Promise<CatalogRes> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: authHeaders(extraHeaders),
  })
  const etag = res.headers.get('etag')
  const body = res.status === 304 ? null : await res.json()
  return { status: res.status, body: body as CatalogRes['body'], etag }
}

describe('GET /api/v1/catalog — aggregation', () => {
  it('returns an items array unioning built-in + MCP sources', async () => {
    const res = await fetchCatalog('/api/v1/catalog')
    expect(res.status).toBe(200)
    const items = res.body?.items ?? []
    // At least one built-in and one MCP featured entry.
    expect(items.some((i) => i['source'] === 'builtin')).toBe(true)
    expect(items.some((i) => i['source'] === 'mcp')).toBe(true)
    // Every entry has the Connector shape fields the modal needs.
    for (const item of items.slice(0, 5)) {
      expect(item['id']).toBeTypeOf('string')
      expect(item['canonicalId']).toBeTypeOf('string')
      expect(item['name']).toBeTypeOf('string')
      expect(item['source']).toBeTypeOf('string')
      expect(item['auth']).toBeTruthy()
    }
  })

  it('returns an ETag header on 200', async () => {
    const res = await fetchCatalog('/api/v1/catalog')
    expect(res.status).toBe(200)
    expect(res.etag).toBeTruthy()
    expect(res.etag).toMatch(/^"[a-f0-9]{16}"$/)
  })
})

describe('GET /api/v1/catalog — ?source filter', () => {
  it('source=builtin returns only built-in connectors', async () => {
    const res = await fetchCatalog('/api/v1/catalog?source=builtin')
    expect(res.status).toBe(200)
    const items = res.body?.items ?? []
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => i['source'] === 'builtin')).toBe(true)
  })

  it('source=mcp returns only MCP connectors', async () => {
    const res = await fetchCatalog('/api/v1/catalog?source=mcp')
    expect(res.status).toBe(200)
    const items = res.body?.items ?? []
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => i['source'] === 'mcp')).toBe(true)
  })

  it('source=composio returns empty when Composio is disabled', async () => {
    // Gateway under test starts without COMPOSIO_API_KEY so no composio
    // source provider is registered. Filtering to composio legitimately
    // returns zero rows — not a 400.
    const res = await fetchCatalog('/api/v1/catalog?source=composio')
    expect(res.status).toBe(200)
    expect(res.body?.items).toEqual([])
  })

  it('400s on an unknown source value', async () => {
    const res = await fetchCatalog('/api/v1/catalog?source=mcps')
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/catalog — ?featured filter', () => {
  it('featured=true narrows to the curated subset', async () => {
    const all = await fetchCatalog('/api/v1/catalog')
    const featured = await fetchCatalog('/api/v1/catalog?featured=true')
    expect(featured.status).toBe(200)
    const allItems = all.body?.items ?? []
    const featuredItems = featured.body?.items ?? []
    // Featured MUST be a subset of the full list.
    expect(featuredItems.length).toBeLessThanOrEqual(allItems.length)
    expect(featuredItems.length).toBeGreaterThan(0)
  })

  it('featured defaults to false (catalog UX — show everything)', async () => {
    const defaultRes = await fetchCatalog('/api/v1/catalog')
    const explicit = await fetchCatalog('/api/v1/catalog?featured=false')
    // Both return the same set; ETag is the same → 304 if we echo it.
    expect(defaultRes.body?.items?.length).toBe(
      explicit.body?.items?.length,
    )
    expect(defaultRes.etag).toBe(explicit.etag)
  })

  it('400s on an unknown featured value', async () => {
    const res = await fetchCatalog('/api/v1/catalog?featured=maybe')
    expect(res.status).toBe(400)
  })
})

describe('GET /api/v1/catalog — ?q search', () => {
  it('q matches on name (case-insensitive)', async () => {
    const all = await fetchCatalog('/api/v1/catalog')
    const allItems = all.body?.items ?? []
    // Pick a name fragment from a built-in so the match exists.
    const target = allItems.find((i) => i['source'] === 'builtin')
    expect(target).toBeDefined()
    const name = target!['name'] as string
    const frag = name.slice(0, Math.min(3, name.length)).toUpperCase()
    const res = await fetchCatalog(
      `/api/v1/catalog?q=${encodeURIComponent(frag)}`,
    )
    expect(res.status).toBe(200)
    const items = res.body?.items ?? []
    expect(items.length).toBeGreaterThan(0)
    expect(
      items.every(
        (i) =>
          ((i['name'] as string).toLowerCase().includes(frag.toLowerCase()) ||
            (i['id'] as string).toLowerCase().includes(frag.toLowerCase()) ||
            (i['canonicalId'] as string)
              .toLowerCase()
              .includes(frag.toLowerCase())),
      ),
    ).toBe(true)
  })

  it('q with no matches returns an empty items array (not 404)', async () => {
    const res = await fetchCatalog(
      `/api/v1/catalog?q=${encodeURIComponent('this-slug-does-not-exist-zzzzz')}`,
    )
    expect(res.status).toBe(200)
    expect(res.body?.items).toEqual([])
  })

  it('combines with source filter', async () => {
    const res = await fetchCatalog(
      `/api/v1/catalog?source=builtin&q=${encodeURIComponent('a')}`,
    )
    expect(res.status).toBe(200)
    const items = res.body?.items ?? []
    expect(items.every((i) => i['source'] === 'builtin')).toBe(true)
  })
})

describe('GET /api/v1/catalog — ETag / conditional GET', () => {
  it('same request twice returns the same ETag', async () => {
    const a = await fetchCatalog('/api/v1/catalog')
    const b = await fetchCatalog('/api/v1/catalog')
    expect(a.etag).toBeTruthy()
    expect(a.etag).toBe(b.etag)
  })

  it('returns 304 when If-None-Match matches', async () => {
    const first = await fetchCatalog('/api/v1/catalog')
    expect(first.status).toBe(200)
    expect(first.etag).toBeTruthy()

    const second = await fetchCatalog('/api/v1/catalog', {
      'If-None-Match': first.etag!,
    })
    expect(second.status).toBe(304)
    // 304 should still echo the ETag header per RFC 7232 §4.1.
    expect(second.etag).toBe(first.etag)
  })

  it('different filters produce different ETags', async () => {
    const a = await fetchCatalog('/api/v1/catalog?source=builtin')
    const b = await fetchCatalog('/api/v1/catalog?source=mcp')
    expect(a.etag).toBeTruthy()
    expect(b.etag).toBeTruthy()
    expect(a.etag).not.toBe(b.etag)
  })
})
