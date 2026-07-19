import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, createSecretKey } from 'node:crypto'
import { SignJWT } from 'jose'
import { GatewayState } from '../../../../src/gateway/state.js'
import { MIGRATIONS } from '../../../../src/gateway/db/schema.js'
import { openDatabaseSafely } from '../../../../src/gateway/db/migration-safety.js'
import {
  DelegatedPrincipalStore,
  ScopedPrincipalService,
} from '../../../../src/gateway/auth/scoped-principal.js'

let dir: string
let dbPath: string
let state: GatewayState

const OWNER_TOKEN = 'a'.repeat(64)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ownware-principal-'))
  dbPath = join(dir, 'ownware.db')
  state = new GatewayState(dbPath)
})

afterEach(async () => {
  state.close()
  await rm(dir, { recursive: true, force: true })
})

describe('migration 051 delegated principal store', () => {
  it('is additive and present in the checked migration sequence', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 51)
    expect(migration?.name).toBe('051_delegated_principals')
    expect(migration?.destructive).toBeUndefined()

    const columns = state.rawDbHandle
      .prepare('PRAGMA table_info(delegated_principals)')
      .all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual([
      'token_id',
      'delegate_id',
      'workspace_id',
      'profile_id',
      'purpose',
      'channel',
      'operations_json',
      'issued_at',
      'expires_at',
      'revoked_at',
      'revoke_reason',
      'subject_id',
    ])
  })

  it('upgrades a v50 database without losing existing data', () => {
    const legacyPath = join(dir, 'legacy.db')
    const legacy = openDatabaseSafely(
      legacyPath,
      (db) => db.pragma('foreign_keys = ON'),
      MIGRATIONS.filter((entry) => entry.version <= 50),
    )
    legacy.exec('CREATE TABLE upgrade_marker (value TEXT NOT NULL)')
    legacy.prepare('INSERT INTO upgrade_marker (value) VALUES (?)').run('preserved')
    legacy.close()

    const upgraded = new GatewayState(legacyPath)
    try {
      expect(upgraded.rawDbHandle
        .prepare('SELECT value FROM upgrade_marker')
        .pluck()
        .get()).toBe('preserved')
      expect(upgraded.rawDbHandle
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'delegated_principals'")
        .pluck()
        .get()).toBe('delegated_principals')
    } finally {
      upgraded.close()
    }
  })
})

