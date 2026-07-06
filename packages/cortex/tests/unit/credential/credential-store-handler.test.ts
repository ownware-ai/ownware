/**
 * Unit tests — unified credential-store HTTP handlers.
 *
 * Drives the real handler with mock req/res against a real
 * `DbCredentialBackend` over an in-memory SQLite. Covers:
 *
 *   - GET /credentials: list + filters + bad-query rejection
 *   - GET /credentials/:id: 200 / 404 / 400
 *   - DELETE /credentials/:id: 200 / 404 / 400
 *   - Plaintext value MUST NOT appear in any response body
 *
 * Mock plumbing mirrors `endpoints.test.ts` so future handler tests
 * can copy the same shape without invention.
 */

import Database from 'better-sqlite3'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import {
  CredentialVault,
  __resetMasterKeyCacheForTests,
} from '../../../src/connector/credentials/vault.js'
import { DbCredentialBackend } from '../../../src/credential/store/db-backend.js'
import type { CredentialStore } from '../../../src/credential/store/index.js'
import { createCredentialStoreHandlers } from '../../../src/gateway/handlers/credential-store.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

// ---------------------------------------------------------------------------
// Mock req/res
// ---------------------------------------------------------------------------

function mockRequest(url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from([Buffer.from(payload, 'utf-8')]) as unknown as IncomingMessage
  ;(stream as unknown as { url: string }).url = url
  ;(stream as unknown as { headers: Record<string, string> }).headers = { host: 'localhost' }
  ;(stream as unknown as { method: string }).method = body === undefined ? 'GET' : 'POST'
  return stream
}

interface CapturedResponse {
  statusCode: number
  body: string
}

function mockResponse(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 0, body: '' }
  const res = {
    statusCode: 0,
    headersSent: false,
    writeHead(code: number) {
      captured.statusCode = code
      ;(res as unknown as { headersSent: boolean }).headersSent = true
      return res
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') captured.body = chunk
      return res
    },
  } as unknown as ServerResponse
  return { res, captured }
}

