/**
 * Unit tests — OAuth token lifecycle against the REAL credential backend.
 *
 * Driven against `DbCredentialBackend` + real migrations, with only the token
 * endpoint faked. That fake stands in for an authorization server the same way
 * a local issuer would, which is the point: the entire lifecycle is provable
 * with no account and no network.
 *
 * The properties, ordered by how expensive their failure is:
 *
 *   1. **Single-flight.** Concurrent callers trigger exactly ONE HTTP refresh.
 *      Transport tests proved the vendor SDK re-enters the fetch closure
 *      on retry, so this is a demonstrated requirement. Against a server that
 *      rotates refresh tokens on use, a lost race persists a stale refresh
 *      token over the fresh one and kills the credential permanently.
 *   2. **A denied grant kills the credential once, loudly** — never retried
 *      into a loop or a ban, and the person is told to reconnect.
 *   3. **A transport failure leaves the credential ALONE.** Treating a network
 *      blip as a dead grant would destroy a working connection.
 *   4. **Rotation persists**, so the next process sees the new token.
 *   5. Expiry is refreshed *ahead* of the wall, and a non-renewable token set
 *      says "reconnect" rather than failing opaquely.
 */

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CredentialAuditLog } from '../../../src/credential/audit.js'
import { CredentialInjector } from '../../../src/credential/injector.js'
import { DbOAuthRefreshCoordinator } from '../../../src/credential/oauth-refresh-coordinator.js'
import { GatewayCredentialResolver } from '../../../src/credential/resolver.js'
import { createSqliteCredentialSpendRepository } from '../../../src/storage/sqlite-security-repositories.js'
import { DbCredentialBackend } from '../../../src/credential/store/db-backend.js'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import {
  decodeOAuthTokenSet,
  encodeOAuthTokenSet,
  type OAuthTokenSet,
} from '../../../src/credential/oauth-token.js'
import {
  OAuthCredentialUnusableError,
  OAuthReconnectRequiredError,
  OAuthRefreshCoordinationError,
  OAuthRefreshDeniedError,
  OAuthRefreshStatePersistenceError,
  OAuthRefreshStaleWriteError,
  OAuthRefreshTransportError,
  OAuthTokenManager,
  type RefreshOutcome,
  type RefreshTokenFn,
} from '../../../src/credential/oauth-token-manager.js'

let prevHome: string | undefined
let tmpHome: string
let db: Database.Database
let store: DbCredentialBackend
let audit: CredentialAuditLog
let resolver: GatewayCredentialResolver
let injector: CredentialInjector

const CTX = { agentId: 'agent-1', sessionId: 'session-1', threadId: 'thread-1' }

/** Fixed clock so expiry maths is exact rather than racy. */
const NOW = Date.parse('2026-07-26T12:00:00.000Z')
const now = () => NOW

