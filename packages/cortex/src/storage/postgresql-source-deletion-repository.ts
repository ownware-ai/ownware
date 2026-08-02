import { randomUUID } from 'node:crypto'
import type { EvidenceSearchCache } from '../gateway/evidence-search-cache.js'
import {
  SOURCE_DELETION_IMPLEMENTATION,
  SourceDeletionPlanError,
  type PublicSourceDeletion,
  type SourceDeletionArtifactKind,
  type SourceDeletionArtifactState,
  type SourceDeletionClaim,
  type SourceDeletionDataViewLocator,
  type SourceDeletionInventoryCounts,
  type SourceDeletionInventoryEntry,
  type SourceDeletionPlan,
  type SourceDeletionPublicCounts,
} from '../gateway/source-deletion-store.js'
import {
  SOURCE_JOB_LEASE_MS,
  SOURCE_JOB_MAX_ATTEMPTS,
} from '../gateway/source-job-store.js'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import type { PostgreSqlQueryClient } from './postgresql-repository.js'
import {
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from './postgresql-repository.js'
import type { SourceDeletionRepository } from './source-repositories.js'

interface DeletionPlanRow {
  readonly job_id: string
  readonly workspace_id: string
  readonly profile_id: string
  readonly source_id: string
  readonly source_revision: string
  readonly inventory_state: 'pending' | 'complete'
  readonly created_at: string
  readonly updated_at: string
  readonly job_state: SourceDeletionPlan['state']
  readonly job_updated_at: string
  readonly terminal_at: string | null
}

interface DeletionTombstoneRow {
  readonly job_id: string
  readonly workspace_id: string
  readonly profile_id: string
  readonly source_id: string
  readonly state: 'cancelled' | 'deleted'
  readonly source_revision: string
  readonly immutable_originals: string
  readonly upload_staging: string
  readonly placed_candidates: string
  readonly derived_resources: string
  readonly data_views: string
  readonly search_indexes: string
  readonly source_jobs: string
  readonly idempotency_replays: string
  readonly retrieval_cache_entries: string
  readonly access_grant_revocations: string
  readonly grant_mutation_replays: string
  readonly created_at: string
  readonly terminal_at: string
}

interface JobClaimRow {
  readonly job_id: string
  readonly source_id: string
  readonly attempt: string
  readonly max_attempts: string
  readonly checkpoint: string
  readonly claim_token: string | null
  readonly lease_expires_at: string | null
  readonly state: string
}

interface InventoryTarget {
  readonly kind: SourceDeletionArtifactKind
  readonly id: string
}

interface CacheScope {
  readonly workspaceId: string
  readonly profileId: string
  readonly sourceId: string
}

const workerIdentity = /^[a-z0-9._-]{1,64}$/

function publicCounts(counts: SourceDeletionInventoryCounts): SourceDeletionPublicCounts {
  return {
    immutableOriginals: counts.immutableOriginals,
    uploadStaging: counts.uploadStaging,
    placedCandidates: counts.placedCandidates,
    derivedResources: counts.derivedResources,
    dataViews: counts.dataViews,
    searchIndexes: counts.searchIndexes,
    sourceJobs: counts.sourceJobs,
    idempotencyReplays: counts.idempotencyReplays,
    retrievalCacheEntries: counts.retrievalCacheEntries,
  }
}

function emptyCounts(): SourceDeletionInventoryCounts {
  return {
    immutableOriginals: 0,
    uploadStaging: 0,
    placedCandidates: 0,
    derivedResources: 0,
    dataViews: 0,
    searchIndexes: 0,
    sourceJobs: 0,
    idempotencyReplays: 0,
    retrievalCacheEntries: 0,
    accessGrantRevocations: 0,
    grantMutationReplays: 0,
  }
}

function countsFromTombstone(row: DeletionTombstoneRow): SourceDeletionInventoryCounts {
  return {
    immutableOriginals: safeInteger(row.immutable_originals),
    uploadStaging: safeInteger(row.upload_staging),
    placedCandidates: safeInteger(row.placed_candidates),
    derivedResources: safeInteger(row.derived_resources),
    dataViews: safeInteger(row.data_views),
    searchIndexes: safeInteger(row.search_indexes),
    sourceJobs: safeInteger(row.source_jobs),
    idempotencyReplays: safeInteger(row.idempotency_replays),
    retrievalCacheEntries: safeInteger(row.retrieval_cache_entries),
    accessGrantRevocations: safeInteger(row.access_grant_revocations),
    grantMutationReplays: safeInteger(row.grant_mutation_replays),
  }
}

function publicState(state: SourceDeletionPlan['state']): PublicSourceDeletion['state'] {
  switch (state) {
    case 'queued':
    case 'waiting_for_resource': return 'queued'
    case 'running': return 'deleting'
    case 'cancel_requested': return 'cancel_requested'
    case 'cancelled': return 'cancelled'
    case 'partial':
    case 'failed': return 'partially_deleted'
    case 'succeeded': return 'deleted'
  }
}

async function inventoryCounts(
  client: PostgreSqlQueryClient,
  jobId: string,
  remainingOnly = false,
): Promise<SourceDeletionInventoryCounts> {
  const result = await client.query<{
    readonly artifact_kind: SourceDeletionArtifactKind
    readonly count: string
  }>(`
    SELECT artifact_kind, COUNT(*) AS count
    FROM ownware.source_deletion_inventory
    WHERE job_id = $1 AND (NOT $2::boolean OR state <> 'verified_absent')
    GROUP BY artifact_kind
  `, [jobId, remainingOnly])
  const counts = new Map(result.rows.map((row) => [row.artifact_kind, safeInteger(row.count)]))
  return {
    immutableOriginals: counts.get('immutable_original') ?? 0,
    uploadStaging: counts.get('upload_staging') ?? 0,
    placedCandidates: counts.get('placed_candidate') ?? 0,
    derivedResources: counts.get('derived_resource') ?? 0,
    dataViews: counts.get('data_view') ?? 0,
    searchIndexes: counts.get('search_index') ?? 0,
    sourceJobs: counts.get('source_job') ?? 0,
    idempotencyReplays: counts.get('idempotency_replay') ?? 0,
    retrievalCacheEntries: counts.get('retrieval_cache') ?? 0,
    accessGrantRevocations: counts.get('access_grant_revocation') ?? 0,
    grantMutationReplays: counts.get('grant_mutation_replay') ?? 0,
  }
}

async function getPlanRowScoped(
  client: PostgreSqlQueryClient,
  sourceId: string,
  workspaceId: string,
  profileId: string,
): Promise<DeletionPlanRow | null> {
  const result = await client.query<DeletionPlanRow>(`
    SELECT p.*, j.state AS job_state, j.updated_at AS job_updated_at,
      j.terminal_at AS terminal_at
    FROM ownware.source_deletion_plans p
    JOIN ownware.source_jobs j ON j.job_id = p.job_id AND j.operation = 'delete_source'
    WHERE p.source_id = $1 AND p.workspace_id = $2 AND p.profile_id = $3
  `, [sourceId, workspaceId, profileId])
  return result.rows[0] ?? null
}

async function getPlanRowByJobScoped(
  client: PostgreSqlQueryClient,
  jobId: string,
  workspaceId: string,
  profileId: string,
): Promise<DeletionPlanRow | null> {
  const result = await client.query<DeletionPlanRow>(`
    SELECT p.*, j.state AS job_state, j.updated_at AS job_updated_at,
      j.terminal_at AS terminal_at
    FROM ownware.source_deletion_plans p
    JOIN ownware.source_jobs j ON j.job_id = p.job_id AND j.operation = 'delete_source'
    WHERE p.job_id = $1 AND p.workspace_id = $2 AND p.profile_id = $3
  `, [jobId, workspaceId, profileId])
  return result.rows[0] ?? null
}

async function tombstoneBySource(
  client: PostgreSqlQueryClient,
  sourceId: string,
  workspaceId: string,
  profileId: string,
  deletedOnly: boolean,
): Promise<DeletionTombstoneRow | null> {
  const result = await client.query<DeletionTombstoneRow>(`
    SELECT * FROM ownware.source_deletion_tombstones
    WHERE source_id = $1 AND workspace_id = $2 AND profile_id = $3
      AND (NOT $4::boolean OR state = 'deleted')
    ORDER BY terminal_at DESC,
      CASE WHEN state = 'deleted' THEN 1 ELSE 0 END DESC
    LIMIT 1
  `, [sourceId, workspaceId, profileId, deletedOnly])
  return result.rows[0] ?? null
}

async function projectPlan(
  client: PostgreSqlQueryClient,
  row: DeletionPlanRow,
): Promise<SourceDeletionPlan> {
  if (row.inventory_state !== 'complete') throw new Error('deletion inventory is incomplete')
  return {
    jobId: row.job_id,
    sourceId: row.source_id,
    state: row.job_state,
    implementationVersion: SOURCE_DELETION_IMPLEMENTATION,
    sourceRevision: safeInteger(row.source_revision),
    inventoryState: 'complete',
    inventoryCounts: await inventoryCounts(client, row.job_id),
    createdAt: safeInteger(row.created_at),
    updatedAt: safeInteger(row.job_updated_at),
  }
}

function projectTombstonePlan(row: DeletionTombstoneRow): SourceDeletionPlan {
  return {
    jobId: row.job_id,
    sourceId: row.source_id,
    state: row.state === 'deleted' ? 'succeeded' : 'cancelled',
    implementationVersion: SOURCE_DELETION_IMPLEMENTATION,
    sourceRevision: safeInteger(row.source_revision),
    inventoryState: 'complete',
    inventoryCounts: countsFromTombstone(row),
    createdAt: safeInteger(row.created_at),
    updatedAt: safeInteger(row.terminal_at),
  }
}

async function projectPublic(
  client: PostgreSqlQueryClient,
  row: DeletionPlanRow,
): Promise<PublicSourceDeletion> {
  const affected = await inventoryCounts(client, row.job_id)
  return {
    jobId: row.job_id,
    sourceId: row.source_id,
    operation: 'delete_source',
    state: publicState(row.job_state),
    sourceRevision: safeInteger(row.source_revision),
    affected: publicCounts(affected),
    remaining: publicCounts(await inventoryCounts(client, row.job_id, true)),
    createdAt: safeInteger(row.created_at),
    updatedAt: safeInteger(row.job_updated_at),
    terminalAt: row.terminal_at === null ? null : safeInteger(row.terminal_at),
  }
}

function projectPublicTombstone(row: DeletionTombstoneRow): PublicSourceDeletion {
  const affected = countsFromTombstone(row)
  return {
    jobId: row.job_id,
    sourceId: row.source_id,
    operation: 'delete_source',
    state: row.state,
    sourceRevision: safeInteger(row.source_revision),
    affected: publicCounts(affected),
    remaining: row.state === 'deleted' ? publicCounts(emptyCounts()) : publicCounts(affected),
    createdAt: safeInteger(row.created_at),
    updatedAt: safeInteger(row.terminal_at),
    terminalAt: safeInteger(row.terminal_at),
  }
}

async function activeClaim(
  client: PostgreSqlQueryClient,
  jobId: string,
  claimToken: string,
  now: number,
  forUpdate = false,
): Promise<'advanced' | 'stale_claim' | 'lease_expired'> {
  const result = await client.query<Pick<JobClaimRow, 'state' | 'claim_token' | 'lease_expires_at'>>(`
    SELECT state, claim_token, lease_expires_at
    FROM ownware.source_jobs
    WHERE job_id = $1 AND operation = 'delete_source'
    ${forUpdate ? 'FOR UPDATE' : ''}
  `, [jobId])
  const row = result.rows[0]
  if (row === undefined || row.state !== 'running' || row.claim_token !== claimToken) {
    return 'stale_claim'
  }
  if (row.lease_expires_at === null || safeInteger(row.lease_expires_at) < now) {
    return 'lease_expired'
  }
  return 'advanced'
}

async function cacheTarget(
  client: PostgreSqlQueryClient,
  jobId: string,
  artifactId: string,
): Promise<CacheScope | null> {
  const result = await client.query<{
    readonly workspace_id: string
    readonly profile_id: string
    readonly source_id: string
  }>(`
    SELECT p.workspace_id, p.profile_id, p.source_id
    FROM ownware.source_deletion_plans p
    JOIN ownware.source_deletion_inventory i ON i.job_id = p.job_id
    WHERE p.job_id = $1 AND i.artifact_kind = 'retrieval_cache'
      AND i.artifact_id = $2
  `, [jobId, artifactId])
  const row = result.rows[0]
  return row === undefined ? null : {
    workspaceId: row.workspace_id,
    profileId: row.profile_id,
    sourceId: row.source_id,
  }
}

async function collectInventory(
  client: PostgreSqlQueryClient,
  sourceId: string,
  deletionJobId: string,
  revokedGrantIds: readonly string[],
  retrievalCacheEntries: number,
): Promise<InventoryTarget[]> {
  const inventory: InventoryTarget[] = []
  const append = async (kind: SourceDeletionArtifactKind, sql: string, values: unknown[]) => {
    const result = await client.query<{ readonly id: string }>(sql, values)
    for (const row of result.rows) inventory.push({ kind, id: row.id })
  }
  await append('immutable_original', `
    SELECT source_version_id AS id FROM ownware.source_versions WHERE source_id = $1
  `, [sourceId])
  await append('upload_staging', `
    SELECT upload_id AS id FROM ownware.source_upload_sessions WHERE source_id = $1
  `, [sourceId])
  await append('placed_candidate', `
    SELECT DISTINCT pending_version_id AS id FROM ownware.source_upload_sessions
    WHERE source_id = $1 AND pending_version_id IS NOT NULL
  `, [sourceId])
  await append('derived_resource', `
    SELECT resource_id AS id FROM ownware.source_derived_resources WHERE source_id = $1
  `, [sourceId])
  await append('data_view', `
    SELECT data_view_id AS id FROM ownware.source_data_view_jobs WHERE source_id = $1
  `, [sourceId])
  await append('source_job', `
    SELECT job_id AS id FROM ownware.source_jobs WHERE source_id = $1 AND job_id <> $2
  `, [sourceId, deletionJobId])
  await append('source_job', `
    SELECT job_id AS id FROM ownware.source_data_view_jobs WHERE source_id = $1
  `, [sourceId])
  for (const grantId of revokedGrantIds) {
    inventory.push({ kind: 'access_grant_revocation', id: grantId })
  }
  for (let ordinal = 0; ordinal < retrievalCacheEntries; ordinal += 1) {
    inventory.push({ kind: 'retrieval_cache', id: randomUUID() })
  }
  await append('grant_mutation_replay', `
    SELECT id FROM ownware.run_idempotency
    WHERE source_id = $1 AND source_mutation_kind = 'access_grant'
  `, [sourceId])
  await append('idempotency_replay', `
    SELECT id FROM ownware.run_idempotency
    WHERE source_id = $1 AND source_mutation_kind IS NULL
  `, [sourceId])
  return inventory
}

async function revokeSourceGrants(
  client: PostgreSqlQueryClient,
  scope: CacheScope,
  now: number,
): Promise<string[]> {
  const frozen = await client.query(`
    SELECT 1 FROM ownware.runtime_sources
    WHERE source_id = $1 AND workspace_id = $2 AND profile_id = $3
      AND deletion_state = 'frozen'
  `, [scope.sourceId, scope.workspaceId, scope.profileId])
  if (frozen.rowCount !== 1) throw new Error('source is not frozen for grant revocation')
  const candidates = await client.query<{
    readonly grant_id: string
    readonly current_revision: string
    readonly revision_created_at: string
  }>(`
    SELECT g.grant_id, g.current_revision, r.revision_created_at
    FROM ownware.access_grants g
    JOIN ownware.access_grant_revisions r
      ON r.grant_id = g.grant_id AND r.revision = g.current_revision
    WHERE g.workspace_id = $1 AND g.profile_id = $2 AND r.state = 'active'
      AND ((r.resource_kind = 'source_resource'
        AND r.operation IN ('source_content.read', 'source_content.search')
        AND EXISTS (SELECT 1 FROM ownware.source_derived_resources d
          WHERE d.resource_id = r.resource_id AND d.workspace_id = r.workspace_id
            AND d.profile_id = r.profile_id AND d.source_id = $3))
      OR (r.resource_kind = 'source_data_view'
        AND r.operation = 'source_data_views.query'
        AND EXISTS (SELECT 1 FROM ownware.source_data_view_jobs d
          WHERE d.data_view_id = r.resource_id AND d.workspace_id = r.workspace_id
            AND d.profile_id = r.profile_id AND d.source_id = $3)))
    ORDER BY g.grant_id
    FOR UPDATE OF g
  `, [scope.workspaceId, scope.profileId, scope.sourceId])
  for (const row of candidates.rows) {
    const revision = safeInteger(row.current_revision)
    if (now < safeInteger(row.revision_created_at)) {
      throw new Error('source grant revision is newer than the deletion plan')
    }
    const inserted = await client.query(`
      INSERT INTO ownware.access_grant_revisions (
        grant_id, revision, workspace_id, profile_id, state, subject_id, purpose,
        channel, resource_kind, resource_id, operation, field_scope_mode,
        field_ids_json, row_scope_mode, row_ids_json, consent_state,
        consent_evidence_id, autonomy_ceiling, effective_at, expires_at, issued_by,
        revision_created_at, revoked_at
      ) SELECT grant_id, revision + 1, workspace_id, profile_id, 'revoked', subject_id,
        purpose, channel, resource_kind, resource_id, operation, field_scope_mode,
        field_ids_json, row_scope_mode, row_ids_json, consent_state,
        consent_evidence_id, autonomy_ceiling, effective_at, expires_at, issued_by,
        $3, $3
      FROM ownware.access_grant_revisions
      WHERE grant_id = $1 AND revision = $2 AND state = 'active'
    `, [row.grant_id, revision, now])
    if (inserted.rowCount !== 1) throw new Error('source grant revision changed')
    const advanced = await client.query(`
      UPDATE ownware.access_grants SET current_revision = $1
      WHERE grant_id = $2 AND workspace_id = $3 AND profile_id = $4
        AND current_revision = $5
    `, [revision + 1, row.grant_id, scope.workspaceId, scope.profileId, revision])
    if (advanced.rowCount !== 1) throw new Error('source grant head changed')
  }
  return candidates.rows.map((row) => row.grant_id)
}

async function grantTarget(
  client: PostgreSqlQueryClient,
  jobId: string,
  grantId: string,
  forUpdate = false,
): Promise<{
  readonly workspaceId: string
  readonly profileId: string
  readonly revision: number
  readonly revisionCreatedAt: number
  readonly state: 'active' | 'revoked'
} | null> {
  const result = await client.query<{
    readonly workspace_id: string
    readonly profile_id: string
    readonly current_revision: string
    readonly revision_created_at: string
    readonly state: 'active' | 'revoked'
  }>(`
    SELECT p.workspace_id, p.profile_id, g.current_revision,
      r.revision_created_at, r.state
    FROM ownware.source_deletion_plans p
    JOIN ownware.source_deletion_inventory gi
      ON gi.job_id = p.job_id AND gi.artifact_kind = 'access_grant_revocation'
      AND gi.artifact_id = $1
    JOIN ownware.access_grants g ON g.grant_id = gi.artifact_id
      AND g.workspace_id = p.workspace_id AND g.profile_id = p.profile_id
    JOIN ownware.access_grant_revisions r
      ON r.grant_id = g.grant_id AND r.revision = g.current_revision
    WHERE p.job_id = $2 AND ((r.resource_kind = 'source_resource'
      AND r.operation IN ('source_content.read', 'source_content.search')
      AND EXISTS (SELECT 1 FROM ownware.source_deletion_inventory di
        WHERE di.job_id = p.job_id AND di.artifact_kind = 'derived_resource'
          AND di.artifact_id = r.resource_id))
    OR (r.resource_kind = 'source_data_view' AND r.operation = 'source_data_views.query'
      AND EXISTS (SELECT 1 FROM ownware.source_deletion_inventory di
        WHERE di.job_id = p.job_id AND di.artifact_kind = 'data_view'
          AND di.artifact_id = r.resource_id)))
    ${forUpdate ? 'FOR UPDATE OF g' : ''}
  `, [grantId, jobId])
  const row = result.rows[0]
  return row === undefined ? null : {
    workspaceId: row.workspace_id,
    profileId: row.profile_id,
    revision: safeInteger(row.current_revision),
    revisionCreatedAt: safeInteger(row.revision_created_at),
    state: row.state,
  }
}

async function ensureGrantRevokedInTransaction(
  client: PostgreSqlQueryClient,
  jobId: string,
  grantId: string,
  now: number,
): Promise<{ readonly revoked: boolean; readonly scope: CacheScope | null }> {
  const target = await grantTarget(client, jobId, grantId, true)
  if (target === null) return { revoked: false, scope: null }
  const plan = await client.query<{ readonly source_id: string }>(`
    SELECT source_id FROM ownware.source_deletion_plans WHERE job_id = $1
  `, [jobId])
  const sourceId = plan.rows[0]?.source_id
  if (sourceId === undefined) return { revoked: false, scope: null }
  const scope = { workspaceId: target.workspaceId, profileId: target.profileId, sourceId }
  if (target.state === 'revoked') return { revoked: true, scope }
  if (now < target.revisionCreatedAt) return { revoked: false, scope }
  const inserted = await client.query(`
    INSERT INTO ownware.access_grant_revisions (
      grant_id, revision, workspace_id, profile_id, state, subject_id, purpose,
      channel, resource_kind, resource_id, operation, field_scope_mode,
      field_ids_json, row_scope_mode, row_ids_json, consent_state,
      consent_evidence_id, autonomy_ceiling, effective_at, expires_at, issued_by,
      revision_created_at, revoked_at
    ) SELECT grant_id, revision + 1, workspace_id, profile_id, 'revoked', subject_id,
      purpose, channel, resource_kind, resource_id, operation, field_scope_mode,
      field_ids_json, row_scope_mode, row_ids_json, consent_state,
      consent_evidence_id, autonomy_ceiling, effective_at, expires_at, issued_by, $3, $3
    FROM ownware.access_grant_revisions
    WHERE grant_id = $1 AND revision = $2 AND state = 'active'
  `, [grantId, target.revision, now])
  if (inserted.rowCount !== 1) return { revoked: false, scope }
  const advanced = await client.query(`
    UPDATE ownware.access_grants SET current_revision = $1
    WHERE grant_id = $2 AND workspace_id = $3 AND profile_id = $4
      AND current_revision = $5
  `, [target.revision + 1, grantId, target.workspaceId, target.profileId, target.revision])
  if (advanced.rowCount !== 1) throw new Error('source grant head changed')
  return { revoked: true, scope }
}

function invalidateGrant(cache: EvidenceSearchCache | undefined, scope: CacheScope, grantId: string): void {
  cache?.invalidateGrant({
    workspaceId: scope.workspaceId,
    profileId: scope.profileId,
    grantId,
  })
}

/** Complete PostgreSQL implementation of the durable source-deletion authority. */
export function createPostgreSqlSourceDeletionRepository(
  context: PostgreSqlRootRepositoryContext,
  evidenceSearchCache?: EvidenceSearchCache,
): SourceDeletionRepository {
  return {
    plan(input, now = Date.now()) {
      return repositoryCall(context, 'source_deletions', 'plan', 'write_failed', async () => {
        const cacheScope = {
          workspaceId: input.workspaceId,
          profileId: input.profileId,
          sourceId: input.sourceId,
        }
        const cacheEntries = evidenceSearchCache?.inventorySource(cacheScope).entries ?? 0
        const outcome = await withPostgreSqlTransaction(context.pool, async (client) => {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 1396984900))',
            [`${input.workspaceId}\u001f${input.profileId}\u001f${input.sourceId}`],
          )
          const tombstone = await tombstoneBySource(
            client, input.sourceId, input.workspaceId, input.profileId, true,
          )
          if (tombstone !== null) {
            if (input.expectedRevision !== safeInteger(tombstone.source_revision) - 1) {
              throw new SourceDeletionPlanError('source_deletion_revision_conflict')
            }
            return { plan: projectTombstonePlan(tombstone), revoked: [] as string[], fresh: false }
          }
          const existing = await getPlanRowScoped(
            client, input.sourceId, input.workspaceId, input.profileId,
          )
          if (existing !== null) {
            if (input.expectedRevision !== safeInteger(existing.source_revision) - 1) {
              throw new SourceDeletionPlanError('source_deletion_revision_conflict')
            }
            return { plan: await projectPlan(client, existing), revoked: [] as string[], fresh: false }
          }
          const sourceResult = await client.query<{
            readonly revision: string
            readonly deletion_state: string
          }>(`
            SELECT revision, deletion_state FROM ownware.runtime_sources
            WHERE source_id = $1 AND workspace_id = $2 AND profile_id = $3
            FOR UPDATE
          `, [input.sourceId, input.workspaceId, input.profileId])
          const source = sourceResult.rows[0]
          if (source === undefined) throw new SourceDeletionPlanError('source_not_found')
          if (source.deletion_state !== 'active') {
            throw new SourceDeletionPlanError('source_deletion_not_active')
          }
          const revision = safeInteger(source.revision)
          if (revision !== input.expectedRevision) {
            throw new SourceDeletionPlanError('source_deletion_revision_conflict')
          }
          const sourceRevision = revision + 1
          const frozen = await client.query(`
            UPDATE ownware.runtime_sources
            SET deletion_state = 'frozen', revision = $1, updated_at = $2
            WHERE source_id = $3 AND workspace_id = $4 AND profile_id = $5
              AND deletion_state = 'active' AND revision = $6
          `, [
            sourceRevision, now, input.sourceId, input.workspaceId, input.profileId, revision,
          ])
          if (frozen.rowCount !== 1) {
            throw new SourceDeletionPlanError('source_deletion_revision_conflict')
          }
          const revoked = await revokeSourceGrants(client, cacheScope, now)
          await client.query(`
            UPDATE ownware.run_idempotency
            SET state = 'indeterminate', status_code = NULL, result_json = NULL,
              updated_at = $1
            WHERE source_id = $2 AND source_mutation_kind = 'access_grant'
          `, [now, input.sourceId])
          await client.query(`
            UPDATE ownware.source_upload_sessions
            SET state = 'failed', code = 'source_deletion_frozen', updated_at = $1
            WHERE source_id = $2 AND workspace_id = $3 AND profile_id = $4
              AND state IN ('open', 'completing')
          `, [now, input.sourceId, input.workspaceId, input.profileId])
          await client.query(`
            UPDATE ownware.source_jobs
            SET state = 'cancel_requested', cancel_requested_at = $1,
              retry_after = NULL, updated_at = $1
            WHERE source_id = $2 AND workspace_id = $3 AND profile_id = $4
              AND operation IN ('inspect_format', 'extract_text')
              AND state IN ('queued', 'running', 'waiting_for_resource')
          `, [now, input.sourceId, input.workspaceId, input.profileId])
          await client.query(`
            UPDATE ownware.source_data_view_jobs
            SET state = 'cancel_requested', cancel_requested_at = $1,
              retry_after = NULL, updated_at = $1
            WHERE source_id = $2 AND workspace_id = $3 AND profile_id = $4
              AND state IN ('queued', 'running', 'waiting_for_resource')
          `, [now, input.sourceId, input.workspaceId, input.profileId])

          const jobId = randomUUID()
          await client.query(`
            INSERT INTO ownware.source_jobs (
              job_id, workspace_id, profile_id, source_id, source_version_id,
              operation, implementation_version, source_revision, resource_id,
              state, attempt, max_attempts, checkpoint, claim_token, claimed_by,
              lease_expires_at, retry_after, cancel_requested_at, outcome_code,
              created_at, updated_at, terminal_at
            ) VALUES ($1, $2, $3, $4, NULL, 'delete_source', $5, $6, NULL,
              'queued', 0, $7, 0, NULL, NULL, NULL, NULL, NULL, NULL, $8, $8, NULL)
          `, [
            jobId, input.workspaceId, input.profileId, input.sourceId,
            SOURCE_DELETION_IMPLEMENTATION, sourceRevision, SOURCE_JOB_MAX_ATTEMPTS, now,
          ])
          await client.query(`
            INSERT INTO ownware.source_deletion_plans (
              job_id, workspace_id, profile_id, source_id, source_revision,
              inventory_state, inventory_completed_at, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, 'pending', NULL, $6, $6)
          `, [jobId, input.workspaceId, input.profileId, input.sourceId, sourceRevision, now])
          const inventory = await collectInventory(
            client, input.sourceId, jobId, revoked, cacheEntries,
          )
          for (const artifact of inventory) {
            await client.query(`
              INSERT INTO ownware.source_deletion_inventory (
                job_id, artifact_kind, artifact_id, state, created_at, updated_at, terminal_at
              ) VALUES ($1, $2, $3, 'pending', $4, $4, NULL)
            `, [jobId, artifact.kind, artifact.id, now])
          }
          const completed = await client.query(`
            UPDATE ownware.source_deletion_plans
            SET inventory_state = 'complete', inventory_completed_at = $1, updated_at = $1
            WHERE job_id = $2 AND inventory_state = 'pending'
          `, [now, jobId])
          if (completed.rowCount !== 1) throw new Error('deletion inventory did not complete')
          const row = await getPlanRowScoped(
            client, input.sourceId, input.workspaceId, input.profileId,
          )
          if (row === null) throw new Error('deletion plan is unavailable')
          return { plan: await projectPlan(client, row), revoked, fresh: true }
        })
        if (outcome.fresh) evidenceSearchCache?.invalidateSource(cacheScope)
        for (const grantId of outcome.revoked) invalidateGrant(evidenceSearchCache, cacheScope, grantId)
        return outcome.plan
      })
    },

    getScoped(sourceId, workspaceId, profileId) {
      return repositoryCall(context, 'source_deletions', 'getScoped', 'read_failed', async (client) => {
        const row = await getPlanRowScoped(client, sourceId, workspaceId, profileId)
        if (row !== null) return projectPlan(client, row)
        const tombstone = await tombstoneBySource(client, sourceId, workspaceId, profileId, false)
        return tombstone === null ? null : projectTombstonePlan(tombstone)
      })
    },

    getPublicByJobScoped(jobId, workspaceId, profileId) {
      return repositoryCall(
        context, 'source_deletions', 'getPublicByJobScoped', 'read_failed', async (client) => {
          const row = await getPlanRowByJobScoped(client, jobId, workspaceId, profileId)
          if (row !== null) return projectPublic(client, row)
          const result = await client.query<DeletionTombstoneRow>(`
            SELECT * FROM ownware.source_deletion_tombstones
            WHERE job_id = $1 AND workspace_id = $2 AND profile_id = $3
          `, [jobId, workspaceId, profileId])
          return result.rows[0] === undefined ? null : projectPublicTombstone(result.rows[0])
        },
      )
    },

    getPublicBySourceScoped(sourceId, workspaceId, profileId) {
      return repositoryCall(
        context, 'source_deletions', 'getPublicBySourceScoped', 'read_failed', async (client) => {
          const row = await getPlanRowScoped(client, sourceId, workspaceId, profileId)
          if (row !== null) return projectPublic(client, row)
          const tombstone = await tombstoneBySource(client, sourceId, workspaceId, profileId, false)
          return tombstone === null ? null : projectPublicTombstone(tombstone)
        },
      )
    },

    getInventory(jobId) {
      return repositoryCall(context, 'source_deletions', 'getInventory', 'read_failed', async (client) => {
        const result = await client.query<{
          readonly artifact_kind: SourceDeletionArtifactKind
          readonly artifact_id: string
        }>(`
          SELECT artifact_kind, artifact_id FROM ownware.source_deletion_inventory
          WHERE job_id = $1 ORDER BY artifact_kind, artifact_id
        `, [jobId])
        return result.rows.map((row) => ({ kind: row.artifact_kind, id: row.artifact_id }))
      })
    },

    getInventoryEntries(jobId) {
      return repositoryCall(
        context, 'source_deletions', 'getInventoryEntries', 'read_failed', async (client) => {
          const result = await client.query<{
            readonly artifact_kind: SourceDeletionArtifactKind
            readonly artifact_id: string
            readonly state: SourceDeletionArtifactState
          }>(`
            SELECT artifact_kind, artifact_id, state FROM ownware.source_deletion_inventory
            WHERE job_id = $1 ORDER BY artifact_kind, artifact_id
          `, [jobId])
          return result.rows.map((row): SourceDeletionInventoryEntry => ({
            kind: row.artifact_kind, id: row.artifact_id, state: row.state,
          }))
        },
      )
    },

    versionLocatorMatches(jobId, kind, versionId) {
      return repositoryCall(
        context, 'source_deletions', 'versionLocatorMatches', 'read_failed', async (client) => {
          const plan = await client.query<{ readonly source_id: string }>(`
            SELECT source_id FROM ownware.source_deletion_plans WHERE job_id = $1
          `, [jobId])
          const sourceId = plan.rows[0]?.source_id
          if (sourceId === undefined) return false
          const version = await client.query<{
            readonly source_id: string
            readonly object_key: string
          }>(`
            SELECT source_id, object_key FROM ownware.source_versions
            WHERE source_version_id = $1
          `, [versionId])
          const row = version.rows[0]
          if (row === undefined) return kind === 'placed_candidate'
          return row.source_id === sourceId &&
            row.object_key === `sources/${sourceId}/versions/${versionId}/original`
        },
      )
    },

    dataViewLocator(jobId, dataViewId) {
      return repositoryCall(context, 'source_deletions', 'dataViewLocator', 'read_failed', async (client) => {
        const result = await client.query<{
          readonly source_id: string
          readonly source_version_id: string
          readonly private_object_key: string | null
        }>(`
          SELECT p.source_id, d.source_version_id, v.private_object_key
          FROM ownware.source_deletion_plans p
          JOIN ownware.source_deletion_inventory i
            ON i.job_id = p.job_id AND i.artifact_kind = 'data_view'
          JOIN ownware.source_data_view_jobs d
            ON d.data_view_id = i.artifact_id AND d.source_id = p.source_id
          LEFT JOIN ownware.source_data_views v
            ON v.data_view_id = d.data_view_id AND v.job_id = d.job_id
          WHERE p.job_id = $1 AND i.artifact_id = $2
        `, [jobId, dataViewId])
        const row = result.rows[0]
        if (row === undefined) return null
        const expected = `sources/${row.source_id}/versions/${row.source_version_id}/data-views/${dataViewId}.json`
        if (row.private_object_key !== null && row.private_object_key !== expected) return null
        const locator: SourceDeletionDataViewLocator = {
          sourceId: row.source_id,
          sourceVersionId: row.source_version_id,
        }
        return locator
      })
    },

    claimNext(workerId, now = Date.now()) {
      if (!workerIdentity.test(workerId)) {
        return Promise.reject(new TypeError('Source deletion worker identity is invalid'))
      }
      return repositoryCall(context, 'source_deletions', 'claimNext', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const claimToken = randomUUID()
          const leaseExpiresAt = now + SOURCE_JOB_LEASE_MS
          const result = await client.query<JobClaimRow>(`
            WITH candidate AS (
              SELECT j.job_id FROM ownware.source_jobs j
              WHERE j.operation = 'delete_source' AND j.state = 'queued'
                AND j.attempt < j.max_attempts
                AND NOT EXISTS (SELECT 1 FROM ownware.source_data_view_jobs d
                  WHERE d.source_id = j.source_id AND d.state = 'cancel_requested')
              ORDER BY j.created_at, j.job_id
              FOR UPDATE OF j SKIP LOCKED LIMIT 1
            ) UPDATE ownware.source_jobs j
            SET state = 'running', attempt = j.attempt + 1, claim_token = $1,
              claimed_by = $2, lease_expires_at = $3, updated_at = $4
            FROM candidate WHERE j.job_id = candidate.job_id
              AND j.state = 'queued' AND j.attempt < j.max_attempts
            RETURNING j.job_id, j.source_id, j.attempt, j.max_attempts, j.checkpoint,
              j.claim_token, j.lease_expires_at, j.state
          `, [claimToken, workerId, leaseExpiresAt, now])
          const row = result.rows[0]
          if (row === undefined || row.claim_token === null || row.lease_expires_at === null) return null
          const claim: SourceDeletionClaim = {
            jobId: row.job_id,
            sourceId: row.source_id,
            attempt: safeInteger(row.attempt),
            maxAttempts: safeInteger(row.max_attempts) as typeof SOURCE_JOB_MAX_ATTEMPTS,
            checkpoint: safeInteger(row.checkpoint),
            claimToken: row.claim_token,
            leaseExpiresAt: safeInteger(row.lease_expires_at),
          }
          return claim
        }))
    },

    startDestruction(jobId, claimToken, now = Date.now()) {
      return repositoryCall(
        context, 'source_deletions', 'startDestruction', 'write_failed', async () =>
          withPostgreSqlTransaction(context.pool, async (client) => {
            const claim = await activeClaim(client, jobId, claimToken, now, true)
            if (claim !== 'advanced') return claim
            const source = await client.query(`
              UPDATE ownware.runtime_sources SET deletion_state = 'deleting', updated_at = $1
              WHERE source_id = (SELECT source_id FROM ownware.source_jobs WHERE job_id = $2)
                AND deletion_state = 'frozen'
            `, [now, jobId])
            if (source.rowCount !== 1) return 'checkpoint_conflict'
            const advanced = await client.query(`
              UPDATE ownware.source_jobs SET checkpoint = 1, updated_at = $1
              WHERE job_id = $2 AND operation = 'delete_source' AND state = 'running'
                AND claim_token = $3 AND lease_expires_at >= $1 AND checkpoint = 0
            `, [now, jobId, claimToken])
            return advanced.rowCount === 1 ? 'advanced' : 'checkpoint_conflict'
          }),
      )
    },

    renewClaim(jobId, claimToken, now = Date.now()) {
      return repositoryCall(context, 'source_deletions', 'renewClaim', 'write_failed', async (client) => {
        const renewed = await client.query(`
          UPDATE ownware.source_jobs SET lease_expires_at = $1, updated_at = $2
          WHERE job_id = $3 AND operation = 'delete_source' AND state = 'running'
            AND claim_token = $4 AND lease_expires_at >= $2
        `, [now + SOURCE_JOB_LEASE_MS, now, jobId, claimToken])
        return renewed.rowCount === 1
      })
    },

    advanceCheckpoint(jobId, claimToken, expectedCheckpoint, nextCheckpoint, now = Date.now()) {
      if (nextCheckpoint !== expectedCheckpoint + 1) {
        return Promise.reject(new RangeError('Source deletion checkpoint transition is invalid'))
      }
      return repositoryCall(
        context, 'source_deletions', 'advanceCheckpoint', 'write_failed', async () =>
          withPostgreSqlTransaction(context.pool, async (client) => {
            const claim = await activeClaim(client, jobId, claimToken, now, true)
            if (claim !== 'advanced') return claim
            const advanced = await client.query(`
              UPDATE ownware.source_jobs SET checkpoint = $1, updated_at = $2
              WHERE job_id = $3 AND operation = 'delete_source' AND state = 'running'
                AND claim_token = $4 AND lease_expires_at >= $2 AND checkpoint = $5
            `, [nextCheckpoint, now, jobId, claimToken, expectedCheckpoint])
            return advanced.rowCount === 1 ? 'advanced' : 'checkpoint_conflict'
          }),
      )
    },

    markArtifact(jobId, claimToken, kind, artifactId, state, now = Date.now()) {
      return repositoryCall(context, 'source_deletions', 'markArtifact', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const claim = await activeClaim(client, jobId, claimToken, now, true)
          if (claim !== 'advanced') return claim
          const terminalAt = state === 'verified_absent' || state === 'failed' ? now : null
          const updated = await client.query(`
            UPDATE ownware.source_deletion_inventory
            SET state = $1, updated_at = $2, terminal_at = $3
            WHERE job_id = $4 AND artifact_kind = $5 AND artifact_id = $6
              AND state <> 'verified_absent'
          `, [state, now, terminalAt, jobId, kind, artifactId])
          return updated.rowCount === 1 ? 'advanced' : 'checkpoint_conflict'
        }))
    },

    removeControlArtifact(jobId, claimToken, kind, artifactId, now = Date.now()) {
      return repositoryCall(
        context, 'source_deletions', 'removeControlArtifact', 'write_failed', async () => {
          let grantInvalidation: CacheScope | null = null
          const removed = await withPostgreSqlTransaction(context.pool, async (client) => {
            if (await activeClaim(client, jobId, claimToken, now, true) !== 'advanced') return false
            const result = await client.query<{ readonly source_id: string }>(`
              SELECT p.source_id FROM ownware.source_deletion_plans p
              JOIN ownware.source_deletion_inventory i ON i.job_id = p.job_id
              WHERE p.job_id = $1 AND i.artifact_kind = $2 AND i.artifact_id = $3
            `, [jobId, kind, artifactId])
            const sourceId = result.rows[0]?.source_id
            if (sourceId === undefined) return false
            switch (kind) {
              case 'upload_staging':
                await client.query(`DELETE FROM ownware.source_upload_sessions
                  WHERE upload_id = $1 AND source_id = $2`, [artifactId, sourceId])
                return true
              case 'derived_resource':
                await client.query(`DELETE FROM ownware.source_derived_resources
                  WHERE resource_id = $1 AND source_id = $2`, [artifactId, sourceId])
                return true
              case 'source_job':
                await client.query(`DELETE FROM ownware.source_jobs
                  WHERE job_id = $1 AND source_id = $2 AND operation <> 'delete_source'`, [artifactId, sourceId])
                await client.query(`
                  DELETE FROM ownware.source_data_view_jobs d
                  WHERE d.job_id = $1 AND d.source_id = $2
                    AND d.state IN ('succeeded', 'failed', 'cancelled')
                    AND EXISTS (SELECT 1 FROM ownware.source_deletion_inventory i
                      WHERE i.job_id = $3 AND i.artifact_kind = 'data_view'
                        AND i.artifact_id = d.data_view_id AND i.state = 'verified_absent')
                `, [artifactId, sourceId, jobId])
                return true
              case 'idempotency_replay':
              case 'grant_mutation_replay':
                await client.query(`DELETE FROM ownware.run_idempotency
                  WHERE id = $1 AND source_id = $2`, [artifactId, sourceId])
                return true
              case 'access_grant_revocation': {
                const revoked = await ensureGrantRevokedInTransaction(client, jobId, artifactId, now)
                if (revoked.revoked) grantInvalidation = revoked.scope
                return revoked.revoked
              }
              case 'immutable_original':
              case 'placed_candidate': return true
              case 'data_view':
                await client.query(`DELETE FROM ownware.source_data_views
                  WHERE data_view_id = $1 AND source_id = $2`, [artifactId, sourceId])
                return true
              case 'search_index':
              case 'retrieval_cache': return false
            }
          })
          if (grantInvalidation !== null) {
            invalidateGrant(evidenceSearchCache, grantInvalidation, artifactId)
          }
          return removed
        },
      )
    },

    controlArtifactAbsent(kind, artifactId) {
      return repositoryCall(
        context, 'source_deletions', 'controlArtifactAbsent', 'read_failed', async (client) => {
          switch (kind) {
            case 'upload_staging': return (await client.query(
              'SELECT 1 FROM ownware.source_upload_sessions WHERE upload_id = $1', [artifactId],
            )).rowCount === 0
            case 'derived_resource': return (await client.query(
              'SELECT 1 FROM ownware.source_derived_resources WHERE resource_id = $1', [artifactId],
            )).rowCount === 0
            case 'source_job': return (await client.query(
              'SELECT 1 FROM ownware.source_jobs WHERE job_id = $1', [artifactId],
            )).rowCount === 0 && (await client.query(
              'SELECT 1 FROM ownware.source_data_view_jobs WHERE job_id = $1', [artifactId],
            )).rowCount === 0
            case 'idempotency_replay':
            case 'grant_mutation_replay': return (await client.query(
              'SELECT 1 FROM ownware.run_idempotency WHERE id = $1', [artifactId],
            )).rowCount === 0
            case 'access_grant_revocation': return false
            case 'immutable_original':
            case 'placed_candidate': return true
            case 'data_view': return (await client.query(
              'SELECT 1 FROM ownware.source_data_views WHERE data_view_id = $1', [artifactId],
            )).rowCount === 0
            case 'search_index':
            case 'retrieval_cache': return false
          }
        },
      )
    },

    removeRetrievalCacheArtifact(jobId, claimToken, artifactId, now = Date.now()) {
      return repositoryCall(
        context, 'source_deletions', 'removeRetrievalCacheArtifact', 'write_failed', async (client) => {
          if (await activeClaim(client, jobId, claimToken, now) !== 'advanced') return false
          const target = await cacheTarget(client, jobId, artifactId)
          if (target === null || evidenceSearchCache === undefined) return false
          evidenceSearchCache.invalidateSource(target)
          return true
        },
      )
    },

    retrievalCacheArtifactAbsent(jobId, artifactId) {
      return repositoryCall(
        context, 'source_deletions', 'retrievalCacheArtifactAbsent', 'read_failed', async (client) => {
          const target = await cacheTarget(client, jobId, artifactId)
          return target !== null && evidenceSearchCache !== undefined &&
            evidenceSearchCache.inventorySource(target).entries === 0
        },
      )
    },

    finish(jobId, claimToken, now = Date.now()) {
      return repositoryCall(context, 'source_deletions', 'finish', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const claim = await activeClaim(client, jobId, claimToken, now, true)
          if (claim === 'stale_claim' || claim === 'lease_expired') return claim
          const result = await client.query<{
            readonly source_id: string
            readonly workspace_id: string
            readonly profile_id: string
            readonly source_revision: string
            readonly created_at: string
            readonly checkpoint: string
          }>(`
            SELECT j.source_id, j.workspace_id, j.profile_id, j.source_revision,
              j.created_at, j.checkpoint
            FROM ownware.source_jobs j
            JOIN ownware.source_deletion_plans p ON p.job_id = j.job_id
            WHERE j.job_id = $1 AND j.operation = 'delete_source'
          `, [jobId])
          const job = result.rows[0]
          if (job === undefined || safeInteger(job.checkpoint) !== 3) return 'stale_claim'
          const remaining = await client.query<{ readonly count: string }>(`
            SELECT COUNT(*) AS count FROM ownware.source_deletion_inventory
            WHERE job_id = $1 AND state <> 'verified_absent'
          `, [jobId])
          if (safeInteger(remaining.rows[0]?.count ?? '0') > 0) {
            const finished = await client.query(`
              UPDATE ownware.source_jobs SET state = 'partial', claim_token = NULL,
                claimed_by = NULL, lease_expires_at = NULL, retry_after = NULL,
                outcome_code = 'deletion_incomplete', updated_at = $1, terminal_at = $1
              WHERE job_id = $2 AND operation = 'delete_source' AND state = 'running'
                AND claim_token = $3 AND lease_expires_at >= $1 AND checkpoint = 3
            `, [now, jobId, claimToken])
            if (finished.rowCount !== 1) return 'stale_claim'
            const source = await client.query(`
              UPDATE ownware.runtime_sources
              SET deletion_state = 'partially_deleted', updated_at = $1
              WHERE source_id = $2 AND deletion_state = 'deleting' AND revision = $3
            `, [now, job.source_id, safeInteger(job.source_revision)])
            if (source.rowCount !== 1) throw new Error('source deletion state changed')
            return 'partial'
          }
          const residual = await client.query<{ readonly count: string }>(`
            SELECT
              (SELECT COUNT(*) FROM ownware.source_upload_sessions WHERE source_id = $1) +
              (SELECT COUNT(*) FROM ownware.source_derived_resources WHERE source_id = $1) +
              (SELECT COUNT(*) FROM ownware.source_data_views WHERE source_id = $1) +
              (SELECT COUNT(*) FROM ownware.source_data_view_jobs WHERE source_id = $1) +
              (SELECT COUNT(*) FROM ownware.source_jobs WHERE source_id = $1 AND job_id <> $2) +
              (SELECT COUNT(*) FROM ownware.run_idempotency WHERE source_id = $1) +
              (SELECT COUNT(*) FROM ownware.access_grants g
                JOIN ownware.access_grant_revisions r
                  ON r.grant_id = g.grant_id AND r.revision = g.current_revision
                WHERE g.workspace_id = $3 AND g.profile_id = $4 AND r.state = 'active'
                  AND ((r.resource_kind = 'source_resource'
                    AND r.operation IN ('source_content.read', 'source_content.search')
                    AND EXISTS (SELECT 1 FROM ownware.source_deletion_inventory i
                      WHERE i.job_id = $2 AND i.artifact_kind = 'derived_resource'
                        AND i.artifact_id = r.resource_id))
                  OR (r.resource_kind = 'source_data_view'
                    AND r.operation = 'source_data_views.query'
                    AND EXISTS (SELECT 1 FROM ownware.source_deletion_inventory i
                      WHERE i.job_id = $2 AND i.artifact_kind = 'data_view'
                        AND i.artifact_id = r.resource_id)))) AS count
          `, [job.source_id, jobId, job.workspace_id, job.profile_id])
          if (safeInteger(residual.rows[0]?.count ?? '0') !== 0) {
            throw new Error('verified source deletion retained control metadata')
          }
          const counts = await inventoryCounts(client, jobId)
          await insertTombstone(client, {
            jobId,
            workspaceId: job.workspace_id,
            profileId: job.profile_id,
            sourceId: job.source_id,
            state: 'deleted',
            sourceRevision: safeInteger(job.source_revision),
            counts,
            createdAt: safeInteger(job.created_at),
            terminalAt: now,
          })
          await client.query('DELETE FROM ownware.source_deletion_plans WHERE job_id = $1', [jobId])
          const deletedJob = await client.query(`
            DELETE FROM ownware.source_jobs
            WHERE job_id = $1 AND operation = 'delete_source' AND state = 'running'
              AND claim_token = $2 AND lease_expires_at >= $3 AND checkpoint = 3
          `, [jobId, claimToken, now])
          if (deletedJob.rowCount !== 1) throw new Error('source deletion claim changed')
          await client.query('DELETE FROM ownware.source_versions WHERE source_id = $1', [job.source_id])
          const deletedSource = await client.query(`
            DELETE FROM ownware.runtime_sources
            WHERE source_id = $1 AND deletion_state = 'deleting' AND revision = $2
          `, [job.source_id, safeInteger(job.source_revision)])
          if (deletedSource.rowCount !== 1) throw new Error('source deletion fence changed')
          return 'succeeded'
        }))
    },

    retryPartial(jobId, now = Date.now()) {
      return repositoryCall(context, 'source_deletions', 'retryPartial', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => retryPartial(client, jobId, now)))
    },

    retryPartialScoped(jobId, workspaceId, profileId, now = Date.now()) {
      return repositoryCall(
        context, 'source_deletions', 'retryPartialScoped', 'write_failed', async () =>
          withPostgreSqlTransaction(context.pool, async (client) => {
            const row = await getPlanRowByJobScoped(client, jobId, workspaceId, profileId)
            if (row === null) {
              const tombstone = await client.query(`
                SELECT 1 FROM ownware.source_deletion_tombstones
                WHERE job_id = $1 AND workspace_id = $2 AND profile_id = $3
              `, [jobId, workspaceId, profileId])
              return tombstone.rowCount === 0 ? 'missing' : 'not_partial'
            }
            if (publicState(row.job_state) !== 'partially_deleted') return 'not_partial'
            return retryPartial(client, jobId, now)
          }),
      )
    },

    recoverExpiredClaims(now = Date.now()) {
      return repositoryCall(
        context, 'source_deletions', 'recoverExpiredClaims', 'write_failed', async () =>
          withPostgreSqlTransaction(context.pool, async (client) => {
            const requeued = await client.query(`
              UPDATE ownware.source_jobs SET state = 'queued',
                attempt = CASE WHEN checkpoint = 0 AND attempt >= max_attempts THEN 0 ELSE attempt END,
                claim_token = NULL, claimed_by = NULL, lease_expires_at = NULL,
                retry_after = NULL, updated_at = $1
              WHERE operation = 'delete_source' AND state = 'running'
                AND lease_expires_at < $1 AND (attempt < max_attempts OR checkpoint = 0)
            `, [now])
            const partial = await client.query<{ readonly source_id: string }>(`
              UPDATE ownware.source_jobs SET state = 'partial', claim_token = NULL,
                claimed_by = NULL, lease_expires_at = NULL, retry_after = NULL,
                outcome_code = 'deletion_incomplete', updated_at = $1, terminal_at = $1
              WHERE operation = 'delete_source' AND state = 'running'
                AND lease_expires_at < $1 AND attempt >= max_attempts AND checkpoint > 0
              RETURNING source_id
            `, [now])
            if (partial.rows.length > 0) {
              const sourceIds = partial.rows.map((row) => row.source_id)
              const sources = await client.query(`
                UPDATE ownware.runtime_sources SET deletion_state = 'partially_deleted', updated_at = $1
                WHERE source_id = ANY($2::text[]) AND deletion_state = 'deleting'
              `, [now, sourceIds])
              if (sources.rowCount !== partial.rowCount) {
                throw new Error('recovered deletion source state changed')
              }
            }
            return { requeued: requeued.rowCount ?? 0, partial: partial.rowCount ?? 0 }
          }),
      )
    },

    confirmNextCancellation(now = Date.now()) {
      return repositoryCall(
        context, 'source_deletions', 'confirmNextCancellation', 'write_failed', async () =>
          withPostgreSqlTransaction(context.pool, async (client) => {
            const candidate = await client.query<{ readonly job_id: string }>(`
              SELECT job_id FROM ownware.source_jobs
              WHERE operation = 'delete_source' AND state = 'cancel_requested'
                AND checkpoint = 0 AND (claim_token IS NULL OR lease_expires_at < $1)
              ORDER BY updated_at, job_id FOR UPDATE SKIP LOCKED LIMIT 1
            `, [now])
            const jobId = candidate.rows[0]?.job_id
            return jobId === undefined ? false : confirmCancellation(client, jobId, now)
          }),
      )
    },

    requestCancellation(jobId, workspaceId, profileId, now = Date.now()) {
      return repositoryCall(
        context, 'source_deletions', 'requestCancellation', 'write_failed', async () =>
          withPostgreSqlTransaction(context.pool, async (client) => {
            const tombstone = await client.query(`
              SELECT 1 FROM ownware.source_deletion_tombstones
              WHERE job_id = $1 AND workspace_id = $2 AND profile_id = $3
            `, [jobId, workspaceId, profileId])
            if (tombstone.rowCount === 1) return 'terminal'
            const result = await client.query<{ readonly state: string; readonly checkpoint: string }>(`
              SELECT state, checkpoint FROM ownware.source_jobs
              WHERE job_id = $1 AND workspace_id = $2 AND profile_id = $3
                AND operation = 'delete_source' FOR UPDATE
            `, [jobId, workspaceId, profileId])
            const row = result.rows[0]
            if (row === undefined) return 'missing'
            if (row.state === 'cancel_requested') return 'already_requested'
            if (['succeeded', 'partial', 'failed', 'cancelled'].includes(row.state)) return 'terminal'
            if (safeInteger(row.checkpoint) > 0) return 'destruction_started'
            const updated = await client.query(`
              UPDATE ownware.source_jobs SET state = 'cancel_requested',
                cancel_requested_at = $1, retry_after = NULL, updated_at = $1
              WHERE job_id = $2 AND operation = 'delete_source'
                AND state IN ('queued', 'running', 'waiting_for_resource') AND checkpoint = 0
            `, [now, jobId])
            return updated.rowCount === 1 ? 'requested' : 'already_requested'
          }),
      )
    },

    confirmCancellation(jobId, now = Date.now()) {
      return repositoryCall(
        context, 'source_deletions', 'confirmCancellation', 'write_failed', async () =>
          withPostgreSqlTransaction(context.pool, (client) => confirmCancellation(client, jobId, now)),
      )
    },

    ensureGrantRevoked(jobId, grantId, now = Date.now()) {
      return repositoryCall(
        context, 'source_deletions', 'ensureGrantRevoked', 'write_failed', async () => {
          const outcome = await withPostgreSqlTransaction(
            context.pool,
            (client) => ensureGrantRevokedInTransaction(client, jobId, grantId, now),
          )
          if (outcome.revoked && outcome.scope !== null) {
            invalidateGrant(evidenceSearchCache, outcome.scope, grantId)
          }
          return outcome.revoked
        },
      )
    },

    grantRevocationEffective(jobId, grantId) {
      return repositoryCall(
        context, 'source_deletions', 'grantRevocationEffective', 'read_failed', async (client) =>
          (await grantTarget(client, jobId, grantId))?.state === 'revoked',
      )
    },
  }
}

