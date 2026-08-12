import type { SqliteDatabase } from '../storage/sqlite-driver.js'

export type CandidateState = 'placing' | 'ready' | 'placement_failed' | 'cleanup_failed'

export interface CandidateRecord {
  readonly candidateId: string
  readonly profileId: string
  readonly state: CandidateState
  readonly attemptId: string | null
  readonly fileCount: number
  readonly totalBytes: number
  readonly code: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ActiveCandidateRecord {
  readonly profileId: string
  readonly candidateId: string
  readonly deploymentRevision: number
  readonly routingState: DeploymentRoutingState
  readonly health: DeploymentHealth
  readonly healthObservedAt: number | null
  readonly updatedAt: number
}

export interface UndeployedCandidateRecord {
  readonly profileId: string
  readonly previousCandidateId: string
  readonly deploymentRevision: number
  readonly undeployedAt: number
  readonly updatedAt: number
}

export type CandidateDeploymentState =
  | ({ readonly state: 'active' } & ActiveCandidateRecord)
  | ({ readonly state: 'undeployed' } & UndeployedCandidateRecord)

export type DeploymentRoutingState = 'active' | 'paused'
export type DeploymentHealth = 'unknown' | 'starting' | 'healthy' | 'degraded' | 'unhealthy'
export const DEPLOYMENT_HEALTH_FRESH_MS = 5 * 60 * 1000

export type CandidateActivationResult = {
  readonly status: 'activated' | 'unchanged' | 'conflict' |
    'candidate_not_ready' | 'candidate_scope_mismatch'
  readonly previousCandidateId: string | null
  readonly activeCandidateId: string | null
  readonly deploymentRevision: number | null
  readonly routingState: DeploymentRoutingState | null
  readonly health: DeploymentHealth | null
  readonly healthObservedAt: number | null
}

export type CandidateUndeploymentResult = {
  readonly status: 'undeployed' | 'conflict' | 'not_deployed' |
    'not_paused' | 'active_runs'
  readonly previousCandidateId: string | null
  readonly activeCandidateId: string | null
  readonly deploymentRevision: number | null
  readonly activeRunCount: number
  readonly undeployedAt: number | null
}

export type DeploymentRoutingResult = {
  readonly status: 'changed' | 'unchanged' | 'conflict' | 'not_deployed'
  readonly activeCandidateId: string | null
  readonly deploymentRevision: number | null
  readonly routingState: DeploymentRoutingState | null
  readonly health: DeploymentHealth | null
  readonly healthObservedAt: number | null
}

export type CandidateDeletionState = 'deleting' | 'delete_failed' | 'deleted'

export interface CandidateDeletionRecord {
  readonly candidateId: string
  readonly state: CandidateDeletionState
  readonly code: string | null
  readonly startedAt: number
  readonly updatedAt: number
  readonly deletedAt: number | null
}

export type CandidateDeletionClaim = {
  readonly status: 'started' | 'already_deleted' | 'in_progress' | 'not_found' |
    'scope_mismatch' | 'not_ready' | 'active' | 'in_use' | 'rollback_retained'
  readonly candidateId: string
  readonly profileId: string
}

export type CandidateDeletionEligibility = CandidateDeletionClaim['status'] | 'eligible'

interface CandidateRow {
  readonly candidate_id: string
  readonly profile_id: string
  readonly state: CandidateState
  readonly attempt_id: string | null
  readonly file_count: number
  readonly total_bytes: number
  readonly code: string | null
  readonly created_at: number
  readonly updated_at: number
}

interface ActiveCandidateRow {
  readonly profile_id: string
  readonly candidate_id: string
  readonly deployment_revision: number
  readonly routing_state: DeploymentRoutingState
  readonly health: DeploymentHealth
  readonly health_observed_at: number | null
  readonly updated_at: number
}

interface DeploymentStateRow {
  readonly state: 'active' | 'undeployed'
  readonly profile_id: string
  readonly candidate_id: string | null
  readonly previous_candidate_id: string | null
  readonly deployment_revision: number
  readonly routing_state: DeploymentRoutingState | null
  readonly health: DeploymentHealth | null
  readonly health_observed_at: number | null
  readonly undeployed_at: number | null
  readonly updated_at: number
}

interface CandidateDeletionRow {
  readonly candidate_id: string
  readonly state: CandidateDeletionState
  readonly code: string | null
  readonly started_at: number
  readonly updated_at: number
  readonly deleted_at: number | null
}

export class CandidateStore {
  constructor(private readonly db: SqliteDatabase) {}

