/**
 * Credential audit log (board: credentials-unification — C28).
 *
 * Append-only event log for every security-relevant credential
 * interaction. The architectural rule (D7) requires audit writes to
 * be atomic with the work they record — for resolves that means the
 * INSERT runs in the SAME SQLite transaction as the
 * `credentials.lastUsedAt` update, so loom has no way to suppress
 * the write.
 *
 * Phase-5 scope:
 *   - The module + table land now (this file + migration 016).
 *   - `recordEvent` is wired from the validate + reveal handlers
 *     immediately, so those events are auditable from day 1.
 *   - The resolver-side audit (every loom resolve writes one row)
 *     waits for C22 (gateway resolver) to land. Until then there is
 *     no `resolve` event in the table — only the manually-triggered
 *     `validate` / `reveal` / `create` / `update` / `delete` events.
 *
 * Plaintext discipline: the value is NEVER written to this table.
 * The `detail` JSON column may carry context (host, scopes, error
 * reason) but never the credential's plaintext.
 */

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Event schema
// ---------------------------------------------------------------------------

export const CredentialAuditEventTypeSchema = z.enum([
  'create',
  'update',
  'delete',
  'reveal',
  'validate',
  'resolve',
  'approval_granted',
  'approval_denied',
])
export type CredentialAuditEventType = z.infer<typeof CredentialAuditEventTypeSchema>

/**
 * Outcomes recorded per event:
 *   - `ok`     — the operation succeeded normally.
 *   - `denied` — a gate refused the operation (trust-gate denial,
 *                spend-cap exceeded, expired credential).
 *   - `error`  — a runtime failure (provider 5xx, decrypt failure,
 *                user-input validation rejection).
 */
export const CredentialAuditOutcomeSchema = z.enum(['ok', 'denied', 'error'])
export type CredentialAuditOutcome = z.infer<typeof CredentialAuditOutcomeSchema>

/** Public row shape returned by every read helper. */
export const CredentialAuditEventSchema = z.object({
  id: z.string().min(1),
  credentialId: z.string().min(1),
  eventType: CredentialAuditEventTypeSchema,
  outcome: CredentialAuditOutcomeSchema,
  agentId: z.string().nullable(),
  sessionId: z.string().nullable(),
  threadId: z.string().nullable(),
  toolName: z.string().nullable(),
  host: z.string().nullable(),
  detail: z.record(z.unknown()).nullable(),
  estimatedCostUsd: z.number().nullable(),
  actualCostUsd: z.number().nullable(),
  createdAt: z.string().min(1),
})
export type CredentialAuditEvent = z.infer<typeof CredentialAuditEventSchema>

/**
 * Input shape for `recordEvent`. Module assigns `id` + `createdAt`;
 * caller supplies everything else. Optional fields default to NULL
 * in the DB column.
 */
export interface RecordEventInput {
  readonly credentialId: string
  readonly eventType: CredentialAuditEventType
  readonly outcome: CredentialAuditOutcome
  readonly agentId?: string
  readonly sessionId?: string
  readonly threadId?: string
  readonly toolName?: string
  readonly host?: string
  readonly detail?: Readonly<Record<string, unknown>>
  readonly estimatedCostUsd?: number
  readonly actualCostUsd?: number
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

interface AuditRow {
  id: string
  credential_id: string
  event_type: string
  outcome: string
  agent_id: string | null
  session_id: string | null
  thread_id: string | null
  tool_name: string | null
  host: string | null
  detail: string | null
  estimated_cost_usd: number | null
  actual_cost_usd: number | null
  created_at: string
}

function rowToEvent(row: AuditRow): CredentialAuditEvent {
  let detail: Record<string, unknown> | null = null
  if (row.detail !== null && row.detail.length > 0) {
    try { detail = JSON.parse(row.detail) as Record<string, unknown> }
    catch { detail = null }
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
    estimatedCostUsd: row.estimated_cost_usd,
    actualCostUsd: row.actual_cost_usd,
    createdAt: row.created_at,
  })
}

