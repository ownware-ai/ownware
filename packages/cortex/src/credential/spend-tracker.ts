/**
 * Spend tracker (board: credentials-unification — C29).
 *
 * Hard ceiling on LLM cost per credential per period. The architectural
 * promise (D1, D5) is "deterministic, runtime-enforced" — pre-flight
 * estimator hard-fails BEFORE the LLM call goes out; post-flight
 * true-up reconciles tokenizer drift. Spend is read off the same
 * `credential_audit_log` table that backs the audit endpoint, so
 * there's exactly one persistence surface for usage data.
 *
 * Phase-5 scope:
 *   - The math + check API ship now.
 *   - Wired to no live call site yet (the resolver lands in C22; the
 *     LLM provider adapter cuts over in C24). Tests use synthetic
 *     audit data to exercise the full pre/post-flight loop.
 *
 * Cost estimation:
 *   - Caller passes `estimatedCostUsd` to `checkSpendCap`. We do NOT
 *     ship a tokenizer in this module — that's the LLM adapter's job.
 *     Different providers diverge enough on tokenization that owning
 *     it here would just produce a worse estimate. The board's
 *     mitigation (R2) calls for `@anthropic-ai/tokenizer` + `tiktoken`
 *     in the adapter; this module is provider-agnostic.
 */

import type Database from 'better-sqlite3'
import type { SpendCap } from './schema.js'

// ---------------------------------------------------------------------------
// Period helpers — UTC ISO date math, no external dep
// ---------------------------------------------------------------------------

/**
 * Start of the current rolling window for the given period.
 *
 *   - 'day'   → midnight UTC of today
 *   - 'month' → first of the current calendar month, midnight UTC
 *
 * Returned as ISO 8601 with the UTC offset so it round-trips through
 * the audit table's TEXT timestamps cleanly.
 */
export function periodStart(period: SpendCap['period'], now: Date = new Date()): string {
  if (period === 'day') {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    return d.toISOString()
  }
  // month
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  return d.toISOString()
}

// ---------------------------------------------------------------------------
// Read API — current period spend
// ---------------------------------------------------------------------------

/**
 * Total spent on this credential within the current period window.
 * Sums `actual_cost_usd` (post-flight true-ups) where present, falling
 * back to `estimated_cost_usd` for in-flight rows that haven't been
 * reconciled yet. Either column missing is treated as 0.
 */
export function currentPeriodSpend(
  db: Database.Database,
  credentialId: string,
  period: SpendCap['period'],
  now: Date = new Date(),
): { readonly windowStart: string; readonly totalUsd: number } {
  const windowStart = periodStart(period, now)
  // COALESCE the actual onto the estimate so true-ups dominate but
  // pre-flight estimates still count for in-flight calls (otherwise
  // a flurry of fast LLM calls could blow through a cap because
  // none of them have reconciled yet).
  const row = db
    .prepare(
      `
        SELECT COALESCE(
          SUM(COALESCE(actual_cost_usd, estimated_cost_usd, 0)),
          0
        ) AS total
        FROM credential_audit_log
        WHERE credential_id = ?
          AND event_type = 'resolve'
          AND created_at >= ?
      `,
    )
    .get(credentialId, windowStart) as { total: number }
  return { windowStart, totalUsd: row.total }
}

// ---------------------------------------------------------------------------
// Pre-flight check
// ---------------------------------------------------------------------------

export interface SpendCheckOk {
  readonly status: 'ok'
  readonly windowStart: string
  readonly currentSpendUsd: number
  readonly capUsd: number
  readonly remainingUsd: number
}

export interface SpendCheckDenied {
  readonly status: 'denied'
  readonly reason: 'SPEND_CAP_EXCEEDED'
  readonly windowStart: string
  readonly currentSpendUsd: number
  readonly capUsd: number
  readonly estimatedCostUsd: number
}

export type SpendCheckResult = SpendCheckOk | SpendCheckDenied

/**
 * Pre-flight cost check. Caller supplies the estimated cost of the
 * about-to-fire LLM call; this function looks at the period window
 * and refuses if the estimate would push the rolling total past
 * the cap.
 *
 * Failure mode: STRICT. The whole point of D5 is that this is
 * deterministic — an unknown estimator producing 0 should NOT silently
 * pass. Callers MUST supply a real estimate; if they can't, they MUST
 * fail-OPEN at their layer with a logged warning (per board R2),
 * NOT pass `0` here.
 */
export function checkSpendCap(
  db: Database.Database,
  credentialId: string,
  cap: SpendCap,
  estimatedCostUsd: number,
  now: Date = new Date(),
): SpendCheckResult {
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
    throw new Error(
      `checkSpendCap: estimatedCostUsd must be a non-negative finite number (got ${estimatedCostUsd})`,
    )
  }
  const { windowStart, totalUsd } = currentPeriodSpend(db, credentialId, cap.period, now)
  if (totalUsd + estimatedCostUsd > cap.amountUsd) {
    return {
      status: 'denied',
      reason: 'SPEND_CAP_EXCEEDED',
      windowStart,
      currentSpendUsd: totalUsd,
      capUsd: cap.amountUsd,
      estimatedCostUsd,
    }
  }
  return {
    status: 'ok',
    windowStart,
    currentSpendUsd: totalUsd,
    capUsd: cap.amountUsd,
    remainingUsd: cap.amountUsd - totalUsd - estimatedCostUsd,
  }
}
