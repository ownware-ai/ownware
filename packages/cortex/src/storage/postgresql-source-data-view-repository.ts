import { randomUUID } from 'node:crypto'
import {
  CSV_DATA_VIEW_IMPLEMENTATION,
  CSV_DATA_VIEW_MAX_CELL_BYTES,
  CSV_DATA_VIEW_MAX_FIELDS,
  CSV_DATA_VIEW_MAX_ROWS,
  csvDataViewOrdinalId,
  type CsvDataViewField,
} from '../gateway/csv-data-view.js'
import {
  SOURCE_DATA_VIEW_JOB_LEASE_MS,
  SOURCE_DATA_VIEW_JOB_MAX_ATTEMPTS,
  SourceDataViewUnavailableError,
  type ClaimedSourceDataViewTarget,
  type SourceDataViewJob,
  type SourceDataViewJobClaim,
  type SourceDataViewJobState,
  type SourceDataViewManifest,
} from '../gateway/source-data-view-store.js'
import {
  CSV_DATA_VIEW_ARTIFACT_MAX_BYTES,
  type CsvDataViewArtifactManifest,
  type PreparedCsvDataViewArtifact,
} from '../gateway/source-byte-store.js'
import type { SourceQuotaLimits } from '../gateway/source-quota-policy.js'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import {
  nullableSafeInteger,
  repositoryCall,
  safeInteger,
  type PostgreSqlQueryClient,
  withPostgreSqlTransaction,
} from './postgresql-repository.js'
import type { SourceDataViewRepository } from './source-repositories.js'
import {
  assertPostgreSqlSourceQuota,
  lockPostgreSqlSourceQuotaScope,
} from './postgresql-source-foundation.js'

interface JobRow {
  readonly job_id: string
  readonly data_view_id: string
  readonly workspace_id: string
  readonly profile_id: string
  readonly source_id: string
  readonly source_version_id: string
  readonly implementation_version: typeof CSV_DATA_VIEW_IMPLEMENTATION
  readonly source_revision: string
  readonly state: SourceDataViewJobState
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
  readonly view_published?: boolean
}

interface ViewRow extends Record<string, unknown> {
  readonly data_view_id: string
  readonly job_id: string
  readonly workspace_id: string
  readonly profile_id: string
  readonly source_id: string
  readonly source_version_id: string
  readonly implementation_version: typeof CSV_DATA_VIEW_IMPLEMENTATION
  readonly source_revision: string
  readonly source_checksum: string
  readonly artifact_checksum: string
  readonly artifact_byte_count: string
  readonly private_object_key: string
  readonly field_count: string
  readonly row_count: string
  readonly fields_json: string
  readonly classification: SourceDataViewManifest['classification']
  readonly authority: SourceDataViewManifest['authority']
  readonly audience_policy_ref: string
  readonly sensitivity_policy_ref: string
  readonly purpose_policy_ref: string
  readonly retention_policy_ref: string
  readonly freshness_policy_ref: string
  readonly freshness: SourceDataViewManifest['freshness']
  readonly created_at: string
  readonly stale_at: string | null
}

function projectJob(row: JobRow): SourceDataViewJob {
  return {
    jobId: row.job_id,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    operation: 'prepare_data_view',
    implementationVersion: CSV_DATA_VIEW_IMPLEMENTATION,
    resourceId: null,
    dataViewId: row.view_published === true ? row.data_view_id : null,
    state: row.state,
    attempt: safeInteger(row.attempt),
    maxAttempts: safeInteger(row.max_attempts) as typeof SOURCE_DATA_VIEW_JOB_MAX_ATTEMPTS,
    checkpoint: safeInteger(row.checkpoint),
    cancelRequestedAt: nullableSafeInteger(row.cancel_requested_at),
    outcomeCode: row.outcome_code,
    createdAt: safeInteger(row.created_at),
    updatedAt: safeInteger(row.updated_at),
    terminalAt: nullableSafeInteger(row.terminal_at),
  }
}

async function getJob(
  client: PostgreSqlQueryClient,
  jobId: string,
): Promise<JobRow | undefined> {
  const result = await client.query<JobRow>(`
    SELECT j.*, EXISTS (
      SELECT 1 FROM ownware.source_data_views v
      WHERE v.data_view_id = j.data_view_id AND v.job_id = j.job_id
    ) AS view_published
    FROM ownware.source_data_view_jobs j WHERE j.job_id = $1
  `, [jobId])
  return result.rows[0]
}

