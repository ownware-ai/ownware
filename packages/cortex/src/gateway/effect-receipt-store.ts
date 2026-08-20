import { randomUUID } from 'node:crypto'
import type { RuntimeConsequence } from '../runtime/port.js'
import type { SqliteDatabase } from '../storage/sqlite-driver.js'
import { appendActivityLedgerRow } from './activity-ledger.js'

export type EffectReceiptKind =
  | 'intent_observed'
  | 'outcome_observed'
  | 'authority_confirmed'
  | 'reconciliation'

export type EffectReceiptOutcome =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'unknown'

export type EffectReceiptAuthorityKind =
  | 'runtime'
  | 'effect_observer'
  | 'reconciler'

export interface EffectReceipt {
  readonly receiptId: string
  /** Monotonic append order within this run. */
  readonly sequence: number
  readonly effectId: string
  readonly runId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly kind: EffectReceiptKind
  readonly outcome: EffectReceiptOutcome
  readonly consequence: RuntimeConsequence
  readonly authorityKind: EffectReceiptAuthorityKind
  readonly authorityRef: string
  readonly observedAt: number
}

export interface EffectReceiptPage {
  readonly items: readonly EffectReceipt[]
  readonly nextCursor: string | null
}

export interface ObserveEffectInput {
  readonly runId: string
  readonly toolCallId: string
  readonly toolName: string
  /** Stable, content-free identity for one authority observation. */
  readonly observationKey: string
  readonly kind: EffectReceiptKind
  readonly outcome: EffectReceiptOutcome
  readonly consequence: RuntimeConsequence
  readonly authorityKind: EffectReceiptAuthorityKind
  readonly authorityRef: string
  readonly runtimeSequence?: number
}

export interface EffectReceiptRepository {
  observe(input: ObserveEffectInput, now?: number): Promise<EffectReceipt>
  listForRun(
    runId: string,
    page: { readonly limit: number; readonly cursor: string | null },
  ): Promise<EffectReceiptPage>
  markPendingUnknownForRun(
    runId: string,
    authorityRef: string,
    now?: number,
  ): Promise<number>
  reconcileInterrupted(authorityRef: string, now?: number): Promise<number>
}

export type EffectReceiptStoreErrorCode =
  | 'invalid_input'
  | 'run_missing'
  | 'identity_conflict'
  | 'observation_conflict'
  | 'cursor_invalid'

/** Stable, content-free failure safe to cross repository adapters. */
export class EffectReceiptStoreError extends Error {
  override readonly name = 'EffectReceiptStoreError'

  constructor(readonly code: EffectReceiptStoreErrorCode) {
    super(`Effect receipt operation failed (${code}).`)
  }
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,200}$/
const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,160}$/
const SAFE_AUTHORITY = /^[A-Za-z0-9_.:/-]{1,160}$/
const SAFE_OBSERVATION_KEY = /^[A-Za-z0-9_.:-]{1,240}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const CONSEQUENCE_RANK = new Map<RuntimeConsequence, number>([
  ['none_observed', 0],
  ['output_observed', 1],
  ['effect_possible', 2],
  ['effect_confirmed', 3],
])

const RECEIPT_KINDS = new Set<EffectReceiptKind>([
  'intent_observed',
  'outcome_observed',
  'authority_confirmed',
  'reconciliation',
])

const RECEIPT_OUTCOMES = new Set<EffectReceiptOutcome>([
  'pending',
  'succeeded',
  'failed',
  'denied',
  'unknown',
])

const RECEIPT_AUTHORITY_KINDS = new Set<EffectReceiptAuthorityKind>([
  'runtime',
  'effect_observer',
  'reconciler',
])

const CONSEQUENCE_SQL_RANK = `CASE consequence
  WHEN 'none_observed' THEN 0
  WHEN 'output_observed' THEN 1
  WHEN 'effect_possible' THEN 2
  WHEN 'effect_confirmed' THEN 3
  ELSE -1
END`

export interface EffectIdentityStorageRow {
  readonly effect_id: string
  readonly run_id: string
  readonly tool_call_id: string
  readonly tool_name: string
}

export interface EffectReceiptStorageRow {
  readonly receipt_id: string
  readonly receipt_seq: number
  readonly effect_id: string
  readonly run_id: string
  readonly tool_call_id: string
  readonly tool_name: string
  readonly observation_key: string
  readonly kind: EffectReceiptKind
  readonly outcome: EffectReceiptOutcome
  readonly consequence: RuntimeConsequence
  readonly authority_kind: EffectReceiptAuthorityKind
  readonly authority_ref: string
  readonly runtime_sequence: number | null
  readonly observed_at: number
}

