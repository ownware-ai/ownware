import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import {
  validateProfileCandidate,
  type ProfileCandidateValidation,
} from '../../profile/candidate.js'
import {
  CandidateActivationRejected,
  type CandidateActivator,
  CandidateDeploymentRejected,
  type CandidateDeploymentManager,
} from '../../profile/candidate-activation.js'
import {
  CandidateStageRejected,
  type CandidateStager,
} from '../../profile/candidate-stager.js'
import {
  CandidateDeleteRejected,
  type CandidateRetirer,
} from '../../profile/candidate-retirer.js'
import type { CandidateStore } from '../candidate-store.js'
import type { GatewayRunStore } from '../run-store.js'
import { getRequestPrincipal } from '../auth/scoped-principal.js'
import {
  isValidIdempotencyKey,
  principalContinuityKey,
  type IdempotencySnapshot,
  type RunIdempotencyStore,
} from '../idempotency.js'
import { readJSON, sendError, sendJSON } from '../router.js'

export const CANDIDATE_UPLOAD_MAX_FILES = 1_000
export const CANDIDATE_UPLOAD_MAX_BYTES = 6 * 1024 * 1024
export const CANDIDATE_UPLOAD_MAX_PATH_CHARACTERS = 256

export interface CandidateValidationDependencies {
  readonly makeTempDirectory: () => Promise<string>
  readonly makeDirectory: typeof mkdir
  readonly writeFile: typeof writeFile
  readonly validate: typeof validateProfileCandidate
  readonly removeDirectory: (path: string) => Promise<void>
}

const DEFAULT_DEPENDENCIES: CandidateValidationDependencies = {
  makeTempDirectory: () => mkdtemp(join(tmpdir(), 'ownware-candidate-upload-')),
  makeDirectory: mkdir,
  writeFile,
  validate: validateProfileCandidate,
  removeDirectory: (path) => rm(path, { recursive: true, force: true }),
}

export function createValidateCandidateHandler(
  overrides: Partial<CandidateValidationDependencies> = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  return async (req, res): Promise<void> => {
    const parsed = parseUpload(await readJSON(req))
    if (!parsed.ok) {
      sendError(res, 400, parsed.message, 'candidate_upload_invalid', 'invalid_request')
      return
    }

    const dir = await dependencies.makeTempDirectory()
    let result: ProfileCandidateValidation | undefined
    let processingError: unknown
    try {
      for (const file of parsed.files) {
        const target = join(dir, file.path)
        await dependencies.makeDirectory(dirname(target), { recursive: true })
        await dependencies.writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 })
      }
      result = await dependencies.validate({ profileDir: dir })
    } catch (error) {
      processingError = error
    }

    try {
      await dependencies.removeDirectory(dir)
    } catch {
      sendError(
        res,
        500,
        'Candidate validation workspace could not be cleaned up.',
        'candidate_cleanup_failed',
        'unknown',
      )
      return
    }

    if (processingError !== undefined) throw processingError
    sendJSON(res, 200, result!)
  }
}

export const validateCandidate = createValidateCandidateHandler()

const CANDIDATE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/

export function createGetCandidateHandler(
  store: CandidateStore,
): (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const candidateId = params['candidateId']
    if (!candidateId || !CANDIDATE_ID_PATTERN.test(candidateId)) {
      sendError(res, 400, 'Candidate identity is invalid.',
        'candidate_identity_invalid', 'invalid_request')
      return
    }
    const candidate = store.get(candidateId)
    if (!candidate || !isReadableCandidateScope(req, candidate.profileId)) {
      sendError(res, 404, 'Candidate not found.', 'candidate_not_found', 'not_found')
      return
    }
    sendJSON(res, 200, projectCandidate(store, candidate))
  }
}

export function createListCandidatesHandler(
  store: CandidateStore,
): (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const profileId = params['profileId']
    if (!profileId || !isReadableCandidateScope(req, profileId)) {
      sendError(res, 404, 'Profile not found.', 'profile_not_found', 'not_found')
      return
    }
    sendJSON(res, 200, {
      profileId,
      items: store.list(profileId).map((candidate) => projectCandidate(store, candidate)),
    })
  }
}

