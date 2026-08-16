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

import type { SqliteDatabase } from '../storage/sqlite-driver.js'
import {
  SCHEDULE_APPROVAL_INTENT_REVISION,
  scheduleApprovalOperationHash,
} from '../gateway/permission-intent.js'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Honest lifecycle — never a fake "fine". */
export const ApprovalStatusSchema = z.enum([
  'pending', // awaiting the user
  'executing', // exact action claimed; dispatch may already have happened
  'approved', // user approved AND the held action executed cleanly
  'discarded', // user dismissed it — never executed
  'failed', // user approved but executing the held action failed (8d)
  'indeterminate', // claimed, but completion could not be established safely
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
  /** Null only for historical terminal rows that predate exact binding. */
  readonly intentRevision: 1 | null
  /** Present once the one-shot dispatch fence has been acquired. */
  readonly claimedAt: number | null
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
  readonly policyRevision: string
  readonly toolRevision: string
  readonly targetRevision?: string | null
}

export interface DecideApprovalInput {
  readonly status: 'approved' | 'discarded' | 'failed' | 'indeterminate'
  readonly result?: unknown
  readonly errorMessage?: string | null
}

export interface ClaimedApproval extends ApprovalDto {
  readonly status: 'executing'
  readonly operationHash: string
  readonly policyRevision: string
  readonly toolRevision: string
  readonly targetRevision: string | null
}

export type ClaimApprovalResult =
  | { readonly status: 'claimed'; readonly approval: ClaimedApproval }
  | { readonly status: 'missing'; readonly approval: null }
  | {
      readonly status: 'not_pending' | 'already_claimed' | 'intent_mismatch'
      readonly approval: ApprovalDto
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
  readonly intent_revision: number | null
  readonly operation_hash: string | null
  readonly policy_revision: string | null
  readonly tool_revision: string | null
  readonly target_revision: string | null
  readonly claimed_at: number | null
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
    intentRevision: row.intent_revision === SCHEDULE_APPROVAL_INTENT_REVISION
      ? SCHEDULE_APPROVAL_INTENT_REVISION
      : null,
    claimedAt: row.claimed_at,
  }
}

