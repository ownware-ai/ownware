import { randomUUID } from 'node:crypto'
import type {
  EgressMediation,
  EgressMode,
  EgressSourceKind,
  EgressTransport,
} from '@ownware/loom'
import type { SqliteDatabase } from '../storage/sqlite-driver.js'
import { appendActivityLedgerRow } from './activity-ledger.js'

export type EgressReceiptPhase =
  | 'dispatch_started'
  | 'response_observed'
  | 'dispatch_failed'
  | 'dispatch_blocked'
  | 'route_unavailable'
  | 'outcome_unknown'

export type EgressReasonCode =
  | 'local_only_remote_destination'
  | 'local_only_custom_transport'
  | 'local_only_route_unavailable'
  | 'local_only_redirect'
  | 'route_unavailable'
  | 'run_terminated_after_dispatch'
  | 'gateway_restarted_after_dispatch'

export interface EgressReceipt {
  readonly receiptId: string
  readonly sequence: number
  readonly dispatchId: string
  readonly runId: string
  readonly mode: EgressMode
  readonly sourceKind: EgressSourceKind
  readonly sourceRef: string
  readonly transport: EgressTransport
  readonly mediation: EgressMediation
  /** Application transport origin only; never a path, query, body or header. */
  readonly destinationOrigin: string | null
  readonly phase: EgressReceiptPhase
  readonly reasonCode: EgressReasonCode | null
  readonly observedAt: number
}

export interface EgressReceiptPage {
  readonly items: readonly EgressReceipt[]
  readonly nextCursor: string | null
}

export interface ObserveEgressInput {
  readonly dispatchId: string
  readonly runId: string
  readonly mode: EgressMode
  readonly sourceKind: EgressSourceKind
  readonly sourceRef: string
  readonly transport: EgressTransport
  readonly mediation: EgressMediation
  readonly observationKey: string
  readonly destinationOrigin: string | null
  readonly phase: EgressReceiptPhase
  readonly reasonCode: EgressReasonCode | null
}

export interface EgressReceiptRepository {
  observe(input: ObserveEgressInput, now?: number): Promise<EgressReceipt>
  listForRun(
    runId: string,
    page: { readonly limit: number; readonly cursor: string | null },
  ): Promise<EgressReceiptPage>
  markPendingUnknownForRun(
    runId: string,
    reasonCode: Extract<EgressReasonCode, 'run_terminated_after_dispatch'>,
    now?: number,
  ): Promise<number>
  reconcileInterrupted(
    reasonCode: Extract<EgressReasonCode, 'gateway_restarted_after_dispatch'>,
    now?: number,
  ): Promise<number>
}

export type EgressReceiptStoreErrorCode =
  | 'invalid_input'
  | 'run_missing'
  | 'identity_conflict'
  | 'observation_conflict'
  | 'cursor_invalid'

export class EgressReceiptStoreError extends Error {
  override readonly name = 'EgressReceiptStoreError'

  constructor(readonly code: EgressReceiptStoreErrorCode) {
    super(`Egress receipt operation failed (${code}).`)
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SAFE_REF = /^[A-Za-z0-9_.:-]{1,160}$/
const SAFE_KEY = /^[A-Za-z0-9_.:-]{1,200}$/
const MODES = new Set<EgressMode>(['unrestricted', 'local-only'])
const SOURCE_KINDS = new Set<EgressSourceKind>([
  'provider', 'tool', 'connector', 'browser', 'process', 'runtime',
])
const TRANSPORTS = new Set<EgressTransport>([
  'http', 'https', 'ws', 'wss', 'tcp', 'tls', 'unknown',
])
const MEDIATIONS = new Set<EgressMediation>([
  'platform_fetch', 'custom_fetch', 'uncontained', 'unknown',
])
const PHASES = new Set<EgressReceiptPhase>([
  'dispatch_started',
  'response_observed',
  'dispatch_failed',
  'dispatch_blocked',
  'route_unavailable',
  'outcome_unknown',
])
const REASONS = new Set<EgressReasonCode>([
  'local_only_remote_destination',
  'local_only_custom_transport',
  'local_only_route_unavailable',
  'local_only_redirect',
  'route_unavailable',
  'run_terminated_after_dispatch',
  'gateway_restarted_after_dispatch',
])

const PROTOCOL_TRANSPORT: Readonly<Record<string, EgressTransport>> = {
  'http:': 'http',
  'https:': 'https',
  'ws:': 'ws',
  'wss:': 'wss',
  'tcp:': 'tcp',
  'tls:': 'tls',
}

/** Validate and canonicalize a content-free application origin. */
export function canonicalEgressOrigin(value: string, transport?: EgressTransport): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 512
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new EgressReceiptStoreError('invalid_input')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new EgressReceiptStoreError('invalid_input')
  }
  const expected = PROTOCOL_TRANSPORT[url.protocol]
  if (
    expected === undefined
    || (transport !== undefined && transport !== expected)
    || url.username.length > 0
    || url.password.length > 0
    || (url.pathname !== '' && url.pathname !== '/')
    || url.search.length > 0
    || url.hash.length > 0
    || url.hostname.length < 1
  ) {
    throw new EgressReceiptStoreError('invalid_input')
  }
  return `${url.protocol}//${url.host}`
}

