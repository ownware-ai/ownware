/**
 * Thread management handlers.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJSON, sendError, readJSON } from '../router.js'
import type { GatewayState } from '../state.js'
import type { SessionRunner } from '../session-runner.js'
import { ROOT_AGENT_ID } from '../event-bus.js'
import { UpdateThreadSchema } from '../validation/schemas.js'
import {
  authorizePrincipalScope,
  getRequestPrincipal,
} from '../auth/scoped-principal.js'
import { principalContinuityKey } from '../idempotency.js'
import type { RunRepository } from '../../storage/security-repositories.js'
import type { ThreadHydration } from '../types.js'

export interface ThreadHandlerDeps {
  /**
   * The runner exposes liveness — used by /hydrate so the client can tell
   * "this thread is still streaming, open SSE" vs "this thread is
   * terminal, use the snapshot".
   */
  readonly runner?: SessionRunner
  /** Durable authority used to confirm that a live runner ID is public. */
  readonly runStore?: RunRepository
}

export function createThreadHandlers(state: GatewayState, deps: ThreadHandlerDeps = {}) {

  // GET /api/v1/threads?profileId=coder
  async function listThreads(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Public contract (revision 0.47): validated pagination and fail-closed
    // principal scoping. A delegated principal follows the exact threads it is
    // bound to (via hydrate and its own runs); enumerating a profile's threads
    // is an owner surface, so delegation is refused rather than filtered —
    // a filtered empty page would read as "no threads exist".
    if (!authorizePrincipalScope(req, {})) {
      sendError(res, 403, 'Delegated principals cannot enumerate threads', 'principal_scope_denied', 'auth')
      return
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const allowed = new Set(['profileId', 'limit', 'offset'])
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || url.searchParams.getAll(key).length > 1) {
        sendError(res, 400, 'Thread listing query is invalid', 'thread_list_invalid', 'invalid_request')
        return
      }
    }
    const bounded = (name: string, max: number, fallback: number): number | null => {
      const raw = url.searchParams.get(name)
      if (raw === null) return fallback
      if (!/^[0-9]{1,9}$/.test(raw)) return null
      const parsed = Number(raw)
      return parsed > max ? null : parsed
    }
    const limit = bounded('limit', 200, 50)
    const offset = bounded('offset', 1_000_000_000 - 1, 0)
    if (limit === null || limit < 1 || offset === null) {
      sendError(res, 400, 'Thread listing query is invalid', 'thread_list_invalid', 'invalid_request')
      return
    }
    const profileId = url.searchParams.get('profileId') ?? undefined
    res.setHeader('Cache-Control', 'no-store')
    sendJSON(res, 200, await state.listThreads(profileId, { limit, offset }))
  }

  // POST /api/v1/threads
  async function createThread(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJSON<{ profileId?: string; title?: string; workspaceId?: string }>(req)
    const profileId = body?.profileId ?? 'example'
    const title = body?.title
    const workspaceId = body?.workspaceId

    const thread = await state.createThread(profileId, title ?? undefined, workspaceId ?? undefined)
    sendJSON(res, 201, thread)
  }

  // GET /api/v1/threads/:threadId
  async function getThread(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const threadId = params['threadId']!
    const thread = await state.getThread(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }

    const messages = await state.getMessages(threadId)
    sendJSON(res, 200, { ...thread, messages })
  }

  // DELETE /api/v1/threads/:threadId
  async function deleteThread(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const threadId = params['threadId']!
    const deleted = await state.deleteThread(threadId)
    if (!deleted) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }

    res.writeHead(204)
    res.end()
  }

  // GET /api/v1/threads/:threadId/messages
  async function getMessages(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const threadId = params['threadId']!
    const thread = await state.getThread(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }

    sendJSON(res, 200, await state.getMessages(threadId))
  }

  // PATCH /api/v1/threads/:threadId
  async function patchThread(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const threadId = params['threadId']!
    const thread = await state.getThread(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }

    const body = await readJSON(req)
    if (!body) {
      sendError(res, 400, 'Request body required')
      return
    }

    const parsed = UpdateThreadSchema.safeParse(body)
    if (!parsed.success) {
      sendError(res, 400, parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; '))
      return
    }

    // Split the update across two writers because they have different
    // lifecycles. `title` and `status` are run-output state; `model` is
    // run-input state (what the next /run should dispatch with).
    const { model: modelChange, ...rest } = parsed.data
    if (modelChange !== undefined && modelChange !== null) {
      await state.setThreadModel(threadId, modelChange)
    }

    const updated = Object.keys(rest).length > 0
      ? await state.updateThread(threadId, rest)
      : await state.getThread(threadId)
    sendJSON(res, 200, updated)
  }

  // GET /api/v1/threads/:threadId/export?format=markdown|json
  async function exportThread(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const threadId = params['threadId']!
    const thread = await state.getThread(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const format = url.searchParams.get('format') ?? 'markdown'
    const messages = await state.getMessages(threadId)

    if (format === 'json') {
      sendJSON(res, 200, { thread, messages })
      return
    }

    // Markdown export
    const lines: string[] = []
    lines.push(`# ${thread.title ?? `Thread ${thread.id}`}`)
    lines.push('')
    lines.push(`**Profile:** ${thread.profileId}`)
    lines.push(`**Created:** ${thread.createdAt}`)
    lines.push(`**Messages:** ${thread.messageCount}`)
    lines.push('')
    lines.push('---')
    lines.push('')

    for (const msg of messages) {
      const roleLabel = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : msg.role
      lines.push(`## ${roleLabel}`)
      lines.push('')
      if (msg.content) {
        lines.push(msg.content)
        lines.push('')
      }
      if (msg.tools && msg.tools.length > 0) {
        for (const tool of msg.tools) {
          lines.push(`\`\`\`tool: ${tool.name}`)
          lines.push(typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2))
          lines.push('```')
          if (tool.output) {
            lines.push(`\`\`\`output`)
            lines.push(tool.output)
            lines.push('```')
          }
          lines.push('')
        }
      }
      lines.push('---')
      lines.push('')
    }

    const markdown = lines.join('\n')
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Length': Buffer.byteLength(markdown),
    })
    res.end(markdown)
  }

  // GET /api/v1/threads/:threadId/hydrate
  //
  // Single round-trip open for any thread, live or archived. Returns:
  //   - thread                : core Thread record (title, status, totals)
  //   - messages              : full consolidated UI-ready history
  //   - agents                : every agent_id that appears in
  //                             agent_events for this thread (root +
  //                             every sub-agent, including nested) so
  //                             sub-agent modals can enumerate helpers
  //                             without a second request
  //   - runningAgentId        : the currently streaming agent ('root'
  //                             when a live run is in flight, null when
  //                             terminal)
  //   - runningRunId          : the public durable run correlated to that
  //                             live stream, or null for terminal and
  //                             internal/legacy live work
  //   - maxSeq                : highest seq on the root agent's stream —
  //                             observability marker, NOT the cursor
  //                             the client should use for SSE reconnect
  //   - lastClosedTurnEndSeq  : highest retained seq of `turn.end`, or
  //                             the retained cursor floor after pruning.
  //                             THIS is the cursor a
  //                             reconnecting SSE client must pass as
  //                             `?since`. Replaying from the last closed
  //                             turn boundary lets the reducer rebuild
  //                             any in-flight turn (turn.start + deltas
  //                             + open tool calls) that hasn't yet hit
  //                             turn.end. Without it, a reconnect mid-
  //                             turn would drop every text.delta because
  //                             the reducer has no open exchange to
  //                             attach them to.
  //
  // Contract: the client uses this for EVERY thread open. If runningAgentId
  // is non-null, the client then opens an SSE stream on that agent with
  // `?since=lastClosedTurnEndSeq`. If runningAgentId is null, the
  // snapshot is complete and no SSE connection is needed.
  // When runningRunId is non-null, public clients may instead open the
  // run-bounded stream. This route deliberately does not guess a historical
  // run ID for archived messages.
  //
  // Authoritative-source note: once agent_events retention is enabled,
  // old threads' raw events are pruned. `messages` remains intact and
  // is sufficient to reconstruct the UI — hence the one-shot contract
  // that deliberately does not require event replay.
  async function hydrateThread(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const threadId = params['threadId']!
    const thread = await state.getThreadAnywhere(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }

    const principal = getRequestPrincipal(req)
    if (!authorizePrincipalScope(req, {
      workspaceId: thread.workspaceId ?? undefined,
      profileId: thread.profileId,
    }) || (principal?.kind === 'delegated' &&
      !await state.securityRepositories.threadBindings.allows(
        threadId,
        principalContinuityKey(principal),
      ))) {
      sendError(
        res,
        403,
        'Delegated principal does not allow this thread hydration',
        'principal_scope_denied',
        'auth',
      )
      return
    }

    // If a run ends or another starts while storage is being read, repeat the
    // projection once. SessionRunner removes a run only after its final
    // messages and events have been persisted, so the second read closes the
    // active -> terminal race without inventing a cross-store transaction.
    let observedRun = deps.runner?.get(threadId)
    let [messages, agents, maxSeq, firstRetainedSeq, lastTurnEndSeq] = await Promise.all([
      state.getMessages(threadId),
      state.listAgentsForThread(threadId),
      state.getAgentEventMaxSeq(threadId, ROOT_AGENT_ID),
      state.getAgentEventMinSeq(threadId, ROOT_AGENT_ID, -1),
      state.getLastTurnEndSeq(threadId, ROOT_AGENT_ID),
    ])
    let currentRun = deps.runner?.get(threadId)
    if (observedRun?.runId !== currentRun?.runId) {
      observedRun = currentRun
      ;[messages, agents, maxSeq, firstRetainedSeq, lastTurnEndSeq] = await Promise.all([
        state.getMessages(threadId),
        state.listAgentsForThread(threadId),
        state.getAgentEventMaxSeq(threadId, ROOT_AGENT_ID),
        state.getAgentEventMinSeq(threadId, ROOT_AGENT_ID, -1),
        state.getLastTurnEndSeq(threadId, ROOT_AGENT_ID),
      ])
      currentRun = deps.runner?.get(threadId)
    }

    const runningAgentId = currentRun === undefined ? null : ROOT_AGENT_ID
    const durableRun = currentRun === undefined
      ? null
      : await deps.runStore?.get(currentRun.runId) ?? null
    const runningRunId = durableRun !== null && !durableRun.terminal &&
      durableRun.threadId === threadId
      ? durableRun.runId
      : null
    const retainedCursorFloor = firstRetainedSeq === null
      ? maxSeq
      : Math.max(0, firstRetainedSeq - 1)
    const lastClosedTurnEndSeq = Math.max(
      lastTurnEndSeq,
      retainedCursorFloor,
    )

    const hydration = {
      thread,
      messages,
      agents,
      runningAgentId,
      runningRunId,
      maxSeq,
      lastClosedTurnEndSeq,
    } satisfies ThreadHydration
    sendJSON(res, 200, hydration, { 'Cache-Control': 'no-store' })
  }

  return {
    listThreads,
    createThread,
    getThread,
    patchThread,
    deleteThread,
    getMessages,
    exportThread,
    hydrateThread,
  }
}
