import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { SqliteTaskStore } from '../../../src/tasks/store.js'
import { TaskEventBus, type TasksUpdatedEvent } from '../../../src/tasks/event-bus.js'
import { createThreadScopedTaskStore } from '../../../src/tasks/scoped-store.js'

let tmpDir: string
let db: CortexDatabase
let bus: TaskEventBus
let store: SqliteTaskStore

function seedThread(threadId = 'thread_test_1'): string {
  db.rawMainHandle.prepare(
    `INSERT INTO threads (id, profile_id, status, message_count, total_tokens, total_cost)
     VALUES (?, 'test', 'active', 0, 0, 0)`,
  ).run(threadId)
  return threadId
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-tasks-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  bus = new TaskEventBus()
  store = new SqliteTaskStore(db.rawMainHandle, bus)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('SqliteTaskStore', () => {
  it('migration 014 creates the tasks table with expected shape', () => {
    const info = db.rawMainHandle.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`,
    ).get() as { sql: string } | undefined
    expect(info).not.toBeUndefined()
    expect(info!.sql).toMatch(/thread_id/)
    expect(info!.sql).toMatch(/list_order/)
    expect(info!.sql).toMatch(/status/)
    expect(info!.sql).toMatch(/ON DELETE CASCADE/)
  })

  it('listForThread returns [] for an empty thread', () => {
    const threadId = seedThread()
    expect(store.listForThread(threadId)).toEqual([])
  })

  it('replaceAllForThread inserts rows and emits a single bus event', () => {
    const threadId = seedThread()
    const spy = vi.fn()
    bus.subscribe(spy)
    const result = store.replaceAllForThread(threadId, [
      { content: 'A', status: 'in_progress' },
      { content: 'B', status: 'pending' },
    ])
    expect(result).toHaveLength(2)
    expect(result[0]?.content).toBe('A')
    expect(result[0]?.order).toBe(0)
    expect(result[1]?.order).toBe(1)
    expect(spy).toHaveBeenCalledTimes(1)
    const ev = spy.mock.calls[0]?.[0] as TasksUpdatedEvent
    expect(ev.threadId).toBe(threadId)
    expect(ev.tasks).toHaveLength(2)
  })

  it('replaceAllForThread replaces existing rows atomically', () => {
    const threadId = seedThread()
    store.replaceAllForThread(threadId, [
      { content: 'A', status: 'pending' },
      { content: 'B', status: 'pending' },
    ])
    const v1 = store.listForThread(threadId)
    expect(v1).toHaveLength(2)
    const oldIds = v1.map((t) => t.id)

    store.replaceAllForThread(threadId, [
      { content: 'C', status: 'completed' },
    ])
    const v2 = store.listForThread(threadId)
    expect(v2).toHaveLength(1)
    expect(v2[0]?.content).toBe('C')
    expect(oldIds).not.toContain(v2[0]?.id)
  })

  it('replaceAllForThread([]) clears the list and emits', () => {
    const threadId = seedThread()
    store.replaceAllForThread(threadId, [{ content: 'A', status: 'pending' }])
    const spy = vi.fn()
    bus.subscribe(spy)
    store.replaceAllForThread(threadId, [])
    expect(store.listForThread(threadId)).toEqual([])
    expect(spy).toHaveBeenCalledTimes(1)
    expect((spy.mock.calls[0]?.[0] as TasksUpdatedEvent).tasks).toEqual([])
  })

  it('workspaces are isolated — replace on thread A does not touch thread B', () => {
    const a = seedThread('thread_a')
    const b = seedThread('thread_b')
    store.replaceAllForThread(a, [{ content: 'A', status: 'pending' }])
    store.replaceAllForThread(b, [
      { content: 'B1', status: 'pending' },
      { content: 'B2', status: 'in_progress' },
    ])
    expect(store.listForThread(a)).toHaveLength(1)
    expect(store.listForThread(b)).toHaveLength(2)
    store.replaceAllForThread(a, [])
    expect(store.listForThread(a)).toEqual([])
    expect(store.listForThread(b)).toHaveLength(2)
  })

  it('updateStatus updates only the target row and emits full list', () => {
    const threadId = seedThread()
    const inserted = store.replaceAllForThread(threadId, [
      { content: 'A', status: 'pending' },
      { content: 'B', status: 'pending' },
    ])
    const target = inserted[0]!
    const spy = vi.fn()
    bus.subscribe(spy)

    const updated = store.updateStatus(threadId, target.id, 'completed')
    expect(updated).not.toBeNull()
    expect(updated!.status).toBe('completed')
    expect(updated!.id).toBe(target.id)

    const list = store.listForThread(threadId)
    expect(list.find((t) => t.id === target.id)?.status).toBe('completed')
    expect(list.find((t) => t.id !== target.id)?.status).toBe('pending')
    expect(spy).toHaveBeenCalledTimes(1)
    expect((spy.mock.calls[0]?.[0] as TasksUpdatedEvent).tasks).toHaveLength(2)
  })

  it('updateStatus returns null for cross-thread task id (no event)', () => {
    const a = seedThread('thread_a')
    seedThread('thread_b')
    const [t] = store.replaceAllForThread(a, [{ content: 'A', status: 'pending' }])

    const spy = vi.fn()
    bus.subscribe(spy)
    const result = store.updateStatus('thread_b', t!.id, 'completed')
    expect(result).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('cascade: deleting the thread row wipes its tasks', () => {
    const threadId = seedThread()
    store.replaceAllForThread(threadId, [
      { content: 'A', status: 'pending' },
      { content: 'B', status: 'in_progress' },
    ])
    expect(store.listForThread(threadId)).toHaveLength(2)
    db.rawMainHandle.prepare(`DELETE FROM threads WHERE id = ?`).run(threadId)
    expect(store.listForThread(threadId)).toEqual([])
  })

  it('createThreadScopedTaskStore adapts the store to Loom\'s interface', async () => {
    const threadId = seedThread()
    const scoped = createThreadScopedTaskStore(store, threadId)
    const stored = await scoped.replaceAll([
      { content: 'One', status: 'in_progress' },
    ])
    expect(stored).toHaveLength(1)
    expect(stored[0]?.content).toBe('One')
    expect(stored[0]?.status).toBe('in_progress')
    expect(stored[0]).not.toHaveProperty('threadId') // Loom shape has no threadId
    expect(store.listForThread(threadId)).toHaveLength(1)
  })
})
