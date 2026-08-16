import { randomUUID } from 'node:crypto'
import type { SqliteDatabase } from '../storage/sqlite-driver.js'
import {
  EffectReceiptStore,
  isEffectReceiptUuid,
  type EffectIdentityStorageRow,
} from './effect-receipt-store.js'

export type EffectReversalOperationKind = 'inverse' | 'compensation'
export type EffectReversalOfferStatus = 'available' | 'confirmed' | 'stale' | 'expired'
export type EffectReversalReceiptOutcome = 'confirmed' | 'stale' | 'expired'
export type EffectReversalActorKind = 'owner' | 'delegated'

export interface EffectReversalOffer {
  readonly offerId: string
  readonly sequence: number
  readonly runId: string
  readonly effectId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly adapterRef: string
  readonly adapterRevision: string
  readonly operationKind: EffectReversalOperationKind
  readonly status: EffectReversalOfferStatus
  readonly createdAt: number
  readonly expiresAt: number | null
  readonly resolvedAt: number | null
}

export interface EffectReversalReceipt {
  readonly receiptId: string
  readonly sequence: number
  readonly offerId: string
  readonly runId: string
  readonly effectId: string
  readonly operationKind: EffectReversalOperationKind
  readonly outcome: EffectReversalReceiptOutcome
  readonly authorityRef: string
  readonly actorKind: EffectReversalActorKind
  readonly observedAt: number
}

export interface EffectReversalOfferPage {
  readonly items: readonly EffectReversalOffer[]
  readonly nextCursor: string | null
}

export interface EffectReversalReceiptPage {
  readonly items: readonly EffectReversalReceipt[]
  readonly nextCursor: string | null
}

export interface ObserveMemoryProposalReversalInput {
  readonly runId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly profileId: string
  readonly threadId: string
  readonly proposalId: string
  readonly targetRevision: string
  readonly adapterRef: string
  readonly adapterRevision: string
  readonly expiresAt?: number
}

export interface ExecuteMemoryProposalReversalInput {
  readonly runId: string
  readonly offerId: string
  readonly idempotencyKey: string
  readonly actorKind: EffectReversalActorKind
  readonly adapterRef: string
  readonly adapterRevision: string
}

export type EffectReversalExecutionResult =
  | { readonly disposition: 'missing' }
  | {
      readonly disposition: 'executed' | 'replayed'
      readonly offer: EffectReversalOffer
      readonly receipt: EffectReversalReceipt
      /** Adapter-private target identity used only for local invalidation. */
      readonly targetRef: string
    }
  | {
      readonly disposition: 'already_terminal'
      readonly offer: EffectReversalOffer
      readonly receipt: EffectReversalReceipt
      readonly targetRef: string
    }

export interface EffectReversalRepository {
  observeMemoryProposal(
    input: ObserveMemoryProposalReversalInput,
    now?: number,
  ): Promise<EffectReversalOffer>
  getOffer(runId: string, offerId: string): Promise<EffectReversalOffer | null>
  listOffersForRun(
    runId: string,
    page: { readonly limit: number; readonly cursor: string | null },
  ): Promise<EffectReversalOfferPage>
  executeMemoryProposal(
    input: ExecuteMemoryProposalReversalInput,
    now?: number,
  ): Promise<EffectReversalExecutionResult>
  listReceiptsForRun(
    runId: string,
    page: { readonly limit: number; readonly cursor: string | null },
  ): Promise<EffectReversalReceiptPage>
}

export type EffectReversalStoreErrorCode =
  | 'invalid_input'
  | 'effect_missing'
  | 'effect_identity_conflict'
  | 'target_missing'
  | 'target_stale'
  | 'offer_conflict'
  | 'adapter_mismatch'
  | 'cursor_invalid'
  | 'state_corrupt'

export class EffectReversalStoreError extends Error {
  override readonly name = 'EffectReversalStoreError'

  constructor(readonly code: EffectReversalStoreErrorCode) {
    super(`Effect reversal operation failed (${code}).`)
  }
}

