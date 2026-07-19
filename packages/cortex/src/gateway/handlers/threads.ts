/**
 * Thread management handlers.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJSON, sendError, readJSON } from '../router.js'
import type { GatewayState } from '../state.js'
import type { SessionRunner } from '../session-runner.js'
import { ROOT_AGENT_ID } from '../event-bus.js'
import { UpdateThreadSchema } from '../validation/schemas.js'

export interface ThreadHandlerDeps {
  /**
   * The runner exposes liveness — used by /hydrate so the client can tell
   * "this thread is still streaming, open SSE" vs "this thread is
   * terminal, use the snapshot".
   */
  readonly runner?: SessionRunner
}

export function createThreadHandlers(state: GatewayState, deps: ThreadHandlerDeps = {}) {

  // GET /api/v1/threads?profileId=coder
  async function listThreads(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const profileId = url.searchParams.get('profileId') ?? undefined
    sendJSON(res, 200, state.listThreads(profileId))
  }

  // POST /api/v1/threads
  async function createThread(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJSON<{ profileId?: string; title?: string; workspaceId?: string }>(req)
    const profileId = body?.profileId ?? 'example'
    const title = body?.title
    const workspaceId = body?.workspaceId

    const thread = state.createThread(profileId, title ?? undefined, workspaceId ?? undefined)
    sendJSON(res, 201, thread)
  }

  // GET /api/v1/threads/:threadId
  async function getThread(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const threadId = params['threadId']!
    const thread = state.getThread(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }

    const messages = state.getMessages(threadId)
    sendJSON(res, 200, { ...thread, messages })
  }

  // DELETE /api/v1/threads/:threadId
  async function deleteThread(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const threadId = params['threadId']!
    const deleted = state.deleteThread(threadId)
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
    const thread = state.getThread(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }

    sendJSON(res, 200, state.getMessages(threadId))
  }

  // PATCH /api/v1/threads/:threadId
  async function patchThread(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const threadId = params['threadId']!
    const thread = state.getThread(threadId)
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
      state.setThreadModel(threadId, modelChange)
    }

    const updated = Object.keys(rest).length > 0
      ? state.updateThread(threadId, rest)
      : state.getThread(threadId)
    sendJSON(res, 200, updated)
  }

  // GET /api/v1/threads/:threadId/export?format=markdown|json
  async function exportThread(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const threadId = params['threadId']!
    const thread = state.getThread(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const format = url.searchParams.get('format') ?? 'markdown'
    const messages = state.getMessages(threadId)

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
  //
  // Authoritative-source note: once agent_events retention is enabled,
  // old threads' raw events are pruned. `messages` remains intact and
  // is sufficient to reconstruct the UI — hence the one-shot contract
  // that deliberately does not require event replay.
  async function hydrateThread(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const threadId = params['threadId']!
    const thread = state.getThreadAnywhere(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }

    const messages = state.getMessages(threadId)
    const agents = state.listAgentsForThread(threadId)
    const runningAgentId = deps.runner?.isRunning(threadId) ? ROOT_AGENT_ID : null
    const maxSeq = state.getAgentEventMaxSeq(threadId, ROOT_AGENT_ID)
    const firstRetainedSeq = state.getAgentEventMinSeq(threadId, ROOT_AGENT_ID, -1)
    const retainedCursorFloor = firstRetainedSeq === null
      ? maxSeq
      : Math.max(0, firstRetainedSeq - 1)
    const lastClosedTurnEndSeq = Math.max(
      state.getLastTurnEndSeq(threadId, ROOT_AGENT_ID),
      retainedCursorFloor,
    )

    sendJSON(res, 200, {
      thread,
      messages,
      agents,
      runningAgentId,
      maxSeq,
      lastClosedTurnEndSeq,
    })
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
