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
  SourceJobStore,
  SourceJobTargetNotFoundError,
  SourcePreparationNotReadyError,
} from '../source-job-store.js'
import { SourceQuotaExceededError } from '../source-quota-policy.js'
import {
  SourceDataViewStore,
  SourceDataViewUnavailableError,
} from '../source-data-view-store.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CreateSourceJobSchema = z.object({
  operation: z.literal('inspect_format'),
}).strict()
const CreateSourcePreparationSchema = z.object({
  operation: z.enum(['extract_text', 'prepare_data_view']),
}).strict()
const EmptyBodySchema = z.object({}).strict().nullable()

export function createSourceJobHandler(
  jobs: SourceJobStore,
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
      sendError(res, 400, 'Source job request is invalid.',
        'source_job_request_invalid', 'invalid_request')
      return
    }
    const sourceId = params['sourceId'] ?? ''
    const sourceVersionId = params['sourceVersionId'] ?? ''
    if (!UUID.test(sourceId) || !UUID.test(sourceVersionId) ||
        !jobs.hasTargetScoped(
          sourceId, sourceVersionId, principal.workspaceId, principal.profileId,
        )) {
      sendError(res, 404, 'Source version not found.',
        'source_version_not_found', 'not_found')
      return
    }

    const input = await readJSON(req)
    if (isRecord(input) && 'operation' in input && input['operation'] !== 'inspect_format') {
      sendError(res, 400, 'Source job operation is not supported.',
        'source_job_operation_unsupported', 'invalid_request')
      return
    }
    const parsed = CreateSourceJobSchema.safeParse(input)
    if (!parsed.success) {
      sendError(res, 400, 'Source job request is invalid.',
        'source_job_request_invalid', 'invalid_request')
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
      operation: 'source_jobs.create',
      key: idempotencyKey,
    }
    const fencedInput = { sourceId, sourceVersionId, operation: parsed.data.operation }
    const claim = idempotency.claim({ ...key, input: fencedInput })
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
          : 'The original source job request is not safely repeatable.',
        `idempotency_${claim.kind}`,
        'invalid_request',
      )
      return
    }

    try {
      const result = jobs.enqueue({
        workspaceId: principal.workspaceId,
        profileId: principal.profileId,
        ...fencedInput,
      })
      idempotency.complete({ ...key, statusCode: 202, result })
      wakeWorker()
      sendJSON(res, 202, result)
    } catch (error) {
      if (error instanceof SourceQuotaExceededError) {
        idempotency.abandon(key)
        sendError(res, 409, 'Source quota does not allow this operation.',
          'source_quota_exceeded', 'invalid_request', {
            resourceClass: error.resourceClass,
          })
        return
      }
      idempotency.markIndeterminate(key)
      if (error instanceof SourceJobTargetNotFoundError) {
        sendError(res, 404, 'Source version not found.',
          'source_version_not_found', 'not_found')
        return
      }
      throw error
    }
  }
}

export function createGetSourceJobHandler(
  jobs: SourceJobStore,
  dataViews: SourceDataViewStore,
): (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const principal = scopedPrincipal(req, res)
    if (!principal) return
    if (hasQuery(req)) {
      sendError(res, 400, 'Source job request is invalid.',
        'source_job_request_invalid', 'invalid_request')
      return
    }
    const jobId = params['jobId'] ?? ''
    const job = UUID.test(jobId)
      ? jobs.getScoped(jobId, principal.workspaceId, principal.profileId) ??
        dataViews.getJobScoped(jobId, principal.workspaceId, principal.profileId)
      : null
    if (!job) {
      sendError(res, 404, 'Source job not found.', 'source_job_not_found', 'not_found')
      return
    }
    sendJSON(res, 200, job)
  }
}

