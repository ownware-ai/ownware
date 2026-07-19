import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { AccessGrantStore } from '../../../src/gateway/access-grant-store.js'
import {
  EvidenceSearchCache,
  type EvidenceSearchCacheKey,
} from '../../../src/gateway/evidence-search-cache.js'
import type { ProtectedSourceSearchResult } from '../../../src/gateway/protected-source-search.js'
import { SourceStore } from '../../../src/gateway/source-store.js'
import { SourceUploadStore } from '../../../src/gateway/source-upload-store.js'

const WORKSPACE_ID = 'workspace.test'
const PROFILE_ID = 'assistant'
const VERSION_ID = '11111111-1111-4111-8111-111111111111'

describe('evidence-search cache lifecycle invalidation', () => {
  let dir: string
  let database: CortexDatabase
  let cache: EvidenceSearchCache

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evidence-cache-lifecycle-'))
    database = new CortexDatabase(join(dir, 'ownware.db'))
    cache = createCache()
  })

  afterEach(async () => {
    database.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('invalidates only the exact scoped grant immediately after revocation', () => {
    const grants = new AccessGrantStore(database.rawMainHandle, undefined, cache)
    const grant = grants.create({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      subjectId: 'person.synthetic-1',
      purpose: 'customer_support',
      channel: 'web.primary',
      resourceKind: 'source_resource',
      resourceId: '33333333-3333-4333-8333-333333333333',
      operation: 'source_content.search',
      fieldScope: { mode: 'all' },
      rowScope: { mode: 'all' },
      consent: { state: 'not_required' },
      autonomyCeiling: 'observe',
      effectiveAt: 10,
      expiresAt: 10_000,
      issuedBy: 'owner.synthetic',
    }, 10)
    putCandidate(cache, { grantId: grant.grantId })
    putCandidate(cache, { grantId: grant.grantId, profileId: 'other-profile' })

    grants.revoke({
      grantId: grant.grantId,
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      expectedRevision: 1,
    }, 20)

    expect(cache.inventoryGrant({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      grantId: grant.grantId,
    })).toEqual({ entries: 0, retainedBytes: 0 })
    expect(cache.inventoryGrant({
      workspaceId: WORKSPACE_ID,
      profileId: 'other-profile',
      grantId: grant.grantId,
    }).entries).toBe(1)
  })

  it('invalidates only the exact scoped source in the refresh transaction', () => {
    const sourceId = new SourceStore(database.rawMainHandle).create({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      kind: 'file',
      label: 'Synthetic cache refresh source',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.test',
      sensitivityPolicyRef: 'sensitivity.test',
      purposePolicyRef: 'purpose.test',
      retentionPolicyRef: 'retention.test',
      freshnessPolicyRef: 'freshness.test',
    }, 10).sourceId
    database.rawMainHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, preparation_state, created_at
      ) VALUES (?, ?, ?, 'text/plain', 4, ?, 'complete', 'ready', 20)
    `).run(
      VERSION_ID,
      sourceId,
      `sha256:${'a'.repeat(64)}`,
      `sources/${sourceId}/versions/${VERSION_ID}/original`,
    )
    database.rawMainHandle.prepare(`
      UPDATE runtime_sources SET revision = 2, current_version_id = ?,
        registration_state = 'registered', inspection_state = 'complete',
        preparation_state = 'ready', freshness_state = 'fresh', updated_at = 20
      WHERE source_id = ?
    `).run(VERSION_ID, sourceId)
    const uploads = new SourceUploadStore(database.rawMainHandle, undefined, cache)
    const upload = uploads.create({
      sourceId,
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      principalKey: 'refresh-test',
      expectedBytes: 4,
      expectedChecksum: `sha256:${'b'.repeat(64)}`,
      declaredMediaType: 'text/plain',
      filename: 'refresh.txt',
    }, 30)
    database.rawMainHandle.prepare(`
      UPDATE source_upload_sessions SET durable_offset = expected_bytes
      WHERE upload_id = ?
    `).run(upload.uploadId)
    putCandidate(cache, { sourceId })
    putCandidate(cache, { sourceId, profileId: 'other-profile' })
    const versionId = uploads.beginCompletion(upload.uploadId, 40)

    uploads.finishCompletion(upload.uploadId, {
      versionId,
      checksum: `sha256:${'b'.repeat(64)}`,
      verifiedMediaType: 'text/plain',
      byteCount: 4,
      objectKey: `sources/${sourceId}/versions/${versionId}/original`,
    }, 50)

    expect(cache.inventorySource({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId,
    })).toEqual({ entries: 0, retainedBytes: 0 })
    expect(cache.inventorySource({
      workspaceId: WORKSPACE_ID,
      profileId: 'other-profile',
      sourceId,
    }).entries).toBe(1)
  })
})

function createCache(): EvidenceSearchCache {
  return new EvidenceSearchCache({
    maxEntries: 8,
    maxEntriesPerWorkspace: 8,
    maxEntriesPerProfile: 8,
    maxRetainedBytes: 64 * 1024,
    maxRetainedBytesPerWorkspace: 64 * 1024,
    maxRetainedBytesPerProfile: 64 * 1024,
    clock: () => 40,
  })
}

function putCandidate(
  cache: EvidenceSearchCache,
  overrides: Partial<EvidenceSearchCacheKey>,
): void {
  const checksum = `sha256:${'a'.repeat(64)}`
  const key: EvidenceSearchCacheKey = {
    grantId: 'grant.synthetic-1',
    grantRevision: 1,
    grantExpiresAt: 10_000,
    evaluatorVersion: 'access_grant.v1',
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    subjectId: 'person.synthetic-1',
    purpose: 'customer_support',
    channel: 'web.primary',
    consent: { state: 'not_required' },
    permissionMode: 'auto',
    operation: 'source_content.search',
    resourceId: '33333333-3333-4333-8333-333333333333',
    sourceId: '44444444-4444-4444-8444-444444444444',
    sourceVersionId: VERSION_ID,
    sourceRevision: 2,
    sourceChecksum: checksum,
    resourceChecksum: checksum,
    preparationJobId: 'job.synthetic-1',
    objectKey: 'sources/synthetic/derived/resource/content',
    expectedByteCount: 4,
    classification: 'internal',
    authority: 'supporting_reference',
    audiencePolicyRef: 'audience.test',
    sensitivityPolicyRef: 'sensitivity.test',
    purposePolicyRef: 'purpose.test',
    retentionPolicyRef: 'retention.test',
    freshnessPolicyRef: 'freshness.test',
    query: 'needle',
    matchMode: 'exact_utf8',
    maxMatches: 5,
    contextBytes: 8,
    ...overrides,
  }
  const result: ProtectedSourceSearchResult = {
    resourceId: key.resourceId,
    sourceId: key.sourceId,
    sourceVersionId: key.sourceVersionId,
    sourceRevision: key.sourceRevision,
    sourceChecksum: key.sourceChecksum,
    resourceChecksum: key.resourceChecksum,
    freshness: 'current',
    classification: key.classification,
    authority: key.authority,
    status: 'no_matches',
    matchMode: key.matchMode,
    matches: [],
    truncated: false,
    totalByteCount: key.expectedByteCount,
    observedAt: 40,
  }
  expect(cache.put(key, result)).toBe(true)
}
