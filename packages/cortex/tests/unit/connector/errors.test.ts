import { describe, it, expect } from 'vitest'
import {
  ConnectorError,
  ConnectorAuthExpiredError,
  ConnectorRateLimitedError,
  ConnectorNetworkError,
  ConnectorValidationError,
  ConnectorVendorError,
  ConnectorNotConfiguredError,
  ConnectorErrorMetadataSchema,
  isConnectorError,
} from '../../../src/connector/errors.js'

describe('ConnectorError hierarchy', () => {
  it('every subclass is instantiable with the right code', () => {
    const cases = [
      [new ConnectorAuthExpiredError('x', { source: 'composio' }), 'auth_expired'],
      [new ConnectorRateLimitedError('x', { source: 'composio' }), 'rate_limited'],
      [new ConnectorNetworkError('x', { source: 'composio' }), 'network'],
      [new ConnectorValidationError('x', { source: 'composio' }), 'validation'],
      [new ConnectorVendorError('x', { source: 'composio' }), 'vendor'],
      [new ConnectorNotConfiguredError('x', { source: 'composio' }), 'not_configured'],
    ] as const
    for (const [err, code] of cases) {
      expect(err.code).toBe(code)
      expect(err).toBeInstanceOf(ConnectorError)
      expect(err).toBeInstanceOf(Error)
    }
  })

  it('instanceof narrowing works across async boundaries', async () => {
    async function throws() { throw new ConnectorAuthExpiredError('expired', { source: 'composio', connectorId: 'notion' }) }
    try { await throws() } catch (err) {
      expect(isConnectorError(err)).toBe(true)
      expect(err).toBeInstanceOf(ConnectorAuthExpiredError)
      expect((err as ConnectorAuthExpiredError).connectorId).toBe('notion')
    }
  })

  it('toMetadata includes code + message + source', () => {
    const err = new ConnectorAuthExpiredError('oauth expired', { source: 'composio', connectorId: 'notion' })
    const meta = err.toMetadata()
    expect(meta).toMatchObject({ code: 'auth_expired', message: 'oauth expired', source: 'composio', connectorId: 'notion' })
    expect(() => ConnectorErrorMetadataSchema.parse(meta)).not.toThrow()
  })

  it('rate-limited carries retryAfterMs', () => {
    const err = new ConnectorRateLimitedError('slow down', { source: 'composio', retryAfterMs: 5000 })
    expect(err.retryAfterMs).toBe(5000)
    expect(err.toMetadata().retryAfterMs).toBe(5000)
  })

  it('validation carries fieldErrors', () => {
    const err = new ConnectorValidationError('bad input', {
      source: 'composio',
      fieldErrors: { email: 'required' },
    })
    expect(err.fieldErrors).toEqual({ email: 'required' })
    expect(err.toMetadata().fieldErrors).toEqual({ email: 'required' })
  })

  it('vendor carries statusCode', () => {
    const err = new ConnectorVendorError('bad gateway', { source: 'composio', statusCode: 502 })
    expect(err.toMetadata().statusCode).toBe(502)
  })

  it('preserves cause when provided', () => {
    const cause = new Error('underlying')
    const err = new ConnectorNetworkError('network', { source: 'composio', cause })
    expect((err as { cause?: unknown }).cause).toBe(cause)
  })

  it('toMetadata passes the Zod schema', () => {
    for (const err of [
      new ConnectorAuthExpiredError('x', { source: 'composio' }),
      new ConnectorRateLimitedError('x', { source: 'composio', retryAfterMs: 1 }),
      new ConnectorValidationError('x', { source: 'composio', fieldErrors: { k: 'v' } }),
      new ConnectorVendorError('x', { source: 'composio', statusCode: 500 }),
      new ConnectorNotConfiguredError('x', { source: 'composio' }),
    ]) {
      expect(() => ConnectorErrorMetadataSchema.parse(err.toMetadata())).not.toThrow()
    }
  })

  it('isConnectorError predicate', () => {
    expect(isConnectorError(new ConnectorNetworkError('x', { source: 'composio' }))).toBe(true)
    expect(isConnectorError(new Error('plain'))).toBe(false)
    expect(isConnectorError(null)).toBe(false)
  })
})
