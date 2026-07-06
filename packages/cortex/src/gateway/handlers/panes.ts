/**
 * Workspace pane handlers.
 *
 * The wire layer over slice 1a.2's `CortexDatabase` workspace_panes
 * CRUD. Pairs with `gateway/types.ts` (request/response shapes) and
 * `gateway/validation/schemas.ts` (Zod validators).
 *
 * Routes (registered in server.ts):
 *
 *   GET    /api/v1/workspaces/:workspaceId/panes
 *   POST   /api/v1/workspaces/:workspaceId/panes
 *   PATCH  /api/v1/workspaces/:workspaceId/panes/:paneId
 *   DELETE /api/v1/workspaces/:workspaceId/panes/:paneId
 *   PUT    /api/v1/workspaces/:workspaceId/panes        ← reorder
 *   GET    /api/v1/workspaces/:workspaceId/layout
 *   PUT    /api/v1/workspaces/:workspaceId/layout
 *
 * Validation contract: every request body goes through the
 * corresponding Zod schema before reaching the DB. The DB layer
 * trusts validated input and never re-validates. See
 * `gateway/validation/schemas.ts` and the parallel TS types in
 * `gateway/types.ts`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { sendJSON, sendError, readJSON } from '../router.js'
import type { GatewayState } from '../state.js'
import type {
  CreateWorkspacePaneResponse,
  CloseWorkspacePaneResponse,
  PaneKind,
  PaneMetadata,
  PaneZone,
  WorkspaceLayoutResponse,
  WorkspacePane,
  WorkspacePaneListResponse,
} from '../types.js'
import {
  CreateWorkspacePaneSchema,
  UpdateWorkspacePaneSchema,
  ReorderWorkspacePanesSchema,
  SetWorkspaceLayoutSchema,
} from '../validation/schemas.js'
import type { PaneEventBus } from '../pane-event-bus.js'

// ---------------------------------------------------------------------------
// Defaults applied to PaneMetadata when the client omits fields.
// PaneMetadataSchema requires `pinned` and `closeable`; the wire shape
// treats them as optional so callers can send `{ openedBy: 'agent' }`
// alone. The handler fills the missing fields here, never the DB.
// ---------------------------------------------------------------------------

/**
 * Map a pane kind to its default zone (rip-dockview Phase F).
 *
 *   - `chat`                    → `'tabs'` (top tab strip)
 *   - everything else           → `'side'` (single-slot side panel)
 *
 * The client's shell mirrors this split:
 *   - The tab bar shows chat panes only.
 *   - The side panel shows
 *     non-chat panes — content (markdown / code / image / url / ...)
 *     PLUS the singleton workspace tools (terminal / files / tasks).
 *
 * Callers that want to override (e.g. open a markdown pane in the tab
 * strip) still pass `zone` explicitly.
 */
function defaultZoneForKind(kind: PaneKind): PaneZone {
  return kind === 'chat' ? 'tabs' : 'side'
}

function withMetadataDefaults(partial: Partial<PaneMetadata> = {}): PaneMetadata {
  return {
    openedBy: partial.openedBy ?? 'user',
    pinned: partial.pinned ?? false,
    closeable: partial.closeable ?? true,
    ...(partial.subagentId !== undefined ? { subagentId: partial.subagentId } : {}),
    ...(partial.subagentLabel !== undefined ? { subagentLabel: partial.subagentLabel } : {}),
    ...(partial.scopedToChatId !== undefined ? { scopedToChatId: partial.scopedToChatId } : {}),
    ...(partial.attachedTo !== undefined ? { attachedTo: partial.attachedTo } : {}),
  }
}

/**
 * Merge a wire-side partial PaneMetadata onto an existing one.
 * `undefined` = keep existing; explicit `null` is not part of the
 * shape (use UpdateWorkspacePane's `scopedChatId: null` instead, which
 * the DB layer handles separately).
 */