async function setPreparationState(
  client: PostgreSqlQueryClient,
  sourceId: string,
  sourceVersionId: string,
  state: 'not_requested' | 'queued' | 'preparing' | 'ready' | 'failed',
  now: number,
): Promise<void> {
  const version = await client.query(`
    UPDATE ownware.source_versions SET preparation_state = $1
    WHERE source_version_id = $2 AND source_id = $3
  `, [state, sourceVersionId, sourceId])
  if (version.rowCount !== 1) throw new Error('source Data View version changed')
  await client.query(`
    UPDATE ownware.runtime_sources SET preparation_state = $1, updated_at = $2
    WHERE source_id = $3 AND current_version_id = $4 AND deletion_state = 'active'
  `, [state, now, sourceId, sourceVersionId])
}

function claim(row: JobRow): SourceDataViewJobClaim {
  if (row.claim_token === null || row.lease_expires_at === null) {
    throw new Error('source Data View claim is incomplete')
  }
  return {
    jobId: row.job_id,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    dataViewId: row.data_view_id,
    implementationVersion: CSV_DATA_VIEW_IMPLEMENTATION,
    attempt: safeInteger(row.attempt),
    maxAttempts: safeInteger(row.max_attempts) as typeof SOURCE_DATA_VIEW_JOB_MAX_ATTEMPTS,
    checkpoint: safeInteger(row.checkpoint),
    claimToken: row.claim_token,
    leaseExpiresAt: safeInteger(row.lease_expires_at),
  }
}

