/**
 * Unit tests for the web-search pluggable-connector HTTP handlers.
 *
 * Uses mock IncomingMessage/ServerResponse so tests run without a live
 * gateway.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialVault } from '../../../src/connector/credentials/vault.js'
import { WebSearchService } from '../../../src/connector/web-search/service.js'
import { createWebSearchHandlers } from '../../../src/gateway/handlers/web-search.js'
import { vaultIdFor } from '../../../src/connector/web-search/providers.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = body !== undefined ? JSON.stringify(body) : ''
  const sock = new Socket()
  const req = new IncomingMessage(sock)
  ;(req as unknown as { method: string }).method = method
  ;(req as unknown as { url: string }).url = url
  req.headers = { host: 'localhost' }
  // Feed the request stream synchronously — push + end().
  process.nextTick(() => {
    if (payload.length > 0) req.push(payload)
    req.push(null)
  })
  return req
}

interface CapturedResponse {
  status: number
  body: unknown
  raw: string
}

function makeRes(): { res: ServerResponse; done: Promise<CapturedResponse> } {
  const sock = new Socket()
  const req = new IncomingMessage(sock)
  const res = new ServerResponse(req)
  const chunks: Buffer[] = []
  let status = 0
  const origWriteHead = res.writeHead.bind(res)
  res.writeHead = ((s: number, ...args: unknown[]) => {
    status = s
    return origWriteHead(s, ...(args as [])) as unknown as ServerResponse
  }) as ServerResponse['writeHead']
  const origWrite = res.write.bind(res)
  res.write = ((c: unknown) => {
    if (typeof c === 'string') chunks.push(Buffer.from(c))
    else if (Buffer.isBuffer(c)) chunks.push(c)
    return origWrite(c as Buffer)
  }) as ServerResponse['write']

  const done = new Promise<CapturedResponse>(resolve => {
    const origEnd = res.end.bind(res)
    res.end = ((c?: unknown) => {
      if (typeof c === 'string') chunks.push(Buffer.from(c))
      else if (Buffer.isBuffer(c)) chunks.push(c)
      const raw = Buffer.concat(chunks).toString('utf-8')
      let body: unknown = raw
      try { body = JSON.parse(raw) } catch { /* plain text */ }
      resolve({ status, body, raw })
      return origEnd(c as Buffer)
    }) as ServerResponse['end']
  })

  return { res, done }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('web-search handlers', () => {
  let tmpDir: string
  let vault: CredentialVault
  let service: WebSearchService
  let handlers: ReturnType<typeof createWebSearchHandlers>
  const store = new Map<string, string>()
  const settings = {
    getSetting: (k: string) => { const v = store.get(k); return v === undefined ? undefined : { value: v } },
    setSetting: (k: string, v: string) => { store.set(k, v); return { value: v } },
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-ws-h-'))
    vault = new CredentialVault(tmpDir)
    service = new WebSearchService({ settings, vault })
    handlers = createWebSearchHandlers({ service })
    store.clear()
    delete process.env['BRAVE_SEARCH_API_KEY']
    delete process.env['TAVILY_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('GET /connectors/:id/providers', () => {
    it('returns providers for web_search', async () => {
      const { res, done } = makeRes()
      await handlers.listProviders(
        makeReq('GET', '/api/v1/connectors/web_search/providers'),
        res,
        { id: 'web_search' },
      )
      const r = await done
      expect(r.status).toBe(200)
      const body = r.body as { providers: unknown[]; activeProviderId: string; defaultProviderId: string }
      expect(body.defaultProviderId).toBe('duckduckgo')
      expect(body.activeProviderId).toBe('duckduckgo')
      expect(body.providers.length).toBe(4)
    })

    it('returns 404 for non-pluggable connector', async () => {
      const { res, done } = makeRes()
      await handlers.listProviders(
        makeReq('GET', '/api/v1/connectors/readFile/providers'),
        res,
        { id: 'readFile' },
      )
      const r = await done
      expect(r.status).toBe(404)
    })
  })

  describe('PATCH /connectors/:id/provider', () => {
    it('returns 404 for non-pluggable connector', async () => {
      const { res, done } = makeRes()
      await handlers.setProvider(
        makeReq('PATCH', '/api/v1/connectors/readFile/provider', { providerId: 'duckduckgo' }),
        res,
        { id: 'readFile' },
      )
      const r = await done
      expect(r.status).toBe(404)
    })

    it('switches to a key-free provider', async () => {
      const { res, done } = makeRes()
      await handlers.setProvider(
        makeReq('PATCH', '/api/v1/connectors/web_search/provider', { providerId: 'duckduckgo' }),
        res,
        { id: 'web_search' },
      )
      const r = await done
      expect(r.status).toBe(200)
      expect((r.body as { providerId: string }).providerId).toBe('duckduckgo')
      expect(store.get('connector.web_search.providerId')).toBe('duckduckgo')
    })

    it('rejects unknown provider id with 400', async () => {
      const { res, done } = makeRes()
      await handlers.setProvider(
        makeReq('PATCH', '/api/v1/connectors/web_search/provider', { providerId: 'bogus' }),
        res,
        { id: 'web_search' },
      )
      const r = await done
      expect(r.status).toBe(400)
    })

    it('rejects api_key provider with no key anywhere', async () => {
      const { res, done } = makeRes()
      await handlers.setProvider(
        makeReq('PATCH', '/api/v1/connectors/web_search/provider', { providerId: 'brave' }),
        res,
        { id: 'web_search' },
      )
      const r = await done
      expect(r.status).toBe(400)
      expect(r.raw).toMatch(/requires an API key/)
    })

    it('accepts api_key provider when apiKey is in body and persists to vault', async () => {
      const { res, done } = makeRes()
      await handlers.setProvider(
        makeReq('PATCH', '/api/v1/connectors/web_search/provider', {
          providerId: 'brave',
          apiKey: 'test-key',
        }),
        res,
        { id: 'web_search' },
      )
      const r = await done
      expect(r.status).toBe(200)
      expect((r.body as { providerId: string }).providerId).toBe('brave')
      // Verify it landed in vault.
      const loaded = await vault.load(vaultIdFor('brave'))
      expect(loaded?.env['BRAVE_SEARCH_API_KEY']).toBe('test-key')
    })

    it('accepts api_key provider when env key is already present (no body key)', async () => {
      process.env['TAVILY_API_KEY'] = 'env-tk'
      const { res, done } = makeRes()
      await handlers.setProvider(
        makeReq('PATCH', '/api/v1/connectors/web_search/provider', { providerId: 'tavily' }),
        res,
        { id: 'web_search' },
      )
      const r = await done
      expect(r.status).toBe(200)
    })

    it('rejects apiKey for key-free provider', async () => {
      const { res, done } = makeRes()
      await handlers.setProvider(
        makeReq('PATCH', '/api/v1/connectors/web_search/provider', {
          providerId: 'duckduckgo',
          apiKey: 'pointless',
        }),
        res,
        { id: 'web_search' },
      )
      const r = await done
      expect(r.status).toBe(400)
      expect(r.raw).toMatch(/does not accept/)
    })

    it('rejects malformed body', async () => {
      const { res, done } = makeRes()
      await handlers.setProvider(
        makeReq('PATCH', '/api/v1/connectors/web_search/provider', { wrongField: 'x' }),
        res,
        { id: 'web_search' },
      )
      const r = await done
      expect(r.status).toBe(400)
    })
  })
})
