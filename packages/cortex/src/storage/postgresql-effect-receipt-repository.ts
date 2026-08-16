import { randomUUID } from 'node:crypto'
import {
  EffectReceiptStoreError,
  isEffectReceiptUuid,
  isSafeEffectAuthorityRef,
  projectEffectReceipt,
  sameEffectObservation,
  validateEffectObservation,
  type EffectIdentityStorageRow,
  type EffectReceipt,
  type EffectReceiptRepository,
  type EffectReceiptStorageRow,
  type ObserveEffectInput,
} from '../gateway/effect-receipt-store.js'
import type { RuntimeConsequence } from '../runtime/port.js'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import type { PostgreSqlQueryClient } from './postgresql-repository.js'
import {
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from './postgresql-repository.js'

const CONSEQUENCE_RANK = new Map<RuntimeConsequence, number>([
  ['none_observed', 0],
  ['output_observed', 1],
  ['effect_possible', 2],
  ['effect_confirmed', 3],
])

const CONSEQUENCE_SQL_RANK = `CASE consequence
  WHEN 'none_observed' THEN 0
  WHEN 'output_observed' THEN 1
  WHEN 'effect_possible' THEN 2
  WHEN 'effect_confirmed' THEN 3
  ELSE -1
END`

interface PostgreSqlReceiptRow extends Omit<
  EffectReceiptStorageRow,
  'receipt_seq' | 'runtime_sequence' | 'observed_at'
> {
  readonly receipt_seq: string
  readonly runtime_sequence: string | null
  readonly observed_at: string
}

function normalizedReceipt(row: PostgreSqlReceiptRow): EffectReceiptStorageRow {
  return {
    ...row,
    receipt_seq: safeInteger(row.receipt_seq),
    runtime_sequence: row.runtime_sequence === null
      ? null
      : safeInteger(row.runtime_sequence),
    observed_at: safeInteger(row.observed_at),
  }
}

async function advanceRunConsequence(
  client: PostgreSqlQueryClient,
  runId: string,
  consequence: RuntimeConsequence,
  now: number,
): Promise<void> {
  const rank = CONSEQUENCE_RANK.get(consequence)
  if (rank === undefined) throw new EffectReceiptStoreError('invalid_input')
  await client.query(`
    UPDATE ownware.gateway_runs
    SET consequence = $1, updated_at = $2
    WHERE id = $3 AND ${CONSEQUENCE_SQL_RANK} < $4
  `, [consequence, now, runId, rank])
}

async function observeInTransaction(
  client: PostgreSqlQueryClient,
  input: ObserveEffectInput,
  now: number,
): Promise<EffectReceipt> {
  // The run row is the per-run append authority. It makes receipt_seq exact
  // under concurrent writers without relying on clocks or provider ordering.
  const run = await client.query(
    'SELECT 1 FROM ownware.gateway_runs WHERE id = $1 FOR UPDATE',
    [input.runId],
  )
  if (run.rowCount !== 1) throw new EffectReceiptStoreError('run_missing')

  const effectId = randomUUID()
  await client.query(`
    INSERT INTO ownware.effect_identities (
      effect_id, run_id, tool_call_id, tool_name, first_observed_at
    ) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (run_id, tool_call_id) DO NOTHING
  `, [effectId, input.runId, input.toolCallId, input.toolName, now])
  const identityResult = await client.query<EffectIdentityStorageRow>(`
    SELECT effect_id, run_id, tool_call_id, tool_name
    FROM ownware.effect_identities WHERE run_id = $1 AND tool_call_id = $2
  `, [input.runId, input.toolCallId])
  const identity = identityResult.rows[0]
  if (identity === undefined) throw new EffectReceiptStoreError('run_missing')
  if (identity.tool_name !== input.toolName) {
    throw new EffectReceiptStoreError('identity_conflict')
  }

  const receiptId = randomUUID()
  const sequenceResult = await client.query<{ readonly value: string }>(`
    SELECT (COALESCE(MAX(receipt_seq), 0) + 1)::text AS value
    FROM ownware.effect_receipts WHERE run_id = $1
  `, [input.runId])
  const sequence = safeInteger(sequenceResult.rows[0]?.value ?? '')
  await client.query(`
    INSERT INTO ownware.effect_receipts (
      receipt_id, receipt_seq, effect_id, run_id, observation_key, kind, outcome,
      consequence, authority_kind, authority_ref, runtime_sequence, observed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT DO NOTHING
  `, [
    receiptId,
    sequence,
    identity.effect_id,
    input.runId,
    input.observationKey,
    input.kind,
    input.outcome,
    input.consequence,
    input.authorityKind,
    input.authorityRef,
    input.runtimeSequence ?? null,
    now,
  ])
  const existingResult = await client.query<PostgreSqlReceiptRow>(`
    SELECT receipt.*, identity.tool_call_id, identity.tool_name
    FROM ownware.effect_receipts AS receipt
    JOIN ownware.effect_identities AS identity ON identity.effect_id = receipt.effect_id
    WHERE receipt.effect_id = $1 AND receipt.observation_key = $2
  `, [identity.effect_id, input.observationKey])
  const row = existingResult.rows[0]
  if (row === undefined) throw new EffectReceiptStoreError('observation_conflict')
  const normalized = normalizedReceipt(row)
  if (!sameEffectObservation(normalized, input)) {
    throw new EffectReceiptStoreError('observation_conflict')
  }
  await advanceRunConsequence(client, input.runId, input.consequence, now)
  return projectEffectReceipt(normalized)
}

async function reconcilePending(
  client: PostgreSqlQueryClient,
  runId: string,
  authorityRef: string,
  now: number,
): Promise<number> {
  const result = await client.query<EffectIdentityStorageRow>(`
    SELECT identity.effect_id, identity.run_id, identity.tool_call_id, identity.tool_name
    FROM ownware.effect_identities AS identity
    WHERE identity.run_id = $1
      AND EXISTS (
        SELECT 1 FROM ownware.effect_receipts AS receipt
        WHERE receipt.effect_id = identity.effect_id AND receipt.outcome = 'pending'
      )
      AND NOT EXISTS (
        SELECT 1 FROM ownware.effect_receipts AS receipt
        WHERE receipt.effect_id = identity.effect_id
          AND receipt.outcome IN ('succeeded', 'failed', 'denied', 'unknown')
      )
    ORDER BY identity.effect_id
    FOR UPDATE
  `, [runId])
  for (const identity of result.rows) {
    await observeInTransaction(client, {
      runId,
      toolCallId: identity.tool_call_id,
      toolName: identity.tool_name,
      observationKey: `recovery:${identity.effect_id}`,
      kind: 'reconciliation',
      outcome: 'unknown',
      consequence: 'effect_possible',
      authorityKind: 'reconciler',
      authorityRef,
    }, now)
  }
  return result.rows.length
}

export function createPostgreSqlEffectReceiptRepository(
  context: PostgreSqlRootRepositoryContext,
): EffectReceiptRepository {
  return {
    observe(input, now = Date.now()) {
      validateEffectObservation(input)
      if (!Number.isSafeInteger(now) || now < 0) {
        return Promise.reject(new EffectReceiptStoreError('invalid_input'))
      }
      return repositoryCall(context, 'effect_receipts', 'observe', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, (client) =>
          observeInTransaction(client, input, now)))
    },
    listForRun(runId, page) {
      if (
        !isEffectReceiptUuid(runId)
        || !Number.isSafeInteger(page.limit)
        || page.limit < 1
        || page.limit > 100
        || (page.cursor !== null && !isEffectReceiptUuid(page.cursor))
      ) return Promise.reject(new EffectReceiptStoreError('cursor_invalid'))
      return repositoryCall(context, 'effect_receipts', 'list', 'read_failed', async (client) => {
        let cursorSequence: number | null = null
        if (page.cursor !== null) {
          const cursor = await client.query<{ readonly receipt_seq: string }>(`
            SELECT receipt_seq FROM ownware.effect_receipts
            WHERE run_id = $1 AND receipt_id = $2
          `, [runId, page.cursor])
          if (cursor.rows[0] === undefined) throw new EffectReceiptStoreError('cursor_invalid')
          cursorSequence = safeInteger(cursor.rows[0].receipt_seq)
        }
        const result = await client.query<PostgreSqlReceiptRow>(`
          SELECT receipt.*, identity.tool_call_id, identity.tool_name
          FROM ownware.effect_receipts AS receipt
          JOIN ownware.effect_identities AS identity ON identity.effect_id = receipt.effect_id
          WHERE receipt.run_id = $1
            AND ($2::bigint IS NULL OR receipt.receipt_seq > $2)
          ORDER BY receipt.receipt_seq
          LIMIT $3
        `, [runId, cursorSequence, page.limit + 1])
        const rows = result.rows.map(normalizedReceipt)
        const more = rows.length > page.limit
        if (more) rows.pop()
        return {
          items: rows.map(projectEffectReceipt),
          nextCursor: more ? rows.at(-1)!.receipt_id : null,
        }
      })
    },
    markPendingUnknownForRun(runId, authorityRef, now = Date.now()) {
      if (
        !isEffectReceiptUuid(runId)
        || !isSafeEffectAuthorityRef(authorityRef)
        || !Number.isSafeInteger(now)
        || now < 0
      ) return Promise.reject(new EffectReceiptStoreError('invalid_input'))
      return repositoryCall(context, 'effect_receipts', 'reconcile_run', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, (client) =>
          reconcilePending(client, runId, authorityRef, now)))
    },
    reconcileInterrupted(authorityRef, now = Date.now()) {
      if (
        !isSafeEffectAuthorityRef(authorityRef)
        || !Number.isSafeInteger(now)
        || now < 0
      ) return Promise.reject(new EffectReceiptStoreError('invalid_input'))
      return repositoryCall(context, 'effect_receipts', 'reconcile_interrupted', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const runs = await client.query<{ readonly id: string }>(`
            SELECT id FROM ownware.gateway_runs WHERE status = 'indeterminate'
            ORDER BY id FOR UPDATE
          `)
          let count = 0
          for (const run of runs.rows) {
            count += await reconcilePending(client, run.id, authorityRef, now)
          }
          return count
        }))
    },
  }
}
