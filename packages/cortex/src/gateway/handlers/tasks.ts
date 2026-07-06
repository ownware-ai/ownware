/**
 * Tasks HTTP + SSE handlers (T03).
 *
 *   GET   /api/v1/threads/:threadId/tasks
 *   PATCH /api/v1/threads/:threadId/tasks/:taskId
 *   GET   /api/v1/threads/:threadId/tasks/events   (SSE)
 *
 * The writer side (the `todo_write` tool) lives in Loom; Cortex
 * injects a per-thread `TaskStore` adapter into the session config so
 * the tool calls land here. User-initiated mutations (the checkbox
 * toggle in the client's Tasks panel) go through PATCH.
 *
 * Both mutation paths emit a `tasks.updated` event via `TaskEventBus`;
 * the SSE handler fans those out to connected clients.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendError, sendJSON, readJSON } from '../router.js'
import { startSSE, writeSSE } from '../sse.js'
import type { SqliteTaskStore } from '../../tasks/store.js'
import type { TaskEventBus, TasksUpdatedEvent } from '../../tasks/event-bus.js'
import { TaskStatusSchema } from '../../tasks/event-bus.js'

const KEEPALIVE_INTERVAL_MS = 30_000

export interface TaskHandlerDeps {
  readonly store: SqliteTaskStore
  readonly bus: TaskEventBus
}

export function createTaskHandlers(deps: TaskHandlerDeps) {
  const { store, bus } = deps

  // GET /api/v1/threads/:threadId/tasks
  async function listTasks(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const threadId = params['threadId']
    if (threadId == null || threadId.length === 0) {
      sendError(res, 400, 'Missing threadId')
      return
    }
    const items = store.listForThread(threadId)
    sendJSON(res, 200, { items })
  }

  // PATCH /api/v1/threads/:threadId/tasks/:taskId
  async function updateTaskStatus(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const threadId = params['threadId']
    const taskId = params['taskId']
    if (threadId == null || taskId == null) {
      sendError(res, 400, 'Missing threadId or taskId')
      return
    }

    const body = await readJSON<{ status?: unknown }>(req)
    const parsed = TaskStatusSchema.safeParse(body?.status)
    if (!parsed.success) {
      sendError(
        res,
        400,
        'Invalid status: must be "pending", "in_progress", or "completed".',
      )
      return
    }

    const updated = store.updateStatus(threadId, taskId, parsed.data)
    if (updated == null) {
      sendError(res, 404, `Task "${taskId}" not found for thread "${threadId}"`)
      return
    }

    sendJSON(res, 200, { task: updated })
  }

  // GET /api/v1/threads/:threadId/tasks/events
  async function streamTaskEvents(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const threadId = params['threadId']
    if (threadId == null || threadId.length === 0) {
      sendError(res, 400, 'Missing threadId')
      return
    }

    startSSE(res)
    res.write(':ready\n\n')

    // Backpressure-aware queue. If the gateway is emitting faster than
    // the consumer reads, events stack up and drain whenever the next
    // `write()` succeeds. Same idiom used by connector-events.
    const queue: TasksUpdatedEvent[] = []
    let draining = false

    const drain = async (): Promise<void> => {
      if (draining) return
      draining = true
      try {
        while (queue.length > 0 && !res.writableEnded) {
          const ev = queue.shift()!
          await writeSSE(res, ev.type, ev)
        }
      } finally {
        draining = false
      }
    }

    const unsubscribe = bus.subscribe((ev) => {
      if (ev.threadId !== threadId) return
      queue.push(ev)
      void drain()
    })

    // Emit the current state up-front so late joiners don't miss the
    // most recent snapshot (parity with connector-events' behaviour).
    const initial: TasksUpdatedEvent = {
      type: 'tasks.updated',
      threadId,
      tasks: store.listForThread(threadId),
      at: new Date().toISOString(),
    }
    await writeSSE(res, initial.type, initial)

    const keepalive = setInterval(() => {
      if (res.writableEnded) return
      res.write(':ka\n\n')
    }, KEEPALIVE_INTERVAL_MS)

    const cleanup = (): void => {
      clearInterval(keepalive)
      unsubscribe()
      if (!res.writableEnded) res.end()
    }

    req.on('close', cleanup)
    req.on('error', cleanup)
  }

  return { listTasks, updateTaskStatus, streamTaskEvents }
}