function newApprovalId(): string {
  return `appr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class SqliteApprovalStore {
  private readonly db: SqliteDatabase

  constructor(db: SqliteDatabase) {
    this.db = db
  }

  /** Park a held tool call as a pending approval. */
  create(input: CreateApprovalInput): ApprovalDto {
    const id = newApprovalId()
    const now = Date.now()
    const threadId = input.threadId ?? null
    const operationHash = scheduleApprovalOperationHash({
      approvalId: id,
      scheduleId: input.scheduleId,
      runId: input.runId,
      threadId,
      toolName: input.toolName,
      toolInput: input.toolInput,
      policyRevision: input.policyRevision,
      toolRevision: input.toolRevision,
      targetRevision: input.targetRevision ?? null,
    })
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO schedule_approvals (
          id, schedule_id, run_id, thread_id, tool_name, tool_input,
          summary, status, result, error_message, created_at, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)`,
      )
      .run(
        id,
        input.scheduleId,
        input.runId,
        threadId,
        input.toolName,
        JSON.stringify(input.toolInput ?? null),
        input.summary,
        now,
      )
      this.db.prepare(`
        INSERT INTO schedule_approval_bindings (
          approval_id, intent_revision, operation_hash, policy_revision,
          tool_revision, target_revision, bound_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        SCHEDULE_APPROVAL_INTENT_REVISION,
        operationHash,
        input.policyRevision,
        input.toolRevision,
        input.targetRevision ?? null,
        now,
      )
    }).immediate()
    const created = this.get(id)
    if (created == null) {
      throw new Error(`schedule_approvals: insert succeeded but row ${id} not found`)
    }
    return created
  }

  get(id: string): ApprovalDto | null {
    const row = this.db
      .prepare(`
        SELECT approval.*, binding.intent_revision, binding.operation_hash,
          binding.policy_revision, binding.tool_revision,
          binding.target_revision, claim.claimed_at
        FROM schedule_approvals AS approval
        LEFT JOIN schedule_approval_bindings AS binding
          ON binding.approval_id = approval.id
        LEFT JOIN schedule_approval_claims AS claim
          ON claim.approval_id = approval.id
        WHERE approval.id = ?
      `)
      .get(id) as ApprovalRow | undefined
    return row != null ? rowToApproval(row) : null
  }

  /** All approvals produced by one run (newest first). */
  listByRun(runId: string): ApprovalDto[] {
    const rows = this.db
      .prepare(`
        SELECT approval.*, binding.intent_revision, binding.operation_hash,
          binding.policy_revision, binding.tool_revision,
          binding.target_revision, claim.claimed_at
        FROM schedule_approvals AS approval
        LEFT JOIN schedule_approval_bindings AS binding
          ON binding.approval_id = approval.id
        LEFT JOIN schedule_approval_claims AS claim
          ON claim.approval_id = approval.id
        WHERE approval.run_id = ? ORDER BY approval.created_at DESC
      `)
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
        `SELECT a.*, binding.intent_revision, binding.operation_hash,
           binding.policy_revision, binding.tool_revision,
           binding.target_revision, claim.claimed_at,
           s.name AS schedule_name, s.profile_id AS schedule_profile_id
         FROM schedule_approvals a
         JOIN schedules s ON s.id = a.schedule_id
         JOIN schedule_approval_bindings AS binding ON binding.approval_id = a.id
         LEFT JOIN schedule_approval_claims AS claim ON claim.approval_id = a.id
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

  /** Atomically acquire the durable one-shot dispatch fence. */
  claim(id: string, now: number = Date.now()): ClaimApprovalResult {
    return this.db.transaction((): ClaimApprovalResult => {
      const publicApproval = this.get(id)
      if (publicApproval == null) return { status: 'missing', approval: null }
      if (publicApproval.status === 'executing' || publicApproval.claimedAt !== null) {
        return { status: 'already_claimed', approval: publicApproval }
      }
      if (publicApproval.status !== 'pending') {
        return { status: 'not_pending', approval: publicApproval }
      }
      const row = this.db.prepare(`
        SELECT approval.*, binding.intent_revision, binding.operation_hash,
          binding.policy_revision, binding.tool_revision,
          binding.target_revision, claim.claimed_at
        FROM schedule_approvals AS approval
        LEFT JOIN schedule_approval_bindings AS binding
          ON binding.approval_id = approval.id
        LEFT JOIN schedule_approval_claims AS claim
          ON claim.approval_id = approval.id
        WHERE approval.id = ?
      `).get(id) as ApprovalRow
      let recomputed: string | null = null
      try {
        if (
          row.intent_revision === SCHEDULE_APPROVAL_INTENT_REVISION
          && row.operation_hash != null
          && row.policy_revision != null
          && row.tool_revision != null
        ) {
          recomputed = scheduleApprovalOperationHash({
            approvalId: row.id,
            scheduleId: row.schedule_id,
            runId: row.run_id,
            threadId: row.thread_id,
            toolName: row.tool_name,
            toolInput: parseJson(row.tool_input),
            policyRevision: row.policy_revision,
            toolRevision: row.tool_revision,
            targetRevision: row.target_revision,
          })
        }
      } catch {
        recomputed = null
      }
      if (recomputed === null || recomputed !== row.operation_hash) {
        this.db.prepare(`
          UPDATE schedule_approvals
          SET status = 'indeterminate',
              error_message = 'The stored approval identity no longer matches the reviewed action.',
              decided_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(now, id)
        return { status: 'intent_mismatch', approval: this.get(id)! }
      }
      this.db.prepare(`
        INSERT INTO schedule_approval_claims (approval_id, operation_hash, claimed_at)
        VALUES (?, ?, ?)
      `).run(id, row.operation_hash, now)
      const changed = this.db.prepare(`
        UPDATE schedule_approvals SET status = 'executing'
        WHERE id = ? AND status = 'pending'
      `).run(id)
      if (changed.changes !== 1) {
        throw new Error('Schedule approval claim lost its lifecycle transition')
      }
      const claimed = this.get(id)!
      return {
        status: 'claimed',
        approval: {
          ...claimed,
          status: 'executing',
          operationHash: row.operation_hash,
          policyRevision: row.policy_revision!,
          toolRevision: row.tool_revision!,
          targetRevision: row.target_revision,
        },
      }
    }).immediate()
  }

  /** Crash recovery never makes a claimed effect retryable. */
  recoverInterruptedClaims(now: number = Date.now()): number {
    return this.db.prepare(`
      UPDATE schedule_approvals
      SET status = 'indeterminate',
          error_message = COALESCE(
            error_message,
            'Ownware restarted after this action was claimed; its external effect is unknown.'
          ),
          decided_at = ?
      WHERE status = 'executing'
        AND EXISTS (
          SELECT 1 FROM schedule_approval_claims AS claim
          WHERE claim.approval_id = schedule_approvals.id
        )
    `).run(now).changes
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
    const status = z.enum(['approved', 'discarded', 'failed', 'indeterminate'])
      .parse(input.status)
    const expected = status === 'discarded' ? 'pending' : 'executing'
    if (cur.status !== expected) return cur // already decided / not the claimant
    this.db
      .prepare(
        `UPDATE schedule_approvals
         SET status = ?, result = ?, error_message = ?, decided_at = ?
         WHERE id = ? AND status = ?
           AND (
             ? = 'discarded'
             OR EXISTS (
               SELECT 1 FROM schedule_approval_claims AS claim
               WHERE claim.approval_id = schedule_approvals.id
             )
           )`,
      )
      .run(
        status,
        input.result !== undefined ? JSON.stringify(input.result) : null,
        input.errorMessage ?? null,
        Date.now(),
        id,
        expected,
        status,
      )
    return this.get(id)
  }
}
