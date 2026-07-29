/**
 * Integration tests — an OAuth token set through the REAL credential backend.
 *
 * `oauth-token.test.ts` proves the codec in isolation. This file proves the
 * claim that actually justifies the design: that encoding into the existing
 * `value` field makes a token set inherit, unchanged, the storage properties
 * an API key already has. Specifically —
 *
 *   1. It survives `save()` → `decrypt()` with every field intact.
 *   2. **The refresh token is encrypted at rest.** This is the whole argument
 *      for not widening the backend, so it is asserted against the raw SQLite
 *      row rather than trusted.
 *   3. The metadata that crosses the wire still carries NO token material —
 *      `CredentialSchema.strict()` plus an explicit scan of the serialised row.
 *   4. Rotation (`update({ value, hint })`) replaces the payload and the hint
 *      together, so the two cannot drift.
 *
 * Environment mirrors `db-backend.test.ts`: fresh in-memory SQLite per test,
 * HOME repointed at a tmp dir so the master key lands somewhere disposable.
 */

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DbCredentialBackend } from '../../../src/credential/store/db-backend.js'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import { CredentialSchema } from '../../../src/credential/schema.js'
import {
  decodeOAuthTokenSet,
  encodeOAuthTokenSet,
  mergeRefreshedTokens,
  type OAuthTokenSet,
} from '../../../src/credential/oauth-token.js'

let prevHome: string | undefined
let tmpHome: string
let db: Database.Database
let backend: DbCredentialBackend

