/**
 * ComposioReconciler — periodic vendor-side health check.
 *
 * Problem this solves
 * -------------------
 * The completion poller (`connector/completion/poller.ts`) watches a
 * `pending` row from initiation through to `ready` / `failed`. Once a
 * row is `ready` we stop polling — but a vendor-side revocation
 * (user clicked "Remove app" in the Composio dashboard, the OAuth
 * token expired and refresh failed, the org-level auth_config was
 * deleted) flips the vendor's `connected_accounts` row to
 * `INACTIVE` / `EXPIRED` without touching our local store. The user
 * sees "Connected" in the client but every `executeTool` call fails.
 *
 * Pre-F4.c, the only flip-back mechanism was the on-demand
 * `POST /connectors/composio/resync` endpoint — the user had to know
 * to click "Recheck" before the connector card could go red. Real
 * users won't click it; they'll just see broken tools and wonder
 * what's wrong.
 *
 * Design
 * ------
 * - **One call per tick, regardless of how many connectors exist.**
 *   `ComposioClient.listConnectedAccounts({ userId })` returns every
 *   row for the install identity in a single paged walk. Per-connector
 *   `getConnectedAccount` would scale linearly with toolkit count —
 *   not acceptable when a user has 20 active connections.
 * - **Per-gateway singleton.** The gateway constructs one reconciler
 *   at boot; it never spawns more. Concurrent ticks are coalesced
 *   (`inFlight` guard) so a slow vendor response can't stack.
 * - **setInterval-based scheduler with explicit cleanup.**
 *   `start()` / `stop()` are symmetric; `stop()` is idempotent.
 *   The interval is unref'd so it never holds the event loop alive.
 * - **Surgical emit.** Only emit `connector.status_changed` when the
 *   vendor row's state diverges from what local storage believes.
 *   A row that's still ACTIVE produces no event; only `lastVerifiedAt`
 *   moves forward (via `touchVerified`).
 * - **Errors fail loudly.** A failed `listConnectedAccounts` is
 *   logged with context. The current tick aborts; no `lastVerifiedAt`
 *   updates happen (we never lie about freshness on a failed probe).
 *   Next tick retries.
 *
 * State transitions emitted
 * -------------------------
 *   - local `ready`  & vendor `INACTIVE` / `EXPIRED` / `FAILED`
 *       → emit `auth_error`, mark connection `failed` locally.
 *   - local `ready`  & vendor `ACTIVE`
 *       → touchVerified only (no event).
 *   - local `ready`  & vendor returns no row for this id
 *       → emit `stale` (vendor has no record of this account; could
 *         be a transient API issue or a since-deleted row). Don't
 *         flip the local row to `failed` — the next reconcile may
 *         restore it. Leaving `ready` locally with `stale` on the
 *         wire is intentional: the UI shows "Reconnecting…" while
 *         we re-probe. After `staleToleranceMs` of continuous staleness
 *         we escalate to `auth_error`.
 *
 * Scope (F4.c-1)
 * --------------
 * This module ships the reconciler. The wire projection of
 * `lastVerifiedAt` from the connections row into `Connector.lastVerifiedAt`
 * (registry layer) ships in F4.c-2 alongside the call-site migration.
 * The reconciler writes `last_verified_at` today so the field is
 * populated in storage when projection wires up.
 *
 * Added 2026-05-16 (F4.c-1, status taxonomy migration).
 */

import type { ComposioClient } from './client.js'
import type { ConnectorConnectionsStore } from '../connections/store.js'
import type { ConnectorStatusBus } from '../status-bus.js'

const COMPOSIO_SOURCE = 'composio'

/**
 * Default reconcile interval. 90s splits the 60-120s window from the
 * F4.c brief. Each tick is one paged walk of `listConnectedAccounts`
 * for the install user — typically one page (≤100 active connections),
 * so ~1 HTTP call / 90s. Composio's free-tier limits are 600 req/min;
 * a single user could not exceed those at this rate.
 */
export const DEFAULT_RECONCILE_INTERVAL_MS = 90 * 1000