export function validateEffectObservation(input: ObserveEffectInput): void {
  if (
    !UUID.test(input.runId)
    || !SAFE_ID.test(input.toolCallId)
    || !SAFE_NAME.test(input.toolName)
    || !SAFE_OBSERVATION_KEY.test(input.observationKey)
    || !SAFE_AUTHORITY.test(input.authorityRef)
    || !RECEIPT_KINDS.has(input.kind)
    || !RECEIPT_OUTCOMES.has(input.outcome)
    || !RECEIPT_AUTHORITY_KINDS.has(input.authorityKind)
    || !CONSEQUENCE_RANK.has(input.consequence)
    || (
      input.runtimeSequence !== undefined
      && (!Number.isSafeInteger(input.runtimeSequence) || input.runtimeSequence < 1)
    )
    || (
      input.kind === 'intent_observed'
      && (
        input.outcome !== 'pending'
        || input.consequence !== 'none_observed'
        || input.authorityKind !== 'runtime'
      )
    )
    || (
      input.kind === 'reconciliation'
      && (
        input.outcome !== 'unknown'
        || input.consequence !== 'effect_possible'
        || input.authorityKind !== 'reconciler'
        || input.runtimeSequence !== undefined
      )
    )
    || (
      input.kind === 'authority_confirmed'
      && (
        input.authorityKind !== 'effect_observer'
        || input.consequence !== 'effect_confirmed'
      )
    )
    || (
      input.consequence === 'effect_confirmed'
      && (
        input.kind !== 'authority_confirmed'
        || input.authorityKind !== 'effect_observer'
      )
    )
    || (input.authorityKind === 'reconciler' && input.kind !== 'reconciliation')
  ) {
    throw new EffectReceiptStoreError('invalid_input')
  }
}

export function projectEffectReceipt(row: EffectReceiptStorageRow): EffectReceipt {
  return {
    receiptId: row.receipt_id,
    sequence: row.receipt_seq,
    effectId: row.effect_id,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    kind: row.kind,
    outcome: row.outcome,
    consequence: row.consequence,
    authorityKind: row.authority_kind,
    authorityRef: row.authority_ref,
    observedAt: row.observed_at,
  }
}

export function sameEffectObservation(
  row: EffectReceiptStorageRow,
  input: ObserveEffectInput,
): boolean {
  return row.run_id === input.runId
    && row.tool_call_id === input.toolCallId
    && row.tool_name === input.toolName
    && row.observation_key === input.observationKey
    && row.kind === input.kind
    && row.outcome === input.outcome
    && row.consequence === input.consequence
    && row.authority_kind === input.authorityKind
    && row.authority_ref === input.authorityRef
    && row.runtime_sequence === (input.runtimeSequence ?? null)
}

export function isEffectReceiptUuid(value: string): boolean {
  return UUID.test(value)
}

export function isSafeEffectAuthorityRef(value: string): boolean {
  return SAFE_AUTHORITY.test(value)
}

/** SQLite implementation; the adapter wrapper supplies lifecycle errors. */
export class EffectReceiptStore {
  constructor(private readonly db: SqliteDatabase) {}

