/**
 * SqliteScheduleStore — SQLite-backed CRUD + due-query + cursor-advance
 * for the per-profile scheduling vertical. Owns SQL only; the firing
 * engine (ScheduleRunner) and cadence math live in later slices.
 *
 * Construction mirrors `SqliteTaskStore`: it takes the raw better-sqlite3
 * handle (`db.rawMainHandle`). All instants are epoch milliseconds.
 *
 * Key invariant for the engine: `advance()` is the at-most-once cursor
 * write — durably move `next_run_at` forward BEFORE a run fires, so a
 * crash mid-run drops at most one occurrence instead of replaying.
 */

import type Database from 'better-sqlite3'
import {
  CadenceKindSchema,
  CatchUpPolicySchema,
  OverlapPolicySchema,
  DeliveryModeSchema,
  DEFAULT_DELIVERY_MODE,
  ScheduleStateSchema,
  RunStatusSchema,
  DeliveryStatusSchema,
  ScheduleDeliverToSchema,
  type ScheduleDto,
  type ScheduleDeliverTo,
  type CreateScheduleInput,
  type UpdateSchedulePatch,
  type AdvanceScheduleInput,
  type ScheduleRunDto,
  type RecentRunDto,
  type RecordRunInput,
  type UpdateRunPatch,
  type ToolEnvelope,
} from './types.js'
import { SafetyLevelSchema, DEFAULT_SAFETY_LEVEL } from './safety.js'

// ---------------------------------------------------------------------------
// Row shapes (snake_case, as stored)
// ---------------------------------------------------------------------------

interface ScheduleRow {
  readonly id: string
  readonly profile_id: string
  readonly workspace_id: string | null
  readonly name: string
  readonly prompt: string
  readonly model: string | null
  readonly cadence_kind: string
  readonly cadence_expr: string
  readonly cadence_display: string
  readonly timezone: string
  readonly catch_up_policy: string
  readonly catch_up_window_ms: number | null
  readonly overlap_policy: string
  readonly skip_weekends: number
  readonly skip_holidays: number
  readonly tool_envelope: string | null
  readonly safety_level: string
  readonly delivery_mode: string
  readonly quiet_on_empty: number
  readonly deliver_channel: string | null
  readonly deliver_target: string | null
  readonly enabled: number
  readonly state: string
  readonly next_run_at: number | null
  readonly last_run_at: number | null
  readonly last_run_id: string | null
  readonly created_at: number
  readonly updated_at: number
}