function makeAuditId(): string {
  return `caud_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

const INSERT_SQL = `
  INSERT INTO credential_audit_log (
    id, credential_id, event_type, outcome,
    agent_id, session_id, thread_id, tool_name, host,
    detail, estimated_cost_usd, actual_cost_usd, created_at
  ) VALUES (
    @id, @credential_id, @event_type, @outcome,
    @agent_id, @session_id, @thread_id, @tool_name, @host,
    @detail, @estimated_cost_usd, @actual_cost_usd, @created_at
  )
`

const SELECT_COLS = `
  id, credential_id, event_type, outcome, agent_id, session_id,
  thread_id, tool_name, host, detail, estimated_cost_usd,
  actual_cost_usd, created_at
`

/**
 * Append-only credential audit module. Construct against a raw
 * `Database.Database` handle — same convention as the credential
 * store backend.
 */
export class CredentialAuditLog {
  private readonly db: Database.Database
  private readonly stmtInsert: Database.Statement
  private readonly stmtListByCredential: Database.Statement
  private readonly stmtCountByCredential: Database.Statement

  constructor(db: Database.Database) {
    this.db = db
    this.stmtInsert = db.prepare(INSERT_SQL)
    this.stmtListByCredential = db.prepare(`
      SELECT ${SELECT_COLS}
      FROM credential_audit_log
      WHERE credential_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `)
    this.stmtCountByCredential = db.prepare(`
      SELECT COUNT(*) AS c FROM credential_audit_log WHERE credential_id = ?
    `)
  }

  /**
   * Append one event. Synchronous + atomic (single INSERT). Returns
   * the assigned id so callers can correlate with downstream logs.
   *
   * Failures throw — the caller (a handler or the resolver) is the
   * right place to decide whether to surface or swallow. The resolver
   * MUST treat a write failure as a hard fail per D7; handlers may
   * choose to log-and-continue for low-stakes events (e.g. an audit
   * write failing on a successful validate is annoying but not
   * security-relevant).
   */
  recordEvent(input: RecordEventInput): CredentialAuditEvent {
    const id = makeAuditId()
    const createdAt = new Date().toISOString()
    this.stmtInsert.run({
      id,
      credential_id: input.credentialId,
      event_type: input.eventType,
      outcome: input.outcome,
      agent_id: input.agentId ?? null,
      session_id: input.sessionId ?? null,
      thread_id: input.threadId ?? null,
      tool_name: input.toolName ?? null,
      host: input.host ?? null,
      detail: input.detail !== undefined ? JSON.stringify(input.detail) : null,
      estimated_cost_usd: input.estimatedCostUsd ?? null,
      actual_cost_usd: input.actualCostUsd ?? null,
      created_at: createdAt,
    })
    return CredentialAuditEventSchema.parse({
      id,
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
      createdAt,
    })
  }

  /**
   * Page through events for one credential, newest first. `limit` is
   * capped at 200 so pathological URL params can't OOM the response.
   */
  listEventsForCredential(
    credentialId: string,
    options: { readonly limit?: number; readonly offset?: number } = {},
  ): { readonly events: readonly CredentialAuditEvent[]; readonly total: number } {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
    const offset = Math.max(options.offset ?? 0, 0)
    const rows = this.stmtListByCredential.all(credentialId, limit, offset) as AuditRow[]
    const events = rows.map(rowToEvent)
    const total = (this.stmtCountByCredential.get(credentialId) as { c: number }).c
    return { events, total }
  }

  /**
   * Aggregate counts over a time window. Used by `GET /:id/usage`.
   * `groupBy` slices by `tool_name` (default) or `agent_id`.
   */
  aggregateUsage(
    credentialId: string,
    options: {
      readonly sinceIso?: string
      readonly groupBy?: 'tool_name' | 'agent_id'
    } = {},
  ): {
    readonly totalCalls: number
    readonly topConsumers: ReadonlyArray<{ readonly key: string; readonly count: number }>
    readonly windowStart: string | null
  } {
    const groupColumn = options.groupBy ?? 'tool_name'
    const since = options.sinceIso ?? null
    const params: unknown[] = [credentialId]
    let whereSince = ''
    if (since !== null) {
      whereSince = ' AND created_at >= ?'
      params.push(since)
    }

    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM credential_audit_log WHERE credential_id = ?${whereSince}`,
      )
      .get(...params) as { c: number }

    const consumerRows = this.db
      .prepare(
        `
          SELECT ${groupColumn} AS k, COUNT(*) AS c
          FROM credential_audit_log
          WHERE credential_id = ? AND ${groupColumn} IS NOT NULL${whereSince}
          GROUP BY ${groupColumn}
          ORDER BY c DESC
          LIMIT 10
        `,
      )
      .all(...params) as Array<{ k: string; c: number }>

    return {
      totalCalls: totalRow.c,
      topConsumers: consumerRows.map(r => ({ key: r.k, count: r.c })),
      windowStart: since,
    }
  }

  /**
   * Aggregate cost over a time window. Used by `GET /:id/cost`.
   * Returns daily buckets (UTC date string) plus the total.
   */
  aggregateCost(
    credentialId: string,
    options: { readonly sinceIso?: string } = {},
  ): {
    readonly totalEstimatedUsd: number
    readonly totalActualUsd: number
    readonly buckets: ReadonlyArray<{
      readonly date: string
      readonly estimatedUsd: number
      readonly actualUsd: number
      readonly calls: number
    }>
    readonly windowStart: string | null
  } {
    const since = options.sinceIso ?? null
    const params: unknown[] = [credentialId]
    let whereSince = ''
    if (since !== null) {
      whereSince = ' AND created_at >= ?'
      params.push(since)
    }
    // SQLite date-of-day bucket — works on ISO 8601 timestamps.
    const rows = this.db
      .prepare(
        `
          SELECT
            substr(created_at, 1, 10) AS d,
            COALESCE(SUM(estimated_cost_usd), 0) AS est,
            COALESCE(SUM(actual_cost_usd), 0) AS act,
            -- A post-flight cost true-up row (detail.trueUp) is an
            -- accounting entry, not a key issuance — exclude it from
            -- the "calls" tally so the count stays the real number of
            -- times the credential was used.
            SUM(CASE WHEN json_extract(detail, '$.trueUp') IS NOT NULL THEN 0 ELSE 1 END) AS calls
          FROM credential_audit_log
          WHERE credential_id = ?${whereSince}
          GROUP BY d
          ORDER BY d ASC
        `,
      )
      .all(...params) as Array<{ d: string; est: number; act: number; calls: number }>

    const totalEstimated = rows.reduce((s, r) => s + r.est, 0)
    const totalActual = rows.reduce((s, r) => s + r.act, 0)
    return {
      totalEstimatedUsd: totalEstimated,
      totalActualUsd: totalActual,
      buckets: rows.map(r => ({
        date: r.d,
        estimatedUsd: r.est,
        actualUsd: r.act,
        calls: r.calls,
      })),
      windowStart: since,
    }
  }
}