interface EgressIdentityStorageRow {
  readonly dispatch_id: string
  readonly run_id: string
  readonly mode: EgressMode
  readonly source_kind: EgressSourceKind
  readonly source_ref: string
  readonly transport: EgressTransport
  readonly mediation: EgressMediation
}

export interface EgressReceiptStorageRow extends EgressIdentityStorageRow {
  readonly receipt_id: string
  readonly receipt_seq: number
  readonly observation_key: string
  readonly destination_origin: string | null
  readonly phase: EgressReceiptPhase
  readonly reason_code: EgressReasonCode | null
  readonly observed_at: number
}

export function validateEgressObservation(input: ObserveEgressInput): void {
  const destination = input.destinationOrigin === null
    ? null
    : canonicalEgressOrigin(
        input.destinationOrigin,
        input.phase === 'response_observed' ? undefined : input.transport,
      )
  const reasonRequired = input.phase === 'dispatch_blocked'
    || input.phase === 'route_unavailable'
    || input.phase === 'outcome_unknown'
  const destinationRequired = input.phase === 'dispatch_started'
    || input.phase === 'response_observed'
    || input.phase === 'dispatch_failed'
  if (
    !UUID.test(input.dispatchId)
    || !UUID.test(input.runId)
    || !SAFE_REF.test(input.sourceRef)
    || !SAFE_KEY.test(input.observationKey)
    || !MODES.has(input.mode)
    || !SOURCE_KINDS.has(input.sourceKind)
    || !TRANSPORTS.has(input.transport)
    || !MEDIATIONS.has(input.mediation)
    || !PHASES.has(input.phase)
    || (input.reasonCode !== null && !REASONS.has(input.reasonCode))
    || (reasonRequired !== (input.reasonCode !== null))
    || (destinationRequired && destination === null)
    || (input.phase === 'route_unavailable' && destination !== null)
    || (input.phase === 'route_unavailable' && input.mode !== 'unrestricted')
    || (
      input.phase === 'route_unavailable'
      && (
        input.reasonCode !== 'route_unavailable'
        || input.transport !== 'unknown'
        || (input.mediation !== 'uncontained' && input.mediation !== 'unknown')
      )
    )
    || (
      input.phase === 'dispatch_blocked'
      && input.mode !== 'local-only'
    )
    || (
      input.phase === 'dispatch_blocked'
      && input.reasonCode !== 'local_only_remote_destination'
      && input.reasonCode !== 'local_only_custom_transport'
      && input.reasonCode !== 'local_only_route_unavailable'
      && input.reasonCode !== 'local_only_redirect'
    )
    || (
      input.reasonCode === 'local_only_route_unavailable'
      && (
        destination !== null
        || input.transport !== 'unknown'
        || (input.mediation !== 'uncontained' && input.mediation !== 'unknown')
      )
    )
    || (
      input.phase === 'dispatch_blocked'
      && input.reasonCode !== 'local_only_route_unavailable'
      && destination === null
    )
    || (
      input.phase === 'outcome_unknown'
      && input.reasonCode !== 'run_terminated_after_dispatch'
      && input.reasonCode !== 'gateway_restarted_after_dispatch'
    )
  ) throw new EgressReceiptStoreError('invalid_input')
}

export function projectEgressReceipt(row: EgressReceiptStorageRow): EgressReceipt {
  return {
    receiptId: row.receipt_id,
    sequence: row.receipt_seq,
    dispatchId: row.dispatch_id,
    runId: row.run_id,
    mode: row.mode,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    transport: row.transport,
    mediation: row.mediation,
    destinationOrigin: row.destination_origin,
    phase: row.phase,
    reasonCode: row.reason_code,
    observedAt: row.observed_at,
  }
}

