/**
 * ChannelJobStore (CC1) — durable channel-procedure jobs + append-only
 * receipts, cloned from the source-job pattern (leases, checkpoints, CAS,
 * restart recovery) with two additions:
 *
 *   - CONSENT GATES: a job parks (`waiting_for_input`, claim released) with
 *     the gate card persisted on the row, and resumes only through
 *     `respondToGate` — approve requeues it, decline ends it honestly with
 *     a receipt stating what did NOT happen. An unanswered gate parks
 *     forever (timeout never implies approval).
 *   - RECEIPTS: permanent append-only records (DB triggers reject
 *     UPDATE/DELETE) carrying the consent-contract fields.
 *
 * Attempt semantics differ from source jobs deliberately: `attempt` counts
 * FAILURE-driven retries (defer, crash-requeue), not claims — a procedure
 * with several gates must not exhaust its budget by pausing.
 *
 * SECRETS: params/state/gate/receipt payloads must never carry credential
 * values. Beyond the documented rule, `assertNoSecretShapedKeys` rejects
 * key names that look like secret material — a tripwire, not a guarantee.
 */

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ChannelGateSpec } from './channel-procedures.js'

export const CHANNEL_JOB_MAX_ATTEMPTS = 3 as const
export const CHANNEL_JOB_LEASE_MS = 30_000 as const
export const CHANNEL_JOB_MAX_WORK_LINES = 500 as const

export type ChannelJobState =
  | 'queued'
  | 'running'
  | 'waiting_for_input'
  | 'waiting_for_retry'
  | 'cancel_requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface StoredChannelGate extends ChannelGateSpec {
  readonly presentedAt: number
}

export interface ChannelJob {
  readonly jobId: string
  readonly profileId: string
  readonly operation: string
  readonly channelKind: string
  readonly channelId: string | null
  readonly state: ChannelJobState
  readonly attempt: number
  readonly maxAttempts: typeof CHANNEL_JOB_MAX_ATTEMPTS
  readonly checkpoint: number
  readonly stepCount: number
  /** The parked consent gate — non-null exactly when `waiting_for_input`. */
  readonly gate: StoredChannelGate | null
  readonly cancelRequestedAt: number | null
  readonly outcomeCode: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly terminalAt: number | null
}

export interface EnqueueChannelJobInput {
  readonly profileId: string
  readonly operation: string
  readonly channelKind: string
  readonly channelId?: string
  readonly params: Readonly<Record<string, unknown>>
  readonly stepCount: number
}

export interface ChannelJobClaim {
  readonly jobId: string
  readonly profileId: string
  readonly operation: string
  readonly channelKind: string
  readonly channelId: string | null
  readonly params: Readonly<Record<string, unknown>>
  readonly state: Record<string, unknown>
  readonly stepCount: number
  readonly checkpoint: number
  readonly attempt: number
  readonly maxAttempts: typeof CHANNEL_JOB_MAX_ATTEMPTS
  readonly gateResponse: ChannelGateResponse | null
  readonly claimToken: string
  readonly leaseExpiresAt: number
}

export interface ChannelGateResponse {
  readonly gateId: string
  readonly action: 'approve'
  readonly actor: string
  readonly decidedAt: number
}

export interface ChannelWorkLine {
  readonly seq: number
  readonly title: string
  readonly detail: string | null
  readonly createdAt: number
}

export interface ChannelReceiptInput {
  readonly jobId?: string
  readonly profileId: string
  readonly channelKind?: string
  readonly channelId?: string
  readonly kind: string
  readonly title: string
  readonly body: Readonly<Record<string, unknown>>
}

export interface ChannelReceipt {
  readonly receiptId: string
  readonly jobId: string | null
  readonly profileId: string
  readonly channelKind: string | null
  readonly channelId: string | null
  readonly kind: string
  readonly title: string
  readonly body: Record<string, unknown>
  readonly createdAt: number
}

