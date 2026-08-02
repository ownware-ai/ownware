import { randomUUID } from 'node:crypto'
import type { EvidenceSearchCache } from '../gateway/evidence-search-cache.js'
import type { SourceMediaType } from '../gateway/source-media.js'
import {
  SourceQuotaExceededError,
  type SourceQuotaCeilings,
  type SourceQuotaGrowth,
  type SourceQuotaLimits,
} from '../gateway/source-quota-policy.js'
import {
  SOURCE_UPLOAD_MAX_CHUNKS,
  SOURCE_UPLOAD_MAX_CHUNK_BYTES,
  SOURCE_UPLOAD_TTL_MS,
  SourceUploadRefreshConflictError,
  SourceUploadTargetNotFoundError,
  type CurrentSourceIdentity,
  type ScopedSourceUpload,
  type SourceUploadCheckpoint,
  type SourceUploadChunkRecord,
  type SourceUploadSession,
  type SourceVersionManifest,
} from '../gateway/source-upload-store.js'
import type {
  PendingSourceManifest,
  SourceManifest,
} from '../gateway/source-store.js'
import type {
  SourceRepository,
  SourceUploadRepository,
} from './source-repositories.js'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import type { PostgreSqlQueryClient } from './postgresql-repository.js'
import {
  encodePostgreSqlTextKey,
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from './postgresql-repository.js'

interface UsageRow {
  readonly source_registrations: string
  readonly retained_and_reserved_bytes: string
  readonly active_upload_sessions: string
  readonly nonterminal_jobs: string
  readonly derived_resources: string
}

export async function lockPostgreSqlSourceQuotaScope(
  client: PostgreSqlQueryClient,
  workspaceId: string,
  profileId: string,
): Promise<void> {
  // Workspace ceilings are shared by every profile, so every quota mutation in
  // a workspace must first serialize on the same authority. Always acquire the
  // narrower profile lock second so callers cannot form an inverted lock order.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1397837649))', [
    encodePostgreSqlTextKey(`workspace\0${workspaceId}`),
  ])
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1397837649))', [
    encodePostgreSqlTextKey(`profile\0${workspaceId}\0${profileId}`),
  ])
}

async function quotaUsage(
  client: PostgreSqlQueryClient,
  workspaceId: string,
  profileId: string | null,
): Promise<UsageRow> {
  const result = await client.query<UsageRow>(`
    WITH scoped_sources AS (
      SELECT source_id FROM ownware.runtime_sources
      WHERE workspace_id = $1 AND ($2::text IS NULL OR profile_id = $2)
    ), derived_slots AS (
      SELECT resource_id FROM ownware.source_derived_resources
      WHERE workspace_id = $1 AND ($2::text IS NULL OR profile_id = $2)
      UNION SELECT resource_id FROM ownware.source_jobs
      WHERE workspace_id = $1 AND ($2::text IS NULL OR profile_id = $2)
        AND operation = 'extract_text' AND resource_id IS NOT NULL
        AND state IN ('queued', 'running', 'waiting_for_resource', 'cancel_requested')
      UNION SELECT data_view_id FROM ownware.source_data_views
      WHERE workspace_id = $1 AND ($2::text IS NULL OR profile_id = $2)
      UNION SELECT data_view_id FROM ownware.source_data_view_jobs
      WHERE workspace_id = $1 AND ($2::text IS NULL OR profile_id = $2)
        AND state IN ('queued', 'running', 'waiting_for_resource', 'cancel_requested')
    ) SELECT
      (SELECT COUNT(*) FROM ownware.runtime_sources WHERE workspace_id = $1
        AND ($2::text IS NULL OR profile_id = $2) AND deletion_state <> 'deleted') AS source_registrations,
      COALESCE((SELECT SUM(v.byte_count) FROM ownware.source_versions v
        JOIN scoped_sources s ON s.source_id = v.source_id), 0)
        + COALESCE((SELECT SUM(expected_bytes) FROM ownware.source_upload_sessions
          WHERE workspace_id = $1 AND ($2::text IS NULL OR profile_id = $2)
            AND byte_reservation_released_at IS NULL), 0) AS retained_and_reserved_bytes,
      (SELECT COUNT(*) FROM ownware.source_upload_sessions WHERE workspace_id = $1
        AND ($2::text IS NULL OR profile_id = $2) AND state IN ('open', 'completing')) AS active_upload_sessions,
      (SELECT COUNT(*) FROM ownware.source_jobs WHERE workspace_id = $1
        AND ($2::text IS NULL OR profile_id = $2)
        AND state IN ('queued', 'running', 'waiting_for_resource', 'cancel_requested'))
        + (SELECT COUNT(*) FROM ownware.source_data_view_jobs WHERE workspace_id = $1
          AND ($2::text IS NULL OR profile_id = $2)
          AND state IN ('queued', 'running', 'waiting_for_resource', 'cancel_requested')) AS nonterminal_jobs,
      (SELECT COUNT(*) FROM derived_slots) AS derived_resources
  `, [workspaceId, profileId])
  const row = result.rows[0]
  if (row === undefined) throw new Error('source quota usage is unavailable')
  return row
}

