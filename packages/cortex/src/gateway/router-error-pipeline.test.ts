/**
 * Router catch-all classification — S5 + S7 wire-envelope verification.
 *
 * This is the cheapest E2E we can run: a real Router + real handlers
 * that throw concrete error types + real classifyError + real sendError
 * + a fake ServerResponse that captures the wire bytes. No SQLite, no
 * gateway boot — just the actual error-pipeline contract.
 *
 * What this proves:
 *   - Every error response is `{ error, message, category }`.
 *   - `category` is a value from the closed enum.
 *   - The router's catch-all classifies even handler exceptions that
 *     don't call `sendClassifiedError` explicitly — this is the
 *     architectural guarantee covering all 410+ existing handler sites.
 *   - Throwing a typed `RequestError` with an explicit category
 *     surfaces that category on the wire.
 *   - Throwing a typed Loom `ProviderError` subclass is auto-classified.
 *
 * Run: bun test src/gateway/router-error-pipeline.test.ts
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  AuthenticationError,
  RateLimitError,
  OverloadedError,
  ContextWindowExceededError,
  AbortError,
} from '@ownware/loom'

import { Router, RequestError } from './router.js'
import { ConnectorAuthExpiredError } from '../connector/errors.js'

// ---------------------------------------------------------------------------
// Mock req/res — minimal shape Router.handle needs
// ---------------------------------------------------------------------------

interface CapturedResponse {
  status: number
  headers: Record<string, string | number>
  body: Record<string, unknown>
  headersSent: boolean
}

function fakeReqRes(method: string, path: string): {
  req: IncomingMessage
  res: ServerResponse
  captured: CapturedResponse
} {
  const captured: CapturedResponse = {
    status: 0,
    headers: {},
    body: {},
    headersSent: false,
  }
  const req = {
    method,
    url: path,
    headers: { host: 'localhost', origin: 'http://localhost' },
  } as unknown as IncomingMessage
  const res = {
    get headersSent() {
      return captured.headersSent
    },
    writeHead(status: number, headers: Record<string, string | number>) {
      captured.status = status
      captured.headers = headers
      captured.headersSent = true
    },
    setHeader() {},
    end(body: string) {
      try {
        captured.body = JSON.parse(body) as Record<string, unknown>
      } catch {
        captured.body = { raw: body }
      }
    },
  } as unknown as ServerResponse
  return { req, res, captured }
}

async function dispatch(
  router: Router,
  method: string,
  path: string,
): Promise<CapturedResponse> {
  const { req, res, captured } = fakeReqRes(method, path)
  await router.handle(req, res)
  return captured
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('router catch-all — envelope shape', () => {
  it('every 4xx/5xx response carries { error, message, category }', async () => {
    const router = new Router()
    router.get('/explode', async () => {
      throw new Error('synthetic boom')
    })
    const captured = await dispatch(router, 'GET', '/explode')
    expect(captured.body).toHaveProperty('error')
    expect(captured.body).toHaveProperty('message')
    expect(captured.body).toHaveProperty('category')
  })

  it('unknown route → 404 + category="not_found"', async () => {
    const router = new Router()
    const captured = await dispatch(router, 'GET', '/nope')
    expect(captured.status).toBe(404)
    expect(captured.body.category).toBe('not_found')
  })
})

describe('router catch-all — classification of typed throws', () => {
  it('Loom AuthenticationError → category="auth"', async () => {
    const router = new Router()
    router.get('/auth', async () => {
      throw new AuthenticationError('bad key', 'anthropic')
    })
    const captured = await dispatch(router, 'GET', '/auth')
    expect(captured.status).toBe(500)
    expect(captured.body.category).toBe('auth')
  })

  it('Loom RateLimitError → category="rate_limit"', async () => {
    const router = new Router()
    router.get('/rate', async () => {
      throw new RateLimitError('throttled', 'openai')
    })
    const captured = await dispatch(router, 'GET', '/rate')
    expect(captured.body.category).toBe('rate_limit')
  })

  it('Loom OverloadedError → category="overload"', async () => {
    const router = new Router()
    router.get('/over', async () => {
      throw new OverloadedError('busy', 'anthropic')
    })
    const captured = await dispatch(router, 'GET', '/over')
    expect(captured.body.category).toBe('overload')
  })

  it('Loom ContextWindowExceededError → category="context_window"', async () => {
    const router = new Router()
    router.get('/ctx', async () => {
      throw new ContextWindowExceededError('too long', 'openai')
    })
    const captured = await dispatch(router, 'GET', '/ctx')
    expect(captured.body.category).toBe('context_window')
  })

  it('Loom AbortError → category="aborted"', async () => {
    const router = new Router()
    router.get('/abort', async () => {
      throw new AbortError('user')
    })
    const captured = await dispatch(router, 'GET', '/abort')
    expect(captured.body.category).toBe('aborted')
  })

  it('ConnectorAuthExpiredError → category="connector_auth_expired"', async () => {
    const router = new Router()
    router.get('/conn', async () => {
      throw new ConnectorAuthExpiredError('reconnect', { source: 'composio' })
    })
    const captured = await dispatch(router, 'GET', '/conn')
    expect(captured.body.category).toBe('connector_auth_expired')
  })

  it('Network ENOTFOUND wrapped in a generic Error → category="network"', async () => {
    const router = new Router()
    router.get('/net', async () => {
      const e = new Error('getaddrinfo ENOTFOUND api.example.com')
      ;(e as { code: string }).code = 'ENOTFOUND'
      throw e
    })
    const captured = await dispatch(router, 'GET', '/net')
    expect(captured.body.category).toBe('network')
  })

  it('generic Error → category="unknown" (and never crashes the router)', async () => {
    const router = new Router()
    router.get('/wat', async () => {
      throw new Error('novel failure with no signals')
    })
    const captured = await dispatch(router, 'GET', '/wat')
    expect(captured.body.category).toBe('unknown')
    expect(captured.status).toBe(500)
  })
})

describe('router catch-all — RequestError carries optional category', () => {
  it('RequestError without category → status-derived default', async () => {
    const router = new Router()
    router.get('/req', async () => {
      throw new RequestError(409, 'conflict here')
    })
    const captured = await dispatch(router, 'GET', '/req')
    expect(captured.status).toBe(409)
    // 409 default maps to invalid_request via statusToCategory.
    expect(captured.body.category).toBe('invalid_request')
    expect(captured.body.message).toBe('conflict here')
  })

  it('RequestError with explicit category → that category wins', async () => {
    const router = new Router()
    router.get('/req2', async () => {
      throw new RequestError(401, 'no key', 'auth')
    })
    const captured = await dispatch(router, 'GET', '/req2')
    expect(captured.status).toBe(401)
    expect(captured.body.category).toBe('auth')
  })
})

describe('router catch-all — bounded enum (no free-text leaks)', () => {
  it('category is always one of the closed set', async () => {
    const router = new Router()
    router.get('/check', async () => {
      throw new Error('whatever')
    })
    const captured = await dispatch(router, 'GET', '/check')
    const ALLOWED = new Set([
      'auth', 'connector_auth_expired', 'connector_not_configured',
      'rate_limit', 'overload', 'connector_rate_limited',
      'context_window', 'content_policy', 'invalid_request', 'connector_validation',
      'network', 'sqlite', 'connector_vendor',
      'tool_timeout', 'tool_permission',
      'aborted', 'not_found', 'config',
      'unknown',
    ])
    expect(ALLOWED.has(captured.body.category as string)).toBe(true)
  })
})
