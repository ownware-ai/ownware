/**
 * Workspace management handlers.
 *
 * CRUD for workspaces (project folders) and workspace-scoped queries.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { sendJSON, sendError, readJSON } from '../router.js'
import type { GatewayState } from '../state.js'
import type { CreateWorkspaceRequest, UpdateWorkspaceRequest } from '../types.js'
import {
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
} from '../schemas/workspace.js'
import type { TerminalSessionRegistry } from '../../terminal/session-registry.js'
import type { WorkspaceEventBus } from '../workspace-event-bus.js'
// (workspace tab schemas removed in slice 1b.9 — workspace_tabs was
// dropped in migration 025; the canonical pane store is workspace_panes.)

export interface WorkspaceHandlerDeps {
  /**
   * When provided, `DELETE /workspaces/:id` also kills every live
   * PTY (agent + user) for the workspace before removing the DB
   * row. Without this wire, the PTYs would leak until the gateway
   * restarts.
   */
  readonly terminalRegistry?: TerminalSessionRegistry
  /**
   * Fan-out bus for workspace CRUD events (audit #2 C2 / F1a,
   * 2026-05-16). When provided, the handlers emit a
   * `workspace.changed` event on every successful create / update /
   * archive / delete so SSE subscribers can invalidate their caches
   * without polling.
   *
   * Optional so the dozens of existing unit tests that don't care
   * about live events keep compiling. Production wiring in
   * `server.ts` always passes a real bus.
   */
  readonly eventBus?: WorkspaceEventBus
}

export function createWorkspaceHandlers(
  state: GatewayState,
  deps: WorkspaceHandlerDeps = {},
) {
  const eventBus = deps.eventBus

  // GET /api/v1/workspaces?status=active
  async function list(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const status = url.searchParams.get('status') as 'active' | 'archived' | null
    sendJSON(res, 200, state.listWorkspaces(status ?? undefined))
  }

  // POST /api/v1/workspaces
  async function create(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readJSON<CreateWorkspaceRequest>(req)
    const parsed = CreateWorkspaceRequestSchema.safeParse(raw)
    if (!parsed.success) {
      sendError(res, 400, parsed.error.issues[0]?.message ?? 'Invalid workspace request')
      return
    }
    const body = parsed.data

    // Resolve and validate path
    const absPath = resolve(body.path.replace(/^~/, homedir()))
    if (!existsSync(absPath)) {
      if (body.create === true) {
        try {
          mkdirSync(absPath, { recursive: true })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          sendError(res, 400, `Could not create workspace path "${absPath}": ${message}`)
          return
        }
      } else {
        sendError(res, 400, `Path does not exist: ${absPath}`)
        return
      }
    }
    if (!statSync(absPath).isDirectory()) {
      sendError(res, 400, `Path is not a directory: ${absPath}`)
      return
    }

    // Check for duplicate
    const existing = state.getWorkspaceByPath(absPath)
    if (existing) {
      // Reactivate if archived, otherwise return existing
      if (existing.status === 'archived') {
        const updated = state.updateWorkspace(existing.id, { status: 'active' })
        state.touchWorkspace(existing.id)
        // Audit #2 C2 / F1a: reactivation is a state transition out
        // of archived — surface it so subscribers re-fetch the list.
        eventBus?.emit({ workspaceId: existing.id, action: 'updated' })
        sendJSON(res, 200, updated)
        return
      }
      // No state transition — the row was already active. `touchWorkspace`
      // bumps lastOpenedAt but the list query doesn't sort on that, so
      // we intentionally do NOT emit here. Emitting would cause every
      // window-focus refetch to thrash the cache.
      state.touchWorkspace(existing.id)
      sendJSON(res, 200, existing)
      return
    }

    const name = body.name ?? basename(absPath)
    const ws = state.createWorkspace(absPath, name)

    // (The product-manifest-driven default-profile stamp was removed with
    // the legacy product catalog.)
    const created = ws

    // Fan-out hint AFTER the row is durable. Invalidate-only — payload
    // never carries the workspace's writable data. Audit #2 C2 / F1a.
    eventBus?.emit({ workspaceId: ws.id, action: 'created' })
    sendJSON(res, 201, created)
  }

  // GET /api/v1/workspaces/:workspaceId
  async function get(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const id = params['workspaceId']!
    const detail = state.getWorkspaceDetail(id)
    if (!detail) {
      sendError(res, 404, `Workspace "${id}" not found`)
      return
    }
    state.touchWorkspace(id)
    sendJSON(res, 200, detail)
  }

  // PUT /api/v1/workspaces/:workspaceId
  async function update(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const id = params['workspaceId']!
    const raw = await readJSON<UpdateWorkspaceRequest>(req)
    if (!raw) {
      sendError(res, 400, 'Request body required')
      return
    }
    // Declarative validation at the boundary. `activeProducts`, when present,
    // must be a non-empty array of KNOWN product slugs — an empty array bricks
    // landing routing; an unknown slug would orphan the workspace.
    const parsed = UpdateWorkspaceRequestSchema.safeParse(raw)
    if (!parsed.success) {
      sendError(res, 400, parsed.error.issues[0]?.message ?? 'Invalid workspace update')
      return
    }
    const body = parsed.data

    const updated = state.updateWorkspace(id, body)
    if (!updated) {
      sendError(res, 404, `Workspace "${id}" not found`)
      return
    }
    // Emit AFTER the DB write so the bus only fires on durable
    // state. `archived` is split out from `updated` because the client's
    // workspace picker may want to drop the row from the active list
    // without waiting for the refetch (Chunk #19 / F1a). Other status
    // transitions (e.g. `archived → active`) and non-status edits
    // collapse to `updated`.
    const action = updated.status === 'archived' ? 'archived' : 'updated'
    eventBus?.emit({ workspaceId: id, action })
    sendJSON(res, 200, updated)
  }

  // DELETE /api/v1/workspaces/:workspaceId
  async function remove(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const id = params['workspaceId']!
    // Kill every live PTY for the workspace BEFORE deleting the DB
    // row. Reversing this ordering would orphan PTYs whenever the
    // DB delete succeeded but the kill throws. `dropWorkspace` is
    // a no-op when no PTYs exist, so this is safe to always call.
    try {
      deps.terminalRegistry?.dropWorkspace(id)
    } catch (err) {
      // Never block the delete on PTY-kill failure — log and
      // proceed. The next gateway restart will sweep any
      // stragglers via `shutdown()`.
      // eslint-disable-next-line no-console
      console.warn(`[workspaces] dropWorkspace(${id}) threw:`, err)
    }
    const deleted = state.deleteWorkspace(id)
    if (!deleted) {
      sendError(res, 404, `Workspace "${id}" not found`)
      return
    }
    // Audit #2 C2 / F1a: emit AFTER the row is gone. Subscribers
    // re-fetch and the deleted id falls off every active list.
    eventBus?.emit({ workspaceId: id, action: 'deleted' })
    res.writeHead(204)
    res.end()
  }

  // GET /api/v1/workspaces/:workspaceId/threads
  async function listThreads(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const id = params['workspaceId']!
    const ws = state.getWorkspace(id)
    if (!ws) {
      sendError(res, 404, `Workspace "${id}" not found`)
      return
    }
    sendJSON(res, 200, state.listThreadsByWorkspace(id))
  }

  // (The desktop-only browse / history / file-tree endpoints were removed
  // with the legacy desktop shell.)

  return {
    list, create, get, update, remove,
    listThreads,
  }
}
