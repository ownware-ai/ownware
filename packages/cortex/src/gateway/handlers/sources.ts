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
  SOURCE_AUTHORITIES,
  SOURCE_CLASSIFICATIONS,
  SOURCE_KINDS,
  type SourceStore,
} from '../source-store.js'

const POLICY_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_LABEL = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u
const SOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SOURCE_LIST_DEFAULT_LIMIT = 50
export const SOURCE_LIST_MAX_LIMIT = 100

const SourceRegistrationSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  label: z.string().trim().min(1).max(160).regex(SAFE_LABEL),
  classification: z.enum(SOURCE_CLASSIFICATIONS),
  authority: z.enum(SOURCE_AUTHORITIES),
  audiencePolicyRef: z.string().regex(POLICY_REF),
  sensitivityPolicyRef: z.string().regex(POLICY_REF),
  purposePolicyRef: z.string().regex(POLICY_REF),
  retentionPolicyRef: z.string().regex(POLICY_REF),
  freshnessPolicyRef: z.string().regex(POLICY_REF),
}).strict()

export function createRegisterSourceHandler(
  store: SourceStore,
  idempotency: RunIdempotencyStore,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res): Promise<void> => {
    const principal = getRequestPrincipal(req)
    if (principal?.kind !== 'delegated') {
      sendError(res, 403, 'A scoped principal is required for source registration.',
        'source_scoped_principal_required', 'auth')
      return
    }

    const parsed = SourceRegistrationSchema.safeParse(await readJSON(req))
    if (!parsed.success) {
      sendError(res, 400, 'Source registration metadata is invalid.',
        'source_registration_invalid', 'invalid_request')
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
      operation: 'sources.register',
      key: idempotencyKey,
    }
    const claim = idempotency.claim({ ...key, input: parsed.data })
    if (claim.kind === 'replay') {
      res.setHeader('Idempotency-Replayed', 'true')
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
          : claim.kind === 'expired'
            ? 'Idempotency replay window expired; inspect source state before acting.'
            : claim.kind === 'in_progress'
              ? 'The original source registration is still in progress.'
              : 'The original source registration outcome is indeterminate; inspect source state before acting.',
        `idempotency_${claim.kind}`,
        'invalid_request',
      )
      return
    }

    try {
      const result = store.create({
        workspaceId: principal.workspaceId,
        profileId: principal.profileId,
        ...parsed.data,
      })
      idempotency.complete({ ...key, statusCode: 202, result })
      sendJSON(res, 202, result)
    } catch (error) {
      idempotency.markIndeterminate(key)
      throw error
    }
  }
}

export function createListSourcesHandler(
  store: SourceStore,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res): Promise<void> => {
    const principal = getRequestPrincipal(req)
    if (principal?.kind !== 'delegated') {
      sendError(res, 403, 'A scoped principal is required for source access.',
        'source_scoped_principal_required', 'auth')
      return
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if ([...url.searchParams.keys()].some((key) => key !== 'limit' && key !== 'cursor')) {
      sendError(res, 400, 'Source list query is invalid.',
        'source_list_invalid', 'invalid_request')
      return
    }
    const rawLimit = url.searchParams.get('limit')
    const limit = rawLimit === null ? SOURCE_LIST_DEFAULT_LIMIT : Number(rawLimit)
    const cursor = url.searchParams.get('cursor') ?? undefined
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SOURCE_LIST_MAX_LIMIT ||
        (cursor !== undefined && !SOURCE_ID.test(cursor))) {
      sendError(res, 400, 'Source list query is invalid.',
        'source_list_invalid', 'invalid_request')
      return
    }
    sendJSON(res, 200, store.listScoped(
      principal.workspaceId,
      principal.profileId,
      { limit, ...(cursor !== undefined ? { cursor } : {}) },
    ))
  }
}

export function createGetSourceHandler(
  store: SourceStore,
): (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const principal = getRequestPrincipal(req)
    if (principal?.kind !== 'delegated') {
      sendError(res, 403, 'A scoped principal is required for source access.',
        'source_scoped_principal_required', 'auth')
      return
    }
    const sourceId = params['sourceId']
    const source = sourceId && SOURCE_ID.test(sourceId)
      ? store.getScoped(sourceId, principal.workspaceId, principal.profileId)
      : null
    if (!source) {
      sendError(res, 404, 'Source not found.', 'source_not_found', 'not_found')
      return
    }
    sendJSON(res, 200, source)
  }
}
