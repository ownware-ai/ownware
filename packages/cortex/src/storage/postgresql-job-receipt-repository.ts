import {
  JobReceiptError,
  type JobReceipt,
  type JobReceiptAction,
  type JobReceiptRepository,
} from '../gateway/job-receipt.js'
import type { RuntimeConsequence } from '../runtime/port.js'
import type { EffectReceiptOutcome } from '../gateway/effect-receipt-store.js'
import {
  repositoryCall,
  withPostgreSqlTransaction,
} from './postgresql-repository.js'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'

/**
 * PostgreSQL half of the job receipt. Mirrors the SQLite assembler statement
 * for statement — aggregation by effect identity, latest outcome by append
 * order, strongest consequence by rank — so the two dialects cannot drift
 * into different accounts of the same run.
 */

const CONSEQUENCE_RANK: Readonly<Record<RuntimeConsequence, number>> = {
  none_observed: 0,
  output_observed: 1,
  effect_possible: 2,
  effect_confirmed: 3,
}

const TERMINAL_OUTCOMES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'denied'])

interface RunRow {
  readonly id: string
  readonly status: string
  readonly consequence: string
  readonly terminal_at: string | null
  readonly cancel_requested_at: string | null
}

interface ActionRow {
  readonly effect_id: string
  readonly tool_call_id: string
  readonly tool_name: string
  readonly latest_outcome: string
  readonly strongest_consequence: string
  readonly first_observed_at: string
  readonly last_observed_at: string
  readonly receipt_count: string
}

function safeInteger(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new JobReceiptError('run_missing')
  return parsed
}

export function createPostgreSqlJobReceiptRepository(
  context: PostgreSqlRootRepositoryContext,
): JobReceiptRepository {
  return {
    assemble(runId: string): Promise<JobReceipt> {
      return repositoryCall(context, 'runs', 'job_receipt', 'read_failed', () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const runResult = await client.query<RunRow>(`
            SELECT id, status, consequence, terminal_at::text, cancel_requested_at::text
            FROM ownware.gateway_runs WHERE id = $1
          `, [runId])
          const run = runResult.rows[0]
          if (run === undefined) throw new JobReceiptError('run_missing')

          const rows = await client.query<ActionRow>(`
            SELECT
              identity.effect_id,
              identity.tool_call_id,
              identity.tool_name,
              (SELECT latest.outcome FROM ownware.effect_receipts AS latest
                WHERE latest.effect_id = identity.effect_id
                ORDER BY latest.receipt_seq DESC LIMIT 1) AS latest_outcome,
              (SELECT ranked.consequence FROM ownware.effect_receipts AS ranked
                WHERE ranked.effect_id = identity.effect_id
                ORDER BY CASE ranked.consequence
                  WHEN 'effect_confirmed' THEN 3
                  WHEN 'effect_possible'  THEN 2
                  WHEN 'output_observed'  THEN 1
                  ELSE 0 END DESC, ranked.receipt_seq DESC
                LIMIT 1) AS strongest_consequence,
              MIN(receipt.observed_at)::text AS first_observed_at,
              MAX(receipt.observed_at)::text AS last_observed_at,
              COUNT(receipt.receipt_id)::text AS receipt_count
            FROM ownware.effect_identities AS identity
            JOIN ownware.effect_receipts AS receipt
              ON receipt.effect_id = identity.effect_id
            WHERE identity.run_id = $1
            GROUP BY identity.effect_id, identity.tool_call_id, identity.tool_name
            ORDER BY MIN(receipt.receipt_seq)
          `, [runId])

          const actions: JobReceiptAction[] = rows.rows.map((row) => ({
            effectId: row.effect_id,
            toolCallId: row.tool_call_id,
            toolName: row.tool_name,
            outcome: row.latest_outcome as EffectReceiptOutcome,
            consequence: row.strongest_consequence as RuntimeConsequence,
            disposition: TERMINAL_OUTCOMES.has(row.latest_outcome)
              ? 'completed' as const
              : 'indeterminate' as const,
            firstObservedAt: safeInteger(row.first_observed_at),
            lastObservedAt: safeInteger(row.last_observed_at),
            receiptCount: safeInteger(row.receipt_count),
          }))
          const count = (predicate: (action: JobReceiptAction) => boolean): number =>
            actions.filter(predicate).length

          return {
            runId: run.id,
            status: run.status,
            terminal: run.terminal_at !== null,
            stopRequested: run.cancel_requested_at !== null,
            stopRequestedAt: run.cancel_requested_at === null
              ? null
              : safeInteger(run.cancel_requested_at),
            consequence: run.consequence as RuntimeConsequence,
            actions,
            totals: {
              observedActions: actions.length,
              completed: count((a) => a.disposition === 'completed'),
              indeterminate: count((a) => a.disposition === 'indeterminate'),
              succeeded: count((a) => a.outcome === 'succeeded'),
              failed: count((a) => a.outcome === 'failed'),
              denied: count((a) => a.outcome === 'denied'),
              effectPossibleOrStronger: count((a) =>
                CONSEQUENCE_RANK[a.consequence] >= CONSEQUENCE_RANK.effect_possible),
              effectConfirmed: count((a) => a.consequence === 'effect_confirmed'),
            },
          }
        }))
    },
  }
}
