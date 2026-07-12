import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

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
  readonly timeoutMs: number
  readonly status: DurableRunStatus
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
  readonly status: 'pending' | 'approved' | 'denied' | 'expired'
  readonly requestedAt: number
  readonly decidedAt: number | null
}

interface PermissionRow {
  readonly run_id: string
  readonly request_id: string
  readonly operation_hash: string
  readonly tool_name: string
  readonly status: RunPermissionRequest['status']
  readonly requested_at: number
  readonly decided_at: number | null
}

interface RunRow {
  readonly id: string
  readonly thread_id: string
  readonly workspace_id: string | null
  readonly profile_id: string
  readonly candidate_id: string | null
  readonly model: string
  readonly timeout_ms: number
  readonly status: DurableRunStatus
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
    readonly routingState: 'paused',
  ) {
    super(`Profile "${profileId}" is paused and is not accepting new runs`)
    this.name = 'ProfileRunNotAcceptingError'
  }
}

export class GatewayRunStore {
  private readonly permissionHashKey: Buffer

  constructor(
    private readonly db: Database.Database,
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
      if (deployment?.routing_state === 'paused') {
        throw new ProfileRunNotAcceptingError(
          input.profileId,
          deployment.deployment_revision,
          'paused',
        )
      }
      this.db.prepare(`
        INSERT INTO gateway_runs (
          id, thread_id, workspace_id, profile_id, candidate_id, model, timeout_ms, status,
          start_seq, end_seq, code, accepted_at, started_at, updated_at,
          terminal_at, cancel_requested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?, NULL, NULL, ?, NULL, ?, NULL, NULL)
      `).run(
        runId,
        input.threadId,
        input.workspaceId ?? null,
        input.profileId,
        input.candidateId ?? null,
        input.model,
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

  requestCancel(
    runId: string,
    now: number = Date.now(),
  ): 'requested' | 'already_requested' | 'terminal' | 'missing' {
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
    if (result.changes === 1) return 'requested'
    const after = this.get(runId)
    if (!after) return 'missing'
    if (after.terminal) return 'terminal'
    return after.status === 'cancel_requested' ? 'already_requested' : 'missing'
  }

  markTerminal(
    runId: string,
    status: Extract<DurableRunStatus, 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'indeterminate'>,
    input: { readonly endSeq: number; readonly code?: string; readonly now?: number },
  ): void {
    const now = input.now ?? Date.now()
    this.db.prepare(`
      UPDATE gateway_runs
      SET status = ?, end_seq = ?, code = ?, updated_at = ?, terminal_at = ?
      WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'indeterminate')
    `).run(status, input.endSeq, input.code ?? null, now, now, runId)
  }

  recoverInterrupted(now: number = Date.now()): number {
    const result = this.db.prepare(`
      UPDATE gateway_runs
      SET status = 'indeterminate', code = 'gateway_restarted',
          updated_at = ?, terminal_at = ?, end_seq = NULL
      WHERE status IN ('accepted', 'running', 'waiting', 'cancel_requested')
    `).run(now, now)
    return result.changes
  }

  recordPermissionRequest(input: {
    readonly runId: string
    readonly requestId: string
    readonly toolName: string
    readonly toolInput: Record<string, unknown>
  }, now: number = Date.now()): RunPermissionRequest {
    const operationHash = createHmac('sha256', this.permissionHashKey)
      .update(canonicalJson({ toolName: input.toolName, input: input.toolInput }))
      .digest('hex')
    this.db.prepare(`
      INSERT INTO run_permission_requests (
        run_id, request_id, operation_hash, tool_name, status, requested_at, decided_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, NULL)
      ON CONFLICT(run_id, request_id) DO NOTHING
    `).run(input.runId, input.requestId, operationHash, input.toolName, now)
    const record = this.getPermissionRequest(input.runId, input.requestId)
    if (!record || record.operationHash !== operationHash) {
      throw new Error('Permission request identity conflict')
    }
    return record
  }

  getPermissionRequest(runId: string, requestId: string): RunPermissionRequest | null {
    const row = this.db.prepare(`
      SELECT * FROM run_permission_requests WHERE run_id = ? AND request_id = ?
    `).get(runId, requestId) as PermissionRow | undefined
    return row ? toPermission(row) : null
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
    timeoutMs: row.timeout_ms,
    status: row.status,
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
  return {
    runId: row.run_id,
    requestId: row.request_id,
    operationHash: row.operation_hash,
    toolName: row.tool_name,
    status: row.status,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Permission input contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(',')}}`
  }
  throw new Error('Permission input contains an unsupported value')
}
