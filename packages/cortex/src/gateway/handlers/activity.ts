/**
 * Activity feed handler — running + recently completed agent threads.
 *
 * GET /api/v1/activity?workspace=&profile=&status=&limit=50
 *
 * Merges in-memory running agents with DB thread history.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJSON } from '../router.js'
import type { GatewayState } from '../state.js'
import type { ActivityEntry } from '../types.js'

/** Maximum limit for activity query. */
const MAX_LIMIT = 200

/** Default limit for activity query. */
const DEFAULT_LIMIT = 50

export function createActivityHandlers(state: GatewayState) {

  // GET /api/v1/activity
  async function getActivity(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const workspaceFilter = url.searchParams.get('workspace') ?? undefined
    const profileFilter = url.searchParams.get('profile') ?? undefined
    const statusFilter = url.searchParams.get('status') ?? undefined
    const rawLimit = url.searchParams.get('limit')
    const limit = rawLimit ? Math.min(Math.max(parseInt(rawLimit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT) : DEFAULT_LIMIT

    const entries: ActivityEntry[] = []

    // 1. Running agents from in-memory state
    const runtimes = state.listActiveRuntimes()
    for (const { threadId } of runtimes) {
      const thread = state.getThread(threadId)
      if (!thread) continue

      // Apply filters
      if (workspaceFilter && thread.workspaceId !== workspaceFilter) continue
      if (profileFilter && thread.profileId !== profileFilter) continue

      entries.push({
        id: thread.id,
        profileId: thread.profileId,
        threadId: thread.id,
        workspaceId: thread.workspaceId,
        status: 'running',
        title: thread.title,
        elapsedMs: Date.now() - new Date(thread.updatedAt).getTime(),
        tokens: thread.totalTokens,
        cost: thread.totalCost,
        updatedAt: thread.updatedAt,
      })
    }

    // 2. Recent threads from DB (completed/idle)
    const dbThreads = state.listThreads(profileFilter, { limit: limit * 2 })
    for (const thread of dbThreads.items) {
      // Skip if already in running list
      if (entries.some(e => e.id === thread.id)) continue

      // Apply workspace filter
      if (workspaceFilter && thread.workspaceId !== workspaceFilter) continue

      const entryStatus = thread.status === 'error' ? 'error' as const
        : thread.status === 'completed' ? 'completed' as const
        : 'idle' as const

      entries.push({
        id: thread.id,
        profileId: thread.profileId,
        threadId: thread.id,
        workspaceId: thread.workspaceId,
        status: entryStatus,
        title: thread.title,
        elapsedMs: null,
        tokens: thread.totalTokens,
        cost: thread.totalCost,
        updatedAt: thread.updatedAt,
      })
    }

    // 3. Apply status filter
    let filtered = statusFilter
      ? entries.filter(e => e.status === statusFilter)
      : entries

    // 4. Sort by recency (running first, then by updatedAt desc)
    filtered.sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1
      if (b.status === 'running' && a.status !== 'running') return 1
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })

    // 5. Apply limit
    const limited = filtered.slice(0, limit)

    const running = entries.filter(e => e.status === 'running').length
    const idle = entries.filter(e => e.status === 'idle').length

    sendJSON(res, 200, {
      data: limited,
      total: filtered.length,
      running,
      idle,
    })
  }

  return { getActivity }
}
