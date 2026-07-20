import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OwnwareGateway } from '../../../src/gateway/server.js'

let gateway: OwnwareGateway
let rootDir: string
let baseUrl: string

beforeAll(async () => {
  process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'
  rootDir = await mkdtemp(join(tmpdir(), 'ownware-capabilities-'))
  gateway = new OwnwareGateway({
    port: 0,
    profilesDir: join(rootDir, 'profiles'),
    dataDir: join(rootDir, 'data'),
    tls: false,
    disableAuth: false,
  })
  await gateway.start()
  baseUrl = `http://127.0.0.1:${gateway.port}`
}, 20_000)

afterAll(async () => {
  await gateway.stop()
  await rm(rootDir, { recursive: true, force: true })
})

describe('GET /api/v1/capabilities', () => {
  it('requires the normal Gateway bearer token', async () => {
    const response = await fetch(`${baseUrl}/api/v1/capabilities`)
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: 'unauthorized',
      category: 'auth',
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(response.headers.get('x-ownware-correlation-id')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('declares only the deliberately published v1 operations', async () => {
    const response = await fetch(`${baseUrl}/api/v1/capabilities`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      contract: {
        name: 'ownware.gateway',
        major: 1,
        revision: '0.30.0',
      },
      capabilities: [
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
      ],
      limits: {
        jsonBodyBytes: 10 * 1024 * 1024,
        candidateUpload: {
          maxFiles: 1_000,
          maxDecodedBytes: 6 * 1024 * 1024,
          maxPathCharacters: 256,
        },
        runAttachments: {
          maxCount: 8,
          maxItemDecodedBytes: 4 * 1024 * 1024,
          maxTotalDecodedBytes: 6 * 1024 * 1024,
          maxFilenameCharacters: 255,
        },
        accessGrants: {
          minTtlSeconds: 60,
          maxTtlSeconds: 30 * 24 * 60 * 60,
          maxActivePerWorkspaceProfile: 1_024,
          maxPageSize: 100,
        },
        sourceContent: { maxRangeBytes: 64 * 1024 },
        sourceSearch: {
          maxScanBytes: 16 * 1024 * 1024,
          maxQueryBytes: 128,
          maxMatches: 20,
          maxContextBytes: 1024,
          perRequestTimeoutMs: 5_000,
          matchModes: ['exact_utf8', 'ascii_case_insensitive'],
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
        delegationDefaultTtlSeconds: 900,
        delegationMaxTtlSeconds: 3600,
        idempotencyRetentionSeconds: 7 * 24 * 60 * 60,
        rateLimit: {
          enabled: true,
          windowSeconds: 60,
          generalRequests: 600,
          runStarts: 10,
        },
      },
    })
  })

  it('does not expose routes, host paths, persistence details or credentials', async () => {
    const response = await fetch(`${baseUrl}/api/v1/capabilities`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
    })
    const body = JSON.stringify(await response.json()).toLowerCase()

    expect(body).not.toContain('/api/')
    expect(body).not.toContain('marketplace')
    expect(body).not.toContain('sqlite')
    expect(body).not.toContain('database')
    expect(body).not.toContain('token')
    expect(body).not.toContain('/users/')
    expect(body).not.toContain('profilesdir')
    expect(body).not.toContain('datadir')
    expect(body).not.toContain('tmpdir')
  })
})
