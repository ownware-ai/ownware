import type Database from 'better-sqlite3'

export type SourceQuotaResourceClass =
  | 'source_registrations'
  | 'source_storage_bytes'
  | 'source_upload_sessions'
  | 'source_jobs'
  | 'source_derived_resources'

export interface SourceQuotaCeilings {
  readonly maxSourceRegistrations: number
  readonly maxRetainedAndReservedBytes: number
  readonly maxActiveUploadSessions: number
  readonly maxNonterminalJobs: number
  readonly maxDerivedResources: number
}

export interface SourceQuotaLimits {
  readonly workspace: SourceQuotaCeilings
  readonly profile: SourceQuotaCeilings
}

export interface SourceQuotaGrowth {
  readonly sourceRegistrations?: number
  readonly retainedAndReservedBytes?: number
  readonly activeUploadSessions?: number
  readonly nonterminalJobs?: number
  readonly derivedResources?: number
}

export const DEFAULT_SOURCE_QUOTA_LIMITS: SourceQuotaLimits = {
  workspace: {
    maxSourceRegistrations: 1_000,
    maxRetainedAndReservedBytes: 1024 * 1024 * 1024,
    maxActiveUploadSessions: 256,
    maxNonterminalJobs: 64,
    maxDerivedResources: 1_000,
  },
  profile: {
    maxSourceRegistrations: 250,
    maxRetainedAndReservedBytes: 256 * 1024 * 1024,
    maxActiveUploadSessions: 64,
    maxNonterminalJobs: 16,
    maxDerivedResources: 250,
  },
}

export class SourceQuotaExceededError extends Error {
  constructor(readonly resourceClass: SourceQuotaResourceClass) {
    super('Source quota does not allow this operation')
    this.name = 'SourceQuotaExceededError'
  }
}

interface SourceQuotaUsage {
  readonly source_registrations: number
  readonly retained_and_reserved_bytes: number
  readonly active_upload_sessions: number
  readonly nonterminal_jobs: number
  readonly derived_resources: number
}

export class SourceQuotaPolicy {
  constructor(
    private readonly db: Database.Database,
    readonly limits: SourceQuotaLimits = DEFAULT_SOURCE_QUOTA_LIMITS,
  ) {}

  assertCanGrow(
    scope: { readonly workspaceId: string; readonly profileId: string },
    growth: SourceQuotaGrowth,
  ): void {
    this.assertWithin(this.usage(scope.workspaceId, null), growth, this.limits.workspace)
    this.assertWithin(this.usage(scope.workspaceId, scope.profileId), growth, this.limits.profile)
  }

  private assertWithin(
    usage: SourceQuotaUsage,
    growth: SourceQuotaGrowth,
    limits: SourceQuotaCeilings,
  ): void {
    const checks: ReadonlyArray<{
      resourceClass: SourceQuotaResourceClass
      used: number
      growth: number
      limit: number
    }> = [
      {
        resourceClass: 'source_registrations',
        used: usage.source_registrations,
        growth: growth.sourceRegistrations ?? 0,
        limit: limits.maxSourceRegistrations,
      },
      {
        resourceClass: 'source_storage_bytes',
        used: usage.retained_and_reserved_bytes,
        growth: growth.retainedAndReservedBytes ?? 0,
        limit: limits.maxRetainedAndReservedBytes,
      },
      {
        resourceClass: 'source_upload_sessions',
        used: usage.active_upload_sessions,
        growth: growth.activeUploadSessions ?? 0,
        limit: limits.maxActiveUploadSessions,
      },
      {
        resourceClass: 'source_jobs',
        used: usage.nonterminal_jobs,
        growth: growth.nonterminalJobs ?? 0,
        limit: limits.maxNonterminalJobs,
      },
      {
        resourceClass: 'source_derived_resources',
        used: usage.derived_resources,
        growth: growth.derivedResources ?? 0,
        limit: limits.maxDerivedResources,
      },
    ]
    for (const check of checks) {
      if (check.growth > 0 && check.used + check.growth > check.limit) {
        throw new SourceQuotaExceededError(check.resourceClass)
      }
    }
  }

  private usage(workspaceId: string, profileId: string | null): SourceQuotaUsage {
    return this.db.prepare(`
      WITH scoped_sources AS (
        SELECT source_id FROM runtime_sources
        WHERE workspace_id = @workspaceId
          AND (@profileId IS NULL OR profile_id = @profileId)
      ),
      derived_slots AS (
        SELECT resource_id FROM source_derived_resources
        WHERE workspace_id = @workspaceId
          AND (@profileId IS NULL OR profile_id = @profileId)
        UNION
        SELECT resource_id FROM source_jobs
        WHERE workspace_id = @workspaceId
          AND (@profileId IS NULL OR profile_id = @profileId)
          AND operation = 'extract_text'
          AND resource_id IS NOT NULL
          AND state IN ('queued', 'running', 'waiting_for_resource', 'cancel_requested')
        UNION
        SELECT data_view_id FROM source_data_views
        WHERE workspace_id = @workspaceId
          AND (@profileId IS NULL OR profile_id = @profileId)
        UNION
        SELECT data_view_id FROM source_data_view_jobs
        WHERE workspace_id = @workspaceId
          AND (@profileId IS NULL OR profile_id = @profileId)
          AND state IN ('queued', 'running', 'waiting_for_resource', 'cancel_requested')
      )
      SELECT
        (SELECT COUNT(*) FROM runtime_sources
          WHERE workspace_id = @workspaceId
            AND (@profileId IS NULL OR profile_id = @profileId)
            AND deletion_state != 'deleted') AS source_registrations,
        COALESCE((SELECT SUM(v.byte_count) FROM source_versions v
          JOIN scoped_sources s ON s.source_id = v.source_id), 0)
          + COALESCE((SELECT SUM(expected_bytes) FROM source_upload_sessions
            WHERE workspace_id = @workspaceId
              AND (@profileId IS NULL OR profile_id = @profileId)
              AND byte_reservation_released_at IS NULL), 0)
          AS retained_and_reserved_bytes,
        (SELECT COUNT(*) FROM source_upload_sessions
          WHERE workspace_id = @workspaceId
            AND (@profileId IS NULL OR profile_id = @profileId)
            AND state IN ('open', 'completing')) AS active_upload_sessions,
        (SELECT COUNT(*) FROM source_jobs
          WHERE workspace_id = @workspaceId
            AND (@profileId IS NULL OR profile_id = @profileId)
            AND state IN ('queued', 'running', 'waiting_for_resource', 'cancel_requested'))
          + (SELECT COUNT(*) FROM source_data_view_jobs
            WHERE workspace_id = @workspaceId
              AND (@profileId IS NULL OR profile_id = @profileId)
              AND state IN ('queued', 'running', 'waiting_for_resource', 'cancel_requested'))
          AS nonterminal_jobs,
        (SELECT COUNT(*) FROM derived_slots) AS derived_resources
    `).get({ workspaceId, profileId }) as SourceQuotaUsage
  }
}
