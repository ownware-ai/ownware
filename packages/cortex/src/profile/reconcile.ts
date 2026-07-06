/**
 * Live tool reconcile — turn-boundary propagation of profile changes
 * into an already-running Loom Session.
 *
 * Problem it solves
 * -----------------
 * Without this, a chat session's tool list is frozen at session
 * creation. A user who attaches Gmail to their profile mid-
 * conversation has to either restart the gateway or start a new
 * thread before the agent can call Gmail. That's a v0 concession;
 * production expectation is "I added a tool, the agent can use it."
 *
 * Algorithm
 * ---------
 *  1. Rerun the registered connector providers against the CURRENT
 *     profile + vault state. This produces the "desired" set of
 *     connector-sourced tools.
 *  2. Diff by name against the caller-held `managed` snapshot (the
 *     set of tools this module installed on the session previously).
 *  3. `session.addTool(t)` for each new name; `session.removeTool(n)`
 *     for each removed name. Unchanged names keep their existing Tool
 *     binding on the session untouched.
 *  4. Return a fresh `managed` snapshot for the caller to stash; all
 *     subsequent reconciles diff against it.
 *
 * Invariants
 * ----------
 *  - **Never throws.** Any provider failure is captured in
 *    `result.errors[]`; the caller decides whether to surface. The
 *    session's prior tool list is left intact on any failure path.
 *  - **Idempotent.** Calling with no profile/vault change produces
 *    zero add/remove calls and an empty `added`/`removed`.
 *  - **No mid-turn calls.** The only supported call site is the start
 *    of `submitMessage` (before Loom dispatches to the provider).
 *    Callers MUST NOT invoke this while a turn is streaming.
 *  - **v1 scope: connector providers only.** MCP server add/remove
 *    is intentionally out of scope — it requires MCPManager
 *    lifecycle surgery tracked on a separate board. Existing MCP
 *    tools on the session are untouched; they keep working.
 *
 * Called from
 * -----------
 *  - `handlers/run.ts` — at the top of each `submitMessage` when the
 *    per-thread `PendingReconciles` tracker reports pending.
 *
 * Marked by
 * ---------
 *  - `handlers/profiles.ts` + `handlers/mcp.ts` — after attach/detach
 *    mutations write `agent.json` and invalidate the registry entry.
 *  - `server.ts` — subscribes to `ConnectorStatusBus` and marks
 *    threads whose profile declares the affected connector.
 */

import type { Session, Tool } from '@ownware/loom'
import type { LoadedProfile } from './loader.js'
import type {
  ConnectorToolProvider,
  ConnectorToolProviderResult,
} from '../connector/providers/types.js'

/**
 * Snapshot of connector-sourced tools currently installed on the
 * session, keyed by tool name. The caller (sessionCompanions)
 * threads this through each reconcile and receives a fresh snapshot
 * back. Treating this as immutable at the boundary keeps
 * concurrent-reconcile behaviour sane without an allocator-heavy
 * copy-on-write scheme.
 */
export type ManagedTools = ReadonlyMap<string, Tool>

export interface ReconcileOptions {
  /**
   * Providers to run against the profile. Typically the same list
   * passed to `assembleAgent` at session creation — pass-through so
   * reconcile stays in lockstep with assembly.
   */
  readonly providers: readonly ConnectorToolProvider[]
  /**
   * Test seam — override the logger. Production callers rely on the
   * default `console.warn`.
   */
  readonly log?: (line: string) => void
}

export interface ProviderError {
  readonly provider: string
  readonly message: string
}

export interface ReconcileResult {
  /** Tool names newly added to the session. */
  readonly added: readonly string[]
  /** Tool names removed from the session. */
  readonly removed: readonly string[]
  /**
   * Per-provider errors encountered while computing the desired set.
   * A non-empty list does NOT mean the reconcile failed; each errored
   * provider is treated as "contributes nothing this round" and the
   * rest of the reconcile proceeds. Callers that want to surface
   * these to the user (SSE warning, toast) consult this array.
   */
  readonly errors: readonly ProviderError[]
  /** Wall time spent inside the reconcile. For observability. */
  readonly durationMs: number
  /**
   * Fresh snapshot of the connector-sourced tools installed on the
   * session after this reconcile settled. Caller stashes it and
   * passes it back next time.
   */
  readonly managed: ManagedTools
}

