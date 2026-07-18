import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { getRequestPrincipal } from '../auth/scoped-principal.js'
import {
  ACCESS_GRANT_MAX_TTL_SECONDS,
  ACCESS_GRANT_MIN_TTL_SECONDS,
  AccessGrantStore,
  AccessGrantStoreError,
  type AccessGrantRevision,
} from '../access-grant-store.js'
import {
  isValidIdempotencyKey,
  principalContinuityKey,
  type AccessGrantMutationReceipt,
  type RunIdempotencyStore,
} from '../idempotency.js'
import { readJSON, sendError, sendJSON } from '../router.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ConsentSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_required') }).strict(),
  z.object({
    state: z.literal('recorded'),
    evidenceId: z.string().min(1).max(128),
  }).strict(),
])
const CreateSchema = z.object({
  operation: z.enum(['source_content.read', 'source_content.search']).optional(),
  subjectId: z.string().min(1).max(128),
  purpose: z.string().min(1).max(128),
  channel: z.string().min(1).max(128).nullable(),
  consent: ConsentSchema,
  ttlSeconds: z.number().int()
    .min(ACCESS_GRANT_MIN_TTL_SECONDS)
    .max(ACCESS_GRANT_MAX_TTL_SECONDS),
}).strict()
const RevokeSchema = z.object({ expectedRevision: z.number().int().positive() }).strict()
export const ACCESS_GRANT_LIST_MAX_LIMIT = 100

export function createAccessGrantHandlers(options: {
  readonly grants: AccessGrantStore
  readonly idempotency: RunIdempotencyStore
  readonly authEnabled: boolean
  readonly clock?: () => number
}) {
  const clock = options.clock ?? Date.now

  async function create(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    if (!requireOwner(req, res, options.authEnabled)) return
    if (hasQuery(req)) return invalid(res, 'Access grant request is invalid.')
    const resourceId = params['resourceId'] ?? ''
    const parsed = CreateSchema.safeParse(await readJSON(req))
    if (!UUID.test(resourceId) || !parsed.success) {
      return invalid(res, 'Access grant request is invalid.')
    }
    const key = idempotencyKey(req, res)
    if (!key) return
    const principal = getRequestPrincipal(req)!
    const fence = { resourceId, ...parsed.data }
    const claimKey = {
      principalKey: principalContinuityKey(principal),
      operation: 'access_grants.create',
      key,
    }
    const claim = options.idempotency.claim({ ...claimKey, input: fence })
    if (claim.kind === 'replay') return replay(res, claim.statusCode, claim.result)
    if (claim.kind !== 'claimed') return replayFailure(res, claim.kind)
    const target = options.grants.getPreparedTextReadTargetForOwner(resourceId)
    if (!target) {
      options.idempotency.abandon(claimKey)
      return unavailableResource(res)
    }
    try {
      options.idempotency.linkSourceMutation(
        claim.recordId, target.sourceId, 'access_grant', clock(),
      )
    } catch {
      options.idempotency.markIndeterminate(claimKey)
      return indeterminate(res)
    }

    const acceptedAt = clock()
    try {
      const created = options.grants.createPreparedTextAccessGrant({
        workspaceId: target.workspaceId,
        profileId: target.profileId,
        resourceId,
        operation: parsed.data.operation ?? 'source_content.read',
        subjectId: parsed.data.subjectId,
        purpose: parsed.data.purpose,
        channel: parsed.data.channel,
        consent: parsed.data.consent,
        ttlSeconds: parsed.data.ttlSeconds,
        issuedBy: 'install_owner',
      }, acceptedAt)
      const receipt = grantReceipt(created, 'created', acceptedAt)
      try {
        options.idempotency.complete({
          ...claimKey, statusCode: 201, result: receipt,
        }, acceptedAt)
      } catch {
        options.idempotency.markIndeterminate(claimKey)
        return indeterminate(res)
      }
      noStore(res)
      sendJSON(res, 201, receipt)
    } catch (error) {
      options.idempotency.abandon(claimKey)
      handleStoreError(res, error, null)
    }
  }

  async function read(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    if (!requireOwner(req, res, options.authEnabled)) return
    if (hasQuery(req)) return invalid(res, 'Access grant request is invalid.')
    const grant = options.grants.getCurrentForOwner(params['grantId'] ?? '')
    if (!grant) return grantNotFound(res)
    noStore(res)
    sendJSON(res, 200, grant)
  }

  async function list(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!requireOwner(req, res, options.authEnabled)) return
    const page = parsePage(req)
    if (!page) return invalid(res, 'Access grant list query is invalid.')
    try {
      noStore(res)
      sendJSON(res, 200, options.grants.listCurrentForOwner(page, clock()))
    } catch (error) {
      handleStoreError(res, error, null)
    }
  }

  async function revoke(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    if (!requireOwner(req, res, options.authEnabled)) return
    if (hasQuery(req)) return invalid(res, 'Access grant revocation is invalid.')
    const grantId = params['grantId'] ?? ''
    const parsed = RevokeSchema.safeParse(await readJSON(req))
    if (!UUID.test(grantId) || !parsed.success) {
      return invalid(res, 'Access grant revocation is invalid.')
    }
    const key = idempotencyKey(req, res)
    if (!key) return
    const principal = getRequestPrincipal(req)!
    const claimKey = {
      principalKey: principalContinuityKey(principal),
      operation: 'access_grants.revoke',
      key,
    }
    const input = { grantId, expectedRevision: parsed.data.expectedRevision }
    const claim = options.idempotency.claim({ ...claimKey, input })
    if (claim.kind === 'replay') return replay(res, claim.statusCode, claim.result)
    if (claim.kind !== 'claimed') return replayFailure(res, claim.kind)
    const current = options.grants.getCurrentForOwner(grantId)
    const source = options.grants.getSourceIdentityForOwner(grantId)
    if (!current || !source) {
      options.idempotency.abandon(claimKey)
      return grantNotFound(res)
    }
    try {
      options.idempotency.linkSourceMutation(
        claim.recordId, source.sourceId, 'access_grant', clock(),
      )
    } catch {
      options.idempotency.markIndeterminate(claimKey)
      return indeterminate(res)
    }

    const acceptedAt = clock()
    try {
      const revoked = options.grants.revoke({
        grantId,
        workspaceId: source.workspaceId,
        profileId: source.profileId,
        expectedRevision: parsed.data.expectedRevision,
      }, acceptedAt)
      const receipt = grantReceipt(revoked, 'revoked', acceptedAt)
      try {
        options.idempotency.complete({
          ...claimKey, statusCode: 200, result: receipt,
        }, acceptedAt)
      } catch {
        options.idempotency.markIndeterminate(claimKey)
        return indeterminate(res)
      }
      noStore(res)
      sendJSON(res, 200, receipt)
    } catch (error) {
      options.idempotency.abandon(claimKey)
      handleStoreError(res, error, current)
    }
  }

  return { create, read, list, revoke }
}

