import { randomUUID, timingSafeEqual } from 'node:crypto'
import type {
  CredentialBootMigrationOptions,
  CredentialBootMigrationResult,
  CredentialStore,
} from '../credential/store/index.js'
import type {
  CredentialAuditEvent,
  RecordEventInput,
} from '../credential/audit.js'
import { CredentialAuditEventSchema } from '../credential/audit.js'
import type {
  OAuthRefreshAcquireResult,
  OAuthRefreshLease,
} from '../credential/oauth-refresh-coordinator.js'
import { isCredentialId, type SpendCap } from '../credential/schema.js'
import { periodStart, type SpendCheckResult } from '../credential/spend-tracker.js'
import {
  CredentialVault,
  credentialVault as defaultCredentialVault,
} from '../connector/credentials/vault.js'
import { parseRuntimeCredentialId } from '../credential/runtime.js'
import {
  PrincipalAuthError,
  type DelegatedPrincipal,
} from '../gateway/auth/scoped-principal.js'
import { threadPrincipalScopeDigest } from '../gateway/thread-principal-binding.js'
import {
  CodexThreadReferenceStoreError,
} from '../runtime/codex/thread-reference-store.js'
import {
  parseCodexThreadReference,
  type CodexThreadReference,
} from '../runtime/codex/official-thread.js'
import type {
  CredentialAuditRepository,
  CredentialMigrationRepository,
  CredentialSpendRepository,
  DelegatedPrincipalRepository,
  OAuthRefreshRepository,
  ThreadPrincipalBindingRepository,
  CodexThreadReferenceRepository,
} from './security-repositories.js'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import {
  finiteNumber,
  nullableSafeInteger,
  repositoryCall,
  safeInteger,
} from './postgresql-repository.js'

interface AuditRow {
  readonly id: string
  readonly credential_id: string
  readonly event_type: string
  readonly outcome: string
  readonly agent_id: string | null
  readonly session_id: string | null
  readonly thread_id: string | null
  readonly tool_name: string | null
  readonly host: string | null
  readonly detail: string | null
  readonly estimated_cost_usd: string | number | null
  readonly actual_cost_usd: string | number | null
  readonly created_at: string
}

const AUDIT_COLUMNS = `
  id, credential_id, event_type, outcome, agent_id, session_id, thread_id,
  tool_name, host, detail, estimated_cost_usd, actual_cost_usd, created_at
`

function auditEvent(row: AuditRow): CredentialAuditEvent {
  let detail: Record<string, unknown> | null = null
  if (row.detail !== null) {
    try { detail = JSON.parse(row.detail) as Record<string, unknown> } catch { detail = null }
  }
  return CredentialAuditEventSchema.parse({
    id: row.id,
    credentialId: row.credential_id,
    eventType: row.event_type,
    outcome: row.outcome,
    agentId: row.agent_id,
    sessionId: row.session_id,
    threadId: row.thread_id,
    toolName: row.tool_name,
    host: row.host,
    detail,
    estimatedCostUsd: row.estimated_cost_usd === null ? null : finiteNumber(row.estimated_cost_usd),
    actualCostUsd: row.actual_cost_usd === null ? null : finiteNumber(row.actual_cost_usd),
    createdAt: row.created_at,
  })
}

