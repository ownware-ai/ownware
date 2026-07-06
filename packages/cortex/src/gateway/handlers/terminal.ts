/**
 * Terminal HTTP + SSE handlers.
 *
 * Split by PTY kind:
 *
 *   Agent (one per workspace, read-only from the client):
 *     POST /api/v1/workspaces/:wsId/terminal/agent/resize
 *     POST /api/v1/workspaces/:wsId/terminal/agent/reset
 *     GET  /api/v1/workspaces/:wsId/terminal/agent/events
 *     GET  /api/v1/workspaces/:wsId/terminal/agent/output
 *           ?offset=N&limit=M&pattern=regex&ignoreCase=1
 *           → paginated line-based read with optional regex filter.
 *             Pattern filters BEFORE pagination (paginate matches,
 *             not raw lines). Returns `{ lines, totalLines, offset,
 *             hasMore, filter? }`. See `pty-session.readLines`.
 *     (no /input — `shell_execute` is the only writer)
 *
 *   User (0..N per workspace, explicit create/destroy):
 *     POST   /api/v1/workspaces/:wsId/terminals/user                → { id }
 *     GET    /api/v1/workspaces/:wsId/terminals/user                → { ids }
 *     DELETE /api/v1/workspaces/:wsId/terminals/user/:id
 *     POST   /api/v1/workspaces/:wsId/terminals/user/:id/input
 *     POST   /api/v1/workspaces/:wsId/terminals/user/:id/resize
 *     POST   /api/v1/workspaces/:wsId/terminals/user/:id/signal
 *             Body: { signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' }
 *             SIGINT is the common case (Ctrl+C-equivalent sent
 *             from an agent tool without having to write the raw
 *             `\x03` byte through /input). SIGTERM / SIGKILL are
 *             available for stuck processes.
 *     GET    /api/v1/workspaces/:wsId/terminals/user/:id/events
 *     GET    /api/v1/workspaces/:wsId/terminals/user/:id/output
 *             ?offset=N&limit=M&pattern=regex&ignoreCase=1 → same
 *             paginated read as the agent endpoint.
 *     GET    /api/v1/workspaces/:wsId/terminals/user/:id/output/dump
 *             → Dumps the full session buffer to disk at
 *             `{dataDir}/sessions/{id}/log.txt` and returns
 *             `{ path, byteLength, lineCount, preview[] }`. Agent-
 *             facing "file offload" per Anthropic's context-
 *             engineering rule. Used when the buffer is too large
 *             to inline or when the agent wants to hand the log to
 *             another tool (grep, sed, a notebook).
 *
 * SSE streams emit the scrollback snapshot first, then live
 * `terminal.output` / `terminal.exit` frames filtered to that specific
 * (workspaceId, kind, terminalId) tuple. Keepalive every 30s.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sendError, sendJSON, readJSON } from '../router.js'
import { startSSE, writeSSE } from '../sse.js'
import type { TerminalSessionRegistry } from '../../terminal/session-registry.js'
import type { PtySession } from '../../terminal/pty-session.js'
import type {
  TerminalEvent,
  TerminalEventBus,
  TerminalKind,
} from '../../terminal/event-bus.js'

const KEEPALIVE_INTERVAL_MS = 30_000
const MAX_INPUT_BYTES = 64 * 1024 // hard cap per write; 64 KiB dwarfs anything a human types.

// Hard cap on the number of lines returned in one output read. Prevents
// an agent asking for `limit=999999` and stalling on a huge response.
// The agent can paginate through more with follow-up calls.
const MAX_READ_LIMIT = 2_000
const DEFAULT_READ_LIMIT = 500

// Cap on the regex pattern length accepted by the output endpoint.
// Deliberately short — a regex that genuinely needs 200+ chars is a
// design smell in agent tool-use, and longer patterns expand the
// catastrophic-backtracking surface.
const MAX_PATTERN_LENGTH = 200

// Number of leading lines returned as a preview alongside the offload
// path. Matches Anthropic's "return file path + first 10 lines" rule
// from effective-context-engineering-for-ai-agents. Generous at 20
// because agents often want enough to see a stack trace header or a
// dev-server startup block before deciding whether to read more.
const DUMP_PREVIEW_LINES = 20

/**
 * Safe PTY-id filter for on-disk paths. Our user-PTY ids are UUIDs
 * (`randomUUID()`), so this is paranoia rather than defensive need,
 * but keeps `{dataDir}/sessions/{id}/...` from ever escaping the
 * tree even if the id type ever loosens.
 */
