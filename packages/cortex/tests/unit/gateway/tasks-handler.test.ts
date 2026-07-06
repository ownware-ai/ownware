import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { SqliteTaskStore } from '../../../src/tasks/store.js'
import { TaskEventBus } from '../../../src/tasks/event-bus.js'
import { createTaskHandlers } from '../../../src/gateway/handlers/tasks.js'

let tmpDir: string
let db: CortexDatabase
let bus: TaskEventBus
let store: SqliteTaskStore

function seedThread(id = 'thread_h_1'): string {
  db.rawMainHandle.prepare(
    `INSERT INTO threads (id, profile_id, status, message_count, total_tokens, total_cost)
     VALUES (?, 'test', 'active', 0, 0, 0)`,
  ).run(id)
  return id
}

interface Captured {
  status: number
  body: unknown
}

function mockReq(urlSuffix = '', body?: unknown): IncomingMessage {
  const req = {
    url: `/api/v1/threads/thread_h_1/tasks${urlSuffix}`,
    headers: { host: 'localhost' },
    method: body == null ? 'GET' : 'PATCH',
    on: () => req,
  } as unknown as IncomingMessage
  if (body != null) {
    const chunks: Buffer[] = [Buffer.from(JSON.stringify(body))]
    let emitted = false
    ;(req as unknown as { on: (ev: string, cb: (...a: unknown[]) => void) => IncomingMessage }).on = (
      event: string,
      cb: (...a: unknown[]) => void,
    ) => {
      if (event === 'data' && !emitted) {
        emitted = true
        queueMicrotask(() => {
          for (const c of chunks) cb(c)
        })
      }
      if (event === 'end') {
        queueMicrotask(() => cb())
      }
      return req
    }
  }
  return req
}

function mockRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: null }
  const res = {
    writeHead(status: number) {
      captured.status = status
      return this
    },
    end(payload: string) {
      if (payload != null && payload.length > 0) {
        try {
          captured.body = JSON.parse(payload)
        } catch {
          captured.body = payload
        }
      }
    },
  } as unknown as ServerResponse
  return { res, captured }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-tasks-h-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  bus = new TaskEventBus()
  store = new SqliteTaskStore(db.rawMainHandle, bus)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('GET /api/v1/threads/:threadId/tasks', () => {
  it('returns { items: [] } for an empty thread', async () => {
    const threadId = seedThread()
    const handlers = createTaskHandlers({ store, bus })
    const { res, captured } = mockRes()
    await handlers.listTasks(mockReq(), res, { threadId })
    expect(captured.status).toBe(200)
    expect((captured.body as { items: unknown[] }).items).toEqual([])
  })

  it('returns populated items after replaceAll', async () => {
    const threadId = seedThread()
    store.replaceAllForThread(threadId, [
      { content: 'A', status: 'pending' },
      { content: 'B', status: 'in_progress' },
    ])
    const handlers = createTaskHandlers({ store, bus })
    const { res, captured } = mockRes()
    await handlers.listTasks(mockReq(), res, { threadId })
    expect(captured.status).toBe(200)
    const body = captured.body as { items: Array<{ content: string; order: number }> }
    expect(body.items).toHaveLength(2)
    expect(body.items[0]?.content).toBe('A')
    expect(body.items[0]?.order).toBe(0)
    expect(body.items[1]?.order).toBe(1)
  })

  it('returns 400 when threadId is missing', async () => {
    const handlers = createTaskHandlers({ store, bus })
    const { res, captured } = mockRes()
    await handlers.listTasks(mockReq(), res, {})
    expect(captured.status).toBe(400)
  })
})

describe('PATCH /api/v1/threads/:threadId/tasks/:taskId', () => {
  it('updates task status and returns the updated row', async () => {
    const threadId = seedThread()
    const [task] = store.replaceAllForThread(threadId, [
      { content: 'A', status: 'pending' },
    ])
    const handlers = createTaskHandlers({ store, bus })
    const { res, captured } = mockRes()
    await handlers.updateTaskStatus(
      mockReq(`/${task!.id}`, { status: 'completed' }),
      res,
      { threadId, taskId: task!.id },
    )
    // Wait a microtask for the async readJSON to resolve
    await Promise.resolve()
    await Promise.resolve()
    expect(captured.status).toBe(200)
    const body = captured.body as { task: { id: string; status: string } }
    expect(body.task.id).toBe(task!.id)
    expect(body.task.status).toBe('completed')
  })

  it('returns 400 for an invalid status', async () => {
    const threadId = seedThread()
    const [task] = store.replaceAllForThread(threadId, [
      { content: 'A', status: 'pending' },
    ])
    const handlers = createTaskHandlers({ store, bus })
    const { res, captured } = mockRes()
    await handlers.updateTaskStatus(
      mockReq(`/${task!.id}`, { status: 'nope' }),
      res,
      { threadId, taskId: task!.id },
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(captured.status).toBe(400)
  })

  it('returns 404 for a task that does not exist in this thread', async () => {
    const threadId = seedThread()
    const handlers = createTaskHandlers({ store, bus })
    const { res, captured } = mockRes()
    await handlers.updateTaskStatus(
      mockReq('/task_unknown', { status: 'completed' }),
      res,
      { threadId, taskId: 'task_unknown' },
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(captured.status).toBe(404)
  })
})
