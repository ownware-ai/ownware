import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { SqliteDatabase } from '../storage/sqlite-driver.js'
import type { EgressMode } from '@ownware/loom'
import type { RuntimeConsequence } from '../runtime/port.js'
import {
  PERMISSION_INTENT_REVISION,
  permissionIntentMaterial,
} from './permission-intent.js'

export type RunConsequence = RuntimeConsequence

export const RUN_CONSEQUENCES = Object.freeze([
  'none_observed',
  'output_observed',
  'effect_possible',
  'effect_confirmed',
] as const satisfies readonly RunConsequence[])

const RUN_CONSEQUENCE_RANK = new Map<RunConsequence, number>(
  RUN_CONSEQUENCES.map((consequence, index) => [consequence, index]),
)

const RUN_CONSEQUENCE_SQL_RANK = `CASE consequence
  WHEN 'none_observed' THEN 0
  WHEN 'output_observed' THEN 1
  WHEN 'effect_possible' THEN 2
  WHEN 'effect_confirmed' THEN 3
  ELSE -1
END`

export function parseRunConsequence(value: unknown): RunConsequence {
  if (typeof value === 'string' && RUN_CONSEQUENCE_RANK.has(value as RunConsequence)) {
    return value as RunConsequence
  }
  throw new Error('Run consequence is invalid')
}

export type DurableRunStatus =
  | 'accepted'
  | 'running'
  | 'waiting'
  | 'cancel_requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'indeterminate'

const TERMINAL = new Set<DurableRunStatus>([
  'succeeded', 'failed', 'cancelled', 'timed_out', 'indeterminate',
])

export interface RunSnapshot {
  readonly runId: string
  readonly threadId: string
  readonly workspaceId: string | null
  readonly profileId: string
  readonly candidateId: string | null
  readonly model: string
  readonly egressMode: EgressMode
  readonly timeoutMs: number
  readonly status: DurableRunStatus
  readonly consequence: RunConsequence
  readonly terminal: boolean
  readonly outcomeKnown: boolean
  readonly acceptedAt: number
  readonly startedAt: number | null
  readonly updatedAt: number
  readonly terminalAt: number | null
  readonly cancelRequestedAt: number | null
  readonly startSeq: number
  readonly endSeq: number | null
  readonly code: string | null
}

export interface RunPermissionRequest {
  readonly runId: string
  readonly requestId: string
  readonly operationHash: string
  readonly toolName: string
  readonly intentRevision: typeof PERMISSION_INTENT_REVISION
  readonly policyRevision: string
  readonly agentId: string | null
  readonly status: 'pending' | 'approved' | 'denied' | 'expired'
  readonly requestedAt: number
  readonly decidedAt: number | null
  readonly consumedAt: number | null
}

interface PermissionRow {
  readonly run_id: string
  readonly request_id: string
  readonly operation_hash: string
  readonly tool_name: string
  readonly intent_revision: number
  readonly policy_revision: string
  readonly agent_id: string | null
  readonly status: RunPermissionRequest['status']
  readonly requested_at: number
  readonly decided_at: number | null
  readonly consumed_at: number | null
}

interface RunRow {
  readonly id: string
  readonly thread_id: string
  readonly workspace_id: string | null
  readonly profile_id: string
  readonly candidate_id: string | null
  readonly model: string
  readonly egress_mode: EgressMode
  readonly timeout_ms: number
  readonly status: DurableRunStatus
  readonly consequence: string
  readonly start_seq: number
  readonly end_seq: number | null
  readonly code: string | null
  readonly accepted_at: number
  readonly started_at: number | null
  readonly updated_at: number
  readonly terminal_at: number | null
  readonly cancel_requested_at: number | null
}

export class ProfileRunNotAcceptingError extends Error {
  constructor(
    readonly profileId: string,
    readonly deploymentRevision: number,
    readonly routingState: 'paused' | 'undeployed',
  ) {
    super(
      'Profile "' + profileId + '" is ' + routingState +
      ' and is not accepting new runs',
    )
    this.name = 'ProfileRunNotAcceptingError'
  }
}

export class GatewayRunStore {
  private readonly permissionHashKey: Buffer

  constructor(
    private readonly db: SqliteDatabase,
    permissionHashSecret?: string,
  ) {
    this.permissionHashKey = permissionHashSecret === undefined
      ? randomBytes(32)
      : createHmac('sha256', permissionHashSecret)
          .update('ownware.gateway.permission-operation.v1\0')
          .digest()
  }