export function createSourcePreparationHandler(
  jobs: SourceJobStore,
  dataViews: SourceDataViewStore,
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
      sendError(res, 400, 'Source preparation request is invalid.',
        'source_preparation_request_invalid', 'invalid_request')
      return
    }
    const sourceId = params['sourceId'] ?? ''
    const sourceVersionId = params['sourceVersionId'] ?? ''
    if (!UUID.test(sourceId) || !UUID.test(sourceVersionId) ||
        !jobs.hasTargetScoped(
          sourceId, sourceVersionId, principal.workspaceId, principal.profileId,
        )) {
      sendError(res, 404, 'Source version not found.',
        'source_version_not_found', 'not_found')
      return
    }
    const input = await readJSON(req)
    const parsed = CreateSourcePreparationSchema.safeParse(input)
    if (!parsed.success) {
      sendError(res, 400, 'Source preparation request is invalid.',
        'source_preparation_request_invalid', 'invalid_request')
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
      operation: 'source_preparations.create',
      key: idempotencyKey,
    }
    const fencedInput = { sourceId, sourceVersionId, operation: parsed.data.operation }
    const claim = idempotency.claim({ ...key, input: fencedInput })
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
          : 'The original source preparation request is not safely repeatable.',
        `idempotency_${claim.kind}`,
        'invalid_request',
      )
      return
    }
    try {
      const target = {
        workspaceId: principal.workspaceId,
        profileId: principal.profileId,
        sourceId,
        sourceVersionId,
      }
      const result = parsed.data.operation === 'extract_text'
        ? jobs.enqueuePreparation(target)
        : dataViews.enqueue(target)
      idempotency.complete({ ...key, statusCode: 202, result })
      wakeWorker()
      sendJSON(res, 202, result)
    } catch (error) {
      if (error instanceof SourceQuotaExceededError) {
        idempotency.abandon(key)
        sendError(res, 409, 'Source quota does not allow this operation.',
          'source_quota_exceeded', 'invalid_request', {
            resourceClass: error.resourceClass,
          })
        return
      }
      if (error instanceof SourceJobTargetNotFoundError) {
        idempotency.abandon(key)
        sendError(res, 404, 'Source version not found.',
          'source_version_not_found', 'not_found')
        return
      }
      if (error instanceof SourcePreparationNotReadyError) {
        idempotency.abandon(key)
        const status = error.code === 'source_media_unsupported' ? 422
          : error.code === 'source_authority_excluded' ? 403 : 409
        sendError(
          res,
          status,
          preparationMessage(error.code),
          error.code,
          status === 403 ? 'auth' : 'invalid_request',
        )
        return
      }
      if (error instanceof SourceDataViewUnavailableError) {
        idempotency.abandon(key)
        const status = dataViewPreparationStatus(error.code)
        sendError(
          res,
          status,
          dataViewPreparationMessage(error.code),
          error.code,
          status === 403 ? 'auth' : status === 404 ? 'not_found' : 'invalid_request',
        )
        return
      }
      idempotency.markIndeterminate(key)
      throw error
    }
  }
}

export function createGetSourceResourceHandler(
  jobs: SourceJobStore,
): (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const principal = scopedPrincipal(req, res)
    if (!principal) return
    if (hasQuery(req)) {
      sendError(res, 400, 'Source resource request is invalid.',
        'source_resource_request_invalid', 'invalid_request')
      return
    }
    const resourceId = params['resourceId'] ?? ''
    const resource = UUID.test(resourceId)
      ? jobs.getResourceScoped(resourceId, principal.workspaceId, principal.profileId)
      : null
    if (!resource) {
      sendError(res, 404, 'Source resource not found.',
        'source_resource_not_found', 'not_found')
      return
    }
    sendJSON(res, 200, resource)
  }
}

