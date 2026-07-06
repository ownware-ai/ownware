/**
 * classifyHttpError — turn HTTP status + body text into typed ProviderError
 * subclasses. Callers rely on the resulting `instanceof` check to decide
 * retry policy and user-facing recovery UI; getting the classification
 * wrong silently breaks both.
 */

import { describe, it, expect } from 'vitest'
import {
  ProviderError,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  UnprocessableEntityError,
  RateLimitError,
  ServiceUnavailableError,
  OverloadedError,
  ContextWindowExceededError,
  ContentPolicyError,
  classifyHttpError,
} from '../../../src/core/errors.js'

describe('classifyHttpError — by status code', () => {
  it('401 → AuthenticationError, not recoverable', () => {
    const err = classifyHttpError(401, 'invalid key', 'openai')
    expect(err).toBeInstanceOf(AuthenticationError)
    expect(err.recoverable).toBe(false)
    expect(err.statusCode).toBe(401)
  })

  it('403 → PermissionDeniedError, not recoverable', () => {
    const err = classifyHttpError(403, 'no access', 'anthropic')
    expect(err).toBeInstanceOf(PermissionDeniedError)
    expect(err.recoverable).toBe(false)
  })

  it('404 → NotFoundError, not recoverable', () => {
    const err = classifyHttpError(404, 'model not found', 'openai')
    expect(err).toBeInstanceOf(NotFoundError)
    expect(err.recoverable).toBe(false)
  })

  it('408 → generic recoverable ProviderError', () => {
    const err = classifyHttpError(408, 'timeout', 'anthropic')
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).not.toBeInstanceOf(AuthenticationError)
    expect(err.recoverable).toBe(true)
  })

  it('409 → recoverable ProviderError', () => {
    const err = classifyHttpError(409, 'conflict', 'anthropic')
    expect(err.recoverable).toBe(true)
  })

  it('422 → UnprocessableEntityError, not recoverable', () => {
    const err = classifyHttpError(422, 'bad shape', 'openai')
    expect(err).toBeInstanceOf(UnprocessableEntityError)
    expect(err.recoverable).toBe(false)
  })

  it('429 → RateLimitError, recoverable', () => {
    const err = classifyHttpError(429, 'too many', 'anthropic')
    expect(err).toBeInstanceOf(RateLimitError)
    expect(err.recoverable).toBe(true)
  })

  it('500/502/503 → ServiceUnavailableError, recoverable', () => {
    for (const code of [500, 502, 503, 504]) {
      const err = classifyHttpError(code, '', 'anthropic')
      expect(err).toBeInstanceOf(ServiceUnavailableError)
      expect(err.recoverable).toBe(true)
      expect(err.statusCode).toBe(code)
    }
  })

  it('529 → OverloadedError, recoverable', () => {
    const err = classifyHttpError(529, 'overloaded', 'anthropic')
    expect(err).toBeInstanceOf(OverloadedError)
    expect(err.recoverable).toBe(true)
  })

  it('generic 4xx (418) → unrecoverable ProviderError', () => {
    const err = classifyHttpError(418, "i'm a teapot", 'openai')
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).not.toBeInstanceOf(RateLimitError)
    expect(err.recoverable).toBe(false)
  })
})

describe('classifyHttpError — by body content on 400', () => {
  it('400 + "prompt is too long" → ContextWindowExceededError', () => {
    const err = classifyHttpError(400, 'prompt is too long: 250000 tokens > 200000 maximum', 'anthropic')
    expect(err).toBeInstanceOf(ContextWindowExceededError)
    expect(err.recoverable).toBe(false)
  })

  it('400 + "maximum context length" → ContextWindowExceededError', () => {
    const err = classifyHttpError(
      400,
      "This model's maximum context length is 128000 tokens...",
      'openai',
    )
    expect(err).toBeInstanceOf(ContextWindowExceededError)
  })

  it('400 + "context_length_exceeded" → ContextWindowExceededError', () => {
    const err = classifyHttpError(400, JSON.stringify({ code: 'context_length_exceeded' }), 'openai')
    expect(err).toBeInstanceOf(ContextWindowExceededError)
  })

  it('400 + "content_policy_violation" → ContentPolicyError', () => {
    const err = classifyHttpError(400, JSON.stringify({ code: 'content_policy_violation' }), 'openai')
    expect(err).toBeInstanceOf(ContentPolicyError)
    expect(err.recoverable).toBe(false)
  })

  it('400 + safety-policy message → ContentPolicyError', () => {
    const err = classifyHttpError(400, 'Request blocked by safety policy', 'anthropic')
    expect(err).toBeInstanceOf(ContentPolicyError)
  })

  it('400 with unrecognized body → generic unrecoverable ProviderError', () => {
    const err = classifyHttpError(400, 'malformed request', 'openai')
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).not.toBeInstanceOf(ContextWindowExceededError)
    expect(err).not.toBeInstanceOf(ContentPolicyError)
    expect(err.recoverable).toBe(false)
  })
})

describe('classifyHttpError — headers + retry-after', () => {
  it('forwards Retry-After header when provided', () => {
    const err = classifyHttpError(429, 'rate', 'openai', { retryAfterMs: 5000 })
    expect(err).toBeInstanceOf(RateLimitError)
    expect(err.retryAfterMs).toBe(5000)
  })

  it('carries headers through', () => {
    const err = classifyHttpError(500, '', 'openai', {
      headers: { 'x-request-id': 'abc' },
    })
    expect(err.headers['x-request-id']).toBe('abc')
  })
})

describe('error subclasses — defaults', () => {
  it('AuthenticationError defaults to 401', () => {
    const err = new AuthenticationError('bad key', 'openai')
    expect(err.statusCode).toBe(401)
    expect(err.recoverable).toBe(false)
    expect(err.name).toBe('AuthenticationError')
  })

  it('OverloadedError defaults to 529 and recoverable', () => {
    const err = new OverloadedError('', 'anthropic')
    expect(err.statusCode).toBe(529)
    expect(err.recoverable).toBe(true)
  })

  it('RateLimitError defaults to 429 and recoverable', () => {
    const err = new RateLimitError('', 'openai')
    expect(err.statusCode).toBe(429)
    expect(err.recoverable).toBe(true)
  })

  it('subclasses are instanceof ProviderError', () => {
    for (const E of [
      AuthenticationError,
      PermissionDeniedError,
      NotFoundError,
      UnprocessableEntityError,
      RateLimitError,
      ServiceUnavailableError,
      OverloadedError,
      ContextWindowExceededError,
      ContentPolicyError,
    ]) {
      const err = new E('x', 'test')
      expect(err).toBeInstanceOf(ProviderError)
    }
  })
})
