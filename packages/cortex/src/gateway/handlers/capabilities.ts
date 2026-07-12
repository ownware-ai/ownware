import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJSON } from '../router.js'
import { MAX_BODY_SIZE } from '../router.js'
import { DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS } from '../auth/scoped-principal.js'
import { IDEMPOTENCY_RETENTION_MS } from '../idempotency.js'
import type { RateLimitDescriptor } from '../middleware/rate-limit.js'
import {
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_ITEM_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  ATTACHMENT_MAX_FILENAME_CHARS,
} from '@ownware/loom'
import {
  CANDIDATE_UPLOAD_MAX_BYTES,
  CANDIDATE_UPLOAD_MAX_FILES,
  CANDIDATE_UPLOAD_MAX_PATH_CHARACTERS,
} from './candidates.js'
import { SOURCE_LIST_MAX_LIMIT } from './sources.js'
import {
  SOURCE_UPLOAD_MAX_BYTES,
  SOURCE_UPLOAD_MAX_CHUNK_BYTES,
  SOURCE_UPLOAD_MAX_CHUNKS,
  SOURCE_UPLOAD_TTL_MS,
} from '../source-upload-store.js'

const PUBLIC_CAPABILITIES = [
  { id: 'candidates.activate', version: 1 },
  { id: 'candidates.delete', version: 1 },
  { id: 'candidates.list', version: 1 },
  { id: 'candidates.read', version: 1 },
  { id: 'candidates.rollback', version: 1 },
  { id: 'candidates.stage', version: 1 },
  { id: 'candidates.validate', version: 1 },
  { id: 'gateway.capabilities', version: 2 },
  { id: 'gateway.health', version: 1 },
  { id: 'models.list', version: 1 },
  { id: 'principals.issue', version: 1 },
  { id: 'principals.revoke', version: 1 },
  { id: 'profiles.deployment.read', version: 1 },
  { id: 'profiles.list', version: 1 },
  { id: 'profiles.pause', version: 1 },
  { id: 'profiles.resume', version: 1 },
  { id: 'runs.abort', version: 2 },
  { id: 'runs.attachments', version: 1 },
  { id: 'runs.events', version: 2 },
  { id: 'runs.resume', version: 2 },
  { id: 'runs.snapshot', version: 2 },
  { id: 'runs.start', version: 4 },
  { id: 'source_uploads.complete', version: 1 },
  { id: 'source_uploads.create', version: 1 },
  { id: 'source_uploads.write', version: 1 },
  { id: 'source_versions.read', version: 1 },
  { id: 'sources.list', version: 1 },
  { id: 'sources.read', version: 1 },
  { id: 'sources.register', version: 1 },
] as const

export function createCapabilitiesHandler(
  rateLimit: () => RateLimitDescriptor,
): (_req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (_req, res): Promise<void> => {
    sendJSON(res, 200, {
      contract: {
        name: 'ownware.gateway',
        major: 1,
        revision: '0.17.0',
      },
      capabilities: PUBLIC_CAPABILITIES,
      limits: {
        jsonBodyBytes: MAX_BODY_SIZE,
        candidateUpload: {
          maxFiles: CANDIDATE_UPLOAD_MAX_FILES,
          maxDecodedBytes: CANDIDATE_UPLOAD_MAX_BYTES,
          maxPathCharacters: CANDIDATE_UPLOAD_MAX_PATH_CHARACTERS,
        },
        runAttachments: {
          maxCount: ATTACHMENT_MAX_COUNT,
          maxItemDecodedBytes: ATTACHMENT_MAX_ITEM_BYTES,
          maxTotalDecodedBytes: ATTACHMENT_MAX_TOTAL_BYTES,
          maxFilenameCharacters: ATTACHMENT_MAX_FILENAME_CHARS,
        },
        sourceList: { maxPageSize: SOURCE_LIST_MAX_LIMIT },
        sourceUpload: {
          maxDecodedBytes: SOURCE_UPLOAD_MAX_BYTES,
          maxChunkBytes: SOURCE_UPLOAD_MAX_CHUNK_BYTES,
          maxChunks: SOURCE_UPLOAD_MAX_CHUNKS,
          sessionTtlSeconds: SOURCE_UPLOAD_TTL_MS / 1000,
          supportedMediaTypes: ['text/plain', 'application/pdf'],
        },
        delegationDefaultTtlSeconds: DEFAULT_TTL_SECONDS,
        delegationMaxTtlSeconds: MAX_TTL_SECONDS,
        idempotencyRetentionSeconds: IDEMPOTENCY_RETENTION_MS / 1000,
        rateLimit: rateLimit(),
      },
    })
  }
}
