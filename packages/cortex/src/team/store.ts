/**
 * TeamStore — SQLite persistence for the team vertical.
 *
 * Owns all SQL over the `team_*` tables (migration 035). Construction
 * follows the gateway's shared-handle pattern (SqliteTaskStore,
 * ConnectorConnectionsStore): one better-sqlite3 handle, prepared
 * statements per call, synchronous throughout.
 *
 * The store is the writer-discipline enforcement point (L3):
 *   - `setTaskStatus` is the ONLY status writer and validates every
 *     transition against TASK_STATUS_TRANSITIONS — an illegal
 *     transition throws (kernel bug, fail loudly).
 *   - `completeTask` checks the caller IS the task's owner.
 *   - structure mutations (`assignTask`, `updateTaskStructure`) are
 *     reached only through the Conductor's board_write tool.
 */

import type Database from 'better-sqlite3'
import {
  TASK_STATUS_TRANSITIONS,
  TEAM_TASK_STATUSES,
  type CreateTeamInput,
  type Team,
  type TeamConductorEscalation,
  type TeamMember,
  type TeamMemberAutonomy,
  type TeamLease,
  type TeamRun,
  type TeamRunReceipt,
  type TeamRunStatus,
  type TeamTask,
  type TeamTaskKind,
  type TeamTaskStatus,
  type UpdateTeamInput,
} from './schema.js'

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface TeamRow {
  readonly id: string
  readonly name: string
  readonly display_name: string
  readonly charter: string
  readonly charter_identity: string | null
  readonly charter_principles: string | null
  readonly charter_workflow: string | null
  readonly charter_done_means: string | null
  readonly charter_rules: string | null
  readonly charter_voice: string | null
  readonly conductor_name: string
  readonly conductor_model: string | null
  readonly conductor_escalation: string
  readonly conductor_instructions: string | null
  readonly surface: string
  readonly max_cost_usd: number | null
  readonly created_at: string
  readonly updated_at: string
}

interface TeamMemberRow {
  readonly team_id: string
  readonly slug: string
  readonly profile_id: string
  readonly role: string
  readonly instructions: string | null
  readonly model: string | null
  readonly autonomy: string
  readonly tool_restricts: string
  readonly position: number
}

interface TeamReferenceRow {
  readonly team_id: string
  readonly position: number
  readonly name: string
  readonly content: string
}

interface TeamConnectorRow {
  readonly team_id: string
  readonly position: number
  readonly toolkit: string
}

interface TeamRunRow {
  readonly id: string
  readonly team_id: string
  readonly thread_id: string
  readonly workspace_id: string | null
  readonly status: string
  readonly cost_usd: number
  readonly max_cost_usd: number | null
  readonly receipt: string | null
  readonly created_at: string
  readonly updated_at: string
}

interface TeamLeaseRow {
  readonly run_id: string
  readonly resource_key: string
  readonly task_id: string
  readonly agent_id: string
  readonly last_activity_at: string
}

function leaseRowToLease(row: TeamLeaseRow): TeamLease {
  return {
    runId: row.run_id,
    resourceKey: row.resource_key,
    taskId: row.task_id,
    agentId: row.agent_id,
    lastActivityAt: row.last_activity_at,
  }
}

interface TeamTaskRow {
  readonly id: string
  readonly run_id: string
  readonly seq: number
  readonly parent_id: string | null
  readonly kind: string
  readonly title: string
  readonly brief: string
  readonly done_criteria: string
  readonly deliverables: string
  readonly depends_on: string
  readonly owner: string | null
  readonly filed_by: string
  readonly resource_hints: string
  readonly status: string
  readonly result: string | null
  readonly blocked_reason: string | null
  readonly created_at: string
  readonly updated_at: string
}

function parseStringArray(json: string, column: string): readonly string[] {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
    throw new Error(`team_tasks.${column} is corrupted: expected a JSON string array, got ${json}`)
  }
  return parsed as string[]
}

function assertTaskStatus(value: string): TeamTaskStatus {
  if ((TEAM_TASK_STATUSES as readonly string[]).includes(value)) {
    return value as TeamTaskStatus
  }
  throw new Error(`team_tasks.status is corrupted: "${value}"`)
}

