import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export const SOURCE_JOB_MAX_ATTEMPTS = 3 as const
export const SOURCE_JOB_LEASE_MS = 30_000 as const

export type SourceJobOperation = 'inspect_format'
export type SourceJobState =
  | 'queued'
  | 'running'
  | 'waiting_for_resource'
  | 'cancel_requested'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'

export interface SourceJob {
  readonly jobId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly operation: SourceJobOperation
  readonly state: SourceJobState
  readonly attempt: number
  readonly maxAttempts: typeof SOURCE_JOB_MAX_ATTEMPTS
  readonly checkpoint: number
  readonly cancelRequestedAt: number | null
  readonly outcomeCode: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly terminalAt: number | null
}

export interface EnqueueSourceJobInput {
  readonly workspaceId: string
  readonly profileId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly operation: SourceJobOperation
}

export interface SourceJobClaim {
  readonly jobId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly operation: SourceJobOperation
  readonly attempt: number
  readonly maxAttempts: typeof SOURCE_JOB_MAX_ATTEMPTS
  readonly checkpoint: number
  readonly claimToken: string
  readonly leaseExpiresAt: number
}

export interface ClaimedSourceInspectionTarget {
  readonly objectKey: string
  readonly expectedByteCount: number
  readonly expectedChecksum: string
  readonly verifiedMediaType: 'text/plain' | 'application/pdf'
}

export type SourceJobCheckpointResult =
  | 'advanced'
  | 'stale_claim'
  | 'lease_expired'
  | 'checkpoint_conflict'

export interface SourceJobRecoveryResult {
  readonly requeued: number
  readonly failed: number
  readonly cancelled: number
}

export type SourceJobCancelRequestResult =
  | 'requested'
  | 'already_requested'
  | 'terminal'
  | 'missing'

export type SourceJobCancelConfirmationResult =
  | 'cancelled'
  | 'stale_claim'
  | 'lease_expired'
  | 'state_conflict'

export type SourceJobDeferResult =
  | 'deferred'
  | 'stale_claim'
  | 'lease_expired'

export type SourceJobFinishOutcome = 'succeeded' | 'partial' | 'failed'
export type SourceJobFinishResult =
  | 'finished'
  | 'stale_claim'
  | 'lease_expired'
  | 'state_conflict'
  | 'checkpoint_incomplete'

interface SourceJobRow {
  readonly job_id: string
  readonly workspace_id: string
  readonly profile_id: string
  readonly source_id: string
  readonly source_version_id: string
  readonly operation: SourceJobOperation
  readonly state: SourceJobState
  readonly attempt: number
  readonly max_attempts: typeof SOURCE_JOB_MAX_ATTEMPTS
  readonly checkpoint: number
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

export class SourceJobTargetNotFoundError extends Error {
  constructor() {
    super('Source job target not found')
    this.name = 'SourceJobTargetNotFoundError'
  }
}

export class SourceJobStore {
  constructor(private readonly db: Database.Database) {}

  enqueue(input: EnqueueSourceJobInput, now: number = Date.now()): SourceJob {
    return this.db.transaction((): SourceJob => {
      const target = this.db.prepare(`
        SELECT v.source_version_id FROM source_versions v
        JOIN runtime_sources s ON s.source_id = v.source_id
        WHERE v.source_version_id = ? AND v.source_id = ?
          AND s.workspace_id = ? AND s.profile_id = ?
          AND s.deletion_state = 'active'
      `).get(
        input.sourceVersionId,
        input.sourceId,
        input.workspaceId,
        input.profileId,
      )
      if (!target) throw new SourceJobTargetNotFoundError()

      const existing = this.getByVersion(input.sourceVersionId, input.operation)
      if (existing) return this.project(existing)

      const jobId = randomUUID()
      this.db.prepare(`
        INSERT INTO source_jobs (
          job_id, workspace_id, profile_id, source_id, source_version_id,
          operation, state, attempt, max_attempts, checkpoint,
          claim_token, claimed_by, lease_expires_at, retry_after,
          cancel_requested_at, outcome_code, created_at, updated_at, terminal_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, 'queued', 0, ?, 0,
          NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
        )
      `).run(
        jobId,
        input.workspaceId,
        input.profileId,
        input.sourceId,
        input.sourceVersionId,
        input.operation,
        SOURCE_JOB_MAX_ATTEMPTS,
        now,
        now,
      )
      this.setInspectionState(input.sourceId, input.sourceVersionId, 'queued', now)
      return this.project(this.getRow(jobId)!)
    }).immediate()
  }

