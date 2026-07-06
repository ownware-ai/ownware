/**
 * CredentialResolver interface (board: credentials-unification — C20).
 *
 * The interface loom EXPECTS from its consumer (the gateway). The
 * gateway implements `GatewayCredentialResolver` in
 * `packages/cortex/src/credential/resolver.ts`. Loom only knows about
 * the interface — it never imports any concrete resolver.
 *
 * This is the architectural boundary that makes D1 ("credentials are
 * resolved, not retrieved") structurally true:
 *
 *   - Loom never calls `vault.load()` or `keychain.get()`. It calls
 *     `resolver.resolve(name, ctx)` and gets back an opaque handle.
 *   - The gateway's resolver runs every safety check (status,
 *     trust gate, spend cap) inside that single method. There is
 *     no path from loom to a credential value that bypasses the
 *     gates — because there is no path from loom to a value at all.
 *
 * The resolver is supplied to loom at session-construction time
 * (Session refactor — C21). Tests pass a fake resolver; production
 * passes the real `GatewayCredentialResolver`.
 */

import type { OpaqueCredentialHandle } from './handle.js'

// ---------------------------------------------------------------------------
// Resolve context — passed alongside every resolve() call
// ---------------------------------------------------------------------------

/**
 * Context the resolver uses for gating + audit.
 *
 *   - `agentId` / `sessionId` / `threadId` — correlation handles for
 *     the audit row. Required because the audit log is structured for
 *     queries like "what touched my Stripe key from agent_X today?".
 *
 *   - `toolName` — only set when the resolve happens inside a tool
 *     dispatcher (e.g. `shell` or `deploy_to_vercel`). Omitted for
 *     LLM provider-key resolves, which happen before tool dispatch.
 *
 *   - `estimatedCostUsd` — pre-flight cost estimate for LLM calls.
 *     Required when the credential's category is `'llm'` AND it has
 *     a `spendCap` configured; the resolver throws on missing
 *     estimate rather than silently fail-OPEN. For non-LLM resolves
 *     this field is ignored.
 */
export interface ResolveContext {
  readonly agentId: string
  readonly sessionId: string
  readonly threadId: string
  readonly toolName?: string
  readonly estimatedCostUsd?: number
}

// ---------------------------------------------------------------------------
// Errors — discriminated for the caller's catch block
// ---------------------------------------------------------------------------

/**
 * The credential isn't in the store. Loom catches this in the tool
 * dispatcher, pauses the run, and emits a `credential.missing` SSE
 * event for the renderer to surface a `<MissingCredentialBanner>`
 * (C34). After the user fills the value via `POST /credentials`,
 * the run resumes by retrying the resolve.
 */
export class MissingCredentialError extends Error {
  readonly kind = 'missing' as const
  constructor(public readonly variableName: string) {
    super(`No credential is configured for "${variableName}".`)
    this.name = 'MissingCredentialError'
  }
}

/**
 * A safety gate refused the resolve. The `reason` discriminator
 * lets loom + the renderer surface a meaningful message:
 *
 *   - `SPEND_CAP_EXCEEDED` — pre-flight estimate would push past
 *     the credential's spendCap for the current window.
 *   - `APPROVAL_DENIED` — `trust: 'high'` resolve and the user
 *     denied (or the approval timed out).
 *   - `EXPIRED` — credential's `expiresAt` is in the past.
 *   - `REVOKED` — credential's `status` is `'revoked'` (soft-deleted).
 *   - `ERROR` — credential's `status` is `'error'` (last validate failed).
 */
export class CredentialDeniedError extends Error {
  readonly kind = 'denied' as const
  constructor(
    public readonly variableName: string,
    public readonly reason:
      | 'SPEND_CAP_EXCEEDED'
      | 'APPROVAL_DENIED'
      | 'EXPIRED'
      | 'REVOKED'
      | 'ERROR',
    public readonly detail?: string,
  ) {
    super(
      `Credential "${variableName}" denied: ${reason}${detail ? ` — ${detail}` : ''}`,
    )
    this.name = 'CredentialDeniedError'
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Resolve API loom calls into the gateway. Implementations are in the
 * gateway tree — this file owns only the contract.
 */
export interface CredentialResolver {
  /**
   * Resolve a credential by canonical variable name. Returns an
   * opaque handle the caller can later inject at the OS boundary
   * via the injector.
   *
   * @throws MissingCredentialError when the credential isn't in the store
   * @throws CredentialDeniedError when a gate refuses
   * @throws Error for transport / DB failures (rare; bubble up)
   */
  resolve(
    variableName: string,
    ctx: ResolveContext,
  ): Promise<OpaqueCredentialHandle>
}

// ---------------------------------------------------------------------------
// Test fixture — a no-op resolver for unit tests that don't care about credentials
// ---------------------------------------------------------------------------

/**
 * Resolver fixture used by loom's own tests. ALWAYS THROWS
 * MissingCredentialError. Tests that exercise the resolve path
 * pass their own mock; tests that don't touch credentials get a
 * meaningful error if loom accidentally tries to resolve one.
 */
export const ALWAYS_MISSING_RESOLVER: CredentialResolver = {
  resolve(variableName) {
    return Promise.reject(new MissingCredentialError(variableName))
  },
}
