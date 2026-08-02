import { randomUUID } from 'node:crypto'
import type { SourceMediaType } from '../gateway/source-media.js'
import {
  SOURCE_INSPECTION_IMPLEMENTATION,
  SOURCE_JOB_LEASE_MS,
  SOURCE_JOB_MAX_ATTEMPTS,
  SOURCE_TEXT_PREPARATION_IMPLEMENTATION,
  SourceJobTargetNotFoundError,
  SourcePreparationNotReadyError,
  type ClaimedSourceInspectionTarget,
  type InspectionSourceJob,
  type SourceDerivedResource,
  type SourceJob,
  type SourceJobClaim,
  type SourceJobOperation,
  type SourceJobState,
} from '../gateway/source-job-store.js'
import type { SourceQuotaLimits } from '../gateway/source-quota-policy.js'
import type { SourceJobRepository } from './source-repositories.js'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import type { PostgreSqlQueryClient } from './postgresql-repository.js'
import {
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from './postgresql-repository.js'
import {
  assertPostgreSqlSourceQuota,
  lockPostgreSqlSourceQuotaScope,
} from './postgresql-source-foundation.js'

interface JobRow {
  readonly job_id: string
  readonly workspace_id: string
  readonly profile_id: string
  readonly source_id: string
  readonly source_version_id: string
  readonly operation: SourceJobOperation
  readonly implementation_version: SourceJob['implementationVersion']
  readonly source_revision: string
  readonly resource_id: string | null
  readonly state: SourceJobState
  readonly attempt: string
  readonly max_attempts: string
  readonly checkpoint: string
  readonly claim_token: string | null
  readonly claimed_by: string | null
  readonly lease_expires_at: string | null
  readonly retry_after: string | null
  readonly cancel_requested_at: string | null
  readonly outcome_code: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly terminal_at: string | null
  readonly resource_published?: boolean
}

function nullableInteger(value: string | null): number | null {
  return value === null ? null : safeInteger(value)
}

function job(row: JobRow): SourceJob {
  return {
    jobId: row.job_id,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    operation: row.operation,
    implementationVersion: row.implementation_version,
    resourceId: row.resource_published === true ? row.resource_id : null,
    dataViewId: null,
    state: row.state,
    attempt: safeInteger(row.attempt),
    maxAttempts: safeInteger(row.max_attempts) as typeof SOURCE_JOB_MAX_ATTEMPTS,
    checkpoint: safeInteger(row.checkpoint),
    cancelRequestedAt: nullableInteger(row.cancel_requested_at),
    outcomeCode: row.outcome_code,
    createdAt: safeInteger(row.created_at),
    updatedAt: safeInteger(row.updated_at),
    terminalAt: nullableInteger(row.terminal_at),
  }
}

async function getJob(client: PostgreSqlQueryClient, jobId: string): Promise<JobRow | undefined> {
  const result = await client.query<JobRow>(`
    SELECT j.*, EXISTS (
      SELECT 1 FROM ownware.source_derived_resources r
      WHERE r.resource_id = j.resource_id AND r.job_id = j.job_id
    ) AS resource_published
    FROM ownware.source_jobs j WHERE j.job_id = $1
  `, [jobId])
  return result.rows[0]
}

async function setOperationState(
  client: PostgreSqlQueryClient,
  target: { readonly source_id: string; readonly source_version_id: string; readonly operation: SourceJobOperation },
  state: 'reset' | 'queued' | 'running' | 'complete' | 'partial' | 'failed',
  now: number,
): Promise<void> {
  const inspection = target.operation === 'inspect_format'
  const value = inspection
    ? ({ reset: 'not_started', queued: 'queued', running: 'inspecting', complete: 'complete', partial: 'partial', failed: 'failed' } as const)[state]
    : ({ reset: 'not_requested', queued: 'queued', running: 'preparing', complete: 'ready', partial: 'partial', failed: 'failed' } as const)[state]
  const column = inspection ? 'inspection_state' : 'preparation_state'
  const version = await client.query(`
    UPDATE ownware.source_versions SET ${column} = $1
    WHERE source_version_id = $2 AND source_id = $3
  `, [value, target.source_version_id, target.source_id])
  if (version.rowCount !== 1) throw new Error('source job target changed')
  await client.query(`
    UPDATE ownware.runtime_sources SET ${column} = $1, updated_at = $2
    WHERE source_id = $3 AND current_version_id = $4 AND deletion_state = 'active'
  `, [value, now, target.source_id, target.source_version_id])
}

async function insertJob(
  client: PostgreSqlQueryClient,
  input: { readonly workspaceId: string; readonly profileId: string; readonly sourceId: string; readonly sourceVersionId: string },
  operation: SourceJobOperation,
  implementation: SourceJob['implementationVersion'],
  revision: number,
  resourceId: string | null,
  now: number,
): Promise<SourceJob> {
  const id = randomUUID()
  await client.query(`
    INSERT INTO ownware.source_jobs (
      job_id, workspace_id, profile_id, source_id, source_version_id, operation,
      implementation_version, source_revision, resource_id, state, attempt,
      max_attempts, checkpoint, claim_token, claimed_by, lease_expires_at,
      retry_after, cancel_requested_at, outcome_code, created_at, updated_at, terminal_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', 0, $10, 0,
      NULL, NULL, NULL, NULL, NULL, NULL, $11, $11, NULL)
  `, [
    id, input.workspaceId, input.profileId, input.sourceId, input.sourceVersionId,
    operation, implementation, revision, resourceId, SOURCE_JOB_MAX_ATTEMPTS, now,
  ])
  await setOperationState(client, {
    source_id: input.sourceId, source_version_id: input.sourceVersionId, operation,
  }, 'queued', now)
  const row = await getJob(client, id)
  if (row === undefined) throw new Error('source job was not created')
  return job(row)
}

async function claimedTarget(
  client: PostgreSqlQueryClient,
  jobId: string,
  claimToken: string,
  operation: SourceJobOperation,
  now: number,
): Promise<ClaimedSourceInspectionTarget | null> {
  const result = await client.query<{
    readonly object_key: string; readonly byte_count: string
    readonly checksum: string; readonly verified_media_type: SourceMediaType
  }>(`
    SELECT v.object_key, v.byte_count, v.checksum, v.verified_media_type
    FROM ownware.source_jobs j JOIN ownware.source_versions v
      ON v.source_version_id = j.source_version_id AND v.source_id = j.source_id
    WHERE j.job_id = $1 AND j.operation = $2 AND j.state = 'running'
      AND j.claim_token = $3 AND j.lease_expires_at >= $4
  `, [jobId, operation, claimToken, now])
  const row = result.rows[0]
  return row === undefined ? null : {
    objectKey: row.object_key,
    expectedByteCount: safeInteger(row.byte_count),
    expectedChecksum: row.checksum,
    verifiedMediaType: row.verified_media_type,
  }
}

function isTerminal(state: SourceJobState): boolean {
  return ['succeeded', 'partial', 'failed', 'cancelled'].includes(state)
}

export function createPostgreSqlSourceJobRepository(
  context: PostgreSqlRootRepositoryContext,
  limits: SourceQuotaLimits,
): SourceJobRepository {
  return {
    enqueue(input, now = Date.now()) {
      return repositoryCall(context, 'source_jobs', 'enqueue', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          await lockPostgreSqlSourceQuotaScope(client, input.workspaceId, input.profileId)
          const target = await client.query<{ readonly revision: string }>(`
            SELECT s.revision FROM ownware.source_versions v JOIN ownware.runtime_sources s
              ON s.source_id = v.source_id WHERE v.source_version_id = $1 AND v.source_id = $2
              AND s.workspace_id = $3 AND s.profile_id = $4 AND s.deletion_state = 'active'
            FOR SHARE OF s
          `, [input.sourceVersionId, input.sourceId, input.workspaceId, input.profileId])
          if (target.rows[0] === undefined) throw new SourceJobTargetNotFoundError()
          const existing = await client.query<JobRow>(`
            SELECT j.*, EXISTS (SELECT 1 FROM ownware.source_derived_resources r
              WHERE r.resource_id = j.resource_id AND r.job_id = j.job_id) AS resource_published
            FROM ownware.source_jobs j WHERE source_version_id = $1
              AND operation = 'inspect_format' AND implementation_version = $2
          `, [input.sourceVersionId, SOURCE_INSPECTION_IMPLEMENTATION])
          if (existing.rows[0] !== undefined) return job(existing.rows[0]) as InspectionSourceJob
          await assertPostgreSqlSourceQuota(client, limits, input, { nonterminalJobs: 1 })
          return await insertJob(client, input, 'inspect_format', SOURCE_INSPECTION_IMPLEMENTATION,
            safeInteger(target.rows[0].revision), null, now) as InspectionSourceJob
        }))
    },
    enqueuePreparation(input, now = Date.now()) {
      return repositoryCall(context, 'source_jobs', 'enqueuePreparation', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          await lockPostgreSqlSourceQuotaScope(client, input.workspaceId, input.profileId)
          const target = await client.query<{
            readonly verified_media_type: SourceMediaType; readonly inspection_state: string
            readonly revision: string; readonly current_version_id: string | null; readonly authority: string
          }>(`
            SELECT v.verified_media_type, v.inspection_state, s.revision,
              s.current_version_id, s.authority FROM ownware.source_versions v
            JOIN ownware.runtime_sources s ON s.source_id = v.source_id
            WHERE v.source_version_id = $1 AND v.source_id = $2 AND s.workspace_id = $3
              AND s.profile_id = $4 AND s.deletion_state = 'active' FOR SHARE OF s
          `, [input.sourceVersionId, input.sourceId, input.workspaceId, input.profileId])
          const row = target.rows[0]
          if (row === undefined) throw new SourceJobTargetNotFoundError()
          if (row.current_version_id !== input.sourceVersionId) throw new SourcePreparationNotReadyError('source_version_not_current')
          if (row.inspection_state !== 'complete') throw new SourcePreparationNotReadyError('source_inspection_incomplete')
          if (row.verified_media_type !== 'text/plain') throw new SourcePreparationNotReadyError('source_media_unsupported')
          if (row.authority === 'excluded') throw new SourcePreparationNotReadyError('source_authority_excluded')
          const existing = await client.query<JobRow>(`
            SELECT j.*, EXISTS (SELECT 1 FROM ownware.source_derived_resources r
              WHERE r.resource_id = j.resource_id AND r.job_id = j.job_id) AS resource_published
            FROM ownware.source_jobs j WHERE source_version_id = $1 AND operation = 'extract_text'
              AND implementation_version = $2
          `, [input.sourceVersionId, SOURCE_TEXT_PREPARATION_IMPLEMENTATION])
          if (existing.rows[0] !== undefined) return job(existing.rows[0])
          await assertPostgreSqlSourceQuota(client, limits, input, { nonterminalJobs: 1, derivedResources: 1 })
          return insertJob(client, input, 'extract_text', SOURCE_TEXT_PREPARATION_IMPLEMENTATION,
            safeInteger(row.revision), randomUUID(), now)
        }))
    },
    getScoped(jobId, workspaceId, profileId) {
      return repositoryCall(context, 'source_jobs', 'getScoped', 'read_failed', async (client) => {
        const row = await getJob(client, jobId)
        return row === undefined || row.workspace_id !== workspaceId || row.profile_id !== profileId
          ? null : job(row)
      })
    },
    hasTargetScoped(sourceId, sourceVersionId, workspaceId, profileId) {
      return repositoryCall(context, 'source_jobs', 'hasTargetScoped', 'read_failed', async (client) => {
        const result = await client.query(`
          SELECT 1 FROM ownware.source_versions v JOIN ownware.runtime_sources s
            ON s.source_id = v.source_id WHERE v.source_version_id = $1 AND v.source_id = $2
            AND s.workspace_id = $3 AND s.profile_id = $4 AND s.deletion_state = 'active'
        `, [sourceVersionId, sourceId, workspaceId, profileId])
        return result.rowCount === 1
      })
    },
    claimNext(workerId, now = Date.now()) {
      return repositoryCall(context, 'source_jobs', 'claimNext', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const claimToken = randomUUID()
          const expires = now + SOURCE_JOB_LEASE_MS
          const result = await client.query<JobRow>(`
            WITH candidate AS (
              SELECT job_id FROM ownware.source_jobs WHERE attempt < max_attempts
                AND operation IN ('inspect_format', 'extract_text')
                AND (state = 'queued' OR (state = 'waiting_for_resource' AND retry_after <= $1))
              ORDER BY created_at ASC, job_id ASC FOR UPDATE SKIP LOCKED LIMIT 1
            ) UPDATE ownware.source_jobs j SET state = 'running', attempt = j.attempt + 1,
              claim_token = $2, claimed_by = $3, lease_expires_at = $4,
              retry_after = NULL, updated_at = $1 FROM candidate
            WHERE j.job_id = candidate.job_id RETURNING j.*
          `, [now, claimToken, workerId, expires])
          const row = result.rows[0]
          if (row === undefined) return null
          await setOperationState(client, row, 'running', now)
          const claim: SourceJobClaim = {
            jobId: row.job_id, sourceId: row.source_id, sourceVersionId: row.source_version_id,
            operation: row.operation, attempt: safeInteger(row.attempt),
            maxAttempts: safeInteger(row.max_attempts) as typeof SOURCE_JOB_MAX_ATTEMPTS,
            checkpoint: safeInteger(row.checkpoint), implementationVersion: row.implementation_version,
            resourceId: row.resource_id, claimToken, leaseExpiresAt: expires,
          }
          return claim
        }))
    },
    getClaimedInspectionTarget(jobId, claimToken, now = Date.now()) {
      return repositoryCall(context, 'source_jobs', 'getClaimedInspectionTarget', 'read_failed',
        (client) => claimedTarget(client, jobId, claimToken, 'inspect_format', now))
    },
    getClaimedPreparationTarget(jobId, claimToken, now = Date.now()) {
      return repositoryCall(context, 'source_jobs', 'getClaimedPreparationTarget', 'read_failed',
        (client) => claimedTarget(client, jobId, claimToken, 'extract_text', now))
    },
    advanceCheckpoint(jobId, claimToken, expected, next, now = Date.now()) {
      if (!Number.isInteger(expected) || next !== expected + 1 || next < 1 || next > 4) {
        return Promise.reject(new RangeError('Source job checkpoint transition is invalid'))
      }
      return repositoryCall(context, 'source_jobs', 'advanceCheckpoint', 'write_failed', async (client) => {
        const current = await getJob(client, jobId)
        if (current === undefined || current.state !== 'running' || current.claim_token !== claimToken) return 'stale_claim'
        if (current.lease_expires_at === null || safeInteger(current.lease_expires_at) < now) return 'lease_expired'
        if (safeInteger(current.checkpoint) !== expected) return 'checkpoint_conflict'
        const result = await client.query(`
          UPDATE ownware.source_jobs SET checkpoint = $1, updated_at = $2 WHERE job_id = $3
            AND state = 'running' AND claim_token = $4 AND lease_expires_at >= $2 AND checkpoint = $5
        `, [next, now, jobId, claimToken, expected])
        return result.rowCount === 1 ? 'advanced' : 'stale_claim'
      })
    },
    recoverExpiredClaims(now = Date.now()) {
      return repositoryCall(context, 'source_jobs', 'recoverExpiredClaims', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const targets = await client.query<JobRow>(`
            SELECT * FROM ownware.source_jobs WHERE operation IN ('inspect_format', 'extract_text')
              AND ((state = 'running' AND lease_expires_at < $1)
                OR (state = 'cancel_requested' AND (claim_token IS NULL OR lease_expires_at < $1)))
            FOR UPDATE
          `, [now])
          let requeued = 0; let failed = 0; let cancelled = 0
          for (const row of targets.rows) {
            if (row.state === 'cancel_requested') {
              await setOperationState(client, row, 'reset', now); cancelled += 1
              await client.query(`UPDATE ownware.source_jobs SET state = 'cancelled', claim_token = NULL,
                claimed_by = NULL, lease_expires_at = NULL, retry_after = NULL,
                outcome_code = 'cancelled', updated_at = $1, terminal_at = $1 WHERE job_id = $2`, [now, row.job_id])
            } else if (safeInteger(row.attempt) < safeInteger(row.max_attempts)) {
              await setOperationState(client, row, 'queued', now); requeued += 1
              await client.query(`UPDATE ownware.source_jobs SET state = 'queued', claim_token = NULL,
                claimed_by = NULL, lease_expires_at = NULL, retry_after = NULL,
                updated_at = $1 WHERE job_id = $2`, [now, row.job_id])
            } else {
              await setOperationState(client, row, 'failed', now); failed += 1
              await client.query(`UPDATE ownware.source_jobs SET state = 'failed', claim_token = NULL,
                claimed_by = NULL, lease_expires_at = NULL, retry_after = NULL,
                outcome_code = 'attempts_exhausted', updated_at = $1, terminal_at = $1
                WHERE job_id = $2`, [now, row.job_id])
            }
          }
          return { requeued, failed, cancelled }
        }))
    },
    requestCancel(jobId, workspaceId, profileId, now = Date.now()) {
      return repositoryCall(context, 'source_jobs', 'requestCancel', 'write_failed', async (client) => {
        const row = await getJob(client, jobId)
        if (row === undefined || row.workspace_id !== workspaceId || row.profile_id !== profileId) return 'missing'
        if (row.state === 'cancel_requested') return 'already_requested'
        if (isTerminal(row.state)) return 'terminal'
        const result = await client.query(`UPDATE ownware.source_jobs SET state = 'cancel_requested',
          cancel_requested_at = $1, retry_after = NULL, updated_at = $1 WHERE job_id = $2
          AND state IN ('queued', 'running', 'waiting_for_resource')`, [now, jobId])
        return result.rowCount === 1 ? 'requested' : 'already_requested'
      })
    },
    confirmNextUnclaimedCancellation(now = Date.now()) {
      return repositoryCall(context, 'source_jobs', 'confirmNextUnclaimedCancellation', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const result = await client.query<JobRow>(`SELECT * FROM ownware.source_jobs
            WHERE state = 'cancel_requested' AND claim_token IS NULL
            AND operation IN ('inspect_format', 'extract_text')
            ORDER BY updated_at, job_id FOR UPDATE SKIP LOCKED LIMIT 1`)
          const row = result.rows[0]
          if (row === undefined) return false
          await setOperationState(client, row, 'reset', now)
          await client.query(`UPDATE ownware.source_jobs SET state = 'cancelled', outcome_code = 'cancelled',
            updated_at = $1, terminal_at = $1 WHERE job_id = $2`, [now, row.job_id])
          return true
        }))
    },
    confirmCancelled(jobId, claimToken, now = Date.now()) {
      return repositoryCall(context, 'source_jobs', 'confirmCancelled', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const row = await getJob(client, jobId)
          if (row === undefined || row.state !== 'cancel_requested') return 'state_conflict'
          if (row.claim_token !== claimToken) return 'stale_claim'
          if (row.lease_expires_at !== null && safeInteger(row.lease_expires_at) < now) return 'lease_expired'
          await setOperationState(client, row, 'reset', now)
          const result = await client.query(`UPDATE ownware.source_jobs SET state = 'cancelled',
            claim_token = NULL, claimed_by = NULL, lease_expires_at = NULL, retry_after = NULL,
            outcome_code = 'cancelled', updated_at = $1, terminal_at = $1 WHERE job_id = $2
            AND state = 'cancel_requested' AND claim_token IS NOT DISTINCT FROM $3
            AND (lease_expires_at IS NULL OR lease_expires_at >= $1)`, [now, jobId, claimToken])
          return result.rowCount === 1 ? 'cancelled' : 'stale_claim'
        }))
    },
    deferUntil(jobId, claimToken, retryAt, now = Date.now()) {
      if (!Number.isSafeInteger(retryAt) || retryAt <= now) return Promise.reject(new RangeError('Source job retry time must be in the future'))
      return repositoryCall(context, 'source_jobs', 'deferUntil', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const row = await getJob(client, jobId)
          if (row === undefined || row.state !== 'running' || row.claim_token !== claimToken) return 'stale_claim'
          if (row.lease_expires_at === null || safeInteger(row.lease_expires_at) < now) return 'lease_expired'
          const result = await client.query(`UPDATE ownware.source_jobs SET state = 'waiting_for_resource',
            claim_token = NULL, claimed_by = NULL, lease_expires_at = NULL, retry_after = $1,
            updated_at = $2 WHERE job_id = $3 AND state = 'running' AND claim_token = $4
            AND lease_expires_at >= $2`, [retryAt, now, jobId, claimToken])
          if (result.rowCount === 1) await setOperationState(client, row, 'queued', now)
          return result.rowCount === 1 ? 'deferred' : 'stale_claim'
        }))
    },
    finish(jobId, claimToken, outcome, outcomeCode, now = Date.now()) {
      return finishJob(context, jobId, claimToken, outcome, outcomeCode, now)
    },
    finishInspection(jobId, claimToken, outcome, outcomeCode, now = Date.now()) {
      return finishJob(context, jobId, claimToken, outcome, outcomeCode, now, 'inspect_format')
    },
    finishPreparation(jobId, claimToken, outcome, outcomeCode, now = Date.now()) {
      return finishJob(context, jobId, claimToken, outcome, outcomeCode, now, 'extract_text')
    },
    getResourceScoped(resourceId, workspaceId, profileId) {
      return repositoryCall(context, 'source_jobs', 'getResourceScoped', 'read_failed', async (client) => {
        const result = await client.query<Record<string, unknown>>(`SELECT * FROM ownware.source_derived_resources
          WHERE resource_id = $1 AND workspace_id = $2 AND profile_id = $3`, [resourceId, workspaceId, profileId])
        return result.rows[0] === undefined ? null : projectResource(result.rows[0])
      })
    },
  }
}