  create(input: {
    readonly threadId: string
    readonly workspaceId?: string
    readonly profileId: string
    readonly candidateId?: string
    readonly model: string
    readonly egressMode?: EgressMode
    readonly timeoutMs: number
    readonly startSeq: number
  }, now: number = Date.now()): RunSnapshot {
    const runId = randomUUID()
    return this.db.transaction(() => {
      const deployment = this.db.prepare(`
        SELECT deployment_revision, routing_state
        FROM profile_candidate_activations WHERE profile_id = ?
      `).get(input.profileId) as {
        deployment_revision: number
        routing_state: 'active' | 'paused'
      } | undefined
      const undeployed = this.db.prepare(`
        SELECT deployment_revision
        FROM profile_candidate_deployment_tombstones WHERE profile_id = ?
      `).get(input.profileId) as { deployment_revision: number } | undefined
      if (undeployed) {
        throw new ProfileRunNotAcceptingError(
          input.profileId,
          undeployed.deployment_revision,
          'undeployed',
        )
      }
      if (deployment?.routing_state === 'paused') {
        throw new ProfileRunNotAcceptingError(
          input.profileId,
          deployment.deployment_revision,
          'paused',
        )
      }
      this.db.prepare(`
        INSERT INTO gateway_runs (
          id, thread_id, workspace_id, profile_id, candidate_id, model, egress_mode, timeout_ms, status,
          start_seq, end_seq, code, accepted_at, started_at, updated_at,
          terminal_at, cancel_requested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, NULL, NULL, ?, NULL, ?, NULL, NULL)
      `).run(
        runId,
        input.threadId,
        input.workspaceId ?? null,
        input.profileId,
        input.candidateId ?? null,
        input.model,
        input.egressMode ?? 'unrestricted',
        input.timeoutMs,
        input.startSeq,
        now,
        now,
      )
      return this.get(runId)!
    }).immediate()
  }

  countActiveForProfile(profileId: string): number {
    return this.db.prepare(`
      SELECT COUNT(*) FROM gateway_runs
      WHERE profile_id = ?
        AND status IN ('accepted', 'running', 'waiting', 'cancel_requested')
    `).pluck().get(profileId) as number
  }

  get(runId: string): RunSnapshot | null {
    const row = this.db.prepare('SELECT * FROM gateway_runs WHERE id = ?')
      .get(runId) as RunRow | undefined
    return row ? toSnapshot(row) : null
  }

  markRunning(runId: string, now: number = Date.now()): void {
    this.db.prepare(`
      UPDATE gateway_runs
      SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND status = 'accepted'
    `).run(now, now, runId)
  }

  advanceConsequence(
    runId: string,
    consequence: RunConsequence,
    now: number = Date.now(),
  ): void {
    const rank = RUN_CONSEQUENCE_RANK.get(consequence)
    if (rank === undefined) throw new Error('Run consequence is invalid')
    if (rank === 0) return
    this.db.prepare(`
      UPDATE gateway_runs
      SET consequence = ?, updated_at = ?
      WHERE id = ? AND ${RUN_CONSEQUENCE_SQL_RANK} < ?
    `).run(consequence, now, runId, rank)
  }

  requestCancel(
    runId: string,
    now: number = Date.now(),
  ): 'requested' | 'already_requested' | 'terminal' | 'missing' {
    return this.db.transaction(() => {
      const current = this.get(runId)
      if (!current) return 'missing'
      if (current.terminal) return 'terminal'
      if (current.status === 'cancel_requested') return 'already_requested'
      const result = this.db.prepare(`
        UPDATE gateway_runs
        SET status = 'cancel_requested', cancel_requested_at = COALESCE(cancel_requested_at, ?),
            updated_at = ?
        WHERE id = ? AND status IN ('accepted', 'running', 'waiting')
      `).run(now, now, runId)
      if (result.changes === 1) {
        this.expireUnconsumedPermissions(runId, now)
        return 'requested'
      }
      const after = this.get(runId)
      if (!after) return 'missing'
      if (after.terminal) return 'terminal'
      return after.status === 'cancel_requested' ? 'already_requested' : 'missing'
    }).immediate()
  }