function parseBody<T>(captured: CapturedResponse): T {
  return JSON.parse(captured.body) as T
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let prevHome: string | undefined
let tmpHome: string
let db: Database.Database
let store: CredentialStore
let handlers: ReturnType<typeof createCredentialStoreHandlers>

beforeEach(() => {
  prevHome = process.env['HOME']
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-cred-handler-'))
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()
  db = new Database(':memory:')
  for (const m of MIGRATIONS) db.exec(m.sql)
  store = new DbCredentialBackend(db)
  handlers = createCredentialStoreHandlers(store)
})
afterEach(() => {
  db.close()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
})

async function seed(name: string, value = 'sk-ant-XXXXXXXX-HM8A', overrides: Partial<{
  category: 'llm' | 'tool' | 'oauth' | 'mcp-server'
  forConnector: string
  tags: readonly string[]
}> = {}) {
  return store.save({
    name,
    value,
    category: overrides.category ?? 'llm',
    authType: 'api-key',
    variableName: 'ANTHROPIC_API_KEY',
    source: 'manual',
    forConnector: overrides.forConnector,
    tags: overrides.tags,
  })
}

// ---------------------------------------------------------------------------
// GET /credentials
// ---------------------------------------------------------------------------

describe('GET /api/v1/credentials', () => {
  it('returns the full list when no filter is given', async () => {
    await seed('Anthropic')
    await seed('OpenAI', 'sk-oa-XXXXX-OAKE', {
      category: 'tool',
      forConnector: 'manual:openai-tool',
    })
    const { res, captured } = mockResponse()
    await handlers.list(mockRequest('/api/v1/credentials'), res)

    expect(captured.statusCode).toBe(200)
    const body = parseBody<{ credentials: { name: string }[] }>(captured)
    expect(body.credentials.map(c => c.name).sort()).toEqual(['Anthropic', 'OpenAI'])
  })

  it('filters by ?category', async () => {
    await seed('Anthropic')
    await seed('OpenAI', 'sk-oa-XXXX-OAKE', { category: 'tool' })
    const { res, captured } = mockResponse()
    await handlers.list(mockRequest('/api/v1/credentials?category=llm'), res)
    const body = parseBody<{ credentials: { category: string }[] }>(captured)
    expect(body.credentials.length).toBe(1)
    expect(body.credentials[0]!.category).toBe('llm')
  })

  it('filters by ?forConnector', async () => {
    await seed('Anthropic')
    await seed('GitHub', 'ghp_XXXXXXX-GHKE', {
      category: 'mcp-server',
      forConnector: 'mcp:github',
    })
    const { res, captured } = mockResponse()
    await handlers.list(
      mockRequest('/api/v1/credentials?forConnector=mcp%3Agithub'),
      res,
    )
    const body = parseBody<{ credentials: { forConnector: string }[] }>(captured)
    expect(body.credentials.length).toBe(1)
    expect(body.credentials[0]!.forConnector).toBe('mcp:github')
  })

  it('filters by ?tag', async () => {
    await seed('A', 'sk-XXX-AAAA', { tags: ['prod'] })
    await seed('B', 'sk-XXX-BBBB', { tags: ['dev'] })
    const { res, captured } = mockResponse()
    await handlers.list(mockRequest('/api/v1/credentials?tag=prod'), res)
    const body = parseBody<{ credentials: { name: string }[] }>(captured)
    expect(body.credentials.map(c => c.name)).toEqual(['A'])
  })

  it('combines filters with AND', async () => {
    await seed('A', 'sk-XXX-AAAA', { tags: ['prod'] })
    await seed('B', 'sk-XXX-BBBB', { category: 'tool', tags: ['prod'] })
    const { res, captured } = mockResponse()
    await handlers.list(
      mockRequest('/api/v1/credentials?category=llm&tag=prod'),
      res,
    )
    const body = parseBody<{ credentials: { name: string }[] }>(captured)
    expect(body.credentials.map(c => c.name)).toEqual(['A'])
  })

  it('excludes revoked by default; ?includeRevoked=true returns them', async () => {
    const a = await seed('A')
    await store.update(a.id, { status: 'revoked', statusReason: 'user removed' })

    const { res: r1, captured: c1 } = mockResponse()
    await handlers.list(mockRequest('/api/v1/credentials'), r1)
    expect(parseBody<{ credentials: unknown[] }>(c1).credentials.length).toBe(0)

    const { res: r2, captured: c2 } = mockResponse()
    await handlers.list(
      mockRequest('/api/v1/credentials?includeRevoked=true'),
      r2,
    )
    expect(parseBody<{ credentials: unknown[] }>(c2).credentials.length).toBe(1)
  })

  it('rejects an unknown query param (strict schema)', async () => {
    const { res, captured } = mockResponse()
    await handlers.list(mockRequest('/api/v1/credentials?wat=1'), res)
    expect(captured.statusCode).toBe(400)
  })

  it('rejects an unknown category value', async () => {
    const { res, captured } = mockResponse()
    await handlers.list(
      mockRequest('/api/v1/credentials?category=mystery'),
      res,
    )
    expect(captured.statusCode).toBe(400)
  })

  it('rejects an unknown includeRevoked value', async () => {
    const { res, captured } = mockResponse()
    await handlers.list(
      mockRequest('/api/v1/credentials?includeRevoked=yes'),
      res,
    )
    expect(captured.statusCode).toBe(400)
  })

  it('treats empty-string query values as unset', async () => {
    await seed('A')
    const { res, captured } = mockResponse()
    await handlers.list(mockRequest('/api/v1/credentials?category='), res)
    expect(captured.statusCode).toBe(200)
    const body = parseBody<{ credentials: unknown[] }>(captured)
    expect(body.credentials.length).toBe(1)
  })

  it('does NOT include the plaintext value anywhere in the body', async () => {
    const value = 'sk-ant-PLAINTEXT-LEAK-CHECK-2025'
    await seed('Anthropic', value)
    const { res, captured } = mockResponse()
    await handlers.list(mockRequest('/api/v1/credentials'), res)
    expect(captured.body).not.toContain(value)
  })

  it('returns deterministic ordering across calls', async () => {
    for (let i = 0; i < 5; i++) {
      await seed(`K${i}`)
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    const { res: r1, captured: c1 } = mockResponse()
    await handlers.list(mockRequest('/api/v1/credentials'), r1)
    const { res: r2, captured: c2 } = mockResponse()
    await handlers.list(mockRequest('/api/v1/credentials'), r2)
    expect(c1.body).toBe(c2.body)
  })
})

// ---------------------------------------------------------------------------
// GET /credentials/:id
// ---------------------------------------------------------------------------

describe('GET /api/v1/credentials/:id', () => {
  it('returns 200 + the credential metadata for a known id', async () => {
    const seeded = await seed('Anthropic')
    const { res, captured } = mockResponse()
    await handlers.getOne(mockRequest(`/api/v1/credentials/${seeded.id}`), res, { id: seeded.id })
    expect(captured.statusCode).toBe(200)
    const body = parseBody<{ credential: { id: string; name: string } }>(captured)
    expect(body.credential.id).toBe(seeded.id)
    expect(body.credential.name).toBe('Anthropic')
  })

  it('returns 404 for an unknown id', async () => {
    const { res, captured } = mockResponse()
    await handlers.getOne(
      mockRequest('/api/v1/credentials/cred_000000000000'),
      res,
      { id: 'cred_000000000000' },
    )
    expect(captured.statusCode).toBe(404)
  })

  it('returns 400 for a malformed id', async () => {
    const { res, captured } = mockResponse()
    await handlers.getOne(
      mockRequest('/api/v1/credentials/not-a-cred-id'),
      res,
      { id: 'not-a-cred-id' },
    )
    expect(captured.statusCode).toBe(400)
  })

  it('returns 400 for an empty id', async () => {
    const { res, captured } = mockResponse()
    await handlers.getOne(mockRequest('/api/v1/credentials/'), res, { id: '' })
    expect(captured.statusCode).toBe(400)
  })

  it('does NOT include the plaintext value', async () => {
    const value = 'sk-ant-PLAINTEXT-LEAK-CHECK-GETONE'
    const seeded = await seed('Anthropic', value)
    const { res, captured } = mockResponse()
    await handlers.getOne(
      mockRequest(`/api/v1/credentials/${seeded.id}`),
      res,
      { id: seeded.id },
    )
    expect(captured.body).not.toContain(value)
  })
})

// ---------------------------------------------------------------------------
// DELETE /credentials/:id (C14 — soft-delete by default; ?hard=true purges)
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/credentials/:id — soft-delete by default', () => {
  it('soft-deletes by default: status flips to "revoked" and row stays', async () => {
    const seeded = await seed('Anthropic')
    const { res, captured } = mockResponse()
    await handlers.remove(
      mockRequest(`/api/v1/credentials/${seeded.id}`),
      res,
      { id: seeded.id },
    )
    expect(captured.statusCode).toBe(200)
    const body = parseBody<{ deleted: boolean; hard: boolean; credential: { status: string } }>(captured)
    expect(body.deleted).toBe(true)
    expect(body.hard).toBe(false)
    expect(body.credential.status).toBe('revoked')

    // Row still in the store, retrievable when includeRevoked=true.
    const fetched = await store.get(seeded.id)
    expect(fetched?.status).toBe('revoked')
  })

  it('honours an optional ?reason= for the audit trail', async () => {
    const seeded = await seed('Anthropic')
    const { res, captured } = mockResponse()
    await handlers.remove(
      mockRequest(
        `/api/v1/credentials/${seeded.id}?reason=${encodeURIComponent('rotated by ops')}`,
      ),
      res,
      { id: seeded.id },
    )
    expect(captured.statusCode).toBe(200)
    const body = parseBody<{ credential: { statusReason: string } }>(captured)
    expect(body.credential.statusReason).toBe('rotated by ops')
  })

  it('defaults the soft-delete reason to "user removed"', async () => {
    const seeded = await seed('Anthropic')
    const { res, captured } = mockResponse()
    await handlers.remove(
      mockRequest(`/api/v1/credentials/${seeded.id}`),
      res,
      { id: seeded.id },
    )
    const body = parseBody<{ credential: { statusReason: string } }>(captured)
    expect(body.credential.statusReason).toBe('user removed')
  })

  it('?hard=true purges the row from the store', async () => {
    const seeded = await seed('Anthropic')
    const { res, captured } = mockResponse()
    await handlers.remove(
      mockRequest(`/api/v1/credentials/${seeded.id}?hard=true`),
      res,
      { id: seeded.id },
    )
    expect(captured.statusCode).toBe(200)
    const body = parseBody<{ deleted: boolean; hard: boolean }>(captured)
    expect(body.deleted).toBe(true)
    expect(body.hard).toBe(true)
    expect(await store.get(seeded.id)).toBeNull()
  })

  it('returns 404 for an unknown id (soft path)', async () => {
    const { res, captured } = mockResponse()
    await handlers.remove(
      mockRequest('/api/v1/credentials/cred_000000000000'),
      res,
      { id: 'cred_000000000000' },
    )
    expect(captured.statusCode).toBe(404)
  })

  it('returns 404 for an unknown id (hard path)', async () => {
    const { res, captured } = mockResponse()
    await handlers.remove(
      mockRequest('/api/v1/credentials/cred_000000000000?hard=true'),
      res,
      { id: 'cred_000000000000' },
    )
    expect(captured.statusCode).toBe(404)
  })

  it('returns 400 for a malformed id', async () => {
    const { res, captured } = mockResponse()
    await handlers.remove(
      mockRequest('/api/v1/credentials/garbage'),
      res,
      { id: 'garbage' },
    )
    expect(captured.statusCode).toBe(400)
  })

  it('returns 400 for an unknown query param', async () => {
    const seeded = await seed('Anthropic')
    const { res, captured } = mockResponse()
    await handlers.remove(
      mockRequest(`/api/v1/credentials/${seeded.id}?wat=1`),
      res,
      { id: seeded.id },
    )
    expect(captured.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /credentials (C12 — create)
// ---------------------------------------------------------------------------

describe('POST /api/v1/credentials', () => {
  function createBody(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Anthropic Key',
      value: 'sk-ant-XXXXXXXX-NEW1',
      category: 'llm',
      authType: 'api-key',
      variableName: 'ANTHROPIC_API_KEY',
      source: 'manual',
      ...overrides,
    }
  }

  it('returns 201 + the new credential metadata', async () => {
    const { res, captured } = mockResponse()
    await handlers.create(mockRequest('/api/v1/credentials', createBody()), res)
    expect(captured.statusCode).toBe(201)
    const body = parseBody<{ credential: { id: string; hint: string } }>(captured)
    expect(body.credential.id).toMatch(/^cred_[a-f0-9]{12}$/)
    expect(body.credential.hint).toBe('...NEW1')
  })

  it('persists the credential so a subsequent list returns it', async () => {
    const { res } = mockResponse()
    await handlers.create(mockRequest('/api/v1/credentials', createBody()), res)
    const list = await store.list({ category: 'llm' })
    expect(list.length).toBe(1)
  })

  it('does NOT echo the plaintext value in the response', async () => {
    const value = 'sk-ant-PLAINTEXT-LEAK-CREATE-9999'
    const { res, captured } = mockResponse()
    await handlers.create(
      mockRequest('/api/v1/credentials', createBody({ value })),
      res,
    )
    expect(captured.body).not.toContain(value)
  })

  it('returns 409 on a duplicate (category, variableName)', async () => {
    const { res: r1 } = mockResponse()
    await handlers.create(mockRequest('/api/v1/credentials', createBody()), r1)

    const { res, captured } = mockResponse()
    await handlers.create(mockRequest('/api/v1/credentials', createBody()), res)
    expect(captured.statusCode).toBe(409)
    expect(captured.body).toContain('already exists')
  })

  it('400s when api-key authType has no variableName', async () => {
    const { res, captured } = mockResponse()
    await handlers.create(
      mockRequest(
        '/api/v1/credentials',
        createBody({ variableName: undefined }),
      ),
      res,
    )
    expect(captured.statusCode).toBe(400)
    expect(captured.body).toContain('variableName')
  })

  it('400s when spendCap is set on a non-LLM category', async () => {
    const { res, captured } = mockResponse()
    await handlers.create(
      mockRequest(
        '/api/v1/credentials',
        createBody({
          category: 'tool',
          spendCap: { amountUsd: 5, period: 'day' },
        }),
      ),
      res,
    )
    expect(captured.statusCode).toBe(400)
    expect(captured.body).toContain('spendCap')
  })

  it('400s on an unknown body field (strict schema)', async () => {
    const { res, captured } = mockResponse()
    await handlers.create(
      mockRequest('/api/v1/credentials', createBody({ wat: 'no' })),
      res,
    )
    expect(captured.statusCode).toBe(400)
  })

  it('400s on missing body', async () => {
    const { res, captured } = mockResponse()
    await handlers.create(
      mockRequest('/api/v1/credentials'), // no body
      res,
    )
    expect(captured.statusCode).toBe(400)
  })

  it('accepts oauth2 without variableName', async () => {
    const { res, captured } = mockResponse()
    await handlers.create(
      mockRequest(
        '/api/v1/credentials',
        createBody({
          category: 'oauth',
          authType: 'oauth2',
          variableName: undefined,
        }),
      ),
      res,
    )
    expect(captured.statusCode).toBe(201)
  })
})

// ---------------------------------------------------------------------------
// PATCH /credentials/:id (C13)
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/credentials/:id', () => {
  it('updates simple fields and returns the new metadata', async () => {
    const seeded = await seed('Old Name')
    const { res, captured } = mockResponse()
    await handlers.update(
      mockRequest(`/api/v1/credentials/${seeded.id}`, { name: 'New Name', tags: ['prod'] }),
      res,
      { id: seeded.id },
    )
    expect(captured.statusCode).toBe(200)
    const body = parseBody<{ credential: { name: string; tags: string[] } }>(captured)
    expect(body.credential.name).toBe('New Name')
    expect(body.credential.tags).toEqual(['prod'])
  })

  it('rotates the value when `value` is supplied (hint changes)', async () => {
    const seeded = await seed('Anthropic', 'sk-old-XXXX-OLD1')
    const { res, captured } = mockResponse()
    await handlers.update(
      mockRequest(`/api/v1/credentials/${seeded.id}`, { value: 'sk-new-XXXX-NEW2' }),
      res,
      { id: seeded.id },
    )
    expect(captured.statusCode).toBe(200)
    const body = parseBody<{ credential: { hint: string } }>(captured)
    expect(body.credential.hint).toBe('...NEW2')
    const decrypted = await store.decrypt(seeded.id)
    expect(decrypted?.value).toBe('sk-new-XXXX-NEW2')
  })

  it('clears spendCap when set to null (tri-state)', async () => {
    const seeded = await store.save({
      name: 'A',
      value: 'sk-XXXX-AAAA',
      category: 'llm',
      authType: 'api-key',
      variableName: 'ANTHROPIC_API_KEY',
      source: 'manual',
      spendCap: { amountUsd: 5, period: 'day' },
    })
    const { res, captured } = mockResponse()
    await handlers.update(
      mockRequest(`/api/v1/credentials/${seeded.id}`, { spendCap: null }),
      res,
      { id: seeded.id },
    )
    const body = parseBody<{ credential: { spendCap?: unknown } }>(captured)
    expect(body.credential.spendCap).toBeUndefined()
  })

  it('returns 404 for an unknown id', async () => {
    const { res, captured } = mockResponse()
    await handlers.update(
      mockRequest('/api/v1/credentials/cred_000000000000', { name: 'x' }),
      res,
      { id: 'cred_000000000000' },
    )
    expect(captured.statusCode).toBe(404)
  })

  it('returns 400 for an empty patch body', async () => {
    const seeded = await seed('Anthropic')
    const { res, captured } = mockResponse()
    await handlers.update(
      mockRequest(`/api/v1/credentials/${seeded.id}`, {}),
      res,
      { id: seeded.id },
    )
    expect(captured.statusCode).toBe(400)
  })

  it('returns 400 for an unknown body field (strict schema)', async () => {
    const seeded = await seed('Anthropic')
    const { res, captured } = mockResponse()
    await handlers.update(
      mockRequest(`/api/v1/credentials/${seeded.id}`, { name: 'x', wat: true }),
      res,
      { id: seeded.id },
    )
    expect(captured.statusCode).toBe(400)
  })

  it('does NOT echo the plaintext value when rotating', async () => {
    const seeded = await seed('Anthropic')
    const value = 'sk-ant-PLAINTEXT-LEAK-PATCH-7777'
    const { res, captured } = mockResponse()
    await handlers.update(
      mockRequest(`/api/v1/credentials/${seeded.id}`, { value }),
      res,
      { id: seeded.id },
    )
    expect(captured.body).not.toContain(value)
  })
})

// ---------------------------------------------------------------------------
// POST /credentials/:id/validate (C15)
// ---------------------------------------------------------------------------

describe('POST /api/v1/credentials/:id/validate', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns ok=true and stores status=ready when the provider responds 200', async () => {
    const seeded = await seed('Anthropic')
    globalThis.fetch = (async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch
    const { res, captured } = mockResponse()
    await handlers.validate(
      mockRequest(`/api/v1/credentials/${seeded.id}/validate`),
      res,
      { id: seeded.id },
    )
    expect(captured.statusCode).toBe(200)
    expect(parseBody<{ ok: boolean }>(captured).ok).toBe(true)

    const refetched = await store.get(seeded.id)
    expect(refetched?.status).toBe('ready')
    expect(refetched?.lastUsedAt).toBeDefined()
  })

  it('returns ok=false on Anthropic 401 and stores status=error', async () => {
    const seeded = await seed('Anthropic')
    globalThis.fetch = (async () =>
      new Response('Unauthorized', { status: 401 })) as typeof globalThis.fetch
    const { res, captured } = mockResponse()
    await handlers.validate(
      mockRequest(`/api/v1/credentials/${seeded.id}/validate`),
      res,
      { id: seeded.id },
    )
    const body = parseBody<{ ok: boolean; error?: string }>(captured)
    expect(body.ok).toBe(false)
    expect(body.error).toBeDefined()

    const refetched = await store.get(seeded.id)
    expect(refetched?.status).toBe('error')
    expect(refetched?.statusReason).toBeTruthy()
  })

  it('returns 404 for an unknown id (no provider call)', async () => {
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch
    const { res, captured } = mockResponse()
    await handlers.validate(
      mockRequest('/api/v1/credentials/cred_000000000000/validate'),
      res,
      { id: 'cred_000000000000' },
    )
    expect(captured.statusCode).toBe(404)
    expect(fetchCalled).toBe(false)
  })

  it('does NOT include the plaintext value in the response', async () => {
    const value = 'sk-ant-PLAINTEXT-LEAK-VALIDATE-3333'
    const seeded = await seed('Anthropic', value)
    globalThis.fetch = (async () =>
      new Response('{}', { status: 200 })) as typeof globalThis.fetch
    const { res, captured } = mockResponse()
    await handlers.validate(
      mockRequest(`/api/v1/credentials/${seeded.id}/validate`),
      res,
      { id: seeded.id },
    )
    expect(captured.body).not.toContain(value)
  })

  it('other non-LLM categories (e.g. mcp-server) return ok=true without an outbound call', async () => {
    const seeded = await store.save({
      name: 'GitHub MCP',
      value: 'ghp_XXXXXXXX-1111',
      category: 'mcp-server',
      authType: 'api-key',
      variableName: 'GITHUB_TOKEN',
      forConnector: 'mcp:github',
      source: 'mcp-config',
    })
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response('', { status: 200 })
    }) as typeof globalThis.fetch
    const { res, captured } = mockResponse()
    await handlers.validate(
      mockRequest(`/api/v1/credentials/${seeded.id}/validate`),
      res,
      { id: seeded.id },
    )
    expect(parseBody<{ ok: boolean }>(captured).ok).toBe(true)
    // No outbound HTTP call for credentials without a per-source
    // validator (Composio + LLM keys are the validated set today).
    expect(fetchCalled).toBe(false)
  })

  it('Composio key triggers /api/v3/auth/session/info probe and stores status=ready on 200', async () => {
    const seeded = await store.save({
      name: 'Composio',
      value: 'cs_real_key_xxxx',
      category: 'tool',
      authType: 'api-key',
      variableName: 'COMPOSIO_API_KEY',
      source: 'manual',
    })
    let probedUrl: string | null = null
    let probedHeaders: Record<string, string> | null = null
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      probedUrl = typeof input === 'string' ? input : input.toString()
      probedHeaders = (init?.headers ?? {}) as Record<string, string>
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof globalThis.fetch
    const { res, captured } = mockResponse()
    await handlers.validate(
      mockRequest(`/api/v1/credentials/${seeded.id}/validate`),
      res,
      { id: seeded.id },
    )
    expect(captured.statusCode).toBe(200)
    expect(parseBody<{ ok: boolean }>(captured).ok).toBe(true)
    expect(probedUrl).toContain('backend.composio.dev/api/v3/auth/session/info')
    expect(probedHeaders?.['x-api-key']).toBe('cs_real_key_xxxx')

    const refetched = await store.get(seeded.id)
    expect(refetched?.status).toBe('ready')
  })

  it('Composio key 401 marks the credential as error with a clear reason', async () => {
    const seeded = await store.save({
      name: 'Composio',
      value: 'cs_bogus_key',
      category: 'tool',
      authType: 'api-key',
      variableName: 'COMPOSIO_API_KEY',
      source: 'manual',
    })
    globalThis.fetch = (async () =>
      new Response('Unauthorized', { status: 401 })) as typeof globalThis.fetch
    const { res, captured } = mockResponse()
    await handlers.validate(
      mockRequest(`/api/v1/credentials/${seeded.id}/validate`),
      res,
      { id: seeded.id },
    )
    const body = parseBody<{ ok: boolean; error?: string }>(captured)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('rejected')

    const refetched = await store.get(seeded.id)
    expect(refetched?.status).toBe('error')
    expect(refetched?.statusReason).toContain('rejected')
  })

  it('Composio uak_* CLI key is rejected at the panel without any outbound call', async () => {
    const seeded = await store.save({
      name: 'Composio',
      value: 'uak_user_scoped_cli_key',
      category: 'tool',
      authType: 'api-key',
      variableName: 'COMPOSIO_API_KEY',
      source: 'manual',
    })
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch
    const { res, captured } = mockResponse()
    await handlers.validate(
      mockRequest(`/api/v1/credentials/${seeded.id}/validate`),
      res,
      { id: seeded.id },
    )
    const body = parseBody<{ ok: boolean; error?: string }>(captured)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('user-scoped CLI key')
    expect(fetchCalled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// POST /credentials/:id/reveal (C16)
// ---------------------------------------------------------------------------

describe('POST /api/v1/credentials/:id/reveal', () => {
  it('returns the plaintext value with confirm: true', async () => {
    const value = 'sk-ant-XXXXXXXX-REVEAL'
    const seeded = await seed('Anthropic', value)
    const { res, captured } = mockResponse()
    await handlers.reveal(
      mockRequest(`/api/v1/credentials/${seeded.id}/reveal`, { confirm: true }),
      res,
      { id: seeded.id },
    )
    expect(captured.statusCode).toBe(200)
    expect(parseBody<{ value: string }>(captured).value).toBe(value)
  })

  it('400s without { confirm: true }', async () => {
    const seeded = await seed('Anthropic')
    const { res, captured } = mockResponse()
    await handlers.reveal(
      mockRequest(`/api/v1/credentials/${seeded.id}/reveal`, {}),
      res,
      { id: seeded.id },
    )
    expect(captured.statusCode).toBe(400)
  })

  it('400s on { confirm: false }', async () => {
    const seeded = await seed('Anthropic')
    const { res, captured } = mockResponse()
    await handlers.reveal(
      mockRequest(`/api/v1/credentials/${seeded.id}/reveal`, { confirm: false }),
      res,
      { id: seeded.id },
    )
    expect(captured.statusCode).toBe(400)
  })

  it('returns 404 for an unknown id', async () => {
    const { res, captured } = mockResponse()
    await handlers.reveal(
      mockRequest('/api/v1/credentials/cred_000000000000/reveal', {
        confirm: true,
      }),
      res,
      { id: 'cred_000000000000' },
    )
    expect(captured.statusCode).toBe(404)
  })

  it('returns 400 for a malformed id', async () => {
    const { res, captured } = mockResponse()
    await handlers.reveal(
      mockRequest('/api/v1/credentials/garbage/reveal', { confirm: true }),
      res,
      { id: 'garbage' },
    )
    expect(captured.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Boot integration — list survives the migration importer running first
// ---------------------------------------------------------------------------

describe('list — post-migration integration', () => {
  it('returns rows imported by the file-vault migration', async () => {
    // Simulate: file vault has one connector, the importer runs, then
    // the handler is called. End state: the connector's vars are in
    // the unified list.
    const vault = new CredentialVault(join(tmpHome, 'credentials'))
    await vault.save('mcp-server-github', {
      GITHUB_TOKEN: 'ghp_AAAAAAAA-1111',
    })
    const { importFileVaultIntoCredentials } = await import(
      '../../../src/credential/migrations/import-file-vault.js'
    )
    await importFileVaultIntoCredentials(db, store, { vault })

    const { res, captured } = mockResponse()
    await handlers.list(
      mockRequest('/api/v1/credentials?category=mcp-server'),
      res,
    )
    expect(captured.statusCode).toBe(200)
    const body = parseBody<{ credentials: { variableName: string }[] }>(captured)
    expect(body.credentials.map(c => c.variableName)).toEqual(['GITHUB_TOKEN'])
  })
})