export function createPostgreSqlCredentialAuditRepository(
  context: PostgreSqlRootRepositoryContext,
): CredentialAuditRepository {
  return {
    recordEvent(input: RecordEventInput): Promise<CredentialAuditEvent> {
      return repositoryCall(context, 'credential_audit', 'record', 'write_failed', async (client) => {
        const row: CredentialAuditEvent = CredentialAuditEventSchema.parse({
          id: `caud_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          credentialId: input.credentialId,
          eventType: input.eventType,
          outcome: input.outcome,
          agentId: input.agentId ?? null,
          sessionId: input.sessionId ?? null,
          threadId: input.threadId ?? null,
          toolName: input.toolName ?? null,
          host: input.host ?? null,
          detail: input.detail ?? null,
          estimatedCostUsd: input.estimatedCostUsd ?? null,
          actualCostUsd: input.actualCostUsd ?? null,
          createdAt: new Date().toISOString(),
        })
        await client.query(`
          INSERT INTO ownware.credential_audit_log (${AUDIT_COLUMNS})
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `, [
          row.id, row.credentialId, row.eventType, row.outcome, row.agentId,
          row.sessionId, row.threadId, row.toolName, row.host,
          row.detail === null ? null : JSON.stringify(row.detail),
          row.estimatedCostUsd, row.actualCostUsd, row.createdAt,
        ])
        return row
      })
    },

    listEventsForCredential(credentialId, options = {}) {
      return repositoryCall(context, 'credential_audit', 'list', 'read_failed', async (client) => {
        const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
        const offset = Math.max(options.offset ?? 0, 0)
        const [rows, count] = await Promise.all([
          client.query<AuditRow>(`
            SELECT ${AUDIT_COLUMNS} FROM ownware.credential_audit_log
            WHERE credential_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3
          `, [credentialId, limit, offset]),
          client.query<{ readonly count: string }>(`
            SELECT COUNT(*) AS count FROM ownware.credential_audit_log WHERE credential_id = $1
          `, [credentialId]),
        ])
        return { events: rows.rows.map(auditEvent), total: safeInteger(count.rows[0]?.count ?? '0') }
      })
    },

    aggregateUsage(credentialId, options = {}) {
      return repositoryCall(context, 'credential_audit', 'aggregate_usage', 'read_failed', async (client) => {
        const group = options.groupBy === 'agent_id' ? 'agent_id' : 'tool_name'
        const since = options.sinceIso ?? null
        const [total, consumers] = await Promise.all([
          client.query<{ readonly count: string }>(`
            SELECT COUNT(*) AS count FROM ownware.credential_audit_log
            WHERE credential_id = $1 AND ($2::text IS NULL OR created_at >= $2)
          `, [credentialId, since]),
          client.query<{ readonly key: string; readonly count: string }>(`
            SELECT ${group} AS key, COUNT(*) AS count
            FROM ownware.credential_audit_log
            WHERE credential_id = $1 AND ${group} IS NOT NULL
              AND ($2::text IS NULL OR created_at >= $2)
            GROUP BY ${group} ORDER BY count DESC LIMIT 10
          `, [credentialId, since]),
        ])
        return {
          totalCalls: safeInteger(total.rows[0]?.count ?? '0'),
          topConsumers: consumers.rows.map((row) => ({ key: row.key, count: safeInteger(row.count) })),
          windowStart: since,
        }
      })
    },

    aggregateCost(credentialId, options = {}) {
      return repositoryCall(context, 'credential_audit', 'aggregate_cost', 'read_failed', async (client) => {
        const since = options.sinceIso ?? null
        const result = await client.query<{
          readonly date: string
          readonly estimated: string
          readonly actual: string
          readonly calls: string
        }>(`
          SELECT substring(created_at, 1, 10) AS date,
            COALESCE(SUM(estimated_cost_usd), 0) AS estimated,
            COALESCE(SUM(actual_cost_usd), 0) AS actual,
            SUM(CASE WHEN detail IS NOT NULL AND (detail::jsonb ? 'trueUp') THEN 0 ELSE 1 END) AS calls
          FROM ownware.credential_audit_log
          WHERE credential_id = $1 AND ($2::text IS NULL OR created_at >= $2)
          GROUP BY substring(created_at, 1, 10) ORDER BY date ASC
        `, [credentialId, since])
        const buckets = result.rows.map((row) => ({
          date: row.date,
          estimatedUsd: finiteNumber(row.estimated),
          actualUsd: finiteNumber(row.actual),
          calls: safeInteger(row.calls),
        }))
        return {
          totalEstimatedUsd: buckets.reduce((sum, row) => sum + row.estimatedUsd, 0),
          totalActualUsd: buckets.reduce((sum, row) => sum + row.actualUsd, 0),
          buckets,
          windowStart: since,
        }
      })
    },
  }
}

export function createPostgreSqlCredentialSpendRepository(
  context: PostgreSqlRootRepositoryContext,
): CredentialSpendRepository {
  return {
    check(credentialId: string, cap: SpendCap, estimatedCostUsd: number, now = new Date()) {
      if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
        return Promise.reject(new Error('credential spend estimate is invalid'))
      }
      return repositoryCall(context, 'credential_spend', 'check', 'read_failed', async (client) => {
        const windowStart = periodStart(cap.period, now)
        const result = await client.query<{ readonly total: string }>(`
          SELECT COALESCE(SUM(COALESCE(actual_cost_usd, estimated_cost_usd, 0)), 0) AS total
          FROM ownware.credential_audit_log
          WHERE credential_id = $1 AND event_type = 'resolve' AND created_at >= $2
        `, [credentialId, windowStart])
        const total = finiteNumber(result.rows[0]?.total ?? '0')
        const response: SpendCheckResult = total + estimatedCostUsd > cap.amountUsd
          ? {
              status: 'denied', reason: 'SPEND_CAP_EXCEEDED', windowStart,
              currentSpendUsd: total, capUsd: cap.amountUsd, estimatedCostUsd,
            }
          : {
              status: 'ok', windowStart, currentSpendUsd: total, capUsd: cap.amountUsd,
              remainingUsd: cap.amountUsd - total - estimatedCostUsd,
            }
        return response
      })
    },
  }
}

interface PrincipalRow {
  readonly token_id: string
  readonly delegate_id: string
  readonly workspace_id: string
  readonly profile_id: string
  readonly subject_id: string | null
  readonly purpose: string
  readonly channel: string | null
  readonly operations_json: string
  readonly issued_at: string
  readonly expires_at: string
  readonly revoked_at: string | null
}

export function createPostgreSqlPrincipalRepository(
  context: PostgreSqlRootRepositoryContext,
): DelegatedPrincipalRepository {
  return {
    insert(principal: DelegatedPrincipal): Promise<void> {
      return repositoryCall(context, 'principals', 'insert', 'write_failed', async (client) => {
        await client.query(`
          INSERT INTO ownware.delegated_principals (
            token_id, delegate_id, workspace_id, profile_id, subject_id, purpose, channel,
            operations_json, issued_at, expires_at, revoked_at, revoke_reason
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL)
        `, [
          principal.tokenId, principal.delegateId, principal.workspaceId, principal.profileId,
          principal.subjectId ?? null, principal.purpose, principal.channel ?? null,
          JSON.stringify(principal.operations), principal.issuedAt, principal.expiresAt,
        ])
      })
    },
    find(tokenId) {
      return repositoryCall(context, 'principals', 'find', 'read_failed', async (client) => {
        const result = await client.query<PrincipalRow>(`
          SELECT token_id, delegate_id, workspace_id, profile_id, subject_id, purpose, channel,
            operations_json, issued_at, expires_at, revoked_at
          FROM ownware.delegated_principals WHERE token_id = $1
        `, [tokenId])
        const row = result.rows[0]
        if (row === undefined) return null
        let operations: unknown
        try { operations = JSON.parse(row.operations_json) } catch { operations = null }
        if (!Array.isArray(operations) || operations.some((item) => typeof item !== 'string')) {
          throw new PrincipalAuthError('principal_invalid', 'Persisted principal is invalid')
        }
        return {
          kind: 'delegated' as const,
          tokenId: row.token_id,
          delegateId: row.delegate_id,
          workspaceId: row.workspace_id,
          profileId: row.profile_id,
          ...(row.subject_id === null ? {} : { subjectId: row.subject_id }),
          purpose: row.purpose,
          ...(row.channel === null ? {} : { channel: row.channel }),
          operations: operations as string[],
          issuedAt: safeInteger(row.issued_at),
          expiresAt: safeInteger(row.expires_at),
          revokedAt: nullableSafeInteger(row.revoked_at),
        }
      })
    },
    revoke(tokenId, reason, revokedAt) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(reason)) {
        return Promise.reject(new PrincipalAuthError('principal_scope_invalid', 'Invalid revocation reason'))
      }
      return repositoryCall(context, 'principals', 'revoke', 'write_failed', async (client) => {
        const result = await client.query(`
          UPDATE ownware.delegated_principals SET revoked_at = $1, revoke_reason = $2
          WHERE token_id = $3 AND revoked_at IS NULL
        `, [revokedAt, reason, tokenId])
        return result.rowCount === 1
      })
    },
  }
}

export function createPostgreSqlThreadBindingRepository(
  context: PostgreSqlRootRepositoryContext,
): ThreadPrincipalBindingRepository {
  async function allowsDigest(threadId: string, expected: string): Promise<boolean> {
    return repositoryCall(context, 'thread_bindings', 'allows', 'read_failed', async (client) => {
      const result = await client.query<{ readonly principal_scope_digest: string }>(`
        SELECT principal_scope_digest FROM ownware.thread_principal_bindings WHERE thread_id = $1
      `, [threadId])
      const actual = result.rows[0]?.principal_scope_digest
      return typeof actual === 'string' && /^[0-9a-f]{64}$/.test(actual) && timingSafeEqual(
        Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'),
      )
    })
  }
  return {
    async bind(threadId, principalKey, now = Date.now()) {
      const digest = threadPrincipalScopeDigest(principalKey)
      await repositoryCall(context, 'thread_bindings', 'bind', 'write_failed', async (client) => {
        await client.query(`
          INSERT INTO ownware.thread_principal_bindings (thread_id, principal_scope_digest, created_at)
          VALUES ($1, $2, $3) ON CONFLICT (thread_id) DO NOTHING
        `, [threadId, digest, now])
      })
      return allowsDigest(threadId, digest)
    },
    allows(threadId, principalKey) {
      return allowsDigest(threadId, threadPrincipalScopeDigest(principalKey))
    },
  }
}

interface LeaseRow {
  readonly credential_id: string
  readonly owner_id: string
  readonly generation: string
  readonly expires_at: string
}

function lease(row: LeaseRow): OAuthRefreshLease {
  return {
    credentialId: row.credential_id,
    ownerId: row.owner_id,
    generation: safeInteger(row.generation),
    expiresAt: safeInteger(row.expires_at),
  }
}

function assertLeaseTime(value: number, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error('OAuth refresh lease time is invalid')
  }
}

export function createPostgreSqlOAuthRefreshRepository(
  context: PostgreSqlRootRepositoryContext,
  ownerId: string = randomUUID(),
): OAuthRefreshRepository {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(ownerId)) throw new Error('OAuth refresh owner id is invalid')
  const inspect = (credentialId: string): Promise<OAuthRefreshLease | null> =>
    repositoryCall(context, 'oauth_refresh', 'inspect', 'read_failed', async (client) => {
      const result = await client.query<LeaseRow>(`
        SELECT credential_id, owner_id, generation, expires_at
        FROM ownware.oauth_refresh_leases WHERE credential_id = $1
      `, [credentialId])
      return result.rows[0] === undefined ? null : lease(result.rows[0])
    })
  return {
    tryAcquire(credentialId, now, leaseMs): Promise<OAuthRefreshAcquireResult> {
      if (!isCredentialId(credentialId)) return Promise.resolve({ kind: 'missing' })
      assertLeaseTime(now, true)
      assertLeaseTime(leaseMs, false)
      if (!Number.isSafeInteger(now + leaseMs)) throw new Error('OAuth refresh lease expiry is invalid')
      return repositoryCall(context, 'oauth_refresh', 'try_acquire', 'write_failed', async (client) => {
        const credential = await client.query('SELECT 1 FROM ownware.credentials WHERE id = $1', [credentialId])
        if (credential.rowCount !== 1) return { kind: 'missing' }
        const result = await client.query<LeaseRow>(`
          INSERT INTO ownware.oauth_refresh_leases (
            credential_id, owner_id, generation, expires_at, updated_at
          ) VALUES ($1, $2, 1, $3, $4)
          ON CONFLICT (credential_id) DO UPDATE SET
            owner_id = EXCLUDED.owner_id,
            generation = ownware.oauth_refresh_leases.generation + 1,
            expires_at = EXCLUDED.expires_at,
            updated_at = EXCLUDED.updated_at
          WHERE ownware.oauth_refresh_leases.expires_at <= EXCLUDED.updated_at
          RETURNING credential_id, owner_id, generation, expires_at
        `, [credentialId, ownerId, now + leaseMs, now])
        const acquired = result.rows[0]
        if (acquired !== undefined) return { kind: 'acquired', lease: lease(acquired) }
        const held = await client.query<LeaseRow>(`
          SELECT credential_id, owner_id, generation, expires_at
          FROM ownware.oauth_refresh_leases WHERE credential_id = $1
        `, [credentialId])
        return { kind: 'held', retryAt: safeInteger(held.rows[0]?.expires_at ?? now + leaseMs) }
      })
    },
    renew(current, now, leaseMs) {
      assertLeaseTime(now, true)
      assertLeaseTime(leaseMs, false)
      if (!Number.isSafeInteger(now + leaseMs)) throw new Error('OAuth refresh lease expiry is invalid')
      return repositoryCall(context, 'oauth_refresh', 'renew', 'write_failed', async (client) => {
        const result = await client.query<LeaseRow>(`
          UPDATE ownware.oauth_refresh_leases SET expires_at = $1, updated_at = $2
          WHERE credential_id = $3 AND owner_id = $4 AND generation = $5 AND expires_at > $2
          RETURNING credential_id, owner_id, generation, expires_at
        `, [now + leaseMs, now, current.credentialId, current.ownerId, current.generation])
        return result.rows[0] === undefined ? null : lease(result.rows[0])
      })
    },
    release(current) {
      return repositoryCall(context, 'oauth_refresh', 'release', 'write_failed', async (client) => {
        const result = await client.query(`
          DELETE FROM ownware.oauth_refresh_leases
          WHERE credential_id = $1 AND owner_id = $2 AND generation = $3
        `, [current.credentialId, current.ownerId, current.generation])
        return result.rowCount === 1
      })
    },
    inspect,
  }
}

interface CodexRow {
  readonly local_thread_id: string
  readonly remote_thread_id: string
  readonly revision: string
  readonly account_binding: string
  readonly model: string
  readonly model_provider: string
  readonly profile_report_id: string
  readonly sandbox_report_id: string
  readonly bound_at: string
  readonly active_turn_id: string | null
  readonly active_started_at: string | null
  readonly active_consequence: string | null
  readonly last_turn_id: string | null
  readonly last_turn_status: string | null
  readonly last_turn_completed_at: string | null
  readonly last_turn_authority: string | null
  readonly recovery_state: string
}

const CODEX_COLUMNS = `
  local_thread_id, remote_thread_id, revision, account_binding, model, model_provider,
  profile_report_id, sandbox_report_id, bound_at, active_turn_id, active_started_at,
  active_consequence, last_turn_id, last_turn_status, last_turn_completed_at,
  last_turn_authority, recovery_state
`

function codexReference(row: CodexRow): CodexThreadReference {
  return parseCodexThreadReference({
    schemaVersion: 1,
    revision: safeInteger(row.revision),
    selection: { runtime: 'openai-codex', access: { route: 'openai-chatgpt-managed' } },
    localThreadId: row.local_thread_id,
    remoteThreadId: row.remote_thread_id,
    accountBinding: row.account_binding,
    model: row.model,
    modelProvider: row.model_provider,
    profileReportId: row.profile_report_id,
    sandboxReportId: row.sandbox_report_id,
    boundAt: row.bound_at,
    activeTurn: row.active_turn_id === null ? null : {
      id: row.active_turn_id,
      startedAt: row.active_started_at,
      consequence: row.active_consequence,
    },
    lastTerminalTurn: row.last_turn_id === null ? null : {
      id: row.last_turn_id,
      status: row.last_turn_status,
      completedAt: row.last_turn_completed_at,
      authority: row.last_turn_authority,
    },
    recoveryState: row.recovery_state,
  })
}

function codexValues(reference: CodexThreadReference): readonly unknown[] {
  return [
    reference.remoteThreadId, reference.revision, reference.accountBinding, reference.model,
    reference.modelProvider, reference.profileReportId, reference.sandboxReportId,
    reference.boundAt, reference.activeTurn?.id ?? null, reference.activeTurn?.startedAt ?? null,
    reference.activeTurn?.consequence ?? null, reference.lastTerminalTurn?.id ?? null,
    reference.lastTerminalTurn?.status ?? null, reference.lastTerminalTurn?.completedAt ?? null,
    reference.lastTerminalTurn?.authority ?? null, reference.recoveryState, Date.now(),
  ]
}

export function createPostgreSqlCodexReferenceRepository(
  context: PostgreSqlRootRepositoryContext,
): CodexThreadReferenceRepository {
  const load = (localThreadId: string): Promise<CodexThreadReference | undefined> =>
    repositoryCall(context, 'codex_thread_references', 'load', 'read_failed', async (client) => {
      const result = await client.query<CodexRow>(`
        SELECT ${CODEX_COLUMNS} FROM ownware.codex_thread_references WHERE local_thread_id = $1
      `, [localThreadId])
      return result.rows[0] === undefined ? undefined : codexReference(result.rows[0])
    })
  return {
    load,
    async save(input: unknown): Promise<CodexThreadReference> {
      let reference: CodexThreadReference
      try { reference = parseCodexThreadReference(input) } catch {
        throw new CodexThreadReferenceStoreError('invalid_reference')
      }
      const values = codexValues(reference)
      if (reference.revision === 0) {
        const inserted = await repositoryCall(
          context, 'codex_thread_references', 'save', 'write_failed', async (client) =>
            client.query(`
              INSERT INTO ownware.codex_thread_references (
                local_thread_id, remote_thread_id, revision, account_binding, model,
                model_provider, profile_report_id, sandbox_report_id, bound_at,
                active_turn_id, active_started_at, active_consequence, last_turn_id,
                last_turn_status, last_turn_completed_at, last_turn_authority,
                recovery_state, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                $14, $15, $16, $17, $18)
              ON CONFLICT (local_thread_id) DO NOTHING
            `, [reference.localThreadId, ...values]),
        )
        if (inserted.rowCount === 1) return reference
      } else {
        const updated = await repositoryCall(
          context, 'codex_thread_references', 'save', 'write_failed', async (client) =>
            client.query(`
              UPDATE ownware.codex_thread_references SET
                remote_thread_id = $1, revision = $2, account_binding = $3, model = $4,
                model_provider = $5, profile_report_id = $6, sandbox_report_id = $7,
                bound_at = $8, active_turn_id = $9, active_started_at = $10,
                active_consequence = $11, last_turn_id = $12, last_turn_status = $13,
                last_turn_completed_at = $14, last_turn_authority = $15,
                recovery_state = $16, updated_at = $17
              WHERE local_thread_id = $18 AND revision = $19
            `, [...values, reference.localThreadId, reference.revision - 1]),
        )
        if (updated.rowCount === 1) return reference
      }
      const existing = await load(reference.localThreadId)
      if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(reference)) return reference
      throw new CodexThreadReferenceStoreError('stale_write')
    },
  }
}

/**
 * PostgreSQL has no legacy provider_keys table. The file-vault importer still
 * runs against the selected credential authority so switching adapters does
 * not orphan connector credentials.
 */
export function createPostgreSqlCredentialMigrationRepository(
  context: PostgreSqlRootRepositoryContext,
  credentials: CredentialStore,
): CredentialMigrationRepository {
  return {
    async run(options: CredentialBootMigrationOptions = {}): Promise<CredentialBootMigrationResult> {
      context.assertActive()
      const fileVault = await importFileVault(credentials, options)
      return {
        providerKeys: { ran: false, imported: [], alreadyPresent: [], errors: [] },
        fileVault,
      }
    },
  }
}

async function importFileVault(
  credentials: CredentialStore,
  options: CredentialBootMigrationOptions,
): Promise<CredentialBootMigrationResult['fileVault']> {
  const vault: CredentialVault = options.vault ?? defaultCredentialVault
  const ids = await vault.list()
  const existing = await credentials.list({ category: 'mcp-server', includeRevoked: true })
  const pairs = new Set(existing.map((item) => `${item.forConnector ?? ''}::${item.variableName ?? ''}`))
  const perConnector: CredentialBootMigrationResult['fileVault']['perConnector'][number][] = []
  const skippedRuntime: string[] = []
  for (const id of ids) {
    if (parseRuntimeCredentialId(id) !== null) {
      skippedRuntime.push(id)
      continue
    }
    const importedVars: string[] = []
    const skippedVars: string[] = []
    const errors: string[] = []
    let bundle: Awaited<ReturnType<CredentialVault['load']>>
    try { bundle = await vault.load(id) } catch { bundle = null; errors.push('load failed') }
    if (bundle === null) {
      if (errors.length === 0) errors.push('vault entry unavailable')
      perConnector.push({ connectorId: id, importedVars, skippedVars, errors, fileDeleted: false })
      continue
    }
    for (const [variableName, value] of Object.entries(bundle.env)) {
      const key = `${id}::${variableName}`
      if (pairs.has(key)) { skippedVars.push(variableName); continue }
      try {
        await credentials.save({
          name: `${id}: ${variableName}`, value, category: 'mcp-server', authType: 'api-key',
          variableName, forConnector: id, source: 'mcp-config',
        })
        pairs.add(key)
        importedVars.push(variableName)
      } catch { errors.push(variableName) }
    }
    let fileDeleted = false
    if (errors.length === 0 && options.deleteAfterImport !== false) {
      try { await vault.delete(id); fileDeleted = true } catch { errors.push('delete failed') }
    }
    perConnector.push({ connectorId: id, importedVars, skippedVars, errors, fileDeleted })
  }
  return { ran: true, perConnector, skippedRuntime }
}
