/**
 * Memory HTTP + SSE handlers.
 *
 * Endpoints:
 *
 *   GET    /api/v1/profiles/:profileId/memories
 *            ?status=active|archived|superseded|all (default active)
 *            ?limit=N (default 200) ?offset=N
 *   POST   /api/v1/profiles/:profileId/memories         — manual user pin
 *   PATCH  /api/v1/memories/:id                          — edit / pin / archive
 *   DELETE /api/v1/memories/:id                          — hard remove
 *
 *   GET    /api/v1/profiles/:profileId/memories/proposals
 *            ?status=pending|accepted|rejected|edited|all (default pending)
 *   GET    /api/v1/threads/:threadId/memories/proposals  — per-thread variant
 *   POST   /api/v1/memories/proposals/:id/accept         — body may edit content/kind/pin
 *   POST   /api/v1/memories/proposals/:id/reject         — optional reason
 *
 *   GET    /api/v1/user/identity                         — global identity
 *   PUT    /api/v1/user/identity                         — partial update
 *
 *   GET    /api/v1/memory/events                         — SSE invalidation stream
 *
 * Following the gateway's "SSE never carries business payloads" rule
 * (root CLAUDE.md), `memory.events` only ships invalidation HINTS:
 * `{ type, profileId?, memoryId?, proposalId? }`. Clients refetch via
 * HTTP to read actual data. This keeps ownware.db as the single source
 * of truth and eliminates write-ordering races between SSE and reads.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { sendError, sendJSON, readJSON } from '../router.js'
import { startSSE, writeSSE } from '../sse.js'
import {
  CreateMemoryRequestSchema,
  UpdateMemoryRequestSchema,
  AcceptProposalRequestSchema,
  RejectProposalRequestSchema,
  UpdateUserIdentityRequestSchema,
  MemoryStatusSchema,
  ProposalStatusSchema,
  type MemorySystem,
  type MemoryEvent,
} from '../../memory/index.js'

const HEARTBEAT_INTERVAL_MS = 30_000

// Optional status filter accepts the schema enum or the literal 'all'.
const MemoryStatusFilterSchema = z.union([MemoryStatusSchema, z.literal('all')])
const ProposalStatusFilterSchema = z.union([ProposalStatusSchema, z.literal('all')])

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface MemoryHandlerDeps {
  readonly system: MemorySystem
}

export function createMemoryHandlers(deps: MemoryHandlerDeps) {
  const { system } = deps

  // ── Memories CRUD ─────────────────────────────────────────────────

  async function listMemories(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const profileId = params['profileId']
    if (!profileId) {
      sendError(res, 400, 'Missing profileId')
      return
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const statusRaw = url.searchParams.get('status') ?? 'active'
    const limitRaw = url.searchParams.get('limit')
    const offsetRaw = url.searchParams.get('offset')

    const statusParsed = MemoryStatusFilterSchema.safeParse(statusRaw)
    if (!statusParsed.success) {
      sendError(res, 400, `Invalid status: "${statusRaw}".`)
      return
    }
    const limit = clampInt(parseInt(limitRaw ?? '200', 10), 1, 1000, 200)
    const offset = clampInt(parseInt(offsetRaw ?? '0', 10), 0, 1_000_000, 0)

    const items = system.memories.listForProfile(profileId, {
      status: statusParsed.data,
      limit,
      offset,
    })
    const total = system.memories.countForProfile(profileId, statusParsed.data)
    sendJSON(res, 200, { items, total, limit, offset })
  }

  async function createMemory(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const profileId = params['profileId']
    if (!profileId) {
      sendError(res, 400, 'Missing profileId')
      return
    }
    const body = await readJSON<unknown>(req)
    const parsed = CreateMemoryRequestSchema.safeParse({
      ...(typeof body === 'object' && body !== null ? body : {}),
      profileId,
    })
    if (!parsed.success) {
      sendError(res, 400, formatZodIssues(parsed.error))
      return
    }
    const memory = system.memories.create({
      profileId,
      content: parsed.data.content,
      kind: parsed.data.kind,
      source: 'user_pinned',
      confidence: 1.0,
      pinned: parsed.data.pinned,
    })
    sendJSON(res, 201, { memory })
  }

  async function updateMemory(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id']
    if (!id) {
      sendError(res, 400, 'Missing memory id')
      return
    }
    const body = await readJSON<unknown>(req)
    const parsed = UpdateMemoryRequestSchema.safeParse(body ?? {})
    if (!parsed.success) {
      sendError(res, 400, formatZodIssues(parsed.error))
      return
    }
    const updated = system.memories.update(id, parsed.data)
    if (!updated) {
      sendError(res, 404, `Memory "${id}" not found`)
      return
    }
    sendJSON(res, 200, { memory: updated })
  }

  async function deleteMemory(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id']
    if (!id) {
      sendError(res, 400, 'Missing memory id')
      return
    }
    const ok = system.memories.remove(id)
    if (!ok) {
      sendError(res, 404, `Memory "${id}" not found`)
      return
    }
    sendJSON(res, 200, { ok: true })
  }

  // ── Proposals ─────────────────────────────────────────────────────

  async function listProposalsForProfile(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const profileId = params['profileId']
    if (!profileId) {
      sendError(res, 400, 'Missing profileId')
      return
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const statusRaw = url.searchParams.get('status') ?? 'pending'
    const limitRaw = url.searchParams.get('limit')

    const statusParsed = ProposalStatusFilterSchema.safeParse(statusRaw)
    if (!statusParsed.success) {
      sendError(res, 400, `Invalid status: "${statusRaw}".`)
      return
    }
    const limit = clampInt(parseInt(limitRaw ?? '100', 10), 1, 500, 100)

    const items = system.proposals.listForProfile(profileId, {
      status: statusParsed.data,
      limit,
    })
    const pendingCount = system.proposals.countPendingForProfile(profileId)
    sendJSON(res, 200, { items, pendingCount })
  }

  async function listProposalsForThread(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const threadId = params['threadId']
    if (!threadId) {
      sendError(res, 400, 'Missing threadId')
      return
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const statusRaw = url.searchParams.get('status') ?? 'pending'
    const limitRaw = url.searchParams.get('limit')

    const statusParsed = ProposalStatusFilterSchema.safeParse(statusRaw)
    if (!statusParsed.success) {
      sendError(res, 400, `Invalid status: "${statusRaw}".`)
      return
    }
    const limit = clampInt(parseInt(limitRaw ?? '100', 10), 1, 500, 100)
    const items = system.proposals.listForThread(threadId, {
      status: statusParsed.data,
      limit,
    })
    sendJSON(res, 200, { items })
  }

  async function acceptProposal(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id']
    if (!id) {
      sendError(res, 400, 'Missing proposal id')
      return
    }
    const body = await readJSON<unknown>(req)
    const parsed = AcceptProposalRequestSchema.safeParse(body ?? {})
    if (!parsed.success) {
      sendError(res, 400, formatZodIssues(parsed.error))
      return
    }
    try {
      const result = system.proposals.accept(id, parsed.data)
      if (!result) {
        sendError(res, 404, `Proposal "${id}" not found`)
        return
      }
      sendJSON(res, 200, result)
    } catch (err) {
      sendError(res, 409, err instanceof Error ? err.message : String(err))
    }
  }

  async function rejectProposal(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id']
    if (!id) {
      sendError(res, 400, 'Missing proposal id')
      return
    }
    const body = await readJSON<unknown>(req)
    const parsed = RejectProposalRequestSchema.safeParse(body ?? {})
    if (!parsed.success) {
      sendError(res, 400, formatZodIssues(parsed.error))
      return
    }
    try {
      const proposal = system.proposals.reject(id, parsed.data.reason ?? null)
      if (!proposal) {
        sendError(res, 404, `Proposal "${id}" not found`)
        return
      }
      sendJSON(res, 200, { proposal })
    } catch (err) {
      sendError(res, 409, err instanceof Error ? err.message : String(err))
    }
  }

  // ── User identity ─────────────────────────────────────────────────

  async function getIdentity(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    sendJSON(res, 200, { identity: system.identity.get() })
  }

  async function putIdentity(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJSON<unknown>(req)
    const parsed = UpdateUserIdentityRequestSchema.safeParse(body ?? {})
    if (!parsed.success) {
      sendError(res, 400, formatZodIssues(parsed.error))
      return
    }
    const updated = system.identity.set(parsed.data)
    sendJSON(res, 200, { identity: updated })
  }

  // ── SSE: invalidation hints ───────────────────────────────────────

  async function streamMemoryEvents(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    startSSE(res)
    res.write(':ready\n\n')

    const queue: MemoryEvent[] = []
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

    const unsubscribe = system.bus.subscribe((ev) => {
      queue.push(ev)
      void drain()
    })

    const heartbeat = setInterval(() => {
      if (res.writableEnded) return
      void writeSSE(res, 'heartbeat', { type: 'heartbeat', ts: Date.now() })
    }, HEARTBEAT_INTERVAL_MS)

    const cleanup = (): void => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  return {
    listMemories,
    createMemory,
    updateMemory,
    deleteMemory,
    listProposalsForProfile,
    listProposalsForThread,
    acceptProposal,
    rejectProposal,
    getIdentity,
    putIdentity,
    streamMemoryEvents,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  if (Number.isNaN(n)) return fallback
  return Math.max(lo, Math.min(hi, Math.floor(n)))
}

function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.join('.') || 'body'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}
