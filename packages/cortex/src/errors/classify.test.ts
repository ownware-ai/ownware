/**
 * classifyError — coverage tests.
 *
 * One fixture per category (where construction is possible without I/O),
 * plus three wrapped-cause fixtures to verify the cause-graph walk.
 *
 * `unknown` only fires when we genuinely can't classify — every clause we
 * add elsewhere should reduce the `unknown` surface.
 */

import { describe, expect, it } from 'vitest'
import {
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  ServiceUnavailableError,
  OverloadedError,
  ContextWindowExceededError,
  ContentPolicyError,
  UnprocessableEntityError,
  NotFoundError,
  ProviderError,
  AbortError,
  ToolTimeoutError,
  ToolPermissionError,
  ToolError,
  ConfigError,
} from '@ownware/loom'

import {
  ConnectorAuthExpiredError,
  ConnectorRateLimitedError,
  ConnectorNetworkError,
  ConnectorValidationError,
  ConnectorVendorError,
  ConnectorNotConfiguredError,
} from '../connector/errors.js'

import { classifyError } from './classify.js'

// ---------------------------------------------------------------------------
// Loom typed errors → categories
// ---------------------------------------------------------------------------

describe('classifyError — Loom typed errors', () => {
  it('AuthenticationError → auth', () => {
    const c = classifyError(new AuthenticationError('bad key', 'anthropic'))
    expect(c.category).toBe('auth')
    expect(c.retryable).toBe(false)
    expect(c.userAction).toBe('open-settings-brains')
  })

  it('PermissionDeniedError → auth', () => {
    expect(classifyError(new PermissionDeniedError('no plan', 'openai')).category).toBe('auth')
  })

  it('RateLimitError → rate_limit, retryable, carries retryAfterMs', () => {
    const c = classifyError(
      new RateLimitError('429', 'anthropic', { retryAfterMs: 12_000 }),
    )
    expect(c.category).toBe('rate_limit')
    expect(c.retryable).toBe(true)
    expect(c.retryAfterMs).toBe(12_000)
  })

  it('OverloadedError → overload, retryable', () => {
    const c = classifyError(new OverloadedError('fleet overloaded', 'anthropic'))
    expect(c.category).toBe('overload')
    expect(c.retryable).toBe(true)
  })

  it('ServiceUnavailableError → overload', () => {
    expect(classifyError(new ServiceUnavailableError('503', 'openai')).category).toBe('overload')
  })

  it('ContextWindowExceededError → context_window', () => {
    const c = classifyError(new ContextWindowExceededError('prompt too long', 'openai'))
    expect(c.category).toBe('context_window')
    expect(c.retryable).toBe(false)
    expect(c.userAction).toBe('try-shorter-or-bigger-model')
  })

  it('ContentPolicyError → content_policy', () => {
    expect(classifyError(new ContentPolicyError('refusal', 'anthropic')).category).toBe('content_policy')
  })

  it('UnprocessableEntityError → invalid_request', () => {
    expect(classifyError(new UnprocessableEntityError('bad shape', 'openai')).category).toBe('invalid_request')
  })

  it('NotFoundError (provider) → config — model name is a config issue', () => {
    expect(classifyError(new NotFoundError('model not found', 'anthropic')).category).toBe('config')
  })

  it('Generic ProviderError with null statusCode → network', () => {
    expect(classifyError(new ProviderError('no response', 'openai', { recoverable: true })).category).toBe('network')
  })

  it('Generic ProviderError with 5xx → overload', () => {
    expect(classifyError(new ProviderError('boom', 'openai', { statusCode: 502 })).category).toBe('overload')
  })

  it('AbortError → aborted, not retryable', () => {
    const c = classifyError(new AbortError('user'))
    expect(c.category).toBe('aborted')
    expect(c.retryable).toBe(false)
    expect(c.userAction).toBeUndefined()
  })

  it('ToolTimeoutError → tool_timeout', () => {
    expect(classifyError(new ToolTimeoutError('readFile', 'call-1', 30_000)).category).toBe('tool_timeout')
  })

  it('ToolPermissionError → tool_permission', () => {
    expect(classifyError(new ToolPermissionError('shell', 'call-2', {})).category).toBe('tool_permission')
  })

  it('Generic ToolError → unknown (catch-all needs a more specific clause)', () => {
    expect(classifyError(new ToolError('weird', 'tool', 'call-3')).category).toBe('unknown')
  })

  it('ConfigError → config', () => {
    expect(classifyError(new ConfigError('bad agent.json', 'name')).category).toBe('config')
  })
})

// ---------------------------------------------------------------------------
// Cortex connector errors
// ---------------------------------------------------------------------------