export function sameEgressObservation(
  row: EgressReceiptStorageRow,
  input: ObserveEgressInput,
): boolean {
  return row.dispatch_id === input.dispatchId
    && row.run_id === input.runId
    && row.mode === input.mode
    && row.source_kind === input.sourceKind
    && row.source_ref === input.sourceRef
    && row.transport === input.transport
    && row.mediation === input.mediation
    && row.observation_key === input.observationKey
    && row.destination_origin === input.destinationOrigin
    && row.phase === input.phase
    && row.reason_code === input.reasonCode
}

export function canonicalEgressObservation(
  input: ObserveEgressInput,
): ObserveEgressInput {
  return input.destinationOrigin === null
    ? input
    : {
        ...input,
        destinationOrigin: canonicalEgressOrigin(
          input.destinationOrigin,
          input.phase === 'response_observed' ? undefined : input.transport,
        ),
      }
}

export function isEgressReceiptUuid(value: string): boolean {
  return UUID.test(value)
}

export class EgressReceiptStore {
  constructor(private readonly db: SqliteDatabase) {}

  observe(input: ObserveEgressInput, now = Date.now()): EgressReceipt {
    validateEgressObservation(input)
    if (!Number.isSafeInteger(now) || now < 0) throw new EgressReceiptStoreError('invalid_input')
    const normalized = canonicalEgressObservation(input)
    return this.db.transaction(() => this.observeInTransaction(normalized, now))()
  }

  listForRun(
    runId: string,
    page: { readonly limit: number; readonly cursor: string | null },
  ): EgressReceiptPage {
    if (
      !UUID.test(runId)
      || !Number.isSafeInteger(page.limit)
      || page.limit < 1
      || page.limit > 100
      || (page.cursor !== null && !UUID.test(page.cursor))
    ) throw new EgressReceiptStoreError('cursor_invalid')
    let cursorSequence: number | null = null
    if (page.cursor !== null) {
      const cursor = this.db.prepare(`
        SELECT receipt_seq FROM egress_receipts WHERE run_id = ? AND receipt_id = ?
      `).get(runId, page.cursor) as { readonly receipt_seq: number } | undefined
      if (cursor === undefined) throw new EgressReceiptStoreError('cursor_invalid')
      cursorSequence = cursor.receipt_seq
    }
    const rows = this.db.prepare(`
      SELECT receipt.*, identity.mode, identity.source_kind, identity.source_ref,
             identity.transport, identity.mediation
      FROM egress_receipts AS receipt
      JOIN egress_dispatches AS identity ON identity.dispatch_id = receipt.dispatch_id
      WHERE receipt.run_id = ? AND (? IS NULL OR receipt.receipt_seq > ?)
      ORDER BY receipt.receipt_seq LIMIT ?
    `).all(runId, cursorSequence, cursorSequence, page.limit + 1) as EgressReceiptStorageRow[]
    const more = rows.length > page.limit
    if (more) rows.pop()
    return {
      items: rows.map(projectEgressReceipt),
      nextCursor: more ? rows.at(-1)!.receipt_id : null,
    }
  }

  markPendingUnknownForRun(
    runId: string,
    reasonCode: 'run_terminated_after_dispatch',
    now = Date.now(),
  ): number {
    if (!UUID.test(runId) || !Number.isSafeInteger(now) || now < 0) {
      throw new EgressReceiptStoreError('invalid_input')
    }
    return this.db.transaction(() => this.reconcilePending(runId, reasonCode, now))()
  }

  reconcileInterrupted(
    reasonCode: 'gateway_restarted_after_dispatch',
    now = Date.now(),
  ): number {
    if (!Number.isSafeInteger(now) || now < 0) throw new EgressReceiptStoreError('invalid_input')
    return this.db.transaction(() => {
      const runs = this.db.prepare(`
        SELECT id FROM gateway_runs WHERE status = 'indeterminate'
      `).all() as Array<{ readonly id: string }>
      let count = 0
      for (const run of runs) count += this.reconcilePending(run.id, reasonCode, now)
      return count
    })()
  }