export interface ChannelGateDecisionInput {
  readonly gateId: string
  readonly action: 'approve' | 'deny'
  /** Safe identity of the decider — never a token. */
  readonly actor: string
  readonly note?: string
}

export type ChannelGateRespondResult =
  | 'accepted'
  | 'declined'
  | 'gate_mismatch'
  | 'state_conflict'
  | 'missing'

export type ChannelJobClaimOpResult = 'ok' | 'stale_claim' | 'lease_expired'
export type ChannelJobCheckpointResult =
  | 'advanced'
  | 'stale_claim'
  | 'lease_expired'
  | 'checkpoint_conflict'
export type ChannelJobParkResult = 'parked' | 'stale_claim' | 'lease_expired'
export type ChannelJobDeferResult =
  | 'deferred'
  | 'stale_claim'
  | 'lease_expired'
  | 'attempts_exhausted'
export type ChannelJobFinishResult =
  | 'finished'
  | 'stale_claim'
  | 'lease_expired'
  | 'state_conflict'
  | 'checkpoint_incomplete'
export type ChannelJobCancelRequestResult =
  | 'requested'
  | 'already_requested'
  | 'terminal'
  | 'missing'
export type ChannelJobCancelConfirmationResult =
  | 'cancelled'
  | 'stale_claim'
  | 'lease_expired'
  | 'state_conflict'

export interface ChannelJobRecoveryResult {
  readonly requeued: number
  readonly failed: number
  readonly cancelled: number
}

export class ChannelJobConflictError extends Error {
  constructor(readonly existingJobId: string) {
    super('A channel procedure for this profile and operation is already in flight')
    this.name = 'ChannelJobConflictError'
  }
}

const NAME_SHAPE = /^[a-z0-9_]{1,64}$/
const KIND_SHAPE = /^[a-z0-9_]{1,32}$/
/**
 * Key names that look like secret material. `…Id` / `…Ref` suffixed keys
 * (credentialId, tokenRef) are handles, not values, and stay allowed.
 */
const SECRET_KEY_SHAPE = /(secret|password|passphrase|token|api_?key|authorization|private_?key)$/i

export function assertNoSecretShapedKeys(
  value: unknown,
  path = 'payload',
): void {
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_SHAPE.test(key)) {
      throw new TypeError(
        `Channel job ${path}.${key} looks like a secret value — store secrets in the credential vault and reference them by id`,
      )
    }
    assertNoSecretShapedKeys(child, `${path}.${key}`)
  }
}

interface ChannelJobRow {
  readonly job_id: string
  readonly profile_id: string
  readonly operation: string
  readonly channel_kind: string
  readonly channel_id: string | null
  readonly params_json: string
  readonly state_json: string
  readonly step_count: number
  readonly state: ChannelJobState
  readonly attempt: number
  readonly max_attempts: typeof CHANNEL_JOB_MAX_ATTEMPTS
  readonly checkpoint: number
  readonly gate_json: string | null
  readonly gate_response_json: string | null
  readonly claim_token: string | null
  readonly claimed_by: string | null
  readonly lease_expires_at: number | null
  readonly retry_after: number | null
  readonly cancel_requested_at: number | null
  readonly outcome_code: string | null
  readonly created_at: number
  readonly updated_at: number
  readonly terminal_at: number | null
}

export class ChannelJobStore {
  constructor(private readonly db: Database.Database) {}

