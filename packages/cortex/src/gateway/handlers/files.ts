/**
 * Files HTTP + SSE handlers.
 *
 *   GET /api/v1/workspaces/:wsId/files
 *     → { items: FileEntry[] }
 *     → 404 { error: 'workspace_unknown' | 'not_git_repo', message }
 *
 *   GET /api/v1/workspaces/:wsId/files/diff?path=<rel>&side=unstaged|staged
 *     → { path, side, kind: 'diff' | 'new-file', diff, truncated }
 *     → 400 { error: 'path_traversal' | 'bad_request', message }
 *     → 403 { error: 'blocked_path', message }
 *     → 404 { error: 'workspace_unknown' | 'not_git_repo' | 'not_found' }
 *
 *   GET /api/v1/workspaces/:wsId/files/events
 *     → SSE: `files.updated` frames. Initial frame on connect carries
 *       the current snapshot; subsequent frames arrive as the watcher
 *       fires.
 *     → 404 { error: 'workspace_unknown' | 'not_git_repo' } at open
 *       time when the workspace can't stream (no SSE opened in that
 *       case — the client renders the dedicated empty state instead).
 *
 * Error bodies are structured so the client can branch on
 * `body.error`, not status codes. `message` is human-friendly but
 * NOT meant to be shown verbatim — the client maps the discriminator to
 * localized UI copy.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendError, sendJSON } from '../router.js'
import { startSSE, writeSSE } from '../sse.js'
import type {
  FilesEventBus,
  FilesUpdatedEvent,
  FilesService,
} from '../../files/index.js'
import type { DiffSide } from '../../files/index.js'

const KEEPALIVE_INTERVAL_MS = 30_000

export interface FilesHandlerDeps {
  readonly service: FilesService
  readonly bus: FilesEventBus
}

// ---------------------------------------------------------------------------
// Error-body helpers — keep shape consistent with instructions §F02.
// ---------------------------------------------------------------------------

type ErrorDiscriminator =
  | 'workspace_unknown'
  | 'not_git_repo'
  | 'path_traversal'
  | 'blocked_path'
  | 'not_found'
  | 'bad_request'
  | 'spawn_failed'

function sendStructuredError(
  res: ServerResponse,
  status: number,
  discriminator: ErrorDiscriminator,
  message: string,
): void {
  // We use writeHead + end directly so the body carries our
  // structured shape (sendError writes a `{ error: message }`
  // envelope that doesn't discriminate).
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
  }
  res.end(JSON.stringify({ error: discriminator, message }))
}

function requireWsId(
  res: ServerResponse,
  params: Record<string, string>,
): string | null {
  const wsId = params['wsId']
  if (wsId == null || wsId.length === 0) {
    sendError(res, 400, 'Missing wsId')
    return null
  }
  return wsId
}

function parseSide(raw: string | null | undefined): DiffSide | null {
  if (raw == null || raw === 'unstaged') return 'unstaged'
  if (raw === 'staged') return 'staged'
  return null
}

function buildUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function createFilesHandlers(deps: FilesHandlerDeps) {
  const { service, bus } = deps

  // GET /api/v1/workspaces/:wsId/files
  async function listFiles(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return

    const result = await service.list(wsId)
    if (!result.ok) {
      if (result.reason === 'workspace_unknown') {
        sendStructuredError(res, 404, 'workspace_unknown', `No workspace "${wsId}"`)
      } else {
        sendStructuredError(
          res,
          404,
          'not_git_repo',
          "This workspace isn't a git repository.",
        )
      }
      return
    }
    sendJSON(res, 200, { items: result.items })
  }

  // GET /api/v1/workspaces/:wsId/files/diff
  async function getDiff(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return

    const url = buildUrl(req)
    const path = url.searchParams.get('path')
    if (path == null || path.length === 0) {
      sendStructuredError(res, 400, 'bad_request', 'Missing ?path= query parameter')
      return
    }

    const side = parseSide(url.searchParams.get('side'))
    if (side == null) {
      sendStructuredError(
        res,
        400,
        'bad_request',
        '`side` must be "unstaged" or "staged" (default: "unstaged")',
      )
      return
    }

    const result = await service.diff(wsId, path, side)
    if (!result.ok) {
      switch (result.reason) {
        case 'workspace_unknown':
          sendStructuredError(res, 404, 'workspace_unknown', `No workspace "${wsId}"`)
          return
        case 'not_git_repo':
          sendStructuredError(
            res,
            404,
            'not_git_repo',
            "This workspace isn't a git repository.",
          )
          return
        case 'path_traversal':
          sendStructuredError(
            res,
            400,
            'path_traversal',
            'Path escapes the workspace root.',
          )
          return
        case 'blocked_path':
          sendStructuredError(
            res,
            403,
            'blocked_path',
            'This file is protected and cannot be shown in a diff.',
          )
          return
        case 'not_found':
          sendStructuredError(res, 404, 'not_found', `Path not found: ${path}`)
          return
      }
    }

    sendJSON(res, 200, {
      path,
      side,
      kind: result.value.kind,
      diff: result.value.diff,
      truncated: result.value.truncated,
    })
  }

  // GET /api/v1/workspaces/:wsId/files/original?path=<rel>
  //
  // The file's content at HEAD — the "original" side of the Monaco diff editor.
  // `content: null` means the path isn't in HEAD (new/untracked file); the diff
  // then renders as all-additions against an empty original.
  async function getOriginal(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return

    const url = buildUrl(req)
    const path = url.searchParams.get('path')
    if (path == null || path.length === 0) {
      sendStructuredError(res, 400, 'bad_request', 'Missing ?path= query parameter')
      return
    }

    const result = await service.original(wsId, path)
    if (!result.ok) {
      switch (result.reason) {
        case 'workspace_unknown':
          sendStructuredError(res, 404, 'workspace_unknown', `No workspace "${wsId}"`)
          return
        case 'not_git_repo':
          sendStructuredError(res, 404, 'not_git_repo', "This workspace isn't a git repository.")
          return
        case 'path_traversal':
          sendStructuredError(res, 400, 'path_traversal', 'Path escapes the workspace root.')
          return
        case 'blocked_path':
          sendStructuredError(res, 403, 'blocked_path', 'This file is protected.')
          return
      }
    }

    sendJSON(res, 200, { path, content: result.content })
  }

  // GET /api/v1/workspaces/:wsId/files/tree?path=<rel>
  //
  // Lazy directory listing for the coder explorer. `path` is optional
  // (defaults to the workspace root). Unlike /files, this walks the real
  // filesystem (no git requirement) so the tree shows the whole project.
  async function listTree(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return

    const url = buildUrl(req)
    const path = url.searchParams.get('path') ?? ''

    const result = await service.tree(wsId, path)
    if (!result.ok) {
      switch (result.reason) {
        case 'workspace_unknown':
          sendStructuredError(res, 404, 'workspace_unknown', `No workspace "${wsId}"`)
          return
        case 'path_traversal':
          sendStructuredError(res, 400, 'path_traversal', 'Path escapes the workspace root.')
          return
        case 'not_a_directory':
          sendStructuredError(res, 400, 'bad_request', `Not a directory: ${path}`)
          return
        case 'not_found':
          sendStructuredError(res, 404, 'not_found', `Path not found: ${path}`)
          return
      }
    }

    sendJSON(res, 200, { entries: result.entries })
  }

  // GET /api/v1/workspaces/:wsId/files/events
  async function streamEvents(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return

    // Refuse to open SSE for a workspace we can't stream — the client
    // renders the dedicated empty state instead. Holding an SSE
    // connection open just to say "still not a repo" is wasteful.
    const snapshot = await service.list(wsId)
    if (!snapshot.ok) {
      if (snapshot.reason === 'workspace_unknown') {
        sendStructuredError(res, 404, 'workspace_unknown', `No workspace "${wsId}"`)
      } else {
        sendStructuredError(
          res,
          404,
          'not_git_repo',
          "This workspace isn't a git repository.",
        )
      }
      return
    }

    startSSE(res)
    res.write(':ready\n\n')

    // Backpressure-aware queue — same idiom as tasks + connector-events.
    const queue: FilesUpdatedEvent[] = []
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

    // Subscribe to the service's fan-out. The service also starts
    // the watcher on first subscribe and emits the first fresh
    // snapshot from the watcher callback; we don't rely on that
    // here because we want a synchronous initial frame so the
    // client paints without waiting on a filesystem bounce.
    const unsubFromBus = bus.subscribe((ev) => {
      if (ev.workspaceId !== wsId) return
      queue.push(ev)
      void drain()
    })
    const unsubFromService = service.subscribe(wsId, () => {
      // The service forwards through the bus; we subscribe at the
      // bus level above. This service-level subscribe is ONLY to
      // tell the service "keep your watcher alive while I'm here";
      // we drop its callback.
    })

    // Emit the initial frame synchronously from the snapshot we
    // already fetched above — zero-flicker paint for the client.
    const initial: FilesUpdatedEvent = {
      type: 'files.updated',
      workspaceId: wsId,
      at: new Date().toISOString(),
      items: [...snapshot.items],
    }
    await writeSSE(res, 'files.updated', initial)

    const keepalive = setInterval(() => {
      if (res.writableEnded) return
      res.write(':ka\n\n')
    }, KEEPALIVE_INTERVAL_MS)

    const cleanup = (): void => {
      clearInterval(keepalive)
      unsubFromBus()
      unsubFromService()
      if (!res.writableEnded) res.end()
    }

    req.on('close', cleanup)
    req.on('error', cleanup)
  }

  return { listFiles, getDiff, getOriginal, listTree, streamEvents }
}
