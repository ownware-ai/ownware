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
import { SOURCE_JOB_MAX_ATTEMPTS } from '../source-job-store.js'
import {
  SOURCE_INSPECTION_MAX_BYTES,
  SOURCE_INSPECTION_TIMEOUT_MS,
  SOURCE_PREPARATION_MAX_BYTES,
  SOURCE_PREPARATION_MAX_RESOURCES,
  SOURCE_PREPARATION_TIMEOUT_MS,
} from '../source-job-worker.js'
import type { SourceQuotaLimits } from '../source-quota-policy.js'
import {
  ACCESS_GRANT_MAX_ACTIVE_PER_SCOPE,
  ACCESS_GRANT_MAX_SCOPE_IDS,
  ACCESS_GRANT_MAX_TTL_SECONDS,
  ACCESS_GRANT_MIN_TTL_SECONDS,
} from '../access-grant-store.js'
import {
  CSV_DATA_VIEW_ARTIFACT_MAX_BYTES,
  SOURCE_UTF8_MAX_FULL_BYTES,
  SOURCE_UTF8_RANGE_MAX_BYTES,
  SOURCE_UTF8_SEARCH_MAX_CONTEXT_BYTES,
  SOURCE_UTF8_SEARCH_MAX_MATCHES,
  SOURCE_UTF8_SEARCH_MAX_QUERY_BYTES,
  SOURCE_UTF8_SEARCH_TIMEOUT_MS,
} from '../source-byte-store.js'
import { ACCESS_GRANT_LIST_MAX_LIMIT } from './access-grants.js'
import { CONNECTION_LIST_MAX_LIMIT } from './connection-inventory.js'
import {
  CSV_DATA_VIEW_MAX_BYTES,
  CSV_DATA_VIEW_MAX_CELL_BYTES,
  CSV_DATA_VIEW_MAX_CELLS,
  CSV_DATA_VIEW_MAX_FIELDS,
  CSV_DATA_VIEW_MAX_ROWS,
  CSV_DATA_VIEW_TIMEOUT_MS,
} from '../csv-data-view.js'
import {
  CSV_DATA_VIEW_SELECTION_MAX_FIELDS,
  CSV_DATA_VIEW_SELECTION_MAX_RESULT_BYTES,
  CSV_DATA_VIEW_SELECTION_TIMEOUT_MS,
} from '../csv-data-view-selection.js'
import { PROTECTED_DATA_VIEW_SELECTION_MAX_ROWS } from '../protected-data-view-selection.js'
import { SOURCE_DATA_VIEW_JOB_MAX_ATTEMPTS } from '../source-data-view-store.js'

const PUBLIC_CAPABILITIES = [
  { id: 'access_grants.create', version: 3 },
  { id: 'access_grants.list', version: 1 },
  { id: 'access_grants.read', version: 1 },
  { id: 'access_grants.revoke', version: 1 },
  { id: 'candidates.activate', version: 1 },
  { id: 'candidates.delete', version: 1 },
  { id: 'candidates.list', version: 1 },
  { id: 'candidates.read', version: 1 },
  { id: 'candidates.rollback', version: 1 },
  { id: 'candidates.stage', version: 1 },
  { id: 'candidates.validate', version: 1 },
  { id: 'connections.list', version: 1 },
  { id: 'gateway.capabilities', version: 11 },
  { id: 'gateway.health', version: 1 },
  { id: 'models.list', version: 1 },
  { id: 'principals.issue', version: 3 },
  { id: 'principals.revoke', version: 1 },
  { id: 'profiles.deployment.read', version: 1 },
  { id: 'profiles.list', version: 1 },
  { id: 'profiles.pause', version: 1 },
  { id: 'profiles.resume', version: 1 },
  { id: 'runs.abort', version: 3 },
  { id: 'runs.attachments', version: 1 },
  { id: 'runs.events', version: 3 },
  { id: 'runs.resume', version: 3 },
  { id: 'runs.snapshot', version: 3 },
  { id: 'runs.start', version: 5 },
  { id: 'source_deletions.cancel', version: 1 },
  { id: 'source_deletions.create', version: 1 },
  { id: 'source_deletions.read', version: 1 },
  { id: 'source_deletions.retry', version: 1 },
  { id: 'source_uploads.complete', version: 2 },
  { id: 'source_uploads.create', version: 3 },
  { id: 'source_uploads.write', version: 1 },
  { id: 'source_jobs.cancel', version: 2 },
  { id: 'source_jobs.create', version: 2 },
  { id: 'source_jobs.read', version: 3 },
  { id: 'source_preparations.create', version: 3 },
  { id: 'source_content.read', version: 2 },
  { id: 'source_content.search', version: 2 },
  { id: 'source_data_views.query', version: 1 },
  { id: 'source_data_views.read', version: 1 },
  { id: 'source_resources.read', version: 1 },
  { id: 'source_versions.read', version: 1 },
  { id: 'sources.list', version: 1 },
  { id: 'sources.read', version: 1 },
  { id: 'sources.register', version: 2 },
] as const