export function createPostgreSqlSourceDataViewRepository(
  context: PostgreSqlRootRepositoryContext,
  limits: SourceQuotaLimits,
): SourceDataViewRepository {
  return {
    enqueue(input, now = Date.now()) {
      return repositoryCall(context, 'source_data_views', 'enqueue', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          await lockPostgreSqlSourceQuotaScope(client, input.workspaceId, input.profileId)
          const target = await client.query<{
            readonly revision: string
            readonly current_version_id: string | null
            readonly kind: string
            readonly registration_state: string
            readonly authority: string
            readonly access_state: string
            readonly conflict_state: string
            readonly deletion_state: string
            readonly verified_media_type: string
            readonly inspection_state: string
          }>(`
            SELECT s.revision, s.current_version_id, s.kind, s.registration_state,
              s.authority, s.access_state, s.conflict_state, s.deletion_state,
              v.verified_media_type, v.inspection_state
            FROM ownware.source_versions v JOIN ownware.runtime_sources s
              ON s.source_id = v.source_id
            WHERE v.source_version_id = $1 AND v.source_id = $2
              AND s.workspace_id = $3 AND s.profile_id = $4
            FOR UPDATE OF s, v
          `, [input.sourceVersionId, input.sourceId, input.workspaceId, input.profileId])
          const row = target.rows[0]
          if (row === undefined || row.deletion_state !== 'active') {
            throw new SourceDataViewUnavailableError('source_version_not_found')
          }
          if (row.current_version_id !== input.sourceVersionId) {
            throw new SourceDataViewUnavailableError('source_version_not_current')
          }
          if (row.kind !== 'structured_export' || row.registration_state !== 'registered') {
            throw new SourceDataViewUnavailableError('source_data_view_kind_unsupported')
          }
          if (row.inspection_state !== 'complete') {
            throw new SourceDataViewUnavailableError('source_inspection_incomplete')
          }
          if (row.verified_media_type !== 'text/plain') {
            throw new SourceDataViewUnavailableError('source_media_unsupported')
          }
          if (row.authority === 'excluded') {
            throw new SourceDataViewUnavailableError('source_authority_excluded')
          }
          if (row.access_state !== 'available') {
            throw new SourceDataViewUnavailableError('source_access_unavailable')
          }
          if (row.conflict_state === 'confirmed') {
            throw new SourceDataViewUnavailableError('source_conflict_confirmed')
          }

          const existing = await client.query<JobRow>(`
            SELECT j.*, EXISTS (SELECT 1 FROM ownware.source_data_views v
              WHERE v.data_view_id = j.data_view_id AND v.job_id = j.job_id) AS view_published
            FROM ownware.source_data_view_jobs j
            WHERE j.source_version_id = $1 AND j.implementation_version = $2
          `, [input.sourceVersionId, CSV_DATA_VIEW_IMPLEMENTATION])
          if (existing.rows[0] !== undefined) return projectJob(existing.rows[0])

          await assertPostgreSqlSourceQuota(client, limits, input, {
            nonterminalJobs: 1,
            derivedResources: 1,
          })
          const jobId = randomUUID()
          const dataViewId = randomUUID()
          const inserted = await client.query<JobRow>(`
            INSERT INTO ownware.source_data_view_jobs (
              job_id, data_view_id, workspace_id, profile_id, source_id,
              source_version_id, implementation_version, source_revision,
              state, attempt, max_attempts, checkpoint, claim_token, claimed_by,
              lease_expires_at, retry_after, cancel_requested_at, outcome_code,
              created_at, updated_at, terminal_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', 0, $9, 0,
              NULL, NULL, NULL, NULL, NULL, NULL, $10, $10, NULL) RETURNING *
          `, [
            jobId, dataViewId, input.workspaceId, input.profileId, input.sourceId,
            input.sourceVersionId, CSV_DATA_VIEW_IMPLEMENTATION, safeInteger(row.revision),
            SOURCE_DATA_VIEW_JOB_MAX_ATTEMPTS, now,
          ])
          await setPreparationState(client, input.sourceId, input.sourceVersionId, 'queued', now)
          return projectJob({ ...inserted.rows[0]!, view_published: false })
        }))
    },

    getJobScoped(jobId, workspaceId, profileId) {
      return repositoryCall(context, 'source_data_views', 'getJobScoped', 'read_failed', async (client) => {
        const row = await getJob(client, jobId)
        return row === undefined || row.workspace_id !== workspaceId || row.profile_id !== profileId
          ? null
          : projectJob(row)
      })
    },

    requestCancel(jobId, workspaceId, profileId, now = Date.now()) {
      return repositoryCall(context, 'source_data_views', 'requestCancel', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const selected = await client.query<{ readonly state: SourceDataViewJobState }>(`
            SELECT state FROM ownware.source_data_view_jobs
            WHERE job_id = $1 AND workspace_id = $2 AND profile_id = $3 FOR UPDATE
          `, [jobId, workspaceId, profileId])
          const row = selected.rows[0]
          if (row === undefined) return 'missing'
          if (row.state === 'cancel_requested') return 'already_requested'
          if (['succeeded', 'failed', 'cancelled'].includes(row.state)) return 'terminal'
          const updated = await client.query(`
            UPDATE ownware.source_data_view_jobs
            SET state = 'cancel_requested', cancel_requested_at = $1,
              retry_after = NULL, updated_at = $1
            WHERE job_id = $2 AND state IN ('queued', 'running', 'waiting_for_resource')
          `, [now, jobId])
          return updated.rowCount === 1 ? 'requested' : 'already_requested'
        }))
    },

    claimNext(workerId, now = Date.now()) {
      return repositoryCall(context, 'source_data_views', 'claimNext', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const claimToken = randomUUID()
          const leaseExpiresAt = now + SOURCE_DATA_VIEW_JOB_LEASE_MS
          const updated = await client.query<JobRow>(`
            WITH candidate AS (
              SELECT job_id FROM ownware.source_data_view_jobs
              WHERE attempt < max_attempts AND (
                state = 'queued' OR (state = 'waiting_for_resource' AND retry_after <= $1)
              ) ORDER BY created_at ASC, job_id ASC FOR UPDATE SKIP LOCKED LIMIT 1
            ) UPDATE ownware.source_data_view_jobs j
              SET state = 'running', attempt = j.attempt + 1, claim_token = $2,
                claimed_by = $3, lease_expires_at = $4, retry_after = NULL, updated_at = $1
              FROM candidate WHERE j.job_id = candidate.job_id RETURNING j.*
          `, [now, claimToken, workerId, leaseExpiresAt])
          const row = updated.rows[0]
          if (row === undefined) return null
          await setPreparationState(client, row.source_id, row.source_version_id, 'preparing', now)
          return claim(row)
        }))
    },

    claimNextCancellation(workerId, now = Date.now()) {
      if (!/^[a-z0-9._-]{1,64}$/.test(workerId)) {
        return Promise.reject(new TypeError('Source Data View worker identity is invalid'))
      }
      return repositoryCall(context, 'source_data_views', 'claimNextCancellation', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const claimToken = randomUUID()
          const leaseExpiresAt = now + SOURCE_DATA_VIEW_JOB_LEASE_MS
          const updated = await client.query<JobRow>(`
            WITH candidate AS (
              SELECT job_id FROM ownware.source_data_view_jobs
              WHERE state = 'cancel_requested'
                AND (claim_token IS NULL OR lease_expires_at < $1)
              ORDER BY updated_at ASC, job_id ASC FOR UPDATE SKIP LOCKED LIMIT 1
            ) UPDATE ownware.source_data_view_jobs j
              SET claim_token = $2, claimed_by = $3, lease_expires_at = $4, updated_at = $1
              FROM candidate WHERE j.job_id = candidate.job_id RETURNING j.*
          `, [now, claimToken, workerId, leaseExpiresAt])
          return updated.rows[0] === undefined ? null : claim(updated.rows[0])
        }))
    },

    getClaimedTarget(jobId, claimToken, now = Date.now()) {
      return repositoryCall(context, 'source_data_views', 'getClaimedTarget', 'read_failed', async (client) => {
        const result = await client.query<{
          readonly source_id: string
          readonly source_version_id: string
          readonly data_view_id: string
          readonly object_key: string
          readonly byte_count: string
          readonly checksum: string
        }>(`
          SELECT j.source_id, j.source_version_id, j.data_view_id,
            v.object_key, v.byte_count, v.checksum
          FROM ownware.source_data_view_jobs j JOIN ownware.source_versions v
            ON v.source_version_id = j.source_version_id AND v.source_id = j.source_id
          WHERE j.job_id = $1 AND j.claim_token = $2 AND j.state = 'running'
            AND j.lease_expires_at >= $3
        `, [jobId, claimToken, now])
        const row = result.rows[0]
        return row === undefined ? null : {
          objectKey: row.object_key,
          expectedByteCount: safeInteger(row.byte_count),
          expectedChecksum: row.checksum,
          sourceId: row.source_id,
          sourceVersionId: row.source_version_id,
          dataViewId: row.data_view_id,
        } satisfies ClaimedSourceDataViewTarget
      })
    },

    renewClaim(jobId, claimToken, now = Date.now()) {
      return repositoryCall(context, 'source_data_views', 'renewClaim', 'write_failed', async (client) => {
        const updated = await client.query(`
          UPDATE ownware.source_data_view_jobs SET lease_expires_at = $1, updated_at = $2
          WHERE job_id = $3 AND claim_token = $4
            AND state IN ('running', 'cancel_requested') AND lease_expires_at >= $2
        `, [now + SOURCE_DATA_VIEW_JOB_LEASE_MS, now, jobId, claimToken])
        return updated.rowCount === 1
      })
    },

    advanceCheckpoint(jobId, claimToken, expected, next, now = Date.now()) {
      return repositoryCall(context, 'source_data_views', 'advanceCheckpoint', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const selected = await client.query<JobRow>(`
            SELECT * FROM ownware.source_data_view_jobs WHERE job_id = $1 FOR UPDATE
          `, [jobId])
          const row = selected.rows[0]
          if (row === undefined || row.claim_token !== claimToken || row.state !== 'running') {
            return 'stale_claim'
          }
          if (row.lease_expires_at === null || safeInteger(row.lease_expires_at) < now) {
            return 'lease_expired'
          }
          if (safeInteger(row.checkpoint) !== expected || next !== expected + 1 || next > 3) {
            return 'checkpoint_conflict'
          }
          const updated = await client.query(`
            UPDATE ownware.source_data_view_jobs SET checkpoint = $1, updated_at = $2
            WHERE job_id = $3 AND claim_token = $4 AND state = 'running'
              AND checkpoint = $5 AND lease_expires_at >= $2
          `, [next, now, jobId, claimToken, expected])
          return updated.rowCount === 1 ? 'advanced' : 'stale_claim'
        }))
    },

    publish(jobId, claimToken, artifact, now = Date.now()) {
      if (!validArtifactShape(artifact)) return Promise.resolve('state_conflict')
      return repositoryCall(context, 'source_data_views', 'publish', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const selected = await client.query<JobRow & {
            readonly version_checksum: string
            readonly current_revision: string
            readonly current_version_id: string | null
            readonly classification: SourceDataViewManifest['classification']
            readonly authority: SourceDataViewManifest['authority'] | 'excluded'
            readonly audience_policy_ref: string
            readonly sensitivity_policy_ref: string
            readonly purpose_policy_ref: string
            readonly retention_policy_ref: string
            readonly freshness_policy_ref: string
            readonly deletion_state: string
          }>(`
            SELECT j.*, v.checksum AS version_checksum, s.revision AS current_revision,
              s.current_version_id, s.classification, s.authority,
              s.audience_policy_ref, s.sensitivity_policy_ref, s.purpose_policy_ref,
              s.retention_policy_ref, s.freshness_policy_ref, s.deletion_state
            FROM ownware.source_data_view_jobs j JOIN ownware.source_versions v
              ON v.source_version_id = j.source_version_id AND v.source_id = j.source_id
            JOIN ownware.runtime_sources s ON s.source_id = j.source_id
            WHERE j.job_id = $1 FOR UPDATE OF j, v, s
          `, [jobId])
          const row = selected.rows[0]
          if (row === undefined || row.claim_token !== claimToken || row.state !== 'running') {
            return 'stale_claim'
          }
          if (row.lease_expires_at === null || safeInteger(row.lease_expires_at) < now) {
            return 'lease_expired'
          }
          if (safeInteger(row.checkpoint) !== 3) return 'checkpoint_incomplete'
          if (row.authority === 'excluded' || row.deletion_state !== 'active' ||
              !artifactMatches(row, artifact.manifest, artifact.privateObjectKey)) {
            return 'state_conflict'
          }
          const isCurrent = row.current_version_id === row.source_version_id &&
            safeInteger(row.current_revision) === safeInteger(row.source_revision)
          await client.query(`
            INSERT INTO ownware.source_data_views (
              data_view_id, job_id, workspace_id, profile_id, source_id,
              source_version_id, implementation_version, source_revision,
              source_checksum, artifact_checksum, artifact_byte_count,
              private_object_key, field_count, row_count, fields_json,
              classification, authority, audience_policy_ref, sensitivity_policy_ref,
              purpose_policy_ref, retention_policy_ref, freshness_policy_ref,
              freshness, created_at, stale_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
              $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
          `, [
            row.data_view_id, row.job_id, row.workspace_id, row.profile_id, row.source_id,
            row.source_version_id, CSV_DATA_VIEW_IMPLEMENTATION, safeInteger(row.source_revision),
            row.version_checksum, artifact.manifest.artifactChecksum,
            artifact.manifest.artifactByteCount, artifact.privateObjectKey,
            artifact.manifest.fieldCount, artifact.manifest.rowCount,
            JSON.stringify(artifact.manifest.fields), row.classification, row.authority,
            row.audience_policy_ref, row.sensitivity_policy_ref, row.purpose_policy_ref,
            row.retention_policy_ref, row.freshness_policy_ref,
            isCurrent ? 'current' : 'stale', now, isCurrent ? null : now,
          ])
          const finished = await client.query(`
            UPDATE ownware.source_data_view_jobs SET state = 'succeeded', checkpoint = 4,
              outcome_code = 'preparation_complete', claim_token = NULL, claimed_by = NULL,
              lease_expires_at = NULL, updated_at = $1, terminal_at = $1
            WHERE job_id = $2 AND claim_token = $3 AND state = 'running'
              AND checkpoint = 3 AND lease_expires_at >= $1
          `, [now, jobId, claimToken])
          if (finished.rowCount !== 1) throw new Error('source Data View claim changed')
          await client.query(`
            UPDATE ownware.source_versions SET preparation_state = 'ready'
            WHERE source_version_id = $1 AND source_id = $2
          `, [row.source_version_id, row.source_id])
          if (isCurrent) {
            await client.query(`
              UPDATE ownware.runtime_sources SET preparation_state = 'ready', updated_at = $1
              WHERE source_id = $2 AND current_version_id = $3
                AND revision = $4 AND deletion_state = 'active'
            `, [now, row.source_id, row.source_version_id, safeInteger(row.source_revision)])
          }
          return 'finished'
        }))
    },

    deferUntil(jobId, claimToken, retryAfter, now = Date.now()) {
      return repositoryCall(context, 'source_data_views', 'deferUntil', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const selected = await client.query<JobRow>(`
            SELECT * FROM ownware.source_data_view_jobs WHERE job_id = $1 FOR UPDATE
          `, [jobId])
          const row = selected.rows[0]
          if (row === undefined || row.claim_token !== claimToken || row.state !== 'running') {
            return 'stale_claim'
          }
          if (row.lease_expires_at === null || safeInteger(row.lease_expires_at) < now) {
            return 'lease_expired'
          }
          const updated = await client.query(`
            UPDATE ownware.source_data_view_jobs SET state = 'waiting_for_resource',
              claim_token = NULL, claimed_by = NULL, lease_expires_at = NULL,
              retry_after = $1, updated_at = $2
            WHERE job_id = $3 AND claim_token = $4 AND state = 'running'
              AND lease_expires_at >= $2
          `, [retryAfter, now, jobId, claimToken])
          if (updated.rowCount !== 1) return 'stale_claim'
          await setPreparationState(client, row.source_id, row.source_version_id, 'queued', now)
          return 'deferred'
        }))
    },

    finishFailed(jobId, claimToken, outcomeCode, now = Date.now()) {
      if (!/^[a-z0-9_]{1,64}$/.test(outcomeCode)) return Promise.resolve('state_conflict')
      return repositoryCall(context, 'source_data_views', 'finishFailed', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const selected = await client.query<JobRow>(`
            SELECT * FROM ownware.source_data_view_jobs WHERE job_id = $1 FOR UPDATE
          `, [jobId])
          const row = selected.rows[0]
          if (row === undefined || row.claim_token !== claimToken || row.state !== 'running') {
            return 'stale_claim'
          }
          if (row.lease_expires_at === null || safeInteger(row.lease_expires_at) < now) {
            return 'lease_expired'
          }
          const updated = await client.query(`
            UPDATE ownware.source_data_view_jobs SET state = 'failed', outcome_code = $1,
              claim_token = NULL, claimed_by = NULL, lease_expires_at = NULL,
              retry_after = NULL, updated_at = $2, terminal_at = $2
            WHERE job_id = $3 AND claim_token = $4 AND state = 'running'
              AND lease_expires_at >= $2
          `, [outcomeCode, now, jobId, claimToken])
          if (updated.rowCount !== 1) return 'stale_claim'
          await setPreparationState(client, row.source_id, row.source_version_id, 'failed', now)
          return 'finished'
        }))
    },

    confirmCancelled(jobId, claimToken, now = Date.now()) {
      return repositoryCall(context, 'source_data_views', 'confirmCancelled', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const selected = await client.query<JobRow>(`
            SELECT * FROM ownware.source_data_view_jobs WHERE job_id = $1 FOR UPDATE
          `, [jobId])
          const row = selected.rows[0]
          if (row === undefined || row.state !== 'cancel_requested') return 'state_conflict'
          if (row.claim_token !== claimToken) return 'stale_claim'
          if (row.lease_expires_at === null || safeInteger(row.lease_expires_at) < now) {
            return 'lease_expired'
          }
          await setPreparationState(client, row.source_id, row.source_version_id, 'not_requested', now)
          const updated = await client.query(`
            UPDATE ownware.source_data_view_jobs SET state = 'cancelled', claim_token = NULL,
              claimed_by = NULL, lease_expires_at = NULL, retry_after = NULL,
              outcome_code = 'cancelled', updated_at = $1, terminal_at = $1
            WHERE job_id = $2 AND state = 'cancel_requested' AND claim_token = $3
              AND lease_expires_at >= $1
          `, [now, jobId, claimToken])
          return updated.rowCount === 1 ? 'cancelled' : 'stale_claim'
        }))
    },

    fenceUnpublishedArtifactCleanup(jobId, claimToken, dataViewId, now = Date.now()) {
      return repositoryCall(context, 'source_data_views', 'fenceUnpublishedArtifactCleanup', 'write_failed', async (client) => {
        const updated = await client.query(`
          UPDATE ownware.source_data_view_jobs j
          SET lease_expires_at = $1, updated_at = $2
          WHERE j.job_id = $3 AND j.claim_token = $4 AND j.data_view_id = $5
            AND j.state IN ('running', 'cancel_requested') AND j.lease_expires_at >= $2
            AND NOT EXISTS (SELECT 1 FROM ownware.source_data_views v
              WHERE v.job_id = j.job_id AND v.data_view_id = j.data_view_id)
        `, [now + SOURCE_DATA_VIEW_JOB_LEASE_MS, now, jobId, claimToken, dataViewId])
        return updated.rowCount === 1
      })
    },

    recoverExpiredClaims(now = Date.now()) {
      return repositoryCall(context, 'source_data_views', 'recoverExpiredClaims', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const expired = await client.query<JobRow>(`
            SELECT * FROM ownware.source_data_view_jobs
            WHERE state = 'running' AND lease_expires_at < $1
            ORDER BY created_at, job_id FOR UPDATE SKIP LOCKED
          `, [now])
          let requeued = 0
          let failed = 0
          for (const row of expired.rows) {
            const exhausted = safeInteger(row.attempt) >= safeInteger(row.max_attempts)
            const updated = await client.query(`
              UPDATE ownware.source_data_view_jobs SET state = $1, claim_token = NULL,
                claimed_by = NULL, lease_expires_at = NULL, retry_after = NULL,
                outcome_code = $2, updated_at = $3, terminal_at = $4
              WHERE job_id = $5 AND claim_token = $6 AND lease_expires_at < $3
            `, [
              exhausted ? 'failed' : 'queued', exhausted ? 'attempts_exhausted' : null,
              now, exhausted ? now : null, row.job_id, row.claim_token,
            ])
            if (updated.rowCount !== 1) continue
            if (exhausted) failed += 1
            else requeued += 1
            await setPreparationState(
              client,
              row.source_id,
              row.source_version_id,
              exhausted ? 'failed' : 'queued',
              now,
            )
          }
          return { requeued, failed }
        }))
    },

    getViewScoped(dataViewId, workspaceId, profileId) {
      if (!UUID.test(dataViewId) || !SCOPE.test(workspaceId) || !SCOPE.test(profileId)) {
        return Promise.resolve(null)
      }
      return repositoryCall(context, 'source_data_views', 'getViewScoped', 'read_failed', async (client) => {
        const result = await client.query<ViewRow>(`${VIEW_SELECT}
          WHERE dv.data_view_id = $1 AND dv.workspace_id = $2 AND dv.profile_id = $3
            AND s.registration_state = 'registered' AND s.deletion_state = 'active'
            AND sv.checksum = dv.source_checksum
            AND j.state = 'succeeded' AND j.checkpoint = 4
            AND j.outcome_code = 'preparation_complete' AND j.terminal_at IS NOT NULL
            AND ((dv.freshness = 'current' AND s.current_version_id = dv.source_version_id)
              OR dv.freshness = 'stale')
        `, [dataViewId, workspaceId, profileId])
        return result.rows[0] === undefined ? null : projectView(result.rows[0])
      })
    },

    getProtectedSelectionTargetScoped(dataViewId, workspaceId, profileId) {
      if (!UUID.test(dataViewId) || !SCOPE.test(workspaceId) || !SCOPE.test(profileId)) {
        return Promise.resolve(null)
      }
      return repositoryCall(context, 'source_data_views', 'getProtectedSelectionTargetScoped', 'read_failed', async (client) => {
        const result = await client.query<ViewRow>(`${VIEW_SELECT}
          WHERE dv.data_view_id = $1 AND dv.workspace_id = $2 AND dv.profile_id = $3
            AND dv.freshness = 'current' AND dv.stale_at IS NULL
            AND s.revision = dv.source_revision AND s.current_version_id = dv.source_version_id
            AND s.registration_state = 'registered' AND s.inspection_state = 'complete'
            AND s.preparation_state = 'ready' AND s.access_state = 'available'
            AND s.freshness_state = 'fresh' AND s.conflict_state IN ('none', 'resolved')
            AND s.deletion_state = 'active' AND s.classification = dv.classification
            AND s.authority = dv.authority
            AND s.audience_policy_ref = dv.audience_policy_ref
            AND s.sensitivity_policy_ref = dv.sensitivity_policy_ref
            AND s.purpose_policy_ref = dv.purpose_policy_ref
            AND s.retention_policy_ref = dv.retention_policy_ref
            AND s.freshness_policy_ref = dv.freshness_policy_ref
            AND sv.checksum = dv.source_checksum AND sv.inspection_state = 'complete'
            AND sv.preparation_state = 'ready' AND j.state = 'succeeded'
            AND j.checkpoint = 4 AND j.outcome_code = 'preparation_complete'
            AND j.terminal_at IS NOT NULL
        `, [dataViewId, workspaceId, profileId])
        const row = result.rows[0]
        if (row === undefined) return null
        const manifest = projectView(row)
        if (manifest === null || manifest.freshness !== 'current') return null
        const expectedObjectKey = `sources/${manifest.sourceId}/versions/` +
          `${manifest.sourceVersionId}/data-views/${manifest.dataViewId}.json`
        if (row.private_object_key !== expectedObjectKey) return null
        return {
          workspaceId,
          profileId,
          manifest: manifest as SourceDataViewManifest & { readonly freshness: 'current' },
          privateObjectKey: row.private_object_key,
        }
      })
    },

    getPrivateArtifact(dataViewId, workspaceId, profileId) {
      return repositoryCall(context, 'source_data_views', 'getPrivateArtifact', 'read_failed', async (client) => {
        const result = await client.query<{
          readonly private_object_key: string
          readonly artifact_checksum: string
          readonly artifact_byte_count: string
        }>(`
          SELECT private_object_key, artifact_checksum, artifact_byte_count
          FROM ownware.source_data_views
          WHERE data_view_id = $1 AND workspace_id = $2 AND profile_id = $3
        `, [dataViewId, workspaceId, profileId])
        const row = result.rows[0]
        return row === undefined ? null : {
          privateObjectKey: row.private_object_key,
          artifactChecksum: row.artifact_checksum,
          artifactByteCount: safeInteger(row.artifact_byte_count),
        }
      })
    },
  }
}

