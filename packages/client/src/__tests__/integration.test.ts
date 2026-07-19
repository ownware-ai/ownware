/**
 * OwnwareClient against a REAL OwnwareGateway — the contract test.
 *
 * Boots @ownware/cortex (dev dependency) with temp profilesDir + dataDir
 * (per the gateway test-isolation rule: never touch ~/.ownware) and drives
 * the whole surface through the published client: health, models, run,
 * streamReply to a terminal event, abort. A fake Loom provider stands
 * in for "a key is saved" — no network, no LLM.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OwnwareGateway } from '@ownware/cortex'
import { listProviders, registerProvider, unregisterProvider } from '@ownware/loom'
import type { ProviderAdapter } from '@ownware/loom'
import { OwnwareClient, OwnwareError } from '../client.js'

let gateway: OwnwareGateway
let ownware: OwnwareClient
let dir: string

beforeAll(async () => {
  process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'
  dir = await mkdtemp(join(tmpdir(), 'ownware-client-it-'))
  const profilesDir = join(dir, 'profiles')
  const profileDir = join(profilesDir, 'test-agent')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'agent.json'), JSON.stringify({ name: 'test-agent' }))

  for (const name of listProviders()) unregisterProvider(name)
  registerProvider({ name: 'openai' } as unknown as ProviderAdapter)

  gateway = new OwnwareGateway({
    port: 0,
    profilesDir,
    dataDir: join(dir, 'data'),
    tls: false,
    disableAuth: false, // exercise the client's Bearer handling for real
  })
  await gateway.start()
  ownware = new OwnwareClient({ baseUrl: `http://127.0.0.1:${gateway.port}`, token: gateway.token })
}, 20_000)

afterAll(async () => {
  await gateway.stop()
  await rm(dir, { recursive: true, force: true })
  for (const name of listProviders()) unregisterProvider(name)
})

describe('OwnwareClient ⇄ OwnwareGateway', () => {
  it('negotiates the published contract before a dependent call', async () => {
    const negotiation = await ownware.capabilities({
      requiredMajor: 1,
      requiredCapabilities: { 'runs.start': 1, 'runs.events': 1 },
    })
    expect(negotiation).toMatchObject({ status: 'available' })
    if (negotiation.status !== 'available') throw new Error('expected available capabilities')
    expect(negotiation.limits).toMatchObject({
      jsonBodyBytes: 10 * 1024 * 1024,
      candidateUpload: {
        maxFiles: 1_000,
        maxDecodedBytes: 6 * 1024 * 1024,
        maxPathCharacters: 256,
      },
      sourceList: { maxPageSize: 100 },
      connectionList: { maxPageSize: 100 },
      sourceUpload: {
        maxDecodedBytes: 16 * 1024 * 1024,
        maxChunkBytes: 1024 * 1024,
        maxChunks: 64,
        sessionTtlSeconds: 15 * 60,
        supportedSourceKinds: ['file', 'text', 'structured_export'],
        supportedMediaTypes: ['text/plain', 'application/pdf'],
      },
      sourceInspection: {
        maxBytes: 16 * 1024 * 1024,
        perAttemptTimeoutMs: 5_000,
        maxAttempts: 3,
      },
      sourcePreparation: {
        maxBytes: 16 * 1024 * 1024,
        perAttemptTimeoutMs: 5_000,
        maxAttempts: 3,
        maxResourcesPerJob: 1,
      },
      sourceDataView: {
        supportedFormats: ['strict_utf8_csv'],
        maxSourceBytes: 16 * 1024 * 1024,
        maxArtifactBytes: 128 * 1024 * 1024,
        maxFields: 256,
        maxRows: 100_000,
        maxCellBytes: 64 * 1024,
        maxCells: 1_000_000,
        perAttemptTimeoutMs: 5_000,
        maxAttempts: 3,
        maxQueryFields: 32,
        maxQueryRows: 256,
        maxQueryCells: 8_192,
        maxQueryResultBytes: 256 * 1024,
        queryTimeoutMs: 2_000,
        maxGrantScopeIds: 256,
      },
      accessGrants: {
        minTtlSeconds: 60,
        maxTtlSeconds: 30 * 24 * 60 * 60,
        maxActivePerWorkspaceProfile: 1_024,
        maxPageSize: 100,
      },
      sourceContent: { maxRangeBytes: 64 * 1024 },
      sourceQuota: {
        workspace: {
          maxSourceRegistrations: 1_000,
          maxRetainedAndReservedBytes: 1024 * 1024 * 1024,
          maxActiveUploadSessions: 256,
          maxNonterminalJobs: 64,
          maxDerivedResources: 1_000,
        },
        profile: {
          maxSourceRegistrations: 250,
          maxRetainedAndReservedBytes: 256 * 1024 * 1024,
          maxActiveUploadSessions: 64,
          maxNonterminalJobs: 16,
          maxDerivedResources: 250,
        },
      },
      idempotencyRetentionSeconds: 7 * 24 * 60 * 60,
      rateLimit: { enabled: true, runStarts: 10 },
    })
    await expect(ownware.models()).resolves.not.toHaveLength(0)

    await expect(ownware.capabilities({ requiredMajor: 2 })).resolves.toMatchObject({
      status: 'incompatible',
      expectedMajor: 2,
      actualMajor: 1,
    })
  })

  it('negotiates owner connection inventory before using the real Gateway route', async () => {
    await expect(ownware.capabilities({
      requiredMajor: 1,
      requiredCapabilities: { 'connections.list': 1 },
    })).resolves.toMatchObject({ status: 'available' })
    await expect(ownware.connections()).resolves.toEqual({
      items: [],
      nextCursor: null,
      accessPolicy: 'separate_grant_required',
    })
  })

  it('health() answers without auth trouble', async () => {
    const health = await ownware.health()
    expect(health.status).toBe('ok')
  })

  it('models() returns the catalog with hasCredentials booleans', async () => {
    const models = await ownware.models()
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((m) => typeof m.id === 'string')).toBe(true)
    expect(models.every((m) => typeof m.hasCredentials === 'boolean')).toBe(true)
  })

  it('auth is REAL: a tokenless client is rejected, the tokened one is not', async () => {
    const anonymous = new OwnwareClient({ baseUrl: `http://127.0.0.1:${gateway.port}` })
    const thrown = await anonymous.models().catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(OwnwareError)
    expect(thrown).toMatchObject({
      status: 401,
      code: 'unauthorized',
      category: 'auth',
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
  })

  it('owner delegates one capability and revocation is immediate', async () => {
    const workspace = gateway.state.createWorkspace(dir, 'Client delegation')
    const issued = await ownware.issueDelegation({
      delegateId: 'client-integration',
      workspaceId: workspace.id,
      profileId: 'test-agent',
      purpose: 'contract-test',
      operations: ['gateway.capabilities'],
    })
    const delegated = new OwnwareClient({
      baseUrl: `http://127.0.0.1:${gateway.port}`,
      token: issued.token,
    })
    await expect(delegated.capabilities({ requiredMajor: 1 })).resolves.toMatchObject({
      status: 'available',
    })

    await ownware.revokeDelegation(issued.principal.tokenId, 'client_removed')
    const thrown = await delegated.capabilities().catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(OwnwareError)
    expect(thrown).toMatchObject({ status: 401, code: 'principal_revoked' })
  })

  it('a delegated validator validates portable bytes without registering a profile', async () => {
    const before = (await gateway.registry.list()).length
    const workspace = gateway.state.createWorkspace(join(dir, 'candidate-workspace'), 'Client candidate validation')
    const issued = await ownware.issueDelegation({
      delegateId: 'client-candidate-validator',
      workspaceId: workspace.id,
      profileId: 'test-agent',
      purpose: 'validate-portable-agent-kit',
      operations: [
        'candidates.validate', 'candidates.stage', 'candidates.activate', 'candidates.rollback',
        'candidates.read', 'candidates.list',
        'profiles.pause', 'profiles.resume',
        'profiles.deployment.read', 'profiles.list',
      ],
    })
    const delegated = new OwnwareClient({
      baseUrl: `http://127.0.0.1:${gateway.port}`,
      token: issued.token,
    })
    const result = await delegated.validateCandidate({
      files: [{
        path: 'agent.json',
        contentBase64: Buffer.from('{"name":"test-agent"}').toString('base64'),
      }],
    })
    expect(result).toMatchObject({
      valid: true,
      candidateId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      profileName: 'test-agent',
      findings: [],
    })
    await expect(delegated.stageCandidate({
      candidateId: result.candidateId!,
      files: [{
        path: 'agent.json',
        contentBase64: Buffer.from('{"name":"test-agent"}').toString('base64'),
      }],
    })).resolves.toMatchObject({
      candidateId: result.candidateId,
      state: 'ready',
      ready: true,
      idempotent: false,
    })
    await expect(delegated.activateCandidate({
      profileId: 'test-agent',
      candidateId: result.candidateId!,
      expectedActiveCandidateId: null,
    })).resolves.toMatchObject({
      state: 'active',
      changed: true,
      activeCandidateId: result.candidateId,
    })
    await expect(delegated.rollbackCandidate({
      profileId: 'test-agent',
      candidateId: result.candidateId!,
      expectedActiveCandidateId: result.candidateId!,
    })).resolves.toMatchObject({
      state: 'rolled_back',
      changed: false,
      activeCandidateId: result.candidateId,
    })
    await expect(delegated.candidate(result.candidateId!)).resolves.toMatchObject({
      candidateId: result.candidateId, state: 'ready', ready: true,
    })
    await expect(delegated.candidates('test-agent')).resolves.toMatchObject({
      profileId: 'test-agent', items: [expect.objectContaining({ candidateId: result.candidateId })],
    })
    await expect(delegated.deployment('test-agent')).resolves.toMatchObject({
      activeCandidateId: result.candidateId, deploymentRevision: 1,
    })
    await expect(delegated.profiles()).resolves.toEqual([expect.objectContaining({
      id: 'test-agent', activeCandidateId: result.candidateId,
    })])
    await expect(delegated.pauseProfile({
      profileId: 'test-agent',
      expectedDeploymentRevision: 1,
      idempotencyKey: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
    })).resolves.toMatchObject({
      state: 'paused', deploymentRevision: 2,
    })
    await expect(delegated.resumeProfile({
      profileId: 'test-agent',
      expectedDeploymentRevision: 2,
      idempotencyKey: 'dededede-dede-4ede-8ede-dededededede',
    })).resolves.toMatchObject({
      state: 'active', deploymentRevision: 3, health: 'healthy',
    })
    await expect(ownware.run({ profileId: 'test-agent', prompt: 'candidate pin proof' }))
      .resolves.toMatchObject({ candidateId: result.candidateId })
    expect((await gateway.registry.list()).length).toBe(before)
  })

  it('a delegated client registers and reads one safe source manifest', async () => {
    const workspace = gateway.state.createWorkspace(join(dir, 'source-workspace'), 'Client source')
    const issued = await ownware.issueDelegation({
      delegateId: 'client-source-registration',
      subjectId: 'person.sdk-synthetic',
      workspaceId: workspace.id,
      profileId: 'test-agent',
      purpose: 'customer-support',
      operations: [
        'sources.register', 'sources.list', 'sources.read',
        'source_uploads.create', 'source_uploads.write', 'source_uploads.complete',
        'source_versions.read',
        'source_jobs.create', 'source_jobs.read', 'source_jobs.cancel',
        'source_preparations.create', 'source_resources.read',
        'source_content.read', 'source_content.search',
        'source_deletions.create', 'source_deletions.read',
        'source_deletions.cancel', 'source_deletions.retry',
      ],
    })
    const delegated = new OwnwareClient({
      baseUrl: `http://127.0.0.1:${gateway.port}`,
      token: issued.token,
    })
    const input = {
      kind: 'file' as const,
      label: 'Approved client guide',
      classification: 'internal' as const,
      authority: 'supporting_reference' as const,
      audiencePolicyRef: 'audience.support-team',
      sensitivityPolicyRef: 'sensitivity.internal',
      purposePolicyRef: 'purpose.customer-support',
      retentionPolicyRef: 'retention.standard',
      freshnessPolicyRef: 'freshness.monthly',
      idempotencyKey: '52525252-abab-4525-8525-525252525252',
    }
    const source = await delegated.registerSource(input)
    expect(source).toMatchObject({
      label: input.label,
      currentVersionId: null,
      health: { registration: 'pending', freshness: 'unknown' },
    })
    await expect(delegated.registerSource(input)).resolves.toMatchObject({
      sourceId: source.sourceId,
    })
    await expect(delegated.sources()).resolves.toEqual({
      items: [source],
      nextCursor: null,
    })
    await expect(delegated.source(source.sourceId)).resolves.toEqual(source)

    const bytes = Buffer.from('sdk immutable source')
    const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const upload = await delegated.createSourceUploadSession(source.sourceId, {
      expectedBytes: bytes.length,
      expectedChecksum: checksum,
      declaredMediaType: 'text/plain',
      filename: 'sdk-source.txt',
      idempotencyKey: '56565656-abab-4565-8565-565656565656',
    })
    await expect(delegated.writeSourceUploadChunk(upload.uploadId, {
      offset: 0, checksum, bytes,
    })).resolves.toMatchObject({ offset: bytes.length, chunkCount: 1, replayed: false })
    const completed = await delegated.completeSourceUpload(upload.uploadId)
    expect(completed).toMatchObject({
      sourceId: source.sourceId,
      checksum,
      verifiedMediaType: 'text/plain',
      replayed: false,
    })
    await expect(delegated.sourceVersion(
      source.sourceId, completed.sourceVersionId,
    )).resolves.toMatchObject({ sourceVersionId: completed.sourceVersionId, checksum })

    const createRefresh = async (content: string, idempotencyKey: string) => {
      const refreshBytes = Buffer.from(content)
      const refreshChecksum = `sha256:${createHash('sha256').update(refreshBytes).digest('hex')}`
      const refresh = await delegated.createSourceUploadSession(source.sourceId, {
        expectedBytes: refreshBytes.length,
        expectedChecksum: refreshChecksum,
        declaredMediaType: 'text/plain',
        filename: 'sdk-refresh.txt',
        idempotencyKey,
      })
      await delegated.writeSourceUploadChunk(refresh.uploadId, {
        offset: 0,
        checksum: refreshChecksum,
        bytes: refreshBytes,
      })
      return refresh.uploadId
    }
    const staleRefresh = await createRefresh(
      'sdk stale refresh', '58585858-abab-4585-8585-585858585858',
    )
    const newerRefresh = await createRefresh(
      'sdk newer refresh', '59595959-abab-4595-8595-595959595959',
    )
    const newerVersion = await delegated.completeSourceUpload(newerRefresh)
    const staleConflict = await delegated.completeSourceUpload(staleRefresh)
      .catch((error: unknown) => error)
    expect(staleConflict).toBeInstanceOf(OwnwareError)
    expect(staleConflict).toMatchObject({
      status: 409,
      code: 'source_upload_refresh_conflict',
      actualRevision: 3,
      actualCurrentVersionId: newerVersion.sourceVersionId,
    })

    const job = await delegated.createSourceJob(
      source.sourceId,
      newerVersion.sourceVersionId,
      {
        operation: 'inspect_format',
        idempotencyKey: '57575757-abab-4575-8575-575757575757',
      },
    )
    const deadline = Date.now() + 2_000
    let observed = await delegated.sourceJob(job.jobId)
    while (!['succeeded', 'partial', 'failed', 'cancelled'].includes(observed.state) &&
           Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      observed = await delegated.sourceJob(job.jobId)
    }
    expect(observed).toMatchObject({
      jobId: job.jobId,
      sourceId: source.sourceId,
      sourceVersionId: newerVersion.sourceVersionId,
      state: 'succeeded',
      outcomeCode: 'inspection_complete',
      implementationVersion: 'inspect_format.v1',
      resourceId: null,
    })

    const preparation = await delegated.createSourcePreparation(
      source.sourceId,
      newerVersion.sourceVersionId,
      {
        operation: 'extract_text',
        idempotencyKey: '72727272-abab-4727-8727-727272727272',
      },
    )
    let prepared = await delegated.sourceJob(preparation.jobId)
    const preparationDeadline = Date.now() + 2_000
    while (!['succeeded', 'partial', 'failed', 'cancelled'].includes(prepared.state) &&
           Date.now() < preparationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      prepared = await delegated.sourceJob(preparation.jobId)
    }
    expect(prepared).toMatchObject({
      state: 'succeeded', operation: 'extract_text',
      implementationVersion: 'text_extraction.v1',
      outcomeCode: 'preparation_complete', resourceId: expect.any(String),
    })
    const resource = await delegated.sourceResource(prepared.resourceId!)
    expect(resource).toMatchObject({
      resourceId: prepared.resourceId,
      sourceVersionId: newerVersion.sourceVersionId,
      freshness: 'current',
      coverage: 'complete',
    })

    const grantInput = {
      subjectId: 'person.sdk-synthetic',
      purpose: 'customer-support',
      channel: null,
      consent: { state: 'not_required' as const },
      ttlSeconds: 60,
      idempotencyKey: '74747474-cdcd-4747-8747-747474747474',
    }
    const grant = await ownware.createAccessGrant(resource.resourceId, grantInput)
    expect(grant).toMatchObject({ revision: 1, mutation: 'created' })
    await expect(ownware.createAccessGrant(resource.resourceId, grantInput))
      .resolves.toEqual(grant)
    await expect(ownware.accessGrant(grant.grantId)).resolves.toMatchObject({
      grantId: grant.grantId,
      workspaceId: workspace.id,
      profileId: 'test-agent',
      subjectId: 'person.sdk-synthetic',
      operation: 'source_content.read',
    })
    await expect(ownware.accessGrants({ limit: 100 })).resolves.toMatchObject({
      items: [expect.objectContaining({
        grantId: grant.grantId, lifecycle: 'effective', state: 'active',
      })],
      nextCursor: null,
    })
    await expect(delegated.readSourceContent(resource.resourceId, {
      consent: { state: 'not_required' },
      byteStart: 0,
      byteEnd: 3,
    })).resolves.toMatchObject({
      resourceId: resource.resourceId,
      sourceVersionId: newerVersion.sourceVersionId,
      text: 'sdk',
      byteStart: 0,
      byteEnd: 3,
    })
    const searchGrant = await ownware.createAccessGrant(resource.resourceId, {
      ...grantInput,
      operation: 'source_content.search',
      idempotencyKey: '76767676-cdcd-4767-8767-767676767676',
    })
    await expect(delegated.searchSourceContent(resource.resourceId, {
      consent: { state: 'not_required' },
      query: 'SDK', matchMode: 'ascii_case_insensitive',
      maxMatches: 20, contextBytes: 1,
    })).resolves.toMatchObject({
      status: 'complete',
      matches: [expect.objectContaining({ matchByteStart: 0, matchByteEnd: 3 })],
    })
    await ownware.revokeAccessGrant(searchGrant.grantId, {
      expectedRevision: 1,
      idempotencyKey: '77777777-cdcd-4777-8777-777777777777',
    })
    await expect(delegated.searchSourceContent(resource.resourceId, {
      consent: { state: 'not_required' },
      query: 'sdk', matchMode: 'exact_utf8', maxMatches: 20, contextBytes: 0,
    })).rejects.toMatchObject({ status: 404, code: 'source_content_unavailable' })
    await expect(delegated.readSourceContent(resource.resourceId, {
      consent: { state: 'not_required' },
      byteStart: 0, byteEnd: 3,
    })).resolves.toMatchObject({ text: 'sdk' })
    const revokeInput = {
      expectedRevision: 1,
      idempotencyKey: '75757575-cdcd-4757-8757-757575757575',
    }
    const revoked = await ownware.revokeAccessGrant(grant.grantId, revokeInput)
    expect(revoked).toMatchObject({ revision: 2, mutation: 'revoked' })
    await expect(ownware.revokeAccessGrant(grant.grantId, revokeInput))
      .resolves.toEqual(revoked)
    await expect(delegated.readSourceContent(resource.resourceId, {
      consent: { state: 'not_required' },
      byteStart: 0,
      byteEnd: 3,
    })).rejects.toMatchObject({ status: 404, code: 'source_content_unavailable' })

    const postPreparationRefresh = await createRefresh(
      'sdk post preparation refresh', '73737373-abab-4737-8737-737373737373',
    )
    await delegated.completeSourceUpload(postPreparationRefresh)
    await expect(delegated.sourceResource(prepared.resourceId!)).resolves.toMatchObject({
      resourceId: prepared.resourceId, freshness: 'stale', staleAt: expect.any(Number),
    })

    const current = await delegated.source(source.sourceId)
    const deletion = await delegated.createSourceDeletion(source.sourceId, {
      expectedRevision: current.revision,
      idempotencyKey: '74747474-abab-4747-8747-747474747474',
    })
    expect(deletion).toMatchObject({
      sourceId: source.sourceId,
      operation: 'delete_source',
      sourceRevision: current.revision + 1,
    })
    let deleted = await delegated.sourceDeletion(deletion.jobId)
    const deletionDeadline = Date.now() + 2_000
    while (!['cancelled', 'partially_deleted', 'deleted'].includes(deleted.state) &&
           Date.now() < deletionDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      deleted = await delegated.sourceDeletion(deletion.jobId)
    }
    expect(deleted).toMatchObject({
      jobId: deletion.jobId,
      state: 'deleted',
      remaining: {
        immutableOriginals: 0,
        uploadStaging: 0,
        placedCandidates: 0,
        derivedResources: 0,
        dataViews: 0,
        searchIndexes: 0,
        sourceJobs: 0,
        idempotencyReplays: 0,
        retrievalCacheEntries: 0,
      },
      terminalAt: expect.any(Number),
    })
    await expect(delegated.source(source.sourceId)).rejects.toMatchObject({
      status: 404,
      code: 'source_not_found',
    })
  })

  it('prepares a strict CSV Data View through only the public SDK contract', async () => {
    const workspace = gateway.state.createWorkspace(join(dir, 'data-view-workspace'), 'Client Data View')
    const issued = await ownware.issueDelegation({
      delegateId: 'client-data-view-preparation',
      subjectId: 'person.synthetic-data-view',
      workspaceId: workspace.id,
      profileId: 'test-agent',
      purpose: 'customer-support',
      operations: [
        'sources.register', 'sources.list', 'sources.read',
        'source_uploads.create', 'source_uploads.write', 'source_uploads.complete',
        'source_versions.read',
        'source_jobs.create', 'source_jobs.read', 'source_preparations.create',
        'source_data_views.read', 'source_data_views.query',
        'source_deletions.create', 'source_deletions.read',
      ],
    })
    const delegated = new OwnwareClient({
      baseUrl: `http://127.0.0.1:${gateway.port}`,
      token: issued.token,
    })
    const source = await delegated.registerSource({
      kind: 'structured_export',
      label: 'Synthetic support export',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.support-team',
      sensitivityPolicyRef: 'sensitivity.internal',
      purposePolicyRef: 'purpose.customer-support',
      retentionPolicyRef: 'retention.standard',
      freshnessPolicyRef: 'freshness.daily',
      idempotencyKey: '81818181-abab-4181-8181-818181818181',
    })
    const bytes = Buffer.from('name,formula\nAda,=2+2\n')
    const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const upload = await delegated.createSourceUploadSession(source.sourceId, {
      expectedBytes: bytes.length,
      expectedChecksum: checksum,
      declaredMediaType: 'text/plain',
      filename: 'synthetic-support.csv',
      idempotencyKey: '82828282-abab-4282-8282-828282828282',
    })
    await delegated.writeSourceUploadChunk(upload.uploadId, { offset: 0, checksum, bytes })
    const version = await delegated.completeSourceUpload(upload.uploadId)
    await expect(delegated.sourceVersion(
      source.sourceId, version.sourceVersionId,
    )).resolves.toMatchObject({ sourceVersionId: version.sourceVersionId, checksum })
    const inspection = await delegated.createSourceJob(source.sourceId, version.sourceVersionId, {
      operation: 'inspect_format',
      idempotencyKey: '83838383-abab-4383-8383-838383838383',
    })
    const terminal = new Set(['succeeded', 'partial', 'failed', 'cancelled'])
    const awaitJob = async (jobId: string) => {
      const deadline = Date.now() + 2_000
      let job = await delegated.sourceJob(jobId)
      while (!terminal.has(job.state) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        job = await delegated.sourceJob(jobId)
      }
      return job
    }
    await expect(awaitJob(inspection.jobId)).resolves.toMatchObject({
      state: 'succeeded', operation: 'inspect_format', dataViewId: null,
    })
    const preparation = await delegated.createSourcePreparation(
      source.sourceId,
      version.sourceVersionId,
      {
        operation: 'prepare_data_view',
        idempotencyKey: '84848484-abab-4484-8484-848484848484',
      },
    )
    const prepared = await awaitJob(preparation.jobId)
    expect(prepared).toMatchObject({
      state: 'succeeded',
      operation: 'prepare_data_view',
      implementationVersion: 'csv_data_view.v1',
      outcomeCode: 'preparation_complete',
      resourceId: null,
      dataViewId: expect.any(String),
    })
    const publicProjection = JSON.stringify(prepared)
    expect(publicProjection).not.toContain('privateObjectKey')
    expect(publicProjection).not.toContain('source_data_views')
    expect(publicProjection).not.toContain('Ada')
    expect(publicProjection).not.toContain('=2+2')
    const manifest = await delegated.sourceDataView(prepared.dataViewId!)
    expect(manifest).toMatchObject({
      dataViewId: prepared.dataViewId,
      jobId: prepared.jobId,
      sourceId: source.sourceId,
      sourceVersionId: version.sourceVersionId,
      fieldCount: 2,
      rowCount: 1,
      fields: [
        { ordinal: 0, label: 'name' },
        { ordinal: 1, label: 'formula' },
      ],
      freshness: 'current',
      staleAt: null,
    })
    const publicManifest = JSON.stringify(manifest)
    expect(publicManifest).not.toContain('privateObjectKey')
    expect(publicManifest).not.toContain('source_data_views')
    expect(publicManifest).not.toContain('Ada')
    expect(publicManifest).not.toContain('=2+2')

    const selectedFields = [manifest.fields[0]!.fieldId, manifest.fields[1]!.fieldId]
    const queryGrant = await ownware.createDataViewQueryGrant(manifest.dataViewId, {
      subjectId: 'person.synthetic-data-view',
      purpose: 'customer-support',
      channel: null,
      consent: { state: 'not_required' },
      fieldIds: selectedFields,
      rowOffset: 0,
      rowCount: 1,
      ttlSeconds: 60,
      idempotencyKey: '85858585-abab-4585-8585-858585858585',
    })
    expect(queryGrant).toMatchObject({ mutation: 'created', revision: 1 })

    await expect(delegated.querySourceDataView(manifest.dataViewId, {
      consent: { state: 'not_required' },
      fieldIds: selectedFields,
      rowOffset: 0,
      rowCount: 1,
    })).resolves.toMatchObject({
      dataViewId: manifest.dataViewId,
      sourceId: source.sourceId,
      sourceVersionId: version.sourceVersionId,
      sourceRevision: manifest.sourceRevision,
      freshness: 'current',
      implementationVersion: 'csv_data_view_selection.v1',
      rowOffset: 0,
      requestedRowCount: 1,
      returnedRowCount: 1,
      totalRowCount: 1,
      complete: true,
      fields: manifest.fields,
      rows: [{ ordinal: 0, values: ['Ada', '=2+2'] }],
      observedAt: expect.any(Number),
    })

    const current = await delegated.source(source.sourceId)
    const deletion = await delegated.createSourceDeletion(source.sourceId, {
      expectedRevision: current.revision,
      idempotencyKey: '86868686-abab-4686-8686-868686868686',
    })
    let deleted = await delegated.sourceDeletion(deletion.jobId)
    const deletionDeadline = Date.now() + 2_000
    while (!['cancelled', 'partially_deleted', 'deleted'].includes(deleted.state) &&
           Date.now() < deletionDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      deleted = await delegated.sourceDeletion(deletion.jobId)
    }
    expect(deleted).toMatchObject({
      state: 'deleted',
      affected: { dataViews: 1 },
      remaining: {
        immutableOriginals: 0,
        uploadStaging: 0,
        placedCandidates: 0,
        derivedResources: 0,
        dataViews: 0,
        searchIndexes: 0,
        sourceJobs: 0,
        idempotencyReplays: 0,
        retrievalCacheEntries: 0,
      },
      terminalAt: expect.any(Number),
    })
    await expect(delegated.sourceDeletion(deletion.jobId)).resolves.toEqual(deleted)
    await expect(delegated.sourceDataView(manifest.dataViewId)).rejects.toMatchObject({
      status: 404,
      code: 'source_data_view_not_found',
    })
    const unavailableQuery = await delegated.querySourceDataView(manifest.dataViewId, {
      consent: { state: 'not_required' },
      fieldIds: selectedFields,
      rowOffset: 0,
      rowCount: 1,
    }).catch((error: unknown) => error)
    expect(unavailableQuery).toMatchObject({
      status: 404,
      code: 'source_data_view_unavailable',
    })
    expect(JSON.stringify(unavailableQuery)).not.toContain('Ada')
    expect(JSON.stringify(unavailableQuery)).not.toContain('=2+2')
    await expect(delegated.sourceJob(inspection.jobId)).rejects.toMatchObject({
      status: 404,
      code: 'source_job_not_found',
    })
    await expect(delegated.sourceJob(prepared.jobId)).rejects.toMatchObject({
      status: 404,
      code: 'source_job_not_found',
    })
    await expect(delegated.sourceVersion(
      source.sourceId, version.sourceVersionId,
    )).rejects.toMatchObject({ status: 404, code: 'source_version_not_found' })
    await expect(delegated.source(source.sourceId)).rejects.toMatchObject({
      status: 404,
      code: 'source_not_found',
    })
    await expect(delegated.sources()).resolves.toEqual({ items: [], nextCursor: null })
    await expect(ownware.accessGrant(queryGrant.grantId)).resolves.toMatchObject({
      grantId: queryGrant.grantId,
      state: 'revoked',
      revision: 2,
      revokedAt: expect.any(Number),
    })
  })

  it('run() starts a run and streamReply() reaches a terminal event', async () => {
    const result = await ownware.run({ profileId: 'test-agent', prompt: 'hello' })
    expect(result.threadId).toMatch(/^thread_/)
    // The gateway dispatched the fake provider's catalog default —
    // the keyless-fallback path in action, visible through the SDK.
    expect(result.model).toBe('openai:gpt-5.5')
    expect(result.timeoutMs).toBe(30 * 60 * 1000)
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/)
    const snapshot = await ownware.runSnapshot(result.runId!)
    expect(snapshot).toMatchObject({
      runId: result.runId,
      threadId: result.threadId,
      profileId: 'test-agent',
    })

    // The fake provider has no stream() — the run dies immediately and
    // the stream MUST surface that as a terminal event instead of
    // hanging forever (the exact bug hand-rolled clients hit).
    const types: string[] = []
    for await (const ev of ownware.streamReply(result.runId!)) types.push(ev.type)
    expect(types.length).toBeGreaterThan(0)
    expect(['done', 'error']).toContain(types[types.length - 1])
  }, 20_000)

  it('run() replays one durable idempotency key without creating a second thread', async () => {
    const idempotencyKey = '22222222-2222-4222-8222-222222222222'
    const input = { profileId: 'test-agent', prompt: 'one logical turn', idempotencyKey }
    const before = gateway.state.listThreads(undefined, { limit: 10_000 }).items.length
    const first = await ownware.run(input)
    const second = await ownware.run(input)
    const conflict = await ownware.run({ ...input, prompt: 'different turn' })
      .catch((error: unknown) => error)
    const after = gateway.state.listThreads(undefined, { limit: 10_000 }).items.length
    expect(second.threadId).toBe(first.threadId)
    expect(second.runId).toBe(first.runId)
    expect(conflict).toBeInstanceOf(OwnwareError)
    expect(conflict).toMatchObject({ status: 409, code: 'idempotency_conflict' })
    expect(after).toBe(before + 1)
  })

  it('streams the second turn from its run boundary, never the first terminal event', async () => {
    const first = await ownware.run({
      profileId: 'test-agent',
      prompt: 'first bounded turn',
      idempotencyKey: '99999999-9999-4999-8999-999999999999',
    })
    const firstEvents = []
    for await (const event of ownware.streamReply(first.runId!)) firstEvents.push(event)

    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      if ((await ownware.runSnapshot(first.runId!)).terminal) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const second = await ownware.run({
      profileId: 'test-agent',
      threadId: first.threadId,
      prompt: 'second bounded turn',
      idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })
    const secondEvents = []
    for await (const event of ownware.streamReply(second.runId!)) secondEvents.push(event)

    expect(second.runId).not.toBe(first.runId)
    expect(secondEvents.at(-1)!.seq).toBeGreaterThan(firstEvents.at(-1)!.seq)
  }, 20_000)

  it('cancel() is exact and legacy owner abort remains compatible', async () => {
    const { runId, threadId } = await ownware.run({ profileId: 'test-agent', prompt: 'hi again' })
    const cancellation = await ownware.cancel(runId!)
    expect(cancellation.runId).toBe(runId)
    expect(['requested', 'already_terminal']).toContain(cancellation.cancellation)
    await expect(ownware.abort(threadId)).resolves.toBeUndefined()
  })
})