  markTerminal(
    runId: string,
    status: Extract<DurableRunStatus, 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'indeterminate'>,
    input: {
      readonly endSeq: number
      readonly consequence: RunConsequence
      readonly code?: string
      readonly now?: number
    },
  ): void {
    const now = input.now ?? Date.now()
    const rank = RUN_CONSEQUENCE_RANK.get(input.consequence)
    if (rank === undefined) throw new Error('Run consequence is invalid')
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE gateway_runs
      SET status = ?, end_seq = ?, code = ?, updated_at = ?, terminal_at = ?,
          consequence = CASE
            WHEN ${RUN_CONSEQUENCE_SQL_RANK} < ? THEN ?
            ELSE consequence
          END
      WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'indeterminate')
      `).run(
      status,
      input.endSeq,
      input.code ?? null,
      now,
      now,
      rank,
      input.consequence,
        runId,
      )
      this.expireUnconsumedPermissions(runId, now)
    }).immediate()
  }

  recoverInterrupted(now: number = Date.now()): number {
    return this.db.transaction(() => {
      this.db.prepare(`
        UPDATE run_permission_requests
        SET status = 'expired', decided_at = COALESCE(decided_at, ?)
        WHERE status IN ('pending', 'approved')
          AND NOT EXISTS (
            SELECT 1 FROM run_permission_consumptions AS consumption
            WHERE consumption.run_id = run_permission_requests.run_id
              AND consumption.request_id = run_permission_requests.request_id
          )
          AND EXISTS (
            SELECT 1 FROM gateway_runs AS run
            WHERE run.id = run_permission_requests.run_id
              AND run.status IN ('accepted', 'running', 'waiting', 'cancel_requested')
          )
      `).run(now)
      const result = this.db.prepare(`
        UPDATE gateway_runs
        SET status = 'indeterminate', code = 'gateway_restarted',
            updated_at = ?, terminal_at = ?, end_seq = NULL
        WHERE status IN ('accepted', 'running', 'waiting', 'cancel_requested')
      `).run(now, now)
      return result.changes
    }).immediate()
  }

  recordPermissionRequest(input: {
    readonly runId: string
    readonly requestId: string
    readonly toolName: string
    readonly toolInput: Record<string, unknown>
    readonly policyRevision: string
    readonly agentId: string | null
  }, now: number = Date.now()): RunPermissionRequest {
    const operationHash = createHmac('sha256', this.permissionHashKey)
      .update(permissionIntentMaterial(input))
      .digest('hex')
    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO run_permission_requests (
          run_id, request_id, operation_hash, tool_name, status, requested_at, decided_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, NULL)
        ON CONFLICT(run_id, request_id) DO NOTHING
      `).run(input.runId, input.requestId, operationHash, input.toolName, now)
      this.db.prepare(`
        INSERT INTO run_permission_bindings (
          run_id, request_id, intent_revision, policy_revision, agent_id, bound_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, request_id) DO NOTHING
      `).run(
        input.runId,
        input.requestId,
        PERMISSION_INTENT_REVISION,
        input.policyRevision,
        input.agentId,
        now,
      )
      const record = this.getPermissionRequest(input.runId, input.requestId)
      if (
        !record
        || record.operationHash !== operationHash
        || record.intentRevision !== PERMISSION_INTENT_REVISION
        || record.policyRevision !== input.policyRevision
        || record.agentId !== input.agentId
      ) {
        throw new Error('Permission request identity conflict')
      }
      return record
    }).immediate()
  }

  getPermissionRequest(runId: string, requestId: string): RunPermissionRequest | null {
    const row = this.db.prepare(`
      SELECT request.run_id, request.request_id, request.operation_hash,
        request.tool_name, request.status, request.requested_at,
        request.decided_at, binding.intent_revision, binding.policy_revision,
        binding.agent_id, consumption.consumed_at
      FROM run_permission_requests AS request
      JOIN run_permission_bindings AS binding
        ON binding.run_id = request.run_id
        AND binding.request_id = request.request_id
      LEFT JOIN run_permission_consumptions AS consumption
        ON consumption.run_id = request.run_id
        AND consumption.request_id = request.request_id
      WHERE request.run_id = ? AND request.request_id = ?
    `).get(runId, requestId) as PermissionRow | undefined
    return row ? toPermission(row) : null
  }

  consumePermissionApproval(input: {
    readonly runId: string
    readonly requestId: string
    readonly toolName: string
    readonly toolInput: Record<string, unknown>
    readonly policyRevision: string
    readonly agentId: string | null
  }, now: number = Date.now()):
    | 'consumed'
    | 'missing'
    | 'intent_mismatch'
    | 'not_approved'
    | 'already_consumed' {
    const operationHash = createHmac('sha256', this.permissionHashKey)
      .update(permissionIntentMaterial(input))
      .digest('hex')
    return this.db.transaction(() => {
      const current = this.getPermissionRequest(input.runId, input.requestId)
      if (!current) return 'missing'
      if (
        current.operationHash !== operationHash
        || current.policyRevision !== input.policyRevision
        || current.agentId !== input.agentId
        || current.toolName !== input.toolName
      ) return 'intent_mismatch'
      if (current.consumedAt !== null) return 'already_consumed'
      if (current.status !== 'approved') return 'not_approved'
      this.db.prepare(`
        INSERT INTO run_permission_consumptions (
          run_id, request_id, operation_hash, consumed_at
        ) VALUES (?, ?, ?, ?)
      `).run(input.runId, input.requestId, operationHash, now)
      return 'consumed'
    }).immediate()
  }

  decidePermission(
    runId: string,
    requestId: string,
    operationHash: string,
    decision: 'approve' | 'deny',
    now: number = Date.now(),
  ): 'decided' | 'missing' | 'hash_mismatch' | 'already_decided' {
    const current = this.getPermissionRequest(runId, requestId)
    if (!current) return 'missing'
    if (current.operationHash !== operationHash) return 'hash_mismatch'
    if (current.status !== 'pending') return 'already_decided'
    const result = this.db.prepare(`
      UPDATE run_permission_requests
      SET status = ?, decided_at = ?
      WHERE run_id = ? AND request_id = ? AND status = 'pending' AND operation_hash = ?
    `).run(decision === 'approve' ? 'approved' : 'denied', now, runId, requestId, operationHash)
    return result.changes === 1 ? 'decided' : 'already_decided'
  }

  expirePermission(
    runId: string,
    requestId: string,
    operationHash: string,
    now: number = Date.now(),
  ): 'expired' | 'missing' | 'hash_mismatch' | 'already_terminal' {
    const current = this.getPermissionRequest(runId, requestId)
    if (!current) return 'missing'
    if (current.operationHash !== operationHash) return 'hash_mismatch'
    if (current.status === 'denied' || current.status === 'expired' || current.consumedAt !== null) {
      return 'already_terminal'
    }
    const result = this.db.prepare(`
      UPDATE run_permission_requests
      SET status = 'expired', decided_at = COALESCE(decided_at, ?)
      WHERE run_id = ? AND request_id = ? AND operation_hash = ?
        AND status IN ('pending', 'approved')
        AND NOT EXISTS (
          SELECT 1 FROM run_permission_consumptions AS consumption
          WHERE consumption.run_id = run_permission_requests.run_id
            AND consumption.request_id = run_permission_requests.request_id
        )
    `).run(now, runId, requestId, operationHash)
    return result.changes === 1 ? 'expired' : 'already_terminal'
  }

  private expireUnconsumedPermissions(runId: string, now: number): void {
    this.db.prepare(`
      UPDATE run_permission_requests
      SET status = 'expired', decided_at = COALESCE(decided_at, ?)
      WHERE run_id = ? AND status IN ('pending', 'approved')
        AND NOT EXISTS (
          SELECT 1 FROM run_permission_consumptions AS consumption
          WHERE consumption.run_id = run_permission_requests.run_id
            AND consumption.request_id = run_permission_requests.request_id
        )
    `).run(now, runId)
  }

  markWaiting(runId: string, now: number = Date.now()): void {
    this.db.prepare(`
      UPDATE gateway_runs SET status = 'waiting', updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(now, runId)
  }

  markRunningAfterDecision(runId: string, now: number = Date.now()): void {
    this.db.prepare(`
      UPDATE gateway_runs SET status = 'running', updated_at = ?
      WHERE id = ? AND status = 'waiting'
    `).run(now, runId)
  }
}

function toSnapshot(row: RunRow): RunSnapshot {
  const terminal = TERMINAL.has(row.status)
  return {
    runId: row.id,
    threadId: row.thread_id,
    workspaceId: row.workspace_id,
    profileId: row.profile_id,
    candidateId: row.candidate_id,
    model: row.model,
    egressMode: row.egress_mode,
    timeoutMs: row.timeout_ms,
    status: row.status,
    consequence: parseRunConsequence(row.consequence),
    terminal,
    outcomeKnown: row.status !== 'indeterminate',
    acceptedAt: row.accepted_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
    cancelRequestedAt: row.cancel_requested_at,
    startSeq: row.start_seq,
    endSeq: row.end_seq,
    code: row.code,
  }
}

function toPermission(row: PermissionRow): RunPermissionRequest {
  if (row.intent_revision !== PERMISSION_INTENT_REVISION) {
    throw new Error('Permission intent revision is unsupported')
  }
  return {
    runId: row.run_id,
    requestId: row.request_id,
    operationHash: row.operation_hash,
    toolName: row.tool_name,
    intentRevision: PERMISSION_INTENT_REVISION,
    policyRevision: row.policy_revision,
    agentId: row.agent_id,
    status: row.status,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    consumedAt: row.consumed_at,
  }
}