  enqueue(input: EnqueueChannelJobInput, now: number = Date.now()): ChannelJob {
    if (!NAME_SHAPE.test(input.operation)) {
      throw new TypeError(`Channel job operation is invalid: ${input.operation}`)
    }
    if (!KIND_SHAPE.test(input.channelKind)) {
      throw new TypeError(`Channel kind is invalid: ${input.channelKind}`)
    }
    if (!Number.isInteger(input.stepCount) || input.stepCount < 1 || input.stepCount > 64) {
      throw new RangeError('Channel job step count must be 1–64')
    }
    assertNoSecretShapedKeys(input.params, 'params')

    return this.db.transaction((): ChannelJob => {
      const existing = this.db.prepare(`
        SELECT job_id FROM channel_jobs
        WHERE profile_id = ? AND operation = ? AND terminal_at IS NULL
      `).get(input.profileId, input.operation) as { job_id: string } | undefined
      if (existing) throw new ChannelJobConflictError(existing.job_id)

      const jobId = randomUUID()
      this.db.prepare(`
        INSERT INTO channel_jobs (
          job_id, profile_id, operation, channel_kind, channel_id,
          params_json, state_json, step_count,
          state, attempt, max_attempts, checkpoint,
          gate_json, gate_response_json,
          claim_token, claimed_by, lease_expires_at, retry_after,
          cancel_requested_at, outcome_code, created_at, updated_at, terminal_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, '{}', ?, 'queued', 0, ?, 0,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
        )
      `).run(
        jobId,
        input.profileId,
        input.operation,
        input.channelKind,
        input.channelId ?? null,
        JSON.stringify(input.params),
        input.stepCount,
        CHANNEL_JOB_MAX_ATTEMPTS,
        now,
        now,
      )
      return this.project(this.getRow(jobId)!)
    }).immediate()
  }

  get(jobId: string): ChannelJob | null {
    const row = this.getRow(jobId)
    return row ? this.project(row) : null
  }

  listForProfile(profileId: string, limit = 50): ChannelJob[] {
    const rows = this.db.prepare(`
      SELECT * FROM channel_jobs WHERE profile_id = ?
      ORDER BY created_at DESC, job_id DESC LIMIT ?
    `).all(profileId, limit) as ChannelJobRow[]
    return rows.map((row) => this.project(row))
  }

  claimNext(workerId: string, now: number = Date.now()): ChannelJobClaim | null {
    return this.db.transaction((): ChannelJobClaim | null => {
      const candidate = this.db.prepare(`
        SELECT job_id FROM channel_jobs
        WHERE state = 'queued'
           OR (state = 'waiting_for_retry' AND retry_after <= ?)
        ORDER BY created_at ASC, job_id ASC
        LIMIT 1
      `).get(now) as { job_id: string } | undefined
      if (!candidate) return null

      const claimToken = randomUUID()
      const leaseExpiresAt = now + CHANNEL_JOB_LEASE_MS
      const updated = this.db.prepare(`
        UPDATE channel_jobs
        SET state = 'running',
          claim_token = ?, claimed_by = ?, lease_expires_at = ?,
          retry_after = NULL, updated_at = ?
        WHERE job_id = ? AND (
          state = 'queued'
          OR (state = 'waiting_for_retry' AND retry_after <= ?)
        )
      `).run(claimToken, workerId, leaseExpiresAt, now, candidate.job_id, now)
      if (updated.changes !== 1) return null

      const row = this.getRow(candidate.job_id)!
      return {
        jobId: row.job_id,
        profileId: row.profile_id,
        operation: row.operation,
        channelKind: row.channel_kind,
        channelId: row.channel_id,
        params: JSON.parse(row.params_json) as Record<string, unknown>,
        state: JSON.parse(row.state_json) as Record<string, unknown>,
        stepCount: row.step_count,
        checkpoint: row.checkpoint,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        gateResponse: row.gate_response_json
          ? (JSON.parse(row.gate_response_json) as ChannelGateResponse)
          : null,
        claimToken: row.claim_token!,
        leaseExpiresAt: row.lease_expires_at!,
      }
    }).immediate()
  }

  renewLease(
    jobId: string,
    claimToken: string,
    now: number = Date.now(),
  ): ChannelJobClaimOpResult {
    return this.db.transaction((): ChannelJobClaimOpResult => {
      const row = this.getRow(jobId)
      if (!row || row.state !== 'running' || row.claim_token !== claimToken) {
        return 'stale_claim'
      }
      if (row.lease_expires_at === null || row.lease_expires_at < now) {
        return 'lease_expired'
      }
      this.db.prepare(`
        UPDATE channel_jobs SET lease_expires_at = ?, updated_at = ?
        WHERE job_id = ? AND state = 'running' AND claim_token = ?
      `).run(now + CHANNEL_JOB_LEASE_MS, now, jobId, claimToken)
      return 'ok'
    }).immediate()
  }

