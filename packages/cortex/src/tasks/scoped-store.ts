/**
 * createThreadScopedTaskStore — the Loom-facing adapter.
 *
 * Loom's `TaskStore` interface exposes `replaceAll(tasks)` with no
 * thread context. At session assembly time we know exactly which
 * thread the session is running on, so we wrap the SQLite store in
 * an object that pins the threadId. That wrapped object is what
 * goes into `LoomConfig.taskStore`.
 *
 * Kept in its own tiny file so the integration seam is obvious and
 * testable in isolation.
 */

import type { SqliteTaskStore, TaskReplaceInput } from './store.js'
import type { TaskStatusWire } from './event-bus.js'

// Matches Loom's `TaskStore` interface (duplicated here — we don't
// import from @ownware/loom because a runtime dependency on the
// engine isn't needed, only the structural shape).
export interface LoomTaskStoreShape {
  replaceAll(
    tasks: ReadonlyArray<{ readonly content: string; readonly status: TaskStatusWire }>,
  ): Promise<
    ReadonlyArray<{
      readonly id: string
      readonly content: string
      readonly status: TaskStatusWire
      readonly order: number
      readonly createdAt: string
      readonly updatedAt: string
    }>
  >
}

export function createThreadScopedTaskStore(
  store: SqliteTaskStore,
  threadId: string,
): LoomTaskStoreShape {
  return {
    async replaceAll(tasks) {
      const input: TaskReplaceInput[] = tasks.map((t) => ({
        content: t.content,
        status: t.status,
      }))
      const stored = store.replaceAllForThread(threadId, input)
      // Strip threadId — Loom's TaskEntry shape doesn't have it; the
      // Loom tool doesn't need to know which thread the store belongs
      // to. Keeps the boundary clean and the blob smaller.
      return stored.map((t) => ({
        id: t.id,
        content: t.content,
        status: t.status,
        order: t.order,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }))
    },
  }
}
