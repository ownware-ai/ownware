/**
 * HITL registry — the one-line contract every Human-In-The-Loop pause
 * plugs into so the gateway's abort path cancels them uniformly.
 *
 * Why this exists:
 *   `session.abort()` only flips the loop's AbortSignal. That signal is
 *   checked at turn boundaries and inside the provider stream — NOT
 *   inside an `await hitl.*` Promise. A HITL that sits on an unresolved
 *   Promise while the user aborts will therefore park forever, the
 *   runner's `finally` never runs, and the thread stays "running" in
 *   the gateway's books — hydrate lies to the client, the UI shows
 *   "working…" until the 5-minute HITL timeout finally fires.
 *
 *   The fix, for every HITL, is the same: resolve every pending Promise
 *   with deny semantics so the awaiting tool wakes up, emits its
 *   `*.response` event, returns, and the next loop iteration hits the
 *   signal check and exits cleanly.
 *
 *   Before this file: the abort handler hard-referenced each HITL by
 *   name (`runtime.hitl.denyAll()`, `companions.credentialHITL.denyAll()`).
 *   Every new HITL required an edit to `handlers/run.ts`. One forgotten
 *   edit = the same "thread stuck running forever" bug in production.
 *
 *   After this file: HITLs live in `SessionCompanions.hitls: HITLLike[]`.
 *   The abort handler iterates. New HITLs plug in at construction and
 *   abort handles them for free. The bug is now structurally impossible
 *   for HITLs that satisfy the interface; it can only come back if a
 *   new author adds a non-registered HITL — which is now the one thing
 *   the four-invariant checklist and this file's docs tell them not to
 *   do.
 */

/**
 * The minimum surface every registered HITL must expose. Both today's
 * HITLs (`HumanInTheLoop` in Loom, `CredentialHITL` in cortex) already
 * have `denyAll()` + a `pendingCount` getter — the registry plugs them
 * in via {@link asHitlLike} without touching either class.
 *
 * `name` is for observability: the abort handler logs `<name>` with the
 * pre-deny pending count so an incident trace shows exactly which HITL
 * was holding the generator when the user aborted. A fresh HITL author
 * picks a short stable identifier (`'permission'`, `'credential'`,
 * `'mfa'`, …) and sticks with it.
 *
 * `pendingCount` is read, not mutated. It's a property getter on the
 * source HITL so the registry sees the live count at the moment the
 * abort handler touches it — {@link asHitlLike} preserves that by
 * forwarding through its own getter rather than capturing a snapshot.
 *
 * `denyAll` returns `void` by contract. The source HITLs may return
 * `number` (e.g. `CredentialHITL.denyAll(): number`) — TypeScript's
 * structural typing accepts that narrowing because a caller that
 * declared `void` cannot read the return value anyway.
 */
export interface HITLLike {
  readonly name: string
  readonly pendingCount: number
  denyAll(): void
}

/**
 * Adapter: wrap a HITL-like object (one with a `pendingCount` getter
 * and a `denyAll()` method) as a {@link HITLLike} suitable for pushing
 * into `SessionCompanions.hitls`.
 *
 * We never spread the source — spreading an instance does not copy
 * getter descriptors, and `pendingCount` on both live HITLs is a
 * getter. Instead we install a getter on the returned object that
 * forwards to the source, preserving liveness.
 *
 * The function is deliberately tiny — zero branching, zero ambient
 * behaviour. It exists so the registration site at
 * `handlers/run.ts:setSessionCompanions` is one readable call per
 * HITL, and so the interface can grow in the future (e.g. an
 * `isInterruptible(requestId): boolean` method) without every
 * existing HITL class having to implement every new field.
 */
export function asHitlLike(
  name: string,
  source: { readonly pendingCount: number; denyAll: () => unknown },
): HITLLike {
  return {
    name,
    get pendingCount() {
      return source.pendingCount
    },
    denyAll: () => {
      source.denyAll()
    },
  }
}

/**
 * Deny every pending request on every registered HITL. Returns the
 * pre-deny count per HITL so the caller can log what was actually
 * cancelled — useful for incident forensics ("was anything blocked
 * when the user aborted?").
 *
 * Never throws. An individual `denyAll()` that throws (a broken
 * future HITL) logs and is skipped — abort must still complete so the
 * 2s watchdog in the handler can finish the job. The error is
 * re-thrown only in development (via `process.env['NODE_ENV']` gate)
 * so regressions don't hide.
 */
export function denyAllHitls(
  hitls: readonly HITLLike[],
): ReadonlyArray<{ name: string; pendingBefore: number }> {
  const snapshot: Array<{ name: string; pendingBefore: number }> = []
  for (const h of hitls) {
    const pendingBefore = h.pendingCount
    snapshot.push({ name: h.name, pendingBefore })
    try {
      h.denyAll()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[hitl] ${h.name}.denyAll() threw:`, err)
      if (process.env['NODE_ENV'] === 'development') throw err
    }
  }
  return snapshot
}