export function createGetDeploymentHandler(
  store: CandidateStore,
  runs: GatewayRunStore,
): (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const profileId = params['profileId']
    if (!profileId || !isReadableCandidateScope(req, profileId)) {
      sendError(res, 404, 'Profile deployment not found.',
        'profile_deployment_not_found', 'not_found')
      return
    }
    const deployment = store.getActive(profileId)
    if (!deployment) {
      sendError(res, 404, 'Profile deployment not found.',
        'profile_deployment_not_found', 'not_found')
      return
    }
    sendJSON(res, 200, {
      profileId,
      activeCandidateId: deployment.candidateId,
      deploymentRevision: deployment.deploymentRevision,
      routingState: deployment.routingState,
      health: deployment.health,
      healthObservedAt: deployment.healthObservedAt,
      activeRunCount: runs.countActiveForProfile(profileId),
      updatedAt: deployment.updatedAt,
    })
  }
}

export function createDeleteCandidateHandler(
  retirer: CandidateRetirer,
  store: CandidateStore,
): (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const candidateId = params['candidateId']
    if (!candidateId || !CANDIDATE_ID_PATTERN.test(candidateId)) {
      sendError(res, 400, 'Candidate identity is invalid.',
        'candidate_identity_invalid', 'invalid_request')
      return
    }
    const candidate = store.get(candidateId)
    if (!candidate || !isReadableCandidateScope(req, candidate.profileId)) {
      sendError(res, 404, 'Candidate not found.', 'candidate_not_found', 'not_found')
      return
    }
    try {
      sendJSON(res, 200, await retirer.delete({
        profileId: candidate.profileId,
        candidateId,
      }))
    } catch (error) {
      if (!(error instanceof CandidateDeleteRejected)) throw error
      const status = error.code === 'candidate_delete_not_found' ||
        error.code === 'candidate_scope_mismatch' ? 404 : 409
      sendError(
        res,
        status,
        deletionRejectedMessage(error.code),
        error.code,
        status === 404 ? 'not_found' : 'invalid_request',
      )
    }
  }
}

export function createPauseProfileHandler(
  deployment: CandidateDeploymentManager,
  idempotency: RunIdempotencyStore,
): (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const profileId = params['profileId']
    const body = await readJSON(req)
    if (!profileId || !isDeploymentMutationBody(body)) {
      sendError(res, 400, 'Pause requires an exact expectedDeploymentRevision.',
        'deployment_pause_invalid', 'invalid_request')
      return
    }
    if (!isProfileInPrincipalScope(req, profileId, res)) return
    const fence = claimDeploymentMutation(
      req, res, idempotency, 'profiles.pause', { profileId, ...body },
    )
    if (!fence) return
    if (fence.replay) {
      res.setHeader('Idempotency-Replayed', 'true')
      sendJSON(res, fence.replay.statusCode, fence.replay.result)
      return
    }
    try {
      const result = deployment.pause({
        profileId,
        expectedDeploymentRevision: body.expectedDeploymentRevision,
      })
      idempotency.complete({ ...fence.key, statusCode: 200, result })
      sendJSON(res, 200, result)
    } catch (error) {
      idempotency.markIndeterminate(fence.key)
      sendDeploymentError(res, error, 'pause')
    }
  }
}

export function createResumeProfileHandler(
  deployment: CandidateDeploymentManager,
  idempotency: RunIdempotencyStore,
): (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const profileId = params['profileId']
    const body = await readJSON(req)
    if (!profileId || !isDeploymentMutationBody(body)) {
      sendError(res, 400, 'Resume requires an exact expectedDeploymentRevision.',
        'deployment_resume_invalid', 'invalid_request')
      return
    }
    if (!isProfileInPrincipalScope(req, profileId, res)) return
    const fence = claimDeploymentMutation(
      req, res, idempotency, 'profiles.resume', { profileId, ...body },
    )
    if (!fence) return
    if (fence.replay) {
      res.setHeader('Idempotency-Replayed', 'true')
      sendJSON(res, fence.replay.statusCode, fence.replay.result)
      return
    }
    try {
      const result = await deployment.resume({
        profileId,
        expectedDeploymentRevision: body.expectedDeploymentRevision,
      })
      idempotency.complete({ ...fence.key, statusCode: 200, result })
      sendJSON(res, 200, result)
    } catch (error) {
      idempotency.markIndeterminate(fence.key)
      sendDeploymentError(res, error, 'resume')
    }
  }
}

