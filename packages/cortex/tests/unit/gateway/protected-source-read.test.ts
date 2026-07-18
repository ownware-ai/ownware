import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACCESS_GRANT_MIN_TTL_SECONDS,
  AccessGrantStore,
  type AccessGrantRevision,
} from '../../../src/gateway/access-grant-store.js'
import { AccessGrantEvaluator } from '../../../src/gateway/access-grant-evaluator.js'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import {
  ProtectedSourceReadService,
  type ProtectedSourceReadHardFloor,
  type ProtectedSourceReadInput,
} from '../../../src/gateway/protected-source-read.js'
import {
  ProtectedSourceSearchService,
  type ProtectedSourceSearchInput,
} from '../../../src/gateway/protected-source-search.js'
import {
  SourceByteStore,
  type SourceUtf8RangeReadInput,
  type SourceUtf8RangeReadResult,
  type SourceUtf8SearchInput,
  type SourceUtf8SearchResult,
} from '../../../src/gateway/source-byte-store.js'
import { SourceJobStore } from '../../../src/gateway/source-job-store.js'
import { SourceStore } from '../../../src/gateway/source-store.js'

const VERSION_ID = '11111111-1111-4111-8111-111111111111'
const MISSING_RESOURCE_ID = '22222222-2222-4222-8222-222222222222'
const CONTENT = Buffer.from('first|caf\u00e9|final')

let dir: string
let storageRoot: string
let database: CortexDatabase
let grants: AccessGrantStore
let evaluator: AccessGrantEvaluator
let bytes: HookedByteStore
let target: Awaited<ReturnType<typeof seedPreparedTextResource>>
let grant: AccessGrantRevision

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'protected-source-read-'))
  storageRoot = join(dir, 'source-storage')
  database = new CortexDatabase(join(dir, 'ownware.db'))
  grants = new AccessGrantStore(database.rawMainHandle)
  evaluator = new AccessGrantEvaluator(grants)
  bytes = new HookedByteStore(storageRoot)
  target = await seedPreparedTextResource()
  grant = grants.createPreparedTextReadGrant({
    workspaceId: 'workspace.test',
    profileId: 'assistant',
    subjectId: 'person.synthetic-1',
    purpose: 'customer_support',
    channel: 'web.primary',
    resourceId: target.resourceId,
    consent: { state: 'not_required' },
    ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
    issuedBy: 'owner.synthetic',
  }, 100)
})

afterEach(async () => {
  database.close()
  await rm(dir, { recursive: true, force: true })
})