interface ScheduleRunRow {
  readonly id: string
  readonly schedule_id: string
  readonly thread_id: string | null
  readonly scheduled_for: number
  readonly started_at: number | null
  readonly finished_at: number | null
  readonly run_status: string
  readonly skip_reason: string | null
  readonly was_catch_up: number
  readonly error_category: string | null
  readonly error_message: string | null
  readonly delivery_status: string
  readonly idempotency_key: string | null
  readonly created_at: number
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function parseEnvelope(json: string | null): ToolEnvelope | null {
  if (json == null || json.length === 0) return null
  try {
    return JSON.parse(json) as ToolEnvelope
  } catch {
    // A corrupt envelope must not crash a list query; treat as "no
    // envelope" (the profile's normal policy applies) — the run-time
    // safety layer fails closed regardless.
    return null
  }
}

/** Both columns set → the pair; anything else (incl. a half-written pair) → null. */
function rowToDeliver(row: ScheduleRow): ScheduleDeliverTo | null {
  if (row.deliver_channel == null || row.deliver_target == null) return null
  const parsed = ScheduleDeliverToSchema.safeParse({
    channel: row.deliver_channel,
    target: row.deliver_target,
  })
  return parsed.success ? parsed.data : null
}

function rowToSchedule(row: ScheduleRow): ScheduleDto {
  return {
    id: row.id,
    profileId: row.profile_id,
    workspaceId: row.workspace_id,
    name: row.name,
    prompt: row.prompt,
    model: row.model,
    cadenceKind: CadenceKindSchema.parse(row.cadence_kind),
    cadenceExpr: row.cadence_expr,
    cadenceDisplay: row.cadence_display,
    timezone: row.timezone,
    catchUpPolicy: CatchUpPolicySchema.parse(row.catch_up_policy),
    catchUpWindowMs: row.catch_up_window_ms,
    overlapPolicy: OverlapPolicySchema.parse(row.overlap_policy),
    skipWeekends: row.skip_weekends === 1,
    skipHolidays: row.skip_holidays === 1,
    toolEnvelope: parseEnvelope(row.tool_envelope),
    safetyLevel: SafetyLevelSchema.parse(row.safety_level),
    deliveryMode: DeliveryModeSchema.parse(row.delivery_mode),
    quietOnEmpty: row.quiet_on_empty === 1,
    deliver: rowToDeliver(row),
    enabled: row.enabled === 1,
    state: ScheduleStateSchema.parse(row.state),
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunId: row.last_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToRun(row: ScheduleRunRow): ScheduleRunDto {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    threadId: row.thread_id,
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    runStatus: RunStatusSchema.parse(row.run_status),
    skipReason: row.skip_reason,
    wasCatchUp: row.was_catch_up === 1,
    errorCategory: row.error_category,
    errorMessage: row.error_message,
    deliveryStatus: DeliveryStatusSchema.parse(row.delivery_status),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  }
}

const bit = (b: boolean): number => (b ? 1 : 0)

function newScheduleId(): string {
  return `sched_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}
function newRunId(): string {
  return `srun_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class SqliteScheduleStore {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  // -- Schedules ------------------------------------------------------------

  create(input: CreateScheduleInput): ScheduleDto {
    // Enum inputs are validated here so a bad value can't reach SQL.
    const cadenceKind = CadenceKindSchema.parse(input.cadenceKind)
    const catchUpPolicy = CatchUpPolicySchema.parse(input.catchUpPolicy ?? 'catch-up')
    const overlapPolicy = OverlapPolicySchema.parse(input.overlapPolicy ?? 'skip-if-running')
    const safetyLevel = SafetyLevelSchema.parse(input.safetyLevel ?? DEFAULT_SAFETY_LEVEL)
    const deliveryMode = DeliveryModeSchema.parse(input.deliveryMode ?? DEFAULT_DELIVERY_MODE)
    const deliver = input.deliver != null ? ScheduleDeliverToSchema.parse(input.deliver) : null
    const id = newScheduleId()
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO schedules (
          id, profile_id, workspace_id, name, prompt, model,
          cadence_kind, cadence_expr, cadence_display, timezone,
          catch_up_policy, catch_up_window_ms, overlap_policy,
          skip_weekends, skip_holidays, tool_envelope, safety_level, delivery_mode, quiet_on_empty,
          deliver_channel, deliver_target,
          enabled, state, next_run_at, last_run_at, last_run_id,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?
        )`,
      )
      .run(
        id,
        input.profileId,
        input.workspaceId ?? null,
        input.name,
        input.prompt,
        input.model ?? null,
        cadenceKind,
        input.cadenceExpr,
        input.cadenceDisplay,
        input.timezone,
        catchUpPolicy,
        input.catchUpWindowMs ?? null,
        overlapPolicy,
        bit(input.skipWeekends ?? false),
        bit(input.skipHolidays ?? false),
        input.toolEnvelope != null ? JSON.stringify(input.toolEnvelope) : null,
        safetyLevel,
        deliveryMode,
        bit(input.quietOnEmpty ?? true),
        deliver?.channel ?? null,
        deliver?.target ?? null,
        bit(input.enabled ?? true),
        'scheduled',
        input.nextRunAt ?? null,
        null,
        null,
        now,
        now,
      )
    const created = this.get(id)
    if (created == null) {
      throw new Error(`schedules: insert succeeded but row ${id} not found`)
    }
    return created
  }

  get(id: string): ScheduleDto | null {
    const row = this.db
      .prepare(`SELECT * FROM schedules WHERE id = ?`)
      .get(id) as ScheduleRow | undefined
    return row != null ? rowToSchedule(row) : null
  }

  list(filter?: { readonly profileId?: string; readonly enabledOnly?: boolean }): ScheduleDto[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter?.profileId != null) {
      clauses.push(`profile_id = ?`)
      params.push(filter.profileId)
    }
    if (filter?.enabledOnly === true) {
      clauses.push(`enabled = 1`)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM schedules ${where} ORDER BY created_at DESC`)
      .all(...params) as ScheduleRow[]
    return rows.map(rowToSchedule)
  }

  /**
   * Schedules that are due now: enabled, with a concrete next_run_at at
   * or before `now`, oldest-due first. This is the engine's hot query
   * (index `idx_schedules_due`).
   */
  getDue(now: number): ScheduleDto[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM schedules
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC`,
      )
      .all(now) as ScheduleRow[]
    return rows.map(rowToSchedule)
  }

  /** Edit user-facing fields. Does NOT touch the engine cursor (use advance()). */
  update(id: string, patch: UpdateSchedulePatch): ScheduleDto | null {
    const cur = this.get(id)
    if (cur == null) return null
    const m = {
      name: patch.name ?? cur.name,
      prompt: patch.prompt ?? cur.prompt,
      model: patch.model !== undefined ? patch.model : cur.model,
      cadenceKind: CadenceKindSchema.parse(patch.cadenceKind ?? cur.cadenceKind),
      cadenceExpr: patch.cadenceExpr ?? cur.cadenceExpr,
      cadenceDisplay: patch.cadenceDisplay ?? cur.cadenceDisplay,
      timezone: patch.timezone ?? cur.timezone,
      catchUpPolicy: CatchUpPolicySchema.parse(patch.catchUpPolicy ?? cur.catchUpPolicy),
      catchUpWindowMs:
        patch.catchUpWindowMs !== undefined ? patch.catchUpWindowMs : cur.catchUpWindowMs,
      overlapPolicy: OverlapPolicySchema.parse(patch.overlapPolicy ?? cur.overlapPolicy),
      skipWeekends: patch.skipWeekends ?? cur.skipWeekends,
      skipHolidays: patch.skipHolidays ?? cur.skipHolidays,
      toolEnvelope: patch.toolEnvelope !== undefined ? patch.toolEnvelope : cur.toolEnvelope,
      safetyLevel: SafetyLevelSchema.parse(patch.safetyLevel ?? cur.safetyLevel),
      deliveryMode: DeliveryModeSchema.parse(patch.deliveryMode ?? cur.deliveryMode),
      quietOnEmpty: patch.quietOnEmpty ?? cur.quietOnEmpty,
      // `undefined` keeps the current pair; explicit `null` clears it.
      deliver:
        patch.deliver !== undefined
          ? patch.deliver != null
            ? ScheduleDeliverToSchema.parse(patch.deliver)
            : null
          : cur.deliver,
      enabled: patch.enabled ?? cur.enabled,
      state: ScheduleStateSchema.parse(patch.state ?? cur.state),
    }
    this.db
      .prepare(
        `UPDATE schedules SET
          name = ?, prompt = ?, model = ?,
          cadence_kind = ?, cadence_expr = ?, cadence_display = ?, timezone = ?,
          catch_up_policy = ?, catch_up_window_ms = ?, overlap_policy = ?,
          skip_weekends = ?, skip_holidays = ?, tool_envelope = ?, safety_level = ?,
          delivery_mode = ?, quiet_on_empty = ?, deliver_channel = ?, deliver_target = ?,
          enabled = ?, state = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        m.name,
        m.prompt,
        m.model,
        m.cadenceKind,
        m.cadenceExpr,
        m.cadenceDisplay,
        m.timezone,
        m.catchUpPolicy,
        m.catchUpWindowMs,
        m.overlapPolicy,
        bit(m.skipWeekends),
        bit(m.skipHolidays),
        m.toolEnvelope != null ? JSON.stringify(m.toolEnvelope) : null,
        m.safetyLevel,
        m.deliveryMode,
        bit(m.quietOnEmpty),
        m.deliver?.channel ?? null,
        m.deliver?.target ?? null,
        bit(m.enabled),
        m.state,
        Date.now(),
        id,
      )
    return this.get(id)
  }

  /** Pause/resume without deleting (the Active/Paused toggle). */
  setEnabled(id: string, enabled: boolean): ScheduleDto | null {
    return this.update(id, { enabled, state: enabled ? 'scheduled' : 'paused' })
  }

  /**
   * The at-most-once cursor write. Move next_run_at forward (and record
   * last_run_at / last_run_id / state) — call this BEFORE dispatching a run.
   */
  advance(id: string, input: AdvanceScheduleInput): ScheduleDto | null {
    const cur = this.get(id)
    if (cur == null) return null
    const state = input.state != null ? ScheduleStateSchema.parse(input.state) : cur.state
    this.db
      .prepare(
        `UPDATE schedules SET
          next_run_at = ?, last_run_at = ?, last_run_id = ?, state = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.nextRunAt,
        input.lastRunAt !== undefined ? input.lastRunAt : cur.lastRunAt,
        input.lastRunId !== undefined ? input.lastRunId : cur.lastRunId,
        state,
        Date.now(),
        id,
      )
    return this.get(id)
  }

  delete(id: string): boolean {
    // schedule_runs cascade-delete via the FK.
    const info = this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id)
    return info.changes > 0
  }

  /**
   * Atomically record a run AND advance the cursor in ONE transaction —
   * the at-most-once guarantee. A crash can't land between the two commits
   * and re-fire (or strand a half-written state). `lastRunId` is set to the
   * newly-created run so the overlap check sees the right run after restart.
   */
  recordRunAndAdvance(params: {
    readonly run: RecordRunInput
    readonly scheduleId: string
    readonly advance: Omit<AdvanceScheduleInput, 'lastRunId'>
  }): ScheduleRunDto {
    const txn = this.db.transaction((): ScheduleRunDto => {
      const run = this.recordRun(params.run)
      this.advance(params.scheduleId, { ...params.advance, lastRunId: run.id })
      return run
    })
    return txn()
  }

  // -- Runs (history ledger) ------------------------------------------------

  recordRun(input: RecordRunInput): ScheduleRunDto {
    const runStatus = RunStatusSchema.parse(input.runStatus)
    const deliveryStatus = DeliveryStatusSchema.parse(input.deliveryStatus ?? 'not-requested')
    const id = newRunId()
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO schedule_runs (
          id, schedule_id, thread_id, scheduled_for, started_at, finished_at,
          run_status, skip_reason, was_catch_up, error_category, error_message,
          delivery_status, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.scheduleId,
        input.threadId ?? null,
        input.scheduledFor,
        input.startedAt ?? null,
        input.finishedAt ?? null,
        runStatus,
        input.skipReason ?? null,
        bit(input.wasCatchUp ?? false),
        input.errorCategory ?? null,
        input.errorMessage ?? null,
        deliveryStatus,
        input.idempotencyKey ?? null,
        now,
      )
    const created = this.getRun(id)
    if (created == null) {
      throw new Error(`schedule_runs: insert succeeded but row ${id} not found`)
    }
    return created
  }

  getRun(id: string): ScheduleRunDto | null {
    const row = this.db
      .prepare(`SELECT * FROM schedule_runs WHERE id = ?`)
      .get(id) as ScheduleRunRow | undefined
    return row != null ? rowToRun(row) : null
  }

  updateRun(id: string, patch: UpdateRunPatch): ScheduleRunDto | null {
    const cur = this.getRun(id)
    if (cur == null) return null
    const m = {
      threadId: patch.threadId !== undefined ? patch.threadId : cur.threadId,
      startedAt: patch.startedAt !== undefined ? patch.startedAt : cur.startedAt,
      finishedAt: patch.finishedAt !== undefined ? patch.finishedAt : cur.finishedAt,
      runStatus: RunStatusSchema.parse(patch.runStatus ?? cur.runStatus),
      skipReason: patch.skipReason !== undefined ? patch.skipReason : cur.skipReason,
      errorCategory:
        patch.errorCategory !== undefined ? patch.errorCategory : cur.errorCategory,
      errorMessage: patch.errorMessage !== undefined ? patch.errorMessage : cur.errorMessage,
      deliveryStatus: DeliveryStatusSchema.parse(patch.deliveryStatus ?? cur.deliveryStatus),
    }
    this.db
      .prepare(
        `UPDATE schedule_runs SET
          thread_id = ?, started_at = ?, finished_at = ?, run_status = ?,
          skip_reason = ?, error_category = ?, error_message = ?, delivery_status = ?
         WHERE id = ?`,
      )
      .run(
        m.threadId,
        m.startedAt,
        m.finishedAt,
        m.runStatus,
        m.skipReason,
        m.errorCategory,
        m.errorMessage,
        m.deliveryStatus,
        id,
      )
    return this.getRun(id)
  }

  /**
   * Boot reconcile: any run left in 'running' (the process died mid-run)
   * is marked failed — it was interrupted, not silently fine (Principle 21).
   * Returns the number reconciled. Safe to call only at startup, when no
   * run is genuinely in flight.
   */
  failInterruptedRuns(now: number, message = 'Interrupted by restart'): number {
    const info = this.db
      .prepare(
        `UPDATE schedule_runs SET run_status = 'failed-to-run', error_message = ?, finished_at = ?
         WHERE run_status = 'running'`,
      )
      .run(message, now)
    return info.changes
  }

  /** Newest-first run history for a schedule (the timeline/list query). */
  listRuns(scheduleId: string, limit = 50): ScheduleRunDto[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM schedule_runs
         WHERE schedule_id = ?
         ORDER BY scheduled_for DESC
         LIMIT ?`,
      )
      .all(scheduleId, limit) as ScheduleRunRow[]
    return rows.map(rowToRun)
  }

  /** Recent runs ACROSS all schedules (newest first), each enriched with its
   *  schedule's name + profileId — the backbone for a cross-schedule agenda /
   *  "live now" strip. `runningOnly` narrows to in-flight runs. */
  listRecentRuns(limit = 50, opts: { readonly runningOnly?: boolean } = {}): RecentRunDto[] {
    const where = opts.runningOnly === true ? `WHERE r.run_status = 'running'` : ''
    const rows = this.db
      .prepare(
        `SELECT r.*, s.name AS schedule_name, s.profile_id AS schedule_profile_id
         FROM schedule_runs r
         JOIN schedules s ON s.id = r.schedule_id
         ${where}
         ORDER BY r.scheduled_for DESC
         LIMIT ?`,
      )
      .all(limit) as Array<ScheduleRunRow & { schedule_name: string; schedule_profile_id: string }>
    return rows.map((row) => ({
      ...rowToRun(row),
      scheduleName: row.schedule_name,
      profileId: row.schedule_profile_id,
    }))
  }
}
