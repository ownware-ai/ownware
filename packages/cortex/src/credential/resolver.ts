/**
 * Gateway credential resolver (board: credentials-unification — C22).
 *
 * The single ground-truth implementation of loom's `CredentialResolver`
 * interface. Every resolve goes through one method here, and that
 * method runs every safety gate the board promises:
 *
 *   1. Lookup by `variableName` in the unified credentials table.
 *      Missing → `MissingCredentialError`. Loom catches and pauses
 *      the run so the renderer can mount a missing-cred banner.
 *
 *   2. Status check. `expired` / `revoked` / `error` → throw
 *      `CredentialDeniedError` with the matching reason. The
 *      audit row records the denial.
 *
 *   3. Spend gate (LLM only). If the credential is `category: 'llm'`
 *      AND has a `spendCap` configured, call
 *      the selected adapter's spend repository with `ctx.estimatedCostUsd`.
 *      Pre-flight failure → `SPEND_CAP_EXCEEDED`. Audit row records
 *      the cap value + estimated cost so users can see why.
 *
 *   4. Trust gate. If the credential is `trust: 'high'`, call
 *      `trustGate.requestApproval` and BLOCK on the resulting
 *      Promise. Renderer shows a modal; user clicks Allow / Deny;
 *      gateway verifies HMAC; Promise resolves. Denial / timeout
 *      → `APPROVAL_DENIED`.
 *
 *   5. Issue an opaque handle. Token is `crypto.randomUUID()`.
 *      Internal map binds `token → { credentialId, ctx, expiresAt }`.
 *      TTL is configurable; default 5 min. Handles past expiry are
 *      pruned lazily on the next dereference.
 *
 *   6. Audit row written before a successful handle is returned (D7).
 *
 *   7. `lastUsedAt` updated best-effort on the credential row. Audit and
 *      metadata are separate durable operations; neither claims atomicity.
 *
 * Plaintext discipline: no plaintext value crosses ANY of the steps
 * above. The value materialises only at injector time
 * (`dereferenceHandle` returns it) and is never persisted in the
 * resolver's own state — the map keys on `credentialId`, not on
 * the value.
 */

import { randomUUID } from 'node:crypto'
import {
  CredentialDeniedError,
  MissingCredentialError,
  unsafeCreateHandle,
  type CredentialResolver,
  type OpaqueCredentialHandle,
  type ResolveContext,
} from '@ownware/loom'
import type { Credential } from './schema.js'
import type { CredentialStore } from './store/index.js'
import type { TrustGate } from './trust-gate.js'
import type {
  CredentialAuditRepository,
  CredentialSpendRepository,
} from '../storage/security-repositories.js'

// ---------------------------------------------------------------------------
// Internal handle map
// ---------------------------------------------------------------------------

interface ResolvedHandleEntry {
  readonly credentialId: string
  readonly variableName: string
  readonly category: Credential['category']
  readonly ctx: ResolveContext
  readonly expiresAt: number
}

/**
 * Default handle TTL — short enough that a leaked handle expires
 * before most exfiltration windows close, long enough that a legit
 * tool can resolve once and inject several times in sequence (e.g.
 * a deploy command issuing multiple HTTP calls).
 */
const DEFAULT_HANDLE_TTL_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// Constructor deps
// ---------------------------------------------------------------------------

