/**
 * OAuth token lifecycle — the thing that keeps a connected account working
 * for months without the person touching it.
 *
 * `oauth-token.ts` defines what a token set IS; this module owns what happens
 * to one over time: read it, notice it is (about to be) expired, mint a new
 * access token from the refresh token, persist the rotation, and tell the
 * audit log — or, when the authorization server says the grant is dead, flip
 * the credential unhealthy and say why. Multiple managers and processes may
 * share one stored credential; SQLite lease coordination is the authority.
 *
 * ## Single-flight is a hard requirement, not tidiness
 *
 * The transport `fetch` closure this manager feeds is re-entered by the vendor
 * SDK's own retry (proven in loom's transport tests), and several streams can
 * share one credential concurrently. Without coalescing, one expired token
 * becomes N simultaneous refresh calls — and against a server that rotates
 * refresh tokens on use, the LOSERS of that race persist a stale refresh token
 * over the winner's fresh one, killing the credential for good. All managers
 * therefore contend on one credential-scoped durable lease, then re-read the
 * encrypted store after acquisition. Exactly one issuer refresh happens even
 * when the callers live in different gateway processes.
 *
 * ## Failure semantics (the part that decides what a customer sees)
 *
 * - **The server rejected the grant** (`invalid_grant` / 400s): the credential
 *   is flipped to `revoked` with a human-readable `statusReason`, a `refresh`
 *   audit row records the denial, and `OAuthRefreshDeniedError` is thrown.
 *   Every subsequent call fails fast on the status gate — a dead grant does
 *   not get retried into a ban or an infinite loop.
 * - **The refresh transport failed** (network, 5xx): the credential is left
 *   untouched — the grant may be fine — an `error` audit row is written, and
 *   `OAuthRefreshTransportError` is thrown. The next call may retry.
 * - **The token set has no refresh token**: terminal by construction. The
 *   credential flips to `expired` with a reason telling the person to
 *   reconnect, because nothing we do can renew it.
 *
 * ## What this module deliberately does NOT do
 *
 * It never talks HTTP itself. The actual token-endpoint call is injected
 * (`RefreshTokenFn`), for the same reason loom's adapters take a `fetch`:
 * provider specifics stay out of the mechanism, and the whole lifecycle is
 * provable against a local fake issuer — no real account, no network.
 */

import type { CredentialAuditLog } from './audit.js'
import {
  OAuthTokenDecodeError,
  decodeOAuthTokenSet,
  encodeOAuthTokenSet,
  hasKnownExpiry,
  isExpired,
  isRenewable,
  mergeRefreshedTokens,
  type OAuthTokenSet,
} from './oauth-token.js'
import type { CredentialInjector } from './injector.js'
import type {
  OAuthRefreshCoordinator,
  OAuthRefreshLease,
} from './oauth-refresh-coordinator.js'
import type { GatewayCredentialResolver } from './resolver.js'
import type { CredentialStore } from './store/index.js'
import type { CredentialWriteCondition } from './store/types.js'

// ---------------------------------------------------------------------------
// The injected refresh call
// ---------------------------------------------------------------------------

/**
 * Outcome of one attempt against the authorization server's token endpoint.
 *
 * Implementations translate their wire protocol into exactly one of these.
 * `denied` means the SERVER decided the grant is no longer valid — the only
 * outcome that may kill a credential. Anything ambiguous (timeouts, 5xx,
 * malformed response) must be `failed`, because treating a transient fault as
 * a dead grant destroys a working credential.
 */
export type RefreshOutcome =
  | {
      readonly result: 'refreshed'
      /** New access token — required; a refresh that returns none failed. */
      readonly accessToken: string
      /** Rotated refresh token, when the server issued one. Absent = keep old. */
      readonly refreshToken?: string
      /** New expiry, when declared. Absent = the server did not say. */
      readonly expiresAt?: string
      /** Account id, when (re)declared. Absent = keep old. */
      readonly accountId?: string
    }
  | {
      readonly result: 'denied'
      /** Server's stated reason, e.g. `invalid_grant`. Shown to the operator. */
      readonly reason: string
    }
  | {
      readonly result: 'failed'
      /** Transport-level cause. The credential is NOT harmed by this. */
      readonly reason: string
    }

