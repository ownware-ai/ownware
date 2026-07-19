/**
 * Permission history endpoint.
 *
 *   GET /api/v1/permissions
 *
 * Scans every thread's agent_events table for `permission.request` +
 * `permission.response` events, pairs them by requestId, and returns a
 * flat audit log. The client's Settings → Permissions page reads from here
 * to show the user every decision they've made across every thread.
 *
 * The permission.request event carries safe identity, an HMAC operation hash
 * and a content-free input summary; raw model input is never retained. The
 * permission.response event carries `{ requestId, granted }`.
 * We join them so each record is "what was asked + what was decided".
 *
 * No pagination yet — the data set is bounded by the number of tool-use
 * calls that actually triggered HITL approval. If this grows past a few
 * thousand rows, add `?limit` + `?offset`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJSON, sendError, sendJSON } from '../router.js'
import type { GatewayState } from '../state.js'
import { permissionStore, type SavedPermissionRule } from '../../permissions/store.js'

interface PermissionRecord {
  readonly threadId: string
  readonly threadTitle: string | null
  /** Profile that owns the thread — what the user thinks of as
   * "which agent decided this". The frontend Profile filter dropdown
   * matches against this. The previously-emitted `agentId` is a
   * unique run-instance id (e.g. `agent-abc-123`) which doesn't
   * match anything the user can pick from a list — keeping it for
   * debug surfaces but the new field is the canonical filter key. */
  readonly profileId: string | null
  readonly agentId: string
  readonly requestId: string
  readonly toolName: string
  readonly target: string | null
  readonly reason: string
  readonly decision: 'granted' | 'denied'
  readonly decidedAt: string
  readonly requestedAt: string
}

interface PermissionListResponse {
  readonly items: readonly PermissionRecord[]
  readonly total: number
}

