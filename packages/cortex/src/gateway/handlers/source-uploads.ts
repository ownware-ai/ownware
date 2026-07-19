import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { getRequestPrincipal } from '../auth/scoped-principal.js'
import {
  isValidIdempotencyKey,
  principalContinuityKey,
  type RunIdempotencyStore,
} from '../idempotency.js'
import { readJSON, sendError, sendJSON } from '../router.js'
import type { SourceStore } from '../source-store.js'
import {
  SOURCE_UPLOAD_MAX_CHUNK_BYTES,
  SOURCE_UPLOAD_MAX_CHUNKS,
  SOURCE_UPLOAD_MAX_BYTES,
  SourceUploadRefreshConflictError,
  SourceUploadTargetNotFoundError,
  type SourceUploadStore,
} from '../source-upload-store.js'
import { SourceByteStore, SourceByteStoreError } from '../source-byte-store.js'
import { SourceQuotaExceededError } from '../source-quota-policy.js'

const SAFE_FILENAME = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029/\\]+$/u

const UploadSessionInputSchema = z.object({
  expectedBytes: z.number().int().min(1).max(SOURCE_UPLOAD_MAX_BYTES),
  expectedChecksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  declaredMediaType: z.enum(['text/plain', 'application/pdf']),
  filename: z.string().trim().min(1).max(255).regex(SAFE_FILENAME),
}).strict()

export function createSourceUploadSessionHandler(
  sources: SourceStore,
  uploads: SourceUploadStore,
  idempotency: RunIdempotencyStore,
): (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const principal = getRequestPrincipal(req)
    if (principal?.kind !== 'delegated') {
      sendError(res, 403, 'A scoped principal is required for source upload sessions.',
        'source_scoped_principal_required', 'auth')
      return
    }
    const sourceId = params['sourceId'] ?? ''
    const source = sources.getScoped(sourceId, principal.workspaceId, principal.profileId)
    if (!source) {
      sendError(res, 404, 'Source not found.', 'source_not_found', 'not_found')
      return
    }
    const parsed = UploadSessionInputSchema.safeParse(await readJSON(req))
    if (!parsed.success) {
      sendError(res, 400, 'Source upload session declaration is invalid.',
        'source_upload_session_invalid', 'invalid_request')
      return
    }
    if (!['file', 'text', 'structured_export'].includes(source.kind) ||
        (['text', 'structured_export'].includes(source.kind) &&
          parsed.data.declaredMediaType !== 'text/plain') ||
        source.health.deletion !== 'active') {
      sendError(res, 409, 'Source does not support this upload declaration.',
        'source_upload_unsupported', 'invalid_request')
      return
    }
    const rawKey = req.headers['idempotency-key']
    const idempotencyKey = Array.isArray(rawKey) ? undefined : rawKey
    if (!idempotencyKey || !isValidIdempotencyKey(idempotencyKey)) {
      sendError(res, 400, 'Idempotency-Key must be a UUID.',
        'idempotency_key_required', 'invalid_request')
      return
    }
    const principalKey = principalContinuityKey(principal)
    const key = { principalKey, operation: 'source_uploads.create', key: idempotencyKey }
    const claim = idempotency.claim({ ...key, input: { sourceId, ...parsed.data } })
    if (claim.kind === 'replay') {
      res.setHeader('Idempotency-Replayed', 'true')
      sendJSON(res, claim.statusCode, claim.result)
      return
    }
    if (claim.kind !== 'claimed') {
      if (claim.kind === 'in_progress') res.setHeader('Retry-After', '1')
      sendError(res, 409,
        claim.kind === 'conflict'
          ? 'Idempotency key was already used with different input.'
          : 'The original upload-session request is not safely repeatable.',
        `idempotency_${claim.kind}`, 'invalid_request')
      return
    }
    try {
      const result = uploads.create({
        sourceId,
        workspaceId: principal.workspaceId,
        profileId: principal.profileId,
        principalKey,
        ...parsed.data,
      })
      idempotency.complete({ ...key, statusCode: 201, result })
      sendJSON(res, 201, result)
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
      if (error instanceof SourceUploadTargetNotFoundError) {
        sendError(res, 404, 'Source not found.', 'source_not_found', 'not_found')
        return
      }
      throw error
    }
  }
}