/**
 * The provider-specific token-endpoint call. Receives the current refresh
 * token; must NOT throw for protocol-level denial — that is what the `denied`
 * variant is for. A thrown error is treated as transport failure.
 */
export type RefreshTokenFn = (refreshToken: string) => Promise<RefreshOutcome>

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base class so callers can catch the whole family at one site. */
export class OAuthTokenManagerError extends Error {
  readonly credentialId: string

  constructor(message: string, credentialId: string) {
    super(message)
    this.name = 'OAuthTokenManagerError'
    this.credentialId = credentialId
  }
}

/** The credential row is missing, revoked, or not a token set. */
export class OAuthCredentialUnusableError extends OAuthTokenManagerError {
  /** Machine-readable cause for the caller's error surface. */
  readonly reason: 'missing' | 'revoked' | 'unhealthy' | 'not-a-token-set'

  constructor(
    reason: OAuthCredentialUnusableError['reason'],
    credentialId: string,
    detail?: string,
  ) {
    super(
      `OAuth credential ${credentialId} is unusable (${reason})${detail ? `: ${detail}` : ''}`,
      credentialId,
    )
    this.name = 'OAuthCredentialUnusableError'
    this.reason = reason
  }
}

/**
 * The authorization server refused the refresh — the grant is dead. The
 * credential has already been flipped unhealthy by the time this is thrown;
 * the person must reconnect their account.
 */
export class OAuthRefreshDeniedError extends OAuthTokenManagerError {
  readonly serverReason: string

  constructor(credentialId: string, serverReason: string) {
    super(
      `authorization server refused to refresh credential ${credentialId} (${serverReason}) — the account must be reconnected`,
      credentialId,
    )
    this.name = 'OAuthRefreshDeniedError'
    this.serverReason = serverReason
  }
}

/**
 * The refresh could not be completed for a reason that does NOT indict the
 * grant (network, 5xx). The credential is untouched; retrying later is
 * legitimate.
 */
export class OAuthRefreshTransportError extends OAuthTokenManagerError {
  constructor(credentialId: string, cause: string) {
    super(`could not reach the authorization server for credential ${credentialId}: ${cause}`, credentialId)
    this.name = 'OAuthRefreshTransportError'
  }
}

/** The token set cannot be renewed (no refresh token) and has expired. */
export class OAuthReconnectRequiredError extends OAuthTokenManagerError {
  constructor(credentialId: string) {
    super(
      `credential ${credentialId} has expired and carries no refresh token — the account must be reconnected`,
      credentialId,
    )
    this.name = 'OAuthReconnectRequiredError'
  }
}

export class OAuthRefreshCoordinationError extends OAuthTokenManagerError {
  readonly reason: 'timeout' | 'lease-lost'

  constructor(
    credentialId: string,
    reason: OAuthRefreshCoordinationError['reason'],
  ) {
    super(`OAuth refresh coordination failed for credential ${credentialId} (${reason})`, credentialId)
    this.name = 'OAuthRefreshCoordinationError'
    this.reason = reason
  }
}

export class OAuthRefreshStaleWriteError extends OAuthTokenManagerError {
  constructor(credentialId: string) {
    super(
      `OAuth credential ${credentialId} changed while refresh was in progress; the stale result was not stored`,
      credentialId,
    )
    this.name = 'OAuthRefreshStaleWriteError'
  }
}

