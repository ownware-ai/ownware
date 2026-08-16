import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  IDEMPOTENCY_RETENTION_MS,
  digestIdempotencyInput,
  isValidIdempotencyKey,
  parseIdempotencySnapshot,
  validateIdempotencySnapshot,
  type IdempotencyClaim,
  type IdempotencyClaimInput,
  type IdempotencyCompleteInput,
  type IdempotencySnapshot,
} from '../gateway/idempotency.js'
import {
  parseRunConsequence,
  ProfileRunNotAcceptingError,
  type DurableRunStatus,
  type RunConsequence,
  type RunPermissionRequest,
  type RunSnapshot,
} from '../gateway/run-store.js'
import {
  PERMISSION_INTENT_REVISION,
  permissionIntentMaterial,
} from '../gateway/permission-intent.js'
import type {
  IdempotencyRepository,
  RunRepository,
} from './security-repositories.js'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import type { PostgreSqlQueryClient } from './postgresql-repository.js'
import {
  encodePostgreSqlTextKey,
  nullableSafeInteger,
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from './postgresql-repository.js'
import type { EgressMode } from '@ownware/loom'

const TERMINAL = new Set<DurableRunStatus>([
  'succeeded', 'failed', 'cancelled', 'timed_out', 'indeterminate',
])

const RUN_CONSEQUENCE_RANK = new Map<RunConsequence, number>([
  ['none_observed', 0],
  ['output_observed', 1],
  ['effect_possible', 2],
  ['effect_confirmed', 3],
])

const RUN_CONSEQUENCE_SQL_RANK = `CASE consequence
  WHEN 'none_observed' THEN 0
  WHEN 'output_observed' THEN 1
  WHEN 'effect_possible' THEN 2
  WHEN 'effect_confirmed' THEN 3
  ELSE -1
END`

interface RunRow {
  readonly id: string
  readonly thread_id: string
  readonly workspace_id: string | null
  readonly profile_id: string
  readonly candidate_id: string | null
  readonly model: string
  readonly egress_mode: EgressMode
  readonly timeout_ms: string
  readonly status: DurableRunStatus
  readonly consequence: string
  readonly start_seq: string
  readonly end_seq: string | null
  readonly code: string | null
  readonly accepted_at: string
  readonly started_at: string | null
  readonly updated_at: string
  readonly terminal_at: string | null
  readonly cancel_requested_at: string | null
}

interface PermissionRow {
  readonly run_id: string
  readonly request_id: string
  readonly operation_hash: string
  readonly tool_name: string
  readonly intent_revision: string
  readonly policy_revision: string
  readonly agent_id: string | null
  readonly status: RunPermissionRequest['status']
  readonly requested_at: string
  readonly decided_at: string | null
  readonly consumed_at: string | null
}

function snapshot(row: RunRow): RunSnapshot {
  return {
    runId: row.id,
    threadId: row.thread_id,
    workspaceId: row.workspace_id,
    profileId: row.profile_id,
    candidateId: row.candidate_id,
    model: row.model,
    egressMode: row.egress_mode,
    timeoutMs: safeInteger(row.timeout_ms),
    status: row.status,
    consequence: parseRunConsequence(row.consequence),
    terminal: TERMINAL.has(row.status),
    outcomeKnown: row.status !== 'indeterminate',
    acceptedAt: safeInteger(row.accepted_at),
    startedAt: nullableSafeInteger(row.started_at),
    updatedAt: safeInteger(row.updated_at),
    terminalAt: nullableSafeInteger(row.terminal_at),
    cancelRequestedAt: nullableSafeInteger(row.cancel_requested_at),
    startSeq: safeInteger(row.start_seq),
    endSeq: nullableSafeInteger(row.end_seq),
    code: row.code,
  }
}

function permission(row: PermissionRow): RunPermissionRequest {
  if (safeInteger(row.intent_revision) !== PERMISSION_INTENT_REVISION) {
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
    requestedAt: safeInteger(row.requested_at),
    decidedAt: nullableSafeInteger(row.decided_at),
    consumedAt: nullableSafeInteger(row.consumed_at),
  }
}

async function getRun(client: PostgreSqlQueryClient, runId: string): Promise<RunSnapshot | null> {
  const result = await client.query<RunRow>('SELECT * FROM ownware.gateway_runs WHERE id = $1', [runId])
  return result.rows[0] === undefined ? null : snapshot(result.rows[0])
}

async function getPermission(
  client: PostgreSqlQueryClient,
  runId: string,
  requestId: string,
): Promise<RunPermissionRequest | null> {
  const result = await client.query<PermissionRow>(`
    SELECT request.run_id, request.request_id, request.operation_hash,
      request.tool_name, request.status, request.requested_at,
      request.decided_at, binding.intent_revision, binding.policy_revision,
      binding.agent_id, consumption.consumed_at
    FROM ownware.run_permission_requests AS request
    JOIN ownware.run_permission_bindings AS binding
      ON binding.run_id = request.run_id
      AND binding.request_id = request.request_id
    LEFT JOIN ownware.run_permission_consumptions AS consumption
      ON consumption.run_id = request.run_id
      AND consumption.request_id = request.request_id
    WHERE request.run_id = $1 AND request.request_id = $2
  `, [runId, requestId])
  return result.rows[0] === undefined ? null : permission(result.rows[0])
}

export function createPostgreSqlRunRepository(
  context: PostgreSqlRootRepositoryContext,
  permissionHashSecret?: string,
): RunRepository {
  const permissionHashKey = permissionHashSecret === undefined
    ? randomBytes(32)
    : createHmac('sha256', permissionHashSecret)
        .update('ownware.gateway.permission-operation.v1\0')
        .digest()
  return {
    create(input, now = Date.now()) {
      return repositoryCall(context, 'runs', 'create', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            input.profileId,
          ])
          const undeployed = await client.query<{
            readonly deployment_revision: string
          }>(`
            SELECT deployment_revision
            FROM ownware.profile_candidate_deployment_tombstones
            WHERE profile_id = $1
          `, [input.profileId])
          const tombstone = undeployed.rows[0]
          if (tombstone !== undefined) {
            throw new ProfileRunNotAcceptingError(
              input.profileId,
              safeInteger(tombstone.deployment_revision),
              'undeployed',
            )
          }
          const deployment = await client.query<{
            readonly deployment_revision: string
            readonly routing_state: 'active' | 'paused'
          }>(`
            SELECT deployment_revision, routing_state
            FROM ownware.profile_candidate_activations WHERE profile_id = $1 FOR SHARE
          `, [input.profileId])
          const active = deployment.rows[0]
          if (active?.routing_state === 'paused') {
            throw new ProfileRunNotAcceptingError(
              input.profileId, safeInteger(active.deployment_revision), 'paused',
            )
          }
          const runId = randomUUID()
          await client.query(`
            INSERT INTO ownware.gateway_runs (
              id, thread_id, workspace_id, profile_id, candidate_id, model, egress_mode, timeout_ms,
              status, start_seq, end_seq, code, accepted_at, started_at, updated_at,
              terminal_at, cancel_requested_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'accepted', $9, NULL, NULL,
              $10, NULL, $10, NULL, NULL)
          `, [
            runId, input.threadId, input.workspaceId ?? null, input.profileId,
            input.candidateId ?? null, input.model, input.egressMode ?? 'unrestricted', input.timeoutMs,
            input.startSeq, now,
          ])
          const created = await getRun(client, runId)
          if (created === null) throw new Error('run was not created')
          return created
        }),
      )
    },
    countActiveForProfile(profileId) {
      return repositoryCall(context, 'runs', 'count_active', 'read_failed', async (client) => {
        const result = await client.query<{ readonly count: string }>(`
          SELECT COUNT(*) AS count FROM ownware.gateway_runs WHERE profile_id = $1
            AND status IN ('accepted', 'running', 'waiting', 'cancel_requested')
        `, [profileId])
        return safeInteger(result.rows[0]?.count ?? '0')
      })
    },
    get(runId) {
      return repositoryCall(context, 'runs', 'get', 'read_failed', (client) => getRun(client, runId))
    },
    markRunning(runId, now = Date.now()) {
      return repositoryCall(context, 'runs', 'mark_running', 'write_failed', async (client) => {
        await client.query(`
          UPDATE ownware.gateway_runs SET status = 'running',
            started_at = COALESCE(started_at, $1), updated_at = $1
          WHERE id = $2 AND status = 'accepted'
        `, [now, runId])
      })
    },
    advanceConsequence(runId, consequence, now = Date.now()) {
      const rank = RUN_CONSEQUENCE_RANK.get(consequence)
      if (rank === undefined) return Promise.reject(new Error('Run consequence is invalid'))
      if (rank === 0) return Promise.resolve()
      return repositoryCall(context, 'runs', 'advance_consequence', 'write_failed', async (client) => {
        await client.query(`
          UPDATE ownware.gateway_runs SET consequence = $1, updated_at = $2
          WHERE id = $3 AND ${RUN_CONSEQUENCE_SQL_RANK} < $4
        `, [consequence, now, runId, rank])
      })
    },
    requestCancel(runId, now = Date.now()) {
      return repositoryCall(context, 'runs', 'request_cancel', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const result = await client.query<RunRow>(`
            UPDATE ownware.gateway_runs SET status = 'cancel_requested',
              cancel_requested_at = COALESCE(cancel_requested_at, $1), updated_at = $1
            WHERE id = $2 AND status IN ('accepted', 'running', 'waiting') RETURNING *
          `, [now, runId])
          if (result.rowCount === 1) {
            await client.query(`
              UPDATE ownware.run_permission_requests AS request
              SET status = 'expired', decided_at = COALESCE(request.decided_at, $1)
              WHERE request.run_id = $2 AND request.status IN ('pending', 'approved')
                AND NOT EXISTS (
                  SELECT 1 FROM ownware.run_permission_consumptions AS consumption
                  WHERE consumption.run_id = request.run_id
                    AND consumption.request_id = request.request_id
                )
            `, [now, runId])
            return 'requested'
          }
          const current = await getRun(client, runId)
          if (current === null) return 'missing'
          if (current.terminal) return 'terminal'
          return current.status === 'cancel_requested' ? 'already_requested' : 'missing'
        }),
      )
    },
    markTerminal(runId, status, input) {
      const now = input.now ?? Date.now()
      const rank = RUN_CONSEQUENCE_RANK.get(input.consequence)
      if (rank === undefined) return Promise.reject(new Error('Run consequence is invalid'))
      return repositoryCall(context, 'runs', 'mark_terminal', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          await client.query(`
            UPDATE ownware.gateway_runs SET status = $1, end_seq = $2, code = $3,
              updated_at = $4, terminal_at = $4,
              consequence = CASE
                WHEN ${RUN_CONSEQUENCE_SQL_RANK} < $5 THEN $6
                ELSE consequence
              END
              WHERE id = $7
              AND status NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'indeterminate')
          `, [status, input.endSeq, input.code ?? null, now, rank, input.consequence, runId])
          await client.query(`
            UPDATE ownware.run_permission_requests AS request
            SET status = 'expired', decided_at = COALESCE(request.decided_at, $1)
            WHERE request.run_id = $2 AND request.status IN ('pending', 'approved')
              AND NOT EXISTS (
                SELECT 1 FROM ownware.run_permission_consumptions AS consumption
                WHERE consumption.run_id = request.run_id
                  AND consumption.request_id = request.request_id
              )
          `, [now, runId])
        }),
      )
    },
    recoverInterrupted(now = Date.now()) {
      return repositoryCall(context, 'runs', 'recover_interrupted', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          await client.query(`
            UPDATE ownware.run_permission_requests AS request
            SET status = 'expired', decided_at = COALESCE(request.decided_at, $1)
            WHERE request.status IN ('pending', 'approved')
              AND NOT EXISTS (
                SELECT 1 FROM ownware.run_permission_consumptions AS consumption
                WHERE consumption.run_id = request.run_id
                  AND consumption.request_id = request.request_id
              )
              AND EXISTS (
                SELECT 1 FROM ownware.gateway_runs AS run
                WHERE run.id = request.run_id
                  AND run.status IN ('accepted', 'running', 'waiting', 'cancel_requested')
              )
          `, [now])
          const result = await client.query(`
            UPDATE ownware.gateway_runs SET status = 'indeterminate', code = 'gateway_restarted',
              updated_at = $1, terminal_at = $1, end_seq = NULL
            WHERE status IN ('accepted', 'running', 'waiting', 'cancel_requested')
          `, [now])
          return result.rowCount ?? 0
        }),
      )
    },
    recordPermissionRequest(input, now = Date.now()) {
      return repositoryCall(context, 'runs', 'record_permission', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
        const operationHash = createHmac('sha256', permissionHashKey)
          .update(permissionIntentMaterial(input))
          .digest('hex')
        await client.query(`
          INSERT INTO ownware.run_permission_requests (
            run_id, request_id, operation_hash, tool_name, status, requested_at, decided_at
          ) VALUES ($1, $2, $3, $4, 'pending', $5, NULL)
          ON CONFLICT (run_id, request_id) DO NOTHING
        `, [input.runId, input.requestId, operationHash, input.toolName, now])
        await client.query(`
          INSERT INTO ownware.run_permission_bindings (
            run_id, request_id, intent_revision, policy_revision, agent_id, bound_at
          ) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (run_id, request_id) DO NOTHING
        `, [
          input.runId,
          input.requestId,
          PERMISSION_INTENT_REVISION,
          input.policyRevision,
          input.agentId,
          now,
        ])
        const row = await getPermission(client, input.runId, input.requestId)
        if (
          row === null
          || row.operationHash !== operationHash
          || row.intentRevision !== PERMISSION_INTENT_REVISION
          || row.policyRevision !== input.policyRevision
          || row.agentId !== input.agentId
        ) {
          throw new Error('permission request identity conflict')
        }
        return row
      }))
    },
    getPermissionRequest(runId, requestId) {
      return repositoryCall(context, 'runs', 'get_permission', 'read_failed', (client) =>
        getPermission(client, runId, requestId))
    },
    consumePermissionApproval(input, now = Date.now()) {
      return repositoryCall(context, 'runs', 'consume_permission', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const operationHash = createHmac('sha256', permissionHashKey)
            .update(permissionIntentMaterial(input))
            .digest('hex')
          const current = await getPermission(client, input.runId, input.requestId)
          if (current === null) return 'missing' as const
          if (
            current.operationHash !== operationHash
            || current.policyRevision !== input.policyRevision
            || current.agentId !== input.agentId
            || current.toolName !== input.toolName
          ) return 'intent_mismatch' as const
          if (current.consumedAt !== null) return 'already_consumed' as const
          if (current.status !== 'approved') return 'not_approved' as const
          const result = await client.query(`
            INSERT INTO ownware.run_permission_consumptions (
              run_id, request_id, operation_hash, consumed_at
            ) VALUES ($1, $2, $3, $4)
            ON CONFLICT (run_id, request_id) DO NOTHING
          `, [input.runId, input.requestId, operationHash, now])
          return result.rowCount === 1
            ? 'consumed' as const
            : 'already_consumed' as const
        }))
    },
    decidePermission(runId, requestId, operationHash, decision, now = Date.now()) {
      return repositoryCall(context, 'runs', 'decide_permission', 'write_failed', async (client) => {
        const result = await client.query(`
          UPDATE ownware.run_permission_requests SET status = $1, decided_at = $2
          WHERE run_id = $3 AND request_id = $4 AND status = 'pending' AND operation_hash = $5
        `, [decision === 'approve' ? 'approved' : 'denied', now, runId, requestId, operationHash])
        if (result.rowCount === 1) return 'decided'
        const current = await getPermission(client, runId, requestId)
        if (current === null) return 'missing'
        if (current.operationHash !== operationHash) return 'hash_mismatch'
        return 'already_decided'
      })
    },
    expirePermission(runId, requestId, operationHash, now = Date.now()) {
      return repositoryCall(context, 'runs', 'expire_permission', 'write_failed', async (client) => {
        const current = await getPermission(client, runId, requestId)
        if (current === null) return 'missing'
        if (current.operationHash !== operationHash) return 'hash_mismatch'
        if (
          current.status === 'denied'
          || current.status === 'expired'
          || current.consumedAt !== null
        ) return 'already_terminal'
        const result = await client.query(`
          UPDATE ownware.run_permission_requests AS request
          SET status = 'expired', decided_at = COALESCE(request.decided_at, $1)
          WHERE request.run_id = $2 AND request.request_id = $3
            AND request.operation_hash = $4
            AND request.status IN ('pending', 'approved')
            AND NOT EXISTS (
              SELECT 1 FROM ownware.run_permission_consumptions AS consumption
              WHERE consumption.run_id = request.run_id
                AND consumption.request_id = request.request_id
            )
        `, [now, runId, requestId, operationHash])
        return result.rowCount === 1 ? 'expired' : 'already_terminal'
      })
    },
    markWaiting(runId, now = Date.now()) {
      return repositoryCall(context, 'runs', 'mark_waiting', 'write_failed', async (client) => {
        await client.query(`
          UPDATE ownware.gateway_runs SET status = 'waiting', updated_at = $1
          WHERE id = $2 AND status = 'running'
        `, [now, runId])
      })
    },
    markRunningAfterDecision(runId, now = Date.now()) {
      return repositoryCall(context, 'runs', 'mark_running_after_decision', 'write_failed', async (client) => {
        await client.query(`
          UPDATE ownware.gateway_runs SET status = 'running', updated_at = $1
          WHERE id = $2 AND status = 'waiting'
        `, [now, runId])
      })
    },
  }
}

