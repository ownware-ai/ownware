/**
 * Workspace management handlers.
 *
 * CRUD for workspaces (project folders) and workspace-scoped queries.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Dirent } from 'node:fs'
import { existsSync, mkdirSync, statSync, readdirSync, lstatSync } from 'node:fs'
import { basename, resolve, join, relative } from 'node:path'
import { homedir } from 'node:os'
import { sendJSON, sendError, readJSON } from '../router.js'
import type { GatewayState } from '../state.js'
import type { CreateWorkspaceRequest, UpdateWorkspaceRequest } from '../types.js'
import { listProducts, getDefaultProfileId } from '../../product/manifest.js'
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILE_TREE_DEFAULT_DEPTH = 3
const FILE_TREE_MAX_DEPTH = 5
const FILE_TREE_MAX_ENTRIES_PER_DIR = 1000
const FILE_TREE_SKIP = new Set(['.git', 'node_modules', '.next', 'dist', '.cache', '__pycache__', '.venv', '.tox'])

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

    // Seed `lastProfileId` from the product manifest so a brand-new workspace
    // opens on a real agent with zero client-side guessing. Without this the
    // field is null and every client must reinvent the "which agent do I land
    // on?" fallback — the gap that produced the client's hardcoded
    // `lastProfileId: 'ownware-code'`. The default product is the workspace's
    // first activeProduct (DB-defaulted to 'ownware'); its declared
    // defaultProfileId is the landing agent (manifest-driven, one source).
    const defaultProduct = ws.activeProducts[0] ?? listProducts()[0]?.slug
    const defaultProfileId =
      defaultProduct != null ? getDefaultProfileId(defaultProduct) : undefined
    const created =
      defaultProfileId != null
        ? (state.updateWorkspace(ws.id, { lastProfileId: defaultProfileId }) ?? ws)
        : ws

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

  // POST /api/v1/workspaces/browse — list directories for web file picker
  async function browse(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJSON<{ path?: string }>(req)
    const basePath = resolve((body?.path ?? homedir()).replace(/^~/, homedir()))

    if (!existsSync(basePath) || !statSync(basePath).isDirectory()) {
      sendError(res, 400, `Invalid directory: ${basePath}`)
      return
    }

    try {
      const entries = readdirSync(basePath, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          path: join(basePath, e.name),
          isGitRepo: existsSync(join(basePath, e.name, '.git')),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))

      sendJSON(res, 200, { path: basePath, parent: resolve(basePath, '..'), entries })
    } catch {
      sendError(res, 500, `Failed to read directory: ${basePath}`)
    }
  }

  // ── History (per-workspace thread list) ─────────────────────────────
  //
  // The legacy /workspaces/:id/tabs surface was removed in slice 1b.9
  // (migration 025 dropped the workspace_tabs table). Tab management
  // is now expressed as workspace_panes of kind='chat' in the tabs
  // zone, served by /workspaces/:id/panes (handlers/panes.ts).
  // History below is the only surviving non-pane workspace endpoint —
  // it joins workspace_panes to flag which threads are currently
  // open in a chat pane.

  // GET /api/v1/workspaces/:workspaceId/history?search=&limit=&offset=
  //
  // Every thread ever created in this workspace. Each entry carries `hasOpenTab` + `openTabId`
  // so the history drawer can render "Reopen" for closed threads
  // and "Focus" (activate the existing tab) for open ones.
  async function listHistory(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = params['workspaceId']!
    const ws = state.getWorkspace(wsId)
    if (!ws) {
      sendError(res, 404, `Workspace "${wsId}" not found`)
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const search = url.searchParams.get('search') ?? undefined
    const limitRaw = url.searchParams.get('limit')
    const offsetRaw = url.searchParams.get('offset')
    const opts: { search?: string; limit?: number; offset?: number } = {}
    if (search !== undefined && search.trim().length > 0) opts.search = search
    if (limitRaw !== null) {
      const limit = Number.parseInt(limitRaw, 10)
      if (Number.isFinite(limit) && limit > 0) opts.limit = limit
    }
    if (offsetRaw !== null) {
      const offset = Number.parseInt(offsetRaw, 10)
      if (Number.isFinite(offset) && offset >= 0) opts.offset = offset
    }

    sendJSON(res, 200, state.listWorkspaceHistory(wsId, opts))
  }

  // GET /api/v1/workspaces/:workspaceId/files?depth=3
  async function listFiles(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const wsId = params['workspaceId']!
    const ws = state.getWorkspace(wsId)
    if (!ws) {
      sendError(res, 404, `Workspace "${wsId}" not found`)
      return
    }

    if (!existsSync(ws.path)) {
      sendError(res, 410, `Workspace path no longer exists: ${ws.path}`)
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const depth = Math.min(
      parseInt(url.searchParams.get('depth') ?? String(FILE_TREE_DEFAULT_DEPTH), 10) || FILE_TREE_DEFAULT_DEPTH,
      FILE_TREE_MAX_DEPTH,
    )

    const entries = buildFileTree(ws.path, ws.path, depth)
    sendJSON(res, 200, { path: ws.path, entries })
  }

  return {
    list, create, get, update, remove,
    listThreads, browse,
    listHistory,
    listFiles,
  }
}

// ---------------------------------------------------------------------------
// File tree builder
// ---------------------------------------------------------------------------

interface FileEntry {
  readonly name: string
  readonly path: string
  readonly type: 'file' | 'directory'
  readonly size?: number
  readonly modifiedAt?: string
  readonly children?: readonly FileEntry[]
}

function buildFileTree(rootPath: string, currentPath: string, depth: number): FileEntry[] {
  if (depth <= 0) return []

  let entries: Dirent[]
  try {
    entries = readdirSync(currentPath, { withFileTypes: true }) as Dirent[]
  } catch {
    return []
  }

  const result: FileEntry[] = []
  let count = 0

  // Sort: directories first, then alphabetical
  const sorted = entries
    .filter(e => !e.name.startsWith('.') && !FILE_TREE_SKIP.has(e.name))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })

  for (const entry of sorted) {
    if (count >= FILE_TREE_MAX_ENTRIES_PER_DIR) break
    count++

    const fullPath = join(currentPath, entry.name)
    const relPath = relative(rootPath, fullPath)

    if (entry.isDirectory()) {
      const children = depth > 1 ? buildFileTree(rootPath, fullPath, depth - 1) : undefined
      result.push({
        name: entry.name,
        path: relPath,
        type: 'directory',
        children,
      })
    } else {
      try {
        const stat = lstatSync(fullPath)
        result.push({
          name: entry.name,
          path: relPath,
          type: 'file',
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        })
      } catch {
        result.push({ name: entry.name, path: relPath, type: 'file' })
      }
    }
  }

  return result
}
