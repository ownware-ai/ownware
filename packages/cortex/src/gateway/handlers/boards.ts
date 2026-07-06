/**
 * Board HTTP + SSE handlers (Slice 3b).
 *
 *   GET   /api/v1/workspaces/:workspaceId/boards          → switcher list
 *   GET   /api/v1/boards/:boardId                         → full board
 *   POST  /api/v1/boards/:boardId/status                  → lifecycle (user)
 *   PATCH /api/v1/boards/:boardId/slices/:sliceId         → slice status (user)
 *   PATCH /api/v1/boards/:boardId/findings/:findingId     → finding status (user)
 *   GET   /api/v1/workspaces/:workspaceId/boards/events   → SSE (board.updated)
 *
 * The writer side is the `board_write` / `board_update` tools (Cortex,
 * injected per session). User-initiated mutations — the Approve / Resume /
 * Discard buttons, ticking a slice, resolving a finding — come through the
 * POST/PATCH routes here. Both paths emit `board.updated` via the
 * `BoardEventBus`; the SSE handler fans those out, filtered by workspace.
 *
 * Mirrors `handlers/tasks.ts`. SSE carries the full board snapshot per
 * event (parity with tasks); the workspace stream omits an initial dump —
 * clients fetch the list once over HTTP on connect, then live events drive
 * refetch/patch.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendError, sendJSON, readJSON } from '../router.js'
import { startSSE, writeSSE } from '../sse.js'
import type { SqliteBoardStore } from '../../boards/index.js'
import {
  BoardStatusSchema,
  SliceStatusSchema,
  FindingStatusSchema,
  type BoardEventBus,
  type BoardUpdatedEvent,
} from '../../boards/index.js'

const KEEPALIVE_INTERVAL_MS = 30_000

export interface BoardHandlerDeps {
  readonly store: SqliteBoardStore
  readonly bus: BoardEventBus
}

export function createBoardHandlers(deps: BoardHandlerDeps) {
  const { store, bus } = deps

  // GET /api/v1/workspaces/:workspaceId/boards
  async function listBoards(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const workspaceId = params['workspaceId']
    if (workspaceId == null || workspaceId.length === 0) {
      sendError(res, 400, 'Missing workspaceId')
      return
    }
    sendJSON(res, 200, { items: store.listForWorkspace(workspaceId) })
  }

  // GET /api/v1/boards/:boardId
  async function getBoard(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const boardId = params['boardId']
    if (boardId == null || boardId.length === 0) {
      sendError(res, 400, 'Missing boardId')
      return
    }
    const board = store.getById(boardId)
    if (board == null) {
      sendError(res, 404, `Board "${boardId}" not found`)
      return
    }
    sendJSON(res, 200, { board })
  }

  // POST /api/v1/boards/:boardId/status  { status }
  async function setBoardStatus(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const boardId = params['boardId']
    if (boardId == null || boardId.length === 0) {
      sendError(res, 400, 'Missing boardId')
      return
    }
    const body = await readJSON<{ status?: unknown }>(req)
    const parsed = BoardStatusSchema.safeParse(body?.status)
    if (!parsed.success) {
      sendError(res, 400, 'Invalid status: draft|awaiting|running|paused|done|archived.')
      return
    }
    const board = store.setBoardStatus(boardId, parsed.data)
    if (board == null) {
      sendError(res, 404, `Board "${boardId}" not found`)
      return
    }
    sendJSON(res, 200, { board })
  }

  // PATCH /api/v1/boards/:boardId/slices/:sliceId  { status }
  async function updateSlice(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const boardId = params['boardId']
    const sliceId = params['sliceId']
    if (boardId == null || sliceId == null) {
      sendError(res, 400, 'Missing boardId or sliceId')
      return
    }
    const body = await readJSON<{ status?: unknown }>(req)
    const parsed = SliceStatusSchema.safeParse(body?.status)
    if (!parsed.success) {
      sendError(res, 400, 'Invalid status: queued|running|done|failed|skipped.')
      return
    }
    const board = store.updateSliceStatus(boardId, sliceId, parsed.data)
    if (board == null) {
      sendError(res, 404, `Slice "${sliceId}" not found on board "${boardId}"`)
      return
    }
    sendJSON(res, 200, { board })
  }

  // PATCH /api/v1/boards/:boardId/findings/:findingId  { status }
  async function updateFinding(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const boardId = params['boardId']
    const findingId = params['findingId']
    if (boardId == null || findingId == null) {
      sendError(res, 400, 'Missing boardId or findingId')
      return
    }
    const body = await readJSON<{ status?: unknown }>(req)
    const parsed = FindingStatusSchema.safeParse(body?.status)
    if (!parsed.success) {
      sendError(res, 400, 'Invalid status: open|deferred|resolved.')
      return
    }
    const board = store.updateFindingStatus(boardId, findingId, parsed.data)
    if (board == null) {
      sendError(res, 404, `Finding "${findingId}" not found on board "${boardId}"`)
      return
    }
    sendJSON(res, 200, { board })
  }

  // GET /api/v1/workspaces/:workspaceId/boards/events  (SSE)
  async function streamBoardEvents(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const workspaceId = params['workspaceId']
    if (workspaceId == null || workspaceId.length === 0) {
      sendError(res, 400, 'Missing workspaceId')
      return
    }

    startSSE(res)
    res.write(':ready\n\n')

    const queue: BoardUpdatedEvent[] = []
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
      if (ev.workspaceId !== workspaceId) return
      queue.push(ev)
      void drain()
    })

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

  return {
    listBoards,
    getBoard,
    setBoardStatus,
    updateSlice,
    updateFinding,
    streamBoardEvents,
  }
}