async function finishJob(
  context: PostgreSqlRootRepositoryContext,
  jobId: string,
  claimToken: string,
  outcome: 'succeeded' | 'partial' | 'failed',
  outcomeCode: string,
  now: number,
  operation?: SourceJobOperation,
): Promise<'finished' | 'stale_claim' | 'lease_expired' | 'state_conflict' | 'checkpoint_incomplete'> {
  if (!/^[a-z0-9_]{1,64}$/.test(outcomeCode)) throw new TypeError('Source job outcome code is invalid')
  return repositoryCall(context, 'source_jobs', operation === undefined ? 'finish' : operation === 'inspect_format' ? 'finishInspection' : 'finishPreparation', 'write_failed', async () =>
    withPostgreSqlTransaction(context.pool, async (client) => {
      const row = await getJob(client, jobId)
      if (row === undefined || row.state !== 'running' || (operation !== undefined && row.operation !== operation)) return 'state_conflict'
      if (row.claim_token !== claimToken) return 'stale_claim'
      if (row.lease_expires_at === null || safeInteger(row.lease_expires_at) < now) return 'lease_expired'
      const successCheckpoint = operation === undefined ? 4 : 3
      if (outcome === 'succeeded' && safeInteger(row.checkpoint) !== successCheckpoint) return 'checkpoint_incomplete'
      if (operation === 'extract_text' && outcome === 'succeeded') await publishResource(client, row, now)
      if (operation !== undefined) await setOperationState(client, row,
        outcome === 'succeeded' ? 'complete' : outcome === 'partial' ? 'partial' : 'failed', now)
      const result = await client.query(`UPDATE ownware.source_jobs SET state = $1,
        checkpoint = CASE WHEN $1 = 'succeeded' AND $2::boolean THEN 4 ELSE checkpoint END,
        claim_token = NULL, claimed_by = NULL, lease_expires_at = NULL, retry_after = NULL,
        outcome_code = $3, updated_at = $4, terminal_at = $4 WHERE job_id = $5
        AND state = 'running' AND claim_token = $6 AND lease_expires_at >= $4`,
      [outcome, operation !== undefined, outcomeCode, now, jobId, claimToken])
      if (result.rowCount !== 1) throw new Error('source job claim changed')
      return 'finished'
    }))
}