export function createActivateCandidateHandler(
  activator: CandidateActivator,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res): Promise<void> => {
    const body = await readJSON(req)
    if (!isPlainObject(body) ||
        Object.keys(body).some((key) => key !== 'profileId' && key !== 'candidateId' &&
          key !== 'expectedActiveCandidateId') ||
        typeof body['profileId'] !== 'string' ||
        !CANDIDATE_ID_PATTERN.test(String(body['candidateId'])) ||
        !(body['expectedActiveCandidateId'] === null ||
          (typeof body['expectedActiveCandidateId'] === 'string' &&
            CANDIDATE_ID_PATTERN.test(body['expectedActiveCandidateId'])))) {
      sendError(
        res,
        400,
        'Candidate activation requires profileId, candidateId and expectedActiveCandidateId.',
        'candidate_activation_invalid',
        'invalid_request',
      )
      return
    }
    const principal = getRequestPrincipal(req)
    if (principal?.kind === 'delegated' && principal.profileId !== body['profileId']) {
      sendError(
        res,
        403,
        'Candidate profile does not match the delegated profile scope.',
        'candidate_scope_mismatch',
        'auth',
      )
      return
    }
    try {
      sendJSON(res, 200, await activator.activate({
        profileId: body['profileId'],
        candidateId: body['candidateId'] as string,
        expectedActiveCandidateId: body['expectedActiveCandidateId'] as string | null,
      }))
    } catch (error) {
      if (!(error instanceof CandidateActivationRejected)) throw error
      const status = error.code === 'candidate_scope_mismatch' ? 403
        : error.code === 'candidate_storage_inconsistent' ? 500 : 409
      sendError(
        res,
        status,
        activationRejectedMessage(error.code),
        error.code,
        status === 403 ? 'auth' : status === 500 ? 'unknown' : 'invalid_request',
        { activeCandidateId: error.activeCandidateId },
      )
    }
  }
}

export function createRollbackCandidateHandler(
  activator: CandidateActivator,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res): Promise<void> => {
    const body = await readJSON(req)
    if (!isPlainObject(body) ||
        Object.keys(body).some((key) => key !== 'profileId' && key !== 'candidateId' &&
          key !== 'expectedActiveCandidateId') ||
        typeof body['profileId'] !== 'string' ||
        !CANDIDATE_ID_PATTERN.test(String(body['candidateId'])) ||
        !(body['expectedActiveCandidateId'] === null ||
          (typeof body['expectedActiveCandidateId'] === 'string' &&
            CANDIDATE_ID_PATTERN.test(body['expectedActiveCandidateId'])))) {
      sendError(
        res,
        400,
        'Candidate rollback requires profileId, candidateId and expectedActiveCandidateId.',
        'candidate_rollback_invalid',
        'invalid_request',
      )
      return
    }
    const principal = getRequestPrincipal(req)
    if (principal?.kind === 'delegated' && principal.profileId !== body['profileId']) {
      sendError(res, 403, 'Rollback profile does not match the delegated profile scope.',
        'candidate_scope_mismatch', 'auth')
      return
    }
    try {
      sendJSON(res, 200, await activator.rollback({
        profileId: body['profileId'],
        candidateId: body['candidateId'] as string,
        expectedActiveCandidateId: body['expectedActiveCandidateId'] as string | null,
      }))
    } catch (error) {
      if (!(error instanceof CandidateActivationRejected)) throw error
      const publicCode = rollbackErrorCode(error.code)
      const status = error.code === 'candidate_scope_mismatch' ? 403
        : error.code === 'candidate_storage_inconsistent' ? 500 : 409
      sendError(
        res,
        status,
        rollbackRejectedMessage(error.code),
        publicCode,
        status === 403 ? 'auth' : status === 500 ? 'unknown' : 'invalid_request',
        { activeCandidateId: error.activeCandidateId },
      )
    }
  }
}

