/**
 * Trust gate (board: credentials-unification — C30).
 *
 * Enforces `trust: 'high'` deterministically. The flow:
 *
 *   1. Resolver hits a `trust: 'high'` credential.
 *   2. Resolver calls `gate.requestApproval({ credentialId, ctx })`.
 *      The gate returns a Promise that blocks until the user
 *      approves or denies (or the request times out).
 *   3. The gate emits a `credential.approval_required` SSE event
 *      so the renderer can mount a native modal.
 *   4. Renderer shows the modal. User clicks Allow / Deny.
 *   5. Renderer POSTs `/credentials/:id/approve` (or `.../deny`)
 *      with the `requestId`. Gateway calls `gate.respond(requestId,
 *      decision)`, which resolves the blocked Promise.
 *   6. Resolver completes (or fails with `APPROVAL_DENIED`).
 *
 * HMAC signing:
 *
 *   The gate signs each pending request's id with an in-process
 *   HMAC key generated at construction. The renderer round-trips
 *   the `(requestId, signature)` pair, and `respond` verifies the
 *   signature before accepting the decision. This prevents an agent
 *   in loom from forging an approval — the agent has no access to
 *   the HMAC key, so it cannot produce a valid signature.
 *
 *   The HMAC key lives in PROCESS MEMORY only — it's regenerated
 *   on every gateway start. That intentionally means an in-flight
 *   approval doesn't survive a gateway restart; the user is asked
 *   again. Persisting the key would create a separate exfiltration
 *   target and serve no security benefit (the threat is forgery
 *   from inside the same process tree, not across restarts).
 *
 * Phase-5 scope:
 *   - The gate primitive + tests + SSE event shape ship now.
 *   - Wired to no resolver call site yet (C22).
 *   - The renderer-facing POST `/credentials/:id/approve` handler
 *     ships now so a manual e2e test can drive the full loop.
 */

import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Decision + event schemas
// ---------------------------------------------------------------------------

export const ApprovalDecisionSchema = z.enum(['granted', 'denied'])
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>

/**
 * Wire shape for the `credential.approval_required` SSE event. The
 * renderer subscribes to the gateway's existing SSE channel and
 * mounts a modal when one arrives.
 */
export const ApprovalRequiredEventSchema = z.object({
  type: z.literal('credential.approval_required'),
  requestId: z.string().min(1),
  credentialId: z.string().min(1),
  /** Signature the renderer round-trips on the approve / deny POST. */
  signature: z.string().min(1),
  /** Optional context the renderer surfaces in the modal. */
  context: z
    .object({
      toolName: z.string().optional(),
      agentId: z.string().optional(),
      sessionId: z.string().optional(),
      threadId: z.string().optional(),
      reason: z.string().optional(),
    })
    .optional(),
  /** Epoch milliseconds — request expires at this instant. */
  expiresAt: z.number().int().positive(),
})
export type ApprovalRequiredEvent = z.infer<typeof ApprovalRequiredEventSchema>

/**
 * Body the renderer POSTs back to the gateway. The signature MUST
 * match the one emitted in the SSE event — the gate uses
 * `timingSafeEqual` to defeat a timing oracle.
 */
export const ApprovalResponseBodySchema = z.object({
  requestId: z.string().min(1),
  decision: ApprovalDecisionSchema,
  signature: z.string().min(1),
})
export type ApprovalResponseBody = z.infer<typeof ApprovalResponseBodySchema>

// ---------------------------------------------------------------------------
// Pending registry
// ---------------------------------------------------------------------------

interface PendingApproval {
  readonly requestId: string
  readonly credentialId: string
  readonly signature: string
  readonly expiresAt: number
  readonly resolve: (decision: ApprovalDecision) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export interface RequestApprovalContext {
  readonly toolName?: string
  readonly agentId?: string
  readonly sessionId?: string
  readonly threadId?: string
  readonly reason?: string
}

export interface RequestApprovalArgs {
  readonly credentialId: string
  readonly context?: RequestApprovalContext
  /** Override default TTL (60s). Capped at 5 min by the gate. */
  readonly ttlMs?: number
}

/** Sink for `credential.approval_required` events. The SSE handler
 *  subscribes here. Multiple subscribers are supported — events
 *  fan out to all of them in registration order. */
export type ApprovalEventListener = (event: ApprovalRequiredEvent) => void

/** Defaults — tunable but conservative. */
const DEFAULT_TTL_MS = 60_000
const MAX_TTL_MS = 5 * 60_000

// ---------------------------------------------------------------------------
// TrustGate
// ---------------------------------------------------------------------------

export class TrustGate {
  private readonly hmacKey: Buffer
  private readonly pending = new Map<string, PendingApproval>()
  private readonly listeners = new Set<ApprovalEventListener>()

