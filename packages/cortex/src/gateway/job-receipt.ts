import type { RuntimeConsequence } from '../runtime/port.js'
import type { SqliteDatabase } from '../storage/sqlite-driver.js'
import type { EffectReceiptOutcome } from './effect-receipt-store.js'

/**
 * The job receipt — what a finished run is observed to have done.
 *
 * Built only from `gateway_runs.consequence` and the immutable effect receipts.
 * Assistant text is never read: the agent may write prose about its work, but
 * it is never the source of a count, a duration or a status.
 *
 * This projection makes NO absence claims. "Nothing was deleted" and "no emails
 * were sent" are not derivable — receipts record what was observed, not what
 * was never attempted, and they do not classify an action as a delete or a
 * send. Every number here counts receipts; where evidence is missing the answer
 * is `indeterminate`, never zero.
 */

export type JobActionDisposition = 'completed' | 'indeterminate'

export interface JobReceiptAction {
  readonly effectId: string
  readonly toolCallId: string
  readonly toolName: string
  /** Outcome of the latest receipt for this action, by append order. */
  readonly outcome: EffectReceiptOutcome
  /**
   * Strongest consequence observed, not the latest. Consequence only advances,
   * so taking the maximum is the honest reading: an action that reached
   * `effect_possible` never becomes safe again.
   */
  readonly consequence: RuntimeConsequence
  /**
   * `completed` means a terminal outcome was observed — including failure and
   * denial. It does NOT mean the action succeeded, and never means an external
   * effect did or did not occur; read `consequence` for that.
   *
   * `indeterminate` means no terminal outcome was observed. Reconciliation
   * collapses "interrupted mid-dispatch" and "never dispatched" into this one
   * state, so the two cannot be separated from receipts alone.
   */
  readonly disposition: JobActionDisposition
  readonly firstObservedAt: number
  readonly lastObservedAt: number
  /** Receipts recorded for this action, useful for drilling into evidence. */
  readonly receiptCount: number
}

export interface JobReceipt {
  readonly runId: string
  readonly status: string
  readonly terminal: boolean
  /**
   * Whether a stop was requested for this run.
   *
   * The stop account a reader wants ("kept / cut mid-way") is exactly the
   * `completed` / `indeterminate` split already computed per action: an action
   * whose ending was observed is kept, whichever side of the stop it fell; one
   * whose ending was not observed is unknown, likewise. Classifying actions by
   * comparing `observed_at` against `cancel_requested_at` would add nothing but
   * risk — those are supplied timestamps, and a runtime adapter's clock is not
   * the Gateway's. So this flag exists to let a surface phrase the same two
   * buckets as a stop rather than a completion, and nothing more.
   */
  readonly stopRequested: boolean
  readonly stopRequestedAt: number | null
  /** Strongest consequence durably recorded for the run as a whole. */
  readonly consequence: RuntimeConsequence
  readonly actions: readonly JobReceiptAction[]
  readonly totals: {
    /** Distinct tool actions with at least one receipt. */
    readonly observedActions: number
    readonly completed: number
    readonly indeterminate: number
    readonly succeeded: number
    readonly failed: number
    readonly denied: number
    /** Actions whose consequence reached `effect_possible` or stronger. */
    readonly effectPossibleOrStronger: number
    readonly effectConfirmed: number
  }
}

export type JobReceiptErrorCode = 'run_missing'

export class JobReceiptError extends Error {
  override readonly name = 'JobReceiptError'

  constructor(readonly code: JobReceiptErrorCode) {
    super(`Job receipt unavailable (${code}).`)
  }
}

const CONSEQUENCE_RANK: Readonly<Record<RuntimeConsequence, number>> = {
  none_observed: 0,
  output_observed: 1,
  effect_possible: 2,
  effect_confirmed: 3,
}

const TERMINAL_OUTCOMES: ReadonlySet<string> = new Set([
  'succeeded', 'failed', 'denied',
])

interface ActionRow {
  readonly effect_id: string
  readonly tool_call_id: string
  readonly tool_name: string
  readonly latest_outcome: string
  readonly strongest_consequence: string
  readonly first_observed_at: number
  readonly last_observed_at: number
  readonly receipt_count: number
}

