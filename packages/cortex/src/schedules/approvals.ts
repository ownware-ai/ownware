/**
 * Approvals — held actions from a draft-for-approval scheduled run.
 *
 * Its OWN vertical (Principle 22): a `schedule_approvals` table, never columns
 * on `schedules` / `schedule_runs` / `threads`. When a 'draft-approval' run
 * tries a write/send tool, the hold pipeline (Slice 8d) parks the call HERE as
 * a `pending` row instead of executing it; the user approves → it executes
 * (8d), or discards → it's dropped. The cross-agent "Approvals" inbox reads
 * `listPending()` (joined to `schedules` for the agent identity).
 *
 * This file is pure CRUD + typed boundary. The execute-on-approve orchestration
 * lives in the runner/service (8d) — the store only records state. All instants
 * are epoch milliseconds; enums are re-parsed on read so a corrupt row surfaces
 * loudly (same discipline as the schedules store).
 */

import type Database from 'better-sqlite3'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Honest lifecycle — never a fake "fine". */
export const ApprovalStatusSchema = z.enum([
  'pending', // awaiting the user
  'approved', // user approved AND the held action executed cleanly
  'discarded', // user dismissed it — never executed
  'failed', // user approved but executing the held action failed (8d)
])
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>

export interface ApprovalDto {
  readonly id: string
  readonly scheduleId: string
  readonly runId: string
  readonly threadId: string | null
  /** The held tool, e.g. 'gmail_send' / 'writeFile'. */
  readonly toolName: string
  /** The held call's arguments — the draft (email body, file content, …). */
  readonly toolInput: unknown
  /** Human one-liner for the inbox row, e.g. "Email to dana@acme.com — Re: …". */
  readonly summary: string
  readonly status: ApprovalStatus
  /** Tool result once approved + executed (8d). NULL until then. */
  readonly result: unknown | null
  readonly errorMessage: string | null
  readonly createdAt: number
  readonly decidedAt: number | null
}

/** An approval enriched with its schedule's display fields — so the cross-agent
 *  inbox renders (agent avatar + name) without N extra lookups. */
export interface PendingApprovalDto extends ApprovalDto {
  readonly scheduleName: string
  readonly profileId: string
}

export interface CreateApprovalInput {
  readonly scheduleId: string
  readonly runId: string
  readonly threadId?: string | null
  readonly toolName: string
  readonly toolInput: unknown
  readonly summary: string
}

export interface DecideApprovalInput {
  readonly status: ApprovalStatus
  readonly result?: unknown
  readonly errorMessage?: string | null
}

// ---------------------------------------------------------------------------
// Row shape (snake_case, as stored)
// ---------------------------------------------------------------------------

interface ApprovalRow {
  readonly id: string
  readonly schedule_id: string
  readonly run_id: string
  readonly thread_id: string | null
  readonly tool_name: string
  readonly tool_input: string
  readonly summary: string
  readonly status: string
  readonly result: string | null
  readonly error_message: string | null
  readonly created_at: number
  readonly decided_at: number | null
}

function parseJson(json: string | null): unknown {
  if (json == null || json.length === 0) return null
  try {
    return JSON.parse(json)
  } catch {
    // A corrupt blob must not crash the inbox query; surface it as a string so
    // the user still sees *something* rather than a hard failure.
    return json
  }
}

function rowToApproval(row: ApprovalRow): ApprovalDto {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    runId: row.run_id,
    threadId: row.thread_id,
    toolName: row.tool_name,
    toolInput: parseJson(row.tool_input),
    summary: row.summary,
    status: ApprovalStatusSchema.parse(row.status),
    result: parseJson(row.result),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  }
}