  /**
   * Advance to the next checkpoint, atomically persisting the step state
   * gathered by the completed step.
   */
  advanceCheckpoint(
    jobId: string,
    claimToken: string,
    expectedCheckpoint: number,
    stepState: Readonly<Record<string, unknown>>,
    now: number = Date.now(),
  ): ChannelJobCheckpointResult {
    assertNoSecretShapedKeys(stepState, 'state')
    return this.db.transaction((): ChannelJobCheckpointResult => {
      const row = this.getRow(jobId)
      if (!row || row.state !== 'running' || row.claim_token !== claimToken) {
        return 'stale_claim'
      }
      if (row.lease_expires_at === null || row.lease_expires_at < now) {
        return 'lease_expired'
      }
      if (row.checkpoint !== expectedCheckpoint) return 'checkpoint_conflict'
      if (expectedCheckpoint + 1 > row.step_count) {
        throw new RangeError('Channel job checkpoint exceeds the procedure')
      }
      const advanced = this.db.prepare(`
        UPDATE channel_jobs
        SET checkpoint = ?, state_json = ?, gate_response_json = NULL, updated_at = ?
        WHERE job_id = ? AND state = 'running' AND claim_token = ?
          AND lease_expires_at >= ? AND checkpoint = ?
      `).run(
        expectedCheckpoint + 1,
        JSON.stringify(stepState),
        now,
        jobId,
        claimToken,
        now,
        expectedCheckpoint,
      )
      return advanced.changes === 1 ? 'advanced' : 'stale_claim'
    }).immediate()
  }

