import { randomUUID } from 'node:crypto'
import {
  EgressReceiptStoreError,
  canonicalEgressObservation,
  isEgressReceiptUuid,
  projectEgressReceipt,
  sameEgressObservation,
  validateEgressObservation,
  type EgressReceipt,
  type EgressReceiptRepository,
  type EgressReceiptStorageRow,
  type EgressReasonCode,
  type ObserveEgressInput,
} from '../gateway/egress-receipt-store.js'
import type { EgressMediation, EgressMode, EgressSourceKind, EgressTransport } from '@ownware/loom'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import type { PostgreSqlQueryClient } from './postgresql-repository.js'
import {
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from './postgresql-repository.js'

interface EgressIdentityRow {
  readonly dispatch_id: string
  readonly run_id: string
  readonly mode: EgressMode
  readonly source_kind: EgressSourceKind
  readonly source_ref: string
  readonly transport: EgressTransport
  readonly mediation: EgressMediation
}

interface PostgreSqlEgressReceiptRow extends Omit<
  EgressReceiptStorageRow,
  'receipt_seq' | 'observed_at'
> {
  readonly receipt_seq: string
  readonly observed_at: string
}

function normalized(row: PostgreSqlEgressReceiptRow): EgressReceiptStorageRow {
  return {
    ...row,
    receipt_seq: safeInteger(row.receipt_seq),
    observed_at: safeInteger(row.observed_at),
  }
}

async function observeInTransaction(
  client: PostgreSqlQueryClient,
  rawInput: ObserveEgressInput,
  now: number,
): Promise<EgressReceipt> {
  const input = canonicalEgressObservation(rawInput)
  const run = await client.query<{ readonly egress_mode: EgressMode }>(
    'SELECT egress_mode FROM ownware.gateway_runs WHERE id = $1 FOR UPDATE',
    [input.runId],
  )
  if (run.rowCount !== 1) throw new EgressReceiptStoreError('run_missing')
  let identityResult = await client.query<EgressIdentityRow>(`
    SELECT dispatch_id, run_id, mode, source_kind, source_ref, transport, mediation
    FROM ownware.egress_dispatches WHERE dispatch_id = $1
  `, [input.dispatchId])
  let identity = identityResult.rows[0]
  if (identity === undefined) {
    if (run.rows[0]?.egress_mode !== input.mode) {
      throw new EgressReceiptStoreError('invalid_input')
    }
    await client.query(`
      INSERT INTO ownware.egress_dispatches (
        dispatch_id, run_id, mode, source_kind, source_ref, transport, mediation, first_observed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      input.dispatchId,
      input.runId,
      input.mode,
      input.sourceKind,
      input.sourceRef,
      input.transport,
      input.mediation,
      now,
    ])
    identityResult = await client.query<EgressIdentityRow>(`
      SELECT dispatch_id, run_id, mode, source_kind, source_ref, transport, mediation
      FROM ownware.egress_dispatches WHERE dispatch_id = $1
    `, [input.dispatchId])
    identity = identityResult.rows[0]
  }
  if (identity === undefined) throw new EgressReceiptStoreError('run_missing')
  if (
    identity.run_id !== input.runId
    || identity.mode !== input.mode
    || identity.source_kind !== input.sourceKind
    || identity.source_ref !== input.sourceRef
    || identity.transport !== input.transport
    || identity.mediation !== input.mediation
  ) throw new EgressReceiptStoreError('identity_conflict')

  const existingResult = await client.query<PostgreSqlEgressReceiptRow>(`
    SELECT receipt.*, identity.mode, identity.source_kind, identity.source_ref,
           identity.transport, identity.mediation
    FROM ownware.egress_receipts AS receipt
    JOIN ownware.egress_dispatches AS identity
      ON identity.dispatch_id = receipt.dispatch_id
    WHERE receipt.dispatch_id = $1 AND receipt.observation_key = $2
  `, [input.dispatchId, input.observationKey])
  const existing = existingResult.rows[0]
  if (existing !== undefined) {
    const row = normalized(existing)
    if (!sameEgressObservation(row, input)) {
      throw new EgressReceiptStoreError('observation_conflict')
    }
    return projectEgressReceipt(row)
  }

  const sequenceResult = await client.query<{ readonly value: string }>(`
    SELECT (COALESCE(MAX(receipt_seq), 0) + 1)::text AS value
    FROM ownware.egress_receipts WHERE run_id = $1
  `, [input.runId])
  const receiptId = randomUUID()
  const sequence = safeInteger(sequenceResult.rows[0]?.value ?? '')
  const inserted = await client.query<PostgreSqlEgressReceiptRow>(`
    INSERT INTO ownware.egress_receipts (
      receipt_id, receipt_seq, dispatch_id, run_id, observation_key,
      destination_origin, phase, reason_code, observed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *, $10::text AS mode, $11::text AS source_kind,
      $12::text AS source_ref, $13::text AS transport, $14::text AS mediation
  `, [
    receiptId,
    sequence,
    input.dispatchId,
    input.runId,
    input.observationKey,
    input.destinationOrigin,
    input.phase,
    input.reasonCode,
    now,
    input.mode,
    input.sourceKind,
    input.sourceRef,
    input.transport,
    input.mediation,
  ])
  const row = inserted.rows[0]
  if (row === undefined) throw new EgressReceiptStoreError('observation_conflict')
  return projectEgressReceipt(normalized(row))
}

async function reconcilePending(
  client: PostgreSqlQueryClient,
  runId: string,
  reasonCode: EgressReasonCode,
  now: number,
): Promise<number> {
  const result = await client.query<EgressIdentityRow>(`
    SELECT identity.dispatch_id, identity.run_id, identity.mode, identity.source_kind,
      identity.source_ref, identity.transport, identity.mediation
    FROM ownware.egress_dispatches AS identity
    WHERE identity.run_id = $1
      AND EXISTS (
        SELECT 1 FROM ownware.egress_receipts AS receipt
        WHERE receipt.dispatch_id = identity.dispatch_id AND receipt.phase = 'dispatch_started'
      )
      AND NOT EXISTS (
        SELECT 1 FROM ownware.egress_receipts AS receipt
        WHERE receipt.dispatch_id = identity.dispatch_id
          AND receipt.phase IN ('response_observed', 'dispatch_failed', 'outcome_unknown')
      )
    ORDER BY identity.dispatch_id FOR UPDATE
  `, [runId])
  for (const identity of result.rows) {
    await observeInTransaction(client, {
      dispatchId: identity.dispatch_id,
      runId: identity.run_id,
      mode: identity.mode,
      sourceKind: identity.source_kind,
      sourceRef: identity.source_ref,
      transport: identity.transport,
      mediation: identity.mediation,
      observationKey: `reconcile:${reasonCode}`,
      destinationOrigin: null,
      phase: 'outcome_unknown',
      reasonCode,
    }, now)
  }
  return result.rows.length
}

export function createPostgreSqlEgressReceiptRepository(
  context: PostgreSqlRootRepositoryContext,
): EgressReceiptRepository {
  return {
    observe(input, now = Date.now()) {
      validateEgressObservation(input)
      if (!Number.isSafeInteger(now) || now < 0) {
        return Promise.reject(new EgressReceiptStoreError('invalid_input'))
      }
      return repositoryCall(context, 'egress_receipts', 'observe', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, (client) =>
          observeInTransaction(client, input, now)))
    },
    listForRun(runId, page) {
      if (
        !isEgressReceiptUuid(runId)
        || !Number.isSafeInteger(page.limit)
        || page.limit < 1
        || page.limit > 100
        || (page.cursor !== null && !isEgressReceiptUuid(page.cursor))
      ) return Promise.reject(new EgressReceiptStoreError('cursor_invalid'))
      return repositoryCall(context, 'egress_receipts', 'list', 'read_failed', async (client) => {
        let cursorSequence: number | null = null
        if (page.cursor !== null) {
          const cursor = await client.query<{ readonly receipt_seq: string }>(`
            SELECT receipt_seq FROM ownware.egress_receipts
            WHERE run_id = $1 AND receipt_id = $2
          `, [runId, page.cursor])
          if (cursor.rows[0] === undefined) throw new EgressReceiptStoreError('cursor_invalid')
          cursorSequence = safeInteger(cursor.rows[0].receipt_seq)
        }
        const result = await client.query<PostgreSqlEgressReceiptRow>(`
          SELECT receipt.*, identity.mode, identity.source_kind, identity.source_ref,
                 identity.transport, identity.mediation
          FROM ownware.egress_receipts AS receipt
          JOIN ownware.egress_dispatches AS identity
            ON identity.dispatch_id = receipt.dispatch_id
          WHERE receipt.run_id = $1
            AND ($2::bigint IS NULL OR receipt.receipt_seq > $2)
          ORDER BY receipt.receipt_seq LIMIT $3
        `, [runId, cursorSequence, page.limit + 1])
        const rows = result.rows.map(normalized)
        const more = rows.length > page.limit
        if (more) rows.pop()
        return {
          items: rows.map(projectEgressReceipt),
          nextCursor: more ? rows.at(-1)!.receipt_id : null,
        }
      })
    },
    markPendingUnknownForRun(runId, reasonCode, now = Date.now()) {
      if (!isEgressReceiptUuid(runId) || !Number.isSafeInteger(now) || now < 0) {
        return Promise.reject(new EgressReceiptStoreError('invalid_input'))
      }
      return repositoryCall(context, 'egress_receipts', 'reconcile_run', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, (client) =>
          reconcilePending(client, runId, reasonCode, now)))
    },
    reconcileInterrupted(reasonCode, now = Date.now()) {
      if (!Number.isSafeInteger(now) || now < 0) {
        return Promise.reject(new EgressReceiptStoreError('invalid_input'))
      }
      return repositoryCall(context, 'egress_receipts', 'reconcile_interrupted', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const runs = await client.query<{ readonly id: string }>(`
            SELECT id FROM ownware.gateway_runs WHERE status = 'indeterminate'
            ORDER BY id FOR UPDATE
          `)
          let count = 0
          for (const run of runs.rows) {
            count += await reconcilePending(client, run.id, reasonCode, now)
          }
          return count
        }))
    },
  }
}
