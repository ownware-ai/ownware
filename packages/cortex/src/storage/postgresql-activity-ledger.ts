import {
  ActivityLedgerError,
  validateActivityLedgerInput,
  type ActivityLedgerAppendInput,
} from '../gateway/activity-ledger.js'
import type { PostgreSqlQueryClient } from './postgresql-repository.js'

/**
 * PostgreSQL half of the activity ledger append.
 *
 * Deliberately mirrors the SQLite implementation statement for statement so
 * the two dialects cannot drift into different evidence semantics. The shared
 * structural envelope comes from `validateActivityLedgerInput`; only the SQL
 * differs.
 */

interface RunScopeRow {
  readonly thread_id: string
  readonly profile_id: string
  readonly workspace_id: string | null
}

/**
 * Append one index row inside the caller's already-open transaction.
 *
 * Returns the assigned `ledger_seq`.
 */
export async function appendActivityLedgerRowPostgreSql(
  client: PostgreSqlQueryClient,
  input: ActivityLedgerAppendInput,
): Promise<number> {
  validateActivityLedgerInput(input)

  // Scope comes from the run, never from the caller — see the SQLite twin.
  const scope = await client.query<RunScopeRow>(`
    SELECT thread_id, profile_id, workspace_id
    FROM ownware.gateway_runs WHERE id = $1
  `, [input.runId])
  const row = scope.rows[0]
  if (row === undefined) throw new ActivityLedgerError('run_missing')

  // MAX+1 rather than an identity column: identity values can commit out of
  // assignment order, which would hide a row behind a cursor a reader already
  // passed. A concurrent append loses the PRIMARY KEY race and retries.
  const sequence = await client.query<{ readonly value: string }>(`
    SELECT (COALESCE(MAX(ledger_seq), 0) + 1)::text AS value
    FROM ownware.activity_ledger
  `)
  const ledgerSeq = Number(sequence.rows[0]?.value ?? '')
  if (!Number.isSafeInteger(ledgerSeq) || ledgerSeq <= 0) {
    throw new ActivityLedgerError('invalid_input')
  }

  await client.query(`
    INSERT INTO ownware.activity_ledger (
      ledger_seq, family, receipt_id, run_id, thread_id, profile_id,
      workspace_id, occurred_at, origin, outcome, consequence, tool_name
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'live', $9, $10, $11)
  `, [
    ledgerSeq,
    input.family,
    input.receiptId,
    input.runId,
    row.thread_id,
    row.profile_id,
    row.workspace_id,
    input.occurredAt,
    input.outcome ?? null,
    input.consequence ?? null,
    input.toolName ?? null,
  ])

  return ledgerSeq
}