/** Pull a user-visible target path/command/query out of a tool input blob. */
function extractTarget(input: unknown): string | null {
  if (input == null || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  if (typeof o['file_path'] === 'string') return o['file_path']
  if (typeof o['path'] === 'string') return o['path']
  if (typeof o['command'] === 'string') return o['command']
  if (typeof o['url'] === 'string') return o['url']
  if (typeof o['query'] === 'string') return `"${o['query']}"`
  if (typeof o['pattern'] === 'string') return `"${o['pattern']}"`
  return null
}

export function createPermissionHandlers(state: GatewayState) {
  /**
   * GET /api/v1/permissions
   *
   * Returns every permission decision recorded in agent_events, joined
   * request↔response and sorted newest-first.
   */
  async function listPermissions(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Walk every thread, pull its permission events. The number of threads
    // is bounded (tens to a few hundred), so a thread-by-thread scan is
    // acceptable here. If this grows, add a dedicated SQL query.
    const threadsResult = state.listThreads(undefined, { limit: 1000, offset: 0 })
    const threads = threadsResult.items

    interface PendingRequest {
      readonly threadId: string
      readonly threadTitle: string | null
      readonly profileId: string | null
      readonly agentId: string
      readonly requestId: string
      readonly toolName: string
      readonly target: string | null
      readonly reason: string
      readonly requestedAt: string
    }

    const records: PermissionRecord[] = []

    for (const thread of threads) {
      const agents = state.listAgentsForThread(thread.id)
      for (const agent of agents) {
        const events = state.listAgentEvents({
          threadId: thread.id,
          agentId: agent.agentId,
        })

        // Index request events by requestId so we can join the response
        const pending = new Map<string, PendingRequest>()

        for (const ev of events) {
          const payload = ev.payload as Record<string, unknown>

          if (ev.type === 'permission.request') {
            const requestId = typeof payload['requestId'] === 'string' ? payload['requestId'] : null
            if (requestId == null) continue
            const toolName = typeof payload['toolName'] === 'string' ? payload['toolName'] : 'unknown'
            const reason = typeof payload['reason'] === 'string' ? payload['reason'] : ''
            pending.set(requestId, {
              threadId: thread.id,
              threadTitle: thread.title ?? null,
              profileId: thread.profileId ?? null,
              agentId: agent.agentId,
              requestId,
              toolName,
              target: extractTarget(payload['input'])
                ?? (typeof payload['inputSummary'] === 'string' ? payload['inputSummary'] : null),
              reason,
              requestedAt: new Date(ev.createdAt).toISOString(),
            })
            continue
          }

          if (ev.type === 'permission.response') {
            const requestId = typeof payload['requestId'] === 'string' ? payload['requestId'] : null
            if (requestId == null) continue
            const req = pending.get(requestId)
            if (req == null) continue
            const granted = payload['granted'] === true
            records.push({
              ...req,
              decision: granted ? 'granted' : 'denied',
              decidedAt: new Date(ev.createdAt).toISOString(),
            })
            pending.delete(requestId)
          }
        }
      }
    }

    // Newest first
    records.sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1))

    const response: PermissionListResponse = {
      items: records,
      total: records.length,
    }
    sendJSON(res, 200, response)
  }

  /**
   * GET /api/v1/permissions/rules
   *
   * Aggregates the persistent permission rules saved across every
   * profile under `~/.ownware/permissions/<profileId>.json`. Each
   * returned row carries its profileId so the Settings → Permissions
   * "Saved rules" tab can group them. Read-only in this slice; edit
   * endpoints land in Phase 4.
   *
   * The store handles disk I/O, JSON parsing, defensive validation,
   * and the NEVER-zone safeguard (zone 6 allow rules are stripped at
   * load time). Failures fall through as empty lists rather than 500s
   * — a missing or unreadable profile file is "no rules saved", not
   * a server error.
   */
  async function listPermissionRules(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    interface RuleRecord {
      readonly profileId: string
      readonly toolPattern: string
      readonly maxZone: number
      // Only 'allow' is meaningful post-2026-05-14 redesign — see
      // SavedPermissionRule in packages/cortex/src/permissions/store.ts.
      readonly decision: 'allow'
      readonly createdAt: string
      readonly reason?: string
    }

    let profileIds: string[]
    try {
      profileIds = await permissionStore.listProfiles()
    } catch {
      profileIds = []
    }

    const records: RuleRecord[] = []
    for (const profileId of profileIds) {
      let permissions: { rules: SavedPermissionRule[] } = { rules: [] }
      try {
        permissions = await permissionStore.load(profileId)
      } catch {
        continue
      }
      for (const rule of permissions.rules) {
        const out: RuleRecord = {
          profileId,
          toolPattern: rule.toolPattern,
          maxZone: rule.maxZone,
          decision: rule.decision,
          createdAt: rule.createdAt,
          ...(rule.reason !== undefined ? { reason: rule.reason } : {}),
        }
        records.push(out)
      }
    }

    // Newest first — same convention as listPermissions.
    records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

    sendJSON(res, 200, { items: records, total: records.length })
  }

  /**
   * GET /api/v1/permissions/workspace-roots
   *
   * Aggregates active session-scope folder grants across every
   * thread that currently holds a SessionCompanions slot. Includes
   * paused / idle threads — not just actively-iterating runs — so a
   * user who granted access to a folder, then walked away, still
   * sees the grant when they open Settings → Permissions.
   *
   * Output shape:
   *   {
   *     groups: [
   *       { threadId, threadTitle, profileId, items: [{ path }, ...] }
   *     ],
   *     totalGrants: number
   *   }
   *
   * Threads with empty grant lists are omitted so the UI doesn't
   * render bare "no grants" rows for every running thread.
   */
  async function listAllWorkspaceRoots(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    interface Group {
      threadId: string
      threadTitle: string | null
      profileId: string | null
      items: { path: string }[]
    }
    const groups: Group[] = []
    let total = 0

    for (const { threadId, companions } of state.iterSessionCompanions()) {
      const roots = companions.sessionAdditionalRoots ?? []
      if (roots.length === 0) continue
      const thread = state.getThread(threadId)
      groups.push({
        threadId,
        threadTitle: thread?.title ?? null,
        profileId: thread?.profileId ?? null,
        items: roots.map(p => ({ path: p })),
      })
      total += roots.length
    }

    sendJSON(res, 200, { groups, totalGrants: total })
  }

  /**
   * DELETE /api/v1/permissions/rules
   *
   * Revokes a saved "Always allow" rule for a profile/toolPattern pair.
   * Body: `{ profileId: string, toolPattern: string }`. Removes the
   * matching entry from `~/.ownware/permissions/<profileId>.json` and
   * returns `{ removed: 0 | 1 }` so retries don't error.
   *
   * S6 of the 2026-05-14 permission redesign closes the gap where
   * the client's Settings → Permissions tab could list saved rules but
   * couldn't revoke them — the Remove button was disabled with a
   * "coming next release" tooltip. The persistence layer (the
   * `PermissionStore`) already exposed `revokeRule`; this handler is
   * the canonical wire-side write path so the client never touches the
   * filesystem directly.
   *
   * Idempotent: revoking a rule that was already gone returns 200
   * with `{ removed: 0 }` rather than 404, matching the
   * `DELETE /threads/:id/workspace-roots` convention.
   */
  async function revokePermissionRule(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJSON<{ profileId?: unknown; toolPattern?: unknown }>(req)
    if (!body || typeof body.profileId !== 'string' || body.profileId.length === 0) {
      sendError(res, 400, 'Missing required field: profileId (string)')
      return
    }
    if (typeof body.toolPattern !== 'string' || body.toolPattern.length === 0) {
      sendError(res, 400, 'Missing required field: toolPattern (string)')
      return
    }

    try {
      const removed = await permissionStore.revokeRule(body.profileId, body.toolPattern)

      // BUG #8 — disk revoke alone is not enough. The profile assembler
      // pre-populates `ZoneManager.expansions` from saved rules at
      // session start (assembler.ts `createZoneManager`), so until the
      // session ends the live in-memory expansion keeps upgrading
      // 'ask' to 'allow' even after the disk row is gone. Poke every
      // live ZoneManager that belongs to a thread on this profile so
      // the change takes effect on the very next tool call.
      //
      // Idempotent: `ZoneManager.revokeExpansion` returns false when
      // nothing matched (e.g. a runtime grant was scoped 'once' and
      // already consumed) — we don't surface that to the caller. The
      // disk `removed` flag is the canonical return signal.
      for (const { threadId, companions } of state.iterSessionCompanions()) {
        if (!companions.zoneManager) continue
        const thread = state.getThread(threadId)
        if (thread?.profileId !== body.profileId) continue
        companions.zoneManager.revokeExpansion(body.toolPattern)
      }

      sendJSON(res, 200, { removed: removed ? 1 : 0 })
    } catch (err) {
      // Disk write errors are observable but non-fatal — surface as 500
      // so the UI can show a retry rather than silently failing.
      sendError(
        res,
        500,
        `Failed to revoke rule: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return {
    listPermissions,
    listPermissionRules,
    listAllWorkspaceRoots,
    revokePermissionRule,
  }
}
