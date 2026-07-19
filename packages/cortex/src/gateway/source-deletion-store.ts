import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { AccessGrantStore } from './access-grant-store.js'
import type { EvidenceSearchCache } from './evidence-search-cache.js'
import { SOURCE_JOB_LEASE_MS, SOURCE_JOB_MAX_ATTEMPTS } from './source-job-store.js'

export const SOURCE_DELETION_IMPLEMENTATION = 'source_deletion.v1' as const

export type SourceDeletionArtifactKind =
  | 'immutable_original'
  | 'upload_staging'
  | 'placed_candidate'
  | 'derived_resource'
  | 'data_view'
  | 'search_index'
  | 'source_job'
  | 'idempotency_replay'
  | 'retrieval_cache'
  | 'access_grant_revocation'
  | 'grant_mutation_replay'

export interface SourceDeletionPublicCounts {
  readonly immutableOriginals: number
  readonly uploadStaging: number
  readonly placedCandidates: number
  readonly derivedResources: number
  readonly dataViews: number
  readonly searchIndexes: number
  readonly sourceJobs: number
  readonly idempotencyReplays: number
  readonly retrievalCacheEntries: number
}

export interface SourceDeletionInventoryCounts extends SourceDeletionPublicCounts {
  readonly accessGrantRevocations: number
  readonly grantMutationReplays: number
}

export interface SourceDeletionPlan {
  readonly jobId: string
  readonly sourceId: string
  readonly state:
    | 'queued'
    | 'running'
    | 'waiting_for_resource'
    | 'cancel_requested'
    | 'succeeded'
    | 'partial'
    | 'failed'
    | 'cancelled'
  readonly implementationVersion: typeof SOURCE_DELETION_IMPLEMENTATION
  readonly sourceRevision: number
  readonly inventoryState: 'complete'
  readonly inventoryCounts: SourceDeletionInventoryCounts
  readonly createdAt: number
  readonly updatedAt: number
}

export type PublicSourceDeletionState =
  | 'queued'
  | 'deleting'
  | 'cancel_requested'
  | 'cancelled'
  | 'partially_deleted'
  | 'deleted'

export interface PublicSourceDeletion {
  readonly jobId: string
  readonly sourceId: string
  readonly operation: 'delete_source'
  readonly state: PublicSourceDeletionState
  readonly sourceRevision: number
  readonly affected: SourceDeletionPublicCounts
  readonly remaining: SourceDeletionPublicCounts
  readonly createdAt: number
  readonly updatedAt: number
  readonly terminalAt: number | null
}

export type SourceDeletionArtifactState =
  | 'pending'
  | 'removed'
  | 'verified_absent'
  | 'failed'

export interface SourceDeletionInventoryEntry {
  readonly kind: SourceDeletionArtifactKind
  readonly id: string
  readonly state: SourceDeletionArtifactState
}

export interface SourceDeletionDataViewLocator {
  readonly sourceId: string
  readonly sourceVersionId: string
}

export interface SourceDeletionClaim {
  readonly jobId: string
  readonly sourceId: string
  readonly attempt: number
  readonly maxAttempts: typeof SOURCE_JOB_MAX_ATTEMPTS
  readonly checkpoint: number
  readonly claimToken: string
  readonly leaseExpiresAt: number
}

export type SourceDeletionMutationResult =
  | 'advanced'
  | 'stale_claim'
  | 'lease_expired'
  | 'checkpoint_conflict'

export class SourceDeletionPlanError extends Error {
  constructor(readonly code:
    | 'source_not_found'
    | 'source_deletion_revision_conflict'
    | 'source_deletion_not_active') {
    super(code)
    this.name = 'SourceDeletionPlanError'
  }
}

interface DeletionPlanRow {
  readonly job_id: string
  readonly source_id: string
  readonly source_revision: number
  readonly inventory_state: 'pending' | 'complete'
  readonly created_at: number
  readonly updated_at: number
  readonly job_state: SourceDeletionPlan['state']
  readonly job_updated_at: number
  readonly terminal_at: number | null
}

interface DeletionTombstoneRow {
  readonly job_id: string
  readonly workspace_id: string
  readonly profile_id: string
  readonly source_id: string
  readonly state: 'cancelled' | 'deleted'
  readonly source_revision: number
  readonly immutable_originals: number
  readonly upload_staging: number
  readonly placed_candidates: number
  readonly derived_resources: number
  readonly data_views: number
  readonly search_indexes: number
  readonly source_jobs: number
  readonly idempotency_replays: number
  readonly retrieval_cache_entries: number
  readonly access_grant_revocations: number
  readonly grant_mutation_replays: number
  readonly created_at: number
  readonly terminal_at: number
}

export class SourceDeletionStore {
  constructor(
    private readonly db: Database.Database,
    private readonly evidenceSearchCache?: EvidenceSearchCache,
  ) {}