  observe(input: ObserveEffectInput, now = Date.now()): EffectReceipt {
    validateEffectObservation(input)
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new EffectReceiptStoreError('invalid_input')
    }
    return this.db.transaction(() => this.observeInTransaction(input, now))()
  }

  listForRun(
    runId: string,
    page: { readonly limit: number; readonly cursor: string | null },
  ): EffectReceiptPage {
    if (
      !UUID.test(runId)
      || !Number.isSafeInteger(page.limit)
      || page.limit < 1
      || page.limit > 100
      || (page.cursor !== null && !UUID.test(page.cursor))
    ) throw new EffectReceiptStoreError('cursor_invalid')

    let cursorSequence: number | null = null
    if (page.cursor !== null) {
      const cursor = this.db.prepare(`
        SELECT receipt_seq FROM effect_receipts
        WHERE run_id = ? AND receipt_id = ?
      `).get(runId, page.cursor) as { readonly receipt_seq: number } | undefined
      if (cursor === undefined) throw new EffectReceiptStoreError('cursor_invalid')
      cursorSequence = cursor.receipt_seq
    }

    const rows = this.db.prepare(`
      SELECT receipt.*, identity.tool_call_id, identity.tool_name
      FROM effect_receipts AS receipt
      JOIN effect_identities AS identity ON identity.effect_id = receipt.effect_id
      WHERE receipt.run_id = ?
        AND (? IS NULL OR receipt.receipt_seq > ?)
      ORDER BY receipt.receipt_seq
      LIMIT ?
    `).all(
      runId,
      cursorSequence,
      cursorSequence,
      page.limit + 1,
    ) as EffectReceiptStorageRow[]
    const more = rows.length > page.limit
    if (more) rows.pop()
    return {
      items: rows.map(projectEffectReceipt),
      nextCursor: more ? rows.at(-1)!.receipt_id : null,
    }
  }

  markPendingUnknownForRun(
    runId: string,
    authorityRef: string,
    now = Date.now(),
  ): number {
    if (!UUID.test(runId) || !SAFE_AUTHORITY.test(authorityRef) || !Number.isSafeInteger(now) || now < 0) {
      throw new EffectReceiptStoreError('invalid_input')
    }
    return this.db.transaction(() => this.reconcilePending(runId, authorityRef, now))()
  }

  reconcileInterrupted(authorityRef: string, now = Date.now()): number {
    if (!SAFE_AUTHORITY.test(authorityRef) || !Number.isSafeInteger(now) || now < 0) {
      throw new EffectReceiptStoreError('invalid_input')
    }
    return this.db.transaction(() => {
      const runs = this.db.prepare(`
        SELECT id FROM gateway_runs WHERE status = 'indeterminate'
      `).all() as Array<{ readonly id: string }>
      let count = 0
      for (const run of runs) count += this.reconcilePending(run.id, authorityRef, now)
      return count
    })()
  }

  /**
   * Adapter-internal composition seam. The caller must already own the
   * SQLite transaction. This is intentionally absent from the repository
   * interface so ordinary gateway code cannot bypass transaction ownership.
   */
  observeInTransaction(input: ObserveEffectInput, now: number): EffectReceipt {
    const run = this.db.prepare('SELECT 1 FROM gateway_runs WHERE id = ?').get(input.runId)
    if (run === undefined) throw new EffectReceiptStoreError('run_missing')

    let identity = this.db.prepare(`
      SELECT effect_id, run_id, tool_call_id, tool_name
      FROM effect_identities WHERE run_id = ? AND tool_call_id = ?
    `).get(input.runId, input.toolCallId) as EffectIdentityStorageRow | undefined
    if (identity === undefined) {
      const effectId = randomUUID()
      this.db.prepare(`
        INSERT INTO effect_identities (
          effect_id, run_id, tool_call_id, tool_name, first_observed_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(effectId, input.runId, input.toolCallId, input.toolName, now)
      identity = {
        effect_id: effectId,
        run_id: input.runId,
        tool_call_id: input.toolCallId,
        tool_name: input.toolName,
      }
    } else if (identity.tool_name !== input.toolName) {
      throw new EffectReceiptStoreError('identity_conflict')
    }

    const existing = this.db.prepare(`
      SELECT receipt.*, identity.tool_call_id, identity.tool_name
      FROM effect_receipts AS receipt
      JOIN effect_identities AS identity ON identity.effect_id = receipt.effect_id
      WHERE receipt.effect_id = ? AND receipt.observation_key = ?
    `).get(identity.effect_id, input.observationKey) as EffectReceiptStorageRow | undefined
    if (existing !== undefined) {
      if (!sameEffectObservation(existing, input)) {
        throw new EffectReceiptStoreError('observation_conflict')
      }
      this.advanceRunConsequence(input.runId, input.consequence, now)
      return projectEffectReceipt(existing)
    }

    const receiptId = randomUUID()
    const sequence = this.db.prepare(`
      SELECT COALESCE(MAX(receipt_seq), 0) + 1 AS value
      FROM effect_receipts WHERE run_id = ?
    `).pluck().get(input.runId) as number
    this.db.prepare(`
      INSERT INTO effect_receipts (
        receipt_id, receipt_seq, effect_id, run_id, observation_key, kind, outcome,
        consequence, authority_kind, authority_ref, runtime_sequence, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    )
    // Indexed in this same transaction. A convergent duplicate returned above
    // never reaches here, so one receipt is indexed exactly once.
    appendActivityLedgerRow(this.db, {
      family: 'effect',
      receiptId,
      runId: input.runId,
      occurredAt: now,
      outcome: input.outcome,
      consequence: input.consequence,
      toolName: identity.tool_name,
    })
    this.advanceRunConsequence(input.runId, input.consequence, now)
    return {
      receiptId,
      sequence,
      effectId: identity.effect_id,
      runId: input.runId,
      toolCallId: identity.tool_call_id,
      toolName: identity.tool_name,
      kind: input.kind,
      outcome: input.outcome,
      consequence: input.consequence,
      authorityKind: input.authorityKind,
      authorityRef: input.authorityRef,
      observedAt: now,
    }
  }

  private reconcilePending(runId: string, authorityRef: string, now: number): number {
    const identities = this.db.prepare(`
      SELECT identity.effect_id, identity.run_id, identity.tool_call_id, identity.tool_name
      FROM effect_identities AS identity
      WHERE identity.run_id = ?
        AND EXISTS (
          SELECT 1 FROM effect_receipts AS receipt
          WHERE receipt.effect_id = identity.effect_id AND receipt.outcome = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1 FROM effect_receipts AS receipt
          WHERE receipt.effect_id = identity.effect_id
            AND receipt.outcome IN ('succeeded', 'failed', 'denied', 'unknown')
        )
    `).all(runId) as EffectIdentityStorageRow[]
    for (const identity of identities) {
      this.observeInTransaction({
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
    return identities.length
  }

  private advanceRunConsequence(
    runId: string,
    consequence: RuntimeConsequence,
    now: number,
  ): void {
    const rank = CONSEQUENCE_RANK.get(consequence)
    if (rank === undefined) throw new EffectReceiptStoreError('invalid_input')
    this.db.prepare(`
      UPDATE gateway_runs
      SET consequence = ?, updated_at = ?
      WHERE id = ? AND ${CONSEQUENCE_SQL_RANK} < ?
    `).run(consequence, now, runId, rank)
  }
}
