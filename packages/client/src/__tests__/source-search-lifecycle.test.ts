/**
 * Reusable public-boundary proof for subject-bound source search.
 *
 * Harness setup provisions an isolated workspace and profile. Every product
 * action after that uses only the published OwnwareClient contract against a
 * real Gateway; the fixture never reads runtime storage or cache internals.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OwnwareGateway } from '@ownware/cortex'
import {
  OwnwareClient,
  OwnwareError,
  type SourceJob,
  type SourceManifest,
  type SourceUploadCompletionResult,
} from '../index.js'

const PROFILE_ID = 'search-agent'
const SUBJECT_ID = 'person.public-search-fixture'
const PURPOSE = 'customer-support'
const TERMINAL_JOB_STATES = new Set(['succeeded', 'partial', 'failed', 'cancelled'])

describe('public subject-bound source-search lifecycle', () => {
  let dir: string
  let profilesDir: string
  let dataDir: string
  let workspaceId: string
  let delegatedToken: string
  let gateway: OwnwareGateway | undefined
  let owner: OwnwareClient
  let delegated: OwnwareClient

  beforeAll(async () => {
    process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'
    dir = await mkdtemp(join(tmpdir(), 'ownware-public-search-'))
    profilesDir = join(dir, 'profiles')
    dataDir = join(dir, 'data')
    const profileDir = join(profilesDir, PROFILE_ID)
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'agent.json'), JSON.stringify({ name: PROFILE_ID }))
    const otherProfileDir = join(profilesDir, 'other-search-agent')
    await mkdir(otherProfileDir, { recursive: true })
    await writeFile(
      join(otherProfileDir, 'agent.json'),
      JSON.stringify({ name: 'other-search-agent' }),
    )

    gateway = new OwnwareGateway({
      port: 0,
      profilesDir,
      dataDir,
      tls: false,
      disableAuth: false,
    })
    await gateway.start()
    owner = new OwnwareClient({
      baseUrl: `http://127.0.0.1:${gateway.port}`,
      token: gateway.token,
    })

    const workspace = gateway.state.createWorkspace(
      join(dir, 'workspace'),
      'Public search lifecycle',
    )
    workspaceId = workspace.id
    const issued = await owner.issueDelegation({
      delegateId: 'public-search-fixture',
      subjectId: SUBJECT_ID,
      workspaceId: workspace.id,
      profileId: PROFILE_ID,
      purpose: PURPOSE,
      operations: [
        'gateway.capabilities',
        'sources.register', 'sources.read',
        'source_uploads.create', 'source_uploads.write', 'source_uploads.complete',
        'source_jobs.create', 'source_jobs.read',
        'source_preparations.create', 'source_resources.read',
        'source_content.read', 'source_content.search',
        'source_deletions.create', 'source_deletions.read',
      ],
    })
    delegatedToken = issued.token
    delegated = new OwnwareClient({
      baseUrl: `http://127.0.0.1:${gateway.port}`,
      token: delegatedToken,
    })
  }, 20_000)

  afterAll(async () => {
    await gateway?.stop()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('negotiates, repeats, revokes, refreshes, regrants and deletes without stale evidence', async () => {
    await expect(owner.issueDelegation({
      delegateId: 'subjectless-public-search-fixture',
      workspaceId,
      profileId: PROFILE_ID,
      purpose: PURPOSE,
      operations: ['source_content.search'],
    })).rejects.toMatchObject({ status: 400, code: 'principal_scope_invalid' })

    const negotiation = await delegated.capabilities({
      requiredMajor: 1,
      requiredCapabilities: {
        'gateway.capabilities': 10,
        'principals.issue': 3,
        'sources.register': 2,
        'source_uploads.create': 3,
        'source_uploads.write': 1,
        'source_uploads.complete': 2,
        'source_jobs.create': 2,
        'source_jobs.read': 3,
        'source_preparations.create': 3,
        'source_resources.read': 1,
        'access_grants.create': 3,
        'access_grants.revoke': 1,
        'source_content.search': 2,
        'source_deletions.create': 1,
        'source_deletions.read': 1,
      },
    })
    expect(negotiation).toMatchObject({
      status: 'available',
      contract: { name: 'ownware.gateway', major: 1, revision: '0.29.0' },
      limits: {
        sourceSearch: {
          maxScanBytes: 16 * 1024 * 1024,
          maxQueryBytes: 128,
          maxMatches: 20,
          maxContextBytes: 1_024,
          perRequestTimeoutMs: 5_000,
          matchModes: ['exact_utf8', 'ascii_case_insensitive'],
        },
      },
    })

    const source = await delegated.registerSource({
      kind: 'file',
      label: 'Synthetic public search guide',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.support-team',
      sensitivityPolicyRef: 'sensitivity.internal',
      purposePolicyRef: 'purpose.customer-support',
      retentionPolicyRef: 'retention.standard',
      freshnessPolicyRef: 'freshness.monthly',
      idempotencyKey: '10101010-1010-4010-8010-101010101010',
    })
    const firstVersion = await uploadVersion(
      delegated,
      source,
      'first public needle answer',
      '11111111-1111-4111-8111-111111111111',
    )
    const firstResourceId = await prepareVersion(
      delegated,
      source.sourceId,
      firstVersion.sourceVersionId,
      '12121212-1212-4212-8212-121212121212',
      '13131313-1313-4313-8313-131313131313',
    )
    await createReadGrant(
      owner,
      firstResourceId,
      '22222222-2222-4222-8222-222222222222',
    )
    await expect(delegated.readSourceContent(firstResourceId, {
      consent: { state: 'not_required' },
      byteStart: 0,
      byteEnd: 5,
    })).resolves.toMatchObject({
      text: 'first',
      sourceVersionId: firstVersion.sourceVersionId,
    })
    const firstGrant = await createSearchGrant(
      owner,
      firstResourceId,
      '14141414-1414-4414-8414-141414141414',
    )

    const injectedSubject = await fetch(
      `http://127.0.0.1:${gateway?.port}/api/v1/source-resources/${firstResourceId}/content/search`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${delegatedToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          subjectId: 'person.injected',
          consent: { state: 'not_required' },
          query: 'needle',
          matchMode: 'exact_utf8',
          maxMatches: 1,
          contextBytes: 7,
        }),
      },
    )
    expect(injectedSubject.status).toBe(400)
    await expect(injectedSubject.json()).resolves.toMatchObject({
      error: 'source_content_search_request_invalid',
    })

    const otherSubject = await owner.issueDelegation({
      delegateId: 'other-subject-public-search-fixture',
      subjectId: 'person.other-public-search-fixture',
      workspaceId,
      profileId: PROFILE_ID,
      purpose: PURPOSE,
      operations: ['source_content.search'],
    })
    const otherSubjectClient = new OwnwareClient({
      baseUrl: `http://127.0.0.1:${gateway?.port}`,
      token: otherSubject.token,
    })
    await expect(search(otherSubjectClient, firstResourceId)).rejects.toMatchObject({
      status: 404,
      code: 'source_content_unavailable',
    })

    const otherProfile = await owner.issueDelegation({
      delegateId: 'other-profile-public-search-fixture',
      subjectId: SUBJECT_ID,
      workspaceId,
      profileId: 'other-search-agent',
      purpose: PURPOSE,
      operations: ['source_content.search'],
    })
    const otherProfileClient = new OwnwareClient({
      baseUrl: `http://127.0.0.1:${gateway?.port}`,
      token: otherProfile.token,
    })
    await expect(search(otherProfileClient, firstResourceId)).rejects.toMatchObject({
      status: 404,
      code: 'source_content_unavailable',
    })

    const firstSearch = await search(delegated, firstResourceId)
    const repeatedFirstSearch = await search(delegated, firstResourceId)
    expect(withoutObservedAt(repeatedFirstSearch)).toEqual(withoutObservedAt(firstSearch))
    expect(repeatedFirstSearch.observedAt).toBeGreaterThanOrEqual(firstSearch.observedAt)
    expect(firstSearch).toMatchObject({
      status: 'complete',
      freshness: 'current',
      sourceVersionId: firstVersion.sourceVersionId,
      matches: [{
        evidenceId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        text: 'public needle answer',
        matchByteStart: 13,
        matchByteEnd: 19,
      }],
    })
    const serializedFirstSearch = JSON.stringify(firstSearch)
    expect(serializedFirstSearch).not.toContain('objectKey')
    expect(serializedFirstSearch).not.toContain('locator')
    expect(serializedFirstSearch).not.toContain('cache')

    await gateway?.stop()
    gateway = new OwnwareGateway({
      port: 0,
      profilesDir,
      dataDir,
      tls: false,
      disableAuth: false,
    })
    await gateway.start()
    owner = new OwnwareClient({
      baseUrl: `http://127.0.0.1:${gateway.port}`,
      token: gateway.token,
    })
    delegated = new OwnwareClient({
      baseUrl: `http://127.0.0.1:${gateway.port}`,
      token: delegatedToken,
    })
    const afterRestart = await search(delegated, firstResourceId)
    expect(withoutObservedAt(afterRestart)).toEqual(withoutObservedAt(firstSearch))
    expect(afterRestart.observedAt).toBeGreaterThanOrEqual(firstSearch.observedAt)

    await owner.revokeAccessGrant(firstGrant.grantId, {
      expectedRevision: 1,
      idempotencyKey: '15151515-1515-4515-8515-151515151515',
    })
    await expect(search(delegated, firstResourceId)).rejects.toMatchObject({
      status: 404,
      code: 'source_content_unavailable',
    })
    await expect(delegated.readSourceContent(firstResourceId, {
      consent: { state: 'not_required' },
      byteStart: 0,
      byteEnd: 5,
    })).resolves.toMatchObject({
      text: 'first',
      sourceVersionId: firstVersion.sourceVersionId,
    })

    await createSearchGrant(
      owner,
      firstResourceId,
      '16161616-1616-4616-8616-161616161616',
    )
    await expect(search(delegated, firstResourceId)).resolves.toMatchObject({
      sourceVersionId: firstVersion.sourceVersionId,
    })

    const refreshedVersion = await uploadVersion(
      delegated,
      source,
      'second public needle answer',
      '17171717-1717-4717-8717-171717171717',
    )
    await expect(search(delegated, firstResourceId)).rejects.toMatchObject({
      status: 404,
      code: 'source_content_unavailable',
    })
    await expect(delegated.readSourceContent(firstResourceId, {
      consent: { state: 'not_required' },
      byteStart: 0,
      byteEnd: 5,
    })).rejects.toMatchObject({
      status: 404,
      code: 'source_content_unavailable',
    })

    const refreshedResourceId = await prepareVersion(
      delegated,
      source.sourceId,
      refreshedVersion.sourceVersionId,
      '18181818-1818-4818-8818-181818181818',
      '19191919-1919-4919-8919-191919191919',
    )
    await createSearchGrant(
      owner,
      refreshedResourceId,
      '20202020-2020-4020-8020-202020202020',
    )
    await createReadGrant(
      owner,
      refreshedResourceId,
      '23232323-2323-4323-8323-232323232323',
    )
    await expect(delegated.readSourceContent(refreshedResourceId, {
      consent: { state: 'not_required' },
      byteStart: 0,
      byteEnd: 6,
    })).resolves.toMatchObject({
      text: 'second',
      sourceVersionId: refreshedVersion.sourceVersionId,
    })
    const refreshedSearch = await search(delegated, refreshedResourceId)
    const repeatedRefreshedSearch = await search(delegated, refreshedResourceId)
    expect(withoutObservedAt(repeatedRefreshedSearch))
      .toEqual(withoutObservedAt(refreshedSearch))
    expect(repeatedRefreshedSearch.observedAt)
      .toBeGreaterThanOrEqual(refreshedSearch.observedAt)
    expect(refreshedSearch).toMatchObject({
      status: 'complete',
      sourceVersionId: refreshedVersion.sourceVersionId,
      matches: [{ text: 'public needle answer' }],
    })
    expect(refreshedSearch.matches[0]?.evidenceId)
      .not.toBe(firstSearch.matches[0]?.evidenceId)

    const current = await delegated.source(source.sourceId)
    const deletion = await delegated.createSourceDeletion(source.sourceId, {
      expectedRevision: current.revision,
      idempotencyKey: '21212121-2121-4121-8121-212121212121',
    })
    const deleted = await awaitDeletion(delegated, deletion.jobId)
    expect(deleted).toMatchObject({
      state: 'deleted',
      remaining: { retrievalCacheEntries: 0 },
      terminalAt: expect.any(Number),
    })
    await expect(search(delegated, refreshedResourceId)).rejects.toMatchObject({
      status: 404,
      code: 'source_content_unavailable',
    })
    await expect(delegated.readSourceContent(refreshedResourceId, {
      consent: { state: 'not_required' },
      byteStart: 0,
      byteEnd: 6,
    })).rejects.toMatchObject({
      status: 404,
      code: 'source_content_unavailable',
    })
  }, 40_000)
})

async function uploadVersion(
  client: OwnwareClient,
  source: SourceManifest,
  content: string,
  idempotencyKey: string,
): Promise<SourceUploadCompletionResult> {
  const bytes = Buffer.from(content)
  const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const upload = await client.createSourceUploadSession(source.sourceId, {
    expectedBytes: bytes.length,
    expectedChecksum: checksum,
    declaredMediaType: 'text/plain',
    filename: 'synthetic-public-search.txt',
    idempotencyKey,
  })
  await client.writeSourceUploadChunk(upload.uploadId, {
    offset: 0,
    checksum,
    bytes,
  })
  return client.completeSourceUpload(upload.uploadId)
}

async function prepareVersion(
  client: OwnwareClient,
  sourceId: string,
  sourceVersionId: string,
  inspectionKey: string,
  preparationKey: string,
): Promise<string> {
  const inspection = await client.createSourceJob(sourceId, sourceVersionId, {
    operation: 'inspect_format',
    idempotencyKey: inspectionKey,
  })
  await expect(awaitJob(client, inspection.jobId)).resolves.toMatchObject({
    state: 'succeeded',
    operation: 'inspect_format',
    sourceVersionId,
  })
  const preparation = await client.createSourcePreparation(sourceId, sourceVersionId, {
    operation: 'extract_text',
    idempotencyKey: preparationKey,
  })
  const prepared = await awaitJob(client, preparation.jobId)
  expect(prepared).toMatchObject({
    state: 'succeeded',
    operation: 'extract_text',
    sourceVersionId,
    resourceId: expect.any(String),
  })
  if (!prepared.resourceId) throw new Error('expected a prepared resource ID')
  await expect(client.sourceResource(prepared.resourceId)).resolves.toMatchObject({
    resourceId: prepared.resourceId,
    sourceVersionId,
    freshness: 'current',
  })
  return prepared.resourceId
}

async function awaitJob(client: OwnwareClient, jobId: string): Promise<SourceJob> {
  const deadline = Date.now() + 5_000
  let job = await client.sourceJob(jobId)
  while (!TERMINAL_JOB_STATES.has(job.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    job = await client.sourceJob(jobId)
  }
  return job
}

async function createSearchGrant(
  owner: OwnwareClient,
  resourceId: string,
  idempotencyKey: string,
) {
  return owner.createAccessGrant(resourceId, {
    subjectId: SUBJECT_ID,
    purpose: PURPOSE,
    channel: null,
    operation: 'source_content.search',
    consent: { state: 'not_required' },
    ttlSeconds: 60,
    idempotencyKey,
  })
}

async function createReadGrant(
  owner: OwnwareClient,
  resourceId: string,
  idempotencyKey: string,
) {
  return owner.createAccessGrant(resourceId, {
    subjectId: SUBJECT_ID,
    purpose: PURPOSE,
    channel: null,
    operation: 'source_content.read',
    consent: { state: 'not_required' },
    ttlSeconds: 60,
    idempotencyKey,
  })
}

function search(client: OwnwareClient, resourceId: string) {
  return client.searchSourceContent(resourceId, {
    consent: { state: 'not_required' },
    query: 'needle',
    matchMode: 'exact_utf8',
    maxMatches: 1,
    contextBytes: 7,
  })
}

async function awaitDeletion(client: OwnwareClient, jobId: string) {
  const deadline = Date.now() + 5_000
  let deletion = await client.sourceDeletion(jobId)
  while (!['cancelled', 'partially_deleted', 'deleted'].includes(deletion.state) &&
         Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    deletion = await client.sourceDeletion(jobId)
  }
  return deletion
}

function withoutObservedAt<T extends { readonly observedAt: number }>(value: T) {
  const { observedAt: _observedAt, ...evidence } = value
  return evidence
}
