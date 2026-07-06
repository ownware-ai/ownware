/**
 * Credential Human-In-The-Loop resolver.
 *
 * Bridges Loom's `credentials.requestCredential` callback (see
 * `packages/loom/src/core/loop.ts`) to the gateway's HTTP endpoint that
 * the user responds through. The pattern intentionally mirrors the
 * existing permission HITL (`@ownware/loom` `HumanInTheLoop`), one
 * layer up the stack — Loom owns tool-approval HITL; credential HITL is
 * a Cortex concern because the plaintext value only ever touches the
 * vault, which lives here.
 *
 * Lifecycle:
 *
 *   1. `request(req)` is called by the session's
 *      `credentials.requestCredential` closure when the loop needs to
 *      block for user input. It creates a pending entry keyed by
 *      `req.requestId` and returns a Promise.
 *   2. The loop is now suspended awaiting that Promise while the
 *      `credential.request` LoomEvent streams to SSE subscribers.
 *   3. The user enters a value in the client and POSTs to the gateway's
 *      credential endpoint. The handler:
 *        a. Encrypts + stores the value in the vault (NOT here — this
 *           class does not touch the vault; the handler does it before
 *           calling `respond`, so we cannot accidentally log / persist
 *           a value through this module).
 *        b. Calls `respond(requestId, handle)` with the handle the
 *           vault write produced.
 *   4. The Promise resolves with the handle; the loop resumes.
 *   5. If the user clicks deny, the handler calls `deny(requestId)`
 *      instead — the Promise resolves with `null`.
 *
 * Timeouts: mirrors `HumanInTheLoop` — a pending request older than
 * `timeoutMs` resolves with `null` (deny). Default 5 minutes, matching
 * the permission HITL default. This prevents a stale agent from
 * blocking a session forever if the user closes the client mid-request.
 *
 * Security invariant: this class NEVER sees the plaintext value. The
 * gateway endpoint encrypts-and-stores, then hands us a handle. That
 * way a future log-injection or error-dump at this layer cannot leak
 * a credential value.
 */

import type { CredentialHandle } from '@ownware/loom'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Default timeout. Matches the permission HITL default. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export interface PendingCredentialRequest {
  readonly requestId: string
  readonly label: string
  readonly hint: string
  readonly usage: string
  readonly placement: CredentialHandle['placement']
  readonly isRequired: boolean
  readonly createdAt: number
}

// ---------------------------------------------------------------------------
// CredentialHITL
// ---------------------------------------------------------------------------

export class CredentialHITL {
  private readonly timeoutMs: number
  private readonly pending = new Map<
    string,
    {
      resolve: (handle: CredentialHandle | null) => void
      timer: ReturnType<typeof setTimeout>
      request: PendingCredentialRequest
    }
  >()

  constructor(opts?: { readonly timeoutMs?: number }) {
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * Block the caller until the user responds (or `deny` or timeout).
   *
   * Duplicate `requestId` is an error — Loom generates a UUID per
   * request so collisions are a programmer bug worth surfacing loudly.
   */
  request(
    req: PendingCredentialRequest,
  ): Promise<CredentialHandle | null> {
    if (this.pending.has(req.requestId)) {
      return Promise.reject(
        new Error(
          `[credential-hitl] duplicate requestId '${req.requestId}' — ` +
          `Loom generates unique ids per request, this indicates a bug`,
        ),
      )
    }

    return new Promise<CredentialHandle | null>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(req.requestId)
        if (!entry) return
        this.pending.delete(req.requestId)
        entry.resolve(null)
      }, this.timeoutMs)
      this.pending.set(req.requestId, { resolve, timer, request: req })
    })
  }

  /**
   * Resolve a pending request with the stored-credential handle.
   * Silently ignores unknown / already-resolved ids — the HTTP endpoint
   * may fire this after a timeout already denied the request, and that
   * must not crash the runner.
   */
  respond(requestId: string, handle: CredentialHandle): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    entry.resolve(handle)
    return true
  }

  /** Resolve a pending request as denied (null). */
  deny(requestId: string): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    entry.resolve(null)
    return true
  }

  /** Deny every pending request — used on session cleanup / abort. */
  denyAll(): number {
    let n = 0
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve(null)
      this.pending.delete(requestId)
      n++
    }
    return n
  }

  /** Look up a pending request without resolving it. */
  getPending(requestId: string): PendingCredentialRequest | undefined {
    return this.pending.get(requestId)?.request
  }

  /** List every pending request — used by the gateway for diagnostics. */
  listPending(): readonly PendingCredentialRequest[] {
    return [...this.pending.values()].map(e => e.request)
  }

  get pendingCount(): number {
    return this.pending.size
  }

  /** Release all timers. Idempotent. */
  dispose(): void {
    this.denyAll()
  }
}
