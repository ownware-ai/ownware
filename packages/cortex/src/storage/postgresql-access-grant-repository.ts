import { randomUUID } from 'node:crypto'
import {
  ACCESS_GRANT_MAX_ACTIVE_PER_SCOPE,
  ACCESS_GRANT_MAX_SCOPE_IDS,
  AccessGrantStoreError,
  isAccessGrantUuid,
  normalizeAccessGrantInputForStorage,
  normalizeImmediateAccessGrantInputForStorage,
  projectAccessGrantRowForStorage,
  validExactDataViewIdsForStorage,
  withAccessGrantLifecycleForStorage,
  type AccessGrantRevision,
  type AccessGrantStorageRow,
  type CreateAccessGrantInput,
  type DataViewQueryTargetIdentity,
  type PreparedTextReadTarget,
} from '../gateway/access-grant-store.js'
import { csvDataViewOrdinalId } from '../gateway/csv-data-view.js'
import type { EvidenceSearchCache } from '../gateway/evidence-search-cache.js'
import type { AccessGrantRepository } from './security-repositories.js'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import type { PostgreSqlQueryClient } from './postgresql-repository.js'
import {
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from './postgresql-repository.js'

const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function normalizedRow(row: AccessGrantStorageRow): AccessGrantStorageRow {
  return {
    ...row,
    revision: safeInteger(row.revision),
    effective_at: safeInteger(row.effective_at),
    expires_at: safeInteger(row.expires_at),
    revision_created_at: safeInteger(row.revision_created_at),
    revoked_at: row.revoked_at === null ? null : safeInteger(row.revoked_at),
  }
}

function project(row: AccessGrantStorageRow): AccessGrantRevision {
  return projectAccessGrantRowForStorage(normalizedRow(row))
}

async function currentGrant(
  client: PostgreSqlQueryClient,
  grantId: string,
  scope?: { readonly workspaceId: string; readonly profileId: string },
  forUpdate = false,
): Promise<AccessGrantRevision | null> {
  const values: unknown[] = [grantId]
  const scoped = scope === undefined ? '' : ' AND g.workspace_id = $2 AND g.profile_id = $3'
  if (scope !== undefined) values.push(scope.workspaceId, scope.profileId)
  const result = await client.query<AccessGrantStorageRow>(`
    SELECT r.*, g.workspace_id AS head_workspace_id, g.profile_id AS head_profile_id
    FROM ownware.access_grants g JOIN ownware.access_grant_revisions r
      ON r.grant_id = g.grant_id AND r.revision = g.current_revision
    WHERE g.grant_id = $1${scoped}${forUpdate ? ' FOR UPDATE OF g' : ''}
  `, values)
  return result.rows[0] === undefined ? null : project(result.rows[0])
}

async function insertRevision(
  client: PostgreSqlQueryClient,
  grantId: string,
  revision: number,
  state: AccessGrantRevision['state'],
  input: CreateAccessGrantInput,
  revisionCreatedAt: number,
  revokedAt: number | null,
): Promise<void> {
  await client.query(`
    INSERT INTO ownware.access_grant_revisions (
      grant_id, revision, workspace_id, profile_id, state, subject_id, purpose,
      channel, resource_kind, resource_id, operation, field_scope_mode,
      field_ids_json, row_scope_mode, row_ids_json, consent_state,
      consent_evidence_id, autonomy_ceiling, effective_at, expires_at, issued_by,
      revision_created_at, revoked_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
      $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
  `, [
    grantId, revision, input.workspaceId, input.profileId, state, input.subjectId,
    input.purpose, input.channel, input.resourceKind, input.resourceId, input.operation,
    input.fieldScope.mode,
    JSON.stringify(input.fieldScope.mode === 'list' ? input.fieldScope.ids : []),
    input.rowScope.mode,
    JSON.stringify(input.rowScope.mode === 'list' ? input.rowScope.ids : []),
    input.consent.state,
    input.consent.state === 'recorded' ? input.consent.evidenceId : null,
    input.autonomyCeiling, input.effectiveAt, input.expiresAt, input.issuedBy,
    revisionCreatedAt, revokedAt,
  ])
}

async function createGrant(
  client: PostgreSqlQueryClient,
  input: CreateAccessGrantInput,
  now: number,
  maxActive: number,
): Promise<AccessGrantRevision> {
  await client.query(`
    SELECT pg_advisory_xact_lock(hashtextextended($1, 1335664962))
  `, [`${input.workspaceId}\u001f${input.profileId}`])
  const count = await client.query<{ readonly count: string }>(`
    SELECT COUNT(*) AS count FROM ownware.access_grants g
    JOIN ownware.access_grant_revisions r
      ON r.grant_id = g.grant_id AND r.revision = g.current_revision
    WHERE g.workspace_id = $1 AND g.profile_id = $2 AND r.state = 'active'
      AND r.expires_at > $3
  `, [input.workspaceId, input.profileId, now])
  if (safeInteger(count.rows[0]?.count ?? '0') >= maxActive) {
    throw new AccessGrantStoreError('access_grant_limit_exceeded')
  }
  const grantId = randomUUID()
  await client.query(`
    INSERT INTO ownware.access_grants (
      grant_id, workspace_id, profile_id, current_revision, created_at
    ) VALUES ($1, $2, $3, 1, $4)
  `, [grantId, input.workspaceId, input.profileId, now])
  await insertRevision(client, grantId, 1, 'active', input, now, null)
  const result = await currentGrant(client, grantId, {
    workspaceId: input.workspaceId,
    profileId: input.profileId,
  })
  if (result === null) throw new Error('access grant was not created')
  return result
}

interface PreparedTargetRow {
  readonly workspace_id: string
  readonly profile_id: string
  readonly resource_id: string
  readonly job_id: string
  readonly source_id: string
  readonly source_version_id: string
  readonly source_revision: string
  readonly object_key: string
  readonly byte_count: string
  readonly checksum: string
  readonly classification: PreparedTextReadTarget['classification']
  readonly authority: PreparedTextReadTarget['authority']
  readonly audience_policy_ref: string
  readonly sensitivity_policy_ref: string
  readonly purpose_policy_ref: string
  readonly retention_policy_ref: string
  readonly freshness_policy_ref: string
}

async function preparedTarget(
  client: PostgreSqlQueryClient,
  workspaceId: string,
  profileId: string,
  resourceId: string,
): Promise<PreparedTextReadTarget | null> {
  if (!SCOPE.test(workspaceId) || !SCOPE.test(profileId) || !isAccessGrantUuid(resourceId)) return null
  const result = await client.query<PreparedTargetRow>(`
    SELECT r.workspace_id, r.profile_id, r.resource_id, r.job_id, r.source_id,
      r.source_version_id, r.source_revision, v.object_key, v.byte_count, v.checksum,
      r.classification, r.authority, r.audience_policy_ref, r.sensitivity_policy_ref,
      r.purpose_policy_ref, r.retention_policy_ref, r.freshness_policy_ref
    FROM ownware.source_derived_resources r
    JOIN ownware.runtime_sources s ON s.source_id = r.source_id
      AND s.workspace_id = r.workspace_id AND s.profile_id = r.profile_id
    JOIN ownware.source_versions v ON v.source_version_id = r.source_version_id
      AND v.source_id = r.source_id
    JOIN ownware.source_jobs j ON j.job_id = r.job_id AND j.workspace_id = r.workspace_id
      AND j.profile_id = r.profile_id AND j.source_id = r.source_id
      AND j.source_version_id = r.source_version_id AND j.resource_id = r.resource_id
    WHERE r.resource_id = $1 AND r.workspace_id = $2 AND r.profile_id = $3
      AND r.kind = 'text_extraction' AND r.operation = 'extract_text'
      AND r.implementation_version = 'text_extraction.v1'
      AND r.coverage = 'complete' AND r.freshness = 'current' AND r.stale_at IS NULL
      AND r.byte_start = 0 AND r.byte_end = r.byte_count
      AND r.source_checksum = v.checksum AND r.resource_checksum = v.checksum
      AND r.byte_count = v.byte_count AND s.current_version_id = r.source_version_id
      AND s.revision = r.source_revision AND s.classification = r.classification
      AND s.authority = r.authority AND s.audience_policy_ref = r.audience_policy_ref
      AND s.sensitivity_policy_ref = r.sensitivity_policy_ref
      AND s.purpose_policy_ref = r.purpose_policy_ref
      AND s.retention_policy_ref = r.retention_policy_ref
      AND s.freshness_policy_ref = r.freshness_policy_ref
      AND s.registration_state = 'registered' AND s.inspection_state = 'complete'
      AND s.preparation_state = 'ready' AND s.access_state = 'available'
      AND s.freshness_state = 'fresh' AND s.conflict_state IN ('none', 'resolved')
      AND s.deletion_state = 'active' AND v.verified_media_type = 'text/plain'
      AND v.inspection_state = 'complete' AND v.preparation_state = 'ready'
      AND j.operation = 'extract_text' AND j.implementation_version = 'text_extraction.v1'
      AND j.source_revision = r.source_revision AND j.state = 'succeeded'
      AND j.checkpoint = 4 AND j.outcome_code = 'preparation_complete'
      AND j.terminal_at IS NOT NULL
    FOR SHARE OF s
  `, [resourceId, workspaceId, profileId])
  const row = result.rows[0]
  return row === undefined ? null : {
    workspaceId: row.workspace_id,
    profileId: row.profile_id,
    resourceId: row.resource_id,
    jobId: row.job_id,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    sourceRevision: safeInteger(row.source_revision),
    objectKey: row.object_key,
    expectedByteCount: safeInteger(row.byte_count),
    expectedChecksum: row.checksum,
    classification: row.classification,
    authority: row.authority,
    audiencePolicyRef: row.audience_policy_ref,
    sensitivityPolicyRef: row.sensitivity_policy_ref,
    purposePolicyRef: row.purpose_policy_ref,
    retentionPolicyRef: row.retention_policy_ref,
    freshnessPolicyRef: row.freshness_policy_ref,
  }
}

interface DataViewTarget {
  readonly workspaceId: string
  readonly profileId: string
  readonly dataViewId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly rowCount: number
  readonly fieldIds: readonly string[]
}

async function dataViewTarget(
  client: PostgreSqlQueryClient,
  dataViewId: string,
  workspaceId: string,
  profileId: string,
): Promise<DataViewTarget | null> {
  if (!isAccessGrantUuid(dataViewId) || !SCOPE.test(workspaceId) || !SCOPE.test(profileId)) return null
  const result = await client.query<{
    readonly source_id: string
    readonly source_version_id: string
    readonly row_count: string
    readonly fields_json: string
  }>(`
    SELECT dv.source_id, dv.source_version_id, dv.row_count, dv.fields_json
    FROM ownware.source_data_views dv
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
    WHERE dv.data_view_id = $1 AND dv.workspace_id = $2 AND dv.profile_id = $3
      AND dv.freshness = 'current' AND dv.stale_at IS NULL
      AND s.revision = dv.source_revision AND s.current_version_id = dv.source_version_id
      AND s.registration_state = 'registered' AND s.inspection_state = 'complete'
      AND s.preparation_state = 'ready' AND s.access_state = 'available'
      AND s.freshness_state = 'fresh' AND s.conflict_state IN ('none', 'resolved')
      AND s.deletion_state = 'active' AND s.classification = dv.classification
      AND s.authority = dv.authority AND s.audience_policy_ref = dv.audience_policy_ref
      AND s.sensitivity_policy_ref = dv.sensitivity_policy_ref
      AND s.purpose_policy_ref = dv.purpose_policy_ref
      AND s.retention_policy_ref = dv.retention_policy_ref
      AND s.freshness_policy_ref = dv.freshness_policy_ref
      AND sv.checksum = dv.source_checksum AND sv.inspection_state = 'complete'
      AND sv.preparation_state = 'ready' AND j.state = 'succeeded' AND j.checkpoint = 4
      AND j.outcome_code = 'preparation_complete' AND j.terminal_at IS NOT NULL
    FOR SHARE OF s
  `, [dataViewId, workspaceId, profileId])
  const row = result.rows[0]
  if (row === undefined) return null
  let fields: unknown
  try { fields = JSON.parse(row.fields_json) } catch { return null }
  if (!Array.isArray(fields)) return null
  const fieldIds: string[] = []
  for (const field of fields) {
    if (typeof field !== 'object' || field === null ||
      typeof (field as { fieldId?: unknown }).fieldId !== 'string') return null
    fieldIds.push((field as { fieldId: string }).fieldId)
  }
  return {
    workspaceId,
    profileId,
    dataViewId,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    rowCount: safeInteger(row.row_count),
    fieldIds,
  }
}

export function createPostgreSqlAccessGrantRepository(
  context: PostgreSqlRootRepositoryContext,
  evidenceSearchCache?: EvidenceSearchCache,
  maxActive = ACCESS_GRANT_MAX_ACTIVE_PER_SCOPE,
): AccessGrantRepository {
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) throw new TypeError('access grant limit is invalid')
  return {
    create(input, now = Date.now()) {
      let normalized: CreateAccessGrantInput
      try { normalized = normalizeAccessGrantInputForStorage(input) } catch (error) {
        return Promise.reject(error)
      }
      if (!Number.isSafeInteger(now) || now < 0) {
        return Promise.reject(new AccessGrantStoreError('access_grant_invalid'))
      }
      return repositoryCall(context, 'access_grants', 'create', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, (client) => createGrant(client, normalized, now, maxActive)))
    },
    createPreparedTextAccessGrant(input, now = Date.now()) {
      let normalized: CreateAccessGrantInput
      try {
        normalized = normalizeImmediateAccessGrantInputForStorage({
          workspaceId: input.workspaceId, profileId: input.profileId,
          subjectId: input.subjectId, purpose: input.purpose, channel: input.channel,
          resourceKind: 'source_resource', resourceId: input.resourceId,
          operation: input.operation, fieldScope: { mode: 'all' }, rowScope: { mode: 'all' },
          consent: input.consent, autonomyCeiling: 'observe', ttlSeconds: input.ttlSeconds,
          issuedBy: input.issuedBy,
        }, now)
      } catch (error) { return Promise.reject(error) }
      return repositoryCall(context, 'access_grants', 'create_prepared_text', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          if (await preparedTarget(client, input.workspaceId, input.profileId, input.resourceId) === null) {
            throw new AccessGrantStoreError('access_grant_resource_unavailable')
          }
          return createGrant(client, normalized, now, maxActive)
        }))
    },
    createDataViewQueryWindowGrant(input, now = Date.now()) {
      if (!validExactDataViewIdsForStorage(input.fieldIds, 'field') ||
        !Number.isSafeInteger(input.rowOffset) || input.rowOffset < 0 ||
        !Number.isSafeInteger(input.rowCount) || input.rowCount < 1 ||
        input.rowCount > ACCESS_GRANT_MAX_SCOPE_IDS) {
        return Promise.reject(new AccessGrantStoreError('access_grant_invalid'))
      }
      return repositoryCall(context, 'access_grants', 'create_data_view_window', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const target = await dataViewTarget(client, input.dataViewId, input.workspaceId, input.profileId)
          if (target === null) throw new AccessGrantStoreError('access_grant_resource_unavailable')
          const end = input.rowOffset + input.rowCount
          if (!Number.isSafeInteger(end) || input.rowOffset >= target.rowCount || end > target.rowCount ||
            input.fieldIds.some((id) => !target.fieldIds.includes(id))) {
            throw new AccessGrantStoreError('access_grant_invalid')
          }
          const rows = Array.from({ length: input.rowCount }, (_, offset) =>
            csvDataViewOrdinalId('row', target.sourceVersionId, input.rowOffset + offset))
          const normalized = normalizeImmediateAccessGrantInputForStorage({
            workspaceId: input.workspaceId, profileId: input.profileId,
            subjectId: input.subjectId, purpose: input.purpose, channel: input.channel,
            resourceKind: 'source_data_view', resourceId: input.dataViewId,
            operation: 'source_data_views.query', fieldScope: { mode: 'list', ids: input.fieldIds },
            rowScope: { mode: 'list', ids: rows }, consent: input.consent,
            autonomyCeiling: 'observe', ttlSeconds: input.ttlSeconds, issuedBy: input.issuedBy,
          }, now)
          return createGrant(client, normalized, now, maxActive)
        }))
    },
    getPreparedTextReadTargetScoped(workspaceId, profileId, resourceId) {
      return repositoryCall(context, 'access_grants', 'get_prepared_text_target_scoped', 'read_failed',
        (client) => preparedTarget(client, workspaceId, profileId, resourceId))
    },
    getPreparedTextReadTargetForOwner(resourceId) {
      if (!isAccessGrantUuid(resourceId)) return Promise.resolve(null)
      return repositoryCall(context, 'access_grants', 'get_prepared_text_target_owner', 'read_failed', async (client) => {
        const scope = await client.query<{ readonly workspace_id: string; readonly profile_id: string }>(`
          SELECT workspace_id, profile_id FROM ownware.source_derived_resources WHERE resource_id = $1
        `, [resourceId])
        const row = scope.rows[0]
        return row === undefined ? null : preparedTarget(client, row.workspace_id, row.profile_id, resourceId)
      })
    },
    getDataViewQueryTargetForOwner(dataViewId) {
      if (!isAccessGrantUuid(dataViewId)) return Promise.resolve(null)
      return repositoryCall(context, 'access_grants', 'get_data_view_target_owner', 'read_failed', async (client) => {
        const scope = await client.query<{ readonly workspace_id: string; readonly profile_id: string }>(`
          SELECT workspace_id, profile_id FROM ownware.source_data_views WHERE data_view_id = $1
        `, [dataViewId])
        const row = scope.rows[0]
        if (row === undefined) return null
        const target = await dataViewTarget(client, dataViewId, row.workspace_id, row.profile_id)
        const identity: DataViewQueryTargetIdentity | null = target === null ? null : {
          workspaceId: target.workspaceId, profileId: target.profileId,
          dataViewId: target.dataViewId, sourceId: target.sourceId,
        }
        return identity
      })
    },
    getCurrentForOwner(grantId) {
      if (!isAccessGrantUuid(grantId)) return Promise.resolve(null)
      return repositoryCall(context, 'access_grants', 'get_current_owner', 'read_failed',
        (client) => currentGrant(client, grantId))
    },
    getSourceIdentityForOwner(grantId) {
      if (!isAccessGrantUuid(grantId)) return Promise.resolve(null)
      return repositoryCall(context, 'access_grants', 'get_source_identity', 'read_failed', async (client) => {
        const result = await client.query<{
          readonly grant_id: string; readonly workspace_id: string
          readonly profile_id: string; readonly source_id: string
        }>(`
          SELECT g.grant_id, g.workspace_id, g.profile_id,
            COALESCE(dr.source_id, dv.source_id) AS source_id
          FROM ownware.access_grants g
          JOIN ownware.access_grant_revisions r
            ON r.grant_id = g.grant_id AND r.revision = g.current_revision
          LEFT JOIN ownware.source_derived_resources dr ON dr.resource_id = r.resource_id
            AND dr.workspace_id = r.workspace_id AND dr.profile_id = r.profile_id
            AND r.resource_kind = 'source_resource'
            AND r.operation IN ('source_content.read', 'source_content.search')
          LEFT JOIN ownware.source_data_views dv ON dv.data_view_id = r.resource_id
            AND dv.workspace_id = r.workspace_id AND dv.profile_id = r.profile_id
            AND r.resource_kind = 'source_data_view' AND r.operation = 'source_data_views.query'
          WHERE g.grant_id = $1 AND COALESCE(dr.source_id, dv.source_id) IS NOT NULL
        `, [grantId])
        const row = result.rows[0]
        return row === undefined ? null : {
          grantId: row.grant_id, workspaceId: row.workspace_id,
          profileId: row.profile_id, sourceId: row.source_id,
        }
      })
    },
    listCurrentForOwner(page, now = Date.now()) {
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(page.limit) ||
        page.limit < 1 || page.limit > 100 ||
        !(page.cursor === null || isAccessGrantUuid(page.cursor))) {
        return Promise.reject(new AccessGrantStoreError('access_grant_invalid'))
      }
      return repositoryCall(context, 'access_grants', 'list_current_owner', 'read_failed', async (client) => {
        const result = await client.query<AccessGrantStorageRow>(`
          SELECT r.*, g.workspace_id AS head_workspace_id, g.profile_id AS head_profile_id
          FROM ownware.access_grants g JOIN ownware.access_grant_revisions r
            ON r.grant_id = g.grant_id AND r.revision = g.current_revision
          WHERE ($1::text IS NULL OR g.grant_id > $1) ORDER BY g.grant_id ASC LIMIT $2
        `, [page.cursor?.toLowerCase() ?? null, page.limit + 1])
        const more = result.rows.length > page.limit
        const items = result.rows.slice(0, page.limit).map((row) =>
          withAccessGrantLifecycleForStorage(project(row), now))
        return { items, nextCursor: more ? items.at(-1)!.grantId : null }
      })
    },
    revoke(input, now = Date.now()) {
      if (!isAccessGrantUuid(input.grantId) || !SCOPE.test(input.workspaceId) ||
        !SCOPE.test(input.profileId) || !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 1 || !Number.isSafeInteger(now) || now < 0) {
        return Promise.reject(new AccessGrantStoreError('access_grant_invalid'))
      }
      return repositoryCall(context, 'access_grants', 'revoke', 'write_failed', async () => {
        const revoked = await withPostgreSqlTransaction(context.pool, async (client) => {
          const current = await currentGrant(client, input.grantId, input, true)
          if (current === null) throw new AccessGrantStoreError('access_grant_not_found')
          if (current.revision !== input.expectedRevision) {
            throw new AccessGrantStoreError('access_grant_revision_conflict')
          }
          if (current.state !== 'active') throw new AccessGrantStoreError('access_grant_not_active')
          if (now < current.revisionCreatedAt) throw new AccessGrantStoreError('access_grant_invalid')
          const revision = current.revision + 1
          await insertRevision(client, input.grantId, revision, 'revoked', current, now, now)
          const advanced = await client.query(`
            UPDATE ownware.access_grants SET current_revision = $1
            WHERE grant_id = $2 AND workspace_id = $3 AND profile_id = $4
              AND current_revision = $5
          `, [revision, input.grantId, input.workspaceId, input.profileId, input.expectedRevision])
          if (advanced.rowCount !== 1) throw new AccessGrantStoreError('access_grant_revision_conflict')
          const result = await currentGrant(client, input.grantId, input)
          if (result === null) throw new Error('revoked access grant is unavailable')
          return result
        })
        evidenceSearchCache?.invalidateGrant({
          workspaceId: input.workspaceId, profileId: input.profileId, grantId: input.grantId,
        })
        return revoked
      })
    },
    findLiveCandidates(input, now) {
      return repositoryCall(context, 'access_grants', 'find_live_candidates', 'read_failed', async (client) => {
        const result = await client.query<AccessGrantStorageRow>(`
          SELECT r.*, g.workspace_id AS head_workspace_id, g.profile_id AS head_profile_id
          FROM ownware.access_grants g JOIN ownware.access_grant_revisions r
            ON r.grant_id = g.grant_id AND r.revision = g.current_revision
          WHERE r.workspace_id = $1 AND r.profile_id = $2 AND g.workspace_id = $1
            AND g.profile_id = $2 AND r.subject_id = $3 AND r.purpose = $4
            AND r.channel IS NOT DISTINCT FROM $5 AND r.resource_kind = $6
            AND r.resource_id = $7 AND r.operation = $8 AND r.state = 'active'
            AND r.effective_at <= $9 AND r.expires_at > $9
          ORDER BY CASE r.field_scope_mode WHEN 'list' THEN 0 ELSE 1 END,
            CASE r.row_scope_mode WHEN 'list' THEN 0 ELSE 1 END,
            CASE r.autonomy_ceiling WHEN 'observe' THEN 0 WHEN 'recommend' THEN 1
              WHEN 'draft' THEN 2 ELSE 3 END,
            r.expires_at ASC, r.grant_id ASC LIMIT $10
        `, [
          input.workspaceId, input.profileId, input.subjectId, input.purpose, input.channel,
          input.resourceKind, input.resourceId, input.operation, now, maxActive + 1,
        ])
        if (result.rows.length > maxActive) throw new Error('access grant candidate bound exceeded')
        return result.rows.map(project)
      })
    },
  }
}