async function publishResource(client: PostgreSqlQueryClient, row: JobRow, now: number): Promise<void> {
  if (row.resource_id === null) throw new Error('source preparation has no resource identity')
  const target = await client.query<Record<string, unknown>>(`SELECT v.checksum, v.byte_count,
    s.revision, s.current_version_id, s.classification, s.authority, s.audience_policy_ref,
    s.sensitivity_policy_ref, s.purpose_policy_ref, s.retention_policy_ref, s.freshness_policy_ref
    FROM ownware.source_versions v JOIN ownware.runtime_sources s ON s.source_id = v.source_id
    WHERE v.source_version_id = $1 AND v.source_id = $2`, [row.source_version_id, row.source_id])
  const value = target.rows[0]
  if (value === undefined || value['authority'] === 'excluded') throw new Error('source preparation target changed')
  const freshness = value['current_version_id'] === row.source_version_id ? 'current' : 'stale'
  await client.query(`INSERT INTO ownware.source_derived_resources (
    resource_id, job_id, workspace_id, profile_id, source_id, source_version_id, kind,
    operation, implementation_version, source_revision, source_checksum, resource_checksum,
    byte_start, byte_end, byte_count, classification, authority, audience_policy_ref,
    sensitivity_policy_ref, purpose_policy_ref, retention_policy_ref, freshness_policy_ref,
    coverage, freshness, created_at, stale_at
  ) VALUES ($1, $2, $3, $4, $5, $6, 'text_extraction', 'extract_text', $7, $8, $9, $9,
    0, $10, $10, $11, $12, $13, $14, $15, $16, $17, 'complete', $18, $19, $20)`, [
    row.resource_id, row.job_id, row.workspace_id, row.profile_id, row.source_id,
    row.source_version_id, row.implementation_version, safeInteger(row.source_revision),
    value['checksum'], safeInteger(value['byte_count']), value['classification'], value['authority'],
    value['audience_policy_ref'], value['sensitivity_policy_ref'], value['purpose_policy_ref'],
    value['retention_policy_ref'], value['freshness_policy_ref'], freshness, now,
    freshness === 'stale' ? now : null,
  ])
}