export function createStageCandidateHandler(
  stager: CandidateStager,
  overrides: Partial<CandidateValidationDependencies> = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  return async (req, res): Promise<void> => {
    const body = await readJSON(req)
    if (!isPlainObject(body) ||
        Object.keys(body).some((key) => key !== 'candidateId' && key !== 'files') ||
        typeof body['candidateId'] !== 'string') {
      sendError(
        res,
        400,
        'Candidate stage request must contain only candidateId and files.',
        'candidate_upload_invalid',
        'invalid_request',
      )
      return
    }
    const parsed = parseUpload({ files: body['files'] })
    if (!parsed.ok) {
      sendError(res, 400, parsed.message, 'candidate_upload_invalid', 'invalid_request')
      return
    }

    const directory = await dependencies.makeTempDirectory()
    try {
      for (const file of parsed.files) {
        const target = join(directory, file.path)
        await dependencies.makeDirectory(dirname(target), { recursive: true })
        await dependencies.writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 })
      }
      const principal = getRequestPrincipal(req)
      const result = await stager.stage({
        candidateDir: directory,
        expectedCandidateId: body['candidateId'],
        ...(principal?.kind === 'delegated' ? { profileId: principal.profileId } : {}),
        removeSourceAfterStage: true,
      })
      sendJSON(res, 200, result)
    } catch (error) {
      if (!(error instanceof CandidateStageRejected)) {
        try {
          await dependencies.removeDirectory(directory)
        } catch {
          sendError(
            res,
            500,
            'Candidate staging workspace could not be cleaned up.',
            'candidate_cleanup_failed',
            'unknown',
          )
          return
        }
        throw error
      }

      try {
        await dependencies.removeDirectory(directory)
      } catch {
        sendError(
          res,
          500,
          'Candidate staging workspace could not be cleaned up.',
          'candidate_cleanup_failed',
          'unknown',
        )
        return
      }
      const status = error.code === 'candidate_scope_mismatch' ? 403
        : error.code === 'candidate_identity_mismatch' ||
          error.code === 'candidate_stage_in_progress' ? 409
          : error.code === 'candidate_storage_inconsistent' ? 500
            : 400
      sendError(
        res,
        status,
        stageRejectedMessage(error.code),
        error.code,
        error.code === 'candidate_scope_mismatch' ? 'auth' :
          status === 500 ? 'unknown' : 'invalid_request',
        error.findings.length > 0 ? { findings: error.findings } : undefined,
      )
    }
  }
}

type ParsedUpload =
  | { readonly ok: true; readonly files: readonly { path: string; bytes: Buffer }[] }
  | { readonly ok: false; readonly message: string }

function parseUpload(value: unknown): ParsedUpload {
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== 'files')) {
    return invalid('Candidate upload must contain only a files array.')
  }
  if (!Array.isArray(value['files']) || value['files'].length === 0 ||
      value['files'].length > CANDIDATE_UPLOAD_MAX_FILES) {
    return invalid(`Candidate upload must contain 1-${CANDIDATE_UPLOAD_MAX_FILES} files.`)
  }

  const seen = new Set<string>()
  const files: Array<{ path: string; bytes: Buffer }> = []
  let totalBytes = 0
  for (const item of value['files']) {
    if (!isPlainObject(item) || Object.keys(item).some((key) => key !== 'path' && key !== 'contentBase64') ||
        typeof item['path'] !== 'string' || typeof item['contentBase64'] !== 'string') {
      return invalid('Each candidate entry must contain only path and contentBase64 strings.')
    }
    const path = item['path']
    if (!isSafePortablePath(path)) {
      return invalid('Candidate file paths must be relative portable paths without traversal.')
    }
    const folded = path.toLocaleLowerCase('en-US')
    if (seen.has(folded)) return invalid('Candidate file paths must be unique.')
    seen.add(folded)

    const bytes = decodeBase64(item['contentBase64'])
    if (bytes === null) return invalid('Candidate file content must be canonical base64.')
    totalBytes += bytes.length
    if (totalBytes > CANDIDATE_UPLOAD_MAX_BYTES) {
      return invalid(`Candidate decoded bytes exceed ${CANDIDATE_UPLOAD_MAX_BYTES}.`)
    }
    files.push({ path, bytes })
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const left = files[i]!.path.toLocaleLowerCase('en-US')
      const right = files[j]!.path.toLocaleLowerCase('en-US')
      if (left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
        return invalid('A candidate path cannot be both a file and a directory.')
      }
    }
  }
  return { ok: true, files }
}