function rowToTask(row: TeamTaskRow): TeamTask {
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    parentId: row.parent_id,
    kind: row.kind as TeamTaskKind,
    title: row.title,
    brief: row.brief,
    doneCriteria: row.done_criteria,
    deliverables: parseStringArray(row.deliverables, 'deliverables'),
    dependsOn: parseStringArray(row.depends_on, 'depends_on'),
    owner: row.owner,
    filedBy: row.filed_by,
    resourceHints: parseStringArray(row.resource_hints, 'resource_hints'),
    status: assertTaskStatus(row.status),
    result: row.result,
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToRun(row: TeamRunRow): TeamRun {
  return {
    id: row.id,
    teamId: row.team_id,
    threadId: row.thread_id,
    workspaceId: row.workspace_id,
    status: row.status as TeamRunStatus,
    costUsd: row.cost_usd,
    maxCostUsd: row.max_cost_usd,
    receipt: row.receipt !== null ? (JSON.parse(row.receipt) as TeamRunReceipt) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function memberRowToMember(row: TeamMemberRow): TeamMember {
  return {
    slug: row.slug,
    profileId: row.profile_id,
    role: row.role,
    ...(row.instructions !== null ? { instructions: row.instructions } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    autonomy: (row.autonomy as TeamMemberAutonomy) ?? 'inherit',
    toolRestricts: [...parseStringArray(row.tool_restricts, 'tool_restricts')],
  }
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function now(): string {
  return new Date().toISOString()
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface InsertTaskInput {
  readonly kind: TeamTaskKind
  readonly title: string
  readonly brief: string
  readonly doneCriteria?: string
  readonly deliverables?: readonly string[]
  readonly dependsOn?: readonly string[]
  readonly owner?: string | null
  readonly filedBy: string
  readonly resourceHints?: readonly string[]
  readonly parentId?: string | null
  /** Initial status. Defaults to 'ready'. */
  readonly status?: TeamTaskStatus
}

export interface UpdateTaskStructureInput {
  readonly title?: string
  readonly brief?: string
  readonly doneCriteria?: string
  readonly deliverables?: readonly string[]
  readonly dependsOn?: readonly string[]
  readonly resourceHints?: readonly string[]
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class TeamStore {
  constructor(private readonly db: Database.Database) {}

  // ── Teams ────────────────────────────────────────────────────────

  createTeam(input: CreateTeamInput): Team {
    const id = newId('team')
    const ts = now()
    const insertTeam = this.db.prepare(
      `INSERT INTO teams (
         id, name, display_name, charter,
         charter_identity, charter_principles, charter_workflow,
         charter_done_means, charter_rules, charter_voice,
         conductor_name, conductor_model, conductor_escalation,
         conductor_instructions, surface, max_cost_usd, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertMember = this.db.prepare(
      `INSERT INTO team_members (team_id, slug, profile_id, role, instructions, model, autonomy, tool_restricts, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertReference = this.db.prepare(
      `INSERT INTO team_references (team_id, position, name, content) VALUES (?, ?, ?, ?)`,
    )
    const insertConnector = this.db.prepare(
      `INSERT INTO team_connectors (team_id, position, toolkit) VALUES (?, ?, ?)`,
    )
    this.db.transaction(() => {
      insertTeam.run(
        id,
        input.name,
        input.displayName,
        input.charter,
        input.fragments?.identity ?? null,
        input.fragments?.principles ?? null,
        input.fragments?.workflow ?? null,
        input.fragments?.doneMeans ?? null,
        input.fragments?.rules ?? null,
        input.fragments?.voice ?? null,
        input.conductorName,
        input.conductorModel ?? null,
        input.conductorEscalation ?? 'balanced',
        input.conductorInstructions ?? null,
        input.surface ?? 'ownware',
        input.maxCostUsd ?? null,
        ts,
        ts,
      )
      input.members.forEach((m, i) => {
        insertMember.run(
          id,
          m.slug,
          m.profileId,
          m.role,
          m.instructions ?? null,
          m.model ?? null,
          m.autonomy ?? 'inherit',
          JSON.stringify(m.toolRestricts ?? []),
          i,
        )
      })
      ;(input.references ?? []).forEach((r, i) => {
        insertReference.run(id, i, r.name, r.content)
      })
      ;(input.composioToolkits ?? []).forEach((t, i) => {
        insertConnector.run(id, i, t)
      })
    })()
    const team = this.getTeam(id)
    if (!team) throw new Error(`Team "${id}" vanished immediately after insert`)
    return team
  }

  getTeam(id: string): Team | null {
    const row = this.db.prepare(`SELECT * FROM teams WHERE id = ?`).get(id) as TeamRow | undefined
    if (!row) return null
    return this.hydrateTeam(row)
  }

  getTeamByName(name: string): Team | null {
    const row = this.db.prepare(`SELECT * FROM teams WHERE name = ?`).get(name) as TeamRow | undefined
    if (!row) return null
    return this.hydrateTeam(row)
  }

  listTeams(): Team[] {
    const rows = this.db.prepare(`SELECT * FROM teams ORDER BY updated_at DESC`).all() as TeamRow[]
    return rows.map((r) => this.hydrateTeam(r))
  }

  updateTeam(id: string, input: UpdateTeamInput): Team | null {
    const existing = this.getTeam(id)
    if (!existing) return null
    const ts = now()
    this.db.transaction(() => {
      const fragments = input.fragments ?? existing.fragments
      this.db
        .prepare(
          `UPDATE teams SET display_name = ?, charter = ?,
             charter_identity = ?, charter_principles = ?, charter_workflow = ?,
             charter_done_means = ?, charter_rules = ?, charter_voice = ?,
             conductor_name = ?, conductor_model = ?,
             conductor_escalation = ?, conductor_instructions = ?,
             surface = ?, max_cost_usd = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.displayName ?? existing.displayName,
          input.charter ?? existing.charter,
          fragments.identity ?? null,
          fragments.principles ?? null,
          fragments.workflow ?? null,
          fragments.doneMeans ?? null,
          fragments.rules ?? null,
          fragments.voice ?? null,
          input.conductorName ?? existing.conductorName,
          input.conductorModel === undefined ? existing.conductorModel : input.conductorModel,
          input.conductorEscalation ?? existing.conductorEscalation,
          input.conductorInstructions === undefined
            ? existing.conductorInstructions
            : input.conductorInstructions,
          input.surface ?? existing.surface,
          input.maxCostUsd === undefined ? existing.maxCostUsd : input.maxCostUsd,
          ts,
          id,
        )
      if (input.members !== undefined) {
        this.db.prepare(`DELETE FROM team_members WHERE team_id = ?`).run(id)
        const insertMember = this.db.prepare(
          `INSERT INTO team_members (team_id, slug, profile_id, role, instructions, model, autonomy, tool_restricts, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        input.members.forEach((m, i) => {
          insertMember.run(
          id,
          m.slug,
          m.profileId,
          m.role,
          m.instructions ?? null,
          m.model ?? null,
          m.autonomy ?? 'inherit',
          JSON.stringify(m.toolRestricts ?? []),
          i,
        )
        })
      }
      if (input.references !== undefined) {
        this.db.prepare(`DELETE FROM team_references WHERE team_id = ?`).run(id)
        const insertReference = this.db.prepare(
          `INSERT INTO team_references (team_id, position, name, content) VALUES (?, ?, ?, ?)`,
        )
        input.references.forEach((r, i) => {
          insertReference.run(id, i, r.name, r.content)
        })
      }
      if (input.composioToolkits !== undefined) {
        this.db.prepare(`DELETE FROM team_connectors WHERE team_id = ?`).run(id)
        const insertConnector = this.db.prepare(
          `INSERT INTO team_connectors (team_id, position, toolkit) VALUES (?, ?, ?)`,
        )
        input.composioToolkits.forEach((t, i) => {
          insertConnector.run(id, i, t)
        })
      }
    })()
    return this.getTeam(id)
  }

  deleteTeam(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM teams WHERE id = ?`).run(id)
    return result.changes > 0
  }

  private hydrateTeam(row: TeamRow): Team {
    const memberRows = this.db
      .prepare(`SELECT * FROM team_members WHERE team_id = ? ORDER BY position ASC`)
      .all(row.id) as TeamMemberRow[]
    const referenceRows = this.db
      .prepare(`SELECT * FROM team_references WHERE team_id = ? ORDER BY position ASC`)
      .all(row.id) as TeamReferenceRow[]
    const connectorRows = this.db
      .prepare(`SELECT * FROM team_connectors WHERE team_id = ? ORDER BY position ASC`)
      .all(row.id) as TeamConnectorRow[]
    return {
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      charter: row.charter,
      fragments: {
        ...(row.charter_identity !== null ? { identity: row.charter_identity } : {}),
        ...(row.charter_principles !== null ? { principles: row.charter_principles } : {}),
        ...(row.charter_workflow !== null ? { workflow: row.charter_workflow } : {}),
        ...(row.charter_done_means !== null ? { doneMeans: row.charter_done_means } : {}),
        ...(row.charter_rules !== null ? { rules: row.charter_rules } : {}),
        ...(row.charter_voice !== null ? { voice: row.charter_voice } : {}),
      },
      conductorName: row.conductor_name,
      conductorModel: row.conductor_model,
      conductorEscalation: (row.conductor_escalation as TeamConductorEscalation) ?? 'balanced',
      conductorInstructions: row.conductor_instructions,
      surface: row.surface ?? 'ownware',
      references: referenceRows.map((r) => ({ name: r.name, content: r.content })),
      composioToolkits: connectorRows.map((c) => c.toolkit),
      maxCostUsd: row.max_cost_usd,
      members: memberRows.map(memberRowToMember),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  // ── Runs ─────────────────────────────────────────────────────────

  createRun(teamId: string, threadId: string, workspaceId: string | null): TeamRun {
    const team = this.getTeam(teamId)
    if (!team) throw new Error(`Cannot create a run for unknown team "${teamId}"`)
    const id = newId('teamrun')
    const ts = now()
    this.db
      .prepare(
        `INSERT INTO team_runs (id, team_id, thread_id, workspace_id, status, cost_usd, max_cost_usd, receipt, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 0, ?, NULL, ?, ?)`,
      )
      .run(id, teamId, threadId, workspaceId, team.maxCostUsd, ts, ts)
    const run = this.getRun(id)
    if (!run) throw new Error(`Team run "${id}" vanished immediately after insert`)
    return run
  }

  /** Raise/lower the run's budget cap (Conductor's set_budget, post-user-approval). */
  setRunBudget(id: string, maxCostUsd: number | null): void {
    const result = this.db
      .prepare(`UPDATE team_runs SET max_cost_usd = ?, updated_at = ? WHERE id = ?`)
      .run(maxCostUsd, now(), id)
    if (result.changes === 0) {
      throw new Error(`Cannot set budget on unknown team run "${id}"`)
    }
  }

  getRun(id: string): TeamRun | null {
    const row = this.db.prepare(`SELECT * FROM team_runs WHERE id = ?`).get(id) as TeamRunRow | undefined
    return row ? rowToRun(row) : null
  }

  getRunByThread(threadId: string): TeamRun | null {
    const row = this.db.prepare(`SELECT * FROM team_runs WHERE thread_id = ?`).get(threadId) as
      | TeamRunRow
      | undefined
    return row ? rowToRun(row) : null
  }

  listRunsForTeam(teamId: string): TeamRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM team_runs WHERE team_id = ? ORDER BY updated_at DESC`)
      .all(teamId) as TeamRunRow[]
    return rows.map(rowToRun)
  }

  listActiveRuns(): TeamRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM team_runs WHERE status = 'active' ORDER BY created_at ASC`)
      .all() as TeamRunRow[]
    return rows.map(rowToRun)
  }

  setRunStatus(id: string, status: TeamRunStatus, receipt: TeamRunReceipt | null): void {
    const result = this.db
      .prepare(`UPDATE team_runs SET status = ?, receipt = ?, updated_at = ? WHERE id = ?`)
      .run(status, receipt !== null ? JSON.stringify(receipt) : null, now(), id)
    if (result.changes === 0) {
      throw new Error(`Cannot set status on unknown team run "${id}"`)
    }
  }

  addRunCost(id: string, costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return
    this.db
      .prepare(`UPDATE team_runs SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?`)
      .run(costUsd, now(), id)
  }

  // ── Tasks (the Board) ────────────────────────────────────────────

  insertTask(runId: string, input: InsertTaskInput): TeamTask {
    const id = newId('tt')
    const ts = now()
    const insert = this.db.prepare(
      `INSERT INTO team_tasks (
         id, run_id, seq, parent_id, kind, title, brief, done_criteria,
         deliverables, depends_on, owner, filed_by, resource_hints,
         status, result, blocked_reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    this.db.transaction(() => {
      const seqRow = this.db
        .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM team_tasks WHERE run_id = ?`)
        .get(runId) as { next: number }
      insert.run(
        id,
        runId,
        seqRow.next,
        input.parentId ?? null,
        input.kind,
        input.title,
        input.brief,
        input.doneCriteria ?? '',
        JSON.stringify(input.deliverables ?? []),
        JSON.stringify(input.dependsOn ?? []),
        input.owner ?? null,
        input.filedBy,
        JSON.stringify(input.resourceHints ?? []),
        input.status ?? 'ready',
        ts,
        ts,
      )
    })()
    const task = this.getTask(id)
    if (!task) throw new Error(`Team task "${id}" vanished immediately after insert`)
    return task
  }

  getTask(id: string): TeamTask | null {
    const row = this.db.prepare(`SELECT * FROM team_tasks WHERE id = ?`).get(id) as
      | TeamTaskRow
      | undefined
    return row ? rowToTask(row) : null
  }

  /** Resolve a human "T<seq>" reference within a run. */
  getTaskBySeq(runId: string, seq: number): TeamTask | null {
    const row = this.db
      .prepare(`SELECT * FROM team_tasks WHERE run_id = ? AND seq = ?`)
      .get(runId, seq) as TeamTaskRow | undefined
    return row ? rowToTask(row) : null
  }

  listTasks(runId: string): TeamTask[] {
    const rows = this.db
      .prepare(`SELECT * FROM team_tasks WHERE run_id = ? ORDER BY seq ASC`)
      .all(runId) as TeamTaskRow[]
    return rows.map(rowToTask)
  }

  /**
   * THE single status writer (L3). Validates the transition; illegal
   * moves throw — they are kernel bugs, never coerced silently.
   *
   * Leaving 'active' releases every lease the task holds (D8: leases
   * are task-scoped) — this is the one chokepoint every transition
   * funnels through, so a completed/failed/blocked/cancelled task can
   * never squat on a resource.
   */
  setTaskStatus(id: string, status: TeamTaskStatus, blockedReason?: string | null): TeamTask {
    const task = this.getTask(id)
    if (!task) throw new Error(`Cannot set status on unknown team task "${id}"`)
    if (task.status === status) return task
    const legal = TASK_STATUS_TRANSITIONS[task.status]
    if (!legal.includes(status)) {
      throw new Error(
        `Illegal task status transition ${task.status} → ${status} on T${task.seq} ("${task.title}")`,
      )
    }
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE team_tasks SET status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?`)
        .run(status, blockedReason ?? null, now(), id)
      if (task.status === 'active') {
        this.db.prepare(`DELETE FROM team_leases WHERE task_id = ?`).run(id)
      }
    })()
    const updated = this.getTask(id)
    if (!updated) throw new Error(`Team task "${id}" vanished during status update`)
    return updated
  }

  /**
   * Owner-only completion (L3): writes `result`, then moves the status
   * through the kernel's own writer. Throws when the caller is not the
   * task's owner.
   */
  completeTask(callerSlug: string, id: string, result: string): TeamTask {
    const task = this.getTask(id)
    if (!task) throw new Error(`Cannot complete unknown team task "${id}"`)
    if (task.owner !== callerSlug) {
      throw new Error(
        `"${callerSlug}" cannot complete T${task.seq} — it belongs to "${task.owner ?? 'nobody'}"`,
      )
    }
    if (task.status !== 'active') {
      throw new Error(`Cannot complete T${task.seq} from status "${task.status}" — it is not active`)
    }
    this.db
      .prepare(`UPDATE team_tasks SET result = ?, updated_at = ? WHERE id = ?`)
      .run(result, now(), id)
    return this.setTaskStatus(id, 'done')
  }

  /** Conductor-only: assign / reassign an owner. */
  assignTask(id: string, owner: string): TeamTask {
    const task = this.getTask(id)
    if (!task) throw new Error(`Cannot assign unknown team task "${id}"`)
    this.db
      .prepare(`UPDATE team_tasks SET owner = ?, updated_at = ? WHERE id = ?`)
      .run(owner, now(), id)
    const updated = this.getTask(id)
    if (!updated) throw new Error(`Team task "${id}" vanished during assignment`)
    return updated
  }

  /** Conductor-only: structure edits. Never touches status/result/owner. */
  updateTaskStructure(id: string, input: UpdateTaskStructureInput): TeamTask {
    const task = this.getTask(id)
    if (!task) throw new Error(`Cannot update unknown team task "${id}"`)
    this.db
      .prepare(
        `UPDATE team_tasks SET title = ?, brief = ?, done_criteria = ?, deliverables = ?, depends_on = ?, resource_hints = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.title ?? task.title,
        input.brief ?? task.brief,
        input.doneCriteria ?? task.doneCriteria,
        JSON.stringify(input.deliverables ?? task.deliverables),
        JSON.stringify(input.dependsOn ?? task.dependsOn),
        JSON.stringify(input.resourceHints ?? task.resourceHints),
        now(),
        id,
      )
    const updated = this.getTask(id)
    if (!updated) throw new Error(`Team task "${id}" vanished during update`)
    return updated
  }

  // ── Leases (D7/D8 — single writer per resource, task-scoped) ─────

  /**
   * Atomic check-and-acquire. ONE synchronous transaction so two
   * concurrent members can never both pass the check — better-sqlite3
   * serializes on the single connection; the gate is a guarantee, not
   * a heuristic.
   *
   * Returns `{ acquired: true }` when the caller's TASK now holds (or
   * already held) the key — re-entrant per task, and a renewed
   * heartbeat. Returns the current holder otherwise.
   */
  acquireLease(params: {
    readonly runId: string
    readonly resourceKey: string
    readonly taskId: string
    readonly agentId: string
  }): { readonly acquired: true } | { readonly acquired: false; readonly holder: TeamLease } {
    const { runId, resourceKey, taskId, agentId } = params
    let result: { acquired: true } | { acquired: false; holder: TeamLease } = { acquired: true }
    this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT * FROM team_leases WHERE run_id = ? AND resource_key = ?`)
        .get(runId, resourceKey) as TeamLeaseRow | undefined
      if (row && row.task_id !== taskId) {
        result = { acquired: false, holder: leaseRowToLease(row) }
        return
      }
      if (row) {
        this.db
          .prepare(`UPDATE team_leases SET last_activity_at = ? WHERE run_id = ? AND resource_key = ?`)
          .run(now(), runId, resourceKey)
      } else {
        this.db
          .prepare(
            `INSERT INTO team_leases (run_id, resource_key, task_id, agent_id, last_activity_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(runId, resourceKey, taskId, agentId, now())
      }
      result = { acquired: true }
    })()
    return result
  }

  /** Heartbeat (D8): any tool call by an agent renews all its leases. */
  renewLeasesForAgent(runId: string, agentId: string): void {
    this.db
      .prepare(`UPDATE team_leases SET last_activity_at = ? WHERE run_id = ? AND agent_id = ?`)
      .run(now(), runId, agentId)
  }

  listLeases(runId: string): TeamLease[] {
    const rows = this.db
      .prepare(`SELECT * FROM team_leases WHERE run_id = ? ORDER BY resource_key ASC`)
      .all(runId) as TeamLeaseRow[]
    return rows.map(leaseRowToLease)
  }

  /** Kernel: write an answer onto a question task and close it. */
  answerQuestion(id: string, answer: string): TeamTask {
    const task = this.getTask(id)
    if (!task) throw new Error(`Cannot answer unknown team task "${id}"`)
    if (task.kind !== 'question') {
      throw new Error(`T${task.seq} is a ${task.kind} task, not a question`)
    }
    if (task.status !== 'ready' && task.status !== 'active') {
      throw new Error(`Cannot answer T${task.seq} from status "${task.status}"`)
    }
    this.db
      .prepare(`UPDATE team_tasks SET result = ?, updated_at = ? WHERE id = ?`)
      .run(answer, now(), id)
    return this.setTaskStatus(id, 'done')
  }
}
