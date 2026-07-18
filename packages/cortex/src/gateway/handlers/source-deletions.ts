import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { getRequestPrincipal } from '../auth/scoped-principal.js'
import {
  isValidIdempotencyKey,
  principalContinuityKey,
  type RunIdempotencyStore,
} from '../idempotency.js'
import { readJSON, sendError, sendJSON } from '../router.js'
import {
  SourceDeletionPlanError,
  type SourceDeletionStore,
} from '../source-deletion-store.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CreateDeletionSchema = z.object({
  expectedRevision: z.number().int().positive(),
}).strict()
const EmptyBodySchema = z.object({}).strict()

export function createSourceDeletionHandler(
  deletions: SourceDeletionStore,
  idempotency: RunIdempotencyStore,
  wakeWorker: () => void,
): (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const principal = scopedPrincipal(req, res)
    if (!principal) return
    if (hasQuery(req)) {
      sendError(res, 400, 'Source deletion request is invalid.',
        'source_deletion_request_invalid', 'invalid_request')
      return
    }
    const sourceId = params['sourceId'] ?? ''
    const parsed = CreateDeletionSchema.safeParse(await readJSON(req))
    if (!UUID.test(sourceId) || !parsed.success) {
      sendError(res, 400, 'Source deletion request is invalid.',
        'source_deletion_request_invalid', 'invalid_request')
      return
    }
    const rawKey = req.headers['idempotency-key']
    const idempotencyKey = Array.isArray(rawKey) ? undefined : rawKey
    if (!idempotencyKey || !isValidIdempotencyKey(idempotencyKey)) {
      sendError(res, 400, 'Idempotency-Key must be a UUID.',
        'idempotency_key_required', 'invalid_request')
      return
    }
    const key = {
      principalKey: principalContinuityKey(principal),
      operation: 'source_deletions.create',
      key: idempotencyKey,
    }
    const input = { sourceId, expectedRevision: parsed.data.expectedRevision }
    const claim = idempotency.claim({ ...key, input })
    if (claim.kind === 'replay') {
      res.setHeader('Idempotency-Replayed', 'true')
      wakeWorker()
      sendJSON(res, claim.statusCode, claim.result)
      return
    }
    if (claim.kind !== 'claimed') {
      if (claim.kind === 'in_progress') res.setHeader('Retry-After', '1')
      sendError(
        res,
        409,
        claim.kind === 'conflict'
          ? 'Idempotency key was already used with different input.'
          : 'The original source deletion request is not safely repeatable.',
        `idempotency_${claim.kind}`,
        'invalid_request',
      )
      return
    }

    try {
      const plan = deletions.plan({
        workspaceId: principal.workspaceId,
        profileId: principal.profileId,
        sourceId,
        expectedRevision: parsed.data.expectedRevision,
      })
      const result = deletions.getPublicByJobScoped(
        plan.jobId, principal.workspaceId, principal.profileId,
      )
      if (!result) throw new Error('Source deletion projection unavailable')
      idempotency.complete({ ...key, statusCode: 202, result })
      wakeWorker()
      sendJSON(res, 202, result)
    } catch (error) {
      if (error instanceof SourceDeletionPlanError) {
        idempotency.abandon(key)
        if (error.code === 'source_not_found') {
          sendError(res, 404, 'Source not found.', 'source_not_found', 'not_found')
          return
        }
        sendError(
          res,
          409,
          error.code === 'source_deletion_revision_conflict'
            ? 'Source revision changed before deletion could be planned.'
            : 'Source is not available for deletion planning.',
          error.code,
          'invalid_request',
        )
        return
      }
      idempotency.markIndeterminate(key)
      throw error
    }
  }
}

export function createGetSourceDeletionHandler(
  deletions: SourceDeletionStore,
): (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const principal = scopedPrincipal(req, res)
    if (!principal) return
    if (hasQuery(req)) {
      sendError(res, 400, 'Source deletion request is invalid.',
        'source_deletion_request_invalid', 'invalid_request')
      return
    }
    const jobId = params['jobId'] ?? ''
    const deletion = UUID.test(jobId)
      ? deletions.getPublicByJobScoped(jobId, principal.workspaceId, principal.profileId)
      : null
    if (!deletion) {
      sendError(res, 404, 'Source deletion not found.',
        'source_deletion_not_found', 'not_found')
      return
    }
    sendJSON(res, 200, deletion)
  }
}

export function createCancelSourceDeletionHandler(
  deletions: SourceDeletionStore,
  wakeWorker: () => void,
): (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const principal = scopedPrincipal(req, res)
    if (!principal) return
    if (hasQuery(req) || !EmptyBodySchema.safeParse(await readJSON(req)).success) {
      sendError(res, 400, 'Source deletion cancellation request is invalid.',
        'source_deletion_cancel_invalid', 'invalid_request')
      return
    }
    const jobId = params['jobId'] ?? ''
    const result = UUID.test(jobId)
      ? deletions.requestCancellation(
        jobId, principal.workspaceId, principal.profileId,
      )
      : 'missing'
    if (result === 'missing') {
      sendError(res, 404, 'Source deletion not found.',
        'source_deletion_not_found', 'not_found')
      return
    }
    if (result === 'terminal') {
      sendError(res, 409, 'Source deletion is already terminal.',
        'source_deletion_terminal', 'invalid_request')
      return
    }
    if (result === 'destruction_started') {
      sendError(res, 409, 'Source deletion can no longer be cancelled.',
        'source_deletion_irreversible', 'invalid_request')
      return
    }
    const deletion = deletions.getPublicByJobScoped(
      jobId, principal.workspaceId, principal.profileId,
    )
    if (!deletion) {
      sendError(res, 404, 'Source deletion not found.',
        'source_deletion_not_found', 'not_found')
      return
    }
    wakeWorker()
    sendJSON(res, 202, {
      ...deletion,
      cancellation: result === 'requested' ? 'requested' : 'already_requested',
    })
  }
}

export function createRetrySourceDeletionHandler(
  deletions: SourceDeletionStore,
  wakeWorker: () => void,
): (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const principal = scopedPrincipal(req, res)
    if (!principal) return
    if (hasQuery(req) || !EmptyBodySchema.safeParse(await readJSON(req)).success) {
      sendError(res, 400, 'Source deletion retry request is invalid.',
        'source_deletion_retry_invalid', 'invalid_request')
      return
    }
    const jobId = params['jobId'] ?? ''
    const result = UUID.test(jobId)
      ? deletions.retryPartialScoped(
        jobId, principal.workspaceId, principal.profileId,
      )
      : 'missing'
    if (result === 'missing') {
      sendError(res, 404, 'Source deletion not found.',
        'source_deletion_not_found', 'not_found')
      return
    }
    if (result === 'not_partial') {
      sendError(res, 409, 'Source deletion is not ready for partial retry.',
        'source_deletion_not_partial', 'invalid_request')
      return
    }
    const deletion = deletions.getPublicByJobScoped(
      jobId, principal.workspaceId, principal.profileId,
    )
    if (!deletion) throw new Error('Source deletion retry projection unavailable')
    wakeWorker()
    sendJSON(res, 202, { ...deletion, retry: 'queued' })
  }
}

function scopedPrincipal(req: IncomingMessage, res: ServerResponse) {
  const principal = getRequestPrincipal(req)
  if (principal?.kind !== 'delegated') {
    sendError(res, 403, 'A scoped principal is required for source deletion.',
      'source_scoped_principal_required', 'auth')
    return null
  }
  return principal
}

function hasQuery(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  return [...url.searchParams.keys()].length > 0
}