function projectResource(row: Record<string, unknown>): SourceDerivedResource {
  return {
    resourceId: row['resource_id'] as string, jobId: row['job_id'] as string,
    sourceId: row['source_id'] as string, sourceVersionId: row['source_version_id'] as string,
    kind: 'text_extraction', operation: 'extract_text',
    implementationVersion: SOURCE_TEXT_PREPARATION_IMPLEMENTATION,
    sourceRevision: safeInteger(row['source_revision']), sourceChecksum: row['source_checksum'] as string,
    resourceChecksum: row['resource_checksum'] as string, byteStart: 0,
    byteEnd: safeInteger(row['byte_end']), byteCount: safeInteger(row['byte_count']),
    classification: row['classification'] as SourceDerivedResource['classification'],
    authority: row['authority'] as SourceDerivedResource['authority'],
    audiencePolicyRef: row['audience_policy_ref'] as string,
    sensitivityPolicyRef: row['sensitivity_policy_ref'] as string,
    purposePolicyRef: row['purpose_policy_ref'] as string,
    retentionPolicyRef: row['retention_policy_ref'] as string,
    freshnessPolicyRef: row['freshness_policy_ref'] as string,
    coverage: 'complete', freshness: row['freshness'] as SourceDerivedResource['freshness'],
    createdAt: safeInteger(row['created_at']),
    staleAt: row['stale_at'] === null ? null : safeInteger(row['stale_at']),
  }
}
