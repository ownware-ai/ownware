/**
 * Approvals HTTP handlers (Slice 8d-3) — the cross-agent "Approvals" inbox
 * backbone: list pending drafts, count (the badge), get one, discard one.
 *
 *   GET  /api/v1/approvals            inbox (?profileId=, ?limit=) — pending, newest first
 *   GET  /api/v1/approvals/count      pending count (?profileId=) — the sidebar/dock badge
 *   GET  /api/v1/approvals/:id        one approval
 *   POST /api/v1/approvals/:id/discard  drop a draft — it is NEVER executed
 *   POST /api/v1/approvals/:id/approve  re-execute the EXACT held call (8d-4)
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ToolResult } from '@ownware/loom'
import { sendError, sendJSON } from '../router.js'
import type { ApprovalRepository, ScheduleRepository } from '../../storage/platform-repositories.js'

/** Re-execute the exact held tool call with the user's credentials (8d-4).
 *  Implemented by the run handlers, where the registry + credential vault live. */
export type ExecuteHeldTool = (params: {
  readonly profileId: string
  readonly threadId: string | null
  readonly workspaceId?: string
  readonly safetyLevel: 'read-only' | 'draft-approval' | 'full-access'
  readonly toolName: string
  readonly toolInput: unknown
  readonly policyRevision: string
  readonly toolRevision: string
  readonly targetRevision: string | null
}) => Promise<ToolResult>

export interface ApprovalHandlerDeps {
  readonly store: ApprovalRepository
  /** To resolve an approval's schedule → its profile + workspace. */
  readonly scheduleStore: ScheduleRepository
  /** Re-execute the held call on approve (8d-4). */
  readonly executeHeldTool: ExecuteHeldTool
}

export function createApprovalHandlers(deps: ApprovalHandlerDeps) {
  const { store, scheduleStore, executeHeldTool } = deps

  // GET /api/v1/approvals?profileId=&limit=
  async function listApprovals(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const profileId = url.searchParams.get('profileId') ?? undefined
    const limitRaw = Number(url.searchParams.get('limit'))
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200
    sendJSON(res, 200, {
      approvals: await store.listPending({ ...(profileId != null ? { profileId } : {}), limit }),
    })
  }

  // GET /api/v1/approvals/count?profileId= — literal route; registered BEFORE
  // /approvals/:id or ":id" would swallow "count".
  async function countApprovals(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const profileId = url.searchParams.get('profileId') ?? undefined
    sendJSON(res, 200, { count: await store.countPending(profileId) })
  }

  // GET /api/v1/approvals/:id
  async function getApproval(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const approval = await store.get(params['id'] ?? '')
    if (approval == null) {
      sendError(res, 404, `Approval "${params['id']}" not found`)
      return
    }
    sendJSON(res, 200, { approval })
  }

  // POST /api/v1/approvals/:id/discard
  async function discardApproval(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id'] ?? ''
    if (await store.get(id) == null) {
      sendError(res, 404, `Approval "${id}" not found`)
      return
    }
    // decide() only transitions a still-pending row (idempotent); a discarded
    // draft is never executed.
    sendJSON(res, 200, { approval: await store.decide(id, { status: 'discarded' }) })
  }

  // POST /api/v1/approvals/:id/approve — re-execute the EXACT held call (8d-4).
  async function approveApproval(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id'] ?? ''
    const approval = await store.get(id)
    if (approval == null) {
      sendError(res, 404, `Approval "${id}" not found`)
      return
    }
    // Idempotent + at-most-once: only a still-pending row may acquire the
    // durable claim. A non-pending approval is returned as-is.
    if (approval.status !== 'pending') {
      sendJSON(res, 200, { approval })
      return
    }
    const claimed = await store.claim(id)
    if (claimed.status !== 'claimed') {
      sendJSON(res, claimed.status === 'intent_mismatch' ? 409 : 200, {
        approval: claimed.approval,
        ...(claimed.status === 'intent_mismatch'
          ? { code: 'approval_intent_mismatch' }
          : {}),
      })
      return
    }

    // SECURITY: the action, args and binding come ONLY from the atomically
    // claimed durable row — never the request body.
    const bound = claimed.approval
    const schedule = await scheduleStore.get(bound.scheduleId)
    if (schedule == null) {
      sendJSON(res, 200, {
        approval: await store.decide(id, {
          status: 'failed',
          errorMessage: 'The schedule disappeared after this draft was claimed; nothing was dispatched by Ownware.',
        }),
      })
      return
    }

    let result: ToolResult
    try {
      result = await executeHeldTool({
        profileId: schedule.profileId,
        threadId: bound.threadId,
        ...(schedule.workspaceId != null ? { workspaceId: schedule.workspaceId } : {}),
        safetyLevel: schedule.safetyLevel,
        toolName: bound.toolName,
        toolInput: bound.toolInput,
        policyRevision: bound.policyRevision,
        toolRevision: bound.toolRevision,
        targetRevision: bound.targetRevision,
      })
    } catch (err) {
      // executeHeldTool returns isError results rather than throwing, but a
      // thrown error must still be recorded honestly — never swallowed.
      sendJSON(res, 200, {
        approval: await store.decide(id, {
          status: 'failed',
          errorMessage: err instanceof Error ? err.message : String(err),
        }),
      })
      return
    }

    if (result.isError) {
      sendJSON(res, 200, {
        approval: await store.decide(id, {
          status: 'failed',
          errorMessage: typeof result.content === 'string' ? result.content : 'The action failed.',
        }),
      })
      return
    }
    sendJSON(res, 200, {
      approval: await store.decide(id, { status: 'approved', result: result.content }),
    })
  }

  return { listApprovals, countApprovals, getApproval, discardApproval, approveApproval }
}