async function insertTombstone(
  client: PostgreSqlQueryClient,
  input: {
    readonly jobId: string
    readonly workspaceId: string
    readonly profileId: string
    readonly sourceId: string
    readonly state: 'cancelled' | 'deleted'
    readonly sourceRevision: number
    readonly counts: SourceDeletionInventoryCounts
    readonly createdAt: number
    readonly terminalAt: number
  },
): Promise<void> {
  await client.query(`
    INSERT INTO ownware.source_deletion_tombstones (
      job_id, workspace_id, profile_id, source_id, state, source_revision,
      immutable_originals, upload_staging, placed_candidates, derived_resources,
      data_views, search_indexes, source_jobs, idempotency_replays,
      retrieval_cache_entries, access_grant_revocations, grant_mutation_replays,
      created_at, terminal_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
      $14, $15, $16, $17, $18, $19)
  `, [
    input.jobId, input.workspaceId, input.profileId, input.sourceId, input.state,
    input.sourceRevision, input.counts.immutableOriginals, input.counts.uploadStaging,
    input.counts.placedCandidates, input.counts.derivedResources, input.counts.dataViews,
    input.counts.searchIndexes, input.counts.sourceJobs, input.counts.idempotencyReplays,
    input.counts.retrievalCacheEntries, input.counts.accessGrantRevocations,
    input.counts.grantMutationReplays, input.createdAt, input.terminalAt,
  ])
}