function newApprovalId(): string {
  return `appr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class SqliteApprovalStore {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  /** Park a held tool call as a pending approval. */
  create(input: CreateApprovalInput): ApprovalDto {
    const id = newApprovalId()
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO schedule_approvals (
          id, schedule_id, run_id, thread_id, tool_name, tool_input,
          summary, status, result, error_message, created_at, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)`,
      )
      .run(
        id,
        input.scheduleId,
        input.runId,
        input.threadId ?? null,
        input.toolName,
        JSON.stringify(input.toolInput ?? null),
        input.summary,
        now,
      )
    const created = this.get(id)
    if (created == null) {
      throw new Error(`schedule_approvals: insert succeeded but row ${id} not found`)
    }
    return created
  }

  get(id: string): ApprovalDto | null {
    const row = this.db
      .prepare(`SELECT * FROM schedule_approvals WHERE id = ?`)
      .get(id) as ApprovalRow | undefined
    return row != null ? rowToApproval(row) : null
  }

  /** All approvals produced by one run (newest first). */
  listByRun(runId: string): ApprovalDto[] {
    const rows = this.db
      .prepare(`SELECT * FROM schedule_approvals WHERE run_id = ? ORDER BY created_at DESC`)
      .all(runId) as ApprovalRow[]
    return rows.map(rowToApproval)
  }

  /**
   * The cross-agent inbox: pending approvals across ALL schedules, newest
   * first, each enriched with its schedule's name + profileId. `profileId`
   * narrows to one agent (the per-agent filter).
   */
  listPending(opts: { readonly profileId?: string; readonly limit?: number } = {}): PendingApprovalDto[] {
    const clauses = [`a.status = 'pending'`]
    const params: unknown[] = []
    if (opts.profileId != null) {
      clauses.push(`s.profile_id = ?`)
      params.push(opts.profileId)
    }
    const limit = opts.limit != null && opts.limit > 0 ? Math.min(opts.limit, 500) : 200
    const rows = this.db
      .prepare(
        `SELECT a.*, s.name AS schedule_name, s.profile_id AS schedule_profile_id
         FROM schedule_approvals a
         JOIN schedules s ON s.id = a.schedule_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY a.created_at DESC
         LIMIT ?`,
      )
      .all(...params, limit) as Array<ApprovalRow & { schedule_name: string; schedule_profile_id: string }>
    return rows.map((row) => ({
      ...rowToApproval(row),
      scheduleName: row.schedule_name,
      profileId: row.schedule_profile_id,
    }))
  }

  /** Count of pending approvals — the sidebar/dock badge (optionally per agent). */
  countPending(profileId?: string): number {
    if (profileId != null) {
      const r = this.db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM schedule_approvals a JOIN schedules s ON s.id = a.schedule_id
           WHERE a.status = 'pending' AND s.profile_id = ?`,
        )
        .get(profileId) as { n: number }
      return r.n
    }
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM schedule_approvals WHERE status = 'pending'`)
      .get() as { n: number }
    return r.n
  }

  /** Pending approvals parked by ONE run — lets the scheduler classify a run
   *  that held drafts as `needs-approval` rather than a bare success (8d). */
  countPendingForRun(runId: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM schedule_approvals WHERE run_id = ? AND status = 'pending'`)
      .get(runId) as { n: number }
    return r.n
  }

  /**
   * Record a decision: approve / discard / fail. Stamps `decided_at` and
   * optionally the execution result or error (set by the 8d execute step).
   * Only transitions a still-pending row (idempotent — a second decide on an
   * already-decided approval is a no-op returning the current row).
   */
  decide(id: string, input: DecideApprovalInput): ApprovalDto | null {
    const cur = this.get(id)
    if (cur == null) return null
    if (cur.status !== 'pending') return cur // already decided — don't re-stamp
    const status = ApprovalStatusSchema.parse(input.status)
    this.db
      .prepare(
        `UPDATE schedule_approvals
         SET status = ?, result = ?, error_message = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(
        status,
        input.result !== undefined ? JSON.stringify(input.result) : null,
        input.errorMessage ?? null,
        Date.now(),
        id,
      )
    return this.get(id)
  }
}