function isSafePortablePath(path: string): boolean {
  if (path.length === 0 || path.length > CANDIDATE_UPLOAD_MAX_PATH_CHARACTERS || path.includes('\0') ||
      path.includes('\\') || isAbsolute(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    return false
  }
  const segments = path.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function decodeBase64(value: string): Buffer | null {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  return bytes.toString('base64') === value ? bytes : null
}

function invalid(message: string): ParsedUpload {
  return { ok: false, message }
}

function stageRejectedMessage(code: CandidateStageRejected['code']): string {
  const messages: Record<CandidateStageRejected['code'], string> = {
    candidate_identity_invalid: 'Candidate identity must be an opaque sha256 identity.',
    candidate_invalid: 'Candidate bytes did not pass validation.',
    candidate_identity_mismatch: 'Candidate bytes do not match the expected identity.',
    candidate_scope_mismatch: 'Candidate profile does not match the delegated profile scope.',
    candidate_stage_in_progress: 'Candidate staging is already in progress.',
    candidate_storage_inconsistent: 'Stored candidate bytes do not match their recorded identity.',
  }
  return messages[code]
}

function activationRejectedMessage(code: CandidateActivationRejected['code']): string {
  const messages: Record<CandidateActivationRejected['code'], string> = {
    candidate_not_ready: 'Candidate is not ready for activation.',
    candidate_scope_mismatch: 'Candidate does not belong to this profile.',
    candidate_storage_inconsistent: 'Stored candidate bytes do not match their recorded identity.',
    candidate_activation_conflict: 'Active candidate changed before this activation request.',
  }
  return messages[code]
}

function rollbackErrorCode(code: CandidateActivationRejected['code']): string {
  if (code === 'candidate_activation_conflict') return 'candidate_rollback_conflict'
  if (code === 'candidate_not_ready') return 'candidate_rollback_target_not_ready'
  if (code === 'candidate_storage_inconsistent') return 'candidate_rollback_storage_inconsistent'
  return 'candidate_scope_mismatch'
}

function rollbackRejectedMessage(code: CandidateActivationRejected['code']): string {
  const messages: Record<CandidateActivationRejected['code'], string> = {
    candidate_not_ready: 'Rollback candidate is not ready.',
    candidate_scope_mismatch: 'Rollback candidate does not belong to this profile.',
    candidate_storage_inconsistent: 'Rollback candidate bytes do not match their recorded identity.',
    candidate_activation_conflict: 'Active candidate changed before this rollback request.',
  }
  return messages[code]
}

function isDeploymentMutationBody(
  value: unknown,
): value is { expectedDeploymentRevision: number } {
  return isPlainObject(value) &&
    Object.keys(value).every((key) => key === 'expectedDeploymentRevision') &&
    Number.isSafeInteger(value['expectedDeploymentRevision']) &&
    (value['expectedDeploymentRevision'] as number) > 0
}

function isProfileInPrincipalScope(
  req: IncomingMessage,
  profileId: string,
  res: ServerResponse,
): boolean {
  const principal = getRequestPrincipal(req)
  if (principal?.kind !== 'delegated' || principal.profileId === profileId) return true
  sendError(res, 403, 'Profile does not match the delegated profile scope.',
    'candidate_scope_mismatch', 'auth')
  return false
}

function isReadableCandidateScope(req: IncomingMessage, profileId: string): boolean {
  const principal = getRequestPrincipal(req)
  return principal?.kind !== 'delegated' || principal.profileId === profileId
}

function projectCandidate(
  store: CandidateStore,
  candidate: NonNullable<ReturnType<CandidateStore['get']>>,
): Record<string, unknown> {
  const deletion = store.getDeletion(candidate.candidateId)
  const eligibility = store.deletionEligibility({
    profileId: candidate.profileId,
    candidateId: candidate.candidateId,
  })
  return {
    candidateId: candidate.candidateId,
    profileId: candidate.profileId,
    state: deletion?.state ?? candidate.state,
    ready: candidate.state === 'ready' && deletion === null,
    fileCount: candidate.fileCount,
    totalBytes: candidate.totalBytes,
    code: deletion?.code ?? candidate.code,
    createdAt: candidate.createdAt,
    updatedAt: deletion?.updatedAt ?? candidate.updatedAt,
    deletedAt: deletion?.deletedAt ?? null,
    deletionEligible: eligibility === 'eligible',
    deletionBlockedBy: eligibility === 'eligible' || eligibility === 'already_deleted'
      ? null : eligibility,
  }
}

function deletionRejectedMessage(code: CandidateDeleteRejected['code']): string {
  const messages: Record<CandidateDeleteRejected['code'], string> = {
    candidate_delete_not_found: 'Candidate not found.',
    candidate_scope_mismatch: 'Candidate not found.',
    candidate_delete_not_ready: 'Candidate is not ready for deletion.',
    candidate_delete_active: 'The active candidate cannot be deleted.',
    candidate_delete_in_use: 'Candidate is pinned by an active run.',
    candidate_delete_rollback_retained: 'Candidate is retained for exact rollback.',
    candidate_delete_in_progress: 'Candidate deletion is already in progress.',
  }
  return messages[code]
}

function sendDeploymentError(
  res: ServerResponse,
  error: unknown,
  operation: 'pause' | 'resume',
): void {
  if (!(error instanceof CandidateDeploymentRejected)) throw error
  const code = error.code === 'deployment_conflict' ? 'deployment_conflict'
    : error.code === 'profile_not_deployed' ? 'profile_not_deployed'
      : `deployment_${operation}_failed`
  const status = error.code === 'profile_not_deployed' ? 404
    : error.code === 'deployment_conflict' ? 409 : 409
  sendError(
    res,
    status,
    error.code === 'deployment_conflict'
      ? 'Deployment changed before this request.'
      : error.code === 'profile_not_deployed'
        ? 'Profile has no active candidate deployment.'
        : 'Active candidate could not be verified; routing state was not resumed.',
    code,
    status === 404 ? 'not_found' : 'invalid_request',
    error.actual ? {
      activeCandidateId: error.actual.candidateId,
      deploymentRevision: error.actual.deploymentRevision,
      routingState: error.actual.routingState,
      health: error.actual.health,
      healthObservedAt: error.actual.healthObservedAt,
    } : undefined,
  )
}

function claimDeploymentMutation(
  req: IncomingMessage,
  res: ServerResponse,
  store: RunIdempotencyStore,
  operation: 'profiles.pause' | 'profiles.resume',
  input: unknown,
): {
  readonly key: { principalKey: string; operation: string; key: string }
  readonly replay?: { statusCode: number; result: IdempotencySnapshot }
} | null {
  const header = req.headers['idempotency-key']
  const idempotencyKey = Array.isArray(header) ? undefined : header
  if (!idempotencyKey || !isValidIdempotencyKey(idempotencyKey)) {
    sendError(res, 400, 'Idempotency-Key must be a UUID.',
      'idempotency_key_required', 'invalid_request')
    return null
  }
  const principal = getRequestPrincipal(req)
  const key = {
    principalKey: principal ? principalContinuityKey(principal) : 'owner',
    operation,
    key: idempotencyKey,
  }
  const claim = store.claim({ ...key, input })
  if (claim.kind === 'claimed') return { key }
  if (claim.kind === 'replay') return { key, replay: claim }
  if (claim.kind === 'in_progress') res.setHeader('Retry-After', '1')
  sendError(
    res,
    409,
    claim.kind === 'conflict'
      ? 'Idempotency key was already used with different input.'
      : claim.kind === 'expired'
        ? 'Idempotency replay window expired; inspect deployment state before acting.'
        : claim.kind === 'in_progress'
          ? 'The original deployment request is still in progress.'
          : 'The original deployment request outcome is indeterminate; inspect state before acting.',
    `idempotency_${claim.kind}`,
    'invalid_request',
  )
  return null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