async function retryPartial(
  client: PostgreSqlQueryClient,
  jobId: string,
  now: number,
): Promise<'queued' | 'not_partial'> {
  const retryable = await client.query(`
    SELECT 1 FROM ownware.source_jobs j
    JOIN ownware.source_deletion_plans p ON p.job_id = j.job_id
    JOIN ownware.runtime_sources s ON s.source_id = p.source_id
    WHERE j.job_id = $1 AND j.operation = 'delete_source' AND j.state = 'partial'
      AND s.deletion_state = 'partially_deleted' AND s.revision = p.source_revision
    FOR UPDATE OF j, s
  `, [jobId])
  if (retryable.rowCount !== 1) return 'not_partial'
  await client.query(`
    UPDATE ownware.source_deletion_inventory
    SET state = 'pending', updated_at = $1, terminal_at = NULL
    WHERE job_id = $2 AND state = 'failed'
  `, [now, jobId])
  const queued = await client.query(`
    UPDATE ownware.source_jobs SET state = 'queued', attempt = 0,
      checkpoint = CASE WHEN checkpoint = 0 THEN 0 ELSE 1 END,
      claim_token = NULL, claimed_by = NULL, lease_expires_at = NULL,
      retry_after = NULL, outcome_code = NULL, updated_at = $1, terminal_at = NULL
    WHERE job_id = $2 AND operation = 'delete_source' AND state = 'partial'
  `, [now, jobId])
  if (queued.rowCount !== 1) return 'not_partial'
  const source = await client.query(`
    UPDATE ownware.runtime_sources SET deletion_state = 'deleting', updated_at = $1
    WHERE source_id = (SELECT source_id FROM ownware.source_deletion_plans WHERE job_id = $2)
      AND deletion_state = 'partially_deleted'
  `, [now, jobId])
  if (source.rowCount !== 1) throw new Error('partial deletion source state changed')
  return 'queued'
}