export function createCapabilitiesHandler(
  rateLimit: () => RateLimitDescriptor,
  sourceQuota: SourceQuotaLimits,
): (_req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (_req, res): Promise<void> => {
    sendJSON(res, 200, {
      contract: {
        name: 'ownware.gateway',
        major: 1,
        revision: '0.30.0',
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
        connectionList: { maxPageSize: CONNECTION_LIST_MAX_LIMIT },
        sourceUpload: {
          maxDecodedBytes: SOURCE_UPLOAD_MAX_BYTES,
          maxChunkBytes: SOURCE_UPLOAD_MAX_CHUNK_BYTES,
          maxChunks: SOURCE_UPLOAD_MAX_CHUNKS,
          sessionTtlSeconds: SOURCE_UPLOAD_TTL_MS / 1000,
          supportedSourceKinds: ['file', 'text', 'structured_export'],
          supportedMediaTypes: ['text/plain', 'application/pdf'],
        },
        sourceInspection: {
          maxBytes: SOURCE_INSPECTION_MAX_BYTES,
          perAttemptTimeoutMs: SOURCE_INSPECTION_TIMEOUT_MS,
          maxAttempts: SOURCE_JOB_MAX_ATTEMPTS,
        },
        sourcePreparation: {
          maxBytes: SOURCE_PREPARATION_MAX_BYTES,
          perAttemptTimeoutMs: SOURCE_PREPARATION_TIMEOUT_MS,
          maxAttempts: SOURCE_JOB_MAX_ATTEMPTS,
          maxResourcesPerJob: SOURCE_PREPARATION_MAX_RESOURCES,
        },
        sourceDataView: {
          supportedFormats: ['strict_utf8_csv'],
          maxSourceBytes: CSV_DATA_VIEW_MAX_BYTES,
          maxArtifactBytes: CSV_DATA_VIEW_ARTIFACT_MAX_BYTES,
          maxFields: CSV_DATA_VIEW_MAX_FIELDS,
          maxRows: CSV_DATA_VIEW_MAX_ROWS,
          maxCellBytes: CSV_DATA_VIEW_MAX_CELL_BYTES,
          maxCells: CSV_DATA_VIEW_MAX_CELLS,
          perAttemptTimeoutMs: CSV_DATA_VIEW_TIMEOUT_MS,
          maxAttempts: SOURCE_DATA_VIEW_JOB_MAX_ATTEMPTS,
          maxQueryFields: CSV_DATA_VIEW_SELECTION_MAX_FIELDS,
          maxQueryRows: PROTECTED_DATA_VIEW_SELECTION_MAX_ROWS,
          maxQueryCells:
            CSV_DATA_VIEW_SELECTION_MAX_FIELDS * PROTECTED_DATA_VIEW_SELECTION_MAX_ROWS,
          maxQueryResultBytes: CSV_DATA_VIEW_SELECTION_MAX_RESULT_BYTES,
          queryTimeoutMs: CSV_DATA_VIEW_SELECTION_TIMEOUT_MS,
          maxGrantScopeIds: ACCESS_GRANT_MAX_SCOPE_IDS,
        },
        accessGrants: {
          minTtlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
          maxTtlSeconds: ACCESS_GRANT_MAX_TTL_SECONDS,
          maxActivePerWorkspaceProfile: ACCESS_GRANT_MAX_ACTIVE_PER_SCOPE,
          maxPageSize: ACCESS_GRANT_LIST_MAX_LIMIT,
        },
        sourceContent: { maxRangeBytes: SOURCE_UTF8_RANGE_MAX_BYTES },
        sourceSearch: {
          maxScanBytes: SOURCE_UTF8_MAX_FULL_BYTES,
          maxQueryBytes: SOURCE_UTF8_SEARCH_MAX_QUERY_BYTES,
          maxMatches: SOURCE_UTF8_SEARCH_MAX_MATCHES,
          maxContextBytes: SOURCE_UTF8_SEARCH_MAX_CONTEXT_BYTES,
          perRequestTimeoutMs: SOURCE_UTF8_SEARCH_TIMEOUT_MS,
          matchModes: ['exact_utf8', 'ascii_case_insensitive'],
        },
        sourceQuota,
        delegationDefaultTtlSeconds: DEFAULT_TTL_SECONDS,
        delegationMaxTtlSeconds: MAX_TTL_SECONDS,
        idempotencyRetentionSeconds: IDEMPOTENCY_RETENTION_MS / 1000,
        rateLimit: rateLimit(),
      },
    })
  }
}