describe('classifyError — ConnectorError subclasses', () => {
  const ctx = { source: 'composio' as const, connectorId: 'notion' }

  it('ConnectorAuthExpiredError → connector_auth_expired', () => {
    const c = classifyError(new ConnectorAuthExpiredError('token expired', ctx))
    expect(c.category).toBe('connector_auth_expired')
    expect(c.userAction).toBe('reconnect-connector')
  })

  it('ConnectorRateLimitedError → connector_rate_limited, retryable, with retryAfterMs', () => {
    const c = classifyError(
      new ConnectorRateLimitedError('429', { ...ctx, retryAfterMs: 5_000 }),
    )
    expect(c.category).toBe('connector_rate_limited')
    expect(c.retryAfterMs).toBe(5_000)
  })

  it('ConnectorNetworkError → network', () => {
    expect(classifyError(new ConnectorNetworkError('DNS', ctx)).category).toBe('network')
  })

  it('ConnectorValidationError → connector_validation', () => {
    expect(classifyError(new ConnectorValidationError('bad', ctx)).category).toBe('connector_validation')
  })

  it('ConnectorVendorError → connector_vendor, retryable', () => {
    const c = classifyError(new ConnectorVendorError('502', { ...ctx, statusCode: 502 }))
    expect(c.category).toBe('connector_vendor')
    expect(c.retryable).toBe(true)
  })

  it('ConnectorNotConfiguredError → connector_not_configured', () => {
    expect(classifyError(new ConnectorNotConfiguredError('no oauth', ctx)).category).toBe('connector_not_configured')
  })
})

// ---------------------------------------------------------------------------
// Node / undici / fetch error codes
// ---------------------------------------------------------------------------

describe('classifyError — Node error codes', () => {
  function withCode(code: string, message = code): Error {
    const e = new Error(message)
    ;(e as { code: string }).code = code
    return e
  }

  it('ECONNRESET → network', () => {
    expect(classifyError(withCode('ECONNRESET')).category).toBe('network')
  })

  it('ENOTFOUND → network', () => {
    expect(classifyError(withCode('ENOTFOUND')).category).toBe('network')
  })

  it('UND_ERR_CONNECT_TIMEOUT (undici) → network', () => {
    expect(classifyError(withCode('UND_ERR_CONNECT_TIMEOUT')).category).toBe('network')
  })

  it('TypeError with "fetch failed" → network', () => {
    const e = new TypeError('fetch failed')
    expect(classifyError(e).category).toBe('network')
  })

  it('Error with name "AbortError" → aborted', () => {
    const e = new Error('cancelled')
    e.name = 'AbortError'
    expect(classifyError(e).category).toBe('aborted')
  })

  it('SQLITE_BUSY → sqlite, retryable', () => {
    const c = classifyError(withCode('SQLITE_BUSY'))
    expect(c.category).toBe('sqlite')
    expect(c.retryable).toBe(true)
    expect(c.userAction).toBe('wait-and-retry')
  })

  it('SQLITE_CORRUPT → sqlite, NOT retryable', () => {
    const c = classifyError(withCode('SQLITE_CORRUPT'))
    expect(c.category).toBe('sqlite')
    expect(c.retryable).toBe(false)
    expect(c.userAction).toBe('contact-support')
  })
})

// ---------------------------------------------------------------------------
// Cause-graph walk
// ---------------------------------------------------------------------------

describe('classifyError — cause-graph walk', () => {
  it('wraps an ENOTFOUND inside two layers of wrapping → still network', () => {
    const inner = new Error('getaddrinfo ENOTFOUND api.anthropic.com')
    ;(inner as { code: string }).code = 'ENOTFOUND'
    const middle = new Error('Failed to fetch', { cause: inner })
    const outer = new Error('Upstream request failed', { cause: middle })
    expect(classifyError(outer).category).toBe('network')
  })

  it('AggregateError-style .errors[] → first matching child wins', () => {
    const a = new Error('a')
    const b = new RateLimitError('throttled', 'anthropic')
    const aggregate = new Error('multi')
    ;(aggregate as { errors: unknown[] }).errors = [a, b]
    expect(classifyError(aggregate).category).toBe('rate_limit')
  })

  it('cyclic cause chain does not hang', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    ;(a as { cause?: unknown }).cause = b
    // No assertion on category — just must terminate.
    const c = classifyError(a)
    expect(c.category).toBe('unknown')
  })

  it('depth-cap honored: bury a known error 6 levels deep → unknown (we cap at 5)', () => {
    const buried = new RateLimitError('throttled', 'anthropic')
    const l5 = new Error('l5', { cause: buried })
    const l4 = new Error('l4', { cause: l5 })
    const l3 = new Error('l3', { cause: l4 })
    const l2 = new Error('l2', { cause: l3 })
    const l1 = new Error('l1', { cause: l2 })
    const outer = new Error('outer', { cause: l1 })
    // MAX_CAUSE_DEPTH=5; outer is depth 0, l1 depth 1, ..., l5 depth 5,
    // buried would be depth 6 → never enqueued.
    expect(classifyError(outer).category).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// Fallbacks — the `unknown` category must be reachable but rare
// ---------------------------------------------------------------------------

describe('classifyError — unknown fallback', () => {
  it('plain string throw → unknown', () => {
    expect(classifyError('oops').category).toBe('unknown')
  })

  it('plain Error with no signals → unknown', () => {
    expect(classifyError(new Error('completely novel failure shape')).category).toBe('unknown')
  })

  it('null → unknown without crashing', () => {
    const c = classifyError(null)
    expect(c.category).toBe('unknown')
    expect(c.message.length).toBeGreaterThan(0)
  })

  it('undefined → unknown without crashing', () => {
    expect(classifyError(undefined).category).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// Bounded payloads
// ---------------------------------------------------------------------------

describe('classifyError — bounded message field', () => {
  it('caps message at 2000 chars', () => {
    const long = 'x'.repeat(5_000)
    const c = classifyError(new Error(long))
    expect(c.message.length).toBeLessThanOrEqual(2_000)
  })
})
