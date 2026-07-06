/**
 * Tests for `mcp/auth/dynamic-client-registration.ts` — RFC 7591 dynamic
 * client registration.
 */

import { describe, it, expect } from 'vitest'

import {
  registerOAuthClient,
  DynamicClientRegistrationError,
} from '../../../mcp/auth/dynamic-client-registration.js'

function makeResponse(
  body: unknown,
  init: { status?: number } = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('registerOAuthClient', () => {
  it('happy path: returns issued client_id and echoes redirect URIs', async () => {
    const fetchImpl = (async () =>
      makeResponse({
        client_id: 'figma-mcp-abc123',
        redirect_uris: ['http://localhost:8765/callback'],
      })) as typeof fetch

    const result = await registerOAuthClient(
      'https://api.figma.com/v1/oauth/mcp/register',
      {
        redirectUris: ['http://localhost:8765/callback'],
        scopes: ['files:read'],
      },
      { fetch: fetchImpl },
    )
    expect(result.clientId).toBe('figma-mcp-abc123')
    expect(result.clientSecret).toBeNull()
    expect(result.redirectUris).toEqual(['http://localhost:8765/callback'])
  })

  it('captures client_secret when issued (confidential client)', async () => {
    const fetchImpl = (async () =>
      makeResponse({
        client_id: 'cid',
        client_secret: 'shh-very-secret',
        client_id_issued_at: 1700000000,
        client_secret_expires_at: 1800000000,
        redirect_uris: ['http://localhost:8765/callback'],
      })) as typeof fetch

    const result = await registerOAuthClient(
      'https://example.com/register',
      {
        redirectUris: ['http://localhost:8765/callback'],
        scopes: ['read'],
        tokenEndpointAuthMethod: 'client_secret_basic',
      },
      { fetch: fetchImpl },
    )
    expect(result.clientId).toBe('cid')
    expect(result.clientSecret).toBe('shh-very-secret')
    expect(result.clientIdIssuedAt).toBe(1700000000)
    expect(result.clientSecretExpiresAt).toBe(1800000000)
  })

  it('sends correct request body shape per RFC 7591', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string)
      return makeResponse({
        client_id: 'cid',
        redirect_uris: ['http://localhost:8765/callback'],
      })
    }) as typeof fetch

    await registerOAuthClient(
      'https://example.com/register',
      {
        redirectUris: ['http://localhost:8765/callback'],
        scopes: ['files:read', 'comments:write'],
        clientName: 'Cortex',
        clientUri: 'https://ownware.dev',
        tokenEndpointAuthMethod: 'none',
      },
      { fetch: fetchImpl },
    )

    expect(capturedBody.redirect_uris).toEqual(['http://localhost:8765/callback'])
    expect(capturedBody.grant_types).toEqual(['authorization_code'])
    expect(capturedBody.response_types).toEqual(['code'])
    // Scopes joined as a single space-separated string per RFC.
    expect(capturedBody.scope).toBe('files:read comments:write')
    expect(capturedBody.client_name).toBe('Cortex')
    expect(capturedBody.client_uri).toBe('https://ownware.dev')
    expect(capturedBody.token_endpoint_auth_method).toBe('none')
  })

  it('throws DynamicClientRegistrationError on non-2xx', async () => {
    const fetchImpl = (async () =>
      makeResponse({ error: 'invalid_redirect_uri' }, { status: 400 })) as typeof fetch

    await expect(
      registerOAuthClient(
        'https://example.com/register',
        { redirectUris: ['http://localhost:8765/callback'], scopes: [] },
        { fetch: fetchImpl },
      ),
    ).rejects.toBeInstanceOf(DynamicClientRegistrationError)
  })

  it('throws on malformed response (missing client_id)', async () => {
    const fetchImpl = (async () =>
      makeResponse({ wrong: 'response' })) as typeof fetch
    await expect(
      registerOAuthClient(
        'https://example.com/register',
        { redirectUris: ['http://localhost:8765/callback'], scopes: [] },
        { fetch: fetchImpl },
      ),
    ).rejects.toBeInstanceOf(DynamicClientRegistrationError)
  })

  it('throws on non-JSON response', async () => {
    const fetchImpl = (async () =>
      new Response('<html>upstream error</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })) as typeof fetch
    await expect(
      registerOAuthClient(
        'https://example.com/register',
        { redirectUris: ['http://localhost:8765/callback'], scopes: [] },
        { fetch: fetchImpl },
      ),
    ).rejects.toBeInstanceOf(DynamicClientRegistrationError)
  })

  it('throws on network failure', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection reset')
    }) as typeof fetch
    await expect(
      registerOAuthClient(
        'https://example.com/register',
        { redirectUris: ['http://localhost:8765/callback'], scopes: [] },
        { fetch: fetchImpl },
      ),
    ).rejects.toBeInstanceOf(DynamicClientRegistrationError)
  })

  it('rejects empty redirectUris before making any request', async () => {
    let fetchCalls = 0
    const fetchImpl = (async () => {
      fetchCalls++
      return makeResponse({})
    }) as typeof fetch

    await expect(
      registerOAuthClient(
        'https://example.com/register',
        { redirectUris: [], scopes: [] },
        { fetch: fetchImpl },
      ),
    ).rejects.toBeInstanceOf(DynamicClientRegistrationError)
    expect(fetchCalls).toBe(0)
  })

  it('does not include optional fields when not provided', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string)
      return makeResponse({
        client_id: 'cid',
        redirect_uris: ['http://localhost:8765/callback'],
      })
    }) as typeof fetch

    await registerOAuthClient(
      'https://example.com/register',
      {
        redirectUris: ['http://localhost:8765/callback'],
        scopes: ['x'],
      },
      { fetch: fetchImpl },
    )

    expect(capturedBody.client_name).toBeUndefined()
    expect(capturedBody.client_uri).toBeUndefined()
    expect(capturedBody.token_endpoint_auth_method).toBeUndefined()
  })

  it('falls back to request redirect URIs when AS omits them', async () => {
    const fetchImpl = (async () =>
      makeResponse({
        client_id: 'cid',
        // No redirect_uris in response (some ASes don't echo them).
      })) as typeof fetch

    const result = await registerOAuthClient(
      'https://example.com/register',
      {
        redirectUris: ['http://localhost:8765/callback'],
        scopes: [],
      },
      { fetch: fetchImpl },
    )
    expect(result.redirectUris).toEqual(['http://localhost:8765/callback'])
  })
})