function assertWithin(row: UsageRow, growth: SourceQuotaGrowth, limits: SourceQuotaCeilings): void {
  const checks = [
    ['source_registrations', safeInteger(row.source_registrations), growth.sourceRegistrations ?? 0, limits.maxSourceRegistrations],
    ['source_storage_bytes', safeInteger(row.retained_and_reserved_bytes), growth.retainedAndReservedBytes ?? 0, limits.maxRetainedAndReservedBytes],
    ['source_upload_sessions', safeInteger(row.active_upload_sessions), growth.activeUploadSessions ?? 0, limits.maxActiveUploadSessions],
    ['source_jobs', safeInteger(row.nonterminal_jobs), growth.nonterminalJobs ?? 0, limits.maxNonterminalJobs],
    ['source_derived_resources', safeInteger(row.derived_resources), growth.derivedResources ?? 0, limits.maxDerivedResources],
  ] as const
  for (const [resource, used, added, limit] of checks) {
    if (added > 0 && used + added > limit) throw new SourceQuotaExceededError(resource)
  }
}

export async function assertPostgreSqlSourceQuota(
  client: PostgreSqlQueryClient,
  limits: SourceQuotaLimits,
  scope: { readonly workspaceId: string; readonly profileId: string },
  growth: SourceQuotaGrowth,
): Promise<void> {
  await lockPostgreSqlSourceQuotaScope(client, scope.workspaceId, scope.profileId)
  assertWithin(await quotaUsage(client, scope.workspaceId, null), growth, limits.workspace)
  assertWithin(await quotaUsage(client, scope.workspaceId, scope.profileId), growth, limits.profile)
}

interface SourceRow {
  readonly source_id: string
  readonly kind: SourceManifest['kind']
  readonly label: string
  readonly classification: SourceManifest['classification']
  readonly authority: SourceManifest['authority']
  readonly audience_policy_ref: string
  readonly sensitivity_policy_ref: string
  readonly purpose_policy_ref: string
  readonly retention_policy_ref: string
  readonly freshness_policy_ref: string
  readonly revision: string
  readonly current_version_id: string | null
  readonly registration_state: SourceManifest['health']['registration']
  readonly inspection_state: SourceManifest['health']['inspection']
  readonly preparation_state: SourceManifest['health']['preparation']
  readonly access_state: SourceManifest['health']['access']
  readonly freshness_state: SourceManifest['health']['freshness']
  readonly conflict_state: SourceManifest['health']['conflict']
  readonly deletion_state: SourceManifest['health']['deletion']
  readonly created_at: string
  readonly updated_at: string
}

function source(row: SourceRow): SourceManifest {
  return {
    sourceId: row.source_id,
    kind: row.kind,
    label: row.label,
    classification: row.classification,
    authority: row.authority,
    audiencePolicyRef: row.audience_policy_ref,
    sensitivityPolicyRef: row.sensitivity_policy_ref,
    purposePolicyRef: row.purpose_policy_ref,
    retentionPolicyRef: row.retention_policy_ref,
    freshnessPolicyRef: row.freshness_policy_ref,
    revision: safeInteger(row.revision),
    currentVersionId: row.current_version_id,
    health: {
      registration: row.registration_state,
      inspection: row.inspection_state,
      preparation: row.preparation_state,
      access: row.access_state,
      freshness: row.freshness_state,
      conflict: row.conflict_state,
      deletion: row.deletion_state,
    },
    createdAt: safeInteger(row.created_at),
    updatedAt: safeInteger(row.updated_at),
  }
}