/**
 * Reconcile a live session's connector-sourced tool list against the
 * latest profile declaration + vault state. See module docstring for
 * invariants + algorithm.
 */
export async function reconcileSessionTools(
  session: Session,
  prior: ManagedTools,
  profile: LoadedProfile,
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  // Defensive: reconcile's core contract is "never throws." A caller
  // that hands us a crashy logger must not bring that down. Wrap once
  // here so every call site below can log with no try/catch boilerplate.
  const rawLog = options.log ?? ((line) => { console.warn(line) })
  const logFn = (line: string): void => {
    try { rawLog(line) } catch { /* logger is best-effort */ }
  }
  const startedAt = performanceNow()
  const errors: ProviderError[] = []

  // 1. Compute desired set across every registered provider. Each
  //    provider's failure is isolated: we capture the error, skip
  //    its contribution, and continue. Collisions between providers
  //    are captured as errors too (we trust the first, skip the
  //    rest) — mirrors `runToolProviders`'s throw-on-collision but
  //    softened because reconcile must never throw.
  const desired = new Map<string, Tool>()
  for (const provider of options.providers) {
    let result: ConnectorToolProviderResult
    try {
      result = await provider.getToolsForProfile(profile, { existingTools: [] })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push({ provider: provider.source, message: msg })
      logFn(`[ownware] reconcile: provider '${provider.source}' failed: ${msg}`)
      continue
    }
    // Stubs count as desired tools — the assembly path treats them
    // as first-class so the agent sees an honest "not connected"
    // tool rather than a silent gap. Reconcile mirrors that.
    for (const t of [...result.tools, ...result.stubs]) {
      if (desired.has(t.name)) {
        errors.push({
          provider: provider.source,
          message: `Duplicate tool name '${t.name}'; first provider wins`,
        })
        continue
      }
      desired.set(t.name, t)
    }
  }

  // 2. Diff by name against the prior snapshot.
  const added: string[] = []
  const removed: string[] = []

  for (const [name, tool] of desired) {
    if (!prior.has(name)) {
      // NEW — install on the session.
      try {
        session.addTool(tool)
        added.push(name)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push({
          provider: 'session',
          message: `addTool('${name}') failed: ${msg}`,
        })
      }
    }
    // else: already present — leave session untouched. The tool
    // object reference on the session stays stable; its internal
    // state (e.g. composio connectedAccountId) is captured at
    // assembly time. When that underlying state changes (reconnect
    // with new token), the next failed call at runtime is how the
    // user learns; v2 adds force-replace on status-bus reconnect
    // events.
  }

  for (const name of prior.keys()) {
    if (!desired.has(name)) {
      try {
        session.removeTool(name)
        removed.push(name)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push({
          provider: 'session',
          message: `removeTool('${name}') failed: ${msg}`,
        })
      }
    }
  }

  // 3. Build the new snapshot. Desired minus any names we failed to
  //    add (so the next reconcile retries them instead of assuming
  //    they're installed).
  const addedSet = new Set(added)
  const managed = new Map<string, Tool>()
  for (const [name, tool] of desired) {
    if (prior.has(name) || addedSet.has(name)) {
      managed.set(name, tool)
    }
    // names in desired but not prior and not addedSet = we tried to
    // add but failed. Skip from the snapshot so the next attempt
    // treats them as new again.
  }

  return {
    added,
    removed,
    errors,
    durationMs: Math.max(0, performanceNow() - startedAt),
    managed,
  }
}

/**
 * Build an initial `ManagedTools` snapshot from the connector-sourced
 * tools produced by the assembler at session creation. This is what
 * the sessionCompanions stash so the first reconcile has a valid
 * baseline to diff against.
 *
 * Identifying which of the assembler's tools came from connector
 * providers (vs builtins / MCP) requires the caller to tell us —
 * the assembler already ran the providers once and knows which
 * tools each produced. We accept that list directly.
 */
export function initialManagedTools(
  connectorTools: readonly Tool[],
): ManagedTools {
  const m = new Map<string, Tool>()
  for (const t of connectorTools) m.set(t.name, t)
  return m
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Monotonic wall-time reader. `performance.now()` when available,
 * `Date.now()` fallback for older Node targets.
 */
function performanceNow(): number {
  if (typeof globalThis.performance?.now === 'function') {
    return globalThis.performance.now()
  }
  return Date.now()
}
