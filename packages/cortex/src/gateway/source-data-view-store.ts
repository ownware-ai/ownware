import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  CSV_DATA_VIEW_IMPLEMENTATION,
  CSV_DATA_VIEW_MAX_CELL_BYTES,
  CSV_DATA_VIEW_MAX_FIELDS,
  CSV_DATA_VIEW_MAX_ROWS,
  csvDataViewOrdinalId,
  type CsvDataViewField,
} from './csv-data-view.js'
import type {
  CsvDataViewArtifactManifest,
  PreparedCsvDataViewArtifact,
} from './source-byte-store.js'
import { CSV_DATA_VIEW_ARTIFACT_MAX_BYTES } from './source-byte-store.js'
import { SourceQuotaPolicy } from './source-quota-policy.js'

export const SOURCE_DATA_VIEW_JOB_MAX_ATTEMPTS = 3 as const
export const SOURCE_DATA_VIEW_JOB_LEASE_MS = 30_000 as const

export type SourceDataViewJobState =
  | 'queued'
  | 'running'
  | 'waiting_for_resource'
  | 'cancel_requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface SourceDataViewJob {
  readonly jobId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly operation: 'prepare_data_view'
  readonly implementationVersion: typeof CSV_DATA_VIEW_IMPLEMENTATION
  readonly resourceId: null
  readonly dataViewId: string | null
  readonly state: SourceDataViewJobState
  readonly attempt: number
  readonly maxAttempts: typeof SOURCE_DATA_VIEW_JOB_MAX_ATTEMPTS
  readonly checkpoint: number
  readonly cancelRequestedAt: number | null
  readonly outcomeCode: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly terminalAt: number | null
}

export interface SourceDataViewJobClaim {
  readonly jobId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly dataViewId: string
  readonly implementationVersion: typeof CSV_DATA_VIEW_IMPLEMENTATION
  readonly attempt: number
  readonly maxAttempts: typeof SOURCE_DATA_VIEW_JOB_MAX_ATTEMPTS
  readonly checkpoint: number
  readonly claimToken: string
  readonly leaseExpiresAt: number
}

export interface ClaimedSourceDataViewTarget {
  readonly objectKey: string
  readonly expectedByteCount: number
  readonly expectedChecksum: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly dataViewId: string
}

export interface SourceDataViewManifest {
  readonly dataViewId: string
  readonly jobId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly implementationVersion: typeof CSV_DATA_VIEW_IMPLEMENTATION
  readonly sourceRevision: number
  readonly sourceChecksum: string
  readonly artifactChecksum: string
  readonly artifactByteCount: number
  readonly fieldCount: number
  readonly rowCount: number
  readonly fields: readonly CsvDataViewField[]
  readonly classification: 'public' | 'internal' | 'confidential' | 'restricted'
  readonly authority: 'source_of_record' | 'supporting_reference' | 'example'
  readonly audiencePolicyRef: string
  readonly sensitivityPolicyRef: string
  readonly purposePolicyRef: string
  readonly retentionPolicyRef: string
  readonly freshnessPolicyRef: string
  readonly freshness: 'current' | 'stale'
  readonly createdAt: number
  readonly staleAt: number | null
}

export interface ProtectedSourceDataViewTarget {
  readonly workspaceId: string
  readonly profileId: string
  readonly manifest: SourceDataViewManifest & { readonly freshness: 'current' }
  /** Runtime-private locator. Never include this value in a public projection. */
  readonly privateObjectKey: string
}

export interface EnqueueSourceDataViewInput {
  readonly workspaceId: string
  readonly profileId: string
  readonly sourceId: string
  readonly sourceVersionId: string
}

export type SourceDataViewCheckpointResult =
  | 'advanced'
  | 'stale_claim'
  | 'lease_expired'
  | 'checkpoint_conflict'

export type SourceDataViewFinishResult =
  | 'finished'
  | 'stale_claim'
  | 'lease_expired'
  | 'state_conflict'
  | 'checkpoint_incomplete'

export type SourceDataViewDeferResult =
  | 'deferred'
  | 'stale_claim'
  | 'lease_expired'

export type SourceDataViewCancellationResult =
  | 'cancelled'
  | 'state_conflict'
  | 'stale_claim'
  | 'lease_expired'

export interface SourceDataViewRecoveryResult {
  readonly requeued: number
  readonly failed: number
}

export class SourceDataViewUnavailableError extends Error {
  constructor(readonly code:
    | 'source_version_not_found'
    | 'source_version_not_current'
    | 'source_inspection_incomplete'
    | 'source_data_view_kind_unsupported'
    | 'source_media_unsupported'
    | 'source_authority_excluded'
    | 'source_access_unavailable'
    | 'source_conflict_confirmed') {
    super(code)
    this.name = 'SourceDataViewUnavailableError'
  }
}

