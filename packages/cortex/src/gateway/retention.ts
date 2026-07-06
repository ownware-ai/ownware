/**
 * Agent-events retention — prune the root-agent event log for terminal
 * threads while preserving the consolidated `messages` snapshot AND all
 * sub-agent transcripts.
 *
 * Contract:
 *   - Only `agent_events` rows with `agent_id = 'root'` are eligible
 *     for deletion. `messages`, `threads`, `usage_records`, and
 *     sub-agent rows (`agent_id != 'root'`) are untouched.
 *   - Eligibility is by LAST-EVENT AGE on the root stream, not by
 *     `thread.status`. Since the 2026-04-22 stream audit + CRITICAL-2
 *     fix, `thread.status='active'` validly spans idle gaps between
 *     turns (flipped on every run start, flipped back on every finally)
 *     — so status is no longer a reliable "this thread is quiescent"
 *     signal. Last-event age is. A thread with no root events in
 *     `retentionDays` is either cleanly completed and un-revisited or
 *     stalled/abandoned; either way the raw log is safe to drop.
 *   - Threads with any live SSE subscriber on the root agent are
 *     skipped — the "live is always a suffix of disk" invariant would
 *     break if we deleted rows a subscriber has not yet read.
 *
 * Why sub-agent rows survive: the root timeline is fully reconstructible
 * from `messages`, but sub-agent transcripts have no equivalent snapshot
 * yet. Pruning them would leave the client's "View thread" modal blank for
 * archived sub-agents — a UX cliff. Until per-agent messages exist,
 * retention only prunes what `messages` already covers.
 *
 * Shipping default: disabled. Opt-in via OWNWARE_EVENT_RETENTION_ENABLED.
 * The `messages` snapshot contract (see gateway/CLAUDE.md) is the
 * prerequisite — pruning without the client hydrating from /hydrate would
 * destroy history.
 */

import type { CortexDatabase } from './db/database.js'
import type { EventBus } from './event-bus.js'
import { ROOT_AGENT_ID } from './event-bus.js'

export interface RetentionConfig {
  /** Master switch. Default false — opt-in only. */
  readonly enabled: boolean
  /**
   * Minimum age of a terminal thread's `updated_at` before its events
   * become eligible for pruning. Default 7 days.
   */
  readonly retentionDays: number
  /**
   * Interval between automatic retention passes when running inside the
   * gateway. Default 6 hours. One-shot callers (tests, admin endpoint)
   * bypass the timer and call `runOnce()` directly.
   */
  readonly intervalMs: number
}

export const DEFAULT_RETENTION: RetentionConfig = {
  enabled: false,
  retentionDays: 7,
  intervalMs: 6 * 60 * 60 * 1000,
}

export interface RetentionStats {
  readonly threadsEligible: number
  readonly threadsSkippedLiveSubscriber: number
  readonly threadsPruned: number
  readonly rowsDeleted: number
  readonly cutoffIso: string
}

/**
 * Load retention config from environment variables. Called once at
 * gateway startup; the returned config is frozen for the process.
 */
export function loadRetentionConfig(env: NodeJS.ProcessEnv = process.env): RetentionConfig {
  const enabled = env['OWNWARE_EVENT_RETENTION_ENABLED'] === 'true' ||
                  env['OWNWARE_EVENT_RETENTION_ENABLED'] === '1'
  const retentionDaysRaw = env['OWNWARE_EVENT_RETENTION_DAYS']
  const retentionDays = retentionDaysRaw && /^\d+$/.test(retentionDaysRaw)
    ? parseInt(retentionDaysRaw, 10)
    : DEFAULT_RETENTION.retentionDays
  const intervalRaw = env['OWNWARE_EVENT_RETENTION_INTERVAL_MS']
  const intervalMs = intervalRaw && /^\d+$/.test(intervalRaw)
    ? parseInt(intervalRaw, 10)
    : DEFAULT_RETENTION.intervalMs
  return { enabled, retentionDays, intervalMs }
}

/**
 * Run one retention pass synchronously-ish (the DB calls are sync, the
 * subscriber check is sync too). Returns stats so tests and operators
 * can log the outcome.
 *
 * Safe to call even when `enabled=false`; the caller decides whether
 * to invoke it. Kept pure — no timers here.
 */
export function runRetentionOnce(
  db: CortexDatabase,
  bus: EventBus,
  config: RetentionConfig,
): RetentionStats {
  const cutoffMs = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000
  const cutoffIso = new Date(cutoffMs).toISOString()

  const eligible = db.listThreadsWithQuietRootAgent(cutoffMs)
  let prunedCount = 0
  let skipped = 0
  let rowsDeleted = 0

  for (const threadId of eligible) {
    // Never delete from under a live SSE subscriber. Sub-agent events
    // could be pruned safely here, but the conservative rule is: if
    // anyone is watching any agent on this thread, skip the whole
    // thread until next pass.
    if (bus.hasSubscribers(threadId, ROOT_AGENT_ID)) {
      skipped++
      continue
    }

    const deleted = db.pruneAgentEvents(threadId)
    rowsDeleted += deleted
    if (deleted > 0) prunedCount++
  }

  return {
    threadsEligible: eligible.length,
    threadsSkippedLiveSubscriber: skipped,
    threadsPruned: prunedCount,
    rowsDeleted,
    cutoffIso,
  }
}

/**
 * Background scheduler — starts a timer that runs `runRetentionOnce`
 * at `intervalMs`. Returns a stop function so the gateway can cancel
 * the timer on shutdown.
 *
 * No-op when `enabled=false`. Any exception inside the pass is caught
 * and logged so a single bad run never kills the schedule.
 */
export function startRetentionSchedule(
  db: CortexDatabase,
  bus: EventBus,
  config: RetentionConfig,
  onPass?: (stats: RetentionStats) => void,
): () => void {
  if (!config.enabled) return () => {}

  let stopped = false
  const tick = () => {
    if (stopped) return
    try {
      const stats = runRetentionOnce(db, bus, config)
      onPass?.(stats)
    } catch (err) {
      console.error('[retention] pass failed:', err)
    }
  }
  const handle = setInterval(tick, config.intervalMs)
  // Don't keep the event loop alive just for retention — the gateway's
  // HTTP server has its own refs.
  if (typeof handle.unref === 'function') handle.unref()

  // Kick one pass right away so startup prunes stale data before the
  // first interval elapses.
  tick()

  return () => {
    stopped = true
    clearInterval(handle)
  }
}
