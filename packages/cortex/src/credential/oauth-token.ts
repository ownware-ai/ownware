/**
 * OAuth token sets as stored credentials.
 *
 * An API key is one opaque string, which is exactly what `CredentialBackend`
 * stores. An OAuth credential is not: it is an access token, usually a refresh
 * token, an expiry, and often an account identifier that must ride on every
 * request. This module is the codec that lets that structure travel inside the
 * existing single-string `value` field.
 *
 * ## Why encode rather than widen the backend
 *
 * Widening `CredentialBackend` with `refreshValue` / `expiresAt` columns would
 * touch every backend, the shared contract harness, and both migration paths —
 * and would gain nothing, because the payload still has to be encrypted as one
 * blob. Encoding into `value` inherits the properties that already matter and
 * were already reviewed:
 *
 *   - **Encryption at rest** — the refresh token, the most dangerous field
 *     here, is protected by exactly the same AES-GCM path as an API key.
 *   - **`decrypt()` remains the single plaintext exit**, so the resolver's
 *     audit / trust / spend gates apply unchanged.
 *   - **No new storage surface** to review, migrate, or get wrong.
 *
 * ## The hint problem, and why it is handled here
 *
 * `maskCredentialValue()` takes the last four characters of the stored value.
 * For a JSON payload that yields `..."}` — which does not merely look silly,
 * it **fails `HintSchema`'s character class** and the save is rejected. So an
 * OAuth credential must supply its own hint, and this module decides what that
 * hint means:
 *
 *   - Prefer the **account identifier** tail. It is what actually lets a person
 *     recognise which account they connected, it is not secret, and it is
 *     stable across refreshes.
 *   - Otherwise fall back to the **refresh token** tail — stable across
 *     refreshes (unlike the access token, which would churn the hint and
 *     `updatedAt` on every rotation), and no more revealing than the API-key
 *     hint the system already shows.
 *   - Otherwise the **access token** tail, accepting the churn, because some
 *     hint is better than none for recognition.
 *
 * This narrows what `hint` means for `authType: 'oauth2'`: it identifies the
 * connection, not the secret. That is deliberate and is the honest reading —
 * there is no single "the value" to show a tail of.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// The token set
// ---------------------------------------------------------------------------

/**
 * What an authorization server gave us, normalized.
 *
 * Two fields are optional in a way that carries real meaning, and callers must
 * not paper over either:
 *
 * - **`refreshToken` absent** → this credential **cannot be renewed**. When it
 *   expires it is dead and the person must reconnect. A flow that requests no
 *   offline access lands here. Never synthesise a refresh; surface the fact.
 * - **`expiresAt` absent** → the server **did not tell us** when this expires.
 *   That is NOT "never expires". It means we cannot refresh pre-emptively and
 *   will only discover the expiry when a call is rejected. `isExpired()`
 *   returns `false` for this case because we have no evidence of expiry — but
 *   the caller must treat a rejection as authoritative rather than trusting
 *   this absence. See `hasKnownExpiry()`.
 */
export const OAuthTokenSetSchema = z
  .object({
    /** Bearer token presented on each request. Short-lived by design. */
    accessToken: z.string().min(1).max(8192),
    /**
     * Long-lived token used to mint a new access token. Absent when the
     * authorization server issued none — see the note above.
     */
    refreshToken: z.string().min(1).max(8192).optional(),
    /** ISO 8601 instant at which `accessToken` stops being accepted. */
    expiresAt: z.string().datetime({ offset: true }).optional(),
    /**
     * Provider-side account/organisation this token acts as. Frequently must be
     * echoed on every request as a header, and is the most useful thing to show
     * a person who is trying to recognise which account they connected.
     */
    accountId: z.string().min(1).max(256).optional(),
    /** Scopes the server actually granted — which may be fewer than requested. */
    scopes: z.array(z.string().min(1).max(256)).max(256).optional(),
    /** Almost always `Bearer`; retained because some servers differ. */
    tokenType: z.string().min(1).max(64).optional(),
  })
  .strict()

export type OAuthTokenSet = z.infer<typeof OAuthTokenSetSchema>

/**
 * Marker written into the encoded payload.
 *
 * Its job is to make "this credential is an API key, not a token set" a loud,
 * immediate failure rather than a confusing schema error deep in a parse. A
 * bare API key simply will not carry it.
 */
const ENVELOPE_KIND = 'ownware.oauth-token-set/1' as const

const EnvelopeSchema = z
  .object({
    kind: z.literal(ENVELOPE_KIND),
    token: OAuthTokenSetSchema,
  })
  .strict()

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a stored value cannot be read as a token set.
 *
 * Deliberately carries no payload fragment — the value is secret, and an error
 * message is the most likely thing to reach a log.
 */
export class OAuthTokenDecodeError extends Error {
  readonly credentialId: string | undefined

  constructor(message: string, credentialId?: string) {
    super(message)
    this.name = 'OAuthTokenDecodeError'
    this.credentialId = credentialId
  }
}

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/** Characters `HintSchema` accepts after the leading `...`. */
const HINT_SAFE = /[^A-Za-z0-9+/=_.-]/g

/**
 * Build the render-safe hint for a token set.
 *
 * Always returns a schema-valid hint: the source string is stripped of
 * characters outside the permitted class before the tail is taken, and an
 * unusable source degrades to a fixed `...oauth` marker rather than producing
 * something the schema will reject at save time.
 */
