/**
 * ConnectionPoller — source-agnostic engine for driving
 * `ConnectionCompletionListener`s to completion.
 *
 * Responsibilities (owned HERE so every source gets them for free):
 *   - Exponential backoff (3s → 4.5s → 6.75s → ... capped at 30s)
 *   - Max duration (10 minutes), then `expired`
 *   - Idempotent registration (re-register same id = noop)
 *   - Cancellation (`cancel(id)` aborts mid-flight, removes state)
 *   - Writes the terminal row to the connections store
 *   - Emits a `ConnectorStatusEvent` on terminal transitions
 *   - Crash isolation: a listener that throws is caught; the
 *     connection is marked `failed` with the thrown message. The
 *     gateway stays up.
 *
 * NOT responsible for:
 *   - Deciding which listener handles which source (the manager does)
 *   - Vendor-specific HTTP plumbing (listeners do)
 *   - Cross-restart persistence (v1 uses `expireStaleOnBoot()` instead)
 */

import type { ConnectorConnectionsStore } from '../connections/store.js'
import type { ConnectorStatusBus } from '../status-bus.js'
import type {
  BeforeConnectionTerminal,
  ConnectionCompletionListener,
  ConnectionCheckResult,
  ConnectionTerminalState,
} from './types.js'
import type { ConnectorSource, ConnectorStatus } from '../schema.js'

// ---------------------------------------------------------------------------
// Config (exported so tests can build a faster poller)
// ---------------------------------------------------------------------------

export interface PollerConfig {
  /** Initial delay between polls, ms. Default: 1500. */
  readonly initialDelayMs: number
  /** Backoff multiplier. Default: 1.4. */
  readonly backoffMultiplier: number
  /** Upper bound on per-poll delay, ms. Default: 10_000. */
  readonly maxDelayMs: number
  /** Total budget before the connection is marked `expired`, ms.
   * Default: 600_000 (10 min). */
  readonly maxDurationMs: number
}

/**
 * Tuned for OAuth completion latency. Most flows finish in 5–30s
 * (popup load + provider login + scope approval + Composio's webhook
 * to itself). The cadence below polls at least once every ~2.5s for
 * the first ~10s, plateaus at 10s thereafter:
 *
 *   1.5s, 2.1s, 2.9s, 4.1s, 5.8s, 8.1s, 10s, 10s, 10s, 10s, ...
 *
 * Pre-2026-04-27 values (3s / 1.5x / 30s cap) made the worst-case
 * gap 30s after the first minute, which produced the user-visible
 * "click Allow → wait → tab away → come back → THEN it's connected"
 * pattern: the visibility-driven `composio/resync` was rescuing the
 * lazy poller. The faster cadence below means the poller catches
 * completion within ~2-3s of when Composio records ACTIVE, no
 * tab-switching needed. CPU cost is negligible (one HTTP call per
 * second average vs the prior multi-second gaps).
 *
 * Total duration budget unchanged at 10 min — slow / abandoned OAuth
 * flows still expire honestly.
 */
export const DEFAULT_POLLER_CONFIG: PollerConfig = {
  initialDelayMs: 1_500,
  backoffMultiplier: 1.4,
  maxDelayMs: 10_000,
  maxDurationMs: 600_000,
}

// ---------------------------------------------------------------------------
// Per-registration state
// ---------------------------------------------------------------------------

interface PollState {
  readonly connectionId: string
  readonly connectorId: string
  readonly source: string
  readonly listener: ConnectionCompletionListener
  readonly startedAt: number
  readonly abortController: AbortController
  timeoutHandle: ReturnType<typeof setTimeout> | null
  currentDelay: number
  /** Metadata carried from the store, used by listeners that need a
   * redirect/callback URL on every poll. */
  metadata: Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// ConnectionPoller
// ---------------------------------------------------------------------------

export class ConnectionPoller {
  private readonly active = new Map<string, PollState>()
  private readonly config: PollerConfig

  constructor(
    private readonly store: ConnectorConnectionsStore,
    private readonly statusBus: ConnectorStatusBus,
    config: Partial<PollerConfig> = {},
    private readonly beforeTerminal: BeforeConnectionTerminal = async () => {},
  ) {
    this.config = { ...DEFAULT_POLLER_CONFIG, ...config }
  }

  /**
   * Register (or idempotently refresh) a connection for polling.
   *
   * The row must already exist in the connections store as `pending` —
   * the caller typically creates it via `store.upsertPending()` just
   * before calling this.
   *
   * Safe to call twice with the same connectionId: the second call is
   * a noop (returns the existing state). To RESTART polling with a
   * fresh budget, call `cancel(id)` first.
   */
  register(
    connectionId: string,
    listener: ConnectionCompletionListener,
  ): void {
    if (this.active.has(connectionId)) return

    const row = this.store.findByConnectionId(connectionId)
    if (!row) {
      throw new Error(
        `ConnectionPoller.register: unknown connectionId "${connectionId}". ` +
          `Call store.upsertPending() before register().`,
      )
    }
    if (row.status !== 'pending') {
      // Nothing to poll. Don't register.
      return
    }

    const state: PollState = {
      connectionId,
      connectorId: row.connectorId,
      source: row.source,
      listener,
      startedAt: Date.now(),
      abortController: new AbortController(),
      timeoutHandle: null,
      currentDelay: this.config.initialDelayMs,
      metadata: row.metadata,
    }
    this.active.set(connectionId, state)
    this.scheduleNext(state, this.config.initialDelayMs)
  }

  /** Abort and remove the given connection's state, if registered. */
  cancel(connectionId: string): void {
    const state = this.active.get(connectionId)
    if (!state) return
    if (state.timeoutHandle) clearTimeout(state.timeoutHandle)
    state.abortController.abort()
    this.active.delete(connectionId)
  }