const VIEW_SELECT = `
  SELECT dv.* FROM ownware.source_data_views dv
  JOIN ownware.runtime_sources s ON s.source_id = dv.source_id
    AND s.workspace_id = dv.workspace_id AND s.profile_id = dv.profile_id
  JOIN ownware.source_versions sv ON sv.source_version_id = dv.source_version_id
    AND sv.source_id = dv.source_id
  JOIN ownware.source_data_view_jobs j ON j.job_id = dv.job_id
    AND j.data_view_id = dv.data_view_id AND j.workspace_id = dv.workspace_id
    AND j.profile_id = dv.profile_id AND j.source_id = dv.source_id
    AND j.source_version_id = dv.source_version_id
    AND j.implementation_version = dv.implementation_version
    AND j.source_revision = dv.source_revision
`

function validArtifactShape(artifact: PreparedCsvDataViewArtifact): boolean {
  const manifest = artifact.manifest
  const headerKeys = new Set<string>()
  return UUID.test(manifest.dataViewId) && UUID.test(manifest.sourceVersionId) &&
    CHECKSUM.test(manifest.sourceChecksum) && CHECKSUM.test(manifest.artifactChecksum) &&
    Number.isSafeInteger(manifest.artifactByteCount) && manifest.artifactByteCount >= 1 &&
    manifest.artifactByteCount <= CSV_DATA_VIEW_ARTIFACT_MAX_BYTES &&
    manifest.implementationVersion === CSV_DATA_VIEW_IMPLEMENTATION &&
    manifest.fieldCount === manifest.fields.length && manifest.fieldCount >= 1 &&
    manifest.fieldCount <= CSV_DATA_VIEW_MAX_FIELDS && Number.isSafeInteger(manifest.rowCount) &&
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
    privateObjectKey === `sources/${row.source_id}/versions/${row.source_version_id}` +
      `/data-views/${row.data_view_id}.json`
}

