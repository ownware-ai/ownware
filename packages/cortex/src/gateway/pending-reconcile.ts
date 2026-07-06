/**
 * PendingReconciles — per-thread "the tool list may be stale" flag.
 *
 * Producers (any call site that makes profile OR vault state diverge
 * from what a running session is holding):
 *   - `POST /profiles/:id/mcp` | `DELETE /profiles/:id/mcp/:serverId`
 *   - `POST /profiles/:id/composio` | `DELETE /profiles/:id/composio/:slug`
 *   - `PUT /profiles/:id` (writes agent.json; may change tools block)
 *   - `ConnectorStatusBus` subscriber — a composio toolkit flipped to
 *     `ready` or back; only mark threads whose profile declares the
 *     affected connector so unrelated sessions stay untouched.
 *
 * Consumers:
 *   - `handlers/run.ts` — at the top of every `submitMessage`, consume
 *     the pending flag for the thread. If set, run `reconcileSessionTools`
 *     before dispatching to Loom.
 *
 * Why separate from the session object: marking doesn't require the
 * session to exist (a profile edit can happen on a thread that has
 * never started). The flag lives on the gateway state layer and the
 * consume-site guards against missing sessions.
 *
 * Concurrency story — two flavours needed:
 *   1. **Idempotent mark/consume** — multiple producers may hit the
 *      same thread before the user's next message lands. Second+
 *      marks are free; consume is edge-triggered.
 *   2. **Per-thread reconcile mutex** — two simultaneous submitMessage
 *      calls on the same thread shouldn't both fire reconcile (double
 *      addTool -> duplicate-name throw). The `withReconcileLock`
 *      helper gives each call site a turnstile; the second caller
 *      awaits the first and sees `pending=false` on its own consume.
 */

import type { ManagedTools } from '../profile/reconcile.js'

export class PendingReconciles {
  /**
   * Threads marked as needing a reconcile on their next turn. Set
   * semantics (membership only). Absence = clean.
   */
  private readonly threads = new Set<string>()

  /**
   * Per-thread reconcile in-flight promise. Used by `withReconcileLock`
   * to serialize concurrent reconciles on the same thread. Cleared in
   * the `finally` so a reconcile error doesn't leak the lock.
   */
  private readonly locks = new Map<string, Promise<unknown>>()

  /**
   * Per-thread snapshot of connector-sourced tools currently installed
   * on the thread's Loom session. Owned by this tracker (not
   * SessionCompanions) because reconcile + managed are a single
   * concept and splitting them across two owners invites drift. The
   * run handler captures the initial snapshot after a fresh
   * `assembleAgent` and hands it here; each reconcile updates in
   * place.
   */
  private readonly managed = new Map<string, ManagedTools>()

  /**
   * Mark a thread as pending. Idempotent — a thread that's already
   * marked stays marked; the next consume reports `true` exactly once.
   */
  mark(threadId: string): void {
    this.threads.add(threadId)
  }

  /**
   * Edge-triggered read: returns `true` iff the thread was marked
   * pending, and clears the mark. Subsequent consume calls return
   * `false` until the next mark.
   */
  consume(threadId: string): boolean {
    if (!this.threads.has(threadId)) return false
    this.threads.delete(threadId)
    return true
  }

  /**
   * Peek without consuming. Rarely useful — exposed for tests and
   * diagnostics. Prefer `consume` in the hot path so the flag can't
   * be observed stale.
   */
  isPending(threadId: string): boolean {
    return this.threads.has(threadId)
  }

  /**
   * Clear pending flags for every thread. Called on gateway shutdown
   * for symmetry; not strictly necessary since the tracker dies with
   * the process.
   */
  clear(): void {
    this.threads.clear()
    this.managed.clear()
  }

  /**
   * Get the connector-managed tools snapshot for a thread. `undefined`
   * when no session has been born for this thread yet. The reconcile
   * path treats `undefined` as "first reconcile → diff against empty
   * map" but that path is normally skipped — reconcile only runs
   * after an initial snapshot was stashed via `setManaged`.
   */
  getManaged(threadId: string): ManagedTools | undefined {
    return this.managed.get(threadId)
  }

  /**
   * Install a managed-tools snapshot for a thread. Called:
   *   - Once at session creation, with the connector tools produced
   *     by the assembler's provider pass.
   *   - Once per successful reconcile, with the fresh snapshot
   *     returned by `reconcileSessionTools`.
   */
  setManaged(threadId: string, m: ManagedTools): void {
    this.managed.set(threadId, m)
  }

  /**
   * Drop a thread's managed snapshot. Called when the session is
   * deleted (thread teardown).
   */
  deleteManaged(threadId: string): void {
    this.managed.delete(threadId)
  }

  /**
   * Run `body` under a per-thread mutex. If another call is already
   * running for the same thread, await it first (chained), then run.
   *
   * The mutex protects `reconcileSessionTools` + the subsequent Loom
   * `submitMessage` dispatch from two concurrent calls racing the
   * `session.tools` mutation. It does NOT serialize the actual model
   * stream — that's Loom's responsibility and Loom's Session already
   * disallows overlapping streams on the same instance.
   */
  async withReconcileLock<T>(
    threadId: string,
    body: () => Promise<T>,
  ): Promise<T> {
    const prior = this.locks.get(threadId)
    // Chain: wait for the prior to settle (success or failure) before
    // starting ours. We don't care about the prior's result — that's
    // the prior caller's problem.
    const chained = (async () => {
      if (prior) {
        try { await prior } catch { /* prior's error isn't ours */ }
      }
      return body()
    })()
    this.locks.set(threadId, chained)
    try {
      return await chained
    } finally {
      // Only clear if we're still the head of the queue. Another
      // caller that set itself after us is now responsible for
      // clearing its own entry.
      if (this.locks.get(threadId) === chained) {
        this.locks.delete(threadId)
      }
    }
  }
}