  /**
   * Construct a fresh gate. The HMAC key is generated per-instance
   * and never leaves this object. Tests pass an explicit key for
   * deterministic signature checks; production callers omit and let
   * the gate roll its own.
   */
  constructor(opts: { readonly hmacKey?: Buffer } = {}) {
    this.hmacKey = opts.hmacKey ?? randomBytes(32)
  }

  /**
   * Subscribe to `credential.approval_required` events. Returns an
   * `unsubscribe` function the SSE handler calls on teardown.
   */
  onApprovalRequired(listener: ApprovalEventListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Issue a pending approval and return a Promise that resolves with
   * the user's decision (or `'denied'` if the request times out).
   *
   * Emits the `credential.approval_required` event SYNCHRONOUSLY
   * during the call so a single-tick subscriber picks it up before
   * any later code paths.
   */
  requestApproval(args: RequestApprovalArgs): Promise<ApprovalDecision> {
    const requestId = `apv_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const ttl = Math.min(args.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS)
    const expiresAt = Date.now() + ttl
    const signature = this.sign(requestId, args.credentialId, expiresAt)

    return new Promise<ApprovalDecision>(resolve => {
      const timer = setTimeout(() => {
        // Timeout = denial. Same semantics as the user closing the
        // modal — the resolve site MUST NOT proceed without an
        // explicit grant.
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId)
          resolve('denied')
        }
      }, ttl)

      // Don't keep the gateway alive solely on a pending modal — the
      // node process should exit cleanly even if a renderer never
      // responded to a stranded request. `unref()` is a no-op when
      // the timer is the last thing keeping us alive.
      timer.unref?.()

      this.pending.set(requestId, {
        requestId,
        credentialId: args.credentialId,
        signature,
        expiresAt,
        resolve,
        timer,
      })

      const event: ApprovalRequiredEvent = ApprovalRequiredEventSchema.parse({
        type: 'credential.approval_required',
        requestId,
        credentialId: args.credentialId,
        signature,
        ...(args.context !== undefined ? { context: args.context } : {}),
        expiresAt,
      })
      for (const l of this.listeners) {
        try { l(event) } catch { /* listener bug shouldn't break the gate */ }
      }
    })
  }

  /**
   * Resolve a pending approval from the renderer's response. Returns
   * `true` on success; `false` on:
   *   - unknown requestId (timeout race or replay attempt)
   *   - signature mismatch (forgery attempt)
   *
   * This method NEVER throws on a bad signature — a thrown error
   * would leak whether the requestId existed. We return `false` for
   * both "no such request" and "bad signature" so the caller can't
   * distinguish.
   */
  respond(body: ApprovalResponseBody): boolean {
    const pending = this.pending.get(body.requestId)
    if (!pending) return false
    if (!this.verify(body.requestId, pending.credentialId, pending.expiresAt, body.signature)) {
      return false
    }
    this.pending.delete(body.requestId)
    clearTimeout(pending.timer)
    pending.resolve(body.decision)
    return true
  }

  /**
   * Read-only view of pending approvals. Used by diagnostic
   * endpoints + tests. Excludes the resolver Promise + timer.
   */
  listPending(): ReadonlyArray<{
    readonly requestId: string
    readonly credentialId: string
    readonly expiresAt: number
  }> {
    return [...this.pending.values()].map(p => ({
      requestId: p.requestId,
      credentialId: p.credentialId,
      expiresAt: p.expiresAt,
    }))
  }

  // -------------------------------------------------------------------------
  // HMAC helpers — internal
  // -------------------------------------------------------------------------

  private sign(requestId: string, credentialId: string, expiresAt: number): string {
    return createHmac('sha256', this.hmacKey)
      .update(`${requestId}|${credentialId}|${expiresAt}`)
      .digest('hex')
  }

  private verify(
    requestId: string,
    credentialId: string,
    expiresAt: number,
    candidate: string,
  ): boolean {
    const expected = this.sign(requestId, credentialId, expiresAt)
    if (expected.length !== candidate.length) return false
    try {
      return timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(candidate, 'hex'),
      )
    } catch {
      // `Buffer.from('xx', 'hex')` returns whatever it can parse; a
      // malformed hex string can produce different byte lengths and
      // make timingSafeEqual throw. Treat as failure.
      return false
    }
  }
}
