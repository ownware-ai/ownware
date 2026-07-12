import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { GatewayState } from '../state.js'
import type { ProfileRegistry } from '../../profile/registry.js'
import { readJSON, sendError, sendJSON } from '../router.js'
import {
  getRequestPrincipal,
  PrincipalAuthError,
  type ScopedPrincipalService,
} from '../auth/scoped-principal.js'
import type { CandidateStore } from '../candidate-store.js'

const IssueSchema = z.object({
  delegateId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  profileId: z.string().min(1).max(128),
  purpose: z.string().min(1).max(64),
  channel: z.string().min(1).max(64).optional(),
  operations: z.array(z.string().min(1).max(64)).min(1).max(32),
  ttlSeconds: z.number().int().min(1).max(3_600).optional(),
}).strict()

const RevokeSchema = z.object({
  reason: z.string().min(1).max(64),
}).strict()

export function createPrincipalHandlers(options: {
  readonly state: GatewayState
  readonly registry: ProfileRegistry
  readonly service: ScopedPrincipalService
  readonly authEnabled: boolean
  readonly candidateStore?: CandidateStore
}) {
  async function issue(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!options.authEnabled) {
      sendError(res, 409, 'Enable Gateway authentication before issuing a delegation', 'auth_required', 'auth')
      return
    }
    if (getRequestPrincipal(req)?.kind !== 'owner') {
      sendError(res, 403, 'Only the install owner can issue a delegation', 'owner_required', 'auth')
      return
    }

    const parsed = IssueSchema.safeParse(await readJSON(req))
    if (!parsed.success) {
      sendError(res, 400, 'Delegation request is invalid', 'invalid_request', 'invalid_request')
      return
    }
    if (!options.state.getWorkspace(parsed.data.workspaceId)) {
      sendError(res, 404, 'Requested workspace was not found', 'workspace_not_found', 'not_found')
      return
    }
    await options.registry.refreshUser()
    const knownLegacyProfile = options.registry.list()
      .some((profile) => profile.name === parsed.data.profileId)
    const knownCandidateProfile = (options.candidateStore?.list(parsed.data.profileId).length ?? 0) > 0
    if (!knownLegacyProfile && !knownCandidateProfile) {
      sendError(res, 404, 'Requested profile was not found', 'profile_not_found', 'not_found')
      return
    }

    try {
      const issued = await options.service.issue(parsed.data)
      res.setHeader('Cache-Control', 'no-store')
      sendJSON(res, 201, issued)
    } catch (error) {
      const code = error instanceof PrincipalAuthError ? error.code : 'principal_issue_failed'
      sendError(res, 400, 'Delegation could not be issued', code, 'invalid_request')
    }
  }

  async function revoke(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    if (!options.authEnabled) {
      sendError(res, 409, 'Enable Gateway authentication before revoking a delegation', 'auth_required', 'auth')
      return
    }
    if (getRequestPrincipal(req)?.kind !== 'owner') {
      sendError(res, 403, 'Only the install owner can revoke a delegation', 'owner_required', 'auth')
      return
    }
    const parsed = RevokeSchema.safeParse(await readJSON(req))
    if (!parsed.success || !params['tokenId']) {
      sendError(res, 400, 'Revocation request is invalid', 'invalid_request', 'invalid_request')
      return
    }
    try {
      const revoked = options.service.revoke(params['tokenId'], parsed.data.reason)
      if (!revoked) {
        sendError(res, 404, 'Delegation was not found or was already revoked', 'principal_not_found', 'not_found')
        return
      }
      sendJSON(res, 200, { tokenId: params['tokenId'], revoked: true })
    } catch (error) {
      const code = error instanceof PrincipalAuthError ? error.code : 'principal_revoke_failed'
      sendError(res, 400, 'Delegation could not be revoked', code, 'invalid_request')
    }
  }

  return { issue, revoke }
}