beforeEach(() => {
  prevHome = process.env['HOME']
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-oauth-mgr-'))
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
// helpers
// ---------------------------------------------------------------------------

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

function manager(credentialId: string, refresh: RefreshTokenFn, skewMs?: number) {
  return new OAuthTokenManager({
    store,
    resolver,
    injector,
    audit,
    credentialId,
    refresh,
    refreshCoordinator: new DbOAuthRefreshCoordinator(db),
    now,
    ...(skewMs !== undefined ? { expirySkewMs: skewMs } : {}),
  })
}

/** Expiry an hour in the past relative to the fixed clock. */
const EXPIRED = new Date(NOW - 3_600_000).toISOString()
/** Expiry an hour in the future. */
const FRESH = new Date(NOW + 3_600_000).toISOString()

function refreshRows(credentialId: string) {
  return db
    .prepare("SELECT * FROM credential_audit_log WHERE credential_id = ? AND event_type = 'refresh'")
    .all(credentialId) as Array<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// 1 — single-flight
// ---------------------------------------------------------------------------

describe('single-flight refresh', () => {
  it('coalesces concurrent callers onto exactly one HTTP refresh', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: EXPIRED })

    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })

    const refresh: RefreshTokenFn = async () => {
      calls++
      await gate // hold every caller inside the refresh window
      return { result: 'refreshed', accessToken: 'at_new', expiresAt: FRESH }
    }

    const mgr = manager(saved.id, refresh)

    // Five concurrent callers — the realistic shape when several streams
    // share one credential and the SDK retries on top of that.
    const inflight = Promise.all([
      mgr.getAccessToken(CTX),
      mgr.getAccessToken(CTX),
      mgr.getAccessToken(CTX),
      mgr.getAccessToken(CTX),
      mgr.getAccessToken(CTX),
    ])

    await vi.waitFor(() => expect(calls).toBe(1))
    release()
    const grants = await inflight

    expect(calls).toBe(1)
    for (const grant of grants) expect(grant.accessToken).toBe('at_new')
    // One rotation → one audit row, not five.
    expect(refreshRows(saved.id)).toHaveLength(1)
  })

  it('coalesces across separate managers and re-reads the winner’s rotation', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: EXPIRED })

    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const refresh: RefreshTokenFn = async () => {
      calls++
      await gate
      return {
        result: 'refreshed',
        accessToken: 'at_winner',
        refreshToken: 'rt_rotated',
        expiresAt: FRESH,
      }
    }

    const first = manager(saved.id, refresh)
    const second = manager(saved.id, refresh)
    const grants = Promise.all([
      first.getAccessToken(CTX),
      second.getAccessToken(CTX),
    ])

    await vi.waitFor(() => expect(calls).toBe(1))
    release()
    expect((await grants).map(grant => grant.accessToken)).toEqual([
      'at_winner',
      'at_winner',
    ])
    expect(calls).toBe(1)
    expect(decodeOAuthTokenSet((await store.decrypt(saved.id))!.value).refreshToken).toBe('rt_rotated')
  })

  it('does not wedge after a failed refresh — the next call retries', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: EXPIRED })

    let calls = 0
    const refresh: RefreshTokenFn = async () => {
      calls++
      if (calls === 1) return { result: 'failed', reason: 'ECONNRESET' }
      return { result: 'refreshed', accessToken: 'at_recovered', expiresAt: FRESH }
    }

    const mgr = manager(saved.id, refresh)

    await expect(mgr.getAccessToken(CTX)).rejects.toBeInstanceOf(OAuthRefreshTransportError)
    // The latch must have cleared; a transient failure is not terminal.
    const grant = await mgr.getAccessToken(CTX)
    expect(grant.accessToken).toBe('at_recovered')
    expect(calls).toBe(2)
  })

  it('starts a fresh flight for a later expiry, not a cached promise', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: EXPIRED })

    let calls = 0
    const refresh: RefreshTokenFn = async () => {
      calls++
      // Each refresh yields another already-expired token, so the next call
      // must refresh again rather than reuse the settled promise.
      return { result: 'refreshed', accessToken: `at_${calls}`, expiresAt: EXPIRED }
    }

    const mgr = manager(saved.id, refresh)
    expect((await mgr.getAccessToken(CTX)).accessToken).toBe('at_1')
    expect((await mgr.getAccessToken(CTX)).accessToken).toBe('at_2')
    expect(calls).toBe(2)
  })

  it('times out visibly when another process keeps the durable lease', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: EXPIRED })
    let clock = 1_000
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({
      result: 'refreshed',
      accessToken: 'never',
    }))
    const mgr = new OAuthTokenManager({
      store,
      resolver,
      injector,
      audit,
      credentialId: saved.id,
      refresh,
      refreshCoordinator: {
        tryAcquire: () => ({ kind: 'held', retryAt: 10_000 }),
        renew: () => null,
        release: () => false,
      },
      now,
      coordinationNow: () => clock,
      refreshWaitTimeoutMs: 10,
      refreshPollMs: 5,
      wait: async milliseconds => { clock += milliseconds },
    })

    await expect(mgr.getAccessToken(CTX)).rejects.toMatchObject({
      name: 'OAuthRefreshCoordinationError',
      reason: 'timeout',
    })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('rejects an issuer result after lease ownership is lost', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: EXPIRED })
    const mgr = manager(saved.id, async () => {
      db.prepare(`
        UPDATE oauth_refresh_leases
        SET owner_id = 'other-process',
            generation = generation + 1
        WHERE credential_id = ?
      `).run(saved.id)
      return {
        result: 'refreshed',
        accessToken: 'at_unowned',
        refreshToken: 'rt_unowned',
        expiresAt: FRESH,
      }
    })

    await expect(mgr.getAccessToken(CTX)).rejects.toBeInstanceOf(
      OAuthRefreshCoordinationError,
    )
    expect(decodeOAuthTokenSet((await store.decrypt(saved.id))!.value)).toMatchObject({
      accessToken: 'at_old',
      refreshToken: 'rt_old',
    })
  })
})

// ---------------------------------------------------------------------------
// 2 — a denied grant is terminal and loud
// ---------------------------------------------------------------------------

