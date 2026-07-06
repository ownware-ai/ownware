/**
 * Debug handlers — raw event log access for debugging and timeline analysis.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJSON, sendError } from '../router.js'
import type { GatewayState } from '../state.js'

export function createDebugHandlers(state: GatewayState) {

  // GET /api/v1/debug/events?threadId=xxx&type=xxx&agentId=xxx&limit=500&since=xxx
  async function getEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const threadId = url.searchParams.get('threadId')

    if (!threadId) {
      sendError(res, 400, 'Missing required query param: threadId')
      return
    }

    const thread = state.getThread(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }

    const type = url.searchParams.get('type') ?? undefined
    const agentId = url.searchParams.get('agentId') ?? undefined
    const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!) : 500
    const since = url.searchParams.has('since') ? parseInt(url.searchParams.get('since')!) : undefined

    const log = state.getEventLog(threadId, { type, agentId, limit, since })
    sendJSON(res, 200, log)
  }

  // GET /api/v1/debug/events/:threadId/timeline
  async function getTimeline(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const threadId = params['threadId']!
    const thread = state.getThread(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }

    const log = state.getEventLog(threadId)
    if (log.length === 0) {
      sendJSON(res, 200, [])
      return
    }

    const baseTs = log[0]!.ts
    const timeline = log.map((entry, i) => ({
      event: entry.event.type,
      ts: entry.ts - baseTs,
      gap: i === 0 ? 0 : entry.ts - log[i - 1]!.ts,
      data: entry.event,
    }))

    sendJSON(res, 200, timeline)
  }

  return { getEvents, getTimeline }
}
