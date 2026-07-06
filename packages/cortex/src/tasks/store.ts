/**
 * SqliteTaskStore — the SQLite-backed implementation of the Loom
 * `TaskStore` contract, plus a couple of read-side and user-mutation
 * helpers the HTTP layer needs.
 *
 * Per-thread semantics:
 *   - `replaceAllForThread(threadId, tasks)` atomically swaps the
 *     stored list for that thread. One transaction, one bus event.
 *   - `updateStatus(threadId, taskId, status)` flips a single row's
 *     status. Also emits a bus event so the SSE channel reflects
 *     the user's checkbox click.
 *   - `listForThread(threadId)` — read-only snapshot; no event.
 *
 * The Loom-facing adapter (`createThreadScopedTaskStore`) lives in
 * `scoped-store.ts` so the Loom integration seam is isolated and
 * testable. This file only owns SQL + bus plumbing.
 */

import type Database from 'better-sqlite3'
import type { TaskEventBus, TaskDto } from './event-bus.js'
import { TaskStatusSchema, type TaskStatusWire } from './event-bus.js'

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

interface TaskRow {
  readonly id: string
  readonly thread_id: string
  readonly content: string
  readonly status: string
  readonly list_order: number
  readonly created_at: string
  readonly updated_at: string
}

function rowToDto(row: TaskRow): TaskDto {
  return {
    id: row.id,
    threadId: row.thread_id,
    content: row.content,
    // SQL TEXT column is untyped at the DB layer; the enum is
    // enforced on write, so a parse() at read-time surfaces any
    // corruption loudly rather than silently mis-routing.
    status: TaskStatusSchema.parse(row.status),
    order: row.list_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function newTaskId(): string {
  return `task_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

// ---------------------------------------------------------------------------
// Public input shape (from Loom's `TaskStoreWriteInput`, duplicated
// here to avoid a direct import from the Loom package boundary).
// ---------------------------------------------------------------------------

export interface TaskReplaceInput {
  readonly content: string
  readonly status: TaskStatusWire
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class SqliteTaskStore {
  private readonly db: Database.Database
  private readonly bus: TaskEventBus

  constructor(db: Database.Database, bus: TaskEventBus) {
    this.db = db
    this.bus = bus
  }

  listForThread(threadId: string): TaskDto[] {
    if (threadId.length === 0) return []
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE thread_id = ? ORDER BY list_order ASC`,
    ).all(threadId) as TaskRow[]
    return rows.map(rowToDto)
  }

  /**
   * Atomically replace the entire task list for a thread. Returns the
   * stored list and emits a single `tasks.updated` bus event after
   * the transaction commits.
   */
  replaceAllForThread(
    threadId: string,
    tasks: ReadonlyArray<TaskReplaceInput>,
  ): TaskDto[] {
    if (threadId.length === 0) return []

    const now = new Date().toISOString()
    const deleteStmt = this.db.prepare(`DELETE FROM tasks WHERE thread_id = ?`)
    const insertStmt = this.db.prepare(
      `INSERT INTO tasks (id, thread_id, content, status, list_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )

    const txn = this.db.transaction((input: ReadonlyArray<TaskReplaceInput>) => {
      deleteStmt.run(threadId)
      const inserted: TaskDto[] = []
      for (let i = 0; i < input.length; i++) {
        const t = input[i]!
        const validated = TaskStatusSchema.parse(t.status)
        const id = newTaskId()
        insertStmt.run(id, threadId, t.content, validated, i, now, now)
        inserted.push({
          id,
          threadId,
          content: t.content,
          status: validated,
          order: i,
          createdAt: now,
          updatedAt: now,
        })
      }
      return inserted
    })

    const stored = txn(tasks)

    // Emit AFTER the transaction commits so subscribers never see a
    // list that rolled back. Only one event per call regardless of
    // list size.
    this.bus.emit({
      type: 'tasks.updated',
      threadId,
      tasks: stored,
      at: now,
    })

    return stored
  }

  /**
   * Update the status of a single task. Returns the updated DTO, or
   * null when the taskId does not belong to the given thread (prevents
   * cross-thread writes). Emits a `tasks.updated` event with the full
   * refreshed list on success.
   */
  updateStatus(
    threadId: string,
    taskId: string,
    status: TaskStatusWire,
  ): TaskDto | null {
    if (threadId.length === 0 || taskId.length === 0) return null
    const validated = TaskStatusSchema.parse(status)
    const now = new Date().toISOString()

    const existing = this.db.prepare(
      `SELECT * FROM tasks WHERE id = ? AND thread_id = ?`,
    ).get(taskId, threadId) as TaskRow | undefined

    if (!existing) return null

    this.db.prepare(
      `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND thread_id = ?`,
    ).run(validated, now, taskId, threadId)

    const refreshed = this.listForThread(threadId)
    const updated = refreshed.find((t) => t.id === taskId) ?? null
    if (updated == null) return null

    this.bus.emit({
      type: 'tasks.updated',
      threadId,
      tasks: refreshed,
      at: now,
    })

    return updated
  }
}