export const MEMORY_PROPOSAL_REVERSAL_ADAPTER_REF = 'memory.pending-proposal'
export const MEMORY_PROPOSAL_REVERSAL_ADAPTER_REVISION = '1'

interface ReversalOfferStorageRow {
  readonly offer_id: string
  readonly offer_seq: number
  readonly run_id: string
  readonly effect_id: string
  readonly adapter_ref: string
  readonly adapter_revision: string
  readonly operation_kind: EffectReversalOperationKind
  readonly status: EffectReversalOfferStatus
  readonly target_kind: 'memory_proposal'
  readonly target_ref: string
  readonly target_revision: string
  readonly target_profile_id: string
  readonly target_thread_id: string
  readonly created_at: number
  readonly expires_at: number | null
  readonly resolved_at: number | null
  readonly tool_call_id: string
  readonly tool_name: string
}

interface ReversalReceiptStorageRow {
  readonly receipt_id: string
  readonly receipt_seq: number
  readonly offer_id: string
  readonly run_id: string
  readonly effect_id: string
  readonly operation_kind: EffectReversalOperationKind
  readonly outcome: EffectReversalReceiptOutcome
  readonly authority_ref: string
  readonly actor_kind: EffectReversalActorKind
  readonly idempotency_key: string
  readonly observed_at: number
}

function isSafeText(value: string, max: number): boolean {
  if (value.length < 1 || value.length > max) return false
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (code <= 31 || code === 127) return false
  }
  return true
}