describe('a refusal from the authorization server kills the credential once', () => {
  it('flips the credential to revoked with a reason a person can act on', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_dead', expiresAt: EXPIRED })
    const mgr = manager(saved.id, async () => ({ result: 'denied', reason: 'invalid_grant' }))

    await expect(mgr.getAccessToken(CTX)).rejects.toBeInstanceOf(OAuthRefreshDeniedError)

    const after = await store.get(saved.id)
    expect(after?.status).toBe('revoked')
    expect(after?.statusReason).toMatch(/reconnect the account/i)
    expect(after?.statusReason).toContain('invalid_grant')
  })

  it('does not retry a dead grant — subsequent calls fail fast without HTTP', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_dead', expiresAt: EXPIRED })
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ result: 'denied', reason: 'invalid_grant' }))
    const mgr = manager(saved.id, refresh)

    await expect(mgr.getAccessToken(CTX)).rejects.toBeInstanceOf(OAuthRefreshDeniedError)
    // Second call must be stopped by the revoked status, never reach the server.
    await expect(mgr.getAccessToken(CTX)).rejects.toBeInstanceOf(OAuthCredentialUnusableError)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('records the denial in the audit log without leaking token material', async () => {
    const saved = await seed({ accessToken: 'at_secret_access', refreshToken: 'rt_secret_refresh', expiresAt: EXPIRED })
    const mgr = manager(saved.id, async () => ({ result: 'denied', reason: 'invalid_grant' }))

    await expect(mgr.getAccessToken(CTX)).rejects.toThrow()

    const rows = refreshRows(saved.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!['outcome']).toBe('denied')
    const serialised = JSON.stringify(rows)
    expect(serialised).not.toContain('rt_secret_refresh')
    expect(serialised).not.toContain('at_secret_access')
  })

  it('surfaces a failed terminal-state write and quarantines later managers', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_dead', expiresAt: EXPIRED })
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({
      result: 'denied',
      reason: 'invalid_grant',
    }))
    const failingStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'updateIfUnchanged') {
          return async () => { throw new Error('disk unavailable') }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const makeManager = () => new OAuthTokenManager({
      store: failingStore,
      resolver,
      injector,
      audit,
      credentialId: saved.id,
      refresh,
      refreshCoordinator: new DbOAuthRefreshCoordinator(db),
      now,
    })

    await expect(makeManager().getAccessToken(CTX)).rejects.toBeInstanceOf(
      OAuthRefreshStatePersistenceError,
    )
    await expect(makeManager().getAccessToken(CTX)).rejects.toBeInstanceOf(
      OAuthRefreshStatePersistenceError,
    )
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 3 — a transport failure must not harm a possibly-working grant
// ---------------------------------------------------------------------------

describe('a transport failure leaves the credential untouched', () => {
  it('keeps the credential ready after a network-level failure', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: EXPIRED })
    const mgr = manager(saved.id, async () => ({ result: 'failed', reason: 'ETIMEDOUT' }))

    await expect(mgr.getAccessToken(CTX)).rejects.toBeInstanceOf(OAuthRefreshTransportError)

    const after = await store.get(saved.id)
    // NOT revoked — a blip is not evidence the grant is dead.
    expect(after?.status).toBe('ready')

    const decrypted = await store.decrypt(saved.id)
    expect(decodeOAuthTokenSet(decrypted!.value).refreshToken).toBe('rt_old')
  })

  it('treats a THROWN implementation error as transport failure, not denial', async () => {
    // The safe default: only an explicit `denied` may destroy a credential.
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: EXPIRED })
    const mgr = manager(saved.id, async () => { throw new Error('DNS exploded') })

    await expect(mgr.getAccessToken(CTX)).rejects.toBeInstanceOf(OAuthRefreshTransportError)
    expect((await store.get(saved.id))?.status).toBe('ready')
  })
})

// ---------------------------------------------------------------------------
// 4 — rotation persists
// ---------------------------------------------------------------------------