export function createWriteSourceUploadChunkHandler(
  uploads: SourceUploadStore,
  bytes: SourceByteStore,
): (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const principal = getRequestPrincipal(req)
    if (principal?.kind !== 'delegated') {
      sendError(res, 403, 'A scoped principal is required for source uploads.',
        'source_scoped_principal_required', 'auth')
      return
    }
    const uploadId = params['uploadId'] ?? ''
    const principalKey = principalContinuityKey(principal)
    const initial = uploads.getScoped(
      uploadId, principal.workspaceId, principal.profileId, principalKey,
    )
    if (!initial) {
      sendError(res, 404, 'Source upload not found.', 'source_upload_not_found', 'not_found')
      return
    }
    if (initial.state !== 'open') {
      sendError(res, 409, 'Source upload is not open.',
        initial.state === 'expired' ? 'source_upload_expired' : 'source_upload_closed',
        'invalid_request')
      return
    }
    const rawOffset = singleHeader(req.headers['upload-offset'])
    const declaredChecksum = singleHeader(req.headers['upload-chunk-checksum'])
    const contentType = singleHeader(req.headers['content-type'])
    if (!rawOffset || !/^(0|[1-9][0-9]*)$/.test(rawOffset) ||
        !Number.isSafeInteger(Number(rawOffset)) ||
        !declaredChecksum || !/^sha256:[0-9a-f]{64}$/.test(declaredChecksum) ||
        contentType !== 'application/offset+octet-stream') {
      sendError(res, 400, 'Source upload chunk headers are invalid.',
        'source_upload_chunk_invalid', 'invalid_request')
      return
    }
    const requestedOffset = Number(rawOffset)
    const received = await bytes.receive(
      req,
      SOURCE_UPLOAD_MAX_CHUNK_BYTES,
      uploadId,
    ).catch((error) => {
      if (error instanceof SourceByteStoreError && error.code === 'chunk_too_large') {
        sendError(res, 413, 'Source upload chunk exceeds the maximum size.',
          'source_upload_chunk_too_large', 'invalid_request',
          { limitBytes: SOURCE_UPLOAD_MAX_CHUNK_BYTES })
        return null
      }
      throw error
    })
    if (!received) return
    try {
      if (received.byteCount === 0 || received.checksum !== declaredChecksum) {
        sendError(res, 400, 'Source upload chunk checksum or size is invalid.',
          'source_upload_chunk_invalid', 'invalid_request')
        return
      }
      const result = await bytes.withUploadLock(uploadId, async () => {
        const session = uploads.getScoped(
          uploadId, principal.workspaceId, principal.profileId, principalKey,
        )
        if (!session || session.state !== 'open') return { kind: 'closed' } as const
        if (requestedOffset < session.offset) {
          const prior = uploads.findChunk(uploadId, requestedOffset)
          return prior && prior.byteCount === received.byteCount &&
            prior.checksum === received.checksum
            ? { kind: 'replay', session } as const
            : { kind: 'conflict', session } as const
        }
        if (requestedOffset !== session.offset) return { kind: 'conflict', session } as const
        if (session.chunkCount >= SOURCE_UPLOAD_MAX_CHUNKS ||
            session.offset + received.byteCount > session.expectedBytes) {
          return { kind: 'limit', session } as const
        }
        await bytes.reconcile(uploadId, session.offset)
        await bytes.append(uploadId, received)
        try {
          const advanced = uploads.advanceChunk(uploadId, session.offset, received)
          return { kind: 'accepted', session, advanced } as const
        } catch (error) {
          await bytes.reconcile(uploadId, session.offset)
          throw error
        }
      })
      if (result.kind === 'replay') {
        sendJSON(res, 200, {
          uploadId, state: 'open', offset: result.session.offset,
          chunkCount: result.session.chunkCount, replayed: true,
        })
      } else if (result.kind === 'accepted') {
        sendJSON(res, 200, {
          uploadId, state: 'open', offset: result.advanced.offset,
          chunkCount: result.advanced.chunkCount, replayed: false,
        })
      } else if (result.kind === 'limit') {
        sendError(res, 413, 'Source upload exceeds its declared limits.',
          'source_upload_limit_exceeded', 'invalid_request',
          { expectedOffset: result.session.offset })
      } else if (result.kind === 'closed') {
        sendError(res, 409, 'Source upload is not open.',
          'source_upload_closed', 'invalid_request')
      } else {
        sendError(res, 409, 'Source upload offset or prior chunk does not match.',
          'source_upload_offset_conflict', 'invalid_request',
          { expectedOffset: result.session.offset })
      }
    } catch (error) {
      if (error instanceof SourceByteStoreError && error.code === 'storage_inconsistent') {
        sendError(res, 409, 'Source upload storage is inconsistent.',
          'source_upload_storage_inconsistent', 'unknown')
        return
      }
      throw error
    } finally {
      await bytes.discard(received)
    }
  }
}

