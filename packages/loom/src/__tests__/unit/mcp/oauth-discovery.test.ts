/**
 * Tests for `mcp/auth/oauth-discovery.ts` — the MCP 2025-03-26 dynamic
 * OAuth discovery flow.
 *
 * Each test injects a fake `fetch` impl so we exercise the protocol
 * logic without hitting the network.
 */

import { describe, it, expect } from 'vitest'

import {
  parseResourceMetadataUrl,
  probeForWWWAuthenticate,
  discoverOAuthEndpoints,
  OAuthDiscoveryError,
  __testOnly,
} from '../../../mcp/auth/oauth-discovery.js'

// ---------------------------------------------------------------------------
// fake fetch helpers
// ---------------------------------------------------------------------------

function makeResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

interface RoutedFetchEntry {
  readonly when: (url: string, init?: RequestInit) => boolean
  readonly respond: () => Response | Promise<Response>
}

function routedFetch(routes: readonly RoutedFetchEntry[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const route = routes.find(r => r.when(url, init))
    if (!route) {
      throw new Error(`routedFetch: no route matched ${url}`)
    }
    return route.respond()
  }) as typeof fetch
}

// ---------------------------------------------------------------------------
// parseResourceMetadataUrl
// ---------------------------------------------------------------------------

describe('parseResourceMetadataUrl', () => {
  it('extracts a quoted resource_metadata URL from Bearer challenge', () => {
    const header =
      'Bearer realm="figma", resource_metadata="https://api.figma.com/.well-known/oauth-protected-resource"'
    expect(parseResourceMetadataUrl(header)).toBe(
      'https://api.figma.com/.well-known/oauth-protected-resource',
    )
  })

  it('extracts an unquoted URL', () => {
    const header =
      'Bearer resource_metadata=https://api.example.com/.well-known/oauth-protected-resource'
    expect(parseResourceMetadataUrl(header)).toBe(
      'https://api.example.com/.well-known/oauth-protected-resource',
    )
  })

  it('handles multiple parameters in any order', () => {
    const header =
      'Bearer error="invalid_token", resource_metadata="https://x.com/y", error_description="..."'
    expect(parseResourceMetadataUrl(header)).toBe('https://x.com/y')
  })

  it('returns null for null or empty input', () => {
    expect(parseResourceMetadataUrl(null)).toBeNull()
    expect(parseResourceMetadataUrl('')).toBeNull()
  })

  it('returns null when resource_metadata is absent', () => {
    expect(parseResourceMetadataUrl('Bearer realm="x"')).toBeNull()
    expect(parseResourceMetadataUrl('Basic realm="x"')).toBeNull()
  })

  it('rejects non-http(s) URLs', () => {
    expect(parseResourceMetadataUrl('Bearer resource_metadata="ftp://x.com/y"')).toBeNull()
    expect(parseResourceMetadataUrl('Bearer resource_metadata="file:///etc/passwd"')).toBeNull()
  })

  it('case-insensitive on the parameter name', () => {
    expect(
      parseResourceMetadataUrl('Bearer Resource_Metadata="https://x.com/y"'),
    ).toBe('https://x.com/y')
  })
})

// ---------------------------------------------------------------------------
// probeForWWWAuthenticate
// ---------------------------------------------------------------------------

describe('probeForWWWAuthenticate', () => {
  it('returns the WWW-Authenticate header on a 401', async () => {
    const fetchImpl = routedFetch([
      {
        when: () => true,
        respond: () =>
          makeResponse('', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }),
      },
    ])
    const header = await probeForWWWAuthenticate('https://mcp.example.com/mcp', {
      fetch: fetchImpl,
    })
    expect(header).toContain('resource_metadata')
  })

  it('returns null when the server doesn\'t set the header', async () => {
    const fetchImpl = routedFetch([
      { when: () => true, respond: () => makeResponse({ ok: true }) },
    ])
    expect(
      await probeForWWWAuthenticate('https://mcp.example.com/mcp', {
        fetch: fetchImpl,
      }),
    ).toBeNull()
  })

  it('throws OAuthDiscoveryError on network failure', async () => {
    const fetchImpl = (async () => {
      throw new Error('econnrefused')
    }) as typeof fetch
    await expect(
      probeForWWWAuthenticate('https://mcp.example.com/mcp', { fetch: fetchImpl }),
    ).rejects.toBeInstanceOf(OAuthDiscoveryError)
  })

  it('uses POST with empty JSON body', async () => {
    let observedMethod = ''
    let observedBody = ''
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      observedMethod = init?.method ?? 'GET'
      observedBody = (init?.body as string) ?? ''
      return makeResponse('', { status: 401 })
    }) as typeof fetch
    await probeForWWWAuthenticate('https://x.com/mcp', { fetch: fetchImpl })
    expect(observedMethod).toBe('POST')
    expect(observedBody).toBe('{}')
  })
})

// ---------------------------------------------------------------------------
// discoverOAuthEndpoints (full 3-hop)
// ---------------------------------------------------------------------------