function projectView(row: ViewRow): SourceDataViewManifest | null {
  let rawFields: unknown
  try {
    rawFields = JSON.parse(row.fields_json)
  } catch {
    return null
  }
  if (!Array.isArray(rawFields)) return null
  const fields: CsvDataViewField[] = []
  const headerKeys = new Set<string>()
  for (const [ordinal, raw] of rawFields.entries()) {
    if (!isRecord(raw) || typeof raw['fieldId'] !== 'string' || raw['ordinal'] !== ordinal ||
        typeof raw['label'] !== 'string') return null
    const key = raw['label'].trim().normalize('NFKC').toLowerCase()
    if (!key || headerKeys.has(key) || Buffer.byteLength(raw['label']) > CSV_DATA_VIEW_MAX_CELL_BYTES ||
        raw['fieldId'] !== csvDataViewOrdinalId('field', row.source_version_id, ordinal)) return null
    headerKeys.add(key)
    fields.push({ fieldId: raw['fieldId'], ordinal, label: raw['label'] })
  }
  let manifest: SourceDataViewManifest
  try {
    manifest = {
      dataViewId: row.data_view_id,
      jobId: row.job_id,
      sourceId: row.source_id,
      sourceVersionId: row.source_version_id,
      implementationVersion: CSV_DATA_VIEW_IMPLEMENTATION,
      sourceRevision: safeInteger(row.source_revision),
      sourceChecksum: row.source_checksum,
      artifactChecksum: row.artifact_checksum,
      artifactByteCount: safeInteger(row.artifact_byte_count),
      fieldCount: safeInteger(row.field_count),
      rowCount: safeInteger(row.row_count),
      fields,
      classification: row.classification,
      authority: row.authority,
      audiencePolicyRef: row.audience_policy_ref,
      sensitivityPolicyRef: row.sensitivity_policy_ref,
      purposePolicyRef: row.purpose_policy_ref,
      retentionPolicyRef: row.retention_policy_ref,
      freshnessPolicyRef: row.freshness_policy_ref,
      freshness: row.freshness,
      createdAt: safeInteger(row.created_at),
      staleAt: nullableSafeInteger(row.stale_at),
    }
  } catch {
    return null
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
    POLICY_REF.test(manifest.audiencePolicyRef) && POLICY_REF.test(manifest.sensitivityPolicyRef) &&
    POLICY_REF.test(manifest.purposePolicyRef) && POLICY_REF.test(manifest.retentionPolicyRef) &&
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