  getScoped(
    jobId: string,
    workspaceId: string,
    profileId: string,
  ): SourceJob | null {
    const row = this.db.prepare(`
      SELECT * FROM source_jobs
      WHERE job_id = ? AND workspace_id = ? AND profile_id = ?
    `).get(jobId, workspaceId, profileId) as SourceJobRow | undefined
    return row ? this.project(row) : null
  }

  claimNext(workerId: string, now: number = Date.now()): SourceJobClaim | null {
    return this.db.transaction((): SourceJobClaim | null => {
      const candidate = this.db.prepare(`
        SELECT job_id FROM source_jobs
        WHERE attempt < max_attempts
          AND (
            state = 'queued'
            OR (state = 'waiting_for_resource' AND retry_after <= ?)
          )
        ORDER BY created_at ASC, job_id ASC
        LIMIT 1
      `).get(now) as { job_id: string } | undefined
      if (!candidate) return null

      const claimToken = randomUUID()
      const leaseExpiresAt = now + SOURCE_JOB_LEASE_MS
      const updated = this.db.prepare(`
        UPDATE source_jobs
        SET state = 'running', attempt = attempt + 1,
          claim_token = ?, claimed_by = ?, lease_expires_at = ?,
          retry_after = NULL, updated_at = ?
        WHERE job_id = ? AND attempt < max_attempts
          AND (
            state = 'queued'
            OR (state = 'waiting_for_resource' AND retry_after <= ?)
          )
      `).run(
        claimToken,
        workerId,
        leaseExpiresAt,
        now,
        candidate.job_id,
        now,
      )
      if (updated.changes !== 1) return null
      const row = this.getRow(candidate.job_id)!
      if (row.operation === 'inspect_format') {
        this.setInspectionState(row.source_id, row.source_version_id, 'inspecting', now)
      }
      return {
        jobId: row.job_id,
        sourceId: row.source_id,
        sourceVersionId: row.source_version_id,
        operation: row.operation,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        checkpoint: row.checkpoint,
        claimToken: row.claim_token!,
        leaseExpiresAt: row.lease_expires_at!,
      }
    }).immediate()
  }

  getClaimedInspectionTarget(
    jobId: string,
    claimToken: string,
    now: number = Date.now(),
  ): ClaimedSourceInspectionTarget | null {
    const row = this.db.prepare(`
      SELECT v.object_key, v.byte_count, v.checksum, v.verified_media_type
      FROM source_jobs j
      JOIN source_versions v
        ON v.source_version_id = j.source_version_id
       AND v.source_id = j.source_id
      WHERE j.job_id = ? AND j.operation = 'inspect_format'
        AND j.state = 'running' AND j.claim_token = ?
        AND j.lease_expires_at >= ?
    `).get(jobId, claimToken, now) as {
      object_key: string
      byte_count: number
      checksum: string
      verified_media_type: 'text/plain' | 'application/pdf'
    } | undefined
    return row ? {
      objectKey: row.object_key,
      expectedByteCount: row.byte_count,
      expectedChecksum: row.checksum,
      verifiedMediaType: row.verified_media_type,
    } : null
  }

