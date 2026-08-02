/**
 * Integration tests — engine SDK wiring powered by a stored OAuth credential.
 *
 * This is the end-to-end proof that S1 (loom transport hooks), S2 (token set in
 * the credential store) and S3 (lifecycle) compose into one working thing. The
 * whole chain runs here:
 *
 *   real OpenAIProvider → transport closure → OAuthTokenManager
 *     → real DbCredentialBackend (encrypted) → fake token endpoint
 *
 * Only two things are faked: the authorization server and the model endpoint.
 * No network, no account, no subscription — which is exactly the property the
 * board depends on, since a provider integration must be provable without
 * owning a subscription for it.
 *
 * What is proven that the unit tests could not (and no more):
 *
 *   1. A stored token is installed on an SDK-built request sent to the fake.
 *   2. An EXPIRED stored token is refreshed transparently mid-call — the caller
 *      sees a normal stream, not an error.
 *   3. The placeholder key never leaves the process.
 *   4. A dead grant surfaces to the loop as a typed ProviderError.
 */

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OpenAIProvider, ProviderError, type ProviderFetch, type ProviderRequest } from '@ownware/loom'

import { CredentialAuditLog } from '../../../src/credential/audit.js'
import { CredentialInjector } from '../../../src/credential/injector.js'
import { GatewayCredentialResolver } from '../../../src/credential/resolver.js'
import { createSqliteCredentialSpendRepository } from '../../../src/storage/sqlite-security-repositories.js'
import { DbCredentialBackend } from '../../../src/credential/store/db-backend.js'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import { encodeOAuthTokenSet, type OAuthTokenSet } from '../../../src/credential/oauth-token.js'
import { DbOAuthRefreshCoordinator } from '../../../src/credential/oauth-refresh-coordinator.js'
import { OAuthTokenManager, type RefreshTokenFn } from '../../../src/credential/oauth-token-manager.js'
import {
  OAUTH_PLACEHOLDER_KEY,
  makeOAuthTransport,
} from '../../../src/credential/oauth-transport-binding.js'
import type { QuotaSignal } from '../../../src/credential/quota.js'

let prevHome: string | undefined
let tmpHome: string
let db: Database.Database
let store: DbCredentialBackend
let audit: CredentialAuditLog
let resolver: GatewayCredentialResolver
let injector: CredentialInjector

const CTX = { agentId: 'agent-1', sessionId: 'session-1', threadId: 'thread-1' }
const NOW = Date.parse('2026-07-26T12:00:00.000Z')
const EXPIRED = new Date(NOW - 3_600_000).toISOString()
const FRESH = new Date(NOW + 3_600_000).toISOString()

beforeEach(() => {
  prevHome = process.env['HOME']
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-oauth-tx-'))
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()

  db = new Database(':memory:')
  for (const migration of MIGRATIONS) db.exec(migration.sql)
  store = new DbCredentialBackend(db)
  audit = new CredentialAuditLog(db)
  resolver = new GatewayCredentialResolver({
    store,
    audit,
    spend: createSqliteCredentialSpendRepository(db),
  })
  injector = new CredentialInjector(resolver)
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  try { db.close() } catch { /* already closed */ }
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
})

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

