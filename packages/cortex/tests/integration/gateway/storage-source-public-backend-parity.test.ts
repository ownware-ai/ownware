import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OwnwareGateway, type GatewayOptions } from '../../../src/gateway/server.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const PROFILE_ID = 'mini'
const SUBJECT_ID = 'person.storage-source-parity'
const PRIVATE_CELL = 'source-parity-private-cell'
const CSV = Buffer.from(`name,plan\nAda,${PRIVATE_CELL}\nBob,standard\n`)
const CHECKSUM = `sha256:${createHash('sha256').update(CSV).digest('hex')}`
const TEST_URL = configuredPostgreSqlTestUrl()
const itPostgreSql = TEST_URL === undefined ? it.skip : it

type JsonObject = Record<string, unknown>
type StorageKind = 'sqlite' | 'postgresql'

interface HttpEvidence {
  readonly status: number
  readonly body: unknown
}

interface SourceJourneyEvidence {
  readonly workspace: HttpEvidence
  readonly registration: HttpEvidence
  readonly uploadCreated: HttpEvidence
  readonly uploadWritten: HttpEvidence
  readonly uploadCompleted: HttpEvidence
  readonly inspectionAccepted: HttpEvidence
  readonly inspectionTerminal: HttpEvidence
  readonly preparationAccepted: HttpEvidence
  readonly preparationTerminal: HttpEvidence
  readonly dataView: HttpEvidence
  readonly grant: HttpEvidence
  readonly queryBeforeRestart: HttpEvidence
  readonly sourceAfterRestart: HttpEvidence
  readonly queryAfterRestart: HttpEvidence
  readonly revocation: HttpEvidence
  readonly queryAfterRevocation: HttpEvidence
  readonly deletionAccepted: HttpEvidence
  readonly deletionTerminal: HttpEvidence
  readonly sourceAfterDeletion: HttpEvidence
  readonly sourceListAfterDeletion: HttpEvidence
  readonly physicalBytes: {
    readonly durableBeforeDeletion: boolean
    readonly absentAfterDeletion: boolean
  }
}

interface JourneyBackend {
  readonly storage: NonNullable<GatewayOptions['storage']>
  readonly close: () => Promise<void>
}

async function createBackend(kind: StorageKind, root: string): Promise<JourneyBackend> {
  if (kind === 'sqlite') {
    return {
      storage: { kind: 'sqlite', path: join(root, 'storage.db') },
      close: async () => {},
    }
  }
  const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
  return {
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => database.url },
      tls: { mode: 'disable', allowInsecureLoopback: true },
    },
    close: database.close,
  }
}