function sanitizeIdForPath(id: string): string | null {
  if (id.length === 0 || id.length > 100) return null
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null
  return id
}

export interface TerminalHandlerDeps {
  readonly registry: TerminalSessionRegistry
  readonly bus: TerminalEventBus
  /**
   * Cortex data directory (resolved in the server constructor from
   * `opts.dataDir` / `OWNWARE_DATA_DIR` / `~/.ownware`). Used by the
   * `output/dump` endpoint (Item 9) — dumped session buffers land at
   * `{dataDir}/sessions/{terminalId}/log.txt`. Optional so handler
   * tests that don't exercise dump can omit it.
   */
  readonly dataDir?: string
}

// ---------------------------------------------------------------------------
// Shared validation + streaming helpers
// ---------------------------------------------------------------------------

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

function requireTerminalId(
  res: ServerResponse,
  params: Record<string, string>,
): string | null {
  const id = params['id']
  if (id == null || id.length === 0) {
    sendError(res, 400, 'Missing terminal id')
    return null
  }
  return id
}

async function parseResizeBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ cols: number; rows: number } | null> {
  const body = await readJSON<{ cols?: unknown; rows?: unknown }>(req)
  const cols = Number(body?.cols)
  const rows = Number(body?.rows)
  if (
    !Number.isFinite(cols) ||
    !Number.isFinite(rows) ||
    cols <= 0 ||
    rows <= 0 ||
    cols > 1000 ||
    rows > 1000
  ) {
    sendError(res, 400, '`cols` and `rows` must be positive integers (≤ 1000)')
    return null
  }
  return { cols, rows }
}

interface ParsedOutputQuery {
  readonly offset: number
  readonly limit: number
  readonly pattern: RegExp | null
  readonly patternEcho: string | null
  readonly ignoreCase: boolean
}

/**
 * Parse the `?offset=N&limit=M&pattern=X&ignoreCase=1` query used by
 * the agent + user output endpoints. Sends an appropriate 400 and
 * returns null when the query is malformed. Regex compilation errors
 * produce a specific message so the agent's retry carries something
 * useful.
 */
function parseOutputQuery(
  req: IncomingMessage,
  res: ServerResponse,
): ParsedOutputQuery | null {
  const url = new URL(req.url ?? '/', 'http://local')
  const offsetRaw = url.searchParams.get('offset')
  const limitRaw = url.searchParams.get('limit')
  const patternRaw = url.searchParams.get('pattern')
  const ignoreCaseRaw = url.searchParams.get('ignoreCase')

  let offset = 0
  if (offsetRaw != null) {
    const n = Number(offsetRaw)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      sendError(res, 400, '`offset` must be a non-negative integer')
      return null
    }
    offset = n
  }

  let limit = DEFAULT_READ_LIMIT
  if (limitRaw != null) {
    const n = Number(limitRaw)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      sendError(res, 400, '`limit` must be a non-negative integer')
      return null
    }
    if (n > MAX_READ_LIMIT) {
      sendError(
        res,
        400,
        `\`limit\` exceeds the maximum of ${MAX_READ_LIMIT}. Paginate via \`offset\`.`,
      )
      return null
    }
    limit = n
  }

  const ignoreCase =
    ignoreCaseRaw === '1' ||
    ignoreCaseRaw === 'true' ||
    ignoreCaseRaw === 'yes'

  let pattern: RegExp | null = null
  let patternEcho: string | null = null
  if (patternRaw != null && patternRaw.length > 0) {
    if (patternRaw.length > MAX_PATTERN_LENGTH) {
      sendError(
        res,
        400,
        `\`pattern\` exceeds ${MAX_PATTERN_LENGTH} characters`,
      )
      return null
    }
    try {
      pattern = new RegExp(patternRaw, ignoreCase ? 'i' : '')
      patternEcho = patternRaw
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid regex'
      sendError(res, 400, `Invalid \`pattern\`: ${msg}`)
      return null
    }
  }

  return { offset, limit, pattern, patternEcho, ignoreCase }
}