/**
 * After this many milliseconds of being unable to verify a row
 * (vendor returns no record across successive ticks), escalate from
 * `stale` to `auth_error`. Default = 3 missed ticks at the default
 * interval (~4.5 minutes).
 */
export const DEFAULT_STALE_TOLERANCE_MS = 4 * 60 * 1000 + 30 * 1000

/**
 * Vendor status values that indicate the row is no longer usable and
 * the user must reauthorize.
 */
const VENDOR_AUTH_ERROR_STATUSES: ReadonlySet<string> = new Set([
  'INACTIVE',
  'EXPIRED',
  'FAILED',
])

const VENDOR_ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'ACTIVE',
])

export interface ComposioReconcilerOptions {
  readonly client: ComposioClient
  readonly connections: ConnectorConnectionsStore
  readonly statusBus: ConnectorStatusBus
  /** Composio user id for this install (the same value the resync handler uses). */
  readonly defaultUserId: string
  /** Tick interval in ms. Defaults to {@link DEFAULT_RECONCILE_INTERVAL_MS}. */
  readonly intervalMs?: number
  /**
   * When the vendor returns no row for a locally-`ready` connection,
   * mark the wire status `stale`. After this many ms of continuous
   * staleness (no vendor confirmation), escalate to `auth_error`.
   * Defaults to {@link DEFAULT_STALE_TOLERANCE_MS}.
   */
  readonly staleToleranceMs?: number
  /** Page size when walking `listConnectedAccounts`. Default 100. */
  readonly pageSize?: number
  /** Test seam — override the clock. */
  readonly now?: () => number
  /** Test seam — override the log sink. */
  readonly log?: (line: string) => void
}

/**
 * Per-tick outcome — surfaced for tests and observability.
 */
export interface ReconcileTickResult {
  readonly status: 'ok' | 'error'
  readonly checked: number
  readonly verified: number
  readonly markedAuthError: number
  readonly markedStale: number
  readonly durationMs: number
  readonly reason?: string
}

export class ComposioReconciler {
  private readonly client: ComposioClient
  private readonly connections: ConnectorConnectionsStore
  private readonly statusBus: ConnectorStatusBus
  private readonly defaultUserId: string
  private readonly intervalMs: number
  private readonly staleToleranceMs: number
  private readonly pageSize: number
  private readonly nowFn: () => number
  private readonly logFn: (line: string) => void

  private timer: ReturnType<typeof setInterval> | null = null
  private started = false
  private inFlight: Promise<ReconcileTickResult> | null = null

  /**
   * Per-connection-id "first observed as stale" timestamp. When the
   * vendor consistently fails to return a row for a locally-`ready`
   * connection, we record the first miss here and escalate to
   * `auth_error` once `now - first-miss > staleToleranceMs`. Cleared
   * when the vendor confirms ACTIVE again or when we escalate.
   */
  private readonly staleSince = new Map<string, number>()

  constructor(opts: ComposioReconcilerOptions) {
    this.client = opts.client
    this.connections = opts.connections
    this.statusBus = opts.statusBus
    this.defaultUserId = opts.defaultUserId
    this.intervalMs = Math.max(1000, opts.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS)
    this.staleToleranceMs = Math.max(0, opts.staleToleranceMs ?? DEFAULT_STALE_TOLERANCE_MS)
    this.pageSize = Math.max(1, opts.pageSize ?? 100)
    this.nowFn = opts.now ?? Date.now
    this.logFn = opts.log ?? ((line) => { console.log(line) })
  }