  plan(input: {
    readonly workspaceId: string
    readonly profileId: string
    readonly sourceId: string
    readonly expectedRevision: number
  }, now: number = Date.now()): SourceDeletionPlan {
    return this.db.transaction((): SourceDeletionPlan => {
      const tombstone = this.getDeletedTombstoneBySourceScoped(
        input.sourceId, input.workspaceId, input.profileId,
      )
      if (tombstone) {
        if (input.expectedRevision !== tombstone.source_revision - 1) {
          throw new SourceDeletionPlanError('source_deletion_revision_conflict')
        }
        return this.projectTombstonePlan(tombstone)
      }
      const existing = this.getRowScoped(input.sourceId, input.workspaceId, input.profileId)
      if (existing) {
        if (input.expectedRevision !== existing.source_revision - 1) {
          throw new SourceDeletionPlanError('source_deletion_revision_conflict')
        }
        return this.project(existing)
      }

      const source = this.db.prepare(`
        SELECT revision, deletion_state FROM runtime_sources
        WHERE source_id = ? AND workspace_id = ? AND profile_id = ?
      `).get(input.sourceId, input.workspaceId, input.profileId) as {
        revision: number
        deletion_state: string
      } | undefined
      if (!source) throw new SourceDeletionPlanError('source_not_found')
      if (source.deletion_state !== 'active') {
        throw new SourceDeletionPlanError('source_deletion_not_active')
      }
      if (source.revision !== input.expectedRevision) {
        throw new SourceDeletionPlanError('source_deletion_revision_conflict')
      }

      const sourceRevision = source.revision + 1
      const frozen = this.db.prepare(`
        UPDATE runtime_sources
        SET deletion_state = 'frozen', revision = ?, updated_at = ?
        WHERE source_id = ? AND workspace_id = ? AND profile_id = ?
          AND deletion_state = 'active' AND revision = ?
      `).run(
        sourceRevision,
        now,
        input.sourceId,
        input.workspaceId,
        input.profileId,
        source.revision,
      )
      if (frozen.changes !== 1) {
        throw new SourceDeletionPlanError('source_deletion_revision_conflict')
      }

      const retrievalCacheScope = {
        workspaceId: input.workspaceId,
        profileId: input.profileId,
        sourceId: input.sourceId,
      }
      const retrievalCacheEntries = this.evidenceSearchCache
        ?.inventorySource(retrievalCacheScope).entries ?? 0
      const grantRevocations = new AccessGrantStore(
        this.db, undefined, this.evidenceSearchCache,
      )
        .revokeSourceGrantsForFrozenSource({
          workspaceId: input.workspaceId,
          profileId: input.profileId,
          sourceId: input.sourceId,
        }, now)
      this.evidenceSearchCache?.invalidateSource(retrievalCacheScope)
      this.db.prepare(`
        UPDATE run_idempotency
        SET state = 'indeterminate', status_code = NULL, result_json = NULL,
          updated_at = ?
        WHERE source_id = ? AND source_mutation_kind = 'access_grant'
      `).run(now, input.sourceId)

      this.db.prepare(`
        UPDATE source_upload_sessions
        SET state = 'failed', code = 'source_deletion_frozen', updated_at = ?
        WHERE source_id = ? AND workspace_id = ? AND profile_id = ?
          AND state IN ('open', 'completing')
      `).run(now, input.sourceId, input.workspaceId, input.profileId)
      this.db.prepare(`
        UPDATE source_jobs
        SET state = 'cancel_requested', cancel_requested_at = ?,
          retry_after = NULL, updated_at = ?
        WHERE source_id = ? AND workspace_id = ? AND profile_id = ?
          AND operation IN ('inspect_format', 'extract_text')
          AND state IN ('queued', 'running', 'waiting_for_resource')
      `).run(now, now, input.sourceId, input.workspaceId, input.profileId)
      this.db.prepare(`
        UPDATE source_data_view_jobs
        SET state = 'cancel_requested', cancel_requested_at = ?,
          retry_after = NULL, updated_at = ?
        WHERE source_id = ? AND workspace_id = ? AND profile_id = ?
          AND state IN ('queued', 'running', 'waiting_for_resource')
      `).run(now, now, input.sourceId, input.workspaceId, input.profileId)

      const jobId = randomUUID()
      this.db.prepare(`
        INSERT INTO source_jobs (
          job_id, workspace_id, profile_id, source_id, source_version_id,
          operation, implementation_version, source_revision, resource_id,
          state, attempt, max_attempts, checkpoint, claim_token, claimed_by,
          lease_expires_at, retry_after, cancel_requested_at, outcome_code,
          created_at, updated_at, terminal_at
        ) VALUES (
          ?, ?, ?, ?, NULL, 'delete_source', ?, ?, NULL,
          'queued', 0, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
        )
      `).run(
        jobId,
        input.workspaceId,
        input.profileId,
        input.sourceId,
        SOURCE_DELETION_IMPLEMENTATION,
        sourceRevision,
        SOURCE_JOB_MAX_ATTEMPTS,
        now,
        now,
      )
      this.db.prepare(`
        INSERT INTO source_deletion_plans (
          job_id, workspace_id, profile_id, source_id, source_revision,
          inventory_state, inventory_completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
      `).run(
        jobId,
        input.workspaceId,
        input.profileId,
        input.sourceId,
        sourceRevision,
        now,
        now,
      )

      const insertInventory = this.db.prepare(`
        INSERT INTO source_deletion_inventory (
          job_id, artifact_kind, artifact_id, state, created_at, updated_at, terminal_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, NULL)
      `)
      const inventory = this.collectInventory(
        input.sourceId,
        jobId,
        grantRevocations.map((grant) => grant.grantId),
        retrievalCacheEntries,
      )
      for (const artifact of inventory) {
        insertInventory.run(jobId, artifact.kind, artifact.id, now, now)
      }
      const completed = this.db.prepare(`
        UPDATE source_deletion_plans
        SET inventory_state = 'complete', inventory_completed_at = ?, updated_at = ?
        WHERE job_id = ? AND inventory_state = 'pending'
      `).run(now, now, jobId)
      if (completed.changes !== 1) throw new Error('Deletion inventory did not complete')
      return this.project(this.getRowScoped(
        input.sourceId, input.workspaceId, input.profileId,
      )!)
    }).immediate()
  }

  getScoped(
    sourceId: string,
    workspaceId: string,
    profileId: string,
  ): SourceDeletionPlan | null {
    const row = this.getRowScoped(sourceId, workspaceId, profileId)
    if (row) return this.project(row)
    const tombstone = this.getLatestTombstoneBySourceScoped(sourceId, workspaceId, profileId)
    return tombstone ? this.projectTombstonePlan(tombstone) : null
  }

  getPublicByJobScoped(
    jobId: string,
    workspaceId: string,
    profileId: string,
  ): PublicSourceDeletion | null {
    const row = this.getRowByJobScoped(jobId, workspaceId, profileId)
    if (row) return this.projectPublic(row)
    const tombstone = this.db.prepare(`
      SELECT * FROM source_deletion_tombstones
      WHERE job_id = ? AND workspace_id = ? AND profile_id = ?
    `).get(jobId, workspaceId, profileId) as DeletionTombstoneRow | undefined
    return tombstone ? this.projectPublicTombstone(tombstone) : null
  }

  getPublicBySourceScoped(
    sourceId: string,
    workspaceId: string,
    profileId: string,
  ): PublicSourceDeletion | null {
    const row = this.getRowScoped(sourceId, workspaceId, profileId)
    if (row) return this.projectPublic(row)
    const tombstone = this.getLatestTombstoneBySourceScoped(sourceId, workspaceId, profileId)
    return tombstone ? this.projectPublicTombstone(tombstone) : null
  }

  getInventory(jobId: string): readonly {
    readonly kind: SourceDeletionArtifactKind
    readonly id: string
  }[] {
    const rows = this.db.prepare(`
      SELECT artifact_kind, artifact_id FROM source_deletion_inventory
      WHERE job_id = ? ORDER BY artifact_kind, artifact_id
    `).all(jobId) as Array<{
      artifact_kind: SourceDeletionArtifactKind
      artifact_id: string
    }>
    return rows.map((row) => ({ kind: row.artifact_kind, id: row.artifact_id }))
  }