  appendWorkLine(
    jobId: string,
    claimToken: string,
    title: string,
    detail: string | undefined,
    now: number = Date.now(),
  ): ChannelJobClaimOpResult {
    if (!title.trim() || title.length > 200) {
      throw new RangeError('Channel work line title must be 1–200 characters')
    }
    if (detail !== undefined && detail.length > 1000) {
      throw new RangeError('Channel work line detail exceeds 1000 characters')
    }
    return this.db.transaction((): ChannelJobClaimOpResult => {
      const row = this.getRow(jobId)
      if (!row || row.state !== 'running' || row.claim_token !== claimToken) {
        return 'stale_claim'
      }
      if (row.lease_expires_at === null || row.lease_expires_at < now) {
        return 'lease_expired'
      }
      const last = this.db.prepare(
        'SELECT MAX(seq) AS seq FROM channel_job_work_lines WHERE job_id = ?',
      ).get(jobId) as { seq: number | null }
      const seq = (last.seq ?? 0) + 1
      if (seq > CHANNEL_JOB_MAX_WORK_LINES) {
        throw new RangeError('Channel job work-line budget exhausted — the procedure is too chatty')
      }
      this.db.prepare(`
        INSERT INTO channel_job_work_lines (job_id, seq, title, detail, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(jobId, seq, title, detail ?? null, now)
      return 'ok'
    }).immediate()
  }

  workLines(jobId: string): ChannelWorkLine[] {
    const rows = this.db.prepare(`
      SELECT seq, title, detail, created_at FROM channel_job_work_lines
      WHERE job_id = ? ORDER BY seq ASC
    `).all(jobId) as Array<{
      seq: number; title: string; detail: string | null; created_at: number
    }>
    return rows.map((r) => ({
      seq: r.seq, title: r.title, detail: r.detail, createdAt: r.created_at,
    }))
  }

  /** Park at a consent gate: claim released, job waits for a person. */
  parkForGate(
    jobId: string,
    claimToken: string,
    gate: ChannelGateSpec,
    now: number = Date.now(),
  ): ChannelJobParkResult {
    assertNoSecretShapedKeys(gate, 'gate')
    return this.db.transaction((): ChannelJobParkResult => {
      const row = this.getRow(jobId)
      if (!row || row.state !== 'running' || row.claim_token !== claimToken) {
        return 'stale_claim'
      }
      if (row.lease_expires_at === null || row.lease_expires_at < now) {
        return 'lease_expired'
      }
      const stored: StoredChannelGate = { ...gate, presentedAt: now }
      const parked = this.db.prepare(`
        UPDATE channel_jobs
        SET state = 'waiting_for_input', gate_json = ?, gate_response_json = NULL,
          claim_token = NULL, claimed_by = NULL, lease_expires_at = NULL,
          updated_at = ?
        WHERE job_id = ? AND state = 'running' AND claim_token = ?
          AND lease_expires_at >= ?
      `).run(JSON.stringify(stored), now, jobId, claimToken, now)
      return parked.changes === 1 ? 'parked' : 'stale_claim'
    }).immediate()
  }

  /**
   * A person decides a parked gate. Approve requeues the job with the
   * decision attached; decline ends the procedure (state unchanged for the
   * customer — the receipt says so). Both write a permanent receipt.
   */
  respondToGate(
    jobId: string,
    decision: ChannelGateDecisionInput,
    now: number = Date.now(),
  ): ChannelGateRespondResult {
    if (!decision.actor.trim()) throw new TypeError('Gate decision needs an actor')
    return this.db.transaction((): ChannelGateRespondResult => {
      const row = this.getRow(jobId)
      if (!row) return 'missing'
      if (row.state !== 'waiting_for_input' || row.gate_json === null) {
        return 'state_conflict'
      }
      const gate = JSON.parse(row.gate_json) as StoredChannelGate
      if (gate.id !== decision.gateId) return 'gate_mismatch'

      const receiptBody = {
        gateId: gate.id,
        action: decision.action,
        actor: decision.actor,
        scope: gate.included,
        exclusions: gate.excluded,
        requestedAt: gate.presentedAt,
        decidedAt: now,
        ...(decision.note ? { note: decision.note } : {}),
        ...(decision.action === 'deny'
          ? { whatRemainedUnchanged: gate.onDecline }
          : {}),
      }
      this.insertReceipt({
        jobId,
        profileId: row.profile_id,
        channelKind: row.channel_kind,
        ...(row.channel_id ? { channelId: row.channel_id } : {}),
        kind: 'gate_decision',
        title: decision.action === 'approve'
          ? `Approved — ${gate.title}`
          : `Declined — ${gate.title}`,
        body: receiptBody,
      }, now)

      if (decision.action === 'approve') {
        const response: ChannelGateResponse = {
          gateId: gate.id,
          action: 'approve',
          actor: decision.actor,
          decidedAt: now,
        }
        this.db.prepare(`
          UPDATE channel_jobs
          SET state = 'queued', gate_json = NULL, gate_response_json = ?,
            updated_at = ?
          WHERE job_id = ? AND state = 'waiting_for_input'
        `).run(JSON.stringify(response), now, jobId)
        return 'accepted'
      }

      this.db.prepare(`
        UPDATE channel_jobs
        SET state = 'cancelled', gate_json = NULL, gate_response_json = NULL,
          cancel_requested_at = ?, outcome_code = 'gate_declined',
          updated_at = ?, terminal_at = ?
        WHERE job_id = ? AND state = 'waiting_for_input'
      `).run(now, now, now, jobId)
      return 'declined'
    }).immediate()
  }

  /**
   * The gate step consumes an approve decision: clears the response and
   * advances past the gate in one CAS.
   */
  consumeGateResponse(
    jobId: string,
    claimToken: string,
    expectedCheckpoint: number,
    expectedGateId: string,
    now: number = Date.now(),
  ): ChannelJobCheckpointResult | 'response_missing' {
    return this.db.transaction((): ChannelJobCheckpointResult | 'response_missing' => {
      const row = this.getRow(jobId)
      if (!row || row.state !== 'running' || row.claim_token !== claimToken) {
        return 'stale_claim'
      }
      if (row.lease_expires_at === null || row.lease_expires_at < now) {
        return 'lease_expired'
      }
      if (row.checkpoint !== expectedCheckpoint) return 'checkpoint_conflict'
      if (!row.gate_response_json) return 'response_missing'
      const response = JSON.parse(row.gate_response_json) as ChannelGateResponse
      if (response.gateId !== expectedGateId) return 'response_missing'
      if (expectedCheckpoint + 1 > row.step_count) {
        throw new RangeError('Channel job checkpoint exceeds the procedure')
      }
      const advanced = this.db.prepare(`
        UPDATE channel_jobs
        SET checkpoint = ?, gate_response_json = NULL, updated_at = ?
        WHERE job_id = ? AND state = 'running' AND claim_token = ?
          AND lease_expires_at >= ? AND checkpoint = ?
      `).run(
        expectedCheckpoint + 1, now, jobId, claimToken, now, expectedCheckpoint,
      )
      return advanced.changes === 1 ? 'advanced' : 'stale_claim'
    }).immediate()
  }

  /** Transient failure: release the claim and retry later (costs an attempt). */
  deferUntil(
    jobId: string,
    claimToken: string,
    retryAt: number,
    now: number = Date.now(),
  ): ChannelJobDeferResult {
    if (!Number.isSafeInteger(retryAt) || retryAt <= now) {
      throw new RangeError('Channel job retry time must be in the future')
    }
    return this.db.transaction((): ChannelJobDeferResult => {
      const row = this.getRow(jobId)
      if (!row || row.state !== 'running' || row.claim_token !== claimToken) {
        return 'stale_claim'
      }
      if (row.lease_expires_at === null || row.lease_expires_at < now) {
        return 'lease_expired'
      }
      if (row.attempt >= row.max_attempts) return 'attempts_exhausted'
      const deferred = this.db.prepare(`
        UPDATE channel_jobs
        SET state = 'waiting_for_retry', attempt = attempt + 1,
          claim_token = NULL, claimed_by = NULL, lease_expires_at = NULL,
          retry_after = ?, updated_at = ?
        WHERE job_id = ? AND state = 'running' AND claim_token = ?
          AND lease_expires_at >= ? AND attempt < max_attempts
      `).run(retryAt, now, jobId, claimToken, now)
      return deferred.changes === 1 ? 'deferred' : 'stale_claim'
    }).immediate()
  }

  finish(
    jobId: string,
    claimToken: string,
    outcome: 'succeeded' | 'failed',
    outcomeCode: string,
    now: number = Date.now(),
  ): ChannelJobFinishResult {
    if (!NAME_SHAPE.test(outcomeCode)) {
      throw new TypeError('Channel job outcome code is invalid')
    }
    return this.db.transaction((): ChannelJobFinishResult => {
      const row = this.getRow(jobId)
      if (!row || row.state !== 'running') return 'state_conflict'
      if (row.claim_token !== claimToken) return 'stale_claim'
      if (row.lease_expires_at === null || row.lease_expires_at < now) {
        return 'lease_expired'
      }
      if (outcome === 'succeeded' && row.checkpoint !== row.step_count) {
        return 'checkpoint_incomplete'
      }
      const finished = this.db.prepare(`
        UPDATE channel_jobs
        SET state = ?, claim_token = NULL, claimed_by = NULL,
          lease_expires_at = NULL, retry_after = NULL, gate_response_json = NULL,
          outcome_code = ?, updated_at = ?, terminal_at = ?
        WHERE job_id = ? AND state = 'running' AND claim_token = ?
          AND lease_expires_at >= ?
      `).run(outcome, outcomeCode, now, now, jobId, claimToken, now)
      return finished.changes === 1 ? 'finished' : 'stale_claim'
    }).immediate()
  }

  requestCancel(jobId: string, now: number = Date.now()): ChannelJobCancelRequestResult {
    return this.db.transaction((): ChannelJobCancelRequestResult => {
      const row = this.getRow(jobId)
      if (!row) return 'missing'
      if (row.state === 'cancel_requested') return 'already_requested'
      if (isTerminal(row.state)) return 'terminal'
      const requested = this.db.prepare(`
        UPDATE channel_jobs
        SET state = 'cancel_requested', cancel_requested_at = ?,
          gate_json = NULL, gate_response_json = NULL,
          retry_after = NULL, updated_at = ?
        WHERE job_id = ? AND state IN (
          'queued', 'running', 'waiting_for_input', 'waiting_for_retry'
        )
      `).run(now, now, jobId)
      return requested.changes === 1 ? 'requested' : 'already_requested'
    }).immediate()
  }

  confirmNextUnclaimedCancellation(now: number = Date.now()): boolean {
    const candidate = this.db.prepare(`
      SELECT job_id FROM channel_jobs
      WHERE state = 'cancel_requested' AND claim_token IS NULL
      ORDER BY updated_at ASC, job_id ASC
      LIMIT 1
    `).get() as { job_id: string } | undefined
    return candidate !== undefined &&
      this.confirmCancelled(candidate.job_id, null, now) === 'cancelled'
  }

  confirmCancelled(
    jobId: string,
    claimToken: string | null,
    now: number = Date.now(),
  ): ChannelJobCancelConfirmationResult {
    return this.db.transaction((): ChannelJobCancelConfirmationResult => {
      const row = this.getRow(jobId)
      if (!row || row.state !== 'cancel_requested') return 'state_conflict'
      if (row.claim_token !== claimToken) return 'stale_claim'
      if (row.lease_expires_at !== null && row.lease_expires_at < now) {
        return 'lease_expired'
      }
      const cancelled = this.db.prepare(`
        UPDATE channel_jobs
        SET state = 'cancelled', claim_token = NULL, claimed_by = NULL,
          lease_expires_at = NULL, retry_after = NULL,
          outcome_code = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE job_id = ? AND state = 'cancel_requested'
          AND claim_token IS ?
          AND (lease_expires_at IS NULL OR lease_expires_at >= ?)
      `).run(now, now, jobId, claimToken, now)
      if (cancelled.changes !== 1) return 'stale_claim'
      this.insertReceipt({
        jobId,
        profileId: row.profile_id,
        channelKind: row.channel_kind,
        ...(row.channel_id ? { channelId: row.channel_id } : {}),
        kind: 'procedure_cancelled',
        title: 'Setup cancelled — nothing further was changed',
        body: {
          operation: row.operation,
          checkpointReached: row.checkpoint,
          requestedAt: row.cancel_requested_at,
        },
      }, now)
      return 'cancelled'
    }).immediate()
  }

  /** Startup / periodic recovery: expired running leases and stale cancels. */
  recoverExpiredClaims(now: number = Date.now()): ChannelJobRecoveryResult {
    return this.db.transaction((): ChannelJobRecoveryResult => {
      const cancelTargets = this.db.prepare(`
        SELECT job_id FROM channel_jobs
        WHERE state = 'cancel_requested'
          AND (claim_token IS NULL OR lease_expires_at < ?)
      `).all(now) as Array<{ job_id: string }>
      let cancelled = 0
      for (const target of cancelTargets) {
        this.db.prepare(`
          UPDATE channel_jobs
          SET claim_token = NULL, claimed_by = NULL, lease_expires_at = NULL,
            updated_at = ?
          WHERE job_id = ? AND state = 'cancel_requested'
            AND claim_token IS NOT NULL AND lease_expires_at < ?
        `).run(now, target.job_id, now)
        if (this.confirmCancelled(target.job_id, null, now) === 'cancelled') {
          cancelled += 1
        }
      }
      const requeued = this.db.prepare(`
        UPDATE channel_jobs
        SET state = 'queued', attempt = attempt + 1,
          claim_token = NULL, claimed_by = NULL, lease_expires_at = NULL,
          retry_after = NULL, updated_at = ?
        WHERE state = 'running' AND lease_expires_at < ?
          AND attempt < max_attempts
      `).run(now, now).changes
      const failed = this.db.prepare(`
        UPDATE channel_jobs
        SET state = 'failed', claim_token = NULL, claimed_by = NULL,
          lease_expires_at = NULL, retry_after = NULL,
          outcome_code = 'attempts_exhausted', updated_at = ?, terminal_at = ?
        WHERE state = 'running' AND lease_expires_at < ?
          AND attempt >= max_attempts
      `).run(now, now, now).changes
      return { requeued, failed, cancelled }
    }).immediate()
  }

  appendReceipt(input: ChannelReceiptInput, now: number = Date.now()): ChannelReceipt {
    return this.db.transaction(
      (): ChannelReceipt => this.insertReceipt(input, now),
    ).immediate()
  }

  receiptsForJob(jobId: string): ChannelReceipt[] {
    const rows = this.db.prepare(`
      SELECT * FROM channel_receipts WHERE job_id = ?
      ORDER BY created_at ASC, receipt_id ASC
    `).all(jobId) as Array<Record<string, unknown>>
    return rows.map(projectReceipt)
  }

  receiptsForProfile(profileId: string, limit = 100): ChannelReceipt[] {
    const rows = this.db.prepare(`
      SELECT * FROM channel_receipts WHERE profile_id = ?
      ORDER BY created_at DESC, receipt_id DESC LIMIT ?
    `).all(profileId, limit) as Array<Record<string, unknown>>
    return rows.map(projectReceipt)
  }

  private insertReceipt(input: ChannelReceiptInput, now: number): ChannelReceipt {
    if (!NAME_SHAPE.test(input.kind)) {
      throw new TypeError(`Channel receipt kind is invalid: ${input.kind}`)
    }
    if (!input.title.trim() || input.title.length > 200) {
      throw new RangeError('Channel receipt title must be 1–200 characters')
    }
    assertNoSecretShapedKeys(input.body, 'receipt')
    const receiptId = randomUUID()
    this.db.prepare(`
      INSERT INTO channel_receipts (
        receipt_id, job_id, profile_id, channel_kind, channel_id,
        kind, title, body_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId,
      input.jobId ?? null,
      input.profileId,
      input.channelKind ?? null,
      input.channelId ?? null,
      input.kind,
      input.title,
      JSON.stringify(input.body),
      now,
    )
    return {
      receiptId,
      jobId: input.jobId ?? null,
      profileId: input.profileId,
      channelKind: input.channelKind ?? null,
      channelId: input.channelId ?? null,
      kind: input.kind,
      title: input.title,
      body: { ...input.body },
      createdAt: now,
    }
  }

  private getRow(jobId: string): ChannelJobRow | null {
    return (this.db.prepare(
      'SELECT * FROM channel_jobs WHERE job_id = ?',
    ).get(jobId) as ChannelJobRow | undefined) ?? null
  }

  private project(row: ChannelJobRow): ChannelJob {
    return {
      jobId: row.job_id,
      profileId: row.profile_id,
      operation: row.operation,
      channelKind: row.channel_kind,
      channelId: row.channel_id,
      state: row.state,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      checkpoint: row.checkpoint,
      stepCount: row.step_count,
      gate: row.gate_json ? (JSON.parse(row.gate_json) as StoredChannelGate) : null,
      cancelRequestedAt: row.cancel_requested_at,
      outcomeCode: row.outcome_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      terminalAt: row.terminal_at,
    }
  }
}

function isTerminal(state: ChannelJobState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}

function projectReceipt(row: Record<string, unknown>): ChannelReceipt {
  return {
    receiptId: row['receipt_id'] as string,
    jobId: row['job_id'] as string | null,
    profileId: row['profile_id'] as string,
    channelKind: row['channel_kind'] as string | null,
    channelId: row['channel_id'] as string | null,
    kind: row['kind'] as string,
    title: row['title'] as string,
    body: JSON.parse(row['body_json'] as string) as Record<string, unknown>,
    createdAt: row['created_at'] as number,
  }
}