describe('rotation is persisted', () => {
  it('stores the new access token and recovers an expired status', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: EXPIRED })
    await store.update(saved.id, { status: 'expired', statusReason: 'stale' })

    const mgr = manager(saved.id, async () => ({
      result: 'refreshed', accessToken: 'at_new', expiresAt: FRESH,
    }))
    await mgr.getAccessToken(CTX)

    const after = await store.get(saved.id)
    expect(after?.status).toBe('ready')
    expect(after?.expiresAt).toBe(FRESH)

    const stored = decodeOAuthTokenSet((await store.decrypt(saved.id))!.value)
    expect(stored.accessToken).toBe('at_new')
  })

  it('keeps the old refresh token when the server does not resend it', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_keepme', expiresAt: EXPIRED })
    const mgr = manager(saved.id, async () => ({
      result: 'refreshed', accessToken: 'at_new', expiresAt: FRESH,
    }))
    await mgr.getAccessToken(CTX)

    const stored = decodeOAuthTokenSet((await store.decrypt(saved.id))!.value)
    expect(stored.refreshToken).toBe('rt_keepme')
  })

  it('adopts a rotated refresh token and never reuses the consumed one', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_1', expiresAt: EXPIRED })
    const seenRefreshTokens: string[] = []
    let n = 0

    const mgr = manager(saved.id, async (rt) => {
      seenRefreshTokens.push(rt)
      n++
      return { result: 'refreshed', accessToken: `at_${n}`, refreshToken: `rt_${n + 1}`, expiresAt: EXPIRED }
    })

    await mgr.getAccessToken(CTX)
    await mgr.getAccessToken(CTX)

    // Second refresh presented the rotated token, not the consumed one.
    expect(seenRefreshTokens).toEqual(['rt_1', 'rt_2'])
  })

  it('keeps the account id available for callers that must echo it', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: EXPIRED })
    const mgr = manager(saved.id, async () => ({
      result: 'refreshed', accessToken: 'at_new', expiresAt: FRESH,
    }))
    expect((await mgr.getAccessToken(CTX)).accountId).toBe('acct-4271')
  })

  it('writes exactly one ok audit row per successful rotation', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: EXPIRED })
    const mgr = manager(saved.id, async () => ({
      result: 'refreshed', accessToken: 'at_new', expiresAt: FRESH,
    }))
    await mgr.getAccessToken(CTX)

    const rows = refreshRows(saved.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!['outcome']).toBe('ok')
    expect(rows[0]!['agent_id']).toBe('agent-1')
  })

  it('does not overwrite an operator revocation that lands during refresh', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: EXPIRED })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const mgr = manager(saved.id, async () => {
      await gate
      return {
        result: 'refreshed',
        accessToken: 'at_stale',
        refreshToken: 'rt_stale',
        expiresAt: FRESH,
      }
    })

    const pending = mgr.getAccessToken(CTX)
    await vi.waitFor(() => {
      expect(db.prepare(
        'SELECT COUNT(*) AS count FROM oauth_refresh_leases WHERE credential_id = ?',
      ).get(saved.id)).toEqual({ count: 1 })
    })
    await store.update(saved.id, {
      status: 'revoked',
      statusReason: 'operator disconnected the account',
    })
    release()

    await expect(pending).rejects.toBeInstanceOf(OAuthRefreshStaleWriteError)
    expect((await store.get(saved.id))?.status).toBe('revoked')
    expect(decodeOAuthTokenSet((await store.decrypt(saved.id))!.value).accessToken).toBe('at_old')
  })
})

// ---------------------------------------------------------------------------
// 5 — expiry, renewability, and unusable rows
// ---------------------------------------------------------------------------

describe('expiry handling', () => {
  it('does not refresh a token that is still comfortably valid', async () => {
    const saved = await seed({ accessToken: 'at_good', refreshToken: 'rt_old', expiresAt: FRESH })
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ result: 'refreshed', accessToken: 'nope' }))

    expect((await manager(saved.id, refresh).getAccessToken(CTX)).accessToken).toBe('at_good')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes AHEAD of the wall, inside the skew window', async () => {
    // 30s before expiry, inside the default 60s skew: refresh now rather than
    // let the request be the thing that discovers the expiry.
    const soon = new Date(NOW + 30_000).toISOString()
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: soon })
    const mgr = manager(saved.id, async () => ({ result: 'refreshed', accessToken: 'at_ahead', expiresAt: FRESH }))

    expect((await mgr.getAccessToken(CTX)).accessToken).toBe('at_ahead')
  })

  it('serves a token with no declared expiry rather than refreshing blindly', async () => {
    // Unknown expiry is not evidence of expiry; a rejection later is what
    // proves it. Refreshing on every call would hammer the token endpoint.
    const saved = await seed({ accessToken: 'at_unknown_expiry', refreshToken: 'rt_old' })
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ result: 'refreshed', accessToken: 'nope' }))

    expect((await manager(saved.id, refresh).getAccessToken(CTX)).accessToken).toBe('at_unknown_expiry')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('tells the person to reconnect when an expired set cannot be renewed', async () => {
    const saved = await seed({ accessToken: 'at_old', expiresAt: EXPIRED })
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ result: 'refreshed', accessToken: 'nope' }))
    const mgr = manager(saved.id, refresh)

    await expect(mgr.getAccessToken(CTX)).rejects.toBeInstanceOf(OAuthReconnectRequiredError)
    expect(refresh).not.toHaveBeenCalled()

    const after = await store.get(saved.id)
    expect(after?.status).toBe('expired')
    expect(after?.statusReason).toMatch(/reconnect the account/i)
  })
})