  getInventoryEntries(jobId: string): readonly SourceDeletionInventoryEntry[] {
    const rows = this.db.prepare(`
      SELECT artifact_kind, artifact_id, state FROM source_deletion_inventory
      WHERE job_id = ? ORDER BY artifact_kind, artifact_id
    `).all(jobId) as Array<{
      artifact_kind: SourceDeletionArtifactKind
      artifact_id: string
      state: SourceDeletionArtifactState
    }>
    return rows.map((row) => ({
      kind: row.artifact_kind,
      id: row.artifact_id,
      state: row.state,
    }))
  }

  versionLocatorMatches(
    jobId: string,
    kind: 'immutable_original' | 'placed_candidate',
    versionId: string,
  ): boolean {
    const plan = this.db.prepare(`
      SELECT source_id FROM source_deletion_plans WHERE job_id = ?
    `).get(jobId) as { source_id: string } | undefined
    if (!plan) return false
    const version = this.db.prepare(`
      SELECT source_id, object_key FROM source_versions WHERE source_version_id = ?
    `).get(versionId) as { source_id: string; object_key: string } | undefined
    if (!version) return kind === 'placed_candidate'
    return version.source_id === plan.source_id &&
      version.object_key === `sources/${plan.source_id}/versions/${versionId}/original`
  }

  dataViewLocator(
    jobId: string,
    dataViewId: string,
  ): SourceDeletionDataViewLocator | null {
    const row = this.db.prepare(`
      SELECT p.source_id, d.source_version_id, v.private_object_key
      FROM source_deletion_plans p
      JOIN source_deletion_inventory i
        ON i.job_id = p.job_id AND i.artifact_kind = 'data_view'
      JOIN source_data_view_jobs d
        ON d.data_view_id = i.artifact_id AND d.source_id = p.source_id
      LEFT JOIN source_data_views v
        ON v.data_view_id = d.data_view_id AND v.job_id = d.job_id
      WHERE p.job_id = ? AND i.artifact_id = ?
    `).get(jobId, dataViewId) as {
      source_id: string
      source_version_id: string
      private_object_key: string | null
    } | undefined
    if (!row) return null
    const expected =
      `sources/${row.source_id}/versions/${row.source_version_id}/data-views/${dataViewId}.json`
    if (row.private_object_key !== null && row.private_object_key !== expected) return null
    return { sourceId: row.source_id, sourceVersionId: row.source_version_id }
  }

  claimNext(workerId: string, now: number = Date.now()): SourceDeletionClaim | null {
    if (!/^[a-z0-9._-]{1,64}$/.test(workerId)) {
      throw new TypeError('Source deletion worker identity is invalid')
    }
    return this.db.transaction((): SourceDeletionClaim | null => {
      const candidate = this.db.prepare(`
        SELECT j.job_id FROM source_jobs j
        WHERE j.operation = 'delete_source' AND j.state = 'queued'
          AND j.attempt < j.max_attempts
          AND NOT EXISTS (
            SELECT 1 FROM source_data_view_jobs d
            WHERE d.source_id = j.source_id AND d.state = 'cancel_requested'
          )
        ORDER BY j.created_at ASC, j.job_id ASC LIMIT 1
      `).get() as { job_id: string } | undefined
      if (!candidate) return null
      const claimToken = randomUUID()
      const leaseExpiresAt = now + SOURCE_JOB_LEASE_MS
      const claimed = this.db.prepare(`
        UPDATE source_jobs
        SET state = 'running', attempt = attempt + 1, claim_token = ?,
          claimed_by = ?, lease_expires_at = ?, updated_at = ?
        WHERE job_id = ? AND operation = 'delete_source' AND state = 'queued'
          AND attempt < max_attempts
      `).run(claimToken, workerId, leaseExpiresAt, now, candidate.job_id)
      if (claimed.changes !== 1) return null
      const row = this.db.prepare(`
        SELECT job_id, source_id, attempt, max_attempts, checkpoint,
          claim_token, lease_expires_at
        FROM source_jobs WHERE job_id = ?
      `).get(candidate.job_id) as {
        job_id: string
        source_id: string
        attempt: number
        max_attempts: typeof SOURCE_JOB_MAX_ATTEMPTS
        checkpoint: number
        claim_token: string
        lease_expires_at: number
      }
      return {
        jobId: row.job_id,
        sourceId: row.source_id,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        checkpoint: row.checkpoint,
        claimToken: row.claim_token,
        leaseExpiresAt: row.lease_expires_at,
      }
    }).immediate()
  }

  startDestruction(
    jobId: string,
    claimToken: string,
    now: number = Date.now(),
  ): SourceDeletionMutationResult {
    return this.db.transaction((): SourceDeletionMutationResult => {
      const claim = this.getActiveClaim(jobId, claimToken, now)
      if (claim !== 'advanced') return claim
      const source = this.db.prepare(`
        UPDATE runtime_sources
        SET deletion_state = 'deleting', updated_at = ?
        WHERE source_id = (
          SELECT source_id FROM source_jobs WHERE job_id = ?
        ) AND deletion_state = 'frozen'
      `).run(now, jobId)
      if (source.changes !== 1) return 'checkpoint_conflict'
      const advanced = this.db.prepare(`
        UPDATE source_jobs SET checkpoint = 1, updated_at = ?
        WHERE job_id = ? AND operation = 'delete_source' AND state = 'running'
          AND claim_token = ? AND lease_expires_at >= ? AND checkpoint = 0
      `).run(now, jobId, claimToken, now)
      return advanced.changes === 1 ? 'advanced' : 'checkpoint_conflict'
    }).immediate()
  }

  renewClaim(
    jobId: string,
    claimToken: string,
    now: number = Date.now(),
  ): boolean {
    return this.db.prepare(`
      UPDATE source_jobs
      SET lease_expires_at = ?, updated_at = ?
      WHERE job_id = ? AND operation = 'delete_source' AND state = 'running'
        AND claim_token = ? AND lease_expires_at >= ?
    `).run(now + SOURCE_JOB_LEASE_MS, now, jobId, claimToken, now).changes === 1
  }

  advanceCheckpoint(
    jobId: string,
    claimToken: string,
    expectedCheckpoint: 1 | 2,
    nextCheckpoint: 2 | 3,
    now: number = Date.now(),
  ): SourceDeletionMutationResult {
    if (nextCheckpoint !== expectedCheckpoint + 1) {
      throw new RangeError('Source deletion checkpoint transition is invalid')
    }
    return this.advanceDeletionCheckpoint(
      jobId, claimToken, expectedCheckpoint, nextCheckpoint, now,
    )
  }