  get(candidateId: string): CandidateRecord | null {
    const row = this.db.prepare('SELECT * FROM profile_candidates WHERE candidate_id = ?')
      .get(candidateId) as CandidateRow | undefined
    return row ? toRecord(row) : null
  }

  list(profileId: string): CandidateRecord[] {
    return (this.db.prepare(`
      SELECT * FROM profile_candidates WHERE profile_id = ?
      ORDER BY created_at DESC, candidate_id ASC
    `).all(profileId) as CandidateRow[]).map(toRecord)
  }

  getDeletion(candidateId: string): CandidateDeletionRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM profile_candidate_deletions WHERE candidate_id = ?
    `).get(candidateId) as CandidateDeletionRow | undefined
    return row ? {
      candidateId: row.candidate_id,
      state: row.state,
      code: row.code,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    } : null
  }

  getActive(profileId: string, now: number = Date.now()): ActiveCandidateRecord | null {
    const row = this.db.prepare(`
      SELECT profile_id, candidate_id, deployment_revision, routing_state,
        health, health_observed_at, updated_at
      FROM profile_candidate_activations WHERE profile_id = ?
    `).get(profileId) as ActiveCandidateRow | undefined
    const stale = row !== undefined && row.health !== 'unknown' &&
      (row.health_observed_at === null || now - row.health_observed_at > DEPLOYMENT_HEALTH_FRESH_MS)
    return row ? {
      profileId: row.profile_id,
      candidateId: row.candidate_id,
      deploymentRevision: row.deployment_revision,
      routingState: row.routing_state,
      health: stale ? 'unknown' : row.health,
      healthObservedAt: row.health_observed_at,
      updatedAt: row.updated_at,
    } : null
  }

  getDeploymentState(
    profileId: string,
    now: number = Date.now(),
  ): CandidateDeploymentState | null {
    // One statement gives readers a single storage snapshot while a concurrent
    // activation or undeploy swaps the mutually exclusive authority rows.
    const rows = this.db.prepare(`
      SELECT 'active' AS state, profile_id, candidate_id,
        NULL AS previous_candidate_id, deployment_revision, routing_state,
        health, health_observed_at, NULL AS undeployed_at, updated_at
      FROM profile_candidate_activations WHERE profile_id = ?
      UNION ALL
      SELECT 'undeployed' AS state, profile_id, NULL AS candidate_id,
        previous_candidate_id, deployment_revision, NULL AS routing_state,
        NULL AS health, NULL AS health_observed_at, undeployed_at, updated_at
      FROM profile_candidate_deployment_tombstones WHERE profile_id = ?
    `).all(profileId, profileId) as DeploymentStateRow[]
    if (rows.length > 1) throw new Error('Candidate deployment state conflict')
    const row = rows[0]
    if (!row) return null
    if (row.state === 'active') {
      if (row.candidate_id === null || row.routing_state === null || row.health === null) {
        throw new Error('Candidate deployment state invalid')
      }
      const stale = row.health !== 'unknown' &&
        (row.health_observed_at === null ||
          now - row.health_observed_at > DEPLOYMENT_HEALTH_FRESH_MS)
      return {
        state: 'active',
        profileId: row.profile_id,
        candidateId: row.candidate_id,
        deploymentRevision: row.deployment_revision,
        routingState: row.routing_state,
        health: stale ? 'unknown' : row.health,
        healthObservedAt: row.health_observed_at,
        updatedAt: row.updated_at,
      }
    }
    if (row.previous_candidate_id === null || row.undeployed_at === null) {
      throw new Error('Candidate deployment state invalid')
    }
    return {
      state: 'undeployed',
      profileId: row.profile_id,
      previousCandidateId: row.previous_candidate_id,
      deploymentRevision: row.deployment_revision,
      undeployedAt: row.undeployed_at,
      updatedAt: row.updated_at,
    }
  }

  compareAndSetActive(input: {
    readonly profileId: string
    readonly candidateId: string
    readonly expectedActiveCandidateId: string | null
    readonly expectedDeploymentRevision?: number | null
  }, now: number = Date.now()): CandidateActivationResult {
    return this.db.transaction(() => {
      const current = this.getActive(input.profileId, now)
      const deployment = this.getDeploymentState(input.profileId, now)
      const undeployed = deployment?.state === 'undeployed' ? deployment : null
      const currentId = current?.candidateId ?? null
      const unchangedState = {
        deploymentRevision: current?.deploymentRevision ??
          undeployed?.deploymentRevision ?? null,
        routingState: current?.routingState ?? null,
        health: current?.health ?? null,
        healthObservedAt: current?.healthObservedAt ?? null,
      }
      const candidate = this.get(input.candidateId)
      const deletion = this.getDeletion(input.candidateId)
      if (!candidate || candidate.state !== 'ready' || deletion !== null) {
        return {
          status: 'candidate_not_ready',
          previousCandidateId: currentId,
          activeCandidateId: currentId,
          ...unchangedState,
        } as const
      }
      if (candidate.profileId !== input.profileId) {
        return {
          status: 'candidate_scope_mismatch',
          previousCandidateId: currentId,
          activeCandidateId: currentId,
          ...unchangedState,
        } as const
      }
      const revisionMatches = current
        ? input.expectedDeploymentRevision === undefined ||
          input.expectedDeploymentRevision === current.deploymentRevision
        : undeployed
          ? input.expectedDeploymentRevision === undeployed.deploymentRevision
          : input.expectedDeploymentRevision === undefined ||
            input.expectedDeploymentRevision === null
      if (currentId !== input.expectedActiveCandidateId || !revisionMatches) {
        return {
          status: 'conflict',
          previousCandidateId: currentId,
          activeCandidateId: currentId,
          ...unchangedState,
        } as const
      }
      if (currentId === input.candidateId) {
        return {
          status: 'unchanged',
          previousCandidateId: currentId,
          activeCandidateId: currentId,
          ...unchangedState,
        } as const
      }
      if (current) {
        const updated = this.db.prepare(`
          UPDATE profile_candidate_activations
          SET candidate_id = ?, deployment_revision = deployment_revision + 1,
            health = 'starting', health_observed_at = ?, updated_at = ?
          WHERE profile_id = ? AND candidate_id = ? AND deployment_revision = ?
        `).run(
          input.candidateId,
          now,
          now,
          input.profileId,
          current.candidateId,
          current.deploymentRevision,
        )
        if (updated.changes !== 1) throw new Error('Candidate activation state conflict')
      } else {
        const deploymentRevision = (undeployed?.deploymentRevision ?? 0) + 1
        if (undeployed) {
          const removed = this.db.prepare(`
            DELETE FROM profile_candidate_deployment_tombstones
            WHERE profile_id = ? AND deployment_revision = ?
          `).run(input.profileId, undeployed.deploymentRevision)
          if (removed.changes !== 1) throw new Error('Candidate deployment state conflict')
        }
        this.db.prepare(`
          INSERT INTO profile_candidate_activations (
            profile_id, candidate_id, deployment_revision, routing_state,
            health, health_observed_at, updated_at
          ) VALUES (?, ?, ?, 'active', 'starting', ?, ?)
        `).run(input.profileId, input.candidateId, deploymentRevision, now, now)
      }
      const active = this.getActive(input.profileId, now)!
      this.db.prepare(`
        INSERT INTO profile_candidate_activation_history (
          profile_id, deployment_revision, candidate_id, activated_at
        ) VALUES (?, ?, ?, ?)
      `).run(
        input.profileId,
        active.deploymentRevision,
        input.candidateId,
        now,
      )
      return {
        status: 'activated',
        previousCandidateId: currentId,
        activeCandidateId: input.candidateId,
        deploymentRevision: active.deploymentRevision,
        routingState: active.routingState,
        health: active.health,
        healthObservedAt: active.healthObservedAt,
      } as const
    }).immediate()
  }

  compareAndSetUndeployed(input: {
    readonly profileId: string
    readonly expectedActiveCandidateId: string
    readonly expectedDeploymentRevision: number
  }, now: number = Date.now()): CandidateUndeploymentResult {
    return this.db.transaction(() => {
      const deployment = this.getDeploymentState(input.profileId, now)
      const result = (
        status: CandidateUndeploymentResult['status'],
        activeRunCount: number,
      ): CandidateUndeploymentResult => ({
        status,
        previousCandidateId: deployment?.state === 'active'
          ? deployment.candidateId
          : deployment?.state === 'undeployed' ? deployment.previousCandidateId : null,
        activeCandidateId: deployment?.state === 'active' ? deployment.candidateId : null,
        deploymentRevision: deployment?.deploymentRevision ?? null,
        activeRunCount,
        undeployedAt: deployment?.state === 'undeployed' ? deployment.undeployedAt : null,
      })
      if (!deployment || deployment.state === 'undeployed') {
        return result('not_deployed', 0)
      }
      if (deployment.candidateId !== input.expectedActiveCandidateId ||
          deployment.deploymentRevision !== input.expectedDeploymentRevision) {
        return result('conflict', 0)
      }
      if (deployment.routingState !== 'paused') return result('not_paused', 0)
      const activeRuns = this.db.prepare(`
        SELECT COUNT(*) FROM gateway_runs
        WHERE profile_id = ?
          AND status IN ('accepted', 'running', 'waiting', 'cancel_requested')
      `).pluck().get(input.profileId) as number
      if (activeRuns > 0) return result('active_runs', activeRuns)

      const removed = this.db.prepare(`
        DELETE FROM profile_candidate_activations
        WHERE profile_id = ? AND candidate_id = ? AND deployment_revision = ?
          AND routing_state = 'paused'
      `).run(
        input.profileId,
        input.expectedActiveCandidateId,
        input.expectedDeploymentRevision,
      )
      if (removed.changes !== 1) throw new Error('Candidate undeployment state conflict')
      const revision = input.expectedDeploymentRevision + 1
      this.db.prepare(`
        INSERT INTO profile_candidate_deployment_tombstones (
          profile_id, previous_candidate_id, deployment_revision,
          undeployed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(input.profileId, input.expectedActiveCandidateId, revision, now, now)
      return {
        status: 'undeployed',
        previousCandidateId: input.expectedActiveCandidateId,
        activeCandidateId: null,
        deploymentRevision: revision,
        activeRunCount: 0,
        undeployedAt: now,
      } as const
    }).immediate()
  }

  compareAndSetRouting(input: {
    readonly profileId: string
    readonly expectedRevision: number
    readonly routingState: DeploymentRoutingState
  }, now: number = Date.now()): DeploymentRoutingResult {
    return this.db.transaction(() => {
      const current = this.getActive(input.profileId, now)
      if (!current) return emptyRoutingResult('not_deployed')
      if (current.deploymentRevision !== input.expectedRevision) {
        return routingResult('conflict', current)
      }
      if (current.routingState === input.routingState) {
        return routingResult('unchanged', current)
      }
      const updated = this.db.prepare(`
        UPDATE profile_candidate_activations
        SET routing_state = ?, deployment_revision = deployment_revision + 1,
          updated_at = ?
        WHERE profile_id = ? AND deployment_revision = ?
      `).run(input.routingState, now, input.profileId, input.expectedRevision)
      if (updated.changes !== 1) {
        const actual = this.getActive(input.profileId, now)
        return actual ? routingResult('conflict', actual) : emptyRoutingResult('not_deployed')
      }
      return routingResult('changed', this.getActive(input.profileId, now)!)
    }).immediate()
  }

  recordHealth(input: {
    readonly profileId: string
    readonly candidateId: string
    readonly health: DeploymentHealth
    readonly observedAt: number
  }): boolean {
    return this.db.prepare(`
      UPDATE profile_candidate_activations
      SET health = ?, health_observed_at = ?, updated_at = MAX(updated_at, ?)
      WHERE profile_id = ? AND candidate_id = ?
        AND (health_observed_at IS NULL OR health_observed_at <= ?)
    `).run(
      input.health,
      input.observedAt,
      input.observedAt,
      input.profileId,
      input.candidateId,
      input.observedAt,
    ).changes === 1
  }

  beginDeletion(input: {
    readonly profileId: string
    readonly candidateId: string
  }, now: number = Date.now()): CandidateDeletionClaim {
    return this.db.transaction(() => {
      const result = (status: CandidateDeletionClaim['status']): CandidateDeletionClaim => ({
        status,
        candidateId: input.candidateId,
        profileId: input.profileId,
      })
      const eligibility = this.deletionEligibility(input, now)
      if (eligibility !== 'eligible') return result(eligibility)
      const deletion = this.getDeletion(input.candidateId)

      if (deletion?.state === 'delete_failed') {
        this.db.prepare(`
          UPDATE profile_candidate_deletions
          SET state = 'deleting', code = NULL, updated_at = ?, deleted_at = NULL
          WHERE candidate_id = ? AND state = 'delete_failed'
        `).run(now, input.candidateId)
      } else {
        this.db.prepare(`
          INSERT INTO profile_candidate_deletions (
            candidate_id, state, code, started_at, updated_at, deleted_at
          ) VALUES (?, 'deleting', NULL, ?, ?, NULL)
        `).run(input.candidateId, now, now)
      }
      return result('started')
    }).immediate()
  }

  deletionEligibility(input: {
    readonly profileId: string
    readonly candidateId: string
  }, now: number = Date.now()): CandidateDeletionEligibility {
    const candidate = this.get(input.candidateId)
    if (!candidate) return 'not_found'
    if (candidate.profileId !== input.profileId) return 'scope_mismatch'
    const deletion = this.getDeletion(input.candidateId)
    if (deletion?.state === 'deleted') return 'already_deleted'
    if (deletion?.state === 'deleting') return 'in_progress'
    if (candidate.state !== 'ready') return 'not_ready'

    const active = this.getActive(input.profileId, now)
    if (active?.candidateId === input.candidateId) return 'active'
    const activeRuns = this.db.prepare(`
      SELECT COUNT(*) FROM gateway_runs
      WHERE candidate_id = ?
        AND status IN ('accepted', 'running', 'waiting', 'cancel_requested')
    `).pluck().get(input.candidateId) as number
    if (activeRuns > 0) return 'in_use'
    const rollbackCandidate = this.db.prepare(`
      SELECT candidate_id
      FROM profile_candidate_activation_history
      WHERE profile_id = ? AND candidate_id != ?
      ORDER BY deployment_revision DESC
      LIMIT 1
    `).pluck().get(input.profileId, active?.candidateId ?? '') as string | undefined
    if (rollbackCandidate === input.candidateId) return 'rollback_retained'
    return 'eligible'
  }

  markDeleteFailed(
    candidateId: string,
    code: string,
    now: number = Date.now(),
  ): void {
    const changed = this.db.prepare(`
      UPDATE profile_candidate_deletions
      SET state = 'delete_failed', code = ?, updated_at = ?
      WHERE candidate_id = ? AND state = 'deleting'
    `).run(code, now, candidateId)
    if (changed.changes !== 1) throw new Error('Candidate deletion state conflict')
  }

  markDeleted(candidateId: string, now: number = Date.now()): void {
    const changed = this.db.prepare(`
      UPDATE profile_candidate_deletions
      SET state = 'deleted', code = NULL, updated_at = ?, deleted_at = ?
      WHERE candidate_id = ? AND state = 'deleting'
    `).run(now, now, candidateId)
    if (changed.changes !== 1) throw new Error('Candidate deletion state conflict')
  }

  begin(input: {
    readonly candidateId: string
    readonly profileId: string
    readonly attemptId: string
    readonly fileCount: number
    readonly totalBytes: number
  }, now: number = Date.now()): 'started' | 'ready' | 'in_progress' {
    return this.db.transaction(() => {
      const current = this.get(input.candidateId)
      if (current) {
        if (current.profileId !== input.profileId || current.fileCount !== input.fileCount ||
            current.totalBytes !== input.totalBytes) {
          throw new Error('Candidate identity metadata conflict')
        }
        if (current.state === 'ready') return 'ready' as const
        if (current.state === 'placing') return 'in_progress' as const
        this.db.prepare(`
          UPDATE profile_candidates
          SET state = 'placing', attempt_id = ?, code = NULL, updated_at = ?
          WHERE candidate_id = ? AND state IN ('placement_failed', 'cleanup_failed')
        `).run(input.attemptId, now, input.candidateId)
        return 'started' as const
      }

      this.db.prepare(`
        INSERT INTO profile_candidates (
          candidate_id, profile_id, state, attempt_id, file_count, total_bytes,
          code, created_at, updated_at
        ) VALUES (?, ?, 'placing', ?, ?, ?, NULL, ?, ?)
      `).run(
        input.candidateId,
        input.profileId,
        input.attemptId,
        input.fileCount,
        input.totalBytes,
        now,
        now,
      )
      return 'started' as const
    })()
  }

  markReady(candidateId: string, attemptId: string, now: number = Date.now()): void {
    const result = this.db.prepare(`
      UPDATE profile_candidates
      SET state = 'ready', attempt_id = NULL, code = NULL, updated_at = ?
      WHERE candidate_id = ? AND state = 'placing' AND attempt_id = ?
    `).run(now, candidateId, attemptId)
    if (result.changes !== 1) throw new Error('Candidate placement state conflict')
  }

  markFailed(
    candidateId: string,
    attemptId: string,
    state: Extract<CandidateState, 'placement_failed' | 'cleanup_failed'>,
    code: string,
    now: number = Date.now(),
  ): void {
    const result = this.db.prepare(`
      UPDATE profile_candidates
      SET state = ?, code = ?, updated_at = ?
      WHERE candidate_id = ? AND state = 'placing' AND attempt_id = ?
    `).run(state, code, now, candidateId, attemptId)
    if (result.changes !== 1) throw new Error('Candidate placement state conflict')
  }

  markCleanupFailed(candidateId: string, attemptId: string, now: number = Date.now()): void {
    const result = this.db.prepare(`
      UPDATE profile_candidates
      SET state = 'cleanup_failed', code = 'cleanup_failed', updated_at = ?
      WHERE candidate_id = ? AND attempt_id = ?
        AND state IN ('placing', 'placement_failed', 'cleanup_failed')
    `).run(now, candidateId, attemptId)
    if (result.changes !== 1) throw new Error('Candidate placement state conflict')
  }

  markCleanupResolved(candidateId: string, attemptId: string, now: number = Date.now()): void {
    const result = this.db.prepare(`
      UPDATE profile_candidates
      SET state = 'placement_failed', code = 'cleanup_recovered', updated_at = ?
      WHERE candidate_id = ? AND state = 'cleanup_failed' AND attempt_id = ?
    `).run(now, candidateId, attemptId)
    if (result.changes !== 1) throw new Error('Candidate placement state conflict')
  }

  recoverInterrupted(now: number = Date.now()): number {
    return this.db.prepare(`
      UPDATE profile_candidates
      SET state = 'placement_failed', code = 'gateway_restarted', updated_at = ?
      WHERE state = 'placing'
    `).run(now).changes
  }
}

function routingResult(
  status: Exclude<DeploymentRoutingResult['status'], 'not_deployed'>,
  record: ActiveCandidateRecord,
): DeploymentRoutingResult {
  return {
    status,
    activeCandidateId: record.candidateId,
    deploymentRevision: record.deploymentRevision,
    routingState: record.routingState,
    health: record.health,
    healthObservedAt: record.healthObservedAt,
  }
}

function emptyRoutingResult(status: 'not_deployed'): DeploymentRoutingResult {
  return {
    status,
    activeCandidateId: null,
    deploymentRevision: null,
    routingState: null,
    health: null,
    healthObservedAt: null,
  }
}

function toRecord(row: CandidateRow): CandidateRecord {
  return {
    candidateId: row.candidate_id,
    profileId: row.profile_id,
    state: row.state,
    attemptId: row.attempt_id,
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
    code: row.code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