describe('ScopedPrincipalService', () => {
  it('requires and preserves an explicit subject for protected resource authority across restart', async () => {
    const service = new ScopedPrincipalService({
      ownerToken: OWNER_TOKEN,
      store: new DelegatedPrincipalStore(state.rawDbHandle),
    })
    const input = {
      delegateId: 'embed-session-42',
      workspaceId: 'workspace_1',
      profileId: 'assistant',
      purpose: 'customer-support',
      channel: 'web',
      operations: ['source_content.read'],
    } as const

    await expect(service.issue(input, 1_750_000_000_000)).rejects.toMatchObject({
      code: 'principal_scope_invalid',
    })
    await expect(service.issue({
      ...input,
      operations: ['source_content.search'],
    }, 1_750_000_000_000)).rejects.toMatchObject({ code: 'principal_scope_invalid' })
    await expect(service.issue({
      ...input,
      operations: ['source_data_views.query'],
    }, 1_750_000_000_000)).rejects.toMatchObject({ code: 'principal_scope_invalid' })

    const issued = await service.issue({
      ...input,
      subjectId: 'customer_42',
    }, 1_750_000_000_000)
    expect(issued.principal.subjectId).toBe('customer_42')
    expect(state.rawDbHandle.prepare(`
      SELECT subject_id FROM delegated_principals WHERE token_id = ?
    `).pluck().get(issued.principal.tokenId)).toBe('customer_42')

    state.close()
    state = new GatewayState(dbPath)
    const reopened = new ScopedPrincipalService({
      ownerToken: OWNER_TOKEN,
      store: new DelegatedPrincipalStore(state.rawDbHandle),
    })
    await expect(reopened.verify(issued.token, 1_750_000_001_000))
      .resolves.toEqual(issued.principal)
  })

  it('rejects a validly signed token whose subject claim differs from persisted issuance', async () => {
    const service = new ScopedPrincipalService({
      ownerToken: OWNER_TOKEN,
      store: new DelegatedPrincipalStore(state.rawDbHandle),
    })
    const issued = await service.issue({
      delegateId: 'embed-session-42',
      workspaceId: 'workspace_1',
      profileId: 'assistant',
      subjectId: 'customer_42',
      purpose: 'customer-support',
      channel: 'web',
      operations: ['source_data_views.query'],
    }, 1_750_000_000_000)
    const principal = issued.principal
    const signingKey = createSecretKey(createHash('sha256')
      .update('ownware.gateway.delegated-principal.hs256.v1\0')
      .update(OWNER_TOKEN)
      .digest())
    const issuer = `ownware:${createHash('sha256')
      .update('ownware.gateway.delegated-principal.issuer.v1\0')
      .update(OWNER_TOKEN)
      .digest('hex')
      .slice(0, 32)}`
    const tampered = await new SignJWT({
      workspace_id: principal.workspaceId,
      profile_id: principal.profileId,
      subject_id: 'customer_99',
      purpose: principal.purpose,
      channel: principal.channel,
      operations: principal.operations,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience('ownware.gateway.v1')
      .setSubject(principal.delegateId)
      .setJti(principal.tokenId)
      .setIssuedAt(principal.issuedAt)
      .setNotBefore(principal.issuedAt)
      .setExpirationTime(principal.expiresAt)
      .sign(signingKey)

    await expect(service.verify(tampered, 1_750_000_001_000)).rejects.toMatchObject({
      code: 'principal_invalid',
    })
  })

  it('issues and verifies canonical bounded claims without storing the bearer token', async () => {
    const store = new DelegatedPrincipalStore(state.rawDbHandle)
    const service = new ScopedPrincipalService({ ownerToken: OWNER_TOKEN, store })
    const issued = await service.issue({
      delegateId: 'embed-session-42',
      workspaceId: 'workspace_1',
      profileId: 'assistant',
      purpose: 'customer-support',
      channel: 'web',
      operations: ['runs.start', 'runs.events', 'runs.start'],
      ttlSeconds: 900,
    }, 1_750_000_000_000)

    expect(issued.token).not.toContain(OWNER_TOKEN)
    expect(issued.principal).toMatchObject({
      kind: 'delegated',
      delegateId: 'embed-session-42',
      workspaceId: 'workspace_1',
      profileId: 'assistant',
      purpose: 'customer-support',
      channel: 'web',
      operations: ['runs.events', 'runs.start'],
    })

    const verified = await service.verify(issued.token, 1_750_000_001_000)
    expect(verified).toEqual(issued.principal)

    const persisted = state.rawDbHandle
      .prepare('SELECT * FROM delegated_principals WHERE token_id = ?')
      .get(issued.principal.tokenId) as Record<string, unknown>
    expect(JSON.stringify(persisted)).not.toContain(issued.token)
    expect(JSON.stringify(persisted)).not.toContain(OWNER_TOKEN)
  })

  it('rejects a token signed by a different install owner secret', async () => {
    const store = new DelegatedPrincipalStore(state.rawDbHandle)
    const issuer = new ScopedPrincipalService({ ownerToken: OWNER_TOKEN, store })
    const verifier = new ScopedPrincipalService({ ownerToken: 'b'.repeat(64), store })
    const issued = await issuer.issue({
      delegateId: 'delegate',
      workspaceId: 'workspace_1',
      profileId: 'assistant',
      purpose: 'support',
      operations: ['runs.start'],
    }, 1_750_000_000_000)

    await expect(verifier.verify(issued.token, 1_750_000_001_000)).rejects.toMatchObject({
      code: 'principal_invalid',
    })
  })

  it('rejects expiry and persisted revocation across a reopened store', async () => {
    const store = new DelegatedPrincipalStore(state.rawDbHandle)
    const service = new ScopedPrincipalService({ ownerToken: OWNER_TOKEN, store })
    const issued = await service.issue({
      delegateId: 'delegate',
      workspaceId: 'workspace_1',
      profileId: 'assistant',
      purpose: 'support',
      operations: ['runs.start'],
      ttlSeconds: 60,
    }, 1_750_000_000_000)

    await expect(service.verify(issued.token, 1_750_000_061_000)).rejects.toMatchObject({
      code: 'principal_expired',
    })

    expect(store.revoke(issued.principal.tokenId, 'client_removed', 1_750_000_010)).toBe(true)
    state.close()
    state = new GatewayState(dbPath)
    const reopened = new ScopedPrincipalService({
      ownerToken: OWNER_TOKEN,
      store: new DelegatedPrincipalStore(state.rawDbHandle),
    })
    await expect(reopened.verify(issued.token, 1_750_000_011_000)).rejects.toMatchObject({
      code: 'principal_revoked',
    })
  })

  it('rejects unbounded or empty scope fields before signing', async () => {
    const service = new ScopedPrincipalService({
      ownerToken: OWNER_TOKEN,
      store: new DelegatedPrincipalStore(state.rawDbHandle),
    })

    await expect(service.issue({
      delegateId: 'delegate',
      workspaceId: 'workspace_1',
      profileId: 'assistant',
      purpose: '',
      operations: ['runs.start'],
    })).rejects.toMatchObject({ code: 'principal_scope_invalid' })
    await expect(service.issue({
      delegateId: 'delegate',
      workspaceId: 'workspace_1',
      profileId: 'assistant',
      purpose: 'support',
      operations: ['RUN EVERYTHING'],
    })).rejects.toMatchObject({ code: 'principal_scope_invalid' })
  })
})