  /** Abort every active registration. Used on gateway shutdown. */
  cancelAll(): void {
    for (const id of [...this.active.keys()]) this.cancel(id)
  }

  /** True if the poller is currently tracking the given connection. */
  isActive(connectionId: string): boolean {
    return this.active.has(connectionId)
  }

  /** Number of currently tracked connections. Observability + tests. */
  get activeCount(): number {
    return this.active.size
  }

  // ── internals ────────────────────────────────────────────────────

  private scheduleNext(state: PollState, delayMs: number): void {
    state.timeoutHandle = setTimeout(() => {
      void this.runOne(state)
    }, delayMs)
  }

  private async runOne(state: PollState): Promise<void> {
    // Bail if we were cancelled between scheduling and firing.
    if (!this.active.has(state.connectionId)) return

    // Budget check FIRST so a slow listener doesn't run past expiry.
    const elapsed = Date.now() - state.startedAt
    if (elapsed >= this.config.maxDurationMs) {
      await this.terminate(state, 'expired', {
        reason: 'Connection attempt timed out.',
      })
      return
    }

    let result: ConnectionCheckResult
    try {
      result = await state.listener.checkStatus(
        state.connectionId,
        state.metadata,
        state.abortController.signal,
      )
    } catch (err) {
      // Listener threw. Terminal failure — the gateway must not crash.
      await this.terminate(state, 'failed', {
        reason: 'Connection status check failed. Please retry.',
      })
      return
    }

    // Cancelled during the in-flight call.
    if (!this.active.has(state.connectionId)) return

    this.store.touchPolled(state.connectionId)

    switch (result.status) {
      case 'pending': {
        this.scheduleRetry(state)
        return
      }
      case 'ready': {
        await this.terminate(state, 'ready', {
          ...(result.vendorAccountId !== undefined ? { vendorAccountId: result.vendorAccountId } : {}),
          ...(result.vendorUserId !== undefined ? { vendorUserId: result.vendorUserId } : {}),
        })
        return
      }
      case 'failed': {
        await this.terminate(state, 'failed', {
          reason: result.errorReason,
        })
        return
      }
      case 'not_found': {
        await this.terminate(state, 'failed', {
          reason: result.errorReason ?? 'Vendor has no record of this connection attempt.',
        })
        return
      }
    }
  }

  private scheduleRetry(state: PollState): void {
    const nextDelay = Math.min(
      state.currentDelay * this.config.backoffMultiplier,
      this.config.maxDelayMs,
    )
    state.currentDelay = nextDelay
    this.scheduleNext(state, nextDelay)
  }

  private finish(state: PollState): void {
    this.active.delete(state.connectionId)
    if (state.timeoutHandle) clearTimeout(state.timeoutHandle)
  }

  private async terminate(
    state: PollState,
    terminal: ConnectionTerminalState,
    opts: {
      reason?: string
      vendorAccountId?: string
      vendorUserId?: string
    },
  ): Promise<void> {
    if (!this.active.has(state.connectionId)) return
    const before = this.store.findByConnectionId(state.connectionId)
    if (!before || before.status !== 'pending') {
      this.finish(state)
      return
    }

    try {
      await this.beforeTerminal({
        connectionId: state.connectionId,
        connectorId: state.connectorId,
        source: state.source,
        terminal,
        metadata: before.metadata,
      })
    } catch {
      if (!this.active.has(state.connectionId)) return
      const current = this.store.findByConnectionId(state.connectionId)
      if (!current || current.status !== 'pending') {
        this.finish(state)
        return
      }
      this.scheduleRetry(state)
      return
    }

    // Cancellation or another terminal writer may win while cleanup awaits.
    // Store transitions compare-and-set pending, and only that winner emits.
    if (!this.active.has(state.connectionId)) return

    // Update the durable row FIRST so a crash between write and emit
    // still leaves the correct state on disk.
    let transitioned = false
    switch (terminal) {
      case 'ready': {
        const result = this.store.markReady({
          connectionId: state.connectionId,
          ...(opts.vendorAccountId !== undefined ? { vendorAccountId: opts.vendorAccountId } : {}),
          ...(opts.vendorUserId !== undefined ? { vendorUserId: opts.vendorUserId } : {}),
        })
        transitioned = result.transitioned
        break
      }
      case 'failed': {
        const result = this.store.markFailed({
          connectionId: state.connectionId,
          reason: opts.reason ?? 'Connection failed.',
        })
        transitioned = result.transitioned
        break
      }
      case 'expired': {
        const result = this.store.markExpired(state.connectionId, opts.reason)
        transitioned = result?.transitioned === true
        break
      }
    }
    this.finish(state)
    if (!transitioned) return

    // Map the terminal state to the (coarser) connector status vocabulary
    // used by the ConnectorStatusBus.
    const statusForBus: ConnectorStatus =
      terminal === 'ready' ? 'ready' : terminal === 'failed' ? 'error' : 'error'

    // `source` on the connections store is a free-form string; the
    // status bus accepts the ConnectorSource enum. When they match we
    // pass through; otherwise we fall back to `'mcp'` (the unified
    // label that absorbed `'custom_mcp'` in Phase 16, 2026-05-01).
    const sourceForBus: ConnectorSource =
      state.source === 'builtin' ? 'builtin'
      : state.source === 'mcp' ? 'mcp'
      : state.source === 'composio' ? 'composio'
      : 'mcp'

    this.statusBus.emit({
      connectorId: state.connectorId,
      source: sourceForBus,
      status: statusForBus,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    })
  }
}