  /**
   * Begin the periodic reconciliation. Synchronous — never blocks.
   *
   * The first tick fires after `intervalMs`; we do NOT auto-trigger an
   * immediate tick at start because the gateway already runs the
   * on-demand resync handler at boot for any user that lands on the
   * Tools surface. Doubling up at start would create a thundering-herd
   * pattern when many gateways boot together (e.g. in tests).
   */
  start(): void {
    if (this.started) return
    this.started = true

    this.timer = setInterval(() => {
      void this.reconcileNow().catch((err: unknown) => {
        // Defense — `reconcileNow` returns its own error shape; this
        // should never run, but a logic bug must not silently stop the
        // schedule.
        this.logFn(
          `[ownware] composio.reconcile: unexpected throw — ${stringifyError(err)}`,
        )
      })
    }, this.intervalMs)

    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      this.timer.unref()
    }
  }

  /** Stop the periodic timer and clear state. Idempotent. */
  stop(): void {
    this.started = false
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.staleSince.clear()
  }

  /**
   * Run one reconcile pass synchronously. Coalesces with any
   * already-in-flight tick — a second call returns the same promise.
   *
   * Public for tests and the on-demand resync handler (which can call
   * this in addition to its catalog walk).
   */
  reconcileNow(): Promise<ReconcileTickResult> {
    if (this.inFlight !== null) return this.inFlight
    this.inFlight = this.runTick().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async runTick(): Promise<ReconcileTickResult> {
    const startedAt = this.nowFn()

    // Phase 1: snapshot the local `ready` rows. The reconciler only
    // checks ready rows — `pending` is the completion poller's job
    // and terminal rows (`failed`, `expired`) don't need re-checking.
    const localReady = this.connections.listActiveByStatus(
      COMPOSIO_SOURCE,
      'ready',
      this.defaultUserId,
    )

    if (localReady.length === 0) {
      // Nothing to reconcile. We still consider the tick "ok" so the
      // log surface doesn't go silent during a fresh install.
      return {
        status: 'ok',
        checked: 0,
        verified: 0,
        markedAuthError: 0,
        markedStale: 0,
        durationMs: Math.max(0, this.nowFn() - startedAt),
      }
    }

    // Phase 2: ONE vendor call to fetch every account for this user.
    // We don't filter by status here — we need to see both ACTIVE
    // (verify) and inactive variants (downgrade). The vendor returns
    // both in the same paged walk.
    let vendorById: Map<string, string>
    try {
      vendorById = await this.fetchVendorAccountStatuses()
    } catch (err) {
      const reason = stringifyError(err)
      this.logFn(
        `[ownware] composio.reconcile: error — ${reason}`,
      )
      return {
        status: 'error',
        checked: localReady.length,
        verified: 0,
        markedAuthError: 0,
        markedStale: 0,
        durationMs: Math.max(0, this.nowFn() - startedAt),
        reason,
      }
    }

    // Phase 3: diff each local row against the vendor's snapshot.
    let verified = 0
    let markedAuthError = 0
    let markedStale = 0
    const now = this.nowFn()

    for (const row of localReady) {
      // The reconciler keys on the connection_id, which for Composio
      // is set equal to the vendor's `connected_account_id` at
      // upsert-time (see connect-handler + resync). Same is true of
      // vendor_account_id when populated.
      const vendorKey = row.vendorAccountId ?? row.connectionId
      const vendorStatus = vendorById.get(vendorKey)

      if (vendorStatus === undefined) {
        // Vendor has no record. Could be a transient miss (their list
        // endpoint dropped the row mid-walk) or a real disappearance.
        // First miss: emit `stale` and start the tolerance clock.
        // Subsequent misses past the tolerance: escalate to auth_error.
        const firstMissAt = this.staleSince.get(row.connectionId)
        if (firstMissAt === undefined) {
          this.staleSince.set(row.connectionId, now)
          this.statusBus.emit({
            connectorId: row.connectorId,
            source: COMPOSIO_SOURCE,
            status: 'stale',
            reason: 'Vendor returned no record for this connection',
          })
          markedStale++
          continue
        }
        if (now - firstMissAt >= this.staleToleranceMs) {
          // Tolerance exceeded — escalate. Local row becomes `failed`
          // so the next assembler pass shows the connector as needing
          // reauthorization in the agent prompt too.
          this.connections.markFailed({
            connectionId: row.connectionId,
            reason: 'Vendor no longer reports this connection. Please reconnect.',
          })
          this.staleSince.delete(row.connectionId)
          this.statusBus.emit({
            connectorId: row.connectorId,
            source: COMPOSIO_SOURCE,
            status: 'auth_error',
            previousStatus: 'stale',
            reason: 'Connection missing on vendor side beyond tolerance',
          })
          markedAuthError++
          continue
        }
        // Still within tolerance — re-emit `stale` to refresh any UI
        // observer that joined since the first miss. The bus dedupes
        // no-op transitions (same status as cached), so this is a
        // cheap no-op except on the first observation.
        this.statusBus.emit({
          connectorId: row.connectorId,
          source: COMPOSIO_SOURCE,
          status: 'stale',
          reason: 'Vendor still missing this connection',
        })
        continue
      }

      if (VENDOR_ACTIVE_STATUSES.has(vendorStatus)) {
        // Healthy. Touch the row's last_verified_at, drop any stale
        // tracking, and emit ready (the bus will no-op if we were
        // already on ready in the cache — which is the common case).
        this.connections.touchVerified(row.connectionId, now)
        this.staleSince.delete(row.connectionId)
        this.statusBus.emit({
          connectorId: row.connectorId,
          source: COMPOSIO_SOURCE,
          status: 'ready',
          reason: 'Vendor reports ACTIVE',
        })
        verified++
        continue
      }

      if (VENDOR_AUTH_ERROR_STATUSES.has(vendorStatus)) {
        // Vendor explicitly rejects this row — flip local state to
        // failed (so the assembler stops handing the agent a ready
        // tool) and emit auth_error so the client shows "Reauthorize".
        this.connections.markFailed({
          connectionId: row.connectionId,
          reason: `Vendor reports status ${vendorStatus}. Please reconnect.`,
        })
        this.staleSince.delete(row.connectionId)
        this.statusBus.emit({
          connectorId: row.connectorId,
          source: COMPOSIO_SOURCE,
          status: 'auth_error',
          reason: `Vendor reports ${vendorStatus}`,
        })
        markedAuthError++
        continue
      }

      // INITIALIZING / INITIATED — vendor side is mid-OAuth.
      // Conservative: leave the local `ready` row alone (this row
      // was previously confirmed ready; the vendor's "initiating"
      // here likely means a refresh-token rotation we shouldn't
      // surface to the user). Don't bump lastVerifiedAt; next tick
      // re-evaluates.
    }

    const durationMs = Math.max(0, this.nowFn() - startedAt)
    this.logFn(
      `[ownware] composio.reconcile: ok — checked=${localReady.length} verified=${verified} authError=${markedAuthError} stale=${markedStale} in ${durationMs}ms`,
    )
    return {
      status: 'ok',
      checked: localReady.length,
      verified,
      markedAuthError,
      markedStale,
      durationMs,
    }
  }

  /**
   * Walk `listConnectedAccounts` for the install user, paging until
   * the cursor exhausts. Returns a map of `connected_account_id` →
   * vendor status string. We intentionally do NOT filter by status
   * at the API layer — we need both ACTIVE (for verify) and
   * INACTIVE/EXPIRED/FAILED (for auth_error transition) in the same
   * snapshot.
   */
  private async fetchVendorAccountStatuses(): Promise<Map<string, string>> {
    const MAX_PAGES = 20 // 20 * pageSize = 2000 active accounts — far beyond any realistic single user
    const out = new Map<string, string>()
    let cursor: string | undefined
    let pages = 0

    while (true) {
      const page = await this.client.listConnectedAccounts({
        userId: this.defaultUserId,
        limit: this.pageSize,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      pages++
      for (const item of page.items) {
        if (typeof item.id === 'string' && item.id.length > 0) {
          out.set(item.id, item.status)
        }
      }
      const next = page.next_cursor
      if (!next || next.length === 0) break
      cursor = next
      if (pages >= MAX_PAGES) {
        this.logFn(
          `[ownware] composio.reconcile: reached MAX_PAGES=${MAX_PAGES.toString()}; stopping walk`,
        )
        break
      }
    }
    return out
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