describe('ProtectedSourceReadService', () => {
  it('returns one bounded verified range with exact safe lineage', async () => {
    const service = createService()
    const result = await service.read(input(0, 5))

    expect(result).toEqual({
      resourceId: target.resourceId,
      sourceId: target.sourceId,
      sourceVersionId: VERSION_ID,
      sourceRevision: target.sourceRevision,
      sourceChecksum: checksum(CONTENT),
      resourceChecksum: checksum(CONTENT),
      freshness: 'current',
      classification: 'internal',
      authority: 'supporting_reference',
      text: 'first',
      byteStart: 0,
      byteEnd: 5,
      byteCount: 5,
      totalByteCount: CONTENT.length,
      observedAt: 200,
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('object_key')
    expect(serialized).not.toContain('sources/')
    expect(serialized).not.toContain('policy.test')
    expect(bytes.calls).toBe(1)
  })

  it('collapses wrong resource, subject, consent, and grant state before bytes', async () => {
    const service = createService()
    const denied = [
      { ...input(0, 1), resourceId: MISSING_RESOURCE_ID },
      { ...input(0, 1), subjectId: 'person.synthetic-other' },
      {
        ...input(0, 1),
        consent: { state: 'recorded', evidenceId: 'consent.synthetic-other' } as const,
      },
    ]
    for (const request of denied) {
      await expect(service.read(request)).rejects.toMatchObject({
        code: 'protected_source_unavailable',
      })
    }
    grants.revoke({
      grantId: grant.grantId,
      workspaceId: grant.workspaceId,
      profileId: grant.profileId,
      expectedRevision: grant.revision,
    }, 201)
    await expect(service.read(input(0, 1))).rejects.toMatchObject({
      code: 'protected_source_unavailable',
    })
    expect(bytes.calls).toBe(0)
  })

  it('checks the runtime hard floor before scanning and again before release', async () => {
    const denyFirst = createService(() => ({
      decision: 'deny', ruleId: 'source.policy.denied',
    }))
    await expect(denyFirst.read(input(0, 5))).rejects.toMatchObject({
      code: 'protected_source_unavailable',
    })
    expect(bytes.calls).toBe(0)

    let checks = 0
    const denySecond = createService(() => ++checks === 1
      ? { decision: 'allow' }
      : { decision: 'deny', ruleId: 'source.policy.changed' })
    await expect(denySecond.read(input(0, 5))).rejects.toMatchObject({
      code: 'protected_source_unavailable',
    })
    expect(checks).toBe(2)
    expect(bytes.calls).toBe(1)
  })

  it('withholds buffered text when the grant is revoked during the scan', async () => {
    bytes.afterRead = () => {
      grants.revoke({
        grantId: grant.grantId,
        workspaceId: grant.workspaceId,
        profileId: grant.profileId,
        expectedRevision: grant.revision,
      }, 201)
    }
    await expect(createService().read(input(0, 5))).rejects.toMatchObject({
      code: 'protected_source_unavailable',
    })
    expect(bytes.calls).toBe(1)
  })

  it('withholds buffered text when source freshness changes during the scan', async () => {
    bytes.afterRead = () => {
      database.rawMainHandle.prepare(`
        UPDATE runtime_sources SET freshness_state = 'stale', revision = revision + 1
        WHERE source_id = ?
      `).run(target.sourceId)
    }
    await expect(createService().read(input(0, 5))).rejects.toMatchObject({
      code: 'protected_source_unavailable',
    })
    expect(bytes.calls).toBe(1)
  })

  it('withholds buffered text when the grant expires during the scan', async () => {
    const times = [100, grant.expiresAt]
    const service = createService(undefined, () => times.shift() ?? grant.expiresAt)

    await expect(service.read(input(0, 5))).rejects.toMatchObject({
      code: 'protected_source_unavailable',
    })
    expect(bytes.calls).toBe(1)
  })

  it('collapses full-object tampering and never returns the selected text', async () => {
    await writeFile(target.objectPath, Buffer.from('first|cafe|final'))

    await expect(createService().read(input(0, 5))).rejects.toMatchObject({
      code: 'protected_source_unavailable',
    })
    expect(bytes.calls).toBe(1)
  })

  it('rejects malformed and oversized ranges before protected lookup or bytes', async () => {
    const service = createService()
    await expect(service.read(input(1, 1))).rejects.toMatchObject({
      code: 'protected_source_range_invalid',
    })
    await expect(service.read(input(0, 64 * 1024 + 1))).rejects.toMatchObject({
      code: 'protected_source_range_too_large',
    })
    expect(bytes.calls).toBe(0)
  })
})

describe('ProtectedSourceSearchService', () => {
  it('requires a separate search grant and returns stable bounded evidence', async () => {
    const service = createSearchService()
    await expect(service.search(searchInput())).rejects.toMatchObject({
      code: 'protected_source_search_unavailable',
    })
    expect(bytes.calls).toBe(0)

    grants.createPreparedTextAccessGrant({
      workspaceId: 'workspace.test',
      profileId: 'assistant',
      subjectId: 'person.synthetic-1',
      purpose: 'customer_support',
      channel: 'web.primary',
      resourceId: target.resourceId,
      operation: 'source_content.search',
      consent: { state: 'not_required' },
      ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
      issuedBy: 'owner.synthetic',
    }, 100)
    const result = await service.search(searchInput())

    expect(result).toMatchObject({
      resourceId: target.resourceId,
      sourceId: target.sourceId,
      sourceVersionId: VERSION_ID,
      sourceRevision: target.sourceRevision,
      sourceChecksum: checksum(CONTENT),
      resourceChecksum: checksum(CONTENT),
      freshness: 'current',
      classification: 'internal',
      authority: 'supporting_reference',
      status: 'complete',
      matchMode: 'exact_utf8',
      truncated: false,
      totalByteCount: CONTENT.length,
      observedAt: 200,
      matches: [{
        evidenceId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        text: 't|café|f',
        byteStart: 4,
        byteEnd: 13,
        matchByteStart: 6,
        matchByteEnd: 11,
      }],
    })
    expect(JSON.stringify(result)).not.toContain('sources/')
    expect(bytes.calls).toBe(1)
  })

  it('returns an honest no-match result', async () => {
    createSearchGrant()
    const result = await createSearchService().search(searchInput('absent'))
    expect(result).toMatchObject({
      status: 'no_matches', matches: [], truncated: false,
    })
  })

  it('withholds matches when the search grant is revoked after scanning', async () => {
    const searchGrant = createSearchGrant()
    bytes.afterRead = () => {
      grants.revoke({
        grantId: searchGrant.grantId,
        workspaceId: searchGrant.workspaceId,
        profileId: searchGrant.profileId,
        expectedRevision: searchGrant.revision,
      }, 201)
    }
    await expect(createSearchService().search(searchInput())).rejects.toMatchObject({
      code: 'protected_source_search_unavailable',
    })
    bytes.afterRead = undefined
    await expect(createService().read(input(0, 5))).resolves.toMatchObject({ text: 'first' })
  })

  it('rejects malformed search bounds before lookup or bytes', async () => {
    const service = createSearchService()
    for (const invalid of [
      { ...searchInput(''), query: '' },
      { ...searchInput(), maxMatches: 21 },
      { ...searchInput(), contextBytes: 1025 },
      { ...searchInput('é'), matchMode: 'ascii_case_insensitive' as const },
    ]) {
      await expect(service.search(invalid)).rejects.toMatchObject({
        code: 'protected_source_search_invalid',
      })
    }
    expect(bytes.calls).toBe(0)
  })

  it('passes the search operation through both hard-floor checks', async () => {
    createSearchGrant()
    const operations: string[] = []
    const service = createSearchService((context) => {
      operations.push(context.operation)
      return { decision: 'allow' }
    })
    await service.search(searchInput())
    expect(operations).toEqual(['source_content.search', 'source_content.search'])
  })
})

class HookedByteStore extends SourceByteStore {
  calls = 0
  afterRead: (() => void | Promise<void>) | undefined

  override async readPlacedUtf8Range(
    value: SourceUtf8RangeReadInput,
  ): Promise<SourceUtf8RangeReadResult> {
    this.calls += 1
    const result = await super.readPlacedUtf8Range(value)
    await this.afterRead?.()
    return result
  }

  override async searchPlacedUtf8(
    value: SourceUtf8SearchInput,
  ): Promise<SourceUtf8SearchResult> {
    this.calls += 1
    const result = await super.searchPlacedUtf8(value)
    await this.afterRead?.()
    return result
  }
}

function createService(
  hardFloor: ProtectedSourceReadHardFloor = () => ({ decision: 'allow' }),
  clock: () => number = () => 200,
): ProtectedSourceReadService {
  return new ProtectedSourceReadService(grants, evaluator, bytes, hardFloor, clock)
}

function createSearchService(
  hardFloor: ProtectedSourceReadHardFloor = () => ({ decision: 'allow' }),
  clock: () => number = () => 200,
): ProtectedSourceSearchService {
  return new ProtectedSourceSearchService(grants, evaluator, bytes, hardFloor, clock)
}

function createSearchGrant(): AccessGrantRevision {
  return grants.createPreparedTextAccessGrant({
    workspaceId: 'workspace.test',
    profileId: 'assistant',
    subjectId: 'person.synthetic-1',
    purpose: 'customer_support',
    channel: 'web.primary',
    resourceId: target.resourceId,
    operation: 'source_content.search',
    consent: { state: 'not_required' },
    ttlSeconds: ACCESS_GRANT_MIN_TTL_SECONDS,
    issuedBy: 'owner.synthetic',
  }, 100)
}

function input(byteStart: number, byteEnd: number): ProtectedSourceReadInput {
  return {
    workspaceId: 'workspace.test',
    profileId: 'assistant',
    subjectId: 'person.synthetic-1',
    purpose: 'customer_support',
    channel: 'web.primary',
    resourceId: target.resourceId,
    consent: { state: 'not_required' },
    permissionMode: 'auto',
    byteStart,
    byteEnd,
  }
}

function searchInput(query = 'café'): ProtectedSourceSearchInput {
  return {
    workspaceId: 'workspace.test',
    profileId: 'assistant',
    subjectId: 'person.synthetic-1',
    purpose: 'customer_support',
    channel: 'web.primary',
    resourceId: target.resourceId,
    consent: { state: 'not_required' },
    permissionMode: 'auto',
    query,
    matchMode: 'exact_utf8',
    maxMatches: 20,
    contextBytes: 2,
  }
}

async function seedPreparedTextResource(): Promise<{
  readonly sourceId: string
  readonly resourceId: string
  readonly sourceRevision: number
  readonly objectPath: string
}> {
  const source = new SourceStore(database.rawMainHandle).create({
    workspaceId: 'workspace.test',
    profileId: 'assistant',
    kind: 'file',
    label: 'Synthetic source',
    classification: 'internal',
    authority: 'supporting_reference',
    audiencePolicyRef: 'audience.policy.test',
    sensitivityPolicyRef: 'sensitivity.policy.test',
    purposePolicyRef: 'purpose.policy.test',
    retentionPolicyRef: 'retention.policy.test',
    freshnessPolicyRef: 'freshness.policy.test',
  }, 10)
  const objectKey = `sources/${source.sourceId}/versions/${VERSION_ID}/original`
  database.rawMainHandle.prepare(`
    INSERT INTO source_versions (
      source_version_id, source_id, checksum, verified_media_type,
      byte_count, object_key, inspection_state, created_at
    ) VALUES (?, ?, ?, 'text/plain', ?, ?, 'complete', 20)
  `).run(VERSION_ID, source.sourceId, checksum(CONTENT), CONTENT.length, objectKey)
  database.rawMainHandle.prepare(`
    UPDATE runtime_sources SET registration_state = 'registered',
      current_version_id = ?, inspection_state = 'complete',
      freshness_state = 'fresh', updated_at = 20
    WHERE source_id = ?
  `).run(VERSION_ID, source.sourceId)

  const jobs = new SourceJobStore(database.rawMainHandle)
  const job = jobs.enqueuePreparation({
    workspaceId: 'workspace.test',
    profileId: 'assistant',
    sourceId: source.sourceId,
    sourceVersionId: VERSION_ID,
  }, 30)
  const claim = jobs.claimNext('protected-read-worker', 40)!
  for (const checkpoint of [1, 2, 3]) {
    expect(jobs.advanceCheckpoint(
      job.jobId, claim.claimToken, checkpoint - 1, checkpoint, 40 + checkpoint,
    )).toBe('advanced')
  }
  expect(jobs.finishPreparation(
    job.jobId, claim.claimToken, 'succeeded', 'preparation_complete', 50,
  )).toBe('finished')

  const objectPath = join(storageRoot, objectKey)
  await mkdir(dirname(objectPath), { recursive: true })
  await writeFile(objectPath, CONTENT, { mode: 0o600 })
  const resource = jobs.getResourceScoped(
    claim.resourceId!, 'workspace.test', 'assistant',
  )!
  return {
    sourceId: source.sourceId,
    resourceId: resource.resourceId,
    sourceRevision: resource.sourceRevision,
    objectPath,
  }
}

function checksum(value: Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
