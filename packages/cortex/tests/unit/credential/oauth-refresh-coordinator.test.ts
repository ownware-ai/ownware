import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import { CredentialAuditLog } from '../../../src/credential/audit.js'
import { CredentialInjector } from '../../../src/credential/injector.js'
import {
  DbOAuthRefreshCoordinator,
} from '../../../src/credential/oauth-refresh-coordinator.js'
import {
  encodeOAuthTokenSet,
} from '../../../src/credential/oauth-token.js'
import {
  OAuthTokenManager,
  type RefreshTokenFn,
} from '../../../src/credential/oauth-token-manager.js'
import { GatewayCredentialResolver } from '../../../src/credential/resolver.js'
import { DbCredentialBackend } from '../../../src/credential/store/db-backend.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

describe('durable OAuth refresh coordination', () => {
  let previousHome: string | undefined
  let directory: string
  let primary: Database.Database
  let secondary: Database.Database
  let credentialId: string

  beforeEach(async () => {
    previousHome = process.env['HOME']
    directory = mkdtempSync(join(tmpdir(), 'oauth-refresh-coordinator-'))
    process.env['HOME'] = directory
    __resetMasterKeyCacheForTests()

    const path = join(directory, 'ownware.db')
    primary = new Database(path)
    primary.pragma('foreign_keys = ON')
    primary.pragma('journal_mode = WAL')
    primary.pragma('busy_timeout = 5000')
    for (const migration of MIGRATIONS) primary.exec(migration.sql)
    secondary = new Database(path)
    secondary.pragma('foreign_keys = ON')
    secondary.pragma('journal_mode = WAL')
    secondary.pragma('busy_timeout = 5000')

    const encoded = encodeOAuthTokenSet({
      accessToken: 'at_old',
      refreshToken: 'rt_old',
      expiresAt: '2026-07-26T11:00:00.000Z',
      accountId: 'acct-4271',
    })
    credentialId = (await new DbCredentialBackend(primary).save({
      name: 'connected account',
      value: encoded.value,
      hint: encoded.hint,
      category: 'oauth',
      authType: 'oauth2',
      source: 'oauth-flow',
      expiresAt: encoded.expiresAt,
    })).id
  })

  afterEach(() => {
    try { secondary.close() } catch { /* already closed */ }
    try { primary.close() } catch { /* already closed */ }
    if (previousHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = previousHome
    __resetMasterKeyCacheForTests()
    rmSync(directory, { recursive: true, force: true })
  })

  it('serializes two independent database connections by credential', () => {
    const first = new DbOAuthRefreshCoordinator(primary, 'owner-a')
    const second = new DbOAuthRefreshCoordinator(secondary, 'owner-b')

    const acquired = first.tryAcquire(credentialId, 1_000, 500)
    expect(acquired.kind).toBe('acquired')
    const held = second.tryAcquire(credentialId, 1_100, 500)
    expect(held).toEqual({ kind: 'held', retryAt: 1_500 })

    if (acquired.kind !== 'acquired') return
    expect(first.release(acquired.lease)).toBe(true)
    expect(second.tryAcquire(credentialId, 1_101, 500).kind).toBe('acquired')
  })

  it('renews only for the current owner and fences a stale release', () => {
    const first = new DbOAuthRefreshCoordinator(primary, 'owner-a')
    const second = new DbOAuthRefreshCoordinator(secondary, 'owner-b')
    const acquired = first.tryAcquire(credentialId, 1_000, 100)
    if (acquired.kind !== 'acquired') throw new Error('expected first lease')

    const renewed = first.renew(acquired.lease, 1_050, 100)
    expect(renewed?.expiresAt).toBe(1_150)
    expect(second.tryAcquire(credentialId, 1_149, 100).kind).toBe('held')

    const takeover = second.tryAcquire(credentialId, 1_150, 100)
    expect(takeover.kind).toBe('acquired')
    expect(first.release(acquired.lease)).toBe(false)
    expect(second.inspect(credentialId)?.ownerId).toBe('owner-b')
  })

  it('cascades the lease when the credential is hard-deleted', async () => {
    const coordinator = new DbOAuthRefreshCoordinator(primary, 'owner-a')
    expect(coordinator.tryAcquire(credentialId, 1_000, 500).kind).toBe('acquired')
    await new DbCredentialBackend(primary).delete(credentialId)
    expect(coordinator.inspect(credentialId)).toBeNull()
    expect(coordinator.tryAcquire(credentialId, 1_100, 500)).toEqual({ kind: 'missing' })
  })

  it('performs one rotating issuer call across independent stores and managers', async () => {
    const primaryStore = new DbCredentialBackend(primary)
    const secondaryStore = new DbCredentialBackend(secondary)
    const primaryAudit = new CredentialAuditLog(primary)
    const secondaryAudit = new CredentialAuditLog(secondary)
    const primaryResolver = new GatewayCredentialResolver({
      store: primaryStore,
      audit: primaryAudit,
      spendDb: primary,
    })
    const secondaryResolver = new GatewayCredentialResolver({
      store: secondaryStore,
      audit: secondaryAudit,
      spendDb: secondary,
    })

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
        expiresAt: '2026-07-26T13:00:00.000Z',
      }
    }
    const context = {
      agentId: 'agent',
      sessionId: 'session',
      threadId: 'thread',
    }
    const first = new OAuthTokenManager({
      store: primaryStore,
      resolver: primaryResolver,
      injector: new CredentialInjector(primaryResolver),
      audit: primaryAudit,
      credentialId,
      refresh,
      refreshCoordinator: new DbOAuthRefreshCoordinator(primary, 'process-a'),
      now: () => Date.parse('2026-07-26T12:00:00.000Z'),
    })
    const second = new OAuthTokenManager({
      store: secondaryStore,
      resolver: secondaryResolver,
      injector: new CredentialInjector(secondaryResolver),
      audit: secondaryAudit,
      credentialId,
      refresh,
      refreshCoordinator: new DbOAuthRefreshCoordinator(secondary, 'process-b'),
      now: () => Date.parse('2026-07-26T12:00:00.000Z'),
    })

    const pending = Promise.all([
      first.getAccessToken(context),
      second.getAccessToken(context),
    ])
    await vi.waitFor(() => expect(calls).toBe(1))
    release()
    const grants = await pending

    expect(calls).toBe(1)
    expect(grants.map(grant => grant.accessToken)).toEqual([
      'at_winner',
      'at_winner',
    ])
  })
})