/** Minimal valid OpenAI chat-completions SSE stream. */
function modelResponse(text: string): Response {
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  return new Response(
    chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

async function seed(token: Partial<OAuthTokenSet> & { accessToken: string }) {
  const full: OAuthTokenSet = { accountId: 'acct-4271', ...token }
  const encoded = encodeOAuthTokenSet(full)
  return store.save({
    name: 'connected account',
    value: encoded.value,
    hint: encoded.hint,
    category: 'oauth',
    authType: 'oauth2',
    source: 'oauth-flow',
    ...(encoded.expiresAt !== undefined ? { expiresAt: encoded.expiresAt } : {}),
  })
}

function managerFor(credentialId: string, refresh: RefreshTokenFn) {
  return new OAuthTokenManager({
    store,
    resolver,
    injector,
    audit,
    credentialId,
    refresh,
    refreshCoordinator: new DbOAuthRefreshCoordinator(db),
    now: () => NOW,
  })
}

const neverRefresh: RefreshTokenFn = async () => {
  throw new Error('refresh should not have been called')
}

async function drain(stream: AsyncGenerator<{ type: string }>): Promise<string> {
  let text = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text_delta') text += (chunk as { text: string }).text
  }
  return text
}

function request(): ProviderRequest {
  return {
    model: 'gpt-4o',
    system: 'sys',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 32,
    temperature: null,
  } as unknown as ProviderRequest
}

// ---------------------------------------------------------------------------

describe('a stored OAuth credential drives an SDK request into a fake endpoint', () => {
  it('presents the stored access token as the bearer', async () => {
    const saved = await seed({ accessToken: 'at_stored', refreshToken: 'rt_old', expiresAt: FRESH })

    const seen: Array<{ url: string; auth: string | null; account: string | null }> = []
    const fetchImpl: ProviderFetch = async (input, init) => {
      const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0])
      seen.push({
        url: String(input),
        auth: headers.get('authorization'),
        account: headers.get('X-Account-Id'),
      })
      return modelResponse('hello from the model')
    }

    const transport = makeOAuthTransport({
      manager: managerFor(saved.id, neverRefresh),
      context: () => CTX,
      fetchImpl,
      // Provider-specific shaping stays with the caller, not in the binding.
      authorize: ({ headers, accountId }) => {
        if (accountId !== undefined) headers.set('X-Account-Id', accountId)
      },
    })

    const provider = new OpenAIProvider({ apiKey: OAUTH_PLACEHOLDER_KEY, ...transport })
    expect(await drain(provider.stream(request()))).toBe('hello from the model')

    expect(seen).toHaveLength(1)
    expect(seen[0]!.auth).toBe('Bearer at_stored')
    expect(seen[0]!.account).toBe('acct-4271')
  })

  it('never lets the placeholder key reach the wire', async () => {
    const saved = await seed({ accessToken: 'at_stored', refreshToken: 'rt_old', expiresAt: FRESH })
    let observed = ''

    const fetchImpl: ProviderFetch = async (_input, init) => {
      observed = JSON.stringify([...new Headers(init?.headers as ConstructorParameters<typeof Headers>[0])])
      return modelResponse('ok')
    }

    const transport = makeOAuthTransport({
      manager: managerFor(saved.id, neverRefresh), context: () => CTX, fetchImpl,
    })
    await drain(new OpenAIProvider({ apiKey: OAUTH_PLACEHOLDER_KEY, ...transport }).stream(request()))

    expect(observed).not.toContain(OAUTH_PLACEHOLDER_KEY)
    expect(observed).toContain('Bearer at_stored')
  })

  it('lets the caller redirect the request to a different endpoint', async () => {
    const saved = await seed({ accessToken: 'at_stored', refreshToken: 'rt_old', expiresAt: FRESH })
    const hit: string[] = []

    const transport = makeOAuthTransport({
      manager: managerFor(saved.id, neverRefresh),
      context: () => CTX,
      fetchImpl: async input => { hit.push(String(input)); return modelResponse('ok') },
      authorize: ({ url }) =>
        url.includes('/chat/completions')
          ? { url: 'https://alternate.invalid/backend/responses' }
          : undefined,
    })

    await drain(new OpenAIProvider({ apiKey: OAUTH_PLACEHOLDER_KEY, ...transport }).stream(request()))
    expect(hit[0]).toBe('https://alternate.invalid/backend/responses')
  })
})

// ---------------------------------------------------------------------------