  advanceCheckpoint(
    jobId: string,
    claimToken: string,
    expectedCheckpoint: number,
    nextCheckpoint: number,
    now: number = Date.now(),
  ): SourceJobCheckpointResult {
    if (!Number.isInteger(expectedCheckpoint) || nextCheckpoint !== expectedCheckpoint + 1 ||
        nextCheckpoint < 1 || nextCheckpoint > 4) {
      throw new RangeError('Source job checkpoint transition is invalid')
    }
    return this.db.transaction((): SourceJobCheckpointResult => {
      const row = this.getRow(jobId)
      if (!row || row.state !== 'running' || row.claim_token !== claimToken) {
        return 'stale_claim'
      }
      if (row.lease_expires_at === null || row.lease_expires_at < now) {
        return 'lease_expired'
      }
      if (row.checkpoint !== expectedCheckpoint) return 'checkpoint_conflict'

      const advanced = this.db.prepare(`
        UPDATE source_jobs SET checkpoint = ?, updated_at = ?
        WHERE job_id = ? AND state = 'running' AND claim_token = ?
          AND lease_expires_at >= ? AND checkpoint = ?
      `).run(
        nextCheckpoint,
        now,
        jobId,
        claimToken,
        now,
        expectedCheckpoint,
      )
      return advanced.changes === 1 ? 'advanced' : 'stale_claim'
    }).immediate()
  }

  recoverExpiredClaims(now: number = Date.now()): SourceJobRecoveryResult {
    return this.db.transaction((): SourceJobRecoveryResult => {
      const cancellationTargets = this.db.prepare(`
        SELECT source_id, source_version_id FROM source_jobs
        WHERE state = 'cancel_requested'
          AND (claim_token IS NULL OR lease_expires_at < ?)
      `).all(now) as Array<{ source_id: string; source_version_id: string }>
      const requeueTargets = this.db.prepare(`
        SELECT source_id, source_version_id FROM source_jobs
        WHERE state = 'running' AND lease_expires_at < ?
          AND attempt < max_attempts
      `).all(now) as Array<{ source_id: string; source_version_id: string }>
      const failureTargets = this.db.prepare(`
        SELECT source_id, source_version_id FROM source_jobs
        WHERE state = 'running' AND lease_expires_at < ?
          AND attempt >= max_attempts
      `).all(now) as Array<{ source_id: string; source_version_id: string }>
      const cancelled = this.db.prepare(`
        UPDATE source_jobs
        SET state = 'cancelled', claim_token = NULL, claimed_by = NULL,
          lease_expires_at = NULL, retry_after = NULL,
          outcome_code = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE state = 'cancel_requested'
          AND (claim_token IS NULL OR lease_expires_at < ?)
      `).run(now, now, now).changes
      const requeued = this.db.prepare(`
        UPDATE source_jobs
        SET state = 'queued', claim_token = NULL, claimed_by = NULL,
          lease_expires_at = NULL, retry_after = NULL, updated_at = ?
        WHERE state = 'running' AND lease_expires_at < ?
          AND attempt < max_attempts
      `).run(now, now).changes
      const failed = this.db.prepare(`
        UPDATE source_jobs
        SET state = 'failed', claim_token = NULL, claimed_by = NULL,
          lease_expires_at = NULL, retry_after = NULL,
          outcome_code = 'attempts_exhausted', updated_at = ?, terminal_at = ?
        WHERE state = 'running' AND lease_expires_at < ?
          AND attempt >= max_attempts
      `).run(now, now, now).changes
      for (const target of cancellationTargets) {
        this.setInspectionState(
          target.source_id, target.source_version_id, 'not_started', now,
        )
      }
      for (const target of requeueTargets) {
        this.setInspectionState(
          target.source_id, target.source_version_id, 'queued', now,
        )
      }
      for (const target of failureTargets) {
        this.setInspectionState(
          target.source_id, target.source_version_id, 'failed', now,
        )
      }
      return { requeued, failed, cancelled }
    }).immediate()
  }