describe('discoverOAuthEndpoints', () => {
  it('runs the full 3-hop happy path', async () => {
    const fetchImpl = routedFetch([
      // Hop 1: probe MCP server
      {
        when: (url) => url === 'https://mcp.figma.com/mcp',
        respond: () =>
          makeResponse('', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://api.figma.com/.well-known/oauth-protected-resource"',
            },
          }),
      },
      // Hop 2: resource metadata
      {
        when: (url) =>
          url === 'https://api.figma.com/.well-known/oauth-protected-resource',
        respond: () =>
          makeResponse({
            authorization_servers: ['https://figma.com'],
          }),
      },
      // Hop 3: AS metadata
      {
        when: (url) =>
          url === 'https://figma.com/.well-known/oauth-authorization-server',
        respond: () =>
          makeResponse({
            authorization_endpoint: 'https://figma.com/oauth/mcp',
            token_endpoint: 'https://api.figma.com/v1/oauth/token',
            registration_endpoint: 'https://api.figma.com/v1/oauth/mcp/register',
            scopes_supported: ['files:read', 'comments:write'],
            code_challenge_methods_supported: ['S256'],
          }),
      },
    ])

    const result = await discoverOAuthEndpoints('https://mcp.figma.com/mcp', {
      fetch: fetchImpl,
    })

    expect(result).not.toBeNull()
    expect(result!.authorizationServerUrl).toBe('https://figma.com')
    expect(result!.authorizationEndpoint).toBe('https://figma.com/oauth/mcp')
    expect(result!.tokenEndpoint).toBe('https://api.figma.com/v1/oauth/token')
    expect(result!.registrationEndpoint).toBe(
      'https://api.figma.com/v1/oauth/mcp/register',
    )
    expect(result!.scopesSupported).toEqual(['files:read', 'comments:write'])
    expect(result!.codeChallengeMethodsSupported).toEqual(['S256'])
  })

  it('returns null when the server has no WWW-Authenticate header', async () => {
    const fetchImpl = routedFetch([
      { when: () => true, respond: () => makeResponse({ ok: true }) },
    ])
    const result = await discoverOAuthEndpoints('https://mcp.example.com/mcp', {
      fetch: fetchImpl,
    })
    expect(result).toBeNull()
  })

  it('returns null when the header lacks resource_metadata', async () => {
    const fetchImpl = routedFetch([
      {
        when: () => true,
        respond: () =>
          makeResponse('', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Bearer realm="example"' },
          }),
      },
    ])
    expect(
      await discoverOAuthEndpoints('https://x.com/mcp', { fetch: fetchImpl }),
    ).toBeNull()
  })

  it('throws when resource metadata is malformed', async () => {
    const fetchImpl = routedFetch([
      {
        when: (url) => url === 'https://mcp.example.com/mcp',
        respond: () =>
          makeResponse('', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://x.com/.well-known/oauth-protected-resource"',
            },
          }),
      },
      {
        when: (url) => url.endsWith('oauth-protected-resource'),
        respond: () =>
          makeResponse({ wrong_field: 'not RFC 9728' }),
      },
    ])
    await expect(
      discoverOAuthEndpoints('https://mcp.example.com/mcp', { fetch: fetchImpl }),
    ).rejects.toBeInstanceOf(OAuthDiscoveryError)
  })

  it('throws when AS metadata is malformed', async () => {
    const fetchImpl = routedFetch([
      {
        when: (url) => url === 'https://x.com/mcp',
        respond: () =>
          makeResponse('', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://x.com/.well-known/oauth-protected-resource"',
            },
          }),
      },
      {
        when: (url) => url.endsWith('oauth-protected-resource'),
        respond: () => makeResponse({ authorization_servers: ['https://as.x.com'] }),
      },
      {
        when: (url) => url.endsWith('oauth-authorization-server'),
        respond: () => makeResponse({ /* missing required fields */ }),
      },
    ])
    await expect(
      discoverOAuthEndpoints('https://x.com/mcp', { fetch: fetchImpl }),
    ).rejects.toBeInstanceOf(OAuthDiscoveryError)
  })

  it('handles AS issuer with trailing slash', async () => {
    expect(
      __testOnly.buildAuthorizationServerMetadataUrl('https://figma.com/'),
    ).toBe('https://figma.com/.well-known/oauth-authorization-server')
    expect(
      __testOnly.buildAuthorizationServerMetadataUrl('https://figma.com'),
    ).toBe('https://figma.com/.well-known/oauth-authorization-server')
  })

  it('returns null registrationEndpoint when AS doesn\'t advertise it', async () => {
    const fetchImpl = routedFetch([
      {
        when: (url) => url === 'https://x.com/mcp',
        respond: () =>
          makeResponse('', {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://x.com/m"',
            },
          }),
      },
      {
        when: (url) => url === 'https://x.com/m',
        respond: () => makeResponse({ authorization_servers: ['https://as.x.com'] }),
      },
      {
        when: (url) => url === 'https://as.x.com/.well-known/oauth-authorization-server',
        respond: () =>
          makeResponse({
            authorization_endpoint: 'https://as.x.com/auth',
            token_endpoint: 'https://as.x.com/token',
            // No registration_endpoint — AS doesn't support dynamic reg.
          }),
      },
    ])
    const result = await discoverOAuthEndpoints('https://x.com/mcp', { fetch: fetchImpl })
    expect(result).not.toBeNull()
    expect(result!.registrationEndpoint).toBeNull()
  })
})
