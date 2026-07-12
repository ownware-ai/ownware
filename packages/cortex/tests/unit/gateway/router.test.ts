/**
 * Unit tests for the HTTP router.
 */

import { describe, it, expect } from 'vitest'
import { Router, readBody, sendJSON, sendError, RequestError } from '../../../src/gateway/router.js'
import { createServer, request as httpRequest } from 'node:http'
import type { Server } from 'node:http'

// ---------------------------------------------------------------------------
// Helpers — create a test server and make requests
// ---------------------------------------------------------------------------

async function withServer(router: Router, fn: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => router.handle(req, res))
  await new Promise<void>(resolve => server.listen(0, resolve))
  const addr = server.address() as { port: number }
  try {
    await fn(`http://localhost:${addr.port}`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

async function fetchJSON(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init)
  const body = await res.json()
  return { status: res.status, body }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Router', () => {
  it('routes GET requests', async () => {
    const router = new Router()
    router.get('/test', async (_req, res) => {
      sendJSON(res, 200, { ok: true })
    })

    await withServer(router, async (url) => {
      const { status, body } = await fetchJSON(`${url}/test`)
      expect(status).toBe(200)
      expect(body).toEqual({ ok: true })
    })
  })

  it('routes POST requests', async () => {
    const router = new Router()
    router.post('/test', async (req, res) => {
      const raw = await readBody(req)
      const data = JSON.parse(raw)
      sendJSON(res, 201, { received: data })
    })

    await withServer(router, async (url) => {
      const { status, body } = await fetchJSON(`${url}/test`, {
        method: 'POST',
        body: JSON.stringify({ hello: 'world' }),
        headers: { 'Content-Type': 'application/json' },
      })
      expect(status).toBe(201)
      expect((body as any).received).toEqual({ hello: 'world' })
    })
  })

  it('extracts path params', async () => {
    const router = new Router()
    router.get('/items/:itemId', async (_req, res, params) => {
      sendJSON(res, 200, { itemId: params['itemId'] })
    })

    await withServer(router, async (url) => {
      const { body } = await fetchJSON(`${url}/items/abc-123`)
      expect((body as any).itemId).toBe('abc-123')
    })
  })

  it('extracts multiple path params', async () => {
    const router = new Router()
    router.get('/threads/:threadId/messages/:messageId', async (_req, res, params) => {
      sendJSON(res, 200, params)
    })

    await withServer(router, async (url) => {
      const { body } = await fetchJSON(`${url}/threads/t1/messages/m2`)
      expect((body as any).threadId).toBe('t1')
      expect((body as any).messageId).toBe('m2')
    })
  })

  it('returns 404 for unmatched routes', async () => {
    const router = new Router()
    router.get('/exists', async (_req, res) => sendJSON(res, 200, {}))

    await withServer(router, async (url) => {
      const { status, body } = await fetchJSON(`${url}/does-not-exist`)
      expect(status).toBe(404)
      expect((body as any).error).toBe('not_found')
    })
  })

  it('returns 404 for wrong method', async () => {
    const router = new Router()
    router.get('/only-get', async (_req, res) => sendJSON(res, 200, {}))

    await withServer(router, async (url) => {
      const { status } = await fetchJSON(`${url}/only-get`, { method: 'POST' })
      expect(status).toBe(404)
    })
  })

  it('handles CORS preflight', async () => {
    const router = new Router()

    await withServer(router, async (url) => {
      const res = await fetch(`${url}/anything`, { method: 'OPTIONS' })
      expect(res.status).toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(res.headers.get('access-control-allow-methods')).toContain('GET')
    })
  })

  it('catches handler errors and returns 500', async () => {
    const router = new Router()
    router.get('/boom', async () => {
      throw new Error('test explosion')
    })

    await withServer(router, async (url) => {
      const { status, body } = await fetchJSON(`${url}/boom`)
      expect(status).toBe(500)
      expect((body as any).message).toBe('Internal server error')
      expect(JSON.stringify(body)).not.toContain('test explosion')
    })
  })

  it('DELETE routes work', async () => {
    const router = new Router()
    router.delete('/items/:id', async (_req, res) => {
      res.writeHead(204)
      res.end()
    })

    await withServer(router, async (url) => {
      const res = await fetch(`${url}/items/123`, { method: 'DELETE' })
      expect(res.status).toBe(204)
    })
  })

  it('PUT routes work', async () => {
    const router = new Router()
    router.put('/items/:id', async (_req, res) => {
      sendJSON(res, 200, { updated: true })
    })

    await withServer(router, async (url) => {
      const { status } = await fetchJSON(`${url}/items/123`, {
        method: 'PUT',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      })
      expect(status).toBe(200)
    })
  })
})

describe('RequestError', () => {
  it('has status and message', () => {
    const err = new RequestError(400, 'bad input')
    expect(err.status).toBe(400)
    expect(err.message).toBe('bad input')
    expect(err.name).toBe('RequestError')
  })
})

describe('Router — trailing splat (*name)', () => {
  it('captures multi-segment paths into the named splat param', async () => {
    const router = new Router()
    router.get('/files/:bucket/*path', async (_req, res, params) => {
      sendJSON(res, 200, { bucket: params['bucket'], path: params['path'] })
    })

    await withServer(router, async (url) => {
      const single = await fetchJSON(`${url}/files/b1/index.html`)
      expect(single.status).toBe(200)
      expect(single.body).toEqual({ bucket: 'b1', path: 'index.html' })

      const nested = await fetchJSON(`${url}/files/b1/assets/img/logo.svg`)
      expect(nested.status).toBe(200)
      expect(nested.body).toEqual({ bucket: 'b1', path: 'assets/img/logo.svg' })
    })
  })

  it('normalises percent-encoded traversal segments out of the splat capture', async () => {
    // The router parses `req.url` via WHATWG `new URL(...)`, which
    // resolves `%2e%2e` and `..` segments before the pattern even
    // sees them. By the time the splat captures a value, traversal
    // is gone — there's nothing for `..` validation to reject because
    // the path has already been collapsed. Handlers MUST still call
    // `resolve()` + prefix-check on the captured path; URL parsing
    // does not stop a raw `etc/passwd` from being interpreted as a
    // relative path against the wrong root. This test pins the
    // normalisation behaviour so a regression is loud.
    const router = new Router()
    router.get('/files/*path', async (_req, res, params) => {
      sendJSON(res, 200, { path: params['path'] })
    })

    await withServer(router, async (url) => {
      const port = Number(new URL(url).port)
      const body = await new Promise<{ status: number; json: unknown }>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, method: 'GET', path: '/files/assets/%2e%2e/etc/passwd' },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => {
              resolve({
                status: res.statusCode ?? 0,
                json: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
              })
            })
          },
        )
        req.on('error', reject)
        req.end()
      })
      expect(body.status).toBe(200)
      expect(body.json).toEqual({ path: 'etc/passwd' })
    })
  })
})
