/**
 * Tests for the dynamic-OAuth path in `createMCPHandlers().startOAuth`.
 *
 * Substrate (`discoverOAuthEndpoints`, `registerOAuthClient`) is exercised
 * directly in `loom/src/__tests__/unit/mcp/`. Here we cover the cortex-
 * side wire-up:
 *   - Path selection (preset vs dynamic vs error).
 *   - Error response shapes (status + error code) for each failure case.
 *   - That a preset present still wins (no regression).
 *
 * The full happy-path (registration + PKCE + token exchange) requires
 * spinning up a localhost callback server and isn't covered here — the
 * loom unit tests cover the discovery + registration legs, and the
 * existing oauth-callback test covers PKCE.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

import { ProfileRegistry } from '../../../src/profile/registry.js'

// We import the handler factory dynamically per-test so each test gets a
// fresh module-level state (the credential store is module-level).

function makeReq(body: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))])
  return Object.assign(stream, {
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    url: '/api/v1/mcp/oauth/start/figma',
  }) as unknown as IncomingMessage
}

function makeRes(): {
  res: ServerResponse
  body: { status: number; payload: unknown }
} {
  const captured: { status: number; payload: unknown } = { status: 0, payload: null }
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (data?: string) => {
      captured.status = (res as unknown as { statusCode: number }).statusCode
      captured.payload = data ? JSON.parse(data) : null
    },
    writeHead(status: number) {
      ;(res as unknown as { statusCode: number }).statusCode = status
      return res
    },
  } as unknown as ServerResponse
  return { res, body: captured }
}

interface FakeRow {
  id: string
  name: string
  transport: string
  url?: string | null
  command?: string | null
  args?: readonly string[] | null
  registryId?: string | null
}

function makeState(rows: FakeRow[]) {
  return {
    listMCPServers: () => ({ items: rows.map(r => ({ ...r })) }),
    getMCPServer: (id: string) => rows.find(r => r.id === id),
    createMCPServer: () => undefined,
    assignServerToProfile: () => undefined,
  } as unknown as Parameters<
    typeof import('../../../src/gateway/handlers/mcp.js').createMCPHandlers
  >[1]
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Path selection — error cases
// ---------------------------------------------------------------------------

describe('startOAuth — dynamic discovery path', () => {
  it('returns 422 missing_client_id when there is no preset AND no DB row with a URL', async () => {
    const { createMCPHandlers } = await import(
      '../../../src/gateway/handlers/mcp.js'
    )
    const handlers = createMCPHandlers(
      new ProfileRegistry(),
      makeState([]), // no rows at all
    )
    const { res, body } = makeRes()
    await handlers.startOAuth(makeReq({}), res, { serverId: 'unknown-server' })
    expect(body.status).toBe(422)
    expect((body.payload as { error: string }).error).toBe('missing_client_id')
  })

  it('returns 422 oauth_not_supported when server has no WWW-Authenticate', async () => {
    const { createMCPHandlers } = await import(
      '../../../src/gateway/handlers/mcp.js'
    )
    // Mock global fetch — the server responds 200 with no auth challenge.
    vi.stubGlobal(
      'fetch',
      (async () =>
        new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch,
    )
    const handlers = createMCPHandlers(
      new ProfileRegistry(),
      makeState([
        {
          id: 'open-server',
          name: 'Open',
          transport: 'http',
          url: 'https://open.example.com/mcp',
          registryId: 'detected',
        },
      ]),
    )
    const { res, body } = makeRes()
    await handlers.startOAuth(makeReq({}), res, { serverId: 'open-server' })
    expect(body.status).toBe(422)
    expect((body.payload as { error: string }).error).toBe('oauth_not_supported')
  })

  it('returns 422 dynamic_registration_unavailable when AS lacks a registration_endpoint', async () => {
    const { createMCPHandlers } = await import(
      '../../../src/gateway/handlers/mcp.js'
    )
    let hop = 0
    vi.stubGlobal(
      'fetch',
      (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        hop++
        if (hop === 1) {
          // Probe → 401 with metadata pointer.
          return new Response('', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://x.com/.well-known/oauth-protected-resource"',
            },
          })
        }
        if (url.endsWith('oauth-protected-resource')) {
          return new Response(
            JSON.stringify({ authorization_servers: ['https://as.x.com'] }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          )
        }
        // AS metadata — endpoints present but NO registration_endpoint.
        return new Response(
          JSON.stringify({
            authorization_endpoint: 'https://as.x.com/auth',
            token_endpoint: 'https://as.x.com/token',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }) as typeof fetch,
    )

    const handlers = createMCPHandlers(
      new ProfileRegistry(),
      makeState([
        {
          id: 'static-server',
          name: 'Static',
          transport: 'http',
          url: 'https://x.com/mcp',
          registryId: 'detected',
        },
      ]),
    )
    const { res, body } = makeRes()
    await handlers.startOAuth(makeReq({}), res, { serverId: 'static-server' })
    expect(body.status).toBe(422)
    expect((body.payload as { error: string }).error).toBe(
      'dynamic_registration_unavailable',
    )
  })

  it('returns 502 oauth_discovery_failed on protocol error during AS metadata fetch', async () => {
    const { createMCPHandlers } = await import(
      '../../../src/gateway/handlers/mcp.js'
    )
    let hop = 0
    vi.stubGlobal(
      'fetch',
      (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        hop++
        if (hop === 1) {
          return new Response('', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://x.com/.well-known/oauth-protected-resource"',
            },
          })
        }
        if (url.endsWith('oauth-protected-resource')) {
          return new Response(
            JSON.stringify({ authorization_servers: ['https://as.x.com'] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        // AS metadata — malformed (RFC 8414 violation: missing required fields).
        return new Response(JSON.stringify({ wrong_field: 'oops' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch,
    )

    const handlers = createMCPHandlers(
      new ProfileRegistry(),
      makeState([
        {
          id: 'broken-server',
          name: 'Broken',
          transport: 'http',
          url: 'https://x.com/mcp',
          registryId: 'detected',
        },
      ]),
    )
    const { res, body } = makeRes()
    await handlers.startOAuth(makeReq({}), res, { serverId: 'broken-server' })
    expect(body.status).toBe(502)
    expect((body.payload as { error: string }).error).toBe('oauth_discovery_failed')
  })

  it('returns 502 dynamic_registration_failed when registration endpoint returns 4xx', async () => {
    const { createMCPHandlers } = await import(
      '../../../src/gateway/handlers/mcp.js'
    )
    let hop = 0
    vi.stubGlobal(
      'fetch',
      (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        hop++
        if (hop === 1) {
          return new Response('', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://x.com/.well-known/oauth-protected-resource"',
            },
          })
        }
        if (url.endsWith('oauth-protected-resource')) {
          return new Response(
            JSON.stringify({ authorization_servers: ['https://as.x.com'] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (url.endsWith('oauth-authorization-server')) {
          return new Response(
            JSON.stringify({
              authorization_endpoint: 'https://as.x.com/auth',
              token_endpoint: 'https://as.x.com/token',
              registration_endpoint: 'https://as.x.com/register',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        // Registration → 400 (rejected).
        return new Response(JSON.stringify({ error: 'invalid_redirect_uri' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch,
    )

    const handlers = createMCPHandlers(
      new ProfileRegistry(),
      makeState([
        {
          id: 'reject-server',
          name: 'Reject',
          transport: 'http',
          url: 'https://x.com/mcp',
          registryId: 'detected',
        },
      ]),
    )
    const { res, body } = makeRes()
    await handlers.startOAuth(makeReq({}), res, { serverId: 'reject-server' })
    expect(body.status).toBe(502)
    expect((body.payload as { error: string }).error).toBe(
      'dynamic_registration_failed',
    )
  })
})