describe('an expired token is refreshed transparently mid-call', () => {
  it('refreshes, then presents the NEW token — the caller sees a normal stream', async () => {
    const saved = await seed({ accessToken: 'at_expired', refreshToken: 'rt_old', expiresAt: EXPIRED })

    let refreshCalls = 0
    const refresh: RefreshTokenFn = async () => {
      refreshCalls++
      return { result: 'refreshed', accessToken: 'at_refreshed', expiresAt: FRESH }
    }

    const bearers: Array<string | null> = []
    const fetchImpl: ProviderFetch = async (_input, init) => {
      bearers.push(new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).get('authorization'))
      return modelResponse('served')
    }

    const transport = makeOAuthTransport({
      manager: managerFor(saved.id, refresh), context: () => CTX, fetchImpl,
    })

    expect(await drain(new OpenAIProvider({ apiKey: OAUTH_PLACEHOLDER_KEY, ...transport }).stream(request()))).toBe('served')

    expect(refreshCalls).toBe(1)
    expect(bearers).toEqual(['Bearer at_refreshed'])

    // The rotation was persisted, not merely used in-memory.
    expect((await store.get(saved.id))?.expiresAt).toBe(FRESH)
  })

  it('coalesces concurrent streams sharing one credential into one refresh', async () => {
    const saved = await seed({ accessToken: 'at_expired', refreshToken: 'rt_old', expiresAt: EXPIRED })

    let refreshCalls = 0
    const refresh: RefreshTokenFn = async () => {
      refreshCalls++
      await new Promise(r => setTimeout(r, 10))
      return { result: 'refreshed', accessToken: 'at_refreshed', expiresAt: FRESH }
    }

    const transport = makeOAuthTransport({
      manager: managerFor(saved.id, refresh),
      context: () => CTX,
      fetchImpl: async () => modelResponse('ok'),
    })
    const provider = new OpenAIProvider({ apiKey: OAUTH_PLACEHOLDER_KEY, ...transport })

    await Promise.all([
      drain(provider.stream(request())),
      drain(provider.stream(request())),
      drain(provider.stream(request())),
    ])

    expect(refreshCalls).toBe(1)
  })
})

// ---------------------------------------------------------------------------