async function runSourceJourney(kind: StorageKind): Promise<SourceJourneyEvidence> {
  const root = await mkdtemp(join(tmpdir(), `ownware-source-parity-${kind}-`))
  const profilesDir = join(root, 'profiles')
  const dataDir = join(root, 'data')
  const workspacePath = join(root, 'workspace')
  let backend: JourneyBackend | undefined
  let gateway: OwnwareGateway | undefined

  try {
    backend = await createBackend(kind, root)
    await mkdir(join(profilesDir, PROFILE_ID), { recursive: true })
    await mkdir(workspacePath, { recursive: true })
    await writeFile(join(profilesDir, PROFILE_ID, 'agent.json'), JSON.stringify({
      name: PROFILE_ID,
      tools: { preset: 'none' },
      context: { cwd: false, datetime: false },
    }))

    const options = (): GatewayOptions => ({
      port: 0,
      tls: false,
      profilesDir,
      dataDir,
      disableAuth: false,
      disableRateLimit: true,
      disableAccessLog: true,
      storage: backend!.storage,
    })

    gateway = new OwnwareGateway(options())
    await gateway.start()
    let baseUrl = `http://127.0.0.1:${gateway.port}`

    const workspace = await requestJson(baseUrl, '/api/v1/workspaces', {
      method: 'POST',
      headers: ownerHeaders(gateway.token),
      body: JSON.stringify({ path: workspacePath, name: 'Source parity workspace' }),
    })
    expect(workspace.status).toBe(201)
    const workspaceId = stringField(workspace.body, 'id')

    const lifecycleToken = await issueDelegation(baseUrl, gateway.token, {
      delegateId: 'storage-source-parity-lifecycle',
      subjectId: SUBJECT_ID,
      workspaceId,
      operations: [
        'sources.register',
        'sources.list',
        'sources.read',
        'source_uploads.create',
        'source_uploads.write',
        'source_uploads.complete',
        'source_versions.read',
        'source_jobs.create',
        'source_jobs.read',
        'source_preparations.create',
        'source_data_views.read',
        'source_deletions.create',
        'source_deletions.read',
      ],
    })

    const registration = await requestJson(baseUrl, '/api/v1/sources', {
      method: 'POST',
      headers: delegatedHeaders(
        lifecycleToken,
        '11111111-1000-4000-8000-000000000001',
      ),
      body: JSON.stringify({
        kind: 'structured_export',
        label: 'Source backend parity CSV',
        classification: 'internal',
        authority: 'supporting_reference',
        audiencePolicyRef: 'audience.source-parity',
        sensitivityPolicyRef: 'sensitivity.source-parity',
        purposePolicyRef: 'purpose.customer-support',
        retentionPolicyRef: 'retention.source-parity',
        freshnessPolicyRef: 'freshness.source-parity',
      }),
    })
    expect(registration.status).toBe(202)
    const sourceId = stringField(registration.body, 'sourceId')

    const uploadCreated = await requestJson(
      baseUrl,
      `/api/v1/sources/${sourceId}/upload-sessions`,
      {
        method: 'POST',
        headers: delegatedHeaders(
          lifecycleToken,
          '22222222-2000-4000-8000-000000000002',
        ),
        body: JSON.stringify({
          expectedBytes: CSV.length,
          expectedChecksum: CHECKSUM,
          declaredMediaType: 'text/plain',
          filename: 'source-parity.csv',
        }),
      },
    )
    expect(uploadCreated.status).toBe(201)
    const uploadId = stringField(uploadCreated.body, 'uploadId')

    const uploadWritten = await requestJson(
      baseUrl,
      `/api/v1/source-uploads/${uploadId}`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${lifecycleToken}`,
          'content-type': 'application/offset+octet-stream',
          'upload-offset': '0',
          'upload-chunk-checksum': CHECKSUM,
        },
        body: CSV,
      },
    )
    expect(uploadWritten).toMatchObject({
      status: 200,
      body: { offset: CSV.length, chunkCount: 1, replayed: false },
    })

    const uploadCompleted = await requestJson(
      baseUrl,
      `/api/v1/source-uploads/${uploadId}/complete`,
      { method: 'POST', headers: delegatedHeaders(lifecycleToken) },
    )
    expect(uploadCompleted.status).toBe(201)
    const sourceVersionId = stringField(uploadCompleted.body, 'sourceVersionId')

    const originalPath = join(
      dataDir,
      'source-storage',
      'sources',
      sourceId,
      'versions',
      sourceVersionId,
      'original',
    )
    expect(await readFile(originalPath)).toEqual(CSV)

    const inspectionAccepted = await requestJson(
      baseUrl,
      `/api/v1/sources/${sourceId}/versions/${sourceVersionId}/jobs`,
      {
        method: 'POST',
        headers: delegatedHeaders(
          lifecycleToken,
          '33333333-3000-4000-8000-000000000003',
        ),
        body: JSON.stringify({ operation: 'inspect_format' }),
      },
    )
    expect(inspectionAccepted.status).toBe(202)
    const inspectionId = stringField(inspectionAccepted.body, 'jobId')
    const inspectionTerminal = await waitForJob(baseUrl, lifecycleToken, inspectionId)
    expect(inspectionTerminal).toMatchObject({
      status: 200,
      body: { state: 'succeeded', outcomeCode: 'inspection_complete' },
    })

    const preparationAccepted = await requestJson(
      baseUrl,
      `/api/v1/sources/${sourceId}/versions/${sourceVersionId}/preparations`,
      {
        method: 'POST',
        headers: delegatedHeaders(
          lifecycleToken,
          '44444444-4000-4000-8000-000000000004',
        ),
        body: JSON.stringify({ operation: 'prepare_data_view' }),
      },
    )
    expect(preparationAccepted.status).toBe(202)
    const preparationId = stringField(preparationAccepted.body, 'jobId')
    const preparationTerminal = await waitForJob(baseUrl, lifecycleToken, preparationId)
    expect(preparationTerminal).toMatchObject({ status: 200, body: { state: 'succeeded' } })
    const dataViewId = stringField(preparationTerminal.body, 'dataViewId')

    const dataView = await requestJson(
      baseUrl,
      `/api/v1/source-data-views/${dataViewId}`,
      { headers: delegatedHeaders(lifecycleToken) },
    )
    expect(dataView.status).toBe(200)
    const fields = arrayField(dataView.body, 'fields') as JsonObject[]
    expect(fields.map((field) => field['label'])).toEqual(['name', 'plan'])
    const nameFieldId = String(fields[0]?.['fieldId'])
    expect(nameFieldId).toMatch(/^field\.[0-9a-f]{32}$/)

    const grant = await requestJson(
      baseUrl,
      `/api/v1/source-data-views/${dataViewId}/access-grants`,
      {
        method: 'POST',
        headers: ownerHeaders(
          gateway.token,
          '55555555-5000-4000-8000-000000000005',
        ),
        body: JSON.stringify({
          subjectId: SUBJECT_ID,
          purpose: 'customer_support',
          channel: 'web.primary',
          consent: { state: 'not_required' },
          ttlSeconds: 600,
          fieldIds: [nameFieldId],
          rowOffset: 0,
          rowCount: 1,
        }),
      },
    )
    expect(grant.status).toBe(201)
    const grantId = stringField(grant.body, 'grantId')
    const grantRevision = numberField(grant.body, 'revision')

    const queryToken = await issueDelegation(baseUrl, gateway.token, {
      delegateId: 'storage-source-parity-query',
      subjectId: SUBJECT_ID,
      workspaceId,
      operations: ['source_data_views.query'],
    })
    const query = (url: string) => requestJson(
      url,
      `/api/v1/source-data-views/${dataViewId}/query`,
      {
        method: 'POST',
        headers: delegatedHeaders(queryToken),
        body: JSON.stringify({
          consent: { state: 'not_required' },
          fieldIds: [nameFieldId],
          rowOffset: 0,
          rowCount: 1,
        }),
      },
    )
    const queryBeforeRestart = await query(baseUrl)
    expect(queryBeforeRestart).toMatchObject({
      status: 200,
      body: {
        fields: [{ fieldId: nameFieldId, ordinal: 0, label: 'name' }],
        rows: [{ ordinal: 0, values: ['Ada'] }],
        returnedRowCount: 1,
      },
    })
    expect(JSON.stringify(queryBeforeRestart.body)).not.toContain(PRIVATE_CELL)

    await gateway.stop()
    gateway = new OwnwareGateway(options())
    await gateway.start()
    baseUrl = `http://127.0.0.1:${gateway.port}`

    const sourceAfterRestart = await requestJson(
      baseUrl,
      `/api/v1/sources/${sourceId}`,
      { headers: delegatedHeaders(lifecycleToken) },
    )
    expect(sourceAfterRestart.status).toBe(200)
    expect(sourceAfterRestart.body).toMatchObject({
      sourceId,
      currentVersionId: sourceVersionId,
    })
    const queryAfterRestart = await query(baseUrl)
    expect(queryAfterRestart.status).toBe(200)
    expect(withoutObservationTime(queryAfterRestart.body))
      .toEqual(withoutObservationTime(queryBeforeRestart.body))
    expect(await readFile(originalPath)).toEqual(CSV)

    const revocation = await requestJson(
      baseUrl,
      `/api/v1/access-grants/${grantId}/revoke`,
      {
        method: 'POST',
        headers: ownerHeaders(
          gateway.token,
          '66666666-6000-4000-8000-000000000006',
        ),
        body: JSON.stringify({ expectedRevision: grantRevision }),
      },
    )
    expect(revocation.status).toBe(200)
    const queryAfterRevocation = await query(baseUrl)
    expect(queryAfterRevocation).toMatchObject({
      status: 404,
      body: { error: 'source_data_view_unavailable' },
    })
    expect(JSON.stringify(queryAfterRevocation.body)).not.toContain('Ada')
    expect(JSON.stringify(queryAfterRevocation.body)).not.toContain(PRIVATE_CELL)

    const sourceRevision = numberField(sourceAfterRestart.body, 'revision')
    const deletionAccepted = await requestJson(
      baseUrl,
      `/api/v1/sources/${sourceId}/deletions`,
      {
        method: 'POST',
        headers: delegatedHeaders(
          lifecycleToken,
          '77777777-7000-4000-8000-000000000007',
        ),
        body: JSON.stringify({ expectedRevision: sourceRevision }),
      },
    )
    expect(deletionAccepted.status).toBe(202)
    const deletionId = stringField(deletionAccepted.body, 'jobId')
    const deletionTerminal = await waitForDeletion(baseUrl, lifecycleToken, deletionId)
    expect(deletionTerminal).toMatchObject({ status: 200, body: { state: 'deleted' } })

    const sourceAfterDeletion = await requestJson(
      baseUrl,
      `/api/v1/sources/${sourceId}`,
      { headers: delegatedHeaders(lifecycleToken) },
    )
    expect(sourceAfterDeletion).toMatchObject({
      status: 404,
      body: { error: 'source_not_found' },
    })
    const sourceListAfterDeletion = await requestJson(baseUrl, '/api/v1/sources', {
      headers: delegatedHeaders(lifecycleToken),
    })
    expect(sourceListAfterDeletion).toMatchObject({
      status: 200,
      body: { items: [], nextCursor: null },
    })
    await expect(stat(originalPath)).rejects.toMatchObject({ code: 'ENOENT' })

    const replacements = new Map<string, string>([
      [root, '<root>'],
      [workspaceId, '<workspace-id>'],
      [sourceId, '<source-id>'],
      [uploadId, '<upload-id>'],
      [sourceVersionId, '<source-version-id>'],
      [inspectionId, '<inspection-job-id>'],
      [preparationId, '<preparation-job-id>'],
      [dataViewId, '<data-view-id>'],
      [grantId, '<grant-id>'],
      [deletionId, '<deletion-job-id>'],
      ...fields.map((field, index) => [
        String(field['fieldId']),
        `<field-${index + 1}-id>`,
      ] as const),
      ...rowIds(queryBeforeRestart.body).map((rowId, index) => [
        rowId,
        `<row-${index + 1}-id>`,
      ] as const),
    ])
    const evidence = {
      workspace,
      registration,
      uploadCreated,
      uploadWritten,
      uploadCompleted,
      inspectionAccepted,
      inspectionTerminal,
      preparationAccepted,
      preparationTerminal,
      dataView,
      grant,
      queryBeforeRestart,
      sourceAfterRestart,
      queryAfterRestart,
      revocation,
      queryAfterRevocation,
      deletionAccepted,
      deletionTerminal,
      sourceAfterDeletion,
      sourceListAfterDeletion,
      physicalBytes: {
        durableBeforeDeletion: true,
        absentAfterDeletion: true,
      },
    }
    expect(JSON.stringify(evidence)).not.toContain(PRIVATE_CELL)
    return canonicalize(evidence, replacements) as unknown as SourceJourneyEvidence
  } finally {
    await gateway?.stop().catch(() => {})
    await backend?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}

async function requestJson(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<HttpEvidence> {
  const response = await fetch(`${baseUrl}${path}`, init)
  return { status: response.status, body: await response.json() as unknown }
}

async function issueDelegation(
  baseUrl: string,
  ownerToken: string,
  input: {
    readonly delegateId: string
    readonly subjectId: string
    readonly workspaceId: string
    readonly operations: readonly string[]
  },
): Promise<string> {
  const response = await requestJson(baseUrl, '/api/v1/auth/delegations', {
    method: 'POST',
    headers: ownerHeaders(ownerToken),
    body: JSON.stringify({
      ...input,
      profileId: PROFILE_ID,
      purpose: 'customer_support',
      channel: 'web.primary',
    }),
  })
  expect(response.status).toBe(201)
  return stringField(response.body, 'token')
}

function ownerHeaders(token: string, idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  }
}

function delegatedHeaders(token: string, idempotencyKey?: string): Record<string, string> {
  return ownerHeaders(token, idempotencyKey)
}

async function waitForJob(
  baseUrl: string,
  token: string,
  jobId: string,
): Promise<HttpEvidence> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const response = await requestJson(baseUrl, `/api/v1/source-jobs/${jobId}`, {
      headers: delegatedHeaders(token),
    })
    expect(response.status).toBe(200)
    const state = String(objectBody(response.body)['state'])
    if (['succeeded', 'partial', 'failed', 'cancelled'].includes(state)) return response
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Source job did not become terminal')
}

async function waitForDeletion(
  baseUrl: string,
  token: string,
  jobId: string,
): Promise<HttpEvidence> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const response = await requestJson(baseUrl, `/api/v1/source-deletions/${jobId}`, {
      headers: delegatedHeaders(token),
    })
    expect(response.status).toBe(200)
    const state = String(objectBody(response.body)['state'])
    if (['deleted', 'partially_deleted', 'cancelled'].includes(state)) return response
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Source deletion did not become terminal')
}