interface JobRow {
  readonly job_id: string
  readonly data_view_id: string
  readonly workspace_id: string
  readonly profile_id: string
  readonly source_id: string
  readonly source_version_id: string
  readonly implementation_version: typeof CSV_DATA_VIEW_IMPLEMENTATION
  readonly source_revision: number
  readonly state: SourceDataViewJobState
  readonly attempt: number
  readonly max_attempts: typeof SOURCE_DATA_VIEW_JOB_MAX_ATTEMPTS
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

export class SourceDataViewStore {
  constructor(
    private readonly db: Database.Database,
    private readonly quota: SourceQuotaPolicy = new SourceQuotaPolicy(db),
  ) {}

  enqueue(input: EnqueueSourceDataViewInput, now: number = Date.now()): SourceDataViewJob {
    return this.db.transaction((): SourceDataViewJob => {
      const target = this.db.prepare(`
        SELECT s.revision, s.current_version_id, s.kind, s.registration_state,
          s.authority, s.access_state, s.conflict_state, s.deletion_state,
          v.verified_media_type, v.inspection_state
        FROM source_versions v
        JOIN runtime_sources s ON s.source_id = v.source_id
        WHERE v.source_version_id = ? AND v.source_id = ?
          AND s.workspace_id = ? AND s.profile_id = ?
      `).get(
        input.sourceVersionId,
        input.sourceId,
        input.workspaceId,
        input.profileId,
      ) as {
        revision: number
        current_version_id: string | null
        kind: string
        registration_state: string
        authority: string
        access_state: string
        conflict_state: string
        deletion_state: string
        verified_media_type: string
        inspection_state: string
      } | undefined
      if (!target || target.deletion_state !== 'active') {
        throw new SourceDataViewUnavailableError('source_version_not_found')
      }
      if (target.current_version_id !== input.sourceVersionId) {
        throw new SourceDataViewUnavailableError('source_version_not_current')
      }
      if (target.kind !== 'structured_export' || target.registration_state !== 'registered') {
        throw new SourceDataViewUnavailableError('source_data_view_kind_unsupported')
      }
      if (target.inspection_state !== 'complete') {
        throw new SourceDataViewUnavailableError('source_inspection_incomplete')
      }
      if (target.verified_media_type !== 'text/plain') {
        throw new SourceDataViewUnavailableError('source_media_unsupported')
      }
      if (target.authority === 'excluded') {
        throw new SourceDataViewUnavailableError('source_authority_excluded')
      }
      if (target.access_state !== 'available') {
        throw new SourceDataViewUnavailableError('source_access_unavailable')
      }
      if (target.conflict_state === 'confirmed') {
        throw new SourceDataViewUnavailableError('source_conflict_confirmed')
      }

      const existing = this.db.prepare(`
        SELECT * FROM source_data_view_jobs
        WHERE source_version_id = ? AND implementation_version = ?
      `).get(
        input.sourceVersionId,
        CSV_DATA_VIEW_IMPLEMENTATION,
      ) as JobRow | undefined
      if (existing) return this.projectJob(existing)

      this.quota.assertCanGrow(input, { nonterminalJobs: 1, derivedResources: 1 })
      const jobId = randomUUID()
      const dataViewId = randomUUID()
      this.db.prepare(`
        INSERT INTO source_data_view_jobs (
          job_id, data_view_id, workspace_id, profile_id, source_id,
          source_version_id, implementation_version, source_revision,
          state, attempt, max_attempts, checkpoint, claim_token, claimed_by,
          lease_expires_at, retry_after, cancel_requested_at, outcome_code,
          created_at, updated_at, terminal_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, 0, NULL, NULL,
          NULL, NULL, NULL, NULL, ?, ?, NULL
        )
      `).run(
        jobId,
        dataViewId,
        input.workspaceId,
        input.profileId,
        input.sourceId,
        input.sourceVersionId,
        CSV_DATA_VIEW_IMPLEMENTATION,
        target.revision,
        SOURCE_DATA_VIEW_JOB_MAX_ATTEMPTS,
        now,
        now,
      )
      this.setPreparationState(input.sourceId, input.sourceVersionId, 'queued', now)
      return this.projectJob(this.getJobRow(jobId)!)
    }).immediate()
  }

  getJobScoped(jobId: string, workspaceId: string, profileId: string): SourceDataViewJob | null {
    const row = this.db.prepare(`
      SELECT * FROM source_data_view_jobs
      WHERE job_id = ? AND workspace_id = ? AND profile_id = ?
    `).get(jobId, workspaceId, profileId) as JobRow | undefined
    return row ? this.projectJob(row) : null
  }