function requireOwner(
  req: IncomingMessage,
  res: ServerResponse,
  authEnabled: boolean,
): boolean {
  if (!authEnabled) {
    sendError(res, 409, 'Enable Gateway authentication before managing access grants.',
      'auth_required', 'auth')
    return false
  }
  if (getRequestPrincipal(req)?.kind !== 'owner') {
    sendError(res, 403, 'Only the install owner can manage access grants.',
      'owner_required', 'auth')
    return false
  }
  return true
}

function idempotencyKey(req: IncomingMessage, res: ServerResponse): string | null {
  const raw = req.headers['idempotency-key']
  const key = Array.isArray(raw) ? undefined : raw
  if (!key || !isValidIdempotencyKey(key)) {
    sendError(res, 400, 'Idempotency-Key must be a UUID.',
      'idempotency_key_required', 'invalid_request')
    return null
  }
  return key
}

function replay(
  res: ServerResponse,
  statusCode: number,
  result: unknown,
): void {
  noStore(res)
  res.setHeader('Idempotency-Replayed', 'true')
  sendJSON(res, statusCode, result)
}

function replayFailure(
  res: ServerResponse,
  kind: 'conflict' | 'in_progress' | 'indeterminate' | 'expired',
): void {
  if (kind === 'in_progress') res.setHeader('Retry-After', '1')
  sendError(res, 409,
    kind === 'conflict'
      ? 'Idempotency key was already used with different input.'
      : 'The original access grant mutation is not safely repeatable.',
    `idempotency_${kind}`, 'invalid_request')
}

function indeterminate(res: ServerResponse): void {
  sendError(res, 409,
    'Access grant mutation outcome is uncertain; inspect current grants before acting.',
    'idempotency_indeterminate', 'invalid_request')
}

function grantReceipt(
  grant: AccessGrantRevision,
  mutation: AccessGrantMutationReceipt['mutation'],
  acceptedAt: number,
): AccessGrantMutationReceipt {
  return { grantId: grant.grantId, revision: grant.revision, mutation, acceptedAt }
}

function parsePage(req: IncomingMessage): { limit: number; cursor: string | null } | null {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if ([...url.searchParams.keys()].some((key) => key !== 'limit' && key !== 'cursor') ||
      url.searchParams.getAll('limit').length > 1 ||
      url.searchParams.getAll('cursor').length > 1) return null
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? 50 : Number(rawLimit)
  const cursor = url.searchParams.get('cursor')
  return Number.isInteger(limit) && limit >= 1 && limit <= ACCESS_GRANT_LIST_MAX_LIMIT &&
    (cursor === null || UUID.test(cursor)) ? { limit, cursor } : null
}

function handleStoreError(
  res: ServerResponse,
  error: unknown,
  current: AccessGrantRevision | null,
): void {
  if (!(error instanceof AccessGrantStoreError)) throw error
  switch (error.code) {
    case 'access_grant_resource_unavailable': return unavailableResource(res)
    case 'access_grant_limit_exceeded':
      return sendError(res, 409, 'Access grant capacity is exhausted.',
        error.code, 'invalid_request')
    case 'access_grant_revision_conflict':
      return sendError(res, 409, 'Access grant revision changed.',
        error.code, 'invalid_request', {
          ...(current ? { actualRevision: current.revision } : {}),
        })
    case 'access_grant_not_active':
      return sendError(res, 409, 'Access grant is already inactive.',
        error.code, 'invalid_request')
    case 'access_grant_not_found': return grantNotFound(res)
    case 'access_grant_invalid': return invalid(res, 'Access grant request is invalid.')
  }
}

function hasQuery(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  return [...url.searchParams.keys()].length > 0
}

function invalid(res: ServerResponse, message: string): void {
  sendError(res, 400, message, 'access_grant_invalid', 'invalid_request')
}

function unavailableResource(res: ServerResponse): void {
  sendError(res, 404, 'Prepared source resource is unavailable.',
    'access_grant_resource_unavailable', 'not_found')
}

function grantNotFound(res: ServerResponse): void {
  sendError(res, 404, 'Access grant was not found.',
    'access_grant_not_found', 'not_found')
}

function noStore(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store')
}