interface IdempotencyRow {
  readonly id: string
  readonly request_salt: string
  readonly request_digest: string
  readonly state: 'in_progress' | 'completed' | 'indeterminate'
  readonly lease_owner: string
  readonly status_code: string | null
  readonly result_json: string | null
  readonly expires_at: string
  readonly source_id: string | null
}

async function findIdempotency(
  client: PostgreSqlQueryClient,
  input: Pick<IdempotencyClaimInput, 'principalKey' | 'operation' | 'key'>,
  forUpdate = false,
): Promise<IdempotencyRow | undefined> {
  const result = await client.query<IdempotencyRow>(`
    SELECT id, request_salt, request_digest, state, lease_owner, status_code,
      result_json, expires_at, source_id FROM ownware.run_idempotency
    WHERE principal_key = $1 AND operation = $2 AND idempotency_key = $3
    ${forUpdate ? 'FOR UPDATE' : ''}
  `, [encodePostgreSqlTextKey(input.principalKey), input.operation, input.key])
  return result.rows[0]
}

function sourceIdForOperation(operation: string, result: IdempotencySnapshot): string | null {
  if (![
    'sources.register', 'source_uploads.create', 'source_jobs.create', 'source_preparations.create',
  ].includes(operation)) return null
  return 'sourceId' in result ? result.sourceId : null
}