function objectBody(value: unknown): JsonObject {
  expect(value).toBeTypeOf('object')
  expect(value).not.toBeNull()
  expect(Array.isArray(value)).toBe(false)
  return value as JsonObject
}

function stringField(value: unknown, key: string): string {
  const result = objectBody(value)[key]
  expect(result).toBeTypeOf('string')
  return result as string
}

function numberField(value: unknown, key: string): number {
  const result = objectBody(value)[key]
  expect(result).toBeTypeOf('number')
  return result as number
}

function arrayField(value: unknown, key: string): unknown[] {
  const result = objectBody(value)[key]
  expect(Array.isArray(result)).toBe(true)
  return result as unknown[]
}

function rowIds(value: unknown): string[] {
  return arrayField(value, 'rows').map((row) => stringField(row, 'rowId'))
}

function withoutObservationTime(value: unknown): unknown {
  const body = { ...objectBody(value) }
  delete body['observedAt']
  return body
}

function canonicalize(
  value: unknown,
  replacements: ReadonlyMap<string, string>,
  key = '',
): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, replacements))
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as JsonObject).map(([childKey, child]) => [
      childKey,
      canonicalize(child, replacements, childKey),
    ]))
  }
  if (key.endsWith('At') || key === 'observedAt') return '<timestamp>'
  if (key === 'artifactChecksum') return '<artifact-checksum>'
  if (key === 'requestId' || key === 'correlationId') return '<request-id>'
  if (typeof value !== 'string') return value
  let normalized = value
  for (const [original, replacement] of replacements) {
    normalized = normalized.replaceAll(original, replacement)
  }
  return normalized
}

describe('public source lifecycle storage backend parity', () => {
  it('drives real bytes through SQLite, restart, scoped query and deletion', async () => {
    const evidence = await runSourceJourney('sqlite')
    expect(evidence.queryAfterRestart).toEqual(evidence.queryBeforeRestart)
    expect(evidence.physicalBytes).toEqual({
      durableBeforeDeletion: true,
      absentAfterDeletion: true,
    })
  }, 60_000)

  itPostgreSql('matches the complete normalized SQLite journey with PostgreSQL', async () => {
    const sqlite = await runSourceJourney('sqlite')
    const postgresql = await runSourceJourney('postgresql')
    expect(postgresql).toEqual(sqlite)
  }, 120_000)
})