// ---------------------------------------------------------------------------
// 6 — the gates an API key passes, an OAuth credential passes too (BUGS #1)
// ---------------------------------------------------------------------------

describe('an OAuth credential is not privileged over an API key', () => {
  // Regression cover for BUGS #1. The original implementation read the store
  // directly and so skipped every gate below. These assert the NEGATIVE —
  // that the gates actually run — because the earlier suite proved only what
  // the manager *did*, never what it *routed through*, and passed throughout.

  function resolveRows(credentialId: string) {
    return db
      .prepare("SELECT * FROM credential_audit_log WHERE credential_id = ? AND event_type = 'resolve'")
      .all(credentialId) as Array<Record<string, unknown>>
  }

  it('writes a resolve audit row for every access-token request', async () => {
    const saved = await seed({ accessToken: 'at_good', refreshToken: 'rt_old', expiresAt: FRESH })
    await manager(saved.id, async () => ({ result: 'refreshed', accessToken: 'x' })).getAccessToken(CTX)

    const rows = resolveRows(saved.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!['outcome']).toBe('ok')
    expect(rows[0]!['agent_id']).toBe('agent-1')
  })

  it('blocks on the trust gate when the credential is trust: high', async () => {
    const saved = await seed({ accessToken: 'at_good', refreshToken: 'rt_old', expiresAt: FRESH })
    await store.update(saved.id, { trust: 'high' })

    // No trust gate is configured on this resolver, so a `trust: 'high'`
    // credential must fail CLOSED rather than resolve unchecked. Under the
    // old direct-decrypt path this succeeded silently.
    await expect(
      manager(saved.id, async () => ({ result: 'refreshed', accessToken: 'x' })).getAccessToken(CTX),
    ).rejects.toBeInstanceOf(OAuthCredentialUnusableError)
  })

  it('records the trust denial rather than failing silently', async () => {
    const saved = await seed({ accessToken: 'at_good', refreshToken: 'rt_old', expiresAt: FRESH })
    await store.update(saved.id, { trust: 'high' })

    await expect(
      manager(saved.id, async () => ({ result: 'refreshed', accessToken: 'x' })).getAccessToken(CTX),
    ).rejects.toThrow()

    const rows = resolveRows(saved.id)
    expect(rows.some(r => r['outcome'] === 'error' || r['outcome'] === 'denied')).toBe(true)
  })

  it('still refreshes an expired credential — recoverable, not terminal', async () => {
    // The counterpart the status gate must NOT block: `expired` is exactly
    // what the refresh token exists to fix. Only `revoked`/`error` are dead.
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: EXPIRED })
    await store.update(saved.id, { status: 'expired', statusReason: 'stale' })

    const grant = await manager(saved.id, async () => ({
      result: 'refreshed', accessToken: 'at_recovered', expiresAt: FRESH,
    })).getAccessToken(CTX)

    expect(grant.accessToken).toBe('at_recovered')
    expect((await store.get(saved.id))?.status).toBe('ready')
  })
})

describe('unusable credentials fail honestly', () => {
  it('reports a missing credential rather than returning nothing', async () => {
    const mgr = manager('cred_ffffffffffff', async () => ({ result: 'refreshed', accessToken: 'x' }))
    await expect(mgr.getAccessToken(CTX)).rejects.toBeInstanceOf(OAuthCredentialUnusableError)
  })

  it('refuses a revoked credential before any network call', async () => {
    const saved = await seed({ accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: FRESH })
    await store.update(saved.id, { status: 'revoked', statusReason: 'user disconnected' })

    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ result: 'refreshed', accessToken: 'x' }))
    await expect(manager(saved.id, refresh).getAccessToken(CTX)).rejects.toMatchObject({ reason: 'revoked' })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refuses an API key stored against an oauth2 credential, and says so', async () => {
    const saved = await store.save({
      name: 'wrong shape',
      value: 'sk-ant-api03-plain-key',
      category: 'oauth',
      authType: 'oauth2',
      source: 'manual',
    })
    const mgr = manager(saved.id, async () => ({ result: 'refreshed', accessToken: 'x' }))

    await expect(mgr.getAccessToken(CTX)).rejects.toMatchObject({ reason: 'not-a-token-set' })
    // Recorded, because this is a wiring bug someone has to see.
    expect(refreshRows(saved.id)).toHaveLength(1)
  })
})
