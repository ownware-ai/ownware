import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { SourceQuotaPolicy } from './source-quota-policy.js'

export const SOURCE_JOB_MAX_ATTEMPTS = 3 as const
export const SOURCE_JOB_LEASE_MS = 30_000 as const
export const SOURCE_INSPECTION_IMPLEMENTATION = 'inspect_format.v1' as const
export const SOURCE_TEXT_PREPARATION_IMPLEMENTATION = 'text_extraction.v1' as const

export type SourceJobOperation = 'inspect_format' | 'extract_text'
export type SourceJobImplementation =
  | typeof SOURCE_INSPECTION_IMPLEMENTATION
  | typeof SOURCE_TEXT_PREPARATION_IMPLEMENTATION
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
  readonly implementationVersion: SourceJobImplementation
  readonly resourceId: string | null
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

export interface InspectionSourceJob extends Omit<
  SourceJob,
  'operation' | 'implementationVersion' | 'resourceId'
> {
  readonly operation: 'inspect_format'
  readonly implementationVersion: typeof SOURCE_INSPECTION_IMPLEMENTATION
  readonly resourceId: null
}

export interface EnqueueSourceJobInput {
  readonly workspaceId: string
  readonly profileId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly operation: 'inspect_format'
}

export interface EnqueueSourcePreparationInput {
  readonly workspaceId: string
  readonly profileId: string
  readonly sourceId: string
  readonly sourceVersionId: string
}

export interface SourceJobClaim {
  readonly jobId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly operation: SourceJobOperation
  readonly attempt: number
  readonly maxAttempts: typeof SOURCE_JOB_MAX_ATTEMPTS
  readonly checkpoint: number
  readonly implementationVersion: SourceJobImplementation
  readonly resourceId: string | null
  readonly claimToken: string
  readonly leaseExpiresAt: number
}

export interface ClaimedSourceInspectionTarget {
  readonly objectKey: string
  readonly expectedByteCount: number
  readonly expectedChecksum: string
  readonly verifiedMediaType: 'text/plain' | 'application/pdf'
}

export interface SourceDerivedResource {
  readonly resourceId: string
  readonly jobId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly kind: 'text_extraction'
  readonly operation: 'extract_text'
  readonly implementationVersion: typeof SOURCE_TEXT_PREPARATION_IMPLEMENTATION
  readonly sourceRevision: number
  readonly sourceChecksum: string
  readonly resourceChecksum: string
  readonly byteStart: 0
  readonly byteEnd: number
  readonly byteCount: number
  readonly classification: 'public' | 'internal' | 'confidential' | 'restricted'
  readonly authority: 'source_of_record' | 'supporting_reference' | 'example'
  readonly audiencePolicyRef: string
  readonly sensitivityPolicyRef: string
  readonly purposePolicyRef: string
  readonly retentionPolicyRef: string
  readonly freshnessPolicyRef: string
  readonly coverage: 'complete'
  readonly freshness: 'current' | 'stale'
  readonly createdAt: number
  readonly staleAt: number | null
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
  readonly implementation_version: SourceJobImplementation
  readonly source_revision: number
  readonly resource_id: string | null
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

export class SourcePreparationNotReadyError extends Error {
  constructor(readonly code:
    | 'source_version_not_current'
    | 'source_inspection_incomplete'
    | 'source_media_unsupported'
    | 'source_authority_excluded') {
    super(code)
    this.name = 'SourcePreparationNotReadyError'
  }
}

export class SourceJobStore {
  constructor(
    private readonly db: Database.Database,
    private readonly quota: SourceQuotaPolicy = new SourceQuotaPolicy(db),
  ) {}