  markArtifact(
    jobId: string,
    claimToken: string,
    kind: SourceDeletionArtifactKind,
    artifactId: string,
    state: 'removed' | 'verified_absent' | 'failed',
    now: number = Date.now(),
  ): SourceDeletionMutationResult {
    const claim = this.getActiveClaim(jobId, claimToken, now)
    if (claim !== 'advanced') return claim
    const terminalAt = state === 'verified_absent' || state === 'failed' ? now : null
    const updated = this.db.prepare(`
      UPDATE source_deletion_inventory
      SET state = ?, updated_at = ?, terminal_at = ?
      WHERE job_id = ? AND artifact_kind = ? AND artifact_id = ?
        AND state != 'verified_absent'
    `).run(state, now, terminalAt, jobId, kind, artifactId)
    return updated.changes === 1 ? 'advanced' : 'checkpoint_conflict'
  }

  removeControlArtifact(
    jobId: string,
    claimToken: string,
    kind: SourceDeletionArtifactKind,
    artifactId: string,
    now: number = Date.now(),
  ): boolean {
    if (this.getActiveClaim(jobId, claimToken, now) !== 'advanced') return false
    const plan = this.db.prepare(`
      SELECT p.source_id FROM source_deletion_plans p
      JOIN source_deletion_inventory i ON i.job_id = p.job_id
      WHERE p.job_id = ? AND i.artifact_kind = ? AND i.artifact_id = ?
    `).get(jobId, kind, artifactId) as { source_id: string } | undefined
    if (!plan) return false
    switch (kind) {
      case 'upload_staging':
        this.db.prepare(`
          DELETE FROM source_upload_sessions WHERE upload_id = ? AND source_id = ?
        `).run(artifactId, plan.source_id)
        return true
      case 'derived_resource':
        this.db.prepare(`
          DELETE FROM source_derived_resources WHERE resource_id = ? AND source_id = ?
        `).run(artifactId, plan.source_id)
        return true
      case 'source_job':
        this.db.prepare(`
          DELETE FROM source_jobs
          WHERE job_id = ? AND source_id = ? AND operation != 'delete_source'
        `).run(artifactId, plan.source_id)
        this.db.prepare(`
          DELETE FROM source_data_view_jobs
          WHERE job_id = ? AND source_id = ?
            AND state IN ('succeeded', 'failed', 'cancelled')
            AND EXISTS (
              SELECT 1 FROM source_deletion_inventory i
              WHERE i.job_id = ? AND i.artifact_kind = 'data_view'
                AND i.artifact_id = source_data_view_jobs.data_view_id
                AND i.state = 'verified_absent'
            )
        `).run(artifactId, plan.source_id, jobId)
        return true
      case 'idempotency_replay':
      case 'grant_mutation_replay':
        this.db.prepare(`
          DELETE FROM run_idempotency WHERE id = ? AND source_id = ?
        `).run(artifactId, plan.source_id)
        return true
      case 'access_grant_revocation':
        return this.ensureGrantRevoked(jobId, artifactId, now)
      case 'immutable_original':
      case 'placed_candidate':
        return true
      case 'data_view':
        this.db.prepare(`
          DELETE FROM source_data_views
          WHERE data_view_id = ? AND source_id = ?
        `).run(artifactId, plan.source_id)
        return true
      case 'search_index':
      case 'retrieval_cache':
        return false
    }
  }

  controlArtifactAbsent(
    kind: SourceDeletionArtifactKind,
    artifactId: string,
  ): boolean {
    switch (kind) {
      case 'upload_staging':
        return this.db.prepare(
          'SELECT 1 FROM source_upload_sessions WHERE upload_id = ?',
        ).get(artifactId) === undefined
      case 'derived_resource':
        return this.db.prepare(
          'SELECT 1 FROM source_derived_resources WHERE resource_id = ?',
        ).get(artifactId) === undefined
      case 'source_job':
        return this.db.prepare(
          'SELECT 1 FROM source_jobs WHERE job_id = ?',
        ).get(artifactId) === undefined && this.db.prepare(
          'SELECT 1 FROM source_data_view_jobs WHERE job_id = ?',
        ).get(artifactId) === undefined
      case 'idempotency_replay':
      case 'grant_mutation_replay':
        return this.db.prepare(
          'SELECT 1 FROM run_idempotency WHERE id = ?',
        ).get(artifactId) === undefined
      case 'access_grant_revocation':
        return false
      case 'immutable_original':
      case 'placed_candidate':
        return true
      case 'data_view':
        return this.db.prepare(
          'SELECT 1 FROM source_data_views WHERE data_view_id = ?',
        ).get(artifactId) === undefined
      case 'search_index':
      case 'retrieval_cache':
        return false
    }
  }

  removeRetrievalCacheArtifact(
    jobId: string,
    claimToken: string,
    artifactId: string,
    now: number = Date.now(),
  ): boolean {
    if (this.getActiveClaim(jobId, claimToken, now) !== 'advanced') return false
    const target = this.retrievalCacheTarget(jobId, artifactId)
    if (!target || !this.evidenceSearchCache) return false
    this.evidenceSearchCache.invalidateSource(target)
    return true
  }

  retrievalCacheArtifactAbsent(jobId: string, artifactId: string): boolean {
    const target = this.retrievalCacheTarget(jobId, artifactId)
    return target !== null && this.evidenceSearchCache !== undefined &&
      this.evidenceSearchCache.inventorySource(target).entries === 0
  }