export function oauthCredentialHint(token: OAuthTokenSet): string {
  const source = token.accountId ?? token.refreshToken ?? token.accessToken
  const safe = source.replace(HINT_SAFE, '')
  if (safe.length === 0) return '...oauth'
  return `...${safe.slice(-Math.min(4, safe.length))}`
}

/**
 * Serialise a token set for storage.
 *
 * Returns everything the save/update call needs so the caller never has to
 * reconstruct the hint or the expiry independently — keeping the three
 * derived from one source and unable to disagree.
 */
export function encodeOAuthTokenSet(token: OAuthTokenSet): {
  readonly value: string
  readonly hint: string
  readonly expiresAt: string | undefined
  readonly grantedScopes: readonly string[] | undefined
} {
  const parsed = OAuthTokenSetSchema.parse(token)
  return {
    value: JSON.stringify({ kind: ENVELOPE_KIND, token: parsed }),
    hint: oauthCredentialHint(parsed),
    expiresAt: parsed.expiresAt,
    grantedScopes: parsed.scopes,
  }
}

/**
 * Read a stored value back as a token set.
 *
 * Throws `OAuthTokenDecodeError` on anything that is not a well-formed
 * envelope — including a plain API key, which is the realistic mistake. It
 * never returns a partially-populated set: a caller that gets a value back can
 * rely on every field being valid. Failing here is strongly preferred to
 * returning a token set with an empty access token, which would go out as
 * `Authorization: Bearer ` and be rejected far from the cause.
 */
export function decodeOAuthTokenSet(value: string, credentialId?: string): OAuthTokenSet {
  let raw: unknown
  try {
    raw = JSON.parse(value)
  } catch {
    throw new OAuthTokenDecodeError(
      'credential value is not an OAuth token set (not valid JSON) — it is most likely a plain API key stored against an oauth2 credential',
      credentialId,
    )
  }

  const parsed = EnvelopeSchema.safeParse(raw)
  if (!parsed.success) {
    throw new OAuthTokenDecodeError(
      `credential value is not a well-formed OAuth token set: ${parsed.error.issues
        .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
      credentialId,
    )
  }
  return parsed.data.token
}

/** True when the stored value looks like a token-set envelope. Never throws. */
export function isOAuthTokenSetValue(value: string): boolean {
  try {
    decodeOAuthTokenSet(value)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/**
 * Whether the server told us when this token expires.
 *
 * Callers deciding "can I refresh pre-emptively?" must consult this rather than
 * inferring from `isExpired()` returning `false` — the two answers coincide for
 * a token with no declared expiry, and conflating them turns "we don't know"
 * into "it's fine".
 */
export function hasKnownExpiry(token: OAuthTokenSet): boolean {
  return token.expiresAt !== undefined
}

/**
 * Whether the access token is past its declared expiry.
 *
 * `skewMs` treats a token as expired slightly early so a refresh happens before
 * a request rather than after a rejection; it also absorbs clock drift between
 * us and the authorization server. Default 60s.
 *
 * Returns `false` when no expiry was declared — that is the absence of
 * evidence, not evidence of validity. Pair with `hasKnownExpiry()`.
 */
export function isExpired(token: OAuthTokenSet, now: number = Date.now(), skewMs = 60_000): boolean {
  if (token.expiresAt === undefined) return false
  const at = Date.parse(token.expiresAt)
  if (Number.isNaN(at)) return false
  return at - skewMs <= now
}

/**
 * Whether this credential can be renewed without the person re-authorising.
 *
 * A token set with no refresh token is terminal: when it expires, the only
 * remedy is a fresh connect. Surfacing that early is the difference between
 * telling someone "reconnect your account" and showing them a failing agent.
 */
export function isRenewable(token: OAuthTokenSet): boolean {
  return token.refreshToken !== undefined
}

/**
 * Merge a refresh response over the existing set.
 *
 * Authorization servers routinely omit `refresh_token` on a refresh response,
 * meaning "keep using the one you have". Dropping it in that case would destroy
 * the ability to ever refresh again — the credential would work once more and
 * then die. Likewise `accountId` and `scopes` are preserved when the response
 * is silent about them.
 *
 * **`expiresAt` is the deliberate exception and is NOT carried forward.** The
 * previous expiry described the previous access token; stamping it onto a newly
 * minted one would assert an expiry we were never told, and since that instant
 * is by definition already past, the fresh token would be judged expired the
 * moment it was stored — an immediate refresh loop. A server that returns a new
 * access token without an expiry has told us it does not know or will not say,
 * and `hasKnownExpiry()` must report that honestly rather than inherit a stale
 * answer.
 */
export function mergeRefreshedTokens(
  previous: OAuthTokenSet,
  incoming: Partial<OAuthTokenSet> & { accessToken: string },
): OAuthTokenSet {
  return OAuthTokenSetSchema.parse({
    accessToken: incoming.accessToken,
    refreshToken: incoming.refreshToken ?? previous.refreshToken,
    expiresAt: incoming.expiresAt ?? undefined,
    accountId: incoming.accountId ?? previous.accountId,
    scopes: incoming.scopes ?? previous.scopes,
    tokenType: incoming.tokenType ?? previous.tokenType,
  })
}