  enqueue(input: EnqueueSourceJobInput, now: number = Date.now()): InspectionSourceJob {
    return this.db.transaction((): InspectionSourceJob => {
      const target = this.db.prepare(`
        SELECT v.source_version_id, s.revision FROM source_versions v
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

      const existing = this.getByVersion(
        input.sourceVersionId, input.operation, SOURCE_INSPECTION_IMPLEMENTATION,
      )
      if (existing) return this.project(existing) as InspectionSourceJob
      this.quota.assertCanGrow(input, { nonterminalJobs: 1 })

      const jobId = randomUUID()
      this.db.prepare(`
        INSERT INTO source_jobs (
          job_id, workspace_id, profile_id, source_id, source_version_id,
          operation, implementation_version, source_revision, resource_id,
          state, attempt, max_attempts, checkpoint,
          claim_token, claimed_by, lease_expires_at, retry_after,
          cancel_requested_at, outcome_code, created_at, updated_at, terminal_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', 0, ?, 0,
          NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
        )
      `).run(
        jobId,
        input.workspaceId,
        input.profileId,
        input.sourceId,
        input.sourceVersionId,
        input.operation,
        SOURCE_INSPECTION_IMPLEMENTATION,
        (target as { revision: number }).revision,
        SOURCE_JOB_MAX_ATTEMPTS,
        now,
        now,
      )
      this.setInspectionState(input.sourceId, input.sourceVersionId, 'queued', now)
      return this.project(this.getRow(jobId)!) as InspectionSourceJob
    }).immediate()
  }

  enqueuePreparation(
    input: EnqueueSourcePreparationInput,
    now: number = Date.now(),
  ): SourceJob {
    return this.db.transaction((): SourceJob => {
      const target = this.db.prepare(`
        SELECT v.verified_media_type, v.inspection_state,
          s.revision, s.current_version_id, s.authority
        FROM source_versions v
        JOIN runtime_sources s ON s.source_id = v.source_id
        WHERE v.source_version_id = ? AND v.source_id = ?
          AND s.workspace_id = ? AND s.profile_id = ?
          AND s.deletion_state = 'active'
      `).get(
        input.sourceVersionId,
        input.sourceId,
        input.workspaceId,
        input.profileId,
      ) as {
        verified_media_type: 'text/plain' | 'application/pdf'
        inspection_state: string
        revision: number
        current_version_id: string | null
        authority: string
      } | undefined
      if (!target) throw new SourceJobTargetNotFoundError()
      if (target.current_version_id !== input.sourceVersionId) {
        throw new SourcePreparationNotReadyError('source_version_not_current')
      }
      if (target.inspection_state !== 'complete') {
        throw new SourcePreparationNotReadyError('source_inspection_incomplete')
      }
      if (target.verified_media_type !== 'text/plain') {
        throw new SourcePreparationNotReadyError('source_media_unsupported')
      }
      if (target.authority === 'excluded') {
        throw new SourcePreparationNotReadyError('source_authority_excluded')
      }

      const existing = this.getByVersion(
        input.sourceVersionId,
        'extract_text',
        SOURCE_TEXT_PREPARATION_IMPLEMENTATION,
      )
      if (existing) return this.project(existing)
      this.quota.assertCanGrow(input, {
        nonterminalJobs: 1,
        derivedResources: 1,
      })

      const jobId = randomUUID()
      const resourceId = randomUUID()
      this.db.prepare(`
        INSERT INTO source_jobs (
          job_id, workspace_id, profile_id, source_id, source_version_id,
          operation, implementation_version, source_revision, resource_id,
          state, attempt, max_attempts, checkpoint,
          claim_token, claimed_by, lease_expires_at, retry_after,
          cancel_requested_at, outcome_code, created_at, updated_at, terminal_at
        ) VALUES (
          ?, ?, ?, ?, ?, 'extract_text', ?, ?, ?, 'queued', 0, ?, 0,
          NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
        )
      `).run(
        jobId,
        input.workspaceId,
        input.profileId,
        input.sourceId,
        input.sourceVersionId,
        SOURCE_TEXT_PREPARATION_IMPLEMENTATION,
        target.revision,
        resourceId,
        SOURCE_JOB_MAX_ATTEMPTS,
        now,
        now,
      )
      this.setPreparationState(input.sourceId, input.sourceVersionId, 'queued', now)
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
        AND operation IN ('inspect_format', 'extract_text')
    `).get(jobId, workspaceId, profileId) as SourceJobRow | undefined
    return row ? this.project(row) : null
  }

  hasTargetScoped(
    sourceId: string,
    sourceVersionId: string,
    workspaceId: string,
    profileId: string,
  ): boolean {
    return this.db.prepare(`
      SELECT 1 FROM source_versions v
      JOIN runtime_sources s ON s.source_id = v.source_id
      WHERE v.source_version_id = ? AND v.source_id = ?
        AND s.workspace_id = ? AND s.profile_id = ?
        AND s.deletion_state = 'active'
    `).get(sourceVersionId, sourceId, workspaceId, profileId) !== undefined
  }

  claimNext(workerId: string, now: number = Date.now()): SourceJobClaim | null {
    return this.db.transaction((): SourceJobClaim | null => {
      const candidate = this.db.prepare(`
        SELECT job_id FROM source_jobs
        WHERE attempt < max_attempts
          AND operation IN ('inspect_format', 'extract_text')
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
          AND operation IN ('inspect_format', 'extract_text')
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
      } else {
        this.setPreparationState(row.source_id, row.source_version_id, 'preparing', now)
      }
      return {
        jobId: row.job_id,
        sourceId: row.source_id,
        sourceVersionId: row.source_version_id,
        operation: row.operation,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        checkpoint: row.checkpoint,
        implementationVersion: row.implementation_version,
        resourceId: row.resource_id,
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

  getClaimedPreparationTarget(
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
      WHERE j.job_id = ? AND j.operation = 'extract_text'
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
        SELECT source_id, source_version_id, operation FROM source_jobs
        WHERE state = 'cancel_requested'
          AND operation IN ('inspect_format', 'extract_text')
          AND (claim_token IS NULL OR lease_expires_at < ?)
      `).all(now) as Array<{
        source_id: string; source_version_id: string; operation: SourceJobOperation
      }>
      const requeueTargets = this.db.prepare(`
        SELECT source_id, source_version_id, operation FROM source_jobs
        WHERE state = 'running' AND lease_expires_at < ?
          AND operation IN ('inspect_format', 'extract_text')
          AND attempt < max_attempts
      `).all(now) as Array<{
        source_id: string; source_version_id: string; operation: SourceJobOperation
      }>
      const failureTargets = this.db.prepare(`
        SELECT source_id, source_version_id, operation FROM source_jobs
        WHERE state = 'running' AND lease_expires_at < ?
          AND operation IN ('inspect_format', 'extract_text')
          AND attempt >= max_attempts
      `).all(now) as Array<{
        source_id: string; source_version_id: string; operation: SourceJobOperation
      }>
      const cancelled = this.db.prepare(`
        UPDATE source_jobs
        SET state = 'cancelled', claim_token = NULL, claimed_by = NULL,
          lease_expires_at = NULL, retry_after = NULL,
          outcome_code = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE state = 'cancel_requested'
          AND operation IN ('inspect_format', 'extract_text')
          AND (claim_token IS NULL OR lease_expires_at < ?)
      `).run(now, now, now).changes
      const requeued = this.db.prepare(`
        UPDATE source_jobs
        SET state = 'queued', claim_token = NULL, claimed_by = NULL,
          lease_expires_at = NULL, retry_after = NULL, updated_at = ?
        WHERE state = 'running' AND lease_expires_at < ?
          AND operation IN ('inspect_format', 'extract_text')
          AND attempt < max_attempts
      `).run(now, now).changes
      const failed = this.db.prepare(`
        UPDATE source_jobs
        SET state = 'failed', claim_token = NULL, claimed_by = NULL,
          lease_expires_at = NULL, retry_after = NULL,
          outcome_code = 'attempts_exhausted', updated_at = ?, terminal_at = ?
        WHERE state = 'running' AND lease_expires_at < ?
          AND operation IN ('inspect_format', 'extract_text')
          AND attempt >= max_attempts
      `).run(now, now, now).changes
      for (const target of cancellationTargets) {
        this.resetOperationState(target, now)
      }
      for (const target of requeueTargets) {
        this.queueOperationState(target, now)
      }
      for (const target of failureTargets) {
        this.failOperationState(target, now)
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
          AND operation IN ('inspect_format', 'extract_text')
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

  confirmNextUnclaimedCancellation(now: number = Date.now()): boolean {
    const candidate = this.db.prepare(`
      SELECT job_id FROM source_jobs
      WHERE state = 'cancel_requested' AND claim_token IS NULL
        AND operation IN ('inspect_format', 'extract_text')
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
      } else {
        this.setPreparationState(
          row.source_id, row.source_version_id, 'not_requested', now,
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
      } else if (deferred.changes === 1) {
        this.setPreparationState(
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

  finishPreparation(
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
      if (!row || row.state !== 'running' || row.operation !== 'extract_text') {
        return 'state_conflict'
      }
      if (row.claim_token !== claimToken) return 'stale_claim'
      if (row.lease_expires_at === null || row.lease_expires_at < now) {
        return 'lease_expired'
      }
      if (outcome === 'succeeded' && row.checkpoint !== 3) {
        return 'checkpoint_incomplete'
      }

      if (outcome === 'succeeded') {
        if (!row.resource_id) throw new Error('Source preparation has no resource identity')
        const target = this.db.prepare(`
          SELECT v.checksum, v.byte_count,
            s.revision, s.current_version_id, s.classification, s.authority,
            s.audience_policy_ref, s.sensitivity_policy_ref,
            s.purpose_policy_ref, s.retention_policy_ref, s.freshness_policy_ref
          FROM source_versions v
          JOIN runtime_sources s ON s.source_id = v.source_id
          WHERE v.source_version_id = ? AND v.source_id = ?
        `).get(row.source_version_id, row.source_id) as {
          checksum: string
          byte_count: number
          revision: number
          current_version_id: string | null
          classification: SourceDerivedResource['classification']
          authority: SourceDerivedResource['authority'] | 'excluded'
          audience_policy_ref: string
          sensitivity_policy_ref: string
          purpose_policy_ref: string
          retention_policy_ref: string
          freshness_policy_ref: string
        } | undefined
        if (!target || target.authority === 'excluded') {
          throw new Error('Source preparation target changed')
        }
        const freshness = target.current_version_id === row.source_version_id
          ? 'current' : 'stale'
        this.db.prepare(`
          INSERT INTO source_derived_resources (
            resource_id, job_id, workspace_id, profile_id, source_id,
            source_version_id, kind, operation, implementation_version,
            source_revision, source_checksum, resource_checksum,
            byte_start, byte_end, byte_count, classification, authority,
            audience_policy_ref, sensitivity_policy_ref, purpose_policy_ref,
            retention_policy_ref, freshness_policy_ref, coverage, freshness,
            created_at, stale_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, 'text_extraction', 'extract_text', ?, ?, ?, ?,
            0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?
          )
        `).run(
          row.resource_id,
          row.job_id,
          row.workspace_id,
          row.profile_id,
          row.source_id,
          row.source_version_id,
          row.implementation_version,
          row.source_revision,
          target.checksum,
          target.checksum,
          target.byte_count,
          target.byte_count,
          target.classification,
          target.authority,
          target.audience_policy_ref,
          target.sensitivity_policy_ref,
          target.purpose_policy_ref,
          target.retention_policy_ref,
          target.freshness_policy_ref,
          freshness,
          now,
          freshness === 'stale' ? now : null,
        )
      }

      const preparationState = outcome === 'succeeded'
        ? 'ready' : outcome === 'partial' ? 'partial' : 'failed'
      this.setPreparationState(
        row.source_id,
        row.source_version_id,
        preparationState,
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
      if (finished.changes !== 1) throw new Error('Source preparation claim changed')
      return 'finished'
    }).immediate()
  }

  getResourceScoped(
    resourceId: string,
    workspaceId: string,
    profileId: string,
  ): SourceDerivedResource | null {
    const row = this.db.prepare(`
      SELECT * FROM source_derived_resources
      WHERE resource_id = ? AND workspace_id = ? AND profile_id = ?
    `).get(resourceId, workspaceId, profileId) as Record<string, unknown> | undefined
    return row ? projectResource(row) : null
  }

  private getByVersion(
    sourceVersionId: string,
    operation: SourceJobOperation,
    implementationVersion: string,
  ): SourceJobRow | null {
    return (this.db.prepare(`
      SELECT * FROM source_jobs
      WHERE source_version_id = ? AND operation = ? AND implementation_version = ?
    `).get(
      sourceVersionId, operation, implementationVersion,
    ) as SourceJobRow | undefined) ?? null
  }

  private getRow(jobId: string): SourceJobRow | null {
    return (this.db.prepare(
      'SELECT * FROM source_jobs WHERE job_id = ?',
    ).get(jobId) as SourceJobRow | undefined) ?? null
  }

  private project(row: SourceJobRow): SourceJob {
    const resourcePublished = row.resource_id !== null && this.db.prepare(`
      SELECT 1 FROM source_derived_resources
      WHERE resource_id = ? AND job_id = ?
    `).get(row.resource_id, row.job_id) !== undefined
    return {
      jobId: row.job_id,
      sourceId: row.source_id,
      sourceVersionId: row.source_version_id,
      operation: row.operation,
      implementationVersion: row.implementation_version,
      resourceId: resourcePublished ? row.resource_id : null,
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

  private setPreparationState(
    sourceId: string,
    sourceVersionId: string,
    state: 'not_requested' | 'queued' | 'preparing' | 'ready' | 'partial' | 'failed',
    now: number,
  ): void {
    const version = this.db.prepare(`
      UPDATE source_versions SET preparation_state = ?
      WHERE source_version_id = ? AND source_id = ?
    `).run(state, sourceVersionId, sourceId)
    if (version.changes !== 1) throw new Error('Source preparation target changed')
    this.db.prepare(`
      UPDATE runtime_sources SET preparation_state = ?, updated_at = ?
      WHERE source_id = ? AND current_version_id = ? AND deletion_state = 'active'
    `).run(state, now, sourceId, sourceVersionId)
  }

  private resetOperationState(
    target: { source_id: string; source_version_id: string; operation: SourceJobOperation },
    now: number,
  ): void {
    if (target.operation === 'inspect_format') {
      this.setInspectionState(target.source_id, target.source_version_id, 'not_started', now)
    } else {
      this.setPreparationState(target.source_id, target.source_version_id, 'not_requested', now)
    }
  }

  private queueOperationState(
    target: { source_id: string; source_version_id: string; operation: SourceJobOperation },
    now: number,
  ): void {
    if (target.operation === 'inspect_format') {
      this.setInspectionState(target.source_id, target.source_version_id, 'queued', now)
    } else {
      this.setPreparationState(target.source_id, target.source_version_id, 'queued', now)
    }
  }

  private failOperationState(
    target: { source_id: string; source_version_id: string; operation: SourceJobOperation },
    now: number,
  ): void {
    if (target.operation === 'inspect_format') {
      this.setInspectionState(target.source_id, target.source_version_id, 'failed', now)
    } else {
      this.setPreparationState(target.source_id, target.source_version_id, 'failed', now)
    }
  }
}

function projectResource(row: Record<string, unknown>): SourceDerivedResource {
  return {
    resourceId: row['resource_id'] as string,
    jobId: row['job_id'] as string,
    sourceId: row['source_id'] as string,
    sourceVersionId: row['source_version_id'] as string,
    kind: 'text_extraction',
    operation: 'extract_text',
    implementationVersion: SOURCE_TEXT_PREPARATION_IMPLEMENTATION,
    sourceRevision: row['source_revision'] as number,
    sourceChecksum: row['source_checksum'] as string,
    resourceChecksum: row['resource_checksum'] as string,
    byteStart: 0,
    byteEnd: row['byte_end'] as number,
    byteCount: row['byte_count'] as number,
    classification: row['classification'] as SourceDerivedResource['classification'],
    authority: row['authority'] as SourceDerivedResource['authority'],
    audiencePolicyRef: row['audience_policy_ref'] as string,
    sensitivityPolicyRef: row['sensitivity_policy_ref'] as string,
    purposePolicyRef: row['purpose_policy_ref'] as string,
    retentionPolicyRef: row['retention_policy_ref'] as string,
    freshnessPolicyRef: row['freshness_policy_ref'] as string,
    coverage: 'complete',
    freshness: row['freshness'] as SourceDerivedResource['freshness'],
    createdAt: row['created_at'] as number,
    staleAt: row['stale_at'] as number | null,
  }
}

function isTerminal(state: SourceJobState): boolean {
  return state === 'succeeded' || state === 'partial' || state === 'failed' ||
    state === 'cancelled'
}