  requestCancel(
    jobId: string,
    workspaceId: string,
    profileId: string,
    now: number = Date.now(),
  ): SourceJobCancelRequestResult {
    return this.db.transaction((): SourceJobCancelRequestResult => {
      const row = this.db.prepare(`
        SELECT * FROM source_jobs
        WHERE job_id = ? AND workspace_id = ? AND profile_id = ?
      `).get(jobId, workspaceId, profileId) as SourceJobRow | undefined
      if (!row) return 'missing'
      if (row.state === 'cancel_requested') return 'already_requested'
      if (isTerminal(row.state)) return 'terminal'

      const requested = this.db.prepare(`
        UPDATE source_jobs
        SET state = 'cancel_requested', cancel_requested_at = ?,
          retry_after = NULL, updated_at = ?
        WHERE job_id = ? AND state IN ('queued', 'running', 'waiting_for_resource')
      `).run(now, now, jobId)
      return requested.changes === 1 ? 'requested' : 'already_requested'
    }).immediate()
  }

  confirmCancelled(
    jobId: string,
    claimToken: string | null,
    now: number = Date.now(),
  ): SourceJobCancelConfirmationResult {
    return this.db.transaction((): SourceJobCancelConfirmationResult => {
      const row = this.getRow(jobId)
      if (!row || row.state !== 'cancel_requested') return 'state_conflict'
      if (row.claim_token !== claimToken) return 'stale_claim'
      if (row.lease_expires_at !== null && row.lease_expires_at < now) {
        return 'lease_expired'
      }

      if (row.operation === 'inspect_format') {
        this.setInspectionState(
          row.source_id, row.source_version_id, 'not_started', now,
        )
      }

      const cancelled = this.db.prepare(`
        UPDATE source_jobs
        SET state = 'cancelled', claim_token = NULL, claimed_by = NULL,
          lease_expires_at = NULL, retry_after = NULL,
          outcome_code = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE job_id = ? AND state = 'cancel_requested'
          AND claim_token IS ?
          AND (lease_expires_at IS NULL OR lease_expires_at >= ?)
      `).run(now, now, jobId, claimToken, now)
      return cancelled.changes === 1 ? 'cancelled' : 'stale_claim'
    }).immediate()
  }

  deferUntil(
    jobId: string,
    claimToken: string,
    retryAt: number,
    now: number = Date.now(),
  ): SourceJobDeferResult {
    if (!Number.isSafeInteger(retryAt) || retryAt <= now) {
      throw new RangeError('Source job retry time must be in the future')
    }
    return this.db.transaction((): SourceJobDeferResult => {
      const row = this.getRow(jobId)
      if (!row || row.state !== 'running' || row.claim_token !== claimToken) {
        return 'stale_claim'
      }
      if (row.lease_expires_at === null || row.lease_expires_at < now) {
        return 'lease_expired'
      }
      const deferred = this.db.prepare(`
        UPDATE source_jobs
        SET state = 'waiting_for_resource', claim_token = NULL,
          claimed_by = NULL, lease_expires_at = NULL,
          retry_after = ?, updated_at = ?
        WHERE job_id = ? AND state = 'running' AND claim_token = ?
          AND lease_expires_at >= ?
      `).run(retryAt, now, jobId, claimToken, now)
      if (deferred.changes === 1 && row.operation === 'inspect_format') {
        this.setInspectionState(
          row.source_id, row.source_version_id, 'queued', now,
        )
      }
      return deferred.changes === 1 ? 'deferred' : 'stale_claim'
    }).immediate()
  }

  finish(
    jobId: string,
    claimToken: string,
    outcome: SourceJobFinishOutcome,
    outcomeCode: string,
    now: number = Date.now(),
  ): SourceJobFinishResult {
    if (!/^[a-z0-9_]{1,64}$/.test(outcomeCode)) {
      throw new TypeError('Source job outcome code is invalid')
    }
    return this.db.transaction((): SourceJobFinishResult => {
      const row = this.getRow(jobId)
      if (!row || row.state !== 'running') return 'state_conflict'
      if (row.claim_token !== claimToken) return 'stale_claim'
      if (row.lease_expires_at === null || row.lease_expires_at < now) {
        return 'lease_expired'
      }
      if (outcome === 'succeeded' && row.checkpoint !== 4) {
        return 'checkpoint_incomplete'
      }

      const finished = this.db.prepare(`
        UPDATE source_jobs
        SET state = ?, claim_token = NULL, claimed_by = NULL,
          lease_expires_at = NULL, retry_after = NULL,
          outcome_code = ?, updated_at = ?, terminal_at = ?
        WHERE job_id = ? AND state = 'running' AND claim_token = ?
          AND lease_expires_at >= ?
      `).run(outcome, outcomeCode, now, now, jobId, claimToken, now)
      return finished.changes === 1 ? 'finished' : 'stale_claim'
    }).immediate()
  }