export function createPostgreSqlSourceRepository(
  context: PostgreSqlRootRepositoryContext,
  limits: SourceQuotaLimits,
): SourceRepository {
  return {
    create(input, now = Date.now()) {
      return repositoryCall(context, 'sources', 'create', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          await assertPostgreSqlSourceQuota(client, limits, input, { sourceRegistrations: 1 })
          const sourceId = randomUUID()
          const result = await client.query<SourceRow>(`
            INSERT INTO ownware.runtime_sources (
              source_id, workspace_id, profile_id, kind, label, classification,
              authority, audience_policy_ref, sensitivity_policy_ref, purpose_policy_ref,
              retention_policy_ref, freshness_policy_ref, revision, current_version_id,
              registration_state, inspection_state, preparation_state, access_state,
              freshness_state, conflict_state, deletion_state, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1,
              NULL, 'pending', 'not_started', 'not_requested', 'available', 'unknown',
              'none', 'active', $13, $13) RETURNING *
          `, [
            sourceId, input.workspaceId, input.profileId, input.kind, input.label,
            input.classification, input.authority, input.audiencePolicyRef,
            input.sensitivityPolicyRef, input.purposePolicyRef, input.retentionPolicyRef,
            input.freshnessPolicyRef, now,
          ])
          return source(result.rows[0]!) as PendingSourceManifest
        }))
    },
    getScoped(sourceId, workspaceId, profileId) {
      return repositoryCall(context, 'sources', 'getScoped', 'read_failed', async (client) => {
        const result = await client.query<SourceRow>(`
          SELECT * FROM ownware.runtime_sources
          WHERE source_id = $1 AND workspace_id = $2 AND profile_id = $3
        `, [sourceId, workspaceId, profileId])
        return result.rows[0] === undefined ? null : source(result.rows[0])
      })
    },
    listScoped(workspaceId, profileId, options) {
      return repositoryCall(context, 'sources', 'listScoped', 'read_failed', async (client) => {
        const result = await client.query<SourceRow>(`
          SELECT * FROM ownware.runtime_sources WHERE workspace_id = $1 AND profile_id = $2
            AND ($3::text IS NULL OR source_id > $3) ORDER BY source_id ASC LIMIT $4
        `, [workspaceId, profileId, options.cursor ?? null, options.limit + 1])
        const more = result.rows.length > options.limit
        const rows = result.rows.slice(0, options.limit)
        return { items: rows.map(source), nextCursor: more ? rows.at(-1)!.source_id : null }
      })
    },
  }
}

interface UploadRow {
  readonly upload_id: string
  readonly source_id: string
  readonly state: ScopedSourceUpload['state']
  readonly workspace_id: string
  readonly profile_id: string
  readonly principal_key: string
  readonly durable_offset: string
  readonly chunk_count: string
  readonly expected_bytes: string
  readonly expected_checksum: string
  readonly declared_media_type: SourceMediaType
  readonly max_chunk_bytes: string
  readonly max_chunks: string
  readonly expires_at: string
  readonly created_at: string
  readonly pending_version_id: string | null
  readonly completed_version_id: string | null
  readonly code: string | null
  readonly base_source_revision: string
  readonly base_current_version_id: string | null
}

function scopedUpload(row: UploadRow): ScopedSourceUpload {
  return {
    uploadId: row.upload_id, sourceId: row.source_id, state: row.state,
    offset: safeInteger(row.durable_offset), chunkCount: safeInteger(row.chunk_count),
    expectedBytes: safeInteger(row.expected_bytes), expectedChecksum: row.expected_checksum,
    declaredMediaType: row.declared_media_type, expiresAt: safeInteger(row.expires_at),
    pendingVersionId: row.pending_version_id, completedVersionId: row.completed_version_id,
    baseSourceRevision: safeInteger(row.base_source_revision),
    baseCurrentVersionId: row.base_current_version_id, code: row.code,
  }
}

interface VersionRow {
  readonly source_version_id: string
  readonly source_id: string
  readonly checksum: string
  readonly verified_media_type: SourceMediaType
  readonly byte_count: string
  readonly inspection_state: SourceVersionManifest['inspection']
  readonly created_at: string
}

function version(row: VersionRow): SourceVersionManifest {
  return {
    sourceVersionId: row.source_version_id, sourceId: row.source_id,
    checksum: row.checksum, verifiedMediaType: row.verified_media_type,
    byteCount: safeInteger(row.byte_count), inspection: row.inspection_state,
    createdAt: safeInteger(row.created_at),
  }
}