  requestCancel(
    jobId: string,
    workspaceId: string,
    profileId: string,
    now: number = Date.now(),
  ): 'requested' | 'already_requested' | 'terminal' | 'missing' {
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT state FROM source_data_view_jobs
        WHERE job_id = ? AND workspace_id = ? AND profile_id = ?
      `).get(jobId, workspaceId, profileId) as { state: SourceDataViewJobState } | undefined
      if (!row) return 'missing'
      if (row.state === 'cancel_requested') return 'already_requested'
      if (['succeeded', 'failed', 'cancelled'].includes(row.state)) return 'terminal'
      const requested = this.db.prepare(`
        UPDATE source_data_view_jobs
        SET state = 'cancel_requested', cancel_requested_at = ?,
          retry_after = NULL, updated_at = ?
        WHERE job_id = ? AND state IN ('queued', 'running', 'waiting_for_resource')
      `).run(now, now, jobId)
      return requested.changes === 1 ? 'requested' : 'already_requested'
    }).immediate()
  }

  claimNext(workerId: string, now: number = Date.now()): SourceDataViewJobClaim | null {
    return this.db.transaction((): SourceDataViewJobClaim | null => {
      const candidate = this.db.prepare(`
        SELECT job_id FROM source_data_view_jobs
        WHERE attempt < max_attempts AND (
          state = 'queued'
          OR (state = 'waiting_for_resource' AND retry_after <= ?)
        )
        ORDER BY created_at ASC, job_id ASC LIMIT 1
      `).get(now) as { job_id: string } | undefined
      if (!candidate) return null
      const claimToken = randomUUID()
      const leaseExpiresAt = now + SOURCE_DATA_VIEW_JOB_LEASE_MS
      const updated = this.db.prepare(`
        UPDATE source_data_view_jobs
        SET state = 'running', attempt = attempt + 1,
          claim_token = ?, claimed_by = ?, lease_expires_at = ?,
          retry_after = NULL, updated_at = ?
        WHERE job_id = ? AND attempt < max_attempts AND (
          state = 'queued'
          OR (state = 'waiting_for_resource' AND retry_after <= ?)
        )
      `).run(
        claimToken, workerId, leaseExpiresAt, now, candidate.job_id, now,
      )
      if (updated.changes !== 1) return null
      const row = this.getJobRow(candidate.job_id)!
      this.setPreparationState(row.source_id, row.source_version_id, 'preparing', now)
      return {
        jobId: row.job_id,
        sourceId: row.source_id,
        sourceVersionId: row.source_version_id,
        dataViewId: row.data_view_id,
        implementationVersion: CSV_DATA_VIEW_IMPLEMENTATION,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        checkpoint: row.checkpoint,
        claimToken,
        leaseExpiresAt,
      }
    }).immediate()
  }

  claimNextCancellation(
    workerId: string,
    now: number = Date.now(),
  ): SourceDataViewJobClaim | null {
    if (!/^[a-z0-9._-]{1,64}$/.test(workerId)) {
      throw new TypeError('Source Data View worker identity is invalid')
    }
    return this.db.transaction((): SourceDataViewJobClaim | null => {
      const candidate = this.db.prepare(`
        SELECT job_id FROM source_data_view_jobs
        WHERE state = 'cancel_requested'
          AND (claim_token IS NULL OR lease_expires_at < ?)
        ORDER BY updated_at ASC, job_id ASC LIMIT 1
      `).get(now) as { job_id: string } | undefined
      if (!candidate) return null
      const claimToken = randomUUID()
      const leaseExpiresAt = now + SOURCE_DATA_VIEW_JOB_LEASE_MS
      const claimed = this.db.prepare(`
        UPDATE source_data_view_jobs
        SET claim_token = ?, claimed_by = ?, lease_expires_at = ?, updated_at = ?
        WHERE job_id = ? AND state = 'cancel_requested'
          AND (claim_token IS NULL OR lease_expires_at < ?)
      `).run(
        claimToken, workerId, leaseExpiresAt, now, candidate.job_id, now,
      )
      if (claimed.changes !== 1) return null
      const row = this.getJobRow(candidate.job_id)!
      return {
        jobId: row.job_id,
        sourceId: row.source_id,
        sourceVersionId: row.source_version_id,
        dataViewId: row.data_view_id,
        implementationVersion: CSV_DATA_VIEW_IMPLEMENTATION,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        checkpoint: row.checkpoint,
        claimToken,
        leaseExpiresAt,
      }
    }).immediate()
  }

  getClaimedTarget(
    jobId: string,
    claimToken: string,
    now: number = Date.now(),
  ): ClaimedSourceDataViewTarget | null {
    const row = this.db.prepare(`
      SELECT j.source_id, j.source_version_id, j.data_view_id,
        v.object_key, v.byte_count, v.checksum
      FROM source_data_view_jobs j
      JOIN source_versions v
        ON v.source_version_id = j.source_version_id AND v.source_id = j.source_id
      WHERE j.job_id = ? AND j.claim_token = ? AND j.state = 'running'
        AND j.lease_expires_at >= ?
    `).get(jobId, claimToken, now) as {
      source_id: string
      source_version_id: string
      data_view_id: string
      object_key: string
      byte_count: number
      checksum: string
    } | undefined
    return row ? {
      objectKey: row.object_key,
      expectedByteCount: row.byte_count,
      expectedChecksum: row.checksum,
      sourceId: row.source_id,
      sourceVersionId: row.source_version_id,
      dataViewId: row.data_view_id,
    } : null
  }

  renewClaim(
    jobId: string,
    claimToken: string,
    now: number = Date.now(),
  ): boolean {
    return this.db.prepare(`
      UPDATE source_data_view_jobs
      SET lease_expires_at = ?, updated_at = ?
      WHERE job_id = ? AND claim_token = ?
        AND state IN ('running', 'cancel_requested')
        AND lease_expires_at >= ?
    `).run(
      now + SOURCE_DATA_VIEW_JOB_LEASE_MS, now, jobId, claimToken, now,
    ).changes === 1
  }

  advanceCheckpoint(
    jobId: string,
    claimToken: string,
    expected: number,
    next: number,
    now: number = Date.now(),
  ): SourceDataViewCheckpointResult {
    const row = this.getJobRow(jobId)
    if (!row || row.claim_token !== claimToken || row.state !== 'running') return 'stale_claim'
    if (row.lease_expires_at === null || row.lease_expires_at < now) return 'lease_expired'
    if (row.checkpoint !== expected || next !== expected + 1 || next > 3) {
      return 'checkpoint_conflict'
    }
    const updated = this.db.prepare(`
      UPDATE source_data_view_jobs SET checkpoint = ?, updated_at = ?
      WHERE job_id = ? AND claim_token = ? AND state = 'running'
        AND checkpoint = ? AND lease_expires_at >= ?
    `).run(next, now, jobId, claimToken, expected, now)
    return updated.changes === 1 ? 'advanced' : 'stale_claim'
  }

  publish(
    jobId: string,
    claimToken: string,
    artifact: PreparedCsvDataViewArtifact,
    now: number = Date.now(),
  ): SourceDataViewFinishResult {
    if (!validArtifactShape(artifact)) return 'state_conflict'
    return this.db.transaction((): SourceDataViewFinishResult => {
      const row = this.db.prepare(`
        SELECT j.*, v.checksum AS version_checksum,
          s.revision AS current_revision, s.current_version_id,
          s.classification, s.authority, s.audience_policy_ref,
          s.sensitivity_policy_ref, s.purpose_policy_ref,
          s.retention_policy_ref, s.freshness_policy_ref, s.deletion_state
        FROM source_data_view_jobs j
        JOIN source_versions v
          ON v.source_version_id = j.source_version_id AND v.source_id = j.source_id
        JOIN runtime_sources s ON s.source_id = j.source_id
        WHERE j.job_id = ?
      `).get(jobId) as (JobRow & {
        version_checksum: string
        current_revision: number
        current_version_id: string | null
        classification: SourceDataViewManifest['classification']
        authority: SourceDataViewManifest['authority'] | 'excluded'
        audience_policy_ref: string
        sensitivity_policy_ref: string
        purpose_policy_ref: string
        retention_policy_ref: string
        freshness_policy_ref: string
        deletion_state: string
      }) | undefined
      if (!row || row.claim_token !== claimToken || row.state !== 'running') {
        return 'stale_claim'
      }
      if (row.lease_expires_at === null || row.lease_expires_at < now) return 'lease_expired'
      if (row.checkpoint !== 3) return 'checkpoint_incomplete'
      if (row.authority === 'excluded' ||
          row.deletion_state !== 'active' ||
          !artifactMatches(row, artifact.manifest, artifact.privateObjectKey)) {
        return 'state_conflict'
      }
      const isCurrent = row.current_version_id === row.source_version_id &&
        row.current_revision === row.source_revision
      const freshness = isCurrent ? 'current' : 'stale'
      this.db.prepare(`
        INSERT INTO source_data_views (
          data_view_id, job_id, workspace_id, profile_id, source_id,
          source_version_id, implementation_version, source_revision,
          source_checksum, artifact_checksum, artifact_byte_count,
          private_object_key, field_count, row_count, fields_json,
          classification, authority, audience_policy_ref,
          sensitivity_policy_ref, purpose_policy_ref, retention_policy_ref,
          freshness_policy_ref, freshness, created_at, stale_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        row.data_view_id, row.job_id, row.workspace_id, row.profile_id,
        row.source_id, row.source_version_id, CSV_DATA_VIEW_IMPLEMENTATION,
        row.source_revision, row.version_checksum,
        artifact.manifest.artifactChecksum, artifact.manifest.artifactByteCount,
        artifact.privateObjectKey, artifact.manifest.fieldCount,
        artifact.manifest.rowCount, JSON.stringify(artifact.manifest.fields),
        row.classification, row.authority, row.audience_policy_ref,
        row.sensitivity_policy_ref, row.purpose_policy_ref,
        row.retention_policy_ref, row.freshness_policy_ref,
        freshness, now, isCurrent ? null : now,
      )
      const finished = this.db.prepare(`
        UPDATE source_data_view_jobs
        SET state = 'succeeded', checkpoint = 4, outcome_code = 'preparation_complete',
          claim_token = NULL, claimed_by = NULL, lease_expires_at = NULL,
          updated_at = ?, terminal_at = ?
        WHERE job_id = ? AND claim_token = ? AND state = 'running'
          AND checkpoint = 3 AND lease_expires_at >= ?
      `).run(now, now, jobId, claimToken, now)
      if (finished.changes !== 1) throw new Error('Data View job claim changed')
      this.db.prepare(`
        UPDATE source_versions SET preparation_state = 'ready'
        WHERE source_version_id = ? AND source_id = ?
      `).run(row.source_version_id, row.source_id)
      if (isCurrent) {
        this.db.prepare(`
          UPDATE runtime_sources SET preparation_state = 'ready', updated_at = ?
          WHERE source_id = ? AND current_version_id = ?
            AND revision = ? AND deletion_state = 'active'
        `).run(now, row.source_id, row.source_version_id, row.source_revision)
      }
      return 'finished'
    }).immediate()
  }

  deferUntil(
    jobId: string,
    claimToken: string,
    retryAfter: number,
    now: number = Date.now(),
  ): SourceDataViewDeferResult {
    const row = this.getJobRow(jobId)
    if (!row || row.claim_token !== claimToken || row.state !== 'running') return 'stale_claim'
    if (row.lease_expires_at === null || row.lease_expires_at < now) return 'lease_expired'
    const updated = this.db.prepare(`
      UPDATE source_data_view_jobs
      SET state = 'waiting_for_resource', claim_token = NULL, claimed_by = NULL,
        lease_expires_at = NULL, retry_after = ?, updated_at = ?
      WHERE job_id = ? AND claim_token = ? AND state = 'running'
        AND lease_expires_at >= ?
    `).run(retryAfter, now, jobId, claimToken, now)
    if (updated.changes !== 1) return 'stale_claim'
    this.setPreparationState(row.source_id, row.source_version_id, 'queued', now)
    return 'deferred'
  }

  finishFailed(
    jobId: string,
    claimToken: string,
    outcomeCode: string,
    now: number = Date.now(),
  ): SourceDataViewFinishResult {
    if (!/^[a-z0-9_]{1,64}$/.test(outcomeCode)) return 'state_conflict'
    const row = this.getJobRow(jobId)
    if (!row || row.claim_token !== claimToken || row.state !== 'running') return 'stale_claim'
    if (row.lease_expires_at === null || row.lease_expires_at < now) return 'lease_expired'
    const updated = this.db.prepare(`
      UPDATE source_data_view_jobs
      SET state = 'failed', outcome_code = ?, claim_token = NULL,
        claimed_by = NULL, lease_expires_at = NULL, retry_after = NULL,
        updated_at = ?, terminal_at = ?
      WHERE job_id = ? AND claim_token = ? AND state = 'running'
        AND lease_expires_at >= ?
    `).run(outcomeCode, now, now, jobId, claimToken, now)
    if (updated.changes !== 1) return 'stale_claim'
    this.setPreparationState(row.source_id, row.source_version_id, 'failed', now)
    return 'finished'
  }

  confirmCancelled(
    jobId: string,
    claimToken: string,
    now: number = Date.now(),
  ): SourceDataViewCancellationResult {
    return this.db.transaction((): SourceDataViewCancellationResult => {
      const row = this.getJobRow(jobId)
      if (!row || row.state !== 'cancel_requested') return 'state_conflict'
      if (row.claim_token !== claimToken) return 'stale_claim'
      if (row.lease_expires_at === null || row.lease_expires_at < now) {
        return 'lease_expired'
      }
      this.setPreparationState(
        row.source_id, row.source_version_id, 'not_requested', now,
      )
      const cancelled = this.db.prepare(`
        UPDATE source_data_view_jobs
        SET state = 'cancelled', claim_token = NULL, claimed_by = NULL,
          lease_expires_at = NULL, retry_after = NULL,
          outcome_code = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE job_id = ? AND state = 'cancel_requested' AND claim_token = ?
          AND lease_expires_at >= ?
      `).run(now, now, jobId, claimToken, now)
      return cancelled.changes === 1 ? 'cancelled' : 'stale_claim'
    }).immediate()
  }

  fenceUnpublishedArtifactCleanup(
    jobId: string,
    claimToken: string,
    dataViewId: string,
    now: number = Date.now(),
  ): boolean {
    const fenced = this.db.prepare(`
      UPDATE source_data_view_jobs
      SET lease_expires_at = ?, updated_at = ?
      WHERE job_id = ? AND claim_token = ? AND data_view_id = ?
        AND state IN ('running', 'cancel_requested') AND lease_expires_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM source_data_views v
          WHERE v.job_id = source_data_view_jobs.job_id
            AND v.data_view_id = source_data_view_jobs.data_view_id
        )
    `).run(
      now + SOURCE_DATA_VIEW_JOB_LEASE_MS,
      now,
      jobId,
      claimToken,
      dataViewId,
      now,
    )
    return fenced.changes === 1
  }

  recoverExpiredClaims(now: number = Date.now()): SourceDataViewRecoveryResult {
    return this.db.transaction((): SourceDataViewRecoveryResult => {
      const expired = this.db.prepare(`
        SELECT * FROM source_data_view_jobs
        WHERE state = 'running' AND lease_expires_at < ?
        ORDER BY created_at, job_id
      `).all(now) as JobRow[]
      let requeued = 0
      let failed = 0
      for (const row of expired) {
        const exhausted = row.attempt >= row.max_attempts
        const updated = this.db.prepare(`
          UPDATE source_data_view_jobs
          SET state = ?, claim_token = NULL, claimed_by = NULL,
            lease_expires_at = NULL, retry_after = NULL,
            outcome_code = ?, updated_at = ?, terminal_at = ?
          WHERE job_id = ? AND claim_token = ? AND lease_expires_at < ?
        `).run(
          exhausted ? 'failed' : 'queued',
          exhausted ? 'attempts_exhausted' : null,
          now,
          exhausted ? now : null,
          row.job_id,
          row.claim_token,
          now,
        )
        if (updated.changes !== 1) continue
        if (exhausted) {
          failed += 1
          this.setPreparationState(row.source_id, row.source_version_id, 'failed', now)
        } else {
          requeued += 1
          this.setPreparationState(row.source_id, row.source_version_id, 'queued', now)
        }
      }
      return { requeued, failed }
    }).immediate()
  }

  getViewScoped(
    dataViewId: string,
    workspaceId: string,
    profileId: string,
  ): SourceDataViewManifest | null {
    if (!UUID.test(dataViewId) || !SCOPE.test(workspaceId) || !SCOPE.test(profileId)) {
      return null
    }
    const row = this.db.prepare(`
      SELECT dv.*
      FROM source_data_views dv
      JOIN runtime_sources s
        ON s.source_id = dv.source_id
        AND s.workspace_id = dv.workspace_id
        AND s.profile_id = dv.profile_id
      JOIN source_versions sv
        ON sv.source_version_id = dv.source_version_id
        AND sv.source_id = dv.source_id
      JOIN source_data_view_jobs j
        ON j.job_id = dv.job_id
        AND j.data_view_id = dv.data_view_id
        AND j.workspace_id = dv.workspace_id
        AND j.profile_id = dv.profile_id
        AND j.source_id = dv.source_id
        AND j.source_version_id = dv.source_version_id
        AND j.implementation_version = dv.implementation_version
        AND j.source_revision = dv.source_revision
      WHERE dv.data_view_id = ? AND dv.workspace_id = ? AND dv.profile_id = ?
        AND s.registration_state = 'registered'
        AND s.deletion_state = 'active'
        AND sv.checksum = dv.source_checksum
        AND j.state = 'succeeded' AND j.checkpoint = 4
        AND j.outcome_code = 'preparation_complete'
        AND j.terminal_at IS NOT NULL
        AND (
          (dv.freshness = 'current' AND s.current_version_id = dv.source_version_id)
          OR dv.freshness = 'stale'
        )
    `).get(dataViewId, workspaceId, profileId) as Record<string, unknown> | undefined
    return row ? projectView(row) : null
  }

  getProtectedSelectionTargetScoped(
    dataViewId: string,
    workspaceId: string,
    profileId: string,
  ): ProtectedSourceDataViewTarget | null {
    if (!UUID.test(dataViewId) || !SCOPE.test(workspaceId) || !SCOPE.test(profileId)) {
      return null
    }
    const row = this.db.prepare(`
      SELECT dv.*
      FROM source_data_views dv
      JOIN runtime_sources s
        ON s.source_id = dv.source_id
        AND s.workspace_id = dv.workspace_id
        AND s.profile_id = dv.profile_id
      JOIN source_versions sv
        ON sv.source_version_id = dv.source_version_id
        AND sv.source_id = dv.source_id
      JOIN source_data_view_jobs j
        ON j.job_id = dv.job_id
        AND j.data_view_id = dv.data_view_id
        AND j.workspace_id = dv.workspace_id
        AND j.profile_id = dv.profile_id
        AND j.source_id = dv.source_id
        AND j.source_version_id = dv.source_version_id
        AND j.implementation_version = dv.implementation_version
        AND j.source_revision = dv.source_revision
      WHERE dv.data_view_id = ? AND dv.workspace_id = ? AND dv.profile_id = ?
        AND dv.freshness = 'current' AND dv.stale_at IS NULL
        AND s.revision = dv.source_revision
        AND s.current_version_id = dv.source_version_id
        AND s.registration_state = 'registered'
        AND s.inspection_state = 'complete'
        AND s.preparation_state = 'ready'
        AND s.access_state = 'available'
        AND s.freshness_state = 'fresh'
        AND s.conflict_state IN ('none', 'resolved')
        AND s.deletion_state = 'active'
        AND s.classification = dv.classification
        AND s.authority = dv.authority
        AND s.audience_policy_ref = dv.audience_policy_ref
        AND s.sensitivity_policy_ref = dv.sensitivity_policy_ref
        AND s.purpose_policy_ref = dv.purpose_policy_ref
        AND s.retention_policy_ref = dv.retention_policy_ref
        AND s.freshness_policy_ref = dv.freshness_policy_ref
        AND sv.checksum = dv.source_checksum
        AND sv.inspection_state = 'complete'
        AND sv.preparation_state = 'ready'
        AND j.state = 'succeeded' AND j.checkpoint = 4
        AND j.outcome_code = 'preparation_complete'
        AND j.terminal_at IS NOT NULL
    `).get(dataViewId, workspaceId, profileId) as Record<string, unknown> | undefined
    if (!row || typeof row['private_object_key'] !== 'string') return null
    const manifest = projectView(row)
    if (!manifest || manifest.freshness !== 'current') return null
    const expectedObjectKey =
      `sources/${manifest.sourceId}/versions/${manifest.sourceVersionId}` +
      `/data-views/${manifest.dataViewId}.json`
    if (row['private_object_key'] !== expectedObjectKey) return null
    return {
      workspaceId,
      profileId,
      manifest: manifest as SourceDataViewManifest & { readonly freshness: 'current' },
      privateObjectKey: row['private_object_key'],
    }
  }

  getPrivateArtifact(
    dataViewId: string,
    workspaceId: string,
    profileId: string,
  ): {
    readonly privateObjectKey: string
    readonly artifactChecksum: string
    readonly artifactByteCount: number
  } | null {
    const row = this.db.prepare(`
      SELECT private_object_key, artifact_checksum, artifact_byte_count
      FROM source_data_views
      WHERE data_view_id = ? AND workspace_id = ? AND profile_id = ?
    `).get(dataViewId, workspaceId, profileId) as {
      private_object_key: string
      artifact_checksum: string
      artifact_byte_count: number
    } | undefined
    return row ? {
      privateObjectKey: row.private_object_key,
      artifactChecksum: row.artifact_checksum,
      artifactByteCount: row.artifact_byte_count,
    } : null
  }

  private getJobRow(jobId: string): JobRow | null {
    return (this.db.prepare(
      'SELECT * FROM source_data_view_jobs WHERE job_id = ?',
    ).get(jobId) as JobRow | undefined) ?? null
  }

  private projectJob(row: JobRow): SourceDataViewJob {
    const published = this.db.prepare(`
      SELECT 1 FROM source_data_views WHERE data_view_id = ? AND job_id = ?
    `).get(row.data_view_id, row.job_id) !== undefined
    return {
      jobId: row.job_id,
      sourceId: row.source_id,
      sourceVersionId: row.source_version_id,
      operation: 'prepare_data_view',
      implementationVersion: CSV_DATA_VIEW_IMPLEMENTATION,
      resourceId: null,
      dataViewId: published ? row.data_view_id : null,
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

  private setPreparationState(
    sourceId: string,
    sourceVersionId: string,
    state: 'not_requested' | 'queued' | 'preparing' | 'ready' | 'failed',
    now: number,
  ): void {
    const version = this.db.prepare(`
      UPDATE source_versions SET preparation_state = ?
      WHERE source_version_id = ? AND source_id = ?
    `).run(state, sourceVersionId, sourceId)
    if (version.changes !== 1) throw new Error('Data View source version changed')
    this.db.prepare(`
      UPDATE runtime_sources SET preparation_state = ?, updated_at = ?
      WHERE source_id = ? AND current_version_id = ? AND deletion_state = 'active'
    `).run(state, now, sourceId, sourceVersionId)
  }
}

function validArtifactShape(artifact: PreparedCsvDataViewArtifact): boolean {
  const manifest = artifact.manifest
  const headerKeys = new Set<string>()
  return UUID.test(manifest.dataViewId) && UUID.test(manifest.sourceVersionId) &&
    CHECKSUM.test(manifest.sourceChecksum) && CHECKSUM.test(manifest.artifactChecksum) &&
    Number.isSafeInteger(manifest.artifactByteCount) && manifest.artifactByteCount >= 1 &&
    manifest.artifactByteCount <= CSV_DATA_VIEW_ARTIFACT_MAX_BYTES &&
    manifest.implementationVersion === CSV_DATA_VIEW_IMPLEMENTATION &&
    manifest.fieldCount === manifest.fields.length &&
    manifest.fieldCount >= 1 && manifest.fieldCount <= CSV_DATA_VIEW_MAX_FIELDS &&
    Number.isSafeInteger(manifest.rowCount) &&
    manifest.rowCount >= 0 && manifest.rowCount <= CSV_DATA_VIEW_MAX_ROWS &&
    manifest.fields.every((field, ordinal) => {
      const key = field.label.trim().normalize('NFKC').toLowerCase()
      if (!key || headerKeys.has(key)) return false
      headerKeys.add(key)
      return field.ordinal === ordinal &&
        field.fieldId === csvDataViewOrdinalId('field', manifest.sourceVersionId, ordinal) &&
        Buffer.byteLength(field.label) <= CSV_DATA_VIEW_MAX_CELL_BYTES
    })
}

function artifactMatches(
  row: JobRow & { readonly version_checksum: string },
  manifest: CsvDataViewArtifactManifest,
  privateObjectKey: string,
): boolean {
  return manifest.dataViewId === row.data_view_id &&
    manifest.sourceVersionId === row.source_version_id &&
    manifest.sourceChecksum === row.version_checksum &&
    privateObjectKey ===
      `sources/${row.source_id}/versions/${row.source_version_id}/data-views/${row.data_view_id}.json`
}

function projectView(row: Record<string, unknown>): SourceDataViewManifest | null {
  let rawFields: unknown
  try {
    rawFields = JSON.parse(row['fields_json'] as string)
  } catch {
    return null
  }
  if (!Array.isArray(rawFields)) return null
  const sourceVersionId = row['source_version_id']
  if (typeof sourceVersionId !== 'string') return null
  const fields: CsvDataViewField[] = []
  const headerKeys = new Set<string>()
  for (const [ordinal, raw] of rawFields.entries()) {
    if (!isRecord(raw) || typeof raw['fieldId'] !== 'string' ||
        raw['ordinal'] !== ordinal || typeof raw['label'] !== 'string') return null
    const key = raw['label'].trim().normalize('NFKC').toLowerCase()
    if (!key || headerKeys.has(key) ||
        Buffer.byteLength(raw['label']) > CSV_DATA_VIEW_MAX_CELL_BYTES ||
        raw['fieldId'] !== csvDataViewOrdinalId('field', sourceVersionId, ordinal)) return null
    headerKeys.add(key)
    fields.push({ fieldId: raw['fieldId'], ordinal, label: raw['label'] })
  }
  const manifest: SourceDataViewManifest = {
    dataViewId: row['data_view_id'] as string,
    jobId: row['job_id'] as string,
    sourceId: row['source_id'] as string,
    sourceVersionId,
    implementationVersion: CSV_DATA_VIEW_IMPLEMENTATION,
    sourceRevision: row['source_revision'] as number,
    sourceChecksum: row['source_checksum'] as string,
    artifactChecksum: row['artifact_checksum'] as string,
    artifactByteCount: row['artifact_byte_count'] as number,
    fieldCount: row['field_count'] as number,
    rowCount: row['row_count'] as number,
    fields,
    classification: row['classification'] as SourceDataViewManifest['classification'],
    authority: row['authority'] as SourceDataViewManifest['authority'],
    audiencePolicyRef: row['audience_policy_ref'] as string,
    sensitivityPolicyRef: row['sensitivity_policy_ref'] as string,
    purposePolicyRef: row['purpose_policy_ref'] as string,
    retentionPolicyRef: row['retention_policy_ref'] as string,
    freshnessPolicyRef: row['freshness_policy_ref'] as string,
    freshness: row['freshness'] as SourceDataViewManifest['freshness'],
    createdAt: row['created_at'] as number,
    staleAt: row['stale_at'] as number | null,
  }
  return validPublicManifest(manifest) ? manifest : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CHECKSUM = /^sha256:[0-9a-f]{64}$/
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const POLICY_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function validPublicManifest(manifest: SourceDataViewManifest): boolean {
  return UUID.test(manifest.dataViewId) && UUID.test(manifest.jobId) &&
    UUID.test(manifest.sourceId) && UUID.test(manifest.sourceVersionId) &&
    CHECKSUM.test(manifest.sourceChecksum) && CHECKSUM.test(manifest.artifactChecksum) &&
    Number.isSafeInteger(manifest.sourceRevision) && manifest.sourceRevision > 0 &&
    Number.isSafeInteger(manifest.artifactByteCount) && manifest.artifactByteCount >= 1 &&
    manifest.artifactByteCount <= CSV_DATA_VIEW_ARTIFACT_MAX_BYTES &&
    Number.isSafeInteger(manifest.fieldCount) && manifest.fieldCount === manifest.fields.length &&
    manifest.fieldCount >= 1 && manifest.fieldCount <= CSV_DATA_VIEW_MAX_FIELDS &&
    Number.isSafeInteger(manifest.rowCount) && manifest.rowCount >= 0 &&
    manifest.rowCount <= CSV_DATA_VIEW_MAX_ROWS &&
    ['public', 'internal', 'confidential', 'restricted'].includes(manifest.classification) &&
    ['source_of_record', 'supporting_reference', 'example'].includes(manifest.authority) &&
    POLICY_REF.test(manifest.audiencePolicyRef) &&
    POLICY_REF.test(manifest.sensitivityPolicyRef) &&
    POLICY_REF.test(manifest.purposePolicyRef) &&
    POLICY_REF.test(manifest.retentionPolicyRef) &&
    POLICY_REF.test(manifest.freshnessPolicyRef) &&
    (manifest.freshness === 'current'
      ? manifest.staleAt === null
      : manifest.staleAt !== null && Number.isSafeInteger(manifest.staleAt) &&
        manifest.staleAt >= manifest.createdAt) &&
    Number.isSafeInteger(manifest.createdAt) && manifest.createdAt >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