function isSafeAdapterIdentifier(value: string, max: number): boolean {
  if (value.length < 1 || value.length > max) return false
  for (const character of value) {
    const code = character.codePointAt(0)!
    const alphaNumeric =
      (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
    if (!alphaNumeric && character !== '.' && character !== '_' && character !== ':' && character !== '-') {
      return false
    }
  }
  return true
}

function isTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function validateObserve(input: ObserveMemoryProposalReversalInput, now: number): void {
  if (
    !isEffectReceiptUuid(input.runId)
    || !isSafeAdapterIdentifier(input.toolCallId, 200)
    || !isSafeAdapterIdentifier(input.toolName, 160)
    || !isSafeText(input.profileId, 240)
    || !isSafeText(input.threadId, 240)
    || !isSafeAdapterIdentifier(input.proposalId, 200)
    || !isSafeText(input.targetRevision, 200)
    || !isSafeAdapterIdentifier(input.adapterRef, 160)
    || !isSafeAdapterIdentifier(input.adapterRevision, 80)
    || !isTime(now)
    || (input.expiresAt !== undefined && (!isTime(input.expiresAt) || input.expiresAt <= now))
  ) throw new EffectReversalStoreError('invalid_input')
}

function validatePage(
  runId: string,
  page: { readonly limit: number; readonly cursor: string | null },
): void {
  if (
    !isEffectReceiptUuid(runId)
    || !Number.isSafeInteger(page.limit)
    || page.limit < 1
    || page.limit > 100
    || (page.cursor !== null && !isEffectReceiptUuid(page.cursor))
  ) throw new EffectReversalStoreError('cursor_invalid')
}

function validateExecute(input: ExecuteMemoryProposalReversalInput, now: number): void {
  if (
    !isEffectReceiptUuid(input.runId)
    || !isEffectReceiptUuid(input.offerId)
    || !isEffectReceiptUuid(input.idempotencyKey)
    || (input.actorKind !== 'owner' && input.actorKind !== 'delegated')
    || !isSafeAdapterIdentifier(input.adapterRef, 160)
    || !isSafeAdapterIdentifier(input.adapterRevision, 80)
    || !isTime(now)
  ) throw new EffectReversalStoreError('invalid_input')
}

function projectOffer(row: ReversalOfferStorageRow): EffectReversalOffer {
  return {
    offerId: row.offer_id,
    sequence: row.offer_seq,
    runId: row.run_id,
    effectId: row.effect_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    adapterRef: row.adapter_ref,
    adapterRevision: row.adapter_revision,
    operationKind: row.operation_kind,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
  }
}

function projectReceipt(row: ReversalReceiptStorageRow): EffectReversalReceipt {
  return {
    receiptId: row.receipt_id,
    sequence: row.receipt_seq,
    offerId: row.offer_id,
    runId: row.run_id,
    effectId: row.effect_id,
    operationKind: row.operation_kind,
    outcome: row.outcome,
    authorityRef: row.authority_ref,
    actorKind: row.actor_kind,
    observedAt: row.observed_at,
  }
}

const OFFER_SELECT = `
  SELECT offer.*, identity.tool_call_id, identity.tool_name
  FROM effect_reversal_offers AS offer
  JOIN effect_identities AS identity ON identity.effect_id = offer.effect_id
`

/** SQLite implementation; adapter wrappers own lifecycle error conversion. */
export class EffectReversalStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly effects: EffectReceiptStore,
  ) {}

  observeMemoryProposal(
    input: ObserveMemoryProposalReversalInput,
    now = Date.now(),
  ): EffectReversalOffer {
    validateObserve(input, now)
    return this.db.transaction(() => {
      const identity = this.db.prepare(`
        SELECT identity.effect_id, identity.run_id, identity.tool_call_id, identity.tool_name
        FROM effect_identities AS identity
        WHERE identity.run_id = ? AND identity.tool_call_id = ?
          AND EXISTS (
            SELECT 1 FROM effect_receipts AS receipt
            WHERE receipt.effect_id = identity.effect_id
              AND receipt.kind = 'intent_observed'
          )
      `).get(input.runId, input.toolCallId) as EffectIdentityStorageRow | undefined
      if (identity === undefined) throw new EffectReversalStoreError('effect_missing')
      if (identity.tool_name !== input.toolName) {
        throw new EffectReversalStoreError('effect_identity_conflict')
      }

      const existing = this.db.prepare(`
        ${OFFER_SELECT}
        WHERE offer.effect_id = ? AND offer.adapter_ref = ? AND offer.adapter_revision = ?
      `).get(
        identity.effect_id,
        input.adapterRef,
        input.adapterRevision,
      ) as ReversalOfferStorageRow | undefined
      if (existing !== undefined) {
        if (
          existing.run_id !== input.runId
          || existing.target_kind !== 'memory_proposal'
          || existing.target_ref !== input.proposalId
          || existing.target_revision !== input.targetRevision
          || existing.target_profile_id !== input.profileId
          || existing.target_thread_id !== input.threadId
          || existing.expires_at !== (input.expiresAt ?? null)
        ) throw new EffectReversalStoreError('offer_conflict')
        return projectOffer(existing)
      }

      const proposal = this.db.prepare(`
        SELECT id FROM memory_proposals
        WHERE id = ? AND profile_id = ? AND thread_id = ?
          AND status = 'pending' AND created_at = ?
          AND resolution_authority_ref IS NULL
      `).get(
        input.proposalId,
        input.profileId,
        input.threadId,
        input.targetRevision,
      )
      if (proposal === undefined) throw new EffectReversalStoreError('target_stale')

      const offerId = randomUUID()
      this.effects.observeInTransaction({
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
      const sequence = this.db.prepare(`
        SELECT COALESCE(MAX(offer_seq), 0) + 1
        FROM effect_reversal_offers WHERE run_id = ?
      `).pluck().get(input.runId) as number
      this.db.prepare(`
        INSERT INTO effect_reversal_offers (
          offer_id, offer_seq, run_id, effect_id, adapter_ref, adapter_revision,
          operation_kind, status, target_kind, target_ref, target_revision,
          target_profile_id, target_thread_id, created_at, expires_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'inverse', 'available', 'memory_proposal',
          ?, ?, ?, ?, ?, ?, NULL)
      `).run(
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
      )
      return projectOffer(this.requireOfferRow(input.runId, offerId))
    })()
  }

  getOffer(runId: string, offerId: string): EffectReversalOffer | null {
    if (!isEffectReceiptUuid(runId) || !isEffectReceiptUuid(offerId)) {
      throw new EffectReversalStoreError('invalid_input')
    }
    const row = this.getOfferRow(runId, offerId)
    return row === undefined ? null : projectOffer(row)
  }

  listOffersForRun(
    runId: string,
    page: { readonly limit: number; readonly cursor: string | null },
  ): EffectReversalOfferPage {
    validatePage(runId, page)
    const cursorSequence = this.offerCursor(runId, page.cursor)
    const rows = this.db.prepare(`
      ${OFFER_SELECT}
      WHERE offer.run_id = ? AND (? IS NULL OR offer.offer_seq > ?)
      ORDER BY offer.offer_seq
      LIMIT ?
    `).all(runId, cursorSequence, cursorSequence, page.limit + 1) as ReversalOfferStorageRow[]
    const more = rows.length > page.limit
    if (more) rows.pop()
    return {
      items: rows.map(projectOffer),
      nextCursor: more ? rows.at(-1)!.offer_id : null,
    }
  }

  executeMemoryProposal(
    input: ExecuteMemoryProposalReversalInput,
    now = Date.now(),
  ): EffectReversalExecutionResult {
    validateExecute(input, now)
    return this.db.transaction(() => {
      let offerRow = this.getOfferRow(input.runId, input.offerId)
      if (offerRow === undefined) return { disposition: 'missing' as const }
      if (
        offerRow.adapter_ref !== input.adapterRef
        || offerRow.adapter_revision !== input.adapterRevision
        || offerRow.target_kind !== 'memory_proposal'
        || offerRow.operation_kind !== 'inverse'
      ) throw new EffectReversalStoreError('adapter_mismatch')

      const replay = this.db.prepare(`
        SELECT * FROM effect_reversal_receipts
        WHERE offer_id = ? AND idempotency_key = ?
      `).get(input.offerId, input.idempotencyKey) as ReversalReceiptStorageRow | undefined
      if (replay !== undefined) {
        return {
          disposition: 'replayed' as const,
          offer: projectOffer(offerRow),
          receipt: projectReceipt(replay),
          targetRef: offerRow.target_ref,
        }
      }

      if (offerRow.status !== 'available') {
        const terminal = this.db.prepare(`
          SELECT * FROM effect_reversal_receipts WHERE offer_id = ?
          ORDER BY receipt_seq DESC LIMIT 1
        `).get(input.offerId) as ReversalReceiptStorageRow | undefined
        if (terminal === undefined) throw new EffectReversalStoreError('state_corrupt')
        return {
          disposition: 'already_terminal' as const,
          offer: projectOffer(offerRow),
          receipt: projectReceipt(terminal),
          targetRef: offerRow.target_ref,
        }
      }

      let outcome: EffectReversalReceiptOutcome
      if (offerRow.expires_at !== null && offerRow.expires_at <= now) {
        outcome = 'expired'
      } else {
        const update = this.db.prepare(`
          UPDATE memory_proposals
          SET status = 'rejected', rejection_reason = NULL, resolved_at = ?,
              resolution_authority_ref = ?
          WHERE id = ? AND profile_id = ? AND thread_id = ?
            AND status = 'pending' AND created_at = ?
            AND resolution_authority_ref IS NULL
        `).run(
          new Date(now).toISOString(),
          input.offerId,
          offerRow.target_ref,
          offerRow.target_profile_id,
          offerRow.target_thread_id,
          offerRow.target_revision,
        )
        outcome = update.changes === 1 ? 'confirmed' : 'stale'
      }

      this.db.prepare(`
        UPDATE effect_reversal_offers SET status = ?, resolved_at = ?
        WHERE offer_id = ? AND status = 'available'
      `).run(outcome, now, input.offerId)
      const receiptId = randomUUID()
      const receiptSequence = this.db.prepare(`
        SELECT COALESCE(MAX(receipt_seq), 0) + 1
        FROM effect_reversal_receipts WHERE run_id = ?
      `).pluck().get(input.runId) as number
      this.db.prepare(`
        INSERT INTO effect_reversal_receipts (
          receipt_id, receipt_seq, offer_id, run_id, effect_id, operation_kind,
          outcome, authority_ref, actor_kind, idempotency_key, observed_at
        ) VALUES (?, ?, ?, ?, ?, 'inverse', ?, ?, ?, ?, ?)
      `).run(
        receiptId,
        receiptSequence,
        input.offerId,
        input.runId,
        offerRow.effect_id,
        outcome,
        `${input.adapterRef}:${input.adapterRevision}`,
        input.actorKind,
        input.idempotencyKey,
        now,
      )
      offerRow = this.requireOfferRow(input.runId, input.offerId)
      const receipt = this.requireReceiptRow(receiptId)
      return {
        disposition: 'executed' as const,
        offer: projectOffer(offerRow),
        receipt: projectReceipt(receipt),
        targetRef: offerRow.target_ref,
      }
    })()
  }

  listReceiptsForRun(
    runId: string,
    page: { readonly limit: number; readonly cursor: string | null },
  ): EffectReversalReceiptPage {
    validatePage(runId, page)
    const cursorSequence = this.receiptCursor(runId, page.cursor)
    const rows = this.db.prepare(`
      SELECT * FROM effect_reversal_receipts
      WHERE run_id = ? AND (? IS NULL OR receipt_seq > ?)
      ORDER BY receipt_seq
      LIMIT ?
    `).all(runId, cursorSequence, cursorSequence, page.limit + 1) as ReversalReceiptStorageRow[]
    const more = rows.length > page.limit
    if (more) rows.pop()
    return {
      items: rows.map(projectReceipt),
      nextCursor: more ? rows.at(-1)!.receipt_id : null,
    }
  }

  private getOfferRow(runId: string, offerId: string): ReversalOfferStorageRow | undefined {
    return this.db.prepare(`
      ${OFFER_SELECT} WHERE offer.run_id = ? AND offer.offer_id = ?
    `).get(runId, offerId) as ReversalOfferStorageRow | undefined
  }

  private requireOfferRow(runId: string, offerId: string): ReversalOfferStorageRow {
    const row = this.getOfferRow(runId, offerId)
    if (row === undefined) throw new EffectReversalStoreError('state_corrupt')
    return row
  }

  private requireReceiptRow(receiptId: string): ReversalReceiptStorageRow {
    const row = this.db.prepare(`
      SELECT * FROM effect_reversal_receipts WHERE receipt_id = ?
    `).get(receiptId) as ReversalReceiptStorageRow | undefined
    if (row === undefined) throw new EffectReversalStoreError('state_corrupt')
    return row
  }

  private offerCursor(runId: string, cursor: string | null): number | null {
    if (cursor === null) return null
    const row = this.db.prepare(`
      SELECT offer_seq FROM effect_reversal_offers WHERE run_id = ? AND offer_id = ?
    `).get(runId, cursor) as { readonly offer_seq: number } | undefined
    if (row === undefined) throw new EffectReversalStoreError('cursor_invalid')
    return row.offer_seq
  }

  private receiptCursor(runId: string, cursor: string | null): number | null {
    if (cursor === null) return null
    const row = this.db.prepare(`
      SELECT receipt_seq FROM effect_reversal_receipts WHERE run_id = ? AND receipt_id = ?
    `).get(runId, cursor) as { readonly receipt_seq: number } | undefined
    if (row === undefined) throw new EffectReversalStoreError('cursor_invalid')
    return row.receipt_seq
  }
}

export const effectReversalValidation = {
  observe: validateObserve,
  execute: validateExecute,
  page: validatePage,
  projectOffer,
  projectReceipt,
} as const

export type { ReversalOfferStorageRow, ReversalReceiptStorageRow }