  finish(
    jobId: string,
    claimToken: string,
    now: number = Date.now(),
  ): 'succeeded' | 'partial' | 'stale_claim' | 'lease_expired' {
    return this.db.transaction((): 'succeeded' | 'partial' | 'stale_claim' | 'lease_expired' => {
      const claim = this.getActiveClaim(jobId, claimToken, now)
      if (claim === 'stale_claim' || claim === 'lease_expired') return claim
      const job = this.db.prepare(`
        SELECT j.source_id, j.workspace_id, j.profile_id, j.source_revision,
          j.created_at, j.checkpoint
        FROM source_jobs j
        JOIN source_deletion_plans p ON p.job_id = j.job_id
        WHERE j.job_id = ? AND j.operation = 'delete_source'
      `).get(jobId) as {
        source_id: string
        workspace_id: string
        profile_id: string
        source_revision: number
        created_at: number
        checkpoint: number
      } | undefined
      if (!job || job.checkpoint !== 3) return 'stale_claim'
      const remaining = this.db.prepare(`
        SELECT COUNT(*) AS count FROM source_deletion_inventory
        WHERE job_id = ? AND state != 'verified_absent'
      `).get(jobId) as { count: number }
      if (remaining.count > 0) {
        const finished = this.db.prepare(`
          UPDATE source_jobs
          SET state = 'partial', claim_token = NULL, claimed_by = NULL,
            lease_expires_at = NULL, retry_after = NULL,
            outcome_code = 'deletion_incomplete', updated_at = ?, terminal_at = ?
          WHERE job_id = ? AND operation = 'delete_source' AND state = 'running'
            AND claim_token = ? AND lease_expires_at >= ? AND checkpoint = 3
        `).run(now, now, jobId, claimToken, now)
        if (finished.changes !== 1) return 'stale_claim'
        const source = this.db.prepare(`
          UPDATE runtime_sources
          SET deletion_state = 'partially_deleted', updated_at = ?
          WHERE source_id = ? AND deletion_state = 'deleting'
            AND revision = ?
        `).run(now, job.source_id, job.source_revision)
        if (source.changes !== 1) throw new Error('Source deletion state changed')
        return 'partial'
      }

      const residual = this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM source_upload_sessions WHERE source_id = ?) +
          (SELECT COUNT(*) FROM source_derived_resources WHERE source_id = ?) +
          (SELECT COUNT(*) FROM source_data_views WHERE source_id = ?) +
          (SELECT COUNT(*) FROM source_data_view_jobs WHERE source_id = ?) +
          (SELECT COUNT(*) FROM source_jobs
            WHERE source_id = ? AND job_id != ?) +
          (SELECT COUNT(*) FROM run_idempotency WHERE source_id = ?) +
          (SELECT COUNT(*)
            FROM access_grants g
            JOIN access_grant_revisions r
              ON r.grant_id = g.grant_id AND r.revision = g.current_revision
            WHERE g.workspace_id = ? AND g.profile_id = ?
              AND r.state = 'active'
              AND (
                (
                  r.resource_kind = 'source_resource'
                  AND r.operation IN ('source_content.read', 'source_content.search')
                  AND EXISTS (
                    SELECT 1 FROM source_deletion_inventory i
                    WHERE i.job_id = ? AND i.artifact_kind = 'derived_resource'
                      AND i.artifact_id = r.resource_id
                  )
                ) OR (
                  r.resource_kind = 'source_data_view'
                  AND r.operation = 'source_data_views.query'
                  AND EXISTS (
                    SELECT 1 FROM source_deletion_inventory i
                    WHERE i.job_id = ? AND i.artifact_kind = 'data_view'
                      AND i.artifact_id = r.resource_id
                  )
                )
              )) AS count
      `).get(
        job.source_id,
        job.source_id,
        job.source_id,
        job.source_id,
        job.source_id,
        jobId,
        job.source_id,
        job.workspace_id,
        job.profile_id,
        jobId,
        jobId,
      ) as { count: number }
      if (residual.count !== 0) {
        throw new Error('Verified source deletion retained unplanned control metadata')
      }
      const counts = this.inventoryCounts(jobId)
      this.db.prepare(`
        INSERT INTO source_deletion_tombstones (
          job_id, workspace_id, profile_id, source_id, state, source_revision,
          immutable_originals, upload_staging, placed_candidates,
          derived_resources, data_views, search_indexes, source_jobs,
          idempotency_replays, retrieval_cache_entries,
          access_grant_revocations, grant_mutation_replays,
          created_at, terminal_at
        ) VALUES (?, ?, ?, ?, 'deleted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        jobId,
        job.workspace_id,
        job.profile_id,
        job.source_id,
        job.source_revision,
        counts.immutableOriginals,
        counts.uploadStaging,
        counts.placedCandidates,
        counts.derivedResources,
        counts.dataViews,
        counts.searchIndexes,
        counts.sourceJobs,
        counts.idempotencyReplays,
        counts.retrievalCacheEntries,
        counts.accessGrantRevocations,
        counts.grantMutationReplays,
        job.created_at,
        now,
      )
      this.db.prepare('DELETE FROM source_deletion_plans WHERE job_id = ?').run(jobId)
      const deletedJob = this.db.prepare(`
        DELETE FROM source_jobs
        WHERE job_id = ? AND operation = 'delete_source' AND state = 'running'
          AND claim_token = ? AND lease_expires_at >= ? AND checkpoint = 3
      `).run(jobId, claimToken, now)
      if (deletedJob.changes !== 1) throw new Error('Source deletion claim changed')
      this.db.prepare('DELETE FROM source_versions WHERE source_id = ?').run(job.source_id)
      const deletedSource = this.db.prepare(`
        DELETE FROM runtime_sources
        WHERE source_id = ? AND deletion_state = 'deleting' AND revision = ?
      `).run(job.source_id, job.source_revision)
      if (deletedSource.changes !== 1) throw new Error('Source deletion fence changed')
      return 'succeeded'
    }).immediate()
  }

  retryPartial(jobId: string, now: number = Date.now()): 'queued' | 'not_partial' {
    return this.db.transaction((): 'queued' | 'not_partial' => {
      const retryable = this.db.prepare(`
        SELECT 1 FROM source_jobs j
        JOIN source_deletion_plans p ON p.job_id = j.job_id
        JOIN runtime_sources s ON s.source_id = p.source_id
        WHERE j.job_id = ? AND j.operation = 'delete_source' AND j.state = 'partial'
          AND s.deletion_state = 'partially_deleted' AND s.revision = p.source_revision
      `).get(jobId)
      if (!retryable) return 'not_partial'
      this.db.prepare(`
        UPDATE source_deletion_inventory
        SET state = 'pending', updated_at = ?, terminal_at = NULL
        WHERE job_id = ? AND state = 'failed'
      `).run(now, jobId)
      const queued = this.db.prepare(`
        UPDATE source_jobs
        SET state = 'queued', attempt = 0,
          checkpoint = CASE WHEN checkpoint = 0 THEN 0 ELSE 1 END,
          claim_token = NULL,
          claimed_by = NULL, lease_expires_at = NULL, retry_after = NULL,
          outcome_code = NULL, updated_at = ?, terminal_at = NULL
        WHERE job_id = ? AND operation = 'delete_source' AND state = 'partial'
      `).run(now, jobId)
      if (queued.changes === 1) {
        const source = this.db.prepare(`
          UPDATE runtime_sources
          SET deletion_state = 'deleting', updated_at = ?
          WHERE source_id = (
            SELECT source_id FROM source_deletion_plans WHERE job_id = ?
          ) AND deletion_state = 'partially_deleted'
        `).run(now, jobId)
        if (source.changes !== 1) throw new Error('Partial deletion source state changed')
      }
      return queued.changes === 1 ? 'queued' : 'not_partial'
    }).immediate()
  }

  retryPartialScoped(
    jobId: string,
    workspaceId: string,
    profileId: string,
    now: number = Date.now(),
  ): 'queued' | 'not_partial' | 'missing' {
    const existing = this.getPublicByJobScoped(jobId, workspaceId, profileId)
    if (!existing) return 'missing'
    if (existing.state !== 'partially_deleted') return 'not_partial'
    return this.retryPartial(jobId, now)
  }

  recoverExpiredClaims(now: number = Date.now()): {
    readonly requeued: number
    readonly partial: number
  } {
    return this.db.transaction(() => {
      const requeued = this.db.prepare(`
        UPDATE source_jobs
        SET state = 'queued',
          attempt = CASE WHEN checkpoint = 0 AND attempt >= max_attempts
            THEN 0 ELSE attempt END,
          claim_token = NULL, claimed_by = NULL,
          lease_expires_at = NULL, retry_after = NULL, updated_at = ?
        WHERE operation = 'delete_source' AND state = 'running'
          AND lease_expires_at < ? AND (attempt < max_attempts OR checkpoint = 0)
      `).run(now, now).changes
      const partial = this.db.prepare(`
        UPDATE source_jobs
        SET state = 'partial', claim_token = NULL, claimed_by = NULL,
          lease_expires_at = NULL, retry_after = NULL,
          outcome_code = 'deletion_incomplete', updated_at = ?, terminal_at = ?
        WHERE operation = 'delete_source' AND state = 'running'
          AND lease_expires_at < ? AND attempt >= max_attempts AND checkpoint > 0
      `).run(now, now, now).changes
      const partialSources = this.db.prepare(`
        UPDATE runtime_sources
        SET deletion_state = 'partially_deleted', updated_at = ?
        WHERE source_id IN (
          SELECT source_id FROM source_jobs
          WHERE operation = 'delete_source' AND state = 'partial'
            AND terminal_at = ?
        ) AND deletion_state = 'deleting'
      `).run(now, now)
      if (partialSources.changes !== partial) {
        throw new Error('Recovered deletion source state changed')
      }
      return { requeued, partial }
    }).immediate()
  }

  confirmNextCancellation(now: number = Date.now()): boolean {
    const candidate = this.db.prepare(`
      SELECT job_id FROM source_jobs
      WHERE operation = 'delete_source' AND state = 'cancel_requested'
        AND checkpoint = 0 AND (claim_token IS NULL OR lease_expires_at < ?)
      ORDER BY updated_at ASC, job_id ASC LIMIT 1
    `).get(now) as { job_id: string } | undefined
    return candidate !== undefined && this.confirmCancellation(candidate.job_id, now)
  }

  requestCancellation(
    jobId: string,
    workspaceId: string,
    profileId: string,
    now: number = Date.now(),
  ): 'requested' | 'already_requested' | 'destruction_started' | 'terminal' | 'missing' {
    if (this.db.prepare(`
      SELECT 1 FROM source_deletion_tombstones
      WHERE job_id = ? AND workspace_id = ? AND profile_id = ?
    `).get(jobId, workspaceId, profileId)) return 'terminal'
    const row = this.db.prepare(`
      SELECT state, checkpoint FROM source_jobs
      WHERE job_id = ? AND workspace_id = ? AND profile_id = ?
        AND operation = 'delete_source'
    `).get(jobId, workspaceId, profileId) as {
      state: string
      checkpoint: number
    } | undefined
    if (!row) return 'missing'
    if (row.state === 'cancel_requested') return 'already_requested'
    if (['succeeded', 'partial', 'failed', 'cancelled'].includes(row.state)) return 'terminal'
    if (row.checkpoint > 0) return 'destruction_started'
    const updated = this.db.prepare(`
      UPDATE source_jobs SET state = 'cancel_requested', cancel_requested_at = ?,
        retry_after = NULL, updated_at = ?
      WHERE job_id = ? AND operation = 'delete_source'
        AND state IN ('queued', 'running', 'waiting_for_resource')
        AND checkpoint = 0
    `).run(now, now, jobId)
    if (updated.changes === 1) return 'requested'
    const current = this.db.prepare(`
      SELECT checkpoint FROM source_jobs WHERE job_id = ? AND operation = 'delete_source'
    `).get(jobId) as { checkpoint: number } | undefined
    return current && current.checkpoint > 0 ? 'destruction_started' : 'already_requested'
  }

  confirmCancellation(jobId: string, now: number = Date.now()): boolean {
    return this.db.transaction((): boolean => {
      const job = this.db.prepare(`
        SELECT source_id, workspace_id, profile_id, source_revision, created_at
        FROM source_jobs WHERE job_id = ? AND operation = 'delete_source'
          AND state = 'cancel_requested' AND checkpoint = 0
          AND (claim_token IS NULL OR lease_expires_at < ?)
      `).get(jobId, now) as {
        source_id: string
        workspace_id: string
        profile_id: string
        source_revision: number
        created_at: number
      } | undefined
      if (!job) return false
      const counts = this.inventoryCounts(jobId)
      const thawed = this.db.prepare(`
        UPDATE runtime_sources
        SET deletion_state = 'active', revision = revision + 1, updated_at = ?
        WHERE source_id = ? AND deletion_state = 'frozen' AND revision = ?
      `).run(now, job.source_id, job.source_revision)
      if (thawed.changes !== 1) return false
      this.db.prepare(`
        INSERT INTO source_deletion_tombstones (
          job_id, workspace_id, profile_id, source_id, state, source_revision,
          immutable_originals, upload_staging, placed_candidates,
          derived_resources, data_views, search_indexes, source_jobs,
          idempotency_replays, retrieval_cache_entries,
          access_grant_revocations, grant_mutation_replays,
          created_at, terminal_at
        ) VALUES (?, ?, ?, ?, 'cancelled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        jobId,
        job.workspace_id,
        job.profile_id,
        job.source_id,
        job.source_revision,
        counts.immutableOriginals,
        counts.uploadStaging,
        counts.placedCandidates,
        counts.derivedResources,
        counts.dataViews,
        counts.searchIndexes,
        counts.sourceJobs,
        counts.idempotencyReplays,
        counts.retrievalCacheEntries,
        counts.accessGrantRevocations,
        counts.grantMutationReplays,
        job.created_at,
        now,
      )
      this.db.prepare('DELETE FROM source_deletion_plans WHERE job_id = ?').run(jobId)
      const cancelled = this.db.prepare(`
        DELETE FROM source_jobs
        WHERE job_id = ? AND operation = 'delete_source'
          AND state = 'cancel_requested' AND checkpoint = 0
      `).run(jobId)
      if (cancelled.changes !== 1) throw new Error('Deletion cancellation state changed')
      return true
    }).immediate()
  }

  private collectInventory(
    sourceId: string,
    deletionJobId: string,
    revokedGrantIds: readonly string[],
    retrievalCacheEntries: number,
  ): Array<{ readonly kind: SourceDeletionArtifactKind; readonly id: string }> {
    const inventory: Array<{ kind: SourceDeletionArtifactKind; id: string }> = []
    const append = (kind: SourceDeletionArtifactKind, sql: string): void => {
      const ids = this.db.prepare(sql).all(sourceId) as Array<{ id: string }>
      for (const row of ids) inventory.push({ kind, id: row.id })
    }
    append('immutable_original', `
      SELECT source_version_id AS id FROM source_versions WHERE source_id = ?
    `)
    append('upload_staging', `
      SELECT upload_id AS id FROM source_upload_sessions WHERE source_id = ?
    `)
    append('placed_candidate', `
      SELECT DISTINCT pending_version_id AS id FROM source_upload_sessions
      WHERE source_id = ? AND pending_version_id IS NOT NULL
    `)
    append('derived_resource', `
      SELECT resource_id AS id FROM source_derived_resources WHERE source_id = ?
    `)
    append('data_view', `
      SELECT data_view_id AS id FROM source_data_view_jobs WHERE source_id = ?
    `)
    const jobs = this.db.prepare(`
      SELECT job_id AS id FROM source_jobs WHERE source_id = ? AND job_id != ?
    `).all(sourceId, deletionJobId) as Array<{ id: string }>
    for (const row of jobs) inventory.push({ kind: 'source_job', id: row.id })
    const dataViewJobs = this.db.prepare(`
      SELECT job_id AS id FROM source_data_view_jobs WHERE source_id = ?
    `).all(sourceId) as Array<{ id: string }>
    for (const row of dataViewJobs) inventory.push({ kind: 'source_job', id: row.id })
    for (const grantId of revokedGrantIds) {
      inventory.push({ kind: 'access_grant_revocation', id: grantId })
    }
    for (let ordinal = 0; ordinal < retrievalCacheEntries; ordinal += 1) {
      inventory.push({ kind: 'retrieval_cache', id: randomUUID() })
    }
    append('grant_mutation_replay', `
      SELECT id FROM run_idempotency
      WHERE source_id = ? AND source_mutation_kind = 'access_grant'
    `)
    append('idempotency_replay', `
      SELECT id FROM run_idempotency
      WHERE source_id = ? AND source_mutation_kind IS NULL
    `)
    return inventory
  }

  private retrievalCacheTarget(jobId: string, artifactId: string): {
    readonly workspaceId: string
    readonly profileId: string
    readonly sourceId: string
  } | null {
    const row = this.db.prepare(`
      SELECT p.workspace_id, p.profile_id, p.source_id
      FROM source_deletion_plans p
      JOIN source_deletion_inventory i ON i.job_id = p.job_id
      WHERE p.job_id = ? AND i.artifact_kind = 'retrieval_cache'
        AND i.artifact_id = ?
    `).get(jobId, artifactId) as {
      workspace_id: string
      profile_id: string
      source_id: string
    } | undefined
    return row ? {
      workspaceId: row.workspace_id,
      profileId: row.profile_id,
      sourceId: row.source_id,
    } : null
  }

  ensureGrantRevoked(jobId: string, grantId: string, now: number = Date.now()): boolean {
    const target = this.grantRevocationTarget(jobId, grantId)
    if (!target) return false
    if (target.state === 'revoked') return true
    try {
      new AccessGrantStore(this.db, undefined, this.evidenceSearchCache).revoke({
        grantId,
        workspaceId: target.workspaceId,
        profileId: target.profileId,
        expectedRevision: target.revision,
      }, now)
      return true
    } catch {
      return false
    }
  }

  grantRevocationEffective(jobId: string, grantId: string): boolean {
    return this.grantRevocationTarget(jobId, grantId)?.state === 'revoked'
  }

  private grantRevocationTarget(jobId: string, grantId: string): {
    readonly workspaceId: string
    readonly profileId: string
    readonly revision: number
    readonly state: 'active' | 'revoked'
  } | null {
    const row = this.db.prepare(`
      SELECT p.workspace_id, p.profile_id, g.current_revision, r.state
      FROM source_deletion_plans p
      JOIN source_deletion_inventory gi
        ON gi.job_id = p.job_id
        AND gi.artifact_kind = 'access_grant_revocation'
        AND gi.artifact_id = ?
      JOIN access_grants g
        ON g.grant_id = gi.artifact_id
        AND g.workspace_id = p.workspace_id
        AND g.profile_id = p.profile_id
      JOIN access_grant_revisions r
        ON r.grant_id = g.grant_id AND r.revision = g.current_revision
      WHERE p.job_id = ?
        AND (
          (
            r.resource_kind = 'source_resource'
            AND r.operation IN ('source_content.read', 'source_content.search')
            AND EXISTS (
              SELECT 1 FROM source_deletion_inventory di
              WHERE di.job_id = p.job_id AND di.artifact_kind = 'derived_resource'
                AND di.artifact_id = r.resource_id
            )
          ) OR (
            r.resource_kind = 'source_data_view'
            AND r.operation = 'source_data_views.query'
            AND EXISTS (
              SELECT 1 FROM source_deletion_inventory di
              WHERE di.job_id = p.job_id AND di.artifact_kind = 'data_view'
                AND di.artifact_id = r.resource_id
            )
          )
        )
    `).get(grantId, jobId) as {
      workspace_id: string
      profile_id: string
      current_revision: number
      state: 'active' | 'revoked'
    } | undefined
    return row ? {
      workspaceId: row.workspace_id,
      profileId: row.profile_id,
      revision: row.current_revision,
      state: row.state,
    } : null
  }

  private advanceDeletionCheckpoint(
    jobId: string,
    claimToken: string,
    expectedCheckpoint: number,
    nextCheckpoint: number,
    now: number,
  ): SourceDeletionMutationResult {
    const claim = this.getActiveClaim(jobId, claimToken, now)
    if (claim !== 'advanced') return claim
    const advanced = this.db.prepare(`
      UPDATE source_jobs SET checkpoint = ?, updated_at = ?
      WHERE job_id = ? AND operation = 'delete_source' AND state = 'running'
        AND claim_token = ? AND lease_expires_at >= ? AND checkpoint = ?
    `).run(nextCheckpoint, now, jobId, claimToken, now, expectedCheckpoint)
    return advanced.changes === 1 ? 'advanced' : 'checkpoint_conflict'
  }

  private getActiveClaim(
    jobId: string,
    claimToken: string,
    now: number,
  ): 'advanced' | 'stale_claim' | 'lease_expired' {
    const row = this.db.prepare(`
      SELECT state, claim_token, lease_expires_at FROM source_jobs
      WHERE job_id = ? AND operation = 'delete_source'
    `).get(jobId) as {
      state: string
      claim_token: string | null
      lease_expires_at: number | null
    } | undefined
    if (!row || row.state !== 'running' || row.claim_token !== claimToken) {
      return 'stale_claim'
    }
    if (row.lease_expires_at === null || row.lease_expires_at < now) {
      return 'lease_expired'
    }
    return 'advanced'
  }

  private getRowScoped(
    sourceId: string,
    workspaceId: string,
    profileId: string,
  ): DeletionPlanRow | null {
    return (this.db.prepare(`
      SELECT p.*, j.state AS job_state, j.updated_at AS job_updated_at,
        j.terminal_at AS terminal_at
      FROM source_deletion_plans p
      JOIN source_jobs j ON j.job_id = p.job_id AND j.operation = 'delete_source'
      WHERE p.source_id = ? AND p.workspace_id = ? AND p.profile_id = ?
    `).get(sourceId, workspaceId, profileId) as DeletionPlanRow | undefined) ?? null
  }

  private getRowByJobScoped(
    jobId: string,
    workspaceId: string,
    profileId: string,
  ): DeletionPlanRow | null {
    return (this.db.prepare(`
      SELECT p.*, j.state AS job_state, j.updated_at AS job_updated_at,
        j.terminal_at AS terminal_at
      FROM source_deletion_plans p
      JOIN source_jobs j ON j.job_id = p.job_id AND j.operation = 'delete_source'
      WHERE p.job_id = ? AND p.workspace_id = ? AND p.profile_id = ?
    `).get(jobId, workspaceId, profileId) as DeletionPlanRow | undefined) ?? null
  }

  private getDeletedTombstoneBySourceScoped(
    sourceId: string,
    workspaceId: string,
    profileId: string,
  ): DeletionTombstoneRow | null {
    return (this.db.prepare(`
      SELECT * FROM source_deletion_tombstones
      WHERE source_id = ? AND workspace_id = ? AND profile_id = ?
        AND state = 'deleted'
      ORDER BY terminal_at DESC LIMIT 1
    `).get(sourceId, workspaceId, profileId) as DeletionTombstoneRow | undefined) ?? null
  }

  private getLatestTombstoneBySourceScoped(
    sourceId: string,
    workspaceId: string,
    profileId: string,
  ): DeletionTombstoneRow | null {
    return (this.db.prepare(`
      SELECT * FROM source_deletion_tombstones
      WHERE source_id = ? AND workspace_id = ? AND profile_id = ?
      ORDER BY terminal_at DESC, state = 'deleted' DESC LIMIT 1
    `).get(sourceId, workspaceId, profileId) as DeletionTombstoneRow | undefined) ?? null
  }

  private project(row: DeletionPlanRow): SourceDeletionPlan {
    if (row.inventory_state !== 'complete') {
      throw new Error('Deletion inventory is not complete')
    }
    const counts = this.inventoryCounts(row.job_id)
    return {
      jobId: row.job_id,
      sourceId: row.source_id,
      state: row.job_state,
      implementationVersion: SOURCE_DELETION_IMPLEMENTATION,
      sourceRevision: row.source_revision,
      inventoryState: 'complete',
      inventoryCounts: counts,
      createdAt: row.created_at,
      updatedAt: row.job_updated_at,
    }
  }

  private projectTombstonePlan(row: DeletionTombstoneRow): SourceDeletionPlan {
    return {
      jobId: row.job_id,
      sourceId: row.source_id,
      state: row.state === 'deleted' ? 'succeeded' : 'cancelled',
      implementationVersion: SOURCE_DELETION_IMPLEMENTATION,
      sourceRevision: row.source_revision,
      inventoryState: 'complete',
      inventoryCounts: countsFromTombstone(row),
      createdAt: row.created_at,
      updatedAt: row.terminal_at,
    }
  }

  private projectPublic(row: DeletionPlanRow): PublicSourceDeletion {
    const affected = this.inventoryCounts(row.job_id)
    return {
      jobId: row.job_id,
      sourceId: row.source_id,
      operation: 'delete_source',
      state: publicState(row.job_state),
      sourceRevision: row.source_revision,
      affected: publicCounts(affected),
      remaining: publicCounts(this.inventoryCounts(row.job_id, true)),
      createdAt: row.created_at,
      updatedAt: row.job_updated_at,
      terminalAt: row.terminal_at,
    }
  }

  private projectPublicTombstone(row: DeletionTombstoneRow): PublicSourceDeletion {
    const affected = countsFromTombstone(row)
    return {
      jobId: row.job_id,
      sourceId: row.source_id,
      operation: 'delete_source',
      state: row.state,
      sourceRevision: row.source_revision,
      affected: publicCounts(affected),
      remaining: row.state === 'deleted'
        ? publicCounts(emptyCounts())
        : publicCounts(affected),
      createdAt: row.created_at,
      updatedAt: row.terminal_at,
      terminalAt: row.terminal_at,
    }
  }

  private inventoryCounts(jobId: string, remainingOnly = false): SourceDeletionInventoryCounts {
    const counts = Object.fromEntries((this.db.prepare(`
      SELECT artifact_kind, COUNT(*) AS count FROM source_deletion_inventory
      WHERE job_id = ? AND (? = 0 OR state != 'verified_absent')
      GROUP BY artifact_kind
    `).all(jobId, remainingOnly ? 1 : 0) as Array<{
      artifact_kind: SourceDeletionArtifactKind
      count: number
    }>).map((entry) => [entry.artifact_kind, entry.count])) as Partial<
      Record<SourceDeletionArtifactKind, number>
    >
    return {
      immutableOriginals: counts.immutable_original ?? 0,
      uploadStaging: counts.upload_staging ?? 0,
      placedCandidates: counts.placed_candidate ?? 0,
      derivedResources: counts.derived_resource ?? 0,
      dataViews: counts.data_view ?? 0,
      searchIndexes: counts.search_index ?? 0,
      sourceJobs: counts.source_job ?? 0,
      idempotencyReplays: counts.idempotency_replay ?? 0,
      retrievalCacheEntries: counts.retrieval_cache ?? 0,
      accessGrantRevocations: counts.access_grant_revocation ?? 0,
      grantMutationReplays: counts.grant_mutation_replay ?? 0,
    }
  }
}

function countsFromTombstone(row: DeletionTombstoneRow): SourceDeletionInventoryCounts {
  return {
    immutableOriginals: row.immutable_originals,
    uploadStaging: row.upload_staging,
    placedCandidates: row.placed_candidates,
    derivedResources: row.derived_resources,
    dataViews: row.data_views,
    searchIndexes: row.search_indexes,
    sourceJobs: row.source_jobs,
    idempotencyReplays: row.idempotency_replays,
    retrievalCacheEntries: row.retrieval_cache_entries,
    accessGrantRevocations: row.access_grant_revocations,
    grantMutationReplays: row.grant_mutation_replays,
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

function publicState(state: SourceDeletionPlan['state']): PublicSourceDeletionState {
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