describe('the provider’s own quota statement is captured from real responses', () => {
  it('reports what the provider stated, timestamped', async () => {
    const saved = await seed({ accessToken: 'at_stored', refreshToken: 'rt_old', expiresAt: FRESH })
    const seen: QuotaSignal[] = []

    const transport = makeOAuthTransport({
      manager: managerFor(saved.id, neverRefresh),
      context: () => CTX,
      onQuota: s => seen.push(s),
      onObserverFailure: () => {},
      fetchImpl: async () => {
        const res = modelResponse('ok')
        res.headers.set('anthropic-ratelimit-requests-remaining', '11')
        res.headers.set('anthropic-ratelimit-requests-limit', '1000')
        return res
      },
    })

    await drain(new OpenAIProvider({ apiKey: OAUTH_PLACEHOLDER_KEY, ...transport }).stream(request()))

    expect(seen).toHaveLength(1)
    expect(seen[0]!.state).toBe('reported')
    if (seen[0]!.state !== 'reported') return
    expect(seen[0]!.dimensions[0]).toMatchObject({ name: 'requests', remaining: 11, limit: 1000 })
  })

  it('reports unknown — not zero — when the provider states nothing', async () => {
    const saved = await seed({ accessToken: 'at_stored', refreshToken: 'rt_old', expiresAt: FRESH })
    const seen: QuotaSignal[] = []

    const transport = makeOAuthTransport({
      manager: managerFor(saved.id, neverRefresh),
      context: () => CTX,
      onQuota: s => seen.push(s),
      onObserverFailure: () => {},
      fetchImpl: async () => modelResponse('ok'),
    })

    await drain(new OpenAIProvider({ apiKey: OAUTH_PLACEHOLDER_KEY, ...transport }).stream(request()))
    expect(seen[0]).toEqual({ state: 'unknown', reason: 'provider-stated-nothing' })
  })

  it('captures exhaustion mid-conversation, and the stream still fails typed', async () => {
    // The unhappy path that reaches a real customer: her agent is answering an
    // request when the response boundary reports rate limiting.
    const saved = await seed({ accessToken: 'at_stored', refreshToken: 'rt_old', expiresAt: FRESH })
    const seen: QuotaSignal[] = []

    const transport = makeOAuthTransport({
      manager: managerFor(saved.id, neverRefresh),
      context: () => CTX,
      onQuota: s => seen.push(s),
      onObserverFailure: () => {},
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: 'rate limit' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '900' },
        }),
    })

    const provider = new OpenAIProvider({ apiKey: OAUTH_PLACEHOLDER_KEY, ...transport })
    await expect(drain(provider.stream(request()))).rejects.toBeInstanceOf(ProviderError)

    const exhausted = seen.find(s => s.state === 'rate_limited')
    expect(exhausted).toBeDefined()
    if (exhausted?.state !== 'rate_limited') return
    // She can be told when it comes back, not just that it broke.
    expect(exhausted.retryAt).toBeDefined()
  })

  it('does not let a reporting failure break a working model call', async () => {
    const saved = await seed({ accessToken: 'at_stored', refreshToken: 'rt_old', expiresAt: FRESH })
    const failures: unknown[] = []

    const transport = makeOAuthTransport({
      manager: managerFor(saved.id, neverRefresh),
      context: () => CTX,
      onQuota: () => { throw new Error('telemetry sink exploded') },
      onObserverFailure: failure => failures.push(failure),
      fetchImpl: async () => modelResponse('served anyway'),
    })

    // Observability is never worth failing a customer's answer over.
    expect(
      await drain(new OpenAIProvider({ apiKey: OAUTH_PLACEHOLDER_KEY, ...transport }).stream(request())),
    ).toBe('served anyway')
    expect(failures).toEqual([{
      code: 'quota_observer_failed',
      observer: 'quota',
    }])
  })

  it('emits a stable fallback diagnostic if both observer channels throw', async () => {
    const saved = await seed({ accessToken: 'at_stored', expiresAt: FRESH })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const transport = makeOAuthTransport({
      manager: managerFor(saved.id, neverRefresh),
      context: () => CTX,
      onQuota: () => { throw new Error('contains-private-observer-detail') },
      onObserverFailure: () => { throw new Error('diagnostic sink failed') },
      fetchImpl: async () => modelResponse('served'),
    })

    expect(
      await drain(new OpenAIProvider({ apiKey: OAUTH_PLACEHOLDER_KEY, ...transport }).stream(request())),
    ).toBe('served')
    expect(error).toHaveBeenCalledWith(
      'OAuth transport observer diagnostic failed (quota_observer_failed).',
    )
    expect(JSON.stringify(error.mock.calls)).not.toContain('private-observer')
    error.mockRestore()
  })
})

describe('a dead grant reaches the loop as a typed provider error', () => {
  it('surfaces OAuthRefreshDeniedError as a ProviderError, not a raw rejection', async () => {
    const saved = await seed({ accessToken: 'at_expired', refreshToken: 'rt_dead', expiresAt: EXPIRED })

    const transport = makeOAuthTransport({
      manager: managerFor(saved.id, async () => ({ result: 'denied', reason: 'invalid_grant' })),
      context: () => CTX,
      fetchImpl: async () => modelResponse('never reached'),
    })

    const provider = new OpenAIProvider({ apiKey: OAUTH_PLACEHOLDER_KEY, ...transport })
    await expect(drain(provider.stream(request()))).rejects.toBeInstanceOf(ProviderError)

    // And the credential was flipped so the next attempt fails fast.
    expect((await store.get(saved.id))?.status).toBe('revoked')
  })

  it('does not send a request when the token cannot be obtained', async () => {
    const saved = await seed({ accessToken: 'at_expired', refreshToken: 'rt_dead', expiresAt: EXPIRED })
    let requests = 0

    const transport = makeOAuthTransport({
      manager: managerFor(saved.id, async () => ({ result: 'denied', reason: 'invalid_grant' })),
      context: () => CTX,
      fetchImpl: async () => { requests++; return modelResponse('never') },
    })

    await expect(
      drain(new OpenAIProvider({ apiKey: OAUTH_PLACEHOLDER_KEY, ...transport }).stream(request())),
    ).rejects.toThrow()
    // An unauthorised request is worse than no request — it can burn quota or
    // trip abuse detection on the customer's account.
    expect(requests).toBe(0)
  })
})