export function createPostgreSqlSourceUploadRepository(
  context: PostgreSqlRootRepositoryContext,
  limits: SourceQuotaLimits,
  evidenceSearchCache?: EvidenceSearchCache,
): SourceUploadRepository {
  return {
    create(input, now = Date.now()) {
      return repositoryCall(context, 'source_uploads', 'create', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          await lockPostgreSqlSourceQuotaScope(client, input.workspaceId, input.profileId)
          const target = await client.query<{ readonly revision: string; readonly current_version_id: string | null }>(`
            SELECT revision, current_version_id FROM ownware.runtime_sources
            WHERE source_id = $1 AND workspace_id = $2 AND profile_id = $3
              AND deletion_state = 'active' FOR SHARE
          `, [input.sourceId, input.workspaceId, input.profileId])
          const sourceRow = target.rows[0]
          if (sourceRow === undefined) throw new SourceUploadTargetNotFoundError()
          await assertPostgreSqlSourceQuota(client, limits, input, {
            retainedAndReservedBytes: input.expectedBytes, activeUploadSessions: 1,
          })
          const uploadId = randomUUID()
          const expiresAt = now + SOURCE_UPLOAD_TTL_MS
          const inserted = await client.query<UploadRow>(`
            INSERT INTO ownware.source_upload_sessions (
              upload_id, source_id, workspace_id, profile_id, principal_key, state,
              expected_bytes, expected_checksum, declared_media_type, filename,
              durable_offset, chunk_count, max_chunk_bytes, max_chunks, pending_version_id,
              completed_version_id, code, expires_at, created_at, updated_at,
              base_source_revision, base_current_version_id
            ) VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $9, 0, 0, $10,
              $11, NULL, NULL, NULL, $12, $13, $13, $14, $15) RETURNING *
          `, [
            uploadId, input.sourceId, input.workspaceId, input.profileId,
            encodePostgreSqlTextKey(input.principalKey),
            input.expectedBytes, input.expectedChecksum, input.declaredMediaType, input.filename,
            SOURCE_UPLOAD_MAX_CHUNK_BYTES, SOURCE_UPLOAD_MAX_CHUNKS, expiresAt, now,
            safeInteger(sourceRow.revision), sourceRow.current_version_id,
          ])
          const row = inserted.rows[0]!
          const response: SourceUploadSession = {
            uploadId: row.upload_id, sourceId: row.source_id, state: 'open', offset: 0,
            expectedBytes: safeInteger(row.expected_bytes), expectedChecksum: row.expected_checksum,
            declaredMediaType: row.declared_media_type,
            maxChunkBytes: SOURCE_UPLOAD_MAX_CHUNK_BYTES, maxChunks: SOURCE_UPLOAD_MAX_CHUNKS,
            expiresAt: safeInteger(row.expires_at), createdAt: safeInteger(row.created_at),
          }
          return response
        }))
    },
    listOpenCheckpoints() {
      return repositoryCall(context, 'source_uploads', 'listOpenCheckpoints', 'read_failed', async (client) => {
        const result = await client.query<{ readonly upload_id: string; readonly durable_offset: string }>(`
          SELECT upload_id, durable_offset FROM ownware.source_upload_sessions
          WHERE state = 'open' ORDER BY upload_id
        `)
        return result.rows.map((row): SourceUploadCheckpoint => ({
          uploadId: row.upload_id, durableOffset: safeInteger(row.durable_offset),
        }))
      })
    },
    getScoped(uploadId, workspaceId, profileId, principalKey, now = Date.now()) {
      return repositoryCall(context, 'source_uploads', 'getScoped', 'write_failed', async (client) => {
        const result = await client.query<UploadRow>(`
          UPDATE ownware.source_upload_sessions SET
            state = CASE WHEN state = 'open' AND $5 > expires_at THEN 'expired' ELSE state END,
            code = CASE WHEN state = 'open' AND $5 > expires_at THEN 'upload_expired' ELSE code END,
            updated_at = CASE WHEN state = 'open' AND $5 > expires_at THEN $5 ELSE updated_at END
          WHERE upload_id = $1 AND workspace_id = $2 AND profile_id = $3 AND principal_key = $4
          RETURNING *
        `, [
          uploadId,
          workspaceId,
          profileId,
          encodePostgreSqlTextKey(principalKey),
          now,
        ])
        return result.rows[0] === undefined ? null : scopedUpload(result.rows[0])
      })
    },
    getCurrentSourceIdentity(sourceId) {
      return repositoryCall(context, 'source_uploads', 'getCurrentSourceIdentity', 'read_failed', async (client) => {
        const result = await client.query<{ readonly revision: string; readonly current_version_id: string | null }>(`
          SELECT revision, current_version_id FROM ownware.runtime_sources WHERE source_id = $1
        `, [sourceId])
        const row = result.rows[0]
        const identity: CurrentSourceIdentity | null = row === undefined ? null : {
          revision: safeInteger(row.revision), currentVersionId: row.current_version_id,
        }
        return identity
      })
    },
    findChunk(uploadId, startOffset) {
      return repositoryCall(context, 'source_uploads', 'findChunk', 'read_failed', async (client) => {
        const result = await client.query<{
          readonly start_offset: string; readonly byte_count: string; readonly checksum: string
        }>(`
          SELECT start_offset, byte_count, checksum FROM ownware.source_upload_chunks
          WHERE upload_id = $1 AND start_offset = $2
        `, [uploadId, startOffset])
        const row = result.rows[0]
        const chunk: SourceUploadChunkRecord | null = row === undefined ? null : {
          startOffset: safeInteger(row.start_offset), byteCount: safeInteger(row.byte_count),
          checksum: row.checksum,
        }
        return chunk
      })
    },
    advanceChunk(uploadId, expectedOffset, chunk, now = Date.now()) {
      return repositoryCall(context, 'source_uploads', 'advanceChunk', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const session = await client.query<{ readonly durable_offset: string; readonly chunk_count: string }>(`
            SELECT durable_offset, chunk_count FROM ownware.source_upload_sessions
            WHERE upload_id = $1 AND state = 'open' AND expires_at >= $2 FOR UPDATE
          `, [uploadId, now])
          const row = session.rows[0]
          if (row === undefined || safeInteger(row.durable_offset) !== expectedOffset ||
            safeInteger(row.chunk_count) >= SOURCE_UPLOAD_MAX_CHUNKS) {
            throw new Error('upload chunk checkpoint conflict')
          }
          const chunkCount = safeInteger(row.chunk_count)
          await client.query(`
            INSERT INTO ownware.source_upload_chunks (
              upload_id, chunk_index, start_offset, byte_count, checksum, accepted_at
            ) VALUES ($1, $2, $3, $4, $5, $6)
          `, [uploadId, chunkCount, expectedOffset, chunk.byteCount, chunk.checksum, now])
          const offset = expectedOffset + chunk.byteCount
          const updated = await client.query(`
            UPDATE ownware.source_upload_sessions SET durable_offset = $1,
              chunk_count = chunk_count + 1, updated_at = $2
            WHERE upload_id = $3 AND state = 'open' AND durable_offset = $4
          `, [offset, now, uploadId, expectedOffset])
          if (updated.rowCount !== 1) throw new Error('upload chunk checkpoint conflict')
          return { offset, chunkCount: chunkCount + 1 }
        }))
    },
    beginCompletion(uploadId, now = Date.now()) {
      return repositoryCall(context, 'source_uploads', 'beginCompletion', 'write_failed', async (client) => {
        const versionId = randomUUID()
        const result = await client.query(`
          UPDATE ownware.source_upload_sessions SET state = 'completing',
            pending_version_id = $1, updated_at = $2
          WHERE upload_id = $3 AND state = 'open' AND durable_offset = expected_bytes
            AND expires_at >= $2
        `, [versionId, now, uploadId])
        if (result.rowCount !== 1) throw new Error('upload is not ready for completion')
        return versionId
      })
    },
    finishCompletion(uploadId, input, now = Date.now()) {
      return repositoryCall(context, 'source_uploads', 'finishCompletion', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const session = await client.query<{
            readonly source_id: string; readonly workspace_id: string; readonly profile_id: string
            readonly pending_version_id: string | null; readonly base_source_revision: string
            readonly base_current_version_id: string | null
          }>(`
            SELECT source_id, workspace_id, profile_id, pending_version_id,
              base_source_revision, base_current_version_id
            FROM ownware.source_upload_sessions WHERE upload_id = $1 AND state = 'completing'
            FOR UPDATE
          `, [uploadId])
          const row = session.rows[0]
          if (row === undefined || row.pending_version_id !== input.versionId) {
            throw new Error('upload completion checkpoint conflict')
          }
          await client.query(`
            INSERT INTO ownware.source_versions (
              source_version_id, source_id, checksum, verified_media_type,
              byte_count, object_key, inspection_state, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, 'not_started', $7)
            ON CONFLICT (source_version_id) DO NOTHING
          `, [
            input.versionId, row.source_id, input.checksum, input.verifiedMediaType,
            input.byteCount, input.objectKey, now,
          ])
          const updated = await client.query(`
            UPDATE ownware.runtime_sources SET revision = revision + 1,
              current_version_id = $1, registration_state = 'registered',
              inspection_state = 'not_started', preparation_state = 'not_requested',
              freshness_state = 'fresh', updated_at = $2
            WHERE source_id = $3 AND deletion_state = 'active' AND revision = $4
              AND current_version_id IS NOT DISTINCT FROM $5
          `, [input.versionId, now, row.source_id, safeInteger(row.base_source_revision), row.base_current_version_id])
          if (updated.rowCount !== 1) {
            const actual = await client.query<{
              readonly revision: string; readonly current_version_id: string | null; readonly deletion_state: string
            }>('SELECT revision, current_version_id, deletion_state FROM ownware.runtime_sources WHERE source_id = $1', [row.source_id])
            const value = actual.rows[0]
            if (value?.deletion_state === 'active') {
              throw new SourceUploadRefreshConflictError(safeInteger(value.revision), value.current_version_id)
            }
            throw new Error('source is not active for completion')
          }
          await client.query(`
            UPDATE ownware.source_derived_resources SET freshness = 'stale', stale_at = $1
            WHERE source_id = $2 AND source_version_id <> $3 AND freshness = 'current'
          `, [now, row.source_id, input.versionId])
          await client.query(`
            UPDATE ownware.source_data_views SET freshness = 'stale', stale_at = $1
            WHERE source_id = $2 AND source_version_id <> $3 AND freshness = 'current'
          `, [now, row.source_id, input.versionId])
          const completed = await client.query(`
            UPDATE ownware.source_upload_sessions SET state = 'completed',
              completed_version_id = $1, code = NULL, byte_reservation_released_at = $2,
              updated_at = $2 WHERE upload_id = $3 AND state = 'completing'
          `, [input.versionId, now, uploadId])
          if (completed.rowCount !== 1) throw new Error('upload completion state changed')
          evidenceSearchCache?.invalidateSource({
            workspaceId: row.workspace_id, profileId: row.profile_id, sourceId: row.source_id,
          })
          return {
            sourceVersionId: input.versionId, sourceId: row.source_id, checksum: input.checksum,
            verifiedMediaType: input.verifiedMediaType, byteCount: input.byteCount,
            inspection: 'not_started', createdAt: now,
          }
        }))
    },
    getCompletedVersion(uploadId) {
      return repositoryCall(context, 'source_uploads', 'getCompletedVersion', 'read_failed', async (client) => {
        const result = await client.query<VersionRow>(`
          SELECT v.* FROM ownware.source_upload_sessions u JOIN ownware.source_versions v
            ON v.source_version_id = u.completed_version_id
          WHERE u.upload_id = $1 AND u.state = 'completed'
        `, [uploadId])
        return result.rows[0] === undefined ? null : version(result.rows[0])
      })
    },
    getVersionScoped(sourceId, versionId, workspaceId, profileId) {
      return repositoryCall(context, 'source_uploads', 'getVersionScoped', 'read_failed', async (client) => {
        const result = await client.query<VersionRow>(`
          SELECT v.* FROM ownware.source_versions v JOIN ownware.runtime_sources s
            ON s.source_id = v.source_id WHERE v.source_version_id = $1 AND v.source_id = $2
            AND s.workspace_id = $3 AND s.profile_id = $4
        `, [versionId, sourceId, workspaceId, profileId])
        return result.rows[0] === undefined ? null : version(result.rows[0])
      })
    },
    markFailed(uploadId, code, now = Date.now()) {
      return repositoryCall(context, 'source_uploads', 'markFailed', 'write_failed', async (client) => {
        await client.query(`
          UPDATE ownware.source_upload_sessions SET state = 'failed', code = $1, updated_at = $2
          WHERE upload_id = $3 AND state IN ('open', 'completing')
        `, [code, now, uploadId])
      })
    },
    markFailedAfterVerifiedCleanup(uploadId, code, now = Date.now()) {
      return repositoryCall(context, 'source_uploads', 'markFailedAfterVerifiedCleanup', 'write_failed', async (client) => {
        await client.query(`
          UPDATE ownware.source_upload_sessions SET state = 'failed', code = $1,
            byte_reservation_released_at = $2, updated_at = $2
          WHERE upload_id = $3 AND state IN ('open', 'completing')
        `, [code, now, uploadId])
      })
    },
  }
}