export interface GatewayCredentialResolverDeps {
  readonly store: CredentialStore
  readonly audit: CredentialAuditRepository
  readonly spend: CredentialSpendRepository
  readonly trustGate?: TrustGate
  /** Override the handle TTL (tests). */
  readonly handleTtlMs?: number
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export class GatewayCredentialResolver implements CredentialResolver {
  private readonly store: CredentialStore
  private readonly audit: CredentialAuditRepository
  private readonly spend: CredentialSpendRepository
  private readonly trustGate: TrustGate | undefined
  private readonly handleTtlMs: number
  private readonly handles = new Map<string, ResolvedHandleEntry>()

  constructor(deps: GatewayCredentialResolverDeps) {
    this.store = deps.store
    this.audit = deps.audit
    this.spend = deps.spend
    this.trustGate = deps.trustGate
    this.handleTtlMs = deps.handleTtlMs ?? DEFAULT_HANDLE_TTL_MS
  }

  // -------------------------------------------------------------------------
  // resolve
  // -------------------------------------------------------------------------

  /**
   * The single entry point loom calls. See file header for the gate
   * sequence; throws are typed so loom + the renderer can switch on
   * the discriminator.
   */
  async resolve(
    variableName: string,
    ctx: ResolveContext,
  ): Promise<OpaqueCredentialHandle> {
    const credential = await this.findByVariableName(variableName)
    if (credential === null) {
      // No audit row — there's no credentialId to record against.
      // The missing-credential SSE event (C34) carries this name,
      // not the audit log.
      throw new MissingCredentialError(variableName)
    }
    return this.runGates(credential, variableName, ctx)
  }

  /**
   * Resolve a credential by its **id** rather than its `variableName`.
   *
   * Exists because not every credential has a `variableName`: the schema
   * requires one only for `api-key` and `bearer-token`, since that field is
   * the env-var name used at an injection site. An OAuth credential is never
   * injected as `KEY=value`, so it legitimately has none — and without this
   * entry point such a credential could not be resolved at all, which is how
   * the OAuth path came to read the store directly and skip every gate below.
   *
   * Identical gate sequence to `resolve()`. The only difference is the lookup.
   */
  async resolveById(
    credentialId: string,
    ctx: ResolveContext,
  ): Promise<OpaqueCredentialHandle> {
    const credential = await this.store.get(credentialId)
    if (credential === null) {
      throw new MissingCredentialError(credentialId)
    }
    return this.runGates(credential, credential.variableName ?? credential.id, ctx)
  }

  /**
   * Every safety gate, applied to an already-located credential.
   *
   * Shared by both entry points so a credential resolved by id can never end
   * up with fewer checks than one resolved by name. `label` is what appears in
   * thrown errors — the `variableName` when there is one, the id otherwise.
   */
  private async runGates(
    credential: Credential,
    variableName: string,
    ctx: ResolveContext,
  ): Promise<OpaqueCredentialHandle> {

    // Status gate ------------------------------------------------------------
    //
    // `expired` is recoverable for `oauth2` and terminal for everything else.
    // An expired API key is dead — nothing we hold can renew it, so denying is
    // the only honest answer. An expired OAuth credential is precisely what
    // the refresh token exists for; denying it here would make renewal
    // impossible and strand the person on a credential that could have healed
    // itself. `revoked` and `error` still deny for every auth type, so a dead
    // grant is stopped: the refresh path flips a refused grant to `revoked`,
    // which this gate then catches on the very next call.
    const expiredButRenewable = credential.status === 'expired' && credential.authType === 'oauth2'
    if (credential.status !== 'ready' && !expiredButRenewable) {
      const reason: 'EXPIRED' | 'REVOKED' | 'ERROR' =
        credential.status === 'expired' ? 'EXPIRED'
          : credential.status === 'revoked' ? 'REVOKED'
            : 'ERROR'
      await this.audit.recordEvent({
        credentialId: credential.id,
        eventType: 'resolve',
        outcome: 'denied',
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        threadId: ctx.threadId,
        ...(ctx.toolName !== undefined ? { toolName: ctx.toolName } : {}),
        detail: { gate: 'status', status: credential.status, reason: credential.statusReason },
      })
      throw new CredentialDeniedError(variableName, reason, credential.statusReason)
    }

    // Expiry gate (separate from the schema's status — `expiresAt` is
    // a hard wall the validate flow may not have caught yet) -----------------
    //
    // NOT applied to `oauth2`. For every other auth type `expiresAt` describes
    // the credential itself, so an elapsed value means "dead, deny". For an
    // OAuth credential it describes only the short-lived ACCESS TOKEN, which
    // the refresh token exists to replace — an elapsed value there means
    // "refresh now", and denying would make renewal impossible and strand the
    // person on a credential that could have healed itself. The death of an
    // OAuth grant is `status: 'revoked'`, which the status gate above already
    // catches. `OAuthTokenManager` owns access-token expiry.
    if (credential.authType !== 'oauth2' && credential.expiresAt !== undefined) {
      const expiresAt = Date.parse(credential.expiresAt)
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        await this.audit.recordEvent({
          credentialId: credential.id,
          eventType: 'resolve',
          outcome: 'denied',
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          threadId: ctx.threadId,
          ...(ctx.toolName !== undefined ? { toolName: ctx.toolName } : {}),
          detail: { gate: 'expiry', expiresAt: credential.expiresAt },
        })
        // Best-effort: flip the row to status: expired so the next
        // list refetch reflects reality. Failures here are swallowed
        // — the deny is the security-critical bit.
        try {
          await this.store.update(credential.id, {
            status: 'expired',
            statusReason: 'expiresAt elapsed at resolve time',
          })
        } catch { /* best-effort */ }
        throw new CredentialDeniedError(variableName, 'EXPIRED')
      }
    }

    // Spend gate (LLM only, only if a cap is configured) ---------------------
    let estimatedCostUsd: number | undefined
    if (credential.category === 'llm' && credential.spendCap !== undefined) {
      const estimate = ctx.estimatedCostUsd
      if (typeof estimate !== 'number' || !Number.isFinite(estimate) || estimate < 0) {
        // Per D5: estimator MUST supply a real number. A missing
        // estimate fails CLOSED — we'd rather block a real call than
        // silently bypass the cap.
        await this.audit.recordEvent({
          credentialId: credential.id,
          eventType: 'resolve',
          outcome: 'error',
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          threadId: ctx.threadId,
          ...(ctx.toolName !== undefined ? { toolName: ctx.toolName } : {}),
          detail: { gate: 'spend', error: 'missing or invalid estimatedCostUsd' },
        })
        throw new CredentialDeniedError(
          variableName,
          'SPEND_CAP_EXCEEDED',
          'estimatedCostUsd was not supplied',
        )
      }
      const spendResult = await this.spend.check(
        credential.id,
        credential.spendCap,
        estimate,
      )
      if (spendResult.status === 'denied') {
        await this.audit.recordEvent({
          credentialId: credential.id,
          eventType: 'resolve',
          outcome: 'denied',
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          threadId: ctx.threadId,
          ...(ctx.toolName !== undefined ? { toolName: ctx.toolName } : {}),
          estimatedCostUsd: estimate,
          detail: {
            gate: 'spend',
            cap: spendResult.capUsd,
            currentSpend: spendResult.currentSpendUsd,
            windowStart: spendResult.windowStart,
          },
        })
        throw new CredentialDeniedError(
          variableName,
          'SPEND_CAP_EXCEEDED',
          `cap=$${spendResult.capUsd}/${credential.spendCap.period}, used=$${spendResult.currentSpendUsd.toFixed(4)}`,
        )
      }
      estimatedCostUsd = estimate
    }

    // Trust gate -------------------------------------------------------------
    if (credential.trust === 'high') {
      if (this.trustGate === undefined) {
        // Configuration bug — trust:high requires a gate. Fail
        // CLOSED rather than silently allow.
        await this.audit.recordEvent({
          credentialId: credential.id,
          eventType: 'resolve',
          outcome: 'error',
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          threadId: ctx.threadId,
          ...(ctx.toolName !== undefined ? { toolName: ctx.toolName } : {}),
          detail: { gate: 'trust', error: 'trust gate not configured' },
        })
        throw new CredentialDeniedError(
          variableName,
          'APPROVAL_DENIED',
          'trust gate not configured',
        )
      }
      const decision = await this.trustGate.requestApproval({
        credentialId: credential.id,
        context: {
          ...(ctx.toolName !== undefined ? { toolName: ctx.toolName } : {}),
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          threadId: ctx.threadId,
        },
      })
      if (decision === 'denied') {
        await this.audit.recordEvent({
          credentialId: credential.id,
          eventType: 'resolve',
          outcome: 'denied',
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          threadId: ctx.threadId,
          ...(ctx.toolName !== undefined ? { toolName: ctx.toolName } : {}),
          detail: { gate: 'trust' },
        })
        throw new CredentialDeniedError(variableName, 'APPROVAL_DENIED')
      }
    }

    // Issue handle + audit + bump lastUsedAt ---------------------------------
    const token = randomUUID()
    const expiresAt = Date.now() + this.handleTtlMs
    this.handles.set(token, {
      credentialId: credential.id,
      variableName,
      category: credential.category,
      ctx,
      expiresAt,
    })

    await this.audit.recordEvent({
      credentialId: credential.id,
      eventType: 'resolve',
      outcome: 'ok',
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      threadId: ctx.threadId,
      ...(ctx.toolName !== undefined ? { toolName: ctx.toolName } : {}),
      ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    })

    // lastUsedAt is best-effort — a write failure here doesn't
    // invalidate the resolve, just leaves the timestamp slightly
    // stale.
    try {
      await this.store.update(credential.id, {
        lastUsedAt: new Date().toISOString(),
      })
    } catch { /* best-effort */ }

    return unsafeCreateHandle(token)
  }