beforeEach(() => {
  prevHome = process.env['HOME']
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-oauth-store-'))
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()

  db = new Database(':memory:')
  for (const migration of MIGRATIONS) db.exec(migration.sql)
  backend = new DbCredentialBackend(db)
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  try {
    db.close()
  } catch {
    /* already closed */
  }
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

const TOKEN: OAuthTokenSet = {
  accessToken: 'at_live_AAAAAAAAAAAAAAAAAAAA',
  refreshToken: 'rt_live_BBBBBBBBBBBBBBBBBBBB',
  expiresAt: '2026-07-26T12:00:00.000Z',
  accountId: 'acct-4271',
  scopes: ['models.read', 'offline_access'],
}

async function saveToken(token: OAuthTokenSet = TOKEN) {
  const encoded = encodeOAuthTokenSet(token)
  return backend.save({
    name: 'ChatGPT account',
    value: encoded.value,
    hint: encoded.hint,
    category: 'oauth',
    authType: 'oauth2',
    source: 'oauth-flow',
    ...(encoded.expiresAt !== undefined ? { expiresAt: encoded.expiresAt } : {}),
    ...(encoded.grantedScopes !== undefined ? { grantedScopes: encoded.grantedScopes } : {}),
  })
}

// -------------------------------------------------------------------------

describe('an OAuth token set stores through the existing backend unchanged', () => {
  it('saves with no variableName — oauth2 is exempt, and the schema agrees', async () => {
    // api-key / bearer-token require a variableName so the env injector can
    // find them. An OAuth credential is never injected as KEY=value, so the
    // schema's superRefine must not demand one. If this fails, the whole
    // "reuse the existing shape" premise is wrong.
    const saved = await saveToken()
    expect(saved.variableName).toBeUndefined()
    expect(CredentialSchema.safeParse(saved).success).toBe(true)
  })

  it('round-trips every field through save → decrypt', async () => {
    const saved = await saveToken()
    const decrypted = await backend.decrypt(saved.id)
    expect(decrypted).not.toBeNull()
    expect(decodeOAuthTokenSet(decrypted!.value, saved.id)).toEqual(TOKEN)
  })

  it('carries expiry and granted scopes onto the metadata', async () => {
    const saved = await saveToken()
    expect(saved.expiresAt).toBe(TOKEN.expiresAt)
    expect(saved.grantedScopes).toEqual(TOKEN.scopes)
  })

  it('stores a hint that identifies the account', async () => {
    const saved = await saveToken()
    expect(saved.hint).toBe('...4271')
  })
})

// -------------------------------------------------------------------------

describe('the refresh token is protected exactly like an API key', () => {
  it('is encrypted at rest — the raw row contains no token material', async () => {
    const saved = await saveToken()

    const row = db
      .prepare('SELECT * FROM credentials WHERE id = ?')
      .get(saved.id) as Record<string, unknown>
    const serialisedRow = JSON.stringify(row)

    // The claim being tested is about the persisted bytes, so read them.
    expect(serialisedRow).not.toContain(TOKEN.refreshToken)
    expect(serialisedRow).not.toContain(TOKEN.accessToken)
    // ...and the ciphertext is genuinely present, so this is not passing by
    // virtue of the row being empty.
    expect(String(row['encrypted_value'] ?? '')).not.toHaveLength(0)
  })

  it('keeps token material out of the metadata that crosses the wire', async () => {
    const saved = await saveToken()
    const serialisedMetadata = JSON.stringify(saved)

    expect(serialisedMetadata).not.toContain(TOKEN.refreshToken)
    expect(serialisedMetadata).not.toContain(TOKEN.accessToken)
    // The hint is the only value-derived field, and it derives from the
    // non-secret account id.
    expect(saved.hint).toBe('...4271')
  })

  it('keeps token material out of list() results', async () => {
    await saveToken()
    const listed = await backend.list({ category: 'oauth' })
    expect(JSON.stringify(listed)).not.toContain(TOKEN.refreshToken)
    expect(JSON.stringify(listed)).not.toContain(TOKEN.accessToken)
  })
})

// -------------------------------------------------------------------------

describe('rotation replaces payload and hint together', () => {
  it('conditionally rotates only the exact metadata revision that was read', async () => {
    const saved = await saveToken()
    const encoded = encodeOAuthTokenSet(mergeRefreshedTokens(TOKEN, {
      accessToken: 'at_conditional',
    }))
    const initial = await backend.decrypt(saved.id)
    if (initial === null) throw new Error('missing seeded credential')

    const updated = await backend.updateIfUnchanged(saved.id, {
      valueRevision: initial.valueRevision,
      status: initial.metadata.status,
    }, {
      value: encoded.value,
      hint: encoded.hint,
    })
    expect(updated.kind).toBe('updated')

    const stale = await backend.updateIfUnchanged(saved.id, {
      valueRevision: initial.valueRevision,
      status: initial.metadata.status,
    }, {
      status: 'revoked',
      statusReason: 'stale writer',
    })
    expect(stale).toEqual({ kind: 'conflict' })
    expect((await backend.get(saved.id))?.status).toBe('ready')
  })

  it('stores a refreshed token set and keeps the hint consistent', async () => {
    const saved = await saveToken()

    const refreshed = mergeRefreshedTokens(TOKEN, {
      accessToken: 'at_live_CCCCCCCCCCCCCCCCCCCC',
      expiresAt: '2026-07-26T13:00:00.000Z',
    })
    const encoded = encodeOAuthTokenSet(refreshed)

    const updated = await backend.update(saved.id, {
      value: encoded.value,
      hint: encoded.hint,
      ...(encoded.expiresAt !== undefined ? { expiresAt: encoded.expiresAt } : {}),
    })
    expect(updated).not.toBeNull()

    const decrypted = await backend.decrypt(saved.id)
    const stored = decodeOAuthTokenSet(decrypted!.value)

    expect(stored.accessToken).toBe('at_live_CCCCCCCCCCCCCCCCCCCC')
    // The refresh token survived a response that did not resend it.
    expect(stored.refreshToken).toBe(TOKEN.refreshToken)
    expect(updated!.expiresAt).toBe('2026-07-26T13:00:00.000Z')
    // Account-derived, so unchanged by the rotation.
    expect(updated!.hint).toBe('...4271')
  })

  it('leaves no trace of the superseded access token in the row', async () => {
    const saved = await saveToken()
    const refreshed = mergeRefreshedTokens(TOKEN, { accessToken: 'at_live_DDDD' })
    const encoded = encodeOAuthTokenSet(refreshed)
    await backend.update(saved.id, { value: encoded.value, hint: encoded.hint })

    const row = db
      .prepare('SELECT * FROM credentials WHERE id = ?')
      .get(saved.id) as Record<string, unknown>
    expect(JSON.stringify(row)).not.toContain(TOKEN.accessToken)
  })
})

// -------------------------------------------------------------------------

describe('unhappy paths fail honestly', () => {
  it('a plain API key stored against an oauth2 credential fails loudly on read', async () => {
    // Nothing stops a caller writing the wrong shape; what matters is that the
    // mistake surfaces at decode with a clear cause rather than going out as
    // `Authorization: Bearer <json>` and failing at the provider.
    const saved = await backend.save({
      name: 'mistake',
      value: 'sk-ant-api03-not-a-token-set',
      category: 'oauth',
      authType: 'oauth2',
      source: 'manual',
    })
    const decrypted = await backend.decrypt(saved.id)
    expect(() => decodeOAuthTokenSet(decrypted!.value, saved.id)).toThrow(
      /not an OAuth token set/,
    )
  })

  it('a revoked oauth credential is excluded from list by default', async () => {
    const saved = await saveToken()
    await backend.update(saved.id, {
      status: 'revoked',
      statusReason: 'user disconnected the account',
    })

    expect(await backend.list({ category: 'oauth' })).toHaveLength(0)
    expect(await backend.list({ category: 'oauth', includeRevoked: true })).toHaveLength(1)
  })

  it('decrypt of an unknown id returns null rather than throwing', async () => {
    expect(await backend.decrypt('cred_ffffffffffff')).toBeNull()
  })
})