async function parseInputBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<string | null> {
  const body = await readJSON<{ data?: unknown }>(req)
  const data = body?.data
  if (typeof data !== 'string') {
    sendError(res, 400, '`data` must be a string')
    return null
  }
  if (Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) {
    sendError(res, 413, `Input exceeds ${MAX_INPUT_BYTES} bytes`)
    return null
  }
  return data
}

/**
 * Stream bytes from one PTY session onto an SSE response. Sends the
 * scrollback snapshot first, then filters live bus events to the
 * matching (workspaceId, kind, terminalId) tuple.
 */
async function streamSession(
  req: IncomingMessage,
  res: ServerResponse,
  bus: TerminalEventBus,
  session: PtySession,
  filter: {
    readonly workspaceId: string
    readonly kind: TerminalKind
    readonly terminalId: string | null
  },
): Promise<void> {
  startSSE(res)
  res.write(':ready\n\n')

  const snapshot = session.scrollback()
  if (snapshot.length > 0) {
    await writeSSE(res, 'terminal.output', {
      type: 'terminal.output',
      workspaceId: filter.workspaceId,
      kind: filter.kind,
      terminalId: filter.terminalId,
      data: snapshot,
      at: new Date().toISOString(),
    })
  }

  const queue: TerminalEvent[] = []
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
    if (ev.workspaceId !== filter.workspaceId) return
    if (ev.kind !== filter.kind) return
    if (ev.terminalId !== filter.terminalId) return
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

// ---------------------------------------------------------------------------
// Agent handlers
// ---------------------------------------------------------------------------

export function createTerminalAgentHandlers(deps: TerminalHandlerDeps) {
  const { registry, bus } = deps

  async function resize(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return
    const size = await parseResizeBody(req, res)
    if (size == null) return
    const session = registry.getAgent(wsId)
    if (session == null) {
      sendError(res, 404, `No workspace "${wsId}"`)
      return
    }
    session.resize(size.cols, size.rows)
    sendJSON(res, 200, { ok: true })
  }

  async function reset(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return
    registry.dropAgent(wsId)
    sendJSON(res, 200, { ok: true })
  }

  async function streamEvents(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return
    const session = registry.getAgent(wsId)
    if (session == null) {
      sendError(res, 404, `No workspace "${wsId}"`)
      return
    }
    await streamSession(req, res, bus, session, {
      workspaceId: wsId,
      kind: 'agent',
      terminalId: null,
    })
  }

  /**
   * Paginated, optionally regex-filtered line read of the agent PTY's
   * scrollback. Pure read — does NOT lazy-spawn the agent PTY; an
   * untouched workspace yields `{ lines: [], totalLines: 0, ... }`.
   * See module-level doc for the full query + response shape.
   */
  async function readOutput(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return
    if (!registry.workspaceExists(wsId)) {
      sendError(res, 404, `No workspace "${wsId}"`)
      return
    }
    const query = parseOutputQuery(req, res)
    if (query == null) return

    const session = registry.peekAgent(wsId)
    const result = session?.readLines({
      offset: query.offset,
      limit: query.limit,
      ...(query.pattern != null ? { pattern: query.pattern } : {}),
    }) ?? {
      lines: [] as const,
      totalLines: 0,
      offset: query.offset,
      hasMore: false,
      filter:
        query.pattern != null && query.patternEcho != null
          ? {
              pattern: query.patternEcho,
              ignoreCase: query.ignoreCase,
              matchCount: 0,
            }
          : null,
    }
    sendJSON(res, 200, result)
  }

  return { resize, reset, streamEvents, readOutput }
}

// ---------------------------------------------------------------------------
// User-terminal handlers
// ---------------------------------------------------------------------------

export function createTerminalUserHandlers(deps: TerminalHandlerDeps) {
  const { registry, bus } = deps

  async function create(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return

    // Optional ownership + lifecycle fields. All optional — a human-
    // created shell ships with an empty body and gets all defaults.
    // Agent-spawned shells (via Loom `shell_execute`, later board
    // items) populate these for cleanup + notifications.
    interface CreateBody {
      parentThreadId?: unknown
      parentAgent?: unknown
      notifyOnExit?: unknown
      timeoutSeconds?: unknown
      title?: unknown
    }
    const body = await readJSON<CreateBody>(req).catch<CreateBody>(() => ({}))

    const owner: {
      parentThreadId?: string
      parentAgent?: string
      notifyOnExit?: boolean
      timeoutSeconds?: number
      title?: string
    } = {}

    if (typeof body?.parentThreadId === 'string' && body.parentThreadId.length > 0) {
      owner.parentThreadId = body.parentThreadId
    }
    if (typeof body?.parentAgent === 'string' && body.parentAgent.length > 0) {
      owner.parentAgent = body.parentAgent
    }
    if (typeof body?.notifyOnExit === 'boolean') {
      owner.notifyOnExit = body.notifyOnExit
    }
    if (body?.timeoutSeconds !== undefined) {
      const n = Number(body.timeoutSeconds)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        sendError(res, 400, '`timeoutSeconds` must be a positive integer')
        return
      }
      owner.timeoutSeconds = n
    }
    if (typeof body?.title === 'string' && body.title.length > 0) {
      owner.title = body.title
    }

    const created = registry.createUser(wsId, owner)
    if (created == null) {
      sendError(res, 404, `No workspace "${wsId}"`)
      return
    }
    // Echo ownership fields back so the caller confirms what stuck.
    const info = registry.getInfo(wsId, 'user', created.id)
    sendJSON(res, 201, { id: created.id, info })
  }

  async function list(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return
    const ids = registry.listUser(wsId)
    // Also include `SessionInfo` per id — the client uses the status +
    // parentAgent to render tab labels without a follow-up round-trip.
    // `ids` kept for backwards compat with the existing client.
    const infos = ids
      .map((id) => registry.getInfo(wsId, 'user', id))
      .filter((info): info is NonNullable<typeof info> => info != null)
    sendJSON(res, 200, { ids, infos })
  }

  async function drop(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return
    const id = requireTerminalId(res, params)
    if (id == null) return
    if (registry.getUser(wsId, id) == null) {
      sendError(res, 404, `No terminal "${id}" in workspace "${wsId}"`)
      return
    }
    registry.dropUser(wsId, id)
    sendJSON(res, 200, { ok: true })
  }

  async function writeInput(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return
    const id = requireTerminalId(res, params)
    if (id == null) return
    const data = await parseInputBody(req, res)
    if (data == null) return
    const session = registry.getUser(wsId, id)
    if (session == null) {
      sendError(res, 404, `No terminal "${id}" in workspace "${wsId}"`)
      return
    }
    session.write(data)
    sendJSON(res, 200, { ok: true })
  }

  async function resize(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return
    const id = requireTerminalId(res, params)
    if (id == null) return
    const size = await parseResizeBody(req, res)
    if (size == null) return
    const session = registry.getUser(wsId, id)
    if (session == null) {
      sendError(res, 404, `No terminal "${id}" in workspace "${wsId}"`)
      return
    }
    session.resize(size.cols, size.rows)
    sendJSON(res, 200, { ok: true })
  }

  /**
   * Send a POSIX signal to the user PTY. Accepts `SIGINT` (Ctrl+C
   * equivalent, the common agent case), `SIGTERM` (polite
   * termination), or `SIGKILL` (hard kill). Anything else → 400.
   *
   * The per-session `kill()` path on natural SIGKILL goes through
   * node-pty and flips the session's status via the existing `onExit`
   * callback; no extra registry wiring needed here.
   */
  async function sendSignal(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return
    const id = requireTerminalId(res, params)
    if (id == null) return
    interface SignalBody {
      signal?: unknown
    }
    const body = await readJSON<SignalBody>(req).catch<SignalBody>(() => ({}))
    const signal = body?.signal
    if (signal !== 'SIGINT' && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      sendError(
        res,
        400,
        '`signal` must be one of: "SIGINT", "SIGTERM", "SIGKILL"',
      )
      return
    }
    const session = registry.getUser(wsId, id)
    if (session == null) {
      sendError(res, 404, `No terminal "${id}" in workspace "${wsId}"`)
      return
    }
    // SIGINT is best delivered as a write of the raw control byte
    // (0x03) so the tty line discipline interrupts a foreground
    // command the same way a human hitting Ctrl+C would. SIGTERM /
    // SIGKILL go through node-pty's `kill()` (which kills the shell
    // itself, ending the session).
    if (signal === 'SIGINT') {
      session.write('\x03')
    } else {
      session.kill(signal)
    }
    sendJSON(res, 200, { ok: true, signal })
  }

  async function streamEvents(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return
    const id = requireTerminalId(res, params)
    if (id == null) return
    const session = registry.getUser(wsId, id)
    if (session == null) {
      sendError(res, 404, `No terminal "${id}" in workspace "${wsId}"`)
      return
    }
    await streamSession(req, res, bus, session, {
      workspaceId: wsId,
      kind: 'user',
      terminalId: id,
    })
  }

  /**
   * Paginated, optionally regex-filtered line read of a user PTY's
   * scrollback. Mirrors the agent `/output` semantics — see that
   * handler's doc for the query + response shape.
   */
  async function readOutput(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return
    const id = requireTerminalId(res, params)
    if (id == null) return
    const session = registry.getUser(wsId, id)
    if (session == null) {
      sendError(res, 404, `No terminal "${id}" in workspace "${wsId}"`)
      return
    }
    const query = parseOutputQuery(req, res)
    if (query == null) return

    const result = session.readLines({
      offset: query.offset,
      limit: query.limit,
      ...(query.pattern != null ? { pattern: query.pattern } : {}),
    })
    sendJSON(res, 200, result)
  }

  /**
   * Dump the full session scrollback to disk and return the path +
   * a short preview (Item 9 — agent-facing "file offload" pattern
   * from Anthropic's effective-context-engineering rule). Use when
   * the buffer is too large to inline or the agent wants to hand a
   * log file to another tool (grep, sed, a notebook).
   *
   * Writes to `{dataDir}/sessions/{terminalId}/log.txt` — atomic
   * from the client's POV (mkdir -p + writeFile). Returns:
   *   - `path`: absolute path for the agent to reference later
   *   - `byteLength`: file size (bytes, UTF-8)
   *   - `lineCount`: total lines after `\r\n` normalization
   *   - `preview`: first N lines (DUMP_PREVIEW_LINES)
   */
  async function dumpOutput(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return
    const id = requireTerminalId(res, params)
    if (id == null) return
    const session = registry.getUser(wsId, id)
    if (session == null) {
      sendError(res, 404, `No terminal "${id}" in workspace "${wsId}"`)
      return
    }
    if (deps.dataDir == null) {
      sendError(
        res,
        503,
        'Output dump unavailable: gateway has no data directory configured',
      )
      return
    }
    const safeId = sanitizeIdForPath(id)
    if (safeId == null) {
      sendError(res, 400, 'Terminal id is not safe for a filesystem path')
      return
    }

    const scrollback = session.scrollback()
    const dir = join(deps.dataDir, 'sessions', safeId)
    const path = join(dir, 'log.txt')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(path, scrollback, 'utf8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      sendError(res, 500, `Failed to write dump: ${msg}`)
      return
    }

    // Reuse `readLines` with no filter to produce the preview so the
    // line-number + `\r\n` stripping semantics match what `read`
    // returns. Bounded to DUMP_PREVIEW_LINES.
    const previewResult = session.readLines({ limit: DUMP_PREVIEW_LINES })
    sendJSON(res, 200, {
      path,
      byteLength: Buffer.byteLength(scrollback, 'utf8'),
      lineCount: previewResult.totalLines,
      preview: previewResult.lines,
    })
  }

  return {
    create,
    list,
    drop,
    writeInput,
    resize,
    sendSignal,
    streamEvents,
    readOutput,
    dumpOutput,
  }
}