async function confirmCancellation(
  client: PostgreSqlQueryClient,
  jobId: string,
  now: number,
): Promise<boolean> {
  const result = await client.query<{
    readonly source_id: string
    readonly workspace_id: string
    readonly profile_id: string
    readonly source_revision: string
    readonly created_at: string
  }>(`
    SELECT source_id, workspace_id, profile_id, source_revision, created_at
    FROM ownware.source_jobs
    WHERE job_id = $1 AND operation = 'delete_source'
      AND state = 'cancel_requested' AND checkpoint = 0
      AND (claim_token IS NULL OR lease_expires_at < $2)
    FOR UPDATE
  `, [jobId, now])
  const job = result.rows[0]
  if (job === undefined) return false
  const counts = await inventoryCounts(client, jobId)
  const thawed = await client.query(`
    UPDATE ownware.runtime_sources
    SET deletion_state = 'active', revision = revision + 1, updated_at = $1
    WHERE source_id = $2 AND deletion_state = 'frozen' AND revision = $3
  `, [now, job.source_id, safeInteger(job.source_revision)])
  if (thawed.rowCount !== 1) return false
  await insertTombstone(client, {
    jobId,
    workspaceId: job.workspace_id,
    profileId: job.profile_id,
    sourceId: job.source_id,
    state: 'cancelled',
    sourceRevision: safeInteger(job.source_revision),
    counts,
    createdAt: safeInteger(job.created_at),
    terminalAt: now,
  })
  await client.query('DELETE FROM ownware.source_deletion_plans WHERE job_id = $1', [jobId])
  const cancelled = await client.query(`
    DELETE FROM ownware.source_jobs
    WHERE job_id = $1 AND operation = 'delete_source'
      AND state = 'cancel_requested' AND checkpoint = 0
  `, [jobId])
  if (cancelled.rowCount !== 1) throw new Error('deletion cancellation state changed')
  return true
}