/**
 * Assemble the receipt for one run.
 *
 * Aggregates by effect IDENTITY, not by receipt: one action emits several
 * receipts as it advances (intent, outcome, authority confirmation), and
 * counting receipts would overstate how much happened.
 */
export function assembleJobReceipt(db: SqliteDatabase, runId: string): JobReceipt {
  const run = db.prepare(`
    SELECT id, status, consequence, terminal_at, cancel_requested_at
    FROM gateway_runs WHERE id = ?
  `).get(runId) as {
    readonly id: string
    readonly status: string
    readonly consequence: string
    readonly terminal_at: number | null
    readonly cancel_requested_at: number | null
  } | undefined
  if (run === undefined) throw new JobReceiptError('run_missing')

  // The latest outcome comes from the highest receipt_seq — the database's own
  // append order — never from observed_at, which is a supplied timestamp and
  // can repeat or move backwards.
  const rows = db.prepare(`
    SELECT
      identity.effect_id       AS effect_id,
      identity.tool_call_id    AS tool_call_id,
      identity.tool_name       AS tool_name,
      (SELECT latest.outcome FROM effect_receipts AS latest
        WHERE latest.effect_id = identity.effect_id
        ORDER BY latest.receipt_seq DESC LIMIT 1) AS latest_outcome,
      (SELECT ranked.consequence FROM effect_receipts AS ranked
        WHERE ranked.effect_id = identity.effect_id
        ORDER BY CASE ranked.consequence
          WHEN 'effect_confirmed' THEN 3
          WHEN 'effect_possible'  THEN 2
          WHEN 'output_observed'  THEN 1
          ELSE 0 END DESC, ranked.receipt_seq DESC
        LIMIT 1) AS strongest_consequence,
      MIN(receipt.observed_at) AS first_observed_at,
      MAX(receipt.observed_at) AS last_observed_at,
      COUNT(receipt.receipt_id) AS receipt_count
    FROM effect_identities AS identity
    JOIN effect_receipts AS receipt ON receipt.effect_id = identity.effect_id
    WHERE identity.run_id = ?
    GROUP BY identity.effect_id
    ORDER BY MIN(receipt.receipt_seq)
  `).all(runId) as ActionRow[]

  const actions: JobReceiptAction[] = rows.map((row) => ({
    effectId: row.effect_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    outcome: row.latest_outcome as EffectReceiptOutcome,
    consequence: row.strongest_consequence as RuntimeConsequence,
    disposition: TERMINAL_OUTCOMES.has(row.latest_outcome) ? 'completed' : 'indeterminate',
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    receiptCount: row.receipt_count,
  }))

  const count = (predicate: (action: JobReceiptAction) => boolean): number =>
    actions.filter(predicate).length

  return {
    runId: run.id,
    status: run.status,
    terminal: run.terminal_at !== null,
    stopRequested: run.cancel_requested_at !== null,
    stopRequestedAt: run.cancel_requested_at,
    consequence: run.consequence as RuntimeConsequence,
    actions,
    totals: {
      observedActions: actions.length,
      completed: count((a) => a.disposition === 'completed'),
      indeterminate: count((a) => a.disposition === 'indeterminate'),
      succeeded: count((a) => a.outcome === 'succeeded'),
      failed: count((a) => a.outcome === 'failed'),
      denied: count((a) => a.outcome === 'denied'),
      effectPossibleOrStronger: count(
        (a) => CONSEQUENCE_RANK[a.consequence] >= CONSEQUENCE_RANK.effect_possible),
      effectConfirmed: count((a) => a.consequence === 'effect_confirmed'),
    },
  }
}

/**
 * Dialect-agnostic port. Handlers must not know which storage adapter is
 * underneath them, and `rawDbHandle` is a deprecated SQLite-only surface.
 */
export interface JobReceiptRepository {
  assemble(runId: string): Promise<JobReceipt>
}

/** SQLite implementation of {@link JobReceiptRepository}. */
export function createSqliteJobReceiptRepository(db: SqliteDatabase): JobReceiptRepository {
  return { assemble: async (runId) => assembleJobReceipt(db, runId) }
}