  finishInspection(
    jobId: string,
    claimToken: string,
    outcome: SourceJobFinishOutcome,
    outcomeCode: string,
    now: number = Date.now(),
  ): SourceJobFinishResult {
    if (!/^[a-z0-9_]{1,64}$/.test(outcomeCode)) {
      throw new TypeError('Source job outcome code is invalid')
    }
    return this.db.transaction((): SourceJobFinishResult => {
      const row = this.getRow(jobId)
      if (!row || row.state !== 'running' || row.operation !== 'inspect_format') {
        return 'state_conflict'
      }
      if (row.claim_token !== claimToken) return 'stale_claim'
      if (row.lease_expires_at === null || row.lease_expires_at < now) {
        return 'lease_expired'
      }
      if (outcome === 'succeeded' && row.checkpoint !== 3) {
        return 'checkpoint_incomplete'
      }

      const inspectionState = outcome === 'succeeded'
        ? 'complete' : outcome === 'partial' ? 'partial' : 'failed'
      this.setInspectionState(
        row.source_id,
        row.source_version_id,
        inspectionState,
        now,
      )
      const finished = this.db.prepare(`
        UPDATE source_jobs
        SET state = ?, checkpoint = CASE WHEN ? = 'succeeded' THEN 4 ELSE checkpoint END,
          claim_token = NULL, claimed_by = NULL, lease_expires_at = NULL,
          retry_after = NULL, outcome_code = ?, updated_at = ?, terminal_at = ?
        WHERE job_id = ? AND state = 'running' AND claim_token = ?
          AND lease_expires_at >= ?
      `).run(
        outcome,
        outcome,
        outcomeCode,
        now,
        now,
        jobId,
        claimToken,
        now,
      )
      if (finished.changes !== 1) throw new Error('Source inspection claim changed')
      return 'finished'
    }).immediate()
  }

  private getByVersion(
    sourceVersionId: string,
    operation: SourceJobOperation,
  ): SourceJobRow | null {
    return (this.db.prepare(`
      SELECT * FROM source_jobs WHERE source_version_id = ? AND operation = ?
    `).get(sourceVersionId, operation) as SourceJobRow | undefined) ?? null
  }

  private getRow(jobId: string): SourceJobRow | null {
    return (this.db.prepare(
      'SELECT * FROM source_jobs WHERE job_id = ?',
    ).get(jobId) as SourceJobRow | undefined) ?? null
  }

  private project(row: SourceJobRow): SourceJob {
    return {
      jobId: row.job_id,
      sourceId: row.source_id,
      sourceVersionId: row.source_version_id,
      operation: row.operation,
      state: row.state,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      checkpoint: row.checkpoint,
      cancelRequestedAt: row.cancel_requested_at,
      outcomeCode: row.outcome_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      terminalAt: row.terminal_at,
    }
  }

  private setInspectionState(
    sourceId: string,
    sourceVersionId: string,
    state: 'not_started' | 'queued' | 'inspecting' | 'complete' | 'partial' | 'failed',
    now: number,
  ): void {
    const version = this.db.prepare(`
      UPDATE source_versions SET inspection_state = ?
      WHERE source_version_id = ? AND source_id = ?
    `).run(state, sourceVersionId, sourceId)
    if (version.changes !== 1) throw new Error('Source inspection target changed')
    this.db.prepare(`
      UPDATE runtime_sources SET inspection_state = ?, updated_at = ?
      WHERE source_id = ? AND current_version_id = ? AND deletion_state = 'active'
    `).run(state, now, sourceId, sourceVersionId)
  }
}

function isTerminal(state: SourceJobState): boolean {
  return state === 'succeeded' || state === 'partial' || state === 'failed' ||
    state === 'cancelled'
}