  private observeInTransaction(input: ObserveEgressInput, now: number): EgressReceipt {
    if (this.db.prepare('SELECT 1 FROM gateway_runs WHERE id = ?').get(input.runId) === undefined) {
      throw new EgressReceiptStoreError('run_missing')
    }
    let identity = this.db.prepare(`
      SELECT dispatch_id, run_id, mode, source_kind, source_ref, transport, mediation
      FROM egress_dispatches WHERE dispatch_id = ?
    `).get(input.dispatchId) as EgressIdentityStorageRow | undefined
    if (identity === undefined) {
      this.db.prepare(`
        INSERT INTO egress_dispatches (
          dispatch_id, run_id, mode, source_kind, source_ref, transport, mediation, first_observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.dispatchId,
        input.runId,
        input.mode,
        input.sourceKind,
        input.sourceRef,
        input.transport,
        input.mediation,
        now,
      )
      identity = {
        dispatch_id: input.dispatchId,
        run_id: input.runId,
        mode: input.mode,
        source_kind: input.sourceKind,
        source_ref: input.sourceRef,
        transport: input.transport,
        mediation: input.mediation,
      }
    } else if (
      identity.run_id !== input.runId
      || identity.mode !== input.mode
      || identity.source_kind !== input.sourceKind
      || identity.source_ref !== input.sourceRef
      || identity.transport !== input.transport
      || identity.mediation !== input.mediation
    ) {
      throw new EgressReceiptStoreError('identity_conflict')
    }
    const existing = this.db.prepare(`
      SELECT receipt.*, identity.mode, identity.source_kind, identity.source_ref,
             identity.transport, identity.mediation
      FROM egress_receipts AS receipt
      JOIN egress_dispatches AS identity ON identity.dispatch_id = receipt.dispatch_id
      WHERE receipt.dispatch_id = ? AND receipt.observation_key = ?
    `).get(input.dispatchId, input.observationKey) as EgressReceiptStorageRow | undefined
    if (existing !== undefined) {
      if (!sameEgressObservation(existing, input)) {
        throw new EgressReceiptStoreError('observation_conflict')
      }
      return projectEgressReceipt(existing)
    }
    const receiptId = randomUUID()
    const sequence = this.db.prepare(`
      SELECT COALESCE(MAX(receipt_seq), 0) + 1 FROM egress_receipts WHERE run_id = ?
    `).pluck().get(input.runId) as number
    this.db.prepare(`
      INSERT INTO egress_receipts (
        receipt_id, receipt_seq, dispatch_id, run_id, observation_key,
        destination_origin, phase, reason_code, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId,
      sequence,
      input.dispatchId,
      input.runId,
      input.observationKey,
      input.destinationOrigin,
      input.phase,
      input.reasonCode,
      now,
    )
    // Indexed in this same transaction; a converged duplicate returned above
    // never reaches here, so one receipt yields exactly one ledger row.
    appendActivityLedgerRow(this.db, {
      family: 'egress',
      receiptId,
      runId: input.runId,
      occurredAt: now,
      outcome: input.phase,
    })
    return projectEgressReceipt({
      receipt_id: receiptId,
      receipt_seq: sequence,
      dispatch_id: input.dispatchId,
      run_id: input.runId,
      mode: input.mode,
      source_kind: input.sourceKind,
      source_ref: input.sourceRef,
      transport: input.transport,
      mediation: input.mediation,
      observation_key: input.observationKey,
      destination_origin: input.destinationOrigin,
      phase: input.phase,
      reason_code: input.reasonCode,
      observed_at: now,
    })
  }

  private reconcilePending(runId: string, reasonCode: EgressReasonCode, now: number): number {
    const identities = this.db.prepare(`
      SELECT dispatch_id, run_id, mode, source_kind, source_ref, transport, mediation
      FROM egress_dispatches AS identity
      WHERE run_id = ?
        AND EXISTS (
          SELECT 1 FROM egress_receipts AS receipt
          WHERE receipt.dispatch_id = identity.dispatch_id AND receipt.phase = 'dispatch_started'
        )
        AND NOT EXISTS (
          SELECT 1 FROM egress_receipts AS receipt
          WHERE receipt.dispatch_id = identity.dispatch_id
            AND receipt.phase IN ('response_observed', 'dispatch_failed', 'outcome_unknown')
        )
    `).all(runId) as EgressIdentityStorageRow[]
    for (const identity of identities) {
      this.observeInTransaction({
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
    return identities.length
  }
}