function mergeMetadata(
  existing: PaneMetadata,
  patch: Partial<PaneMetadata>,
): PaneMetadata {
  return {
    openedBy: patch.openedBy ?? existing.openedBy,
    pinned: patch.pinned ?? existing.pinned,
    closeable: patch.closeable ?? existing.closeable,
    ...(patch.subagentId !== undefined
      ? { subagentId: patch.subagentId }
      : (existing.subagentId !== undefined ? { subagentId: existing.subagentId } : {})),
    ...(patch.subagentLabel !== undefined
      ? { subagentLabel: patch.subagentLabel }
      : (existing.subagentLabel !== undefined ? { subagentLabel: existing.subagentLabel } : {})),
    ...(patch.scopedToChatId !== undefined
      ? { scopedToChatId: patch.scopedToChatId }
      : (existing.scopedToChatId !== undefined ? { scopedToChatId: existing.scopedToChatId } : {})),
    ...(patch.attachedTo !== undefined
      ? { attachedTo: patch.attachedTo }
      : (existing.attachedTo !== undefined ? { attachedTo: existing.attachedTo } : {})),
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface PaneHandlerDeps {
  /**
   * Fan-out bus for pane CRUD events (audit #2 C3 / F1b, 2026-05-16,
   * Chunk #20). When provided, the handlers emit a `pane.changed`
   * event on every successful create / patch / delete / reorder so
   * SSE subscribers can invalidate their per-workspace pane caches
   * without polling.
   *
   * Optional so the dozens of existing unit tests that don't care
   * about live events keep compiling. Production wiring in
   * `server.ts` always passes a real bus.
   */
  readonly eventBus?: PaneEventBus
}

export function createPaneHandlers(state: GatewayState, deps: PaneHandlerDeps = {}) {
  const eventBus = deps.eventBus

  // GET /api/v1/workspaces/:workspaceId/panes
  async function listPanes(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = params['workspaceId']!
    if (!state.getWorkspace(wsId)) {
      sendError(res, 404, `Workspace "${wsId}" not found`)
      return
    }

    const items = state.getWorkspacePanes(wsId)
    const layout = state.getWorkspacePaneLayout(wsId)
    const sideTrackWidth = state.getWorkspaceSideTrackWidth(wsId)
    const body: WorkspacePaneListResponse = {
      items,
      total: items.length,
      layout,
      sideTrackWidth,
    }
    sendJSON(res, 200, body)
  }

  // POST /api/v1/workspaces/:workspaceId/panes
  //
  // Creates a pane. Server fills metadata defaults, derives the
  // initial title from the kind when none is given, and runs
  // chat-pane idempotency at the DB layer (returns the existing pane
  // for a duplicate `(workspaceId, kind='chat', threadId)` create).
  async function createPane(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = params['workspaceId']!
    if (!state.getWorkspace(wsId)) {
      sendError(res, 404, `Workspace "${wsId}" not found`)
      return
    }

    const body = await readJSON(req)
    if (!body) {
      sendError(res, 400, 'Request body required')
      return
    }
    const parsed = CreateWorkspacePaneSchema.safeParse(body)
    if (!parsed.success) {
      sendError(
        res,
        400,
        parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; '),
      )
      return
    }

    // Default zone is derived from `config.kind` when the caller does
    // not explicitly pick one (rip-dockview Phase F). Chat panes live
    // in the tab strip; the four singleton kinds (terminal / files /
    // tasks / plan) live in the side panel; everything else (markdown,
    // code, image, url, ...) is content the agent shows alongside the
    // chat — also side. The client's shell follows the same split, so
    // unspecified-zone opens land where the surface expects them
    // without callers having to thread the zone through every
    // open_pane invocation.
    const zone: PaneZone =
      parsed.data.zone ?? defaultZoneForKind(parsed.data.config.kind)
    const metadata = withMetadataDefaults(parsed.data.metadata)

    const pane = state.createWorkspacePane(wsId, {
      config: parsed.data.config,
      metadata,
      zone,
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.focused !== undefined ? { focused: parsed.data.focused } : {}),
    })

    // Fan-out hint AFTER the row is durable. Invalidate-only — the
    // payload carries pane id + kind only, never title / config /
    // metadata (Principle 5). Audit #2 C3 / F1b.
    eventBus?.emit({
      wsId,
      paneId: pane.id,
      action: 'created',
      paneKind: pane.config.kind,
    })

    const responseBody: CreateWorkspacePaneResponse = {
      pane,
      placement: parsed.data.placement ?? null,
    }
    sendJSON(res, 201, responseBody)
  }

  // PATCH /api/v1/workspaces/:workspaceId/panes/:paneId
  //
  // `focused: true` activates this pane (transactional clear-and-set
  // via the DB layer). Metadata patches are merged into existing
  // metadata before the DB write — wire shape sends a partial.
  async function patchPane(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = params['workspaceId']!
    const paneId = params['paneId']!
    if (!state.getWorkspace(wsId)) {
      sendError(res, 404, `Workspace "${wsId}" not found`)
      return
    }

    const existing = state.getWorkspacePane(paneId)
    if (!existing || existing.workspaceId !== wsId) {
      sendError(res, 404, `Pane "${paneId}" not found in workspace "${wsId}"`)
      return
    }

    const body = await readJSON(req)
    if (!body) {
      sendError(res, 400, 'Request body required')
      return
    }
    const parsed = UpdateWorkspacePaneSchema.safeParse(body)
    if (!parsed.success) {
      sendError(
        res,
        400,
        parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; '),
      )
      return
    }

    const data = parsed.data

    // Field updates first (everything except `focused`). Metadata
    // partials get merged onto current; `config` replaces wholesale.
    // Build the DB update as a single literal so the readonly
    // parameter type stays satisfied.
    let current: WorkspacePane = existing
    const dbUpdate = {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.position !== undefined ? { position: data.position } : {}),
      ...(data.pinned !== undefined ? { pinned: data.pinned } : {}),
      ...(data.scopedToChatId !== undefined ? { scopedChatId: data.scopedToChatId } : {}),
      ...(data.groupId !== undefined ? { groupId: data.groupId } : {}),
      ...(data.config !== undefined ? { config: data.config } : {}),
      ...(data.metadata !== undefined
        ? { metadata: mergeMetadata(existing.metadata, data.metadata) }
        : {}),
    }

    if (Object.keys(dbUpdate).length > 0) {
      const u = state.updateWorkspacePane(paneId, dbUpdate)
      if (u) current = u
    }

    if (data.focused === true) {
      const focused = state.focusWorkspacePane(paneId)
      if (focused) current = focused
    }

    // Emit AFTER all writes are durable. One event per PATCH — the
    // focus + field updates collapse into a single `updated` because
    // a refetch covers both transitions.
    eventBus?.emit({
      wsId,
      paneId,
      action: 'updated',
      paneKind: current.config.kind,
    })

    sendJSON(res, 200, current)
  }

  // DELETE /api/v1/workspaces/:workspaceId/panes/:paneId
  //
  // Closes a pane. If it was focused, the DB layer promotes a
  // neighbour in the same zone and returns its id so the client can
  // reconcile without a follow-up list query.
  async function deletePane(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = params['workspaceId']!
    const paneId = params['paneId']!
    if (!state.getWorkspace(wsId)) {
      sendError(res, 404, `Workspace "${wsId}" not found`)
      return
    }
    const pane = state.getWorkspacePane(paneId)
    if (!pane || pane.workspaceId !== wsId) {
      sendError(res, 404, `Pane "${paneId}" not found in workspace "${wsId}"`)
      return
    }

    const result = state.deleteWorkspacePane(paneId)
    // Emit AFTER the row is gone. Subscribers refetch and the deleted
    // id falls off the list. The `nextFocusedPaneId` promotion is
    // covered by the same refetch — no second event needed.
    eventBus?.emit({
      wsId,
      paneId,
      action: 'deleted',
      paneKind: pane.config.kind,
    })
    const body: CloseWorkspacePaneResponse = {
      closed: true,
      nextFocusedPaneId: result.nextFocusedPaneId,
    }
    sendJSON(res, 200, body)
  }

  // PUT /api/v1/workspaces/:workspaceId/panes
  //
  // Bulk reorder within a single zone. The client sends the full
  // pane id list in the desired order; positions are assigned
  // 0..ids.length - 1. Membership is validated at the DB layer —
  // an alien id (different workspace or different zone) throws.
  async function reorderPanes(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = params['workspaceId']!
    if (!state.getWorkspace(wsId)) {
      sendError(res, 404, `Workspace "${wsId}" not found`)
      return
    }

    const body = await readJSON(req)
    if (!body) {
      sendError(res, 400, 'Request body required')
      return
    }
    const parsed = ReorderWorkspacePanesSchema.safeParse(body)
    if (!parsed.success) {
      sendError(
        res,
        400,
        parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; '),
      )
      return
    }

    try {
      const rows = state.reorderWorkspacePanes(wsId, parsed.data.zone, parsed.data.ids)
      // Single zone-level event — subscribers refetch the whole list.
      // No `paneId` (the change spans every pane in the zone).
      eventBus?.emit({ wsId, action: 'moved' })
      sendJSON(res, 200, rows)
    } catch (err) {
      // Membership-validation failure — surface as 400 rather than
      // letting it bubble as a 500. The DB layer's error message
      // names the offending ids.
      sendError(res, 400, err instanceof Error ? err.message : String(err))
    }
  }

  // GET /api/v1/workspaces/:workspaceId/layout
  async function getLayout(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = params['workspaceId']!
    if (!state.getWorkspace(wsId)) {
      sendError(res, 404, `Workspace "${wsId}" not found`)
      return
    }
    const body: WorkspaceLayoutResponse = {
      layout: state.getWorkspacePaneLayout(wsId),
      sideTrackWidth: state.getWorkspaceSideTrackWidth(wsId),
    }
    sendJSON(res, 200, body)
  }

  // PUT /api/v1/workspaces/:workspaceId/layout
  //
  // Persist workspace UI state. Carries the Dockview tabs layout and/or
  // the user-chosen side-track width — both optional, at least one
  // required. The client uses the side-track-only PATCH on every drag-end
  // of the `<WorkspaceShellSplitter>` (slice 2 of the FileViewer
  // redesign).
  async function setLayout(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = params['workspaceId']!
    if (!state.getWorkspace(wsId)) {
      sendError(res, 404, `Workspace "${wsId}" not found`)
      return
    }

    const body = await readJSON(req)
    if (!body) {
      sendError(res, 400, 'Request body required')
      return
    }
    const parsed = SetWorkspaceLayoutSchema.safeParse(body)
    if (!parsed.success) {
      sendError(
        res,
        400,
        parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; '),
      )
      return
    }

    if (parsed.data.layout !== undefined) {
      state.setWorkspacePaneLayout(wsId, parsed.data.layout)
    }
    if (parsed.data.sideTrackWidth !== undefined) {
      state.setWorkspaceSideTrackWidth(wsId, parsed.data.sideTrackWidth)
    }

    // Always echo the current persisted values back — the client
    // doesn't have to track which fields it sent vs. relied on.
    const response: WorkspaceLayoutResponse = {
      layout: state.getWorkspacePaneLayout(wsId),
      sideTrackWidth: state.getWorkspaceSideTrackWidth(wsId),
    }
    sendJSON(res, 200, response)
  }

  // ──────────────────────────────────────────────────────────────────
  // GET /api/v1/workspaces/:workspaceId/panes/source?path=<encoded>
  //
  // Wave 5 file-event flow: serves the contents of a workspace file
  // for the path-source `PaneConfig` variants (markdown / txt / json /
  // code / image kinds). The chat-stream `<FileLine>` [Open] button
  // calls `useOpenPane` with `{ source: { origin: 'path', path } }`
  // and the kinds fetch this endpoint at render time — no
  // round-trip through agent context.
  //
  // Security gate (load-bearing — see BOARD's wave-5 decisions):
  //   - The decoded `path` is resolved against the workspace root.
  //   - The realpath must remain inside the workspace's realpath (so
  //     symlinks that escape the workspace are blocked).
  //   - Out-of-workspace → 403 (NOT 404 — the file may exist; we
  //     just refuse to expose it).
  //   - Missing file → 404.
  //   - Oversize (> MAX_PANE_SOURCE_BYTES) → 413.
  //
  // Limitation: this endpoint does NOT honor a session's
  // `additionalWorkspaceRoots` (the per-session HITL grants the
  // agent uses for `readFile` on external paths). The gateway
  // doesn't currently track those at the workspace layer. Files
  // outside the workspace path that the agent could read will
  // surface a `[Open]` button in chat that 403s on click. v1
  // trade-off; documented in WAVE-5-DONE followups.
  //
  // Response: raw bytes with the right Content-Type per extension.
  // text/* gets utf-8; images get image/<format>; everything else
  // 415. Includes a weak ETag (`W/"<mtimeMs>:<size>"`) so the
  // browser can revalidate via If-None-Match.
  // ──────────────────────────────────────────────────────────────────

  async function readPaneSource(
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
    const requested = url.searchParams.get('path')
    if (requested == null || requested.length === 0) {
      sendError(res, 400, 'Missing required query parameter: path')
      return
    }

    let resolved: string
    let workspaceReal: string
    try {
      // Resolve relative paths against the workspace; absolute
      // paths are kept as-is. realpath collapses symlinks so an
      // attacker can't escape via `workspace/link → /etc`.
      const candidate = path.isAbsolute(requested)
        ? requested
        : path.resolve(ws.path, requested)
      resolved = await fs.realpath(candidate)
      workspaceReal = await fs.realpath(ws.path)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        sendError(res, 404, `File not found: ${requested}`)
        return
      }
      sendError(res, 500, `Failed to resolve path: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    // Both paths are realpaths (no symlinks, no `..`) — string-prefix
    // check + boundary slash is safe. Runs BEFORE the MIME check so an
    // out-of-workspace path doesn't leak its presence/absence via the
    // content-type response code.
    const withinWorkspace =
      resolved === workspaceReal
      || resolved.startsWith(workspaceReal + path.sep)
    if (!withinWorkspace) {
      sendError(res, 403, `Path "${requested}" is outside the workspace`)
      return
    }

    const mime = mimeForPath(resolved)
    if (mime == null) {
      sendError(res, 415, `Unsupported file type for path "${requested}"`)
      return
    }

    let stat
    try {
      stat = await fs.stat(resolved)
    } catch {
      sendError(res, 404, `File not found: ${requested}`)
      return
    }
    if (!stat.isFile()) {
      sendError(res, 400, `Path "${requested}" is not a regular file`)
      return
    }
    if (stat.size > MAX_PANE_SOURCE_BYTES) {
      sendError(
        res,
        413,
        `File "${requested}" is too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). ` +
        `Maximum supported size is ${MAX_PANE_SOURCE_BYTES / 1024 / 1024}MB.`,
      )
      return
    }

    const etag = `W/"${stat.mtimeMs}:${stat.size}"`
    const ifNoneMatch = req.headers['if-none-match']
    if (typeof ifNoneMatch === 'string' && ifNoneMatch === etag) {
      res.writeHead(304, { ETag: etag })
      res.end()
      return
    }

    let buffer: Buffer
    try {
      buffer = await fs.readFile(resolved)
    } catch (err) {
      sendError(res, 500, `Failed to read file: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': String(buffer.byteLength),
      ETag: etag,
      'Cache-Control': 'private, no-cache',
    })
    res.end(buffer)
  }

  return {
    listPanes,
    createPane,
    patchPane,
    deletePane,
    reorderPanes,
    getLayout,
    setLayout,
    readPaneSource,
  }
}