  // -------------------------------------------------------------------------
  // dereferenceHandle — internal API for the injector
  //
  // Returns the credential's value PLUS the metadata the injector
  // needs (variableName for env injection, category for cost true-up).
  // Returns null if the handle is unknown OR expired. The injector
  // translates null into a typed error at its own layer.
  // -------------------------------------------------------------------------
  async dereferenceHandle(handle: OpaqueCredentialHandle): Promise<{
    readonly value: string
    readonly valueRevision: string
    readonly metadata: Credential
    readonly variableName: string
    readonly category: Credential['category']
    readonly credentialId: string
    readonly ctx: ResolveContext
  } | null> {
    const entry = this.handles.get(handle.token)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.handles.delete(handle.token)
      return null
    }
    const decrypted = await this.store.decrypt(entry.credentialId)
    if (decrypted === null) return null
    return {
      value: decrypted.value,
      valueRevision: decrypted.valueRevision,
      metadata: decrypted.metadata,
      variableName: entry.variableName,
      category: entry.category,
      credentialId: entry.credentialId,
      ctx: entry.ctx,
    }
  }

  /**
   * Post-flight cost true-up for LLM resolves. Called by the LLM
   * provider adapter (C24) after the actual response cost is known.
   * Records a separate audit row tagged with the credentialId; the
   * spend tracker reads `actual_cost_usd` for its rollups.
   *
   * Safe to call with `actualCostUsd: 0` to record a "called but
   * free-tier" event.
   */
  async recordActualCost(
    handle: OpaqueCredentialHandle,
    actualCostUsd: number,
  ): Promise<void> {
    if (!Number.isFinite(actualCostUsd) || actualCostUsd < 0) return
    const entry = this.handles.get(handle.token)
    if (!entry) return
    await this.audit.recordEvent({
      credentialId: entry.credentialId,
      eventType: 'resolve',
      outcome: 'ok',
      agentId: entry.ctx.agentId,
      sessionId: entry.ctx.sessionId,
      threadId: entry.ctx.threadId,
      ...(entry.ctx.toolName !== undefined ? { toolName: entry.ctx.toolName } : {}),
      actualCostUsd,
      detail: { trueUp: true },
    })
  }

  /**
   * Drop an in-memory handle (e.g. when a tool finishes and won't
   * inject again). Optional — handles also expire on TTL.
   */
  releaseHandle(handle: OpaqueCredentialHandle): void {
    this.handles.delete(handle.token)
  }

  /** Read-only diagnostic. */
  pendingHandleCount(): number {
    return this.handles.size
  }

  // -------------------------------------------------------------------------
  // Lookup helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve a credential row by `variableName`. Searches every
   * category but PREFERS `'llm'` when ambiguous (an LLM key with the
   * same name as a tool key is the more security-relevant one — the
   * spend cap matters most). Returns the first match (deterministic
   * by createdAt asc per the store contract).
   *
   * INCLUDES revoked rows so the status gate above can distinguish
   * "credential was once configured but soft-deleted" (→ denied
   * with reason REVOKED — the user knows they killed it) from
   * "credential never existed" (→ missing — the user is prompted
   * to add one). The public list endpoint still excludes revoked
   * rows by default; this helper only widens the lookup at
   * resolve-time.
   */
  private async findByVariableName(variableName: string): Promise<Credential | null> {
    for (const category of ['llm', 'tool', 'oauth', 'mcp-server'] as const) {
      const list = await this.store.list({ category, includeRevoked: true })
      const found = list.find(c => c.variableName === variableName)
      if (found !== undefined) return found
    }
    return null
  }
}