export function createPostgreSqlIdempotencyRepository(
  context: PostgreSqlRootRepositoryContext,
  leaseOwner: string = randomUUID(),
): IdempotencyRepository {
  return {
    claim(input: IdempotencyClaimInput, now = Date.now()): Promise<IdempotencyClaim> {
      if (!isValidIdempotencyKey(input.key)) return Promise.reject(new Error('invalid idempotency key'))
      return repositoryCall(context, 'idempotency', 'claim', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
          const salt = randomBytes(16).toString('hex')
          const recordId = randomUUID()
          const inserted = await client.query(`
            INSERT INTO ownware.run_idempotency (
              id, principal_key, operation, idempotency_key, request_salt, request_digest,
              state, lease_owner, status_code, result_json, created_at, updated_at, expires_at
            ) VALUES ($1, $2, $3, $4, $5, $6, 'in_progress', $7, NULL, NULL, $8, $8, $9)
            ON CONFLICT (principal_key, operation, idempotency_key) DO NOTHING RETURNING id
          `, [
            recordId, encodePostgreSqlTextKey(input.principalKey), input.operation, input.key, salt,
            digestIdempotencyInput(salt, input.input), leaseOwner, now,
            now + IDEMPOTENCY_RETENTION_MS,
          ])
          if (inserted.rowCount === 1) return { kind: 'claimed', recordId }
          const row = await findIdempotency(client, input, true)
          if (row === undefined) throw new Error('idempotency row disappeared')
          if (row.request_digest !== digestIdempotencyInput(row.request_salt, input.input)) {
            return { kind: 'conflict' }
          }
          if (row.state === 'completed') {
            if (now > safeInteger(row.expires_at)) return { kind: 'expired' }
            if (row.source_id !== null) {
              const active = await client.query(`
                SELECT 1 FROM ownware.runtime_sources
                WHERE source_id = $1 AND deletion_state = 'active'
              `, [row.source_id])
              if (active.rowCount !== 1) return { kind: 'indeterminate' }
            }
            const result = parseIdempotencySnapshot(row.result_json)
            if (row.status_code === null || result === null) {
              await client.query(`
                UPDATE ownware.run_idempotency SET state = 'indeterminate', status_code = NULL,
                  result_json = NULL, updated_at = $1 WHERE id = $2 AND state = 'in_progress'
              `, [now, row.id])
              return { kind: 'indeterminate' }
            }
            return { kind: 'replay', statusCode: safeInteger(row.status_code), result }
          }
          if (row.state === 'indeterminate') return { kind: 'indeterminate' }
          if (row.lease_owner === leaseOwner) return { kind: 'in_progress' }
          await client.query(`
            UPDATE ownware.run_idempotency SET state = 'indeterminate', status_code = NULL,
              result_json = NULL, updated_at = $1 WHERE id = $2 AND state = 'in_progress'
          `, [now, row.id])
          return { kind: 'indeterminate' }
        }),
      )
    },
    complete(input: IdempotencyCompleteInput, now = Date.now()) {
      return repositoryCall(context, 'idempotency', 'complete', 'write_failed', async (client) => {
        const result = validateIdempotencySnapshot(input.result)
        const sourceId = sourceIdForOperation(input.operation, result)
        const updated = await client.query(`
          UPDATE ownware.run_idempotency SET state = 'completed', status_code = $1,
            result_json = $2, source_id = COALESCE($3, source_id), updated_at = $4
          WHERE principal_key = $5 AND operation = $6 AND idempotency_key = $7
            AND state = 'in_progress' AND lease_owner = $8
            AND ($3::text IS NULL OR EXISTS (
              SELECT 1 FROM ownware.runtime_sources
              WHERE source_id = $3 AND deletion_state = 'active'
            ))
        `, [
          input.statusCode, JSON.stringify(result), sourceId, now,
          encodePostgreSqlTextKey(input.principalKey),
          input.operation, input.key, leaseOwner,
        ])
        if (updated.rowCount !== 1) throw new Error('idempotency claim is not completable')
      })
    },
    markIndeterminate(input, now = Date.now()) {
      return repositoryCall(context, 'idempotency', 'mark_indeterminate', 'write_failed', async (client) => {
        await client.query(`
          UPDATE ownware.run_idempotency SET state = 'indeterminate', status_code = NULL,
            result_json = NULL, updated_at = $1
          WHERE principal_key = $2 AND operation = $3 AND idempotency_key = $4
            AND state = 'in_progress'
        `, [now, encodePostgreSqlTextKey(input.principalKey), input.operation, input.key])
      })
    },
    abandon(input) {
      return repositoryCall(context, 'idempotency', 'abandon', 'write_failed', async (client) => {
        await client.query(`
          DELETE FROM ownware.run_idempotency WHERE principal_key = $1 AND operation = $2
            AND idempotency_key = $3 AND state = 'in_progress' AND lease_owner = $4
        `, [encodePostgreSqlTextKey(input.principalKey), input.operation, input.key, leaseOwner])
      })
    },
    linkRun(recordId, runId) {
      return repositoryCall(context, 'idempotency', 'link_run', 'write_failed', async (client) => {
        const result = await client.query(`
          UPDATE ownware.run_idempotency SET run_id = $1 WHERE id = $2 AND run_id IS NULL
            AND state = 'in_progress' AND lease_owner = $3
        `, [runId, recordId, leaseOwner])
        if (result.rowCount !== 1) throw new Error('run idempotency link is unavailable')
      })
    },
    linkSourceMutation(recordId, sourceId, kind, now = Date.now()) {
      if (!isValidIdempotencyKey(recordId) || !isValidIdempotencyKey(sourceId) ||
        !Number.isSafeInteger(now) || now < 0) {
        return Promise.reject(new Error('source mutation link is invalid'))
      }
      return repositoryCall(context, 'idempotency', 'link_source_mutation', 'write_failed', async (client) => {
        const result = await client.query(`
          UPDATE ownware.run_idempotency SET source_id = $1, source_mutation_kind = $2,
            updated_at = $3 WHERE id = $4 AND state = 'in_progress' AND lease_owner = $5
            AND source_id IS NULL AND source_mutation_kind IS NULL AND EXISTS (
              SELECT 1 FROM ownware.runtime_sources
              WHERE source_id = $1 AND deletion_state = 'active'
            )
        `, [sourceId, kind, now, recordId, leaseOwner])
        if (result.rowCount !== 1) throw new Error('source mutation link is unavailable')
      })
    },
  }
}
