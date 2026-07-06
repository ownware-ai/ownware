/**
 * Tests for ComposioClient. Mocks `fetch` directly — no network I/O.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  ComposioClient,
  isLikelyUserScopedComposioKey,
  type ComposioConnectedAccountStatus,
} from '../../../../src/connector/composio/client.js'
import {
  ConnectorAuthExpiredError,
  ConnectorNetworkError,
  ConnectorNotConfiguredError,
  ConnectorRateLimitedError,
  ConnectorValidationError,
  ConnectorVendorError,
} from '../../../../src/connector/errors.js'

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockJsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function makeClient(fetchImpl: typeof fetch, opts: Partial<Parameters<typeof ComposioClient.prototype.toString>[0]> = {}) {
  return new ComposioClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    fetch: fetchImpl,
    // fast retries for tests
    sleep: () => Promise.resolve(),
    maxRetries: 2,
    ...opts,
  })
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('ComposioClient construction', () => {
  it('throws ConnectorNotConfiguredError on empty apiKey', () => {
    expect(() => new ComposioClient({ apiKey: '' })).toThrow(ConnectorNotConfiguredError)
    expect(() => new ComposioClient({ apiKey: '   ' })).toThrow(ConnectorNotConfiguredError)
  })

  it('toString does not leak the api key', () => {
    const c = new ComposioClient({ apiKey: 'super-secret-key-xyz', baseUrl: 'https://example.test' })
    expect(c.toString()).not.toContain('super-secret-key-xyz')
    expect(c.toString()).toContain('https://example.test')
  })
})

// ---------------------------------------------------------------------------
// User-scoped CLI key guard (BUGS.md #4)
// ---------------------------------------------------------------------------

describe('isLikelyUserScopedComposioKey', () => {
  it('flags Composio CLI user-scoped keys (uak_ prefix)', () => {
    // These are the values `composio login` writes to
    // ~/.composio/user_data.json. They authenticate the CLI session
    // and 401 against the SDK / v3 API.
    expect(isLikelyUserScopedComposioKey('uak_abc123xyz')).toBe(true)
    expect(isLikelyUserScopedComposioKey('  uak_padded_with_spaces  ')).toBe(true)
    expect(isLikelyUserScopedComposioKey('uak_with-dashes_and_underscores-09')).toBe(true)
  })

  it('allows project-scoped keys (ak_ prefix) and unknown shapes', () => {
    // ak_* is the project-scoped key minted by `composio dev init`.
    expect(isLikelyUserScopedComposioKey('ak_abc123xyz')).toBe(false)
    // Conservative on unknown formats — Composio may add new key
    // types we don't recognize. We only reject the known-bad case.
    expect(isLikelyUserScopedComposioKey('sk_legacy')).toBe(false)
    expect(isLikelyUserScopedComposioKey('cmp_xyz')).toBe(false)
    expect(isLikelyUserScopedComposioKey('plain-string-no-prefix')).toBe(false)
  })

  it('rejects empty / non-string inputs without throwing', () => {
    expect(isLikelyUserScopedComposioKey('')).toBe(false)
    expect(isLikelyUserScopedComposioKey(null)).toBe(false)
    expect(isLikelyUserScopedComposioKey(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Success + Zod validation
// ---------------------------------------------------------------------------

describe('ComposioClient happy paths', () => {
  it('getAuthConfig parses valid response', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(200, {
      id: 'ac_123',
      is_composio_managed: true,
      toolkit: { slug: 'github', logo: 'https://x/y.png' },
    }))
    const client = makeClient(fetchMock)
    const result = await client.getAuthConfig('ac_123')
    expect(result.id).toBe('ac_123')
    expect(result.toolkit.slug).toBe('github')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://example.test/api/v3/auth_configs/ac_123')
    expect((init as RequestInit).method).toBe('GET')
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': 'test-key' })
  })

  it('listAuthConfigs supports filters', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(200, { items: [] }))
    await makeClient(fetchMock).listAuthConfigs({ toolkitSlug: 'github', isComposioManaged: true, limit: 5 })
    const url = String(fetchMock.mock.calls[0]![0])
    expect(url).toContain('toolkit_slug=github')
    expect(url).toContain('is_composio_managed=true')
    expect(url).toContain('limit=5')
  })

  it('createConnectionLink sends body + parses response', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(201, {
      link_token: 'tok_1',
      redirect_url: 'https://auth/url',
      expires_at: '2026-04-13T00:00:00Z',
      connected_account_id: 'ca_1',
    }))
    const link = await makeClient(fetchMock).createConnectionLink({
      authConfigId: 'ac_1', userId: 'u_1', callbackUrl: 'https://cb/x',
    })
    expect(link.connected_account_id).toBe('ca_1')
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body).toEqual({
      auth_config_id: 'ac_1',
      user_id: 'u_1',
      callback_url: 'https://cb/x',
    })
  })

  it('getConnectedAccount parses status enum', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(200, {
      id: 'ca_1',
      toolkit: { slug: 'github' },
      auth_config: { id: 'ac_1', is_composio_managed: true },
      status: 'ACTIVE' satisfies ComposioConnectedAccountStatus,
    }))
    const ca = await makeClient(fetchMock).getConnectedAccount('ca_1')
    expect(ca.status).toBe('ACTIVE')
  })

  it('executeTool serializes input correctly', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(200, {
      data: { ok: true }, error: null, successful: true,
    }))
    const res = await makeClient(fetchMock).executeTool('GITHUB_LIST_REPOS', {
      connectedAccountId: 'ca_1', arguments: { q: 'test' },
    })
    expect(res.successful).toBe(true)
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))
    expect(body).toEqual({ connected_account_id: 'ca_1', arguments: { q: 'test' } })
  })
})

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('ComposioClient error classification', () => {
  it('maps 401 to ConnectorAuthExpiredError', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(401, { message: 'Invalid API key' }))
    await expect(makeClient(fetchMock).getAuthConfig('ac_1'))
      .rejects.toBeInstanceOf(ConnectorAuthExpiredError)
  })

  it('maps 403 to ConnectorAuthExpiredError', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(403, { message: 'forbidden' }))
    await expect(makeClient(fetchMock).getAuthConfig('ac_1'))
      .rejects.toBeInstanceOf(ConnectorAuthExpiredError)
  })

  it('maps 429 to ConnectorRateLimitedError with retryAfter', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(429, { message: 'too many' }, { 'retry-after': '2' }))
    const err = await makeClient(fetchMock, { maxRetries: 0 })
      .getAuthConfig('ac_1')
      .catch(e => e)
    expect(err).toBeInstanceOf(ConnectorRateLimitedError)
    expect((err as ConnectorRateLimitedError).retryAfterMs).toBe(2000)
  })

  it('maps 4xx (other) to ConnectorValidationError', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(400, { message: 'bad' }))
    await expect(makeClient(fetchMock).getAuthConfig('ac_1'))
      .rejects.toBeInstanceOf(ConnectorValidationError)
  })

  it('maps 5xx to ConnectorVendorError after exhausting retries', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(500, { message: 'boom' }))
    const err = await makeClient(fetchMock, { maxRetries: 2 })
      .getAuthConfig('ac_1').catch(e => e)
    expect(err).toBeInstanceOf(ConnectorVendorError)
    expect((err as ConnectorVendorError).statusCode).toBe(500)
    // 1 initial + 2 retries = 3 calls
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('network throw becomes ConnectorNetworkError after retries', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('network down') })
    const err = await makeClient(fetchMock, { maxRetries: 2 })
      .getAuthConfig('ac_1').catch(e => e)
    expect(err).toBeInstanceOf(ConnectorNetworkError)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('schema mismatch throws ConnectorVendorError (no retry)', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(200, { wrong: 'shape' }))
    const err = await makeClient(fetchMock, { maxRetries: 2 })
      .getAuthConfig('ac_1').catch(e => e)
    expect(err).toBeInstanceOf(ConnectorVendorError)
    // Zod mismatch MUST NOT retry.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Retry rules
// ---------------------------------------------------------------------------

describe('ComposioClient retry policy', () => {
  it('retries 500 twice then succeeds', async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(mockJsonResponse(500, { message: 'boom' }))
    fetchMock.mockResolvedValueOnce(mockJsonResponse(500, { message: 'boom' }))
    fetchMock.mockResolvedValueOnce(mockJsonResponse(200, {
      id: 'ac', is_composio_managed: true, toolkit: { slug: 's', logo: 'x' },
    }))
    const result = await makeClient(fetchMock, { maxRetries: 2 }).getAuthConfig('ac')
    expect(result.id).toBe('ac')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('never retries POST (createConnectionLink) on 500', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(500, { message: 'down' }))
    await expect(
      makeClient(fetchMock, { maxRetries: 2 }).createConnectionLink({
        authConfigId: 'ac', userId: 'u',
      }),
    ).rejects.toBeInstanceOf(ConnectorVendorError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never retries POST (createConnectionLink) on network error', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('down') })
    await expect(
      makeClient(fetchMock, { maxRetries: 2 }).createConnectionLink({
        authConfigId: 'ac', userId: 'u',
      }),
    ).rejects.toBeInstanceOf(ConnectorNetworkError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Input validation (client-side)
// ---------------------------------------------------------------------------

describe('ComposioClient input validation', () => {
  it('createConnectionLink missing authConfigId throws ConnectorValidationError', async () => {
    const c = makeClient(vi.fn())
    await expect(c.createConnectionLink({ authConfigId: '', userId: 'u' }))
      .rejects.toBeInstanceOf(ConnectorValidationError)
  })
  it('getAuthConfig("") throws', async () => {
    const c = makeClient(vi.fn())
    await expect(c.getAuthConfig('')).rejects.toBeInstanceOf(ConnectorValidationError)
  })
})

// ---------------------------------------------------------------------------
// getSessionInfo (workspace identity)
// ---------------------------------------------------------------------------

describe('ComposioClient.getSessionInfo', () => {
  it('parses a valid /auth/session/info response', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(200, {
      project: {
        name: 'my_workspace_first_project',
        id: 'uuid-1',
        org_id: 'uuid-2',
        nano_id: 'pr_abc',
        org: { name: 'my_workspace', id: 'ok_abc', plan: 'HOBBY' },
      },
      org_member: { id: 'm1', email: 'x@y', name: 'x', role: 'ADMIN' },
      api_key: { key: 'ak_redacted', project_id: 'pr_abc' },
    }))
    const client = makeClient(fetchMock)
    const info = await client.getSessionInfo()
    expect(info.project.name).toBe('my_workspace_first_project')
    expect(info.project.org.name).toBe('my_workspace')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://example.test/api/v3/auth/session/info')
    expect((init as RequestInit).method).toBe('GET')
  })

  it('401 surfaces as ConnectorAuthExpiredError', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(401, { error: { message: 'nope' } }))
    await expect(makeClient(fetchMock, { maxRetries: 0 }).getSessionInfo())
      .rejects.toBeInstanceOf(ConnectorAuthExpiredError)
  })

  it('5xx exhausts retries then surfaces ConnectorVendorError', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(500, { error: { message: 'boom' } }))
    await expect(makeClient(fetchMock, { maxRetries: 1 }).getSessionInfo())
      .rejects.toBeInstanceOf(ConnectorVendorError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('malformed shape fails Zod and surfaces ConnectorVendorError', async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(200, { project: { name: 'p' } /* missing org */ }))
    await expect(makeClient(fetchMock).getSessionInfo())
      .rejects.toBeInstanceOf(ConnectorVendorError)
  })

  it('network error surfaces ConnectorNetworkError', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNRESET') })
    await expect(makeClient(fetchMock, { maxRetries: 0 }).getSessionInfo())
      .rejects.toBeInstanceOf(ConnectorNetworkError)
  })
})
