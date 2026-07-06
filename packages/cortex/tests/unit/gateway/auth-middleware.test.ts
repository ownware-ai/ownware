/**
 * Tests for the auth middleware disable flag (Slice 0.9).
 * Ensures the middleware is still installed but becomes a no-op
 * when `disabled: true` is passed.
 */

import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAuthMiddleware, generateSessionToken } from '../../../src/gateway/middleware/auth.js'

interface FakeRes {
  statusCode: number
  headers: Record<string, string | number>
  body: string
  writeHead(status: number, headers?: Record<string, string | number>): void
  end(body?: string): void
}

function makeReq(opts: {
  url?: string
  method?: string
  headers?: Record<string, string>
}): IncomingMessage {
  const req = {
    url: opts.url ?? '/api/v1/profiles',
    method: opts.method ?? 'GET',
    headers: opts.headers ?? {},
  }
  return req as unknown as IncomingMessage
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
    },
    end(body) {
      if (body !== undefined) this.body = body
    },
  }
  return res
}

describe('createAuthMiddleware', () => {
  const token = generateSessionToken()

  it('generates unique random tokens', () => {
    const a = generateSessionToken()
    const b = generateSessionToken()
    expect(a).not.toBe(b)
    expect(a).toHaveLength(64) // 32 bytes hex-encoded
  })

  describe('enabled (default)', () => {
    const middleware = createAuthMiddleware(token)

    it('allows health check without a token', () => {
      const req = makeReq({ url: '/api/v1/health' })
      const res = makeRes()
      expect(middleware(req, res as unknown as ServerResponse)).toBe(true)
    })

    it('allows OPTIONS preflight without a token', () => {
      const req = makeReq({ method: 'OPTIONS' })
      const res = makeRes()
      expect(middleware(req, res as unknown as ServerResponse)).toBe(true)
    })

    it('rejects a request with no Authorization header', () => {
      const req = makeReq({})
      const res = makeRes()
      expect(middleware(req, res as unknown as ServerResponse)).toBe(false)
      expect(res.statusCode).toBe(401)
    })

    it('rejects a malformed Authorization header', () => {
      const req = makeReq({ headers: { authorization: 'Token foo' } })
      const res = makeRes()
      expect(middleware(req, res as unknown as ServerResponse)).toBe(false)
      expect(res.statusCode).toBe(401)
    })

    it('rejects a Bearer token that does not match', () => {
      const req = makeReq({ headers: { authorization: 'Bearer wrong-token' } })
      const res = makeRes()
      expect(middleware(req, res as unknown as ServerResponse)).toBe(false)
      expect(res.statusCode).toBe(401)
    })

    it('accepts a correct Bearer token', () => {
      const req = makeReq({ headers: { authorization: `Bearer ${token}` } })
      const res = makeRes()
      expect(middleware(req, res as unknown as ServerResponse)).toBe(true)
    })
  })

  describe('disabled', () => {
    const middleware = createAuthMiddleware(token, { disabled: true })

    it('accepts requests with no token', () => {
      const req = makeReq({})
      const res = makeRes()
      expect(middleware(req, res as unknown as ServerResponse)).toBe(true)
      expect(res.statusCode).toBe(200) // unchanged — middleware did not send an error
    })

    it('accepts requests with a wrong token', () => {
      const req = makeReq({ headers: { authorization: 'Bearer nope' } })
      const res = makeRes()
      expect(middleware(req, res as unknown as ServerResponse)).toBe(true)
    })

    it('still passes health through (by disable, not by exemption)', () => {
      const req = makeReq({ url: '/api/v1/health' })
      const res = makeRes()
      expect(middleware(req, res as unknown as ServerResponse)).toBe(true)
    })
  })
})