// ---------------------------------------------------------------------------
// Workspace-multiplexed handlers (one connection for ALL terminals)
// ---------------------------------------------------------------------------

/**
 * The clean, multiplexed terminal surface: ONE SSE per workspace carrying every
 * user session's output + lifecycle (created / exit), and ONE input / resize
 * endpoint each that routes by `terminalId`. Collapses the per-terminal SSE +
 * per-terminal endpoints into a single channel the client demuxes — fewer
 * connections, lifecycle frames (no polling), scales to any number of tabs.
 *
 * Additive: the per-terminal endpoints above still exist for the legacy
 * TerminalPanel; the coder dock uses these.
 */
export function createTerminalWorkspaceHandlers(deps: TerminalHandlerDeps) {
  const { registry, bus } = deps

  // GET /api/v1/workspaces/:wsId/terminal/stream
  async function stream(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return
    if (!registry.workspaceExists(wsId)) {
      sendError(res, 404, `Workspace "${wsId}" not found`)
      return
    }

    startSSE(res)
    res.write(':ready\n\n')

    // Snapshot every live session so the client renders existing tabs at once:
    // a `created` frame (adds the tab) + its scrollback as an output frame.
    for (const id of registry.listUser(wsId)) {
      await writeSSE(res, 'terminal.created', {
        type: 'terminal.created',
        workspaceId: wsId,
        kind: 'user',
        terminalId: id,
        at: new Date().toISOString(),
      })
      const snapshot = registry.getUser(wsId, id)?.scrollback() ?? ''
      if (snapshot.length > 0) {
        await writeSSE(res, 'terminal.output', {
          type: 'terminal.output',
          workspaceId: wsId,
          kind: 'user',
          terminalId: id,
          data: snapshot,
          at: new Date().toISOString(),
        })
      }
    }

    const queue: TerminalEvent[] = []
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

    // All user sessions for this workspace (the agent shell is one of them).
    const unsubscribe = bus.subscribe((ev) => {
      if (ev.workspaceId !== wsId) return
      if (ev.kind !== 'user') return
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

  // POST /api/v1/workspaces/:wsId/terminal/input  { terminalId, data }
  async function writeInput(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return
    const body =
      (await readJSON<{ terminalId?: unknown; data?: unknown }>(req).catch(() => null)) ?? {}
    const terminalId = typeof body.terminalId === 'string' ? body.terminalId : null
    const data = typeof body.data === 'string' ? body.data : null
    if (terminalId == null || data == null) {
      sendError(res, 400, '`terminalId` and `data` are required')
      return
    }
    if (Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) {
      sendError(res, 413, `Input exceeds ${(MAX_INPUT_BYTES / 1024).toString()} KiB cap`)
      return
    }
    const session = registry.getUser(wsId, terminalId)
    if (session == null) {
      sendError(res, 404, `No terminal "${terminalId}" in workspace "${wsId}"`)
      return
    }
    session.write(data)
    sendJSON(res, 200, { ok: true })
  }

  // POST /api/v1/workspaces/:wsId/terminal/resize  { terminalId, cols, rows }
  async function resize(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const wsId = requireWsId(res, params)
    if (wsId == null) return
    const body =
      (await readJSON<{ terminalId?: unknown; cols?: unknown; rows?: unknown }>(req).catch(
        () => null,
      )) ?? {}
    const terminalId = typeof body.terminalId === 'string' ? body.terminalId : null
    const cols = typeof body.cols === 'number' ? body.cols : null
    const rows = typeof body.rows === 'number' ? body.rows : null
    if (terminalId == null || cols == null || rows == null || cols <= 0 || rows <= 0) {
      sendError(res, 400, '`terminalId`, `cols`, `rows` are required (cols/rows > 0)')
      return
    }
    const session = registry.getUser(wsId, terminalId)
    if (session == null) {
      sendError(res, 404, `No terminal "${terminalId}" in workspace "${wsId}"`)
      return
    }
    session.resize(cols, rows)
    sendJSON(res, 200, { ok: true })
  }

  return { stream, writeInput, resize }
}
