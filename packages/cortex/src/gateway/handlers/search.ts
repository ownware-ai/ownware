/**
 * Search handler.
 *
 * GET /search?q=&scope=all|threads|profiles|workspaces&limit=20
 * Searches across threads, profiles, and workspaces with relevance scoring.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJSON, sendError } from '../router.js'
import type { GatewayState } from '../state.js'
import type { ProfileRegistry } from '../../profile/registry.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchResult {
  readonly type: 'thread' | 'profile' | 'workspace'
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly score: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createSearchHandlers(state: GatewayState, registry: ProfileRegistry) {

  // GET /api/v1/search?q=&scope=&limit=
  async function search(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const q = url.searchParams.get('q')?.trim() ?? ''
    const scope = url.searchParams.get('scope') ?? 'all'
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, MAX_LIMIT)

    if (!q) {
      sendJSON(res, 200, [])
      return
    }

    const validScopes = ['all', 'threads', 'profiles', 'workspaces']
    if (!validScopes.includes(scope)) {
      sendError(res, 400, `Invalid scope: ${scope}. Must be one of: ${validScopes.join(', ')}`)
      return
    }

    const results: SearchResult[] = []
    const qLower = q.toLowerCase()

    // Search threads
    if (scope === 'all' || scope === 'threads') {
      const threads = state.listThreads(undefined, { limit: 200 })
      for (const thread of threads.items) {
        const title = thread.title ?? ''
        const score = scoreMatch(title, qLower)
        if (score > 0) {
          results.push({
            type: 'thread',
            id: thread.id,
            name: title,
            description: thread.lastMessagePreview,
            score,
          })
        }
      }
    }

    // Search profiles
    if (scope === 'all' || scope === 'profiles') {
      const profiles = registry.list()
      for (const entry of profiles) {
        const nameScore = scoreMatch(entry.name, qLower)
        const descScore = scoreMatch(entry.description ?? '', qLower) * 0.5
        const score = Math.max(nameScore, descScore)
        if (score > 0) {
          results.push({
            type: 'profile',
            id: entry.name,
            name: entry.name,
            description: entry.description ?? null,
            score,
          })
        }
      }
    }

    // Search workspaces
    if (scope === 'all' || scope === 'workspaces') {
      const workspaces = state.listWorkspaces(undefined, { limit: 200 })
      for (const ws of workspaces.items) {
        const nameScore = scoreMatch(ws.name, qLower)
        const pathScore = scoreMatch(ws.path, qLower) * 0.3
        const score = Math.max(nameScore, pathScore)
        if (score > 0) {
          results.push({
            type: 'workspace',
            id: ws.id,
            name: ws.name,
            description: ws.path,
            score,
          })
        }
      }
    }

    // Sort by relevance (highest first), then take limit
    results.sort((a, b) => b.score - a.score)
    sendJSON(res, 200, results.slice(0, limit))
  }

  return { search }
}

// ---------------------------------------------------------------------------
// Scoring: exact match (100) > starts-with (75) > contains (50)
// ---------------------------------------------------------------------------

export function scoreMatch(text: string, query: string): number {
  const lower = text.toLowerCase()
  if (lower === query) return 100
  if (lower.startsWith(query)) return 75
  if (lower.includes(query)) return 50
  return 0
}
