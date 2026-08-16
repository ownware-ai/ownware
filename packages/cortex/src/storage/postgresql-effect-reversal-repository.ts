import { randomUUID } from 'node:crypto'
import {
  EffectReversalStoreError,
  effectReversalValidation,
  type EffectReversalExecutionResult,
  type EffectReversalRepository,
  type ReversalOfferStorageRow,
  type ReversalReceiptStorageRow,
} from '../gateway/effect-reversal-store.js'
import type { EffectIdentityStorageRow } from '../gateway/effect-receipt-store.js'
import { observePostgreSqlEffectInTransaction } from './postgresql-effect-receipt-repository.js'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import type { PostgreSqlQueryClient } from './postgresql-repository.js'
import {
  nullableSafeInteger,
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from './postgresql-repository.js'

interface PostgreSqlOfferRow extends Omit<
  ReversalOfferStorageRow,
  'offer_seq' | 'created_at' | 'expires_at' | 'resolved_at'
> {
  readonly offer_seq: string
  readonly created_at: string
  readonly expires_at: string | null
  readonly resolved_at: string | null
}

interface PostgreSqlReceiptRow extends Omit<
  ReversalReceiptStorageRow,
  'receipt_seq' | 'observed_at'
> {
  readonly receipt_seq: string
  readonly observed_at: string
}

function offerRow(row: PostgreSqlOfferRow): ReversalOfferStorageRow {
  return {
    ...row,
    offer_seq: safeInteger(row.offer_seq),
    created_at: safeInteger(row.created_at),
    expires_at: nullableSafeInteger(row.expires_at),
    resolved_at: nullableSafeInteger(row.resolved_at),
  }
}

function receiptRow(row: PostgreSqlReceiptRow): ReversalReceiptStorageRow {
  return {
    ...row,
    receipt_seq: safeInteger(row.receipt_seq),
    observed_at: safeInteger(row.observed_at),
  }
}

const OFFER_SELECT = `
  SELECT offer.*, identity.tool_call_id, identity.tool_name
  FROM ownware.effect_reversal_offers AS offer
  JOIN ownware.effect_identities AS identity ON identity.effect_id = offer.effect_id
`

async function getOfferRow(
  client: PostgreSqlQueryClient,
  runId: string,
  offerId: string,
  lock = false,
): Promise<ReversalOfferStorageRow | undefined> {
  const result = await client.query<PostgreSqlOfferRow>(`
    ${OFFER_SELECT}
    WHERE offer.run_id = $1 AND offer.offer_id = $2
    ${lock ? 'FOR UPDATE OF offer' : ''}
  `, [runId, offerId])
  return result.rows[0] === undefined ? undefined : offerRow(result.rows[0])
}

async function requireReceipt(
  client: PostgreSqlQueryClient,
  receiptId: string,
): Promise<ReversalReceiptStorageRow> {
  const result = await client.query<PostgreSqlReceiptRow>(`
    SELECT * FROM ownware.effect_reversal_receipts WHERE receipt_id = $1
  `, [receiptId])
  if (result.rows[0] === undefined) throw new EffectReversalStoreError('state_corrupt')
  return receiptRow(result.rows[0])
}

export function createPostgreSqlEffectReversalRepository(
  context: PostgreSqlRootRepositoryContext,
): EffectReversalRepository {
  return {
    observeMemoryProposal(input, now = Date.now()) {
      effectReversalValidation.observe(input, now)
      return repositoryCall(context, 'effect_reversals', 'observe_memory_proposal', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const identityResult = await client.query<EffectIdentityStorageRow>(`
            SELECT identity.effect_id, identity.run_id, identity.tool_call_id, identity.tool_name
            FROM ownware.effect_identities AS identity
            WHERE identity.run_id = $1 AND identity.tool_call_id = $2
              AND EXISTS (
                SELECT 1 FROM ownware.effect_receipts AS receipt
                WHERE receipt.effect_id = identity.effect_id
                  AND receipt.kind = 'intent_observed'
              )
            FOR UPDATE
          `, [input.runId, input.toolCallId])
          const identity = identityResult.rows[0]
          if (identity === undefined) throw new EffectReversalStoreError('effect_missing')
          if (identity.tool_name !== input.toolName) {
            throw new EffectReversalStoreError('effect_identity_conflict')
          }

          const existingResult = await client.query<PostgreSqlOfferRow>(`
            ${OFFER_SELECT}
            WHERE offer.effect_id = $1
              AND offer.adapter_ref = $2 AND offer.adapter_revision = $3
            FOR UPDATE OF offer
          `, [identity.effect_id, input.adapterRef, input.adapterRevision])
          if (existingResult.rows[0] !== undefined) {
            const existing = offerRow(existingResult.rows[0])
            if (
              existing.run_id !== input.runId
              || existing.target_kind !== 'memory_proposal'
              || existing.target_ref !== input.proposalId
              || existing.target_revision !== input.targetRevision
              || existing.target_profile_id !== input.profileId
              || existing.target_thread_id !== input.threadId
              || existing.expires_at !== (input.expiresAt ?? null)
            ) throw new EffectReversalStoreError('offer_conflict')
            return effectReversalValidation.projectOffer(existing)
          }

          const target = await client.query(`
            SELECT id FROM ownware.memory_proposals
            WHERE id = $1 AND profile_id = $2 AND thread_id = $3
              AND status = 'pending' AND created_at = $4
              AND resolution_authority_ref IS NULL
            FOR UPDATE
          `, [input.proposalId, input.profileId, input.threadId, input.targetRevision])
          if (target.rowCount !== 1) throw new EffectReversalStoreError('target_stale')

          const offerId = randomUUID()
          await observePostgreSqlEffectInTransaction(client, {
            runId: input.runId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            observationKey: `reversal:${offerId}`,
            kind: 'authority_confirmed',
            outcome: 'succeeded',
            consequence: 'effect_confirmed',
            authorityKind: 'effect_observer',
            authorityRef: `${input.adapterRef}:${input.adapterRevision}`,
          }, now)
          const sequenceResult = await client.query<{ readonly value: string }>(`
            SELECT (COALESCE(MAX(offer_seq), 0) + 1)::text AS value
            FROM ownware.effect_reversal_offers WHERE run_id = $1
          `, [input.runId])
          const sequence = safeInteger(sequenceResult.rows[0]?.value ?? '')
          await client.query(`
            INSERT INTO ownware.effect_reversal_offers (
              offer_id, offer_seq, run_id, effect_id, adapter_ref, adapter_revision,
              operation_kind, status, target_kind, target_ref, target_revision,
              target_profile_id, target_thread_id, created_at, expires_at, resolved_at
            ) VALUES ($1,$2,$3,$4,$5,$6,'inverse','available','memory_proposal',
              $7,$8,$9,$10,$11,$12,NULL)
          `, [
            offerId,
            sequence,
            input.runId,
            identity.effect_id,
            input.adapterRef,
            input.adapterRevision,
            input.proposalId,
            input.targetRevision,
            input.profileId,
            input.threadId,
            now,
            input.expiresAt ?? null,
          ])
          const created = await getOfferRow(client, input.runId, offerId)
          if (created === undefined) throw new EffectReversalStoreError('state_corrupt')
          return effectReversalValidation.projectOffer(created)
        }))
    },

    getOffer(runId, offerId) {
      if (!isValidId(runId) || !isValidId(offerId)) {
        return Promise.reject(new EffectReversalStoreError('invalid_input'))
      }
      return repositoryCall(context, 'effect_reversals', 'get_offer', 'read_failed', async (client) => {
        const row = await getOfferRow(client, runId, offerId)
        return row === undefined ? null : effectReversalValidation.projectOffer(row)
      })
    },

    listOffersForRun(runId, page) {
      effectReversalValidation.page(runId, page)
      return repositoryCall(context, 'effect_reversals', 'list_offers', 'read_failed', async (client) => {
        let cursorSequence: number | null = null
        if (page.cursor !== null) {
          const cursor = await client.query<{ readonly offer_seq: string }>(`
            SELECT offer_seq FROM ownware.effect_reversal_offers
            WHERE run_id = $1 AND offer_id = $2
          `, [runId, page.cursor])
          if (cursor.rows[0] === undefined) throw new EffectReversalStoreError('cursor_invalid')
          cursorSequence = safeInteger(cursor.rows[0].offer_seq)
        }
        const result = await client.query<PostgreSqlOfferRow>(`
          ${OFFER_SELECT}
          WHERE offer.run_id = $1 AND ($2::bigint IS NULL OR offer.offer_seq > $2)
          ORDER BY offer.offer_seq LIMIT $3
        `, [runId, cursorSequence, page.limit + 1])
        const rows = result.rows.map(offerRow)
        const more = rows.length > page.limit
        if (more) rows.pop()
        return {
          items: rows.map(effectReversalValidation.projectOffer),
          nextCursor: more ? rows.at(-1)!.offer_id : null,
        }
      })
    },

    executeMemoryProposal(input, now = Date.now()) {
      effectReversalValidation.execute(input, now)
      return repositoryCall(context, 'effect_reversals', 'execute_memory_proposal', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client): Promise<EffectReversalExecutionResult> => {
          await client.query('SELECT 1 FROM ownware.gateway_runs WHERE id = $1 FOR UPDATE', [input.runId])
          let offer = await getOfferRow(client, input.runId, input.offerId, true)
          if (offer === undefined) return { disposition: 'missing' }
          if (
            offer.adapter_ref !== input.adapterRef
            || offer.adapter_revision !== input.adapterRevision
            || offer.target_kind !== 'memory_proposal'
            || offer.operation_kind !== 'inverse'
          ) throw new EffectReversalStoreError('adapter_mismatch')

          const replayResult = await client.query<PostgreSqlReceiptRow>(`
            SELECT * FROM ownware.effect_reversal_receipts
            WHERE offer_id = $1 AND idempotency_key = $2
          `, [input.offerId, input.idempotencyKey])
          if (replayResult.rows[0] !== undefined) {
            return {
              disposition: 'replayed',
              offer: effectReversalValidation.projectOffer(offer),
              receipt: effectReversalValidation.projectReceipt(receiptRow(replayResult.rows[0])),
              targetRef: offer.target_ref,
            }
          }

          if (offer.status !== 'available') {
            const terminalResult = await client.query<PostgreSqlReceiptRow>(`
              SELECT * FROM ownware.effect_reversal_receipts
              WHERE offer_id = $1 ORDER BY receipt_seq DESC LIMIT 1
            `, [input.offerId])
            if (terminalResult.rows[0] === undefined) {
              throw new EffectReversalStoreError('state_corrupt')
            }
            return {
              disposition: 'already_terminal',
              offer: effectReversalValidation.projectOffer(offer),
              receipt: effectReversalValidation.projectReceipt(receiptRow(terminalResult.rows[0])),
              targetRef: offer.target_ref,
            }
          }

          let outcome: 'confirmed' | 'stale' | 'expired'
          if (offer.expires_at !== null && offer.expires_at <= now) {
            outcome = 'expired'
          } else {
            const updated = await client.query(`
              UPDATE ownware.memory_proposals
              SET status='rejected', rejection_reason=NULL, resolved_at=$1,
                  resolution_authority_ref=$2
              WHERE id=$3 AND profile_id=$4 AND thread_id=$5
                AND status='pending' AND created_at=$6
                AND resolution_authority_ref IS NULL
              RETURNING id
            `, [
              new Date(now).toISOString(),
              input.offerId,
              offer.target_ref,
              offer.target_profile_id,
              offer.target_thread_id,
              offer.target_revision,
            ])
            outcome = updated.rowCount === 1 ? 'confirmed' : 'stale'
          }

          await client.query(`
            UPDATE ownware.effect_reversal_offers SET status=$1,resolved_at=$2
            WHERE offer_id=$3 AND status='available'
          `, [outcome, now, input.offerId])
          const receiptId = randomUUID()
          const sequenceResult = await client.query<{ readonly value: string }>(`
            SELECT (COALESCE(MAX(receipt_seq), 0) + 1)::text AS value
            FROM ownware.effect_reversal_receipts WHERE run_id = $1
          `, [input.runId])
          const sequence = safeInteger(sequenceResult.rows[0]?.value ?? '')
          await client.query(`
            INSERT INTO ownware.effect_reversal_receipts (
              receipt_id, receipt_seq, offer_id, run_id, effect_id, operation_kind,
              outcome, authority_ref, actor_kind, idempotency_key, observed_at
            ) VALUES ($1,$2,$3,$4,$5,'inverse',$6,$7,$8,$9,$10)
          `, [
            receiptId,
            sequence,
            input.offerId,
            input.runId,
            offer.effect_id,
            outcome,
            `${input.adapterRef}:${input.adapterRevision}`,
            input.actorKind,
            input.idempotencyKey,
            now,
          ])
          offer = await getOfferRow(client, input.runId, input.offerId)
          if (offer === undefined) throw new EffectReversalStoreError('state_corrupt')
          const receipt = await requireReceipt(client, receiptId)
          return {
            disposition: 'executed',
            offer: effectReversalValidation.projectOffer(offer),
            receipt: effectReversalValidation.projectReceipt(receipt),
            targetRef: offer.target_ref,
          }
        }))
    },

    listReceiptsForRun(runId, page) {
      effectReversalValidation.page(runId, page)
      return repositoryCall(context, 'effect_reversals', 'list_receipts', 'read_failed', async (client) => {
        let cursorSequence: number | null = null
        if (page.cursor !== null) {
          const cursor = await client.query<{ readonly receipt_seq: string }>(`
            SELECT receipt_seq FROM ownware.effect_reversal_receipts
            WHERE run_id = $1 AND receipt_id = $2
          `, [runId, page.cursor])
          if (cursor.rows[0] === undefined) throw new EffectReversalStoreError('cursor_invalid')
          cursorSequence = safeInteger(cursor.rows[0].receipt_seq)
        }
        const result = await client.query<PostgreSqlReceiptRow>(`
          SELECT * FROM ownware.effect_reversal_receipts
          WHERE run_id=$1 AND ($2::bigint IS NULL OR receipt_seq > $2)
          ORDER BY receipt_seq LIMIT $3
        `, [runId, cursorSequence, page.limit + 1])
        const rows = result.rows.map(receiptRow)
        const more = rows.length > page.limit
        if (more) rows.pop()
        return {
          items: rows.map(effectReversalValidation.projectReceipt),
          nextCursor: more ? rows.at(-1)!.receipt_id : null,
        }
      })
    },
  }
}

function isValidId(value: string): boolean {
  if (value.length !== 36) return false
  return value[8] === '-' && value[13] === '-' && value[18] === '-' && value[23] === '-'
}