export class OAuthRefreshStatePersistenceError extends OAuthTokenManagerError {
  constructor(credentialId: string) {
    super(
      `OAuth credential ${credentialId} could not persist its refresh state; reconnect or repair credential storage before retrying`,
      credentialId,
    )
    this.name = 'OAuthRefreshStatePersistenceError'
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/** Audit correlation for one access-token request. */
export interface TokenRequestContext {
  readonly agentId: string
  readonly sessionId: string
  readonly threadId: string
}

export interface OAuthTokenManagerDeps {
  /** Used for rotation write-back and status changes only — never for reads. */
  readonly store: CredentialStore
  /**
   * Reads go through here so an OAuth credential passes the same status, trust
   * and spend gates an API key does, and produces the same `resolve` audit row.
   */
  readonly resolver: GatewayCredentialResolver
  /** Dereferences the resolver's handle into the value, for one bounded use. */
  readonly injector: CredentialInjector
  readonly audit: CredentialAuditLog
  readonly credentialId: string
  readonly refresh: RefreshTokenFn
  /** Durable, credential-scoped refresh lease authority. */
  readonly refreshCoordinator: OAuthRefreshCoordinator
  /**
   * Refresh-ahead skew in ms — a token within this window of its declared
   * expiry is refreshed pre-emptively so the refresh happens before a request
   * instead of after a rejection. Also absorbs clock drift. Default 60s.
   */
  readonly expirySkewMs?: number
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Durable lease duration; renewed while an issuer request is in flight. */
  readonly refreshLeaseMs?: number
  /** Maximum time a waiter may spend behind another process. */
  readonly refreshWaitTimeoutMs?: number
  /** Poll interval used to observe early lease release. */
  readonly refreshPollMs?: number
  /** Separate coordination clock; token-expiry tests may freeze `now`. */
  readonly coordinationNow?: () => number
  /** Async wait, injectable for deterministic coordination tests. */
  readonly wait?: (milliseconds: number) => Promise<void>
}

export interface AccessTokenGrant {
  readonly accessToken: string
  readonly accountId: string | undefined
}

interface StoredOAuthTokenSnapshot {
  readonly token: OAuthTokenSet
  readonly condition: CredentialWriteCondition
}

const failedStateWrites = new Map<string, {
  readonly valueRevision: string
  readonly status: CredentialWriteCondition['status']
}>()

export class OAuthTokenManager {
  private readonly store: CredentialStore
  private readonly resolver: GatewayCredentialResolver
  private readonly injector: CredentialInjector
  private readonly audit: CredentialAuditLog
  private readonly credentialId: string
  private readonly refresh: RefreshTokenFn
  private readonly refreshCoordinator: OAuthRefreshCoordinator
  private readonly expirySkewMs: number
  private readonly now: () => number
  private readonly refreshLeaseMs: number
  private readonly refreshWaitTimeoutMs: number
  private readonly refreshPollMs: number
  private readonly coordinationNow: () => number
  private readonly wait: (milliseconds: number) => Promise<void>

  constructor(deps: OAuthTokenManagerDeps) {
    this.store = deps.store
    this.resolver = deps.resolver
    this.injector = deps.injector
    this.audit = deps.audit
    this.credentialId = deps.credentialId
    this.refresh = deps.refresh
    this.refreshCoordinator = deps.refreshCoordinator
    this.expirySkewMs = deps.expirySkewMs ?? 60_000
    this.now = deps.now ?? Date.now
    this.refreshLeaseMs = deps.refreshLeaseMs ?? 60_000
    this.refreshWaitTimeoutMs = deps.refreshWaitTimeoutMs ?? 120_000
    this.refreshPollMs = deps.refreshPollMs ?? 25
    this.coordinationNow = deps.coordinationNow ?? Date.now
    this.wait = deps.wait ?? (milliseconds =>
      new Promise(resolve => setTimeout(resolve, milliseconds)))

    for (const [name, value] of [
      ['refreshLeaseMs', this.refreshLeaseMs],
      ['refreshWaitTimeoutMs', this.refreshWaitTimeoutMs],
      ['refreshPollMs', this.refreshPollMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a safe positive integer`)
      }
    }
  }

  /**
   * The one public entry: a currently-valid access token, refreshing first if
   * needed. This is what a transport `fetch` closure calls per attempt.
   *
   * Every call re-reads the store rather than caching in memory — the store is
   * the single source of truth, so a rotation persisted by another path (or a
   * revocation by the operator) is honoured on the very next call.
   */
  async getAccessToken(ctx: TokenRequestContext): Promise<AccessTokenGrant> {
    const snapshot = await this.readTokenSet(ctx)
    this.assertNotQuarantined(snapshot.condition)

    if (!isExpired(snapshot.token, this.now(), this.expirySkewMs)) {
      return {
        accessToken: snapshot.token.accessToken,
        accountId: snapshot.token.accountId,
      }
    }

    const refreshed = await this.refreshWithLease(ctx)
    return { accessToken: refreshed.accessToken, accountId: refreshed.accountId }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async readTokenSet(ctx: TokenRequestContext): Promise<StoredOAuthTokenSnapshot> {
    // Route through the resolver, NOT `store.decrypt()` directly. This is what
    // subjects an OAuth credential to the same gates an API key passes —
    // status, trust (signed approval when `trust: 'high'`), spend — and what
    // writes the `resolve` audit row. Reading the store directly would give a
    // OAuth credential fewer checks than a pasted key, which was the
    // defect this path originally shipped with.
    //
    // `resolveById` rather than `resolve`: an OAuth credential has no
    // `variableName` to look up by, because it is never injected as an env var.
    let stored: {
      readonly value: string
      readonly condition: CredentialWriteCondition
    }
    try {
      const handle = await this.resolver.resolveById(this.credentialId, {
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        threadId: ctx.threadId,
      })
      stored = await this.injector.runWithCredential(handle, (value, snapshot) => ({
        value,
        condition: {
          valueRevision: snapshot.valueRevision,
          status: snapshot.metadata.status,
        },
      }))
    } catch (err) {
      // Translate the resolver's vocabulary into this module's, preserving the
      // distinction the caller acts on. A denial is authoritative — the gate
      // said no — and must not be retried as though it were transport noise.
      const name = err instanceof Error ? err.name : ''
      if (name === 'MissingCredentialError') {
        throw new OAuthCredentialUnusableError('missing', this.credentialId)
      }
      if (name === 'CredentialDeniedError') {
        const reason = (err as { reason?: string }).reason
        throw new OAuthCredentialUnusableError(
          reason === 'REVOKED' ? 'revoked' : 'unhealthy',
          this.credentialId,
          err instanceof Error ? err.message : undefined,
        )
      }
      throw err
    }

    try {
      return {
        token: decodeOAuthTokenSet(stored.value, this.credentialId),
        condition: stored.condition,
      }
    } catch (err) {
      if (err instanceof OAuthTokenDecodeError) {
        // Wrong shape in the row (most likely an API key saved as oauth2).
        // Record it — this is a wiring bug someone must see, not a transient.
        this.audit.recordEvent({
          credentialId: this.credentialId,
          eventType: 'refresh',
          outcome: 'error',
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          threadId: ctx.threadId,
          detail: { cause: 'stored value is not an OAuth token set' },
        })
        throw new OAuthCredentialUnusableError('not-a-token-set', this.credentialId, err.message)
      }
      throw err
    }
  }

  private assertNotQuarantined(condition: CredentialWriteCondition): void {
    const failed = failedStateWrites.get(this.credentialId)
    if (failed === undefined) return
    if (
      failed.valueRevision !== condition.valueRevision
      || failed.status !== condition.status
    ) {
      failedStateWrites.delete(this.credentialId)
      return
    }
    throw new OAuthRefreshStatePersistenceError(this.credentialId)
  }

  private async acquireRefreshLease(): Promise<OAuthRefreshLease> {
    const deadline = this.coordinationNow() + this.refreshWaitTimeoutMs
    while (true) {
      const now = this.coordinationNow()
      const result = this.refreshCoordinator.tryAcquire(
        this.credentialId,
        now,
        this.refreshLeaseMs,
      )
      if (result.kind === 'acquired') return result.lease
      if (result.kind === 'missing') {
        throw new OAuthCredentialUnusableError('missing', this.credentialId)
      }
      if (now >= deadline) {
        throw new OAuthRefreshCoordinationError(this.credentialId, 'timeout')
      }
      await this.wait(Math.min(this.refreshPollMs, Math.max(1, deadline - now)))
    }
  }

  private async refreshWithLease(ctx: TokenRequestContext): Promise<OAuthTokenSet> {
    let lease = await this.acquireRefreshLease()
    let leaseLost = false
    let renewing = false
    const heartbeatMs = Math.max(10, Math.floor(this.refreshLeaseMs / 3))
    const heartbeat = setInterval(() => {
      if (renewing || leaseLost) return
      renewing = true
      try {
        const renewed = this.refreshCoordinator.renew(
          lease,
          this.coordinationNow(),
          this.refreshLeaseMs,
        )
        if (renewed === null) leaseLost = true
        else lease = renewed
      } catch {
        leaseLost = true
      } finally {
        renewing = false
      }
    }, heartbeatMs)
    heartbeat.unref?.()

    const assertLease = (): void => {
      if (leaseLost) {
        throw new OAuthRefreshCoordinationError(this.credentialId, 'lease-lost')
      }
      let renewed: OAuthRefreshLease | null
      try {
        renewed = this.refreshCoordinator.renew(
          lease,
          this.coordinationNow(),
          this.refreshLeaseMs,
        )
      } catch {
        renewed = null
      }
      if (renewed === null) {
        leaseLost = true
        throw new OAuthRefreshCoordinationError(this.credentialId, 'lease-lost')
      }
      lease = renewed
    }

    try {
      // The winner may already have rotated while this caller waited. This
      // second gated read is what turns the durable lease into single-flight.
      const current = await this.readTokenSet(ctx)
      this.assertNotQuarantined(current.condition)
      if (!isExpired(current.token, this.now(), this.expirySkewMs)) {
        return current.token
      }

      if (!isRenewable(current.token)) {
        assertLease()
        await this.markUnhealthy(
          current.condition,
          'expired',
          'access token expired and no refresh token was issued — reconnect the account',
        )
        this.audit.recordEvent({
          credentialId: this.credentialId,
          eventType: 'refresh',
          outcome: 'denied',
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          threadId: ctx.threadId,
          detail: {
            cause: 'no refresh token',
            hadKnownExpiry: hasKnownExpiry(current.token),
          },
        })
        throw new OAuthReconnectRequiredError(this.credentialId)
      }

      return await this.performRefresh(current, ctx, assertLease)
    } finally {
      clearInterval(heartbeat)
      try {
        this.refreshCoordinator.release(lease)
      } catch {
        // Expiry/takeover already fences this owner. Cleanup failure is not
        // permission to change the outcome of the token operation.
      }
    }
  }

  private async performRefresh(
    snapshot: StoredOAuthTokenSnapshot,
    ctx: TokenRequestContext,
    assertLease: () => void,
  ): Promise<OAuthTokenSet> {
    // isRenewable() was checked by the caller; the non-null assertion is safe
    // because the token set was validated by decode.
    const refreshToken = snapshot.token.refreshToken as string

    let outcome: RefreshOutcome
    try {
      outcome = await this.refresh(refreshToken)
    } catch (err) {
      // A thrown implementation error is transport failure BY CONTRACT: an
      // implementation that wants to kill the credential must say `denied`
      // explicitly. Ambiguity may never destroy a possibly-working grant.
      outcome = { result: 'failed', reason: err instanceof Error ? err.message : String(err) }
    }

    if (outcome.result === 'denied') {
      assertLease()
      await this.markUnhealthy(
        snapshot.condition,
        'revoked',
        `authorization server refused the refresh (${outcome.reason}) — reconnect the account`,
      )
      this.audit.recordEvent({
        credentialId: this.credentialId,
        eventType: 'refresh',
        outcome: 'denied',
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        threadId: ctx.threadId,
        detail: { serverReason: outcome.reason },
      })
      throw new OAuthRefreshDeniedError(this.credentialId, outcome.reason)
    }

    if (outcome.result === 'failed') {
      // Credential deliberately untouched — the grant may be fine.
      this.audit.recordEvent({
        credentialId: this.credentialId,
        eventType: 'refresh',
        outcome: 'error',
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        threadId: ctx.threadId,
        detail: { cause: outcome.reason },
      })
      throw new OAuthRefreshTransportError(this.credentialId, outcome.reason)
    }

    // Success — merge (never dropping an unreturned refresh token), persist,
    // audit. Persistence failure is a HARD failure: returning a token we
    // could not store would desynchronise the store from reality, and with a
    // server that rotates refresh tokens on use, the stored (now consumed)
    // refresh token may already be dead. Better to fail this call loudly.
    const merged = mergeRefreshedTokens(snapshot.token, {
      accessToken: outcome.accessToken,
      ...(outcome.refreshToken !== undefined ? { refreshToken: outcome.refreshToken } : {}),
      ...(outcome.expiresAt !== undefined ? { expiresAt: outcome.expiresAt } : {}),
      ...(outcome.accountId !== undefined ? { accountId: outcome.accountId } : {}),
    })
    const encoded = encodeOAuthTokenSet(merged)

    assertLease()
    let updateResult
    try {
      updateResult = await this.store.updateIfUnchanged(
        this.credentialId,
        snapshot.condition,
        {
          value: encoded.value,
          hint: encoded.hint,
          expiresAt: encoded.expiresAt ?? null,
          // A successful refresh IS the proof of health — recover an
          // `expired` status row without a separate validate round-trip.
          status: 'ready',
          statusReason: null,
        },
      )
    } catch {
      failedStateWrites.set(this.credentialId, snapshot.condition)
      throw new OAuthRefreshStatePersistenceError(this.credentialId)
    }
    if (updateResult.kind === 'missing') {
      // The credential vanished mid-refresh (hard-deleted). Do not resurrect it.
      throw new OAuthCredentialUnusableError('missing', this.credentialId, 'credential was deleted during refresh')
    }
    if (updateResult.kind === 'conflict') {
      throw new OAuthRefreshStaleWriteError(this.credentialId)
    }

    this.audit.recordEvent({
      credentialId: this.credentialId,
      eventType: 'refresh',
      outcome: 'ok',
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      threadId: ctx.threadId,
      detail: {
        rotatedRefreshToken: outcome.refreshToken !== undefined,
        declaredExpiry: outcome.expiresAt !== undefined,
      },
    })

    return merged
  }

  private async markUnhealthy(
    condition: CredentialWriteCondition,
    status: 'revoked' | 'expired',
    reason: string,
  ): Promise<void> {
    let result
    try {
      result = await this.store.updateIfUnchanged(
        this.credentialId,
        condition,
        { status, statusReason: reason },
      )
    } catch {
      failedStateWrites.set(this.credentialId, condition)
      throw new OAuthRefreshStatePersistenceError(this.credentialId)
    }
    if (result.kind === 'missing') {
      throw new OAuthCredentialUnusableError('missing', this.credentialId)
    }
    if (result.kind === 'conflict') {
      const current = await this.store.get(this.credentialId)
      if (current?.status === status) return
      throw new OAuthRefreshStaleWriteError(this.credentialId)
    }
  }
}