export function createGetSourceDataViewHandler(
  dataViews: SourceDataViewStore,
): (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const principal = scopedPrincipal(req, res)
    if (!principal) return
    if (hasQuery(req)) {
      sendError(res, 400, 'Data View request is invalid.',
        'source_data_view_request_invalid', 'invalid_request')
      return
    }
    const dataViewId = params['dataViewId'] ?? ''
    const view = UUID.test(dataViewId)
      ? dataViews.getViewScoped(dataViewId, principal.workspaceId, principal.profileId)
      : null
    if (!view) {
      sendError(res, 404, 'Data View not found.',
        'source_data_view_not_found', 'not_found')
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    sendJSON(res, 200, view)
  }
}

export function createCancelSourceJobHandler(
  jobs: SourceJobStore,
  dataViews: SourceDataViewStore,
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
      sendError(res, 400, 'Source job cancellation request is invalid.',
        'source_job_cancel_invalid', 'invalid_request')
      return
    }
    const jobId = params['jobId'] ?? ''
    let result: 'requested' | 'already_requested' | 'terminal' | 'missing' = 'missing'
    let dataViewJob = false
    if (UUID.test(jobId)) {
      result = jobs.requestCancel(jobId, principal.workspaceId, principal.profileId)
      if (result === 'missing') {
        result = dataViews.requestCancel(
          jobId, principal.workspaceId, principal.profileId,
        )
        dataViewJob = result !== 'missing'
      }
    }
    if (result === 'missing') {
      sendError(res, 404, 'Source job not found.', 'source_job_not_found', 'not_found')
      return
    }
    if (result === 'terminal') {
      sendError(res, 409, 'Source job is already terminal.',
        'source_job_terminal', 'invalid_request')
      return
    }
    const job = dataViewJob
      ? dataViews.getJobScoped(jobId, principal.workspaceId, principal.profileId)
      : jobs.getScoped(jobId, principal.workspaceId, principal.profileId)
    if (!job) {
      sendError(res, 404, 'Source job not found.', 'source_job_not_found', 'not_found')
      return
    }
    wakeWorker()
    sendJSON(res, 202, {
      ...job,
      cancellation: result === 'requested' ? 'requested' : 'already_requested',
    })
  }
}

function scopedPrincipal(req: IncomingMessage, res: ServerResponse) {
  const principal = getRequestPrincipal(req)
  if (principal?.kind !== 'delegated') {
    sendError(res, 403, 'A scoped principal is required for source jobs.',
      'source_scoped_principal_required', 'auth')
    return null
  }
  return principal
}

function hasQuery(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  return [...url.searchParams.keys()].length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function preparationMessage(code: SourcePreparationNotReadyError['code']): string {
  switch (code) {
    case 'source_version_not_current': return 'Source version is no longer current.'
    case 'source_inspection_incomplete': return 'Source inspection is not complete.'
    case 'source_media_unsupported': return 'Source media is not supported for preparation.'
    case 'source_authority_excluded': return 'Source authority excludes preparation.'
  }
}

function dataViewPreparationStatus(code: SourceDataViewUnavailableError['code']): number {
  switch (code) {
    case 'source_version_not_found': return 404
    case 'source_authority_excluded': return 403
    case 'source_media_unsupported':
    case 'source_data_view_kind_unsupported': return 422
    case 'source_version_not_current':
    case 'source_inspection_incomplete':
    case 'source_access_unavailable':
    case 'source_conflict_confirmed': return 409
  }
}

function dataViewPreparationMessage(code: SourceDataViewUnavailableError['code']): string {
  switch (code) {
    case 'source_version_not_found': return 'Source version not found.'
    case 'source_version_not_current': return 'Source version is no longer current.'
    case 'source_inspection_incomplete': return 'Source inspection is not complete.'
    case 'source_data_view_kind_unsupported':
      return 'Source kind does not support Data View preparation.'
    case 'source_media_unsupported': return 'Source media type is not supported.'
    case 'source_authority_excluded': return 'Excluded source cannot be prepared.'
    case 'source_access_unavailable': return 'Source access is not available.'
    case 'source_conflict_confirmed': return 'Source has a confirmed conflict.'
  }
}