export function createCompleteSourceUploadHandler(
  uploads: SourceUploadStore,
  bytes: SourceByteStore,
): (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const principal = getRequestPrincipal(req)
    if (principal?.kind !== 'delegated') {
      sendError(res, 403, 'A scoped principal is required for source uploads.',
        'source_scoped_principal_required', 'auth')
      return
    }
    const uploadId = params['uploadId'] ?? ''
    const principalKey = principalContinuityKey(principal)
    const result = await bytes.withUploadLock(uploadId, async () => {
      const session = uploads.getScoped(
        uploadId, principal.workspaceId, principal.profileId, principalKey,
      )
      if (!session) return { kind: 'missing' } as const
      if (session.state === 'completed') {
        return { kind: 'replay', version: uploads.getCompletedVersion(uploadId)! } as const
      }
      if (session.state === 'failed' && session.code === 'source_upload_refresh_conflict') {
        const actual = uploads.getCurrentSourceIdentity(session.sourceId)
        if (actual) {
          return {
            kind: 'refresh_conflict',
            error: new SourceUploadRefreshConflictError(
              actual.revision,
              actual.currentVersionId,
            ),
          } as const
        }
      }
      if (session.state === 'failed' && session.code === 'source_upload_cleanup_failed') {
        return { kind: 'cleanup_failed' } as const
      }
      if (session.state !== 'open' && session.state !== 'completing') {
        return { kind: 'closed', session } as const
      }
      if (session.state === 'open' && session.offset !== session.expectedBytes) {
        return { kind: 'incomplete', session } as const
      }
      try {
        let versionId = session.pendingVersionId
        let inspected
        let objectKey: string
        if (session.state === 'open') {
          await bytes.reconcile(uploadId, session.offset)
          inspected = await bytes.inspectStaging(uploadId, session.declaredMediaType)
          if (inspected.byteCount !== session.expectedBytes ||
              inspected.checksum !== session.expectedChecksum) {
            uploads.markFailed(uploadId, 'source_upload_verification_failed')
            return { kind: 'verification_failed' } as const
          }
          versionId = uploads.beginCompletion(uploadId)
          objectKey = await bytes.place(uploadId, session.sourceId, versionId)
        } else {
          if (!versionId) throw new Error('Completing upload has no pending version')
          objectKey = `sources/${session.sourceId}/versions/${versionId}/original`
          await bytes.place(uploadId, session.sourceId, versionId)
          inspected = await bytes.inspectPlaced(objectKey, session.declaredMediaType)
        }
        let version
        try {
          version = uploads.finishCompletion(uploadId, {
            versionId: versionId!,
            checksum: inspected.checksum,
            verifiedMediaType: inspected.verifiedMediaType,
            byteCount: inspected.byteCount,
            objectKey,
          })
        } catch (error) {
          if (!(error instanceof SourceUploadRefreshConflictError)) throw error
          try {
            await bytes.discardPlaced(objectKey)
          } catch {
            uploads.markFailed(uploadId, 'source_upload_cleanup_failed')
            return { kind: 'cleanup_failed' } as const
          }
          uploads.markFailedAfterVerifiedCleanup(uploadId, 'source_upload_refresh_conflict')
          return { kind: 'refresh_conflict', error } as const
        }
        return { kind: 'completed', version } as const
      } catch (error) {
        if (error instanceof SourceByteStoreError) {
          uploads.markFailed(uploadId, 'source_upload_verification_failed')
          return { kind: 'verification_failed' } as const
        }
        throw error
      }
    })
    if (result.kind === 'missing') {
      sendError(res, 404, 'Source upload not found.', 'source_upload_not_found', 'not_found')
    } else if (result.kind === 'replay') {
      sendJSON(res, 200, { ...result.version, replayed: true })
    } else if (result.kind === 'completed') {
      sendJSON(res, 201, { ...result.version, replayed: false })
    } else if (result.kind === 'incomplete') {
      sendError(res, 409, 'Source upload has not received all declared bytes.',
        'source_upload_incomplete', 'invalid_request',
        { expectedOffset: result.session.offset, expectedBytes: result.session.expectedBytes })
    } else if (result.kind === 'verification_failed') {
      sendError(res, 422, 'Source upload failed checksum or format verification.',
        'source_upload_verification_failed', 'invalid_request')
    } else if (result.kind === 'refresh_conflict') {
      sendError(res, 409, 'Source changed after this upload session was created.',
        'source_upload_refresh_conflict', 'invalid_request', {
          actualRevision: result.error.actualRevision,
          actualCurrentVersionId: result.error.actualCurrentVersionId,
        })
    } else if (result.kind === 'cleanup_failed') {
      sendError(res, 500, 'Source upload cleanup could not be verified.',
        'source_upload_cleanup_failed', 'unknown')
    } else {
      sendError(res, 409, 'Source upload is not open for completion.',
        result.session.state === 'expired' ? 'source_upload_expired' : 'source_upload_closed',
        'invalid_request')
    }
  }
}

export function createGetSourceVersionHandler(
  uploads: SourceUploadStore,
): (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> {
  return async (req, res, params): Promise<void> => {
    const principal = getRequestPrincipal(req)
    if (principal?.kind !== 'delegated') {
      sendError(res, 403, 'A scoped principal is required for source versions.',
        'source_scoped_principal_required', 'auth')
      return
    }
    const version = uploads.getVersionScoped(
      params['sourceId'] ?? '', params['sourceVersionId'] ?? '',
      principal.workspaceId, principal.profileId,
    )
    if (!version) {
      sendError(res, 404, 'Source version not found.',
        'source_version_not_found', 'not_found')
      return
    }
    sendJSON(res, 200, version)
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value
}
