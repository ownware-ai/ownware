/**
 * sendClassifiedError — envelope round-trip tests.
 *
 * We use a tiny fake ServerResponse to capture the wire output and
 * assert the shape a client's `GatewayError` parser will see.
 */

import { describe, expect, it } from 'vitest'
import {
  AuthenticationError,
  RateLimitError,
  OverloadedError,
  AbortError,
  ToolTimeoutError,
} from '@ownware/loom'
import {
  ConnectorAuthExpiredError,
  ConnectorRateLimitedError,
} from '../connector/errors.js'
import { sendClassifiedError } from './send-classified.js'

interface CapturedResponse {
  status: number
  headers: Record<string, string | number>
  body: { error: string; message: string; category: string }
}

function fakeRes(): { res: { writeHead: (s: number, h: Record<string, string | number>) => void; end: (b: string) => void }; captured: CapturedResponse } {
  const captured: CapturedResponse = {
    status: 0,
    headers: {},
    body: { error: '', message: '', category: '' },
  }
  const res = {
    writeHead: (status: number, headers: Record<string, string | number>) => {
      captured.status = status
      captured.headers = headers
    },
    end: (body: string) => {
      captured.body = JSON.parse(body) as typeof captured.body
    },
  }
  return { res, captured }
}

describe('sendClassifiedError — envelope shape', () => {
  it('AuthenticationError → 401 + category="auth"', () => {
    const { res, captured } = fakeRes()
    sendClassifiedError(res as unknown as Parameters<typeof sendClassifiedError>[0], new AuthenticationError('bad key', 'anthropic'))
    expect(captured.status).toBe(401)
    expect(captured.body.category).toBe('auth')
    expect(captured.body.error).toBe('unauthorized')
    expect(captured.body.message).toContain('bad key')
  })

  it('RateLimitError → 429 + category="rate_limit"', () => {
    const { res, captured } = fakeRes()
    sendClassifiedError(res as unknown as Parameters<typeof sendClassifiedError>[0], new RateLimitError('throttled', 'openai'))
    expect(captured.status).toBe(429)
    expect(captured.body.category).toBe('rate_limit')
  })

  it('OverloadedError → 503 + category="overload"', () => {
    const { res, captured } = fakeRes()
    sendClassifiedError(res as unknown as Parameters<typeof sendClassifiedError>[0], new OverloadedError('fleet', 'anthropic'))
    expect(captured.status).toBe(503)
    expect(captured.body.category).toBe('overload')
  })

  it('AbortError → 409 + category="aborted"', () => {
    const { res, captured } = fakeRes()
    sendClassifiedError(res as unknown as Parameters<typeof sendClassifiedError>[0], new AbortError('user'))
    expect(captured.status).toBe(409)
    expect(captured.body.category).toBe('aborted')
  })

  it('ToolTimeoutError → 504 + category="tool_timeout"', () => {
    const { res, captured } = fakeRes()
    sendClassifiedError(res as unknown as Parameters<typeof sendClassifiedError>[0], new ToolTimeoutError('readFile', 'c1', 30_000))
    expect(captured.status).toBe(504)
    expect(captured.body.category).toBe('tool_timeout')
  })

  it('ConnectorAuthExpiredError → 401 + category="connector_auth_expired"', () => {
    const { res, captured } = fakeRes()
    sendClassifiedError(
      res as unknown as Parameters<typeof sendClassifiedError>[0],
      new ConnectorAuthExpiredError('reconnect', { source: 'composio', connectorId: 'notion' }),
    )
    expect(captured.status).toBe(401)
    expect(captured.body.category).toBe('connector_auth_expired')
  })

  it('ConnectorRateLimitedError → 429 + category="connector_rate_limited"', () => {
    const { res, captured } = fakeRes()
    sendClassifiedError(
      res as unknown as Parameters<typeof sendClassifiedError>[0],
      new ConnectorRateLimitedError('429', { source: 'composio' }),
    )
    expect(captured.status).toBe(429)
    expect(captured.body.category).toBe('connector_rate_limited')
  })

  it('Generic Error → 500 + category="unknown"', () => {
    const { res, captured } = fakeRes()
    sendClassifiedError(res as unknown as Parameters<typeof sendClassifiedError>[0], new Error('novel failure'))
    expect(captured.status).toBe(500)
    expect(captured.body.category).toBe('unknown')
  })

  it('Explicit status override wins over category-derived default', () => {
    const { res, captured } = fakeRes()
    // RateLimitError would default to 429; pass 503 explicitly.
    sendClassifiedError(res as unknown as Parameters<typeof sendClassifiedError>[0], new RateLimitError('x', 'openai'), 503)
    expect(captured.status).toBe(503)
    // Category still reflects the underlying error class.
    expect(captured.body.category).toBe('rate_limit')
  })

  it('Network ENOTFOUND → 503 + category="network"', () => {
    const { res, captured } = fakeRes()
    const e = new Error('getaddrinfo ENOTFOUND')
    ;(e as { code: string }).code = 'ENOTFOUND'
    sendClassifiedError(res as unknown as Parameters<typeof sendClassifiedError>[0], e)
    expect(captured.status).toBe(503)
    expect(captured.body.category).toBe('network')
  })

  it('Envelope always carries the three required fields', () => {
    const { res, captured } = fakeRes()
    sendClassifiedError(res as unknown as Parameters<typeof sendClassifiedError>[0], 'string thrown')
    expect(captured.body).toMatchObject({
      error: expect.any(String),
      message: expect.any(String),
      category: expect.any(String),
    })
  })
})
