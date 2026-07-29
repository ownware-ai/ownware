/**
 * Unit tests — OAuth token sets as stored credentials.
 *
 * The properties worth proving are the ones whose failure is silent and
 * expensive:
 *
 *   1. A token set survives a real save → decrypt round-trip through the
 *      existing backend, with NO change to the backend contract beyond an
 *      optional hint. If this holds, the refresh token inherits the same
 *      encryption-at-rest review that API keys already passed.
 *   2. The hint is schema-valid AND stable across refreshes. The naive
 *      derivation produces `..."}`, which HintSchema rejects outright — a
 *      failure that would only appear the first time someone connected an
 *      account.
 *   3. Decoding fails loudly on anything that is not a token set — above all
 *      on a plain API key, which is the realistic mistake.
 *   4. Absence of a declared expiry is reported as "unknown", never as "valid
 *      forever"; and absence of a refresh token is reported as "cannot renew",
 *      never papered over.
 *   5. A refresh response that omits `refresh_token` does not destroy the
 *      ability to refresh again — the single most damaging merge bug available
 *      here, because the credential keeps working once and then dies.
 */

import { describe, expect, it } from 'vitest'

import {
  OAuthTokenDecodeError,
  decodeOAuthTokenSet,
  encodeOAuthTokenSet,
  hasKnownExpiry,
  isExpired,
  isOAuthTokenSetValue,
  isRenewable,
  mergeRefreshedTokens,
  oauthCredentialHint,
  type OAuthTokenSet,
} from '../../../src/credential/oauth-token.js'
import { CredentialSchema } from '../../../src/credential/schema.js'

const FULL: OAuthTokenSet = {
  accessToken: 'at_live_abcdefghijklmnop',
  refreshToken: 'rt_live_qrstuvwxyz012345',
  expiresAt: '2026-07-26T12:00:00.000Z',
  accountId: 'acct-4271',
  scopes: ['models.read', 'offline_access'],
  tokenType: 'Bearer',
}

// -------------------------------------------------------------------------
// 1 — encode / decode round-trip
// -------------------------------------------------------------------------

describe('encode → decode round-trip', () => {
  it('preserves every field exactly', () => {
    const encoded = encodeOAuthTokenSet(FULL)
    expect(decodeOAuthTokenSet(encoded.value)).toEqual(FULL)
  })

  it('surfaces expiry and scopes for the caller to store as metadata', () => {
    const encoded = encodeOAuthTokenSet(FULL)
    // Derived from one source so the stored metadata cannot disagree with the
    // encrypted payload it describes.
    expect(encoded.expiresAt).toBe(FULL.expiresAt)
    expect(encoded.grantedScopes).toEqual(FULL.scopes)
  })

  it('round-trips a minimal set (no refresh, no expiry, no account)', () => {
    const minimal: OAuthTokenSet = { accessToken: 'at_only' }
    const encoded = encodeOAuthTokenSet(minimal)
    expect(decodeOAuthTokenSet(encoded.value)).toEqual(minimal)
    expect(encoded.expiresAt).toBeUndefined()
  })
})

// -------------------------------------------------------------------------
// 2 — the hint must be schema-valid and stable
// -------------------------------------------------------------------------

describe('hint derivation', () => {
  /** Reuse the real schema so this test tracks HintSchema, not a copy of it. */
  const hintIsSchemaValid = (hint: string): boolean => {
    const candidate = {
      id: 'cred_0123456789ab',
      name: 'n',
      category: 'oauth' as const,
      authType: 'oauth2' as const,
      hint,
      trust: 'medium' as const,
      source: 'oauth-flow' as const,
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
      status: 'ready' as const,
    }
    return CredentialSchema.safeParse(candidate).success
  }

  it('produces a hint the credential schema accepts', () => {
    expect(hintIsSchemaValid(encodeOAuthTokenSet(FULL).hint)).toBe(true)
  })

  it('rejects the naive derivation — proving why the override exists', () => {
    // This is the bug the override prevents: masking the JSON payload yields
    // `..."}`, whose characters are outside HintSchema's class.
    const json = encodeOAuthTokenSet(FULL).value
    const naive = `...${json.slice(-4)}`
    expect(hintIsSchemaValid(naive)).toBe(false)
  })

  it('identifies the account, not the secret, when an accountId exists', () => {
    expect(oauthCredentialHint(FULL)).toBe('...4271')
  })

  it('stays stable across an access-token refresh', () => {
    // A hint derived from the access token would churn on every rotation,
    // bumping updatedAt and flickering the UI for no informational gain.
    const before = oauthCredentialHint(FULL)
    const after = oauthCredentialHint(
      mergeRefreshedTokens(FULL, { accessToken: 'at_completely_different_value' }),
    )
    expect(after).toBe(before)
  })

  it('falls back to the refresh token when there is no account id', () => {
    const { accountId: _drop, ...noAccount } = FULL
    expect(oauthCredentialHint(noAccount)).toBe('...2345')
  })

  it('degrades to a fixed marker rather than emitting an invalid hint', () => {
    // A token made entirely of characters outside the hint class must not
    // produce something the schema will reject at save time.
    const hint = oauthCredentialHint({ accessToken: '!!!!' })
    expect(hint).toBe('...oauth')
    expect(hintIsSchemaValid(hint)).toBe(true)
  })
})