// ── File-source helpers (wave 5) ─────────────────────────────────────

const MAX_PANE_SOURCE_BYTES = 5 * 1024 * 1024 // 5 MB

// Known-binary extensions we refuse to serve as text (would garble). Anything
// NOT here and not an image/json is served as UTF-8 text — matching how an IDE
// opens unknown files, dotfiles (`.gitignore`, `.env`), and extensionless files
// (`Dockerfile`, `Makefile`, `LICENSE`). The 5 MB cap still applies.
const BINARY_EXTENSIONS = new Set([
  // archives
  '.zip', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.7z', '.rar',
  // av
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.mp3', '.wav', '.flac', '.ogg', '.m4a',
  // fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // docs / executables / objects
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.wasm', '.so', '.dylib', '.dll', '.exe', '.bin', '.o', '.a',
  '.class', '.jar', '.pyc',
  // image formats not handled by IMAGE_MIME
  '.avif', '.heic', '.tiff', '.tif',
  // databases
  '.sqlite', '.sqlite3', '.db',
])

const IMAGE_MIME: ReadonlyMap<string, string> = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.svg', 'image/svg+xml'],
])

function mimeForPath(p: string): string | null {
  // Work on the basename so dotfiles read correctly: `.gitignore` has NO real
  // extension (leading dot is the name), and `Dockerfile` has none either.
  const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase()
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot) : ''
  const imageMime = IMAGE_MIME.get(ext)
  if (imageMime !== undefined) return imageMime
  // JSON gets a more specific MIME but the body is still UTF-8.
  if (ext === '.json' || ext === '.json5') return 'application/json; charset=utf-8'
  // Refuse known-binary types (avoids serving garbled bytes as text).
  if (BINARY_EXTENSIONS.has(ext)) return null
  // Default: serve as UTF-8 text — unknown extensions, dotfiles, and
  // extensionless files are config/source in practice. The client highlights it.
  return 'text/plain; charset=utf-8'
}