// -------------------------------------------------------------------------
// 3 — decoding fails loudly on anything that is not a token set
// -------------------------------------------------------------------------

describe('decode rejects non-token-set values', () => {
  it('rejects a plain API key — the realistic mistake', () => {
    expect(() => decodeOAuthTokenSet('sk-ant-api03-abcdef')).toThrow(OAuthTokenDecodeError)
  })

  it('rejects valid JSON that is not an envelope', () => {
    expect(() => decodeOAuthTokenSet(JSON.stringify({ accessToken: 'x' }))).toThrow(
      OAuthTokenDecodeError,
    )
  })

  it('rejects an envelope whose token is malformed', () => {
    const bad = JSON.stringify({
      kind: 'ownware.oauth-token-set/1',
      token: { accessToken: '' },
    })
    expect(() => decodeOAuthTokenSet(bad)).toThrow(OAuthTokenDecodeError)
  })

  it('never leaks the offending value in the error message', () => {
    const secret = 'sk-ant-super-secret-value'
    try {
      decodeOAuthTokenSet(secret)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).not.toContain(secret)
      expect((err as Error).message).not.toContain('super-secret')
    }
  })

  it('carries the credential id when supplied, for diagnosis without the value', () => {
    try {
      decodeOAuthTokenSet('not-json', 'cred_0123456789ab')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as OAuthTokenDecodeError).credentialId).toBe('cred_0123456789ab')
    }
  })

  it('isOAuthTokenSetValue discriminates without throwing', () => {
    expect(isOAuthTokenSetValue(encodeOAuthTokenSet(FULL).value)).toBe(true)
    expect(isOAuthTokenSetValue('sk-ant-api03-abcdef')).toBe(false)
  })
})

// -------------------------------------------------------------------------
// 4 — unknown is reported as unknown
// -------------------------------------------------------------------------

describe('expiry and renewability are reported honestly', () => {
  const at = (iso: string) => Date.parse(iso)

  it('treats a token as expired slightly early, to refresh before rejection', () => {
    const token: OAuthTokenSet = { accessToken: 'a', expiresAt: '2026-07-26T12:00:00.000Z' }
    // 30s before expiry, inside the default 60s skew.
    expect(isExpired(token, at('2026-07-26T11:59:30.000Z'))).toBe(true)
    // 5 minutes before expiry, comfortably outside it.
    expect(isExpired(token, at('2026-07-26T11:55:00.000Z'))).toBe(false)
  })

  it('does not claim a token with no declared expiry is valid forever', () => {
    const token: OAuthTokenSet = { accessToken: 'a' }
    // No evidence of expiry, so nothing to act on pre-emptively...
    expect(isExpired(token)).toBe(false)
    // ...but the caller must be able to tell that apart from "known good".
    expect(hasKnownExpiry(token)).toBe(false)
    expect(hasKnownExpiry({ accessToken: 'a', expiresAt: '2026-07-26T12:00:00.000Z' })).toBe(true)
  })

  it('reports a token set with no refresh token as non-renewable', () => {
    expect(isRenewable({ accessToken: 'a' })).toBe(false)
    expect(isRenewable(FULL)).toBe(true)
  })

  it('does not treat an unparseable expiry as expired', () => {
    // Defensive: a corrupt timestamp must not silently force a refresh storm.
    const token = { accessToken: 'a', expiresAt: '2026-07-26T12:00:00.000Z' } as OAuthTokenSet
    expect(isExpired({ ...token, expiresAt: 'not-a-date' } as OAuthTokenSet)).toBe(false)
  })
})

// -------------------------------------------------------------------------
// 5 — merge must not destroy the ability to refresh
// -------------------------------------------------------------------------

describe('mergeRefreshedTokens', () => {
  it('keeps the existing refresh token when the response omits one', () => {
    // The damaging bug: dropping it here means the credential refreshes once
    // more and then can never refresh again.
    const merged = mergeRefreshedTokens(FULL, {
      accessToken: 'at_new',
      expiresAt: '2026-07-26T13:00:00.000Z',
    })
    expect(merged.refreshToken).toBe(FULL.refreshToken)
    expect(merged.accessToken).toBe('at_new')
  })

  it('adopts a rotated refresh token when the response supplies one', () => {
    const merged = mergeRefreshedTokens(FULL, {
      accessToken: 'at_new',
      refreshToken: 'rt_rotated',
    })
    expect(merged.refreshToken).toBe('rt_rotated')
  })

  it('preserves accountId and scopes when the response is silent', () => {
    const merged = mergeRefreshedTokens(FULL, { accessToken: 'at_new' })
    expect(merged.accountId).toBe(FULL.accountId)
    expect(merged.scopes).toEqual(FULL.scopes)
  })

  it('does NOT carry a stale expiry onto a newly minted access token', () => {
    // Inheriting the old expiry would stamp an already-past instant onto a
    // fresh token, making it look expired immediately — a refresh loop.
    const merged = mergeRefreshedTokens(FULL, { accessToken: 'at_new' })
    expect(merged.expiresAt).toBeUndefined()
    expect(hasKnownExpiry(merged)).toBe(false)
    expect(isExpired(merged, Date.parse('2027-01-01T00:00:00.000Z'))).toBe(false)
  })
})
