import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AccessGrantEvaluator } from '../../../src/gateway/access-grant-evaluator.js'
import {
  AccessGrantStore,
  type AccessGrantRevision,
} from '../../../src/gateway/access-grant-store.js'
import { csvDataViewOrdinalId } from '../../../src/gateway/csv-data-view.js'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import {
  ProtectedDataViewSelectionService,
  type ProtectedDataViewSelectionHardFloor,
  type ProtectedDataViewSelectionInput,
  type ProtectedDataViewSelectionPolicyContext,
} from '../../../src/gateway/protected-data-view-selection.js'
import {
  SourceByteStore,
  SourceByteStoreError,
  type SelectCsvDataViewArtifactInput,
} from '../../../src/gateway/source-byte-store.js'
import {
  SourceDataViewStore,
  type SourceDataViewManifest,
} from '../../../src/gateway/source-data-view-store.js'

const WORKSPACE_ID = 'workspace.test'
const PROFILE_ID = 'assistant'
const SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const VERSION_ID = '22222222-2222-4222-8222-222222222222'
const OBJECT_KEY = `sources/${SOURCE_ID}/versions/${VERSION_ID}/original`
const ORIGINAL = Buffer.from('name,plan,secret\nAda,basic,alpha\nBob,pro,beta')

let dir: string
let storageRoot: string
let database: CortexDatabase
let grants: AccessGrantStore
let evaluator: AccessGrantEvaluator
let dataViews: SourceDataViewStore
let bytes: HookedByteStore
let view: SourceDataViewManifest
let grant: AccessGrantRevision

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'protected-data-view-selection-'))
  storageRoot = join(dir, 'source-storage')
  database = new CortexDatabase(join(dir, 'ownware.db'))
  grants = new AccessGrantStore(database.rawMainHandle)
  evaluator = new AccessGrantEvaluator(grants)
  dataViews = new SourceDataViewStore(database.rawMainHandle)
  bytes = new HookedByteStore(storageRoot)
  view = await seedCurrentDataView()
  grant = createGrant()
})

afterEach(async () => {
  database.close()
  await rm(dir, { recursive: true, force: true })
})

describe('ProtectedDataViewSelectionService', () => {
  it('releases only the exact granted fields and manifest-bounded rows', async () => {
    const contexts: ProtectedDataViewSelectionPolicyContext[] = []
    const service = createService((context) => {
      contexts.push(context)
      return { decision: 'allow' }
    })

    const result = await service.select(input(1, 10))

    expect(result).toMatchObject({
      dataViewId: view.dataViewId,
      sourceId: SOURCE_ID,
      sourceVersionId: VERSION_ID,
      sourceRevision: 1,
      sourceChecksum: checksum(ORIGINAL),
      artifactChecksum: view.artifactChecksum,
      freshness: 'current',
      classification: 'internal',
      authority: 'supporting_reference',
      rowOffset: 1,
      requestedRowCount: 10,
      returnedRowCount: 1,
      totalRowCount: 2,
      complete: true,
      fields: [{ fieldId: view.fields[1]!.fieldId, label: 'plan' }],
      rows: [{
        rowId: csvDataViewOrdinalId('row', VERSION_ID, 1),
        ordinal: 1,
        values: ['pro'],
      }],
      observedAt: 200,
    })
    expect(contexts).toEqual([
      expect.objectContaining({
        operation: 'source_data_views.query',
        dataViewId: view.dataViewId,
        sourceVersionId: VERSION_ID,
        fieldIds: [view.fields[1]!.fieldId],
        rowIds: [csvDataViewOrdinalId('row', VERSION_ID, 1)],
        consent: { state: 'not_required' },
        autonomy: 'observe',
        permissionMode: 'auto',
      }),
      expect.objectContaining({
        operation: 'source_data_views.query',
        dataViewId: view.dataViewId,
        sourceVersionId: VERSION_ID,
        fieldIds: [view.fields[1]!.fieldId],
        rowIds: [csvDataViewOrdinalId('row', VERSION_ID, 1)],
        consent: { state: 'not_required' },
        autonomy: 'observe',
        permissionMode: 'auto',
      }),
    ])
    expect(JSON.stringify(result)).not.toContain('alpha')
    expect(JSON.stringify(result)).not.toContain('beta')
    expect(JSON.stringify(result)).not.toContain('privateObjectKey')
    expect(JSON.stringify(result)).not.toContain('sources/')
    expect(bytes.calls).toBe(1)
  })

  it('checks exact field and actual row identities before selecting bytes', async () => {
    const service = createService()
    for (const denied of [
      { ...input(0, 1), subjectId: 'person.synthetic-other' },
      { ...input(0, 1), fieldIds: ['field.00000000000000000000000000000000'] },
      { ...input(2, 1) },
      { ...input(3, 1) },
    ]) {
      await expect(service.select(denied)).rejects.toMatchObject({
        code: 'protected_data_view_unavailable',
      })
    }
    expect(bytes.calls).toBe(0)
  })

  it('caps grant-backed requests at the 256-ID access-scope ceiling', async () => {
    await expect(createService().select(input(0, 257))).rejects.toMatchObject({
      code: 'protected_data_view_unavailable',
    })
    expect(bytes.calls).toBe(0)
  })

  it('snapshots the requested field scope before the asynchronous selection', async () => {
    const request = input(1, 1)
    const mutableFieldIds = [...request.fieldIds]
    const mutableRequest = { ...request, fieldIds: mutableFieldIds }
    bytes.beforeSelect = () => mutableFieldIds.push(view.fields[2]!.fieldId)

    const result = await createService().select(mutableRequest)

    expect(result.fields.map((field) => field.fieldId)).toEqual([view.fields[1]!.fieldId])
    expect(result.rows).toEqual([expect.objectContaining({ values: ['pro'] })])
  })

  it('rejects a substituted private artifact locator before selecting bytes', async () => {
    database.rawMainHandle.prepare(`
      UPDATE source_data_views SET private_object_key = ? WHERE data_view_id = ?
    `).run(
      `sources/33333333-3333-4333-8333-333333333333/versions/${VERSION_ID}` +
        `/data-views/${view.dataViewId}.json`,
      view.dataViewId,
    )

    await expect(createService().select(input(1, 1))).rejects.toMatchObject({
      code: 'protected_data_view_unavailable',
    })
    expect(bytes.calls).toBe(0)
  })

  it('checks the hard floor before selection and again before release', async () => {
    await expect(createService(() => ({
      decision: 'deny', ruleId: 'data_view.policy.denied',
    })).select(input(1, 1))).rejects.toMatchObject({
      code: 'protected_data_view_unavailable',
    })
    expect(bytes.calls).toBe(0)

    let checks = 0
    await expect(createService(() => ++checks === 1
      ? { decision: 'allow' }
      : { decision: 'deny', ruleId: 'data_view.policy.changed' },
    ).select(input(1, 1))).rejects.toMatchObject({
      code: 'protected_data_view_unavailable',
    })
    expect(checks).toBe(2)
    expect(bytes.calls).toBe(1)
  })

  it('withholds buffered cells after grant revoke or expiry', async () => {
    bytes.afterSelect = () => {
      grants.revoke({
        grantId: grant.grantId,
        workspaceId: grant.workspaceId,
        profileId: grant.profileId,
        expectedRevision: grant.revision,
      }, 201)
    }
    await expect(createService().select(input(1, 1))).rejects.toMatchObject({
      code: 'protected_data_view_unavailable',
    })
    expect(bytes.calls).toBe(1)

    bytes.afterSelect = undefined
    grant = createGrant(201, 300)
    const times = [250, 300]
    await expect(createService(undefined, () => times.shift() ?? 300)
      .select(input(1, 1))).rejects.toMatchObject({
      code: 'protected_data_view_unavailable',
    })
    expect(bytes.calls).toBe(2)
  })

  it('withholds buffered cells after refresh, deletion, or target substitution', async () => {
    for (const mutate of [
      () => database.rawMainHandle.prepare(`
        UPDATE source_data_views SET freshness = 'stale', stale_at = 201
        WHERE data_view_id = ?
      `).run(view.dataViewId),
      () => database.rawMainHandle.prepare(`
        UPDATE runtime_sources SET deletion_state = 'frozen' WHERE source_id = ?
      `).run(SOURCE_ID),
      () => database.rawMainHandle.prepare(`
        UPDATE source_data_views SET source_revision = source_revision + 1
        WHERE data_view_id = ?
      `).run(view.dataViewId),
      () => database.rawMainHandle.prepare(`
        UPDATE runtime_sources SET revision = revision + 1 WHERE source_id = ?
      `).run(SOURCE_ID),
      () => database.rawMainHandle.prepare(`
        UPDATE runtime_sources SET audience_policy_ref = 'audience.changed'
        WHERE source_id = ?
      `).run(SOURCE_ID),
    ]) {
      bytes.afterSelect = mutate
      await expect(createService().select(input(1, 1))).rejects.toMatchObject({
        code: 'protected_data_view_unavailable',
      })
      bytes.afterSelect = undefined
      database.close()
      await rm(dir, { recursive: true, force: true })
      dir = await mkdtemp(join(tmpdir(), 'protected-data-view-selection-'))
      storageRoot = join(dir, 'source-storage')
      database = new CortexDatabase(join(dir, 'ownware.db'))
      grants = new AccessGrantStore(database.rawMainHandle)
      evaluator = new AccessGrantEvaluator(grants)
      dataViews = new SourceDataViewStore(database.rawMainHandle)
      bytes = new HookedByteStore(storageRoot)
      view = await seedCurrentDataView()
      grant = createGrant()
    }
  })

  it('collapses artifact tamper and selector failures to unavailable without cells', async () => {
    const locator = dataViews.getPrivateArtifact(
      view.dataViewId, WORKSPACE_ID, PROFILE_ID,
    )!
    await writeFile(join(storageRoot, locator.privateObjectKey), 'tampered')
    await expect(createService().select(input(1, 1))).rejects.toMatchObject({
      code: 'protected_data_view_unavailable',
    })

    bytes.forcedError = new SourceByteStoreError('data_view_timeout')
    await expect(createService().select(input(1, 1))).rejects.toMatchObject({
      code: 'protected_data_view_unavailable',
    })
  })
})

class HookedByteStore extends SourceByteStore {
  calls = 0
  beforeSelect: (() => void | Promise<void>) | undefined
  afterSelect: (() => void | Promise<void>) | undefined
  forcedError: Error | undefined

  override async selectCsvDataViewArtifact(input: SelectCsvDataViewArtifactInput) {
    this.calls += 1
    if (this.forcedError) throw this.forcedError
    await this.beforeSelect?.()
    const result = await super.selectCsvDataViewArtifact(input)
    await this.afterSelect?.()
    return result
  }
}

function createService(
  hardFloor: ProtectedDataViewSelectionHardFloor = () => ({ decision: 'allow' }),
  clock: () => number = () => 200,
): ProtectedDataViewSelectionService {
  return new ProtectedDataViewSelectionService(
    dataViews, evaluator, bytes, hardFloor, clock,
  )
}

function createGrant(effectiveAt = 100, expiresAt = 1_000): AccessGrantRevision {
  return grants.create({
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    subjectId: 'person.synthetic-1',
    purpose: 'customer_support',
    channel: 'web.primary',
    resourceKind: 'source_data_view',
    resourceId: view.dataViewId,
    operation: 'source_data_views.query',
    fieldScope: { mode: 'list', ids: [view.fields[1]!.fieldId] },
    rowScope: {
      mode: 'list',
      ids: [csvDataViewOrdinalId('row', VERSION_ID, 1)],
    },
    consent: { state: 'not_required' },
    autonomyCeiling: 'observe',
    effectiveAt,
    expiresAt,
    issuedBy: 'owner.synthetic',
  }, effectiveAt)
}

function input(rowOffset: number, rowCount: number): ProtectedDataViewSelectionInput {
  return {
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    subjectId: 'person.synthetic-1',
    purpose: 'customer_support',
    channel: 'web.primary',
    dataViewId: view.dataViewId,
    consent: { state: 'not_required' },
    permissionMode: 'auto',
    fieldIds: [view.fields[1]!.fieldId],
    rowOffset,
    rowCount,
  }
}

async function seedCurrentDataView(): Promise<SourceDataViewManifest> {
  database.rawMainHandle.prepare(`
    INSERT INTO runtime_sources (
      source_id, workspace_id, profile_id, kind, label, classification,
      authority, audience_policy_ref, sensitivity_policy_ref,
      purpose_policy_ref, retention_policy_ref, freshness_policy_ref,
      revision, current_version_id, registration_state, inspection_state,
      preparation_state, access_state, freshness_state, conflict_state,
      deletion_state, created_at, updated_at
    ) VALUES (
      ?, ?, ?, 'structured_export', 'Synthetic CSV', 'internal',
      'supporting_reference', 'audience.test', 'sensitivity.test',
      'purpose.test', 'retention.test', 'freshness.test', 1, ?, 'registered',
      'complete', 'not_requested', 'available', 'fresh', 'none', 'active', 10, 10
    )
  `).run(SOURCE_ID, WORKSPACE_ID, PROFILE_ID, VERSION_ID)
  database.rawMainHandle.prepare(`
    INSERT INTO source_versions (
      source_version_id, source_id, checksum, verified_media_type, byte_count,
      object_key, inspection_state, preparation_state, created_at
    ) VALUES (?, ?, ?, 'text/plain', ?, ?, 'complete', 'not_requested', 10)
  `).run(VERSION_ID, SOURCE_ID, checksum(ORIGINAL), ORIGINAL.length, OBJECT_KEY)
  await mkdir(dirname(join(storageRoot, OBJECT_KEY)), { recursive: true })
  await writeFile(join(storageRoot, OBJECT_KEY), ORIGINAL)

  const job = dataViews.enqueue({
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    sourceId: SOURCE_ID,
    sourceVersionId: VERSION_ID,
  }, 20)
  const claim = dataViews.claimNext('protected-selection-worker', 30)!
  const target = dataViews.getClaimedTarget(job.jobId, claim.claimToken, 31)!
  expect(dataViews.advanceCheckpoint(job.jobId, claim.claimToken, 0, 1, 32))
    .toBe('advanced')
  const artifact = await bytes.prepareCsvDataViewArtifact(target)
  expect(dataViews.advanceCheckpoint(job.jobId, claim.claimToken, 1, 2, 33))
    .toBe('advanced')
  expect(dataViews.advanceCheckpoint(job.jobId, claim.claimToken, 2, 3, 34))
    .toBe('advanced')
  expect(dataViews.publish(job.jobId, claim.claimToken, artifact, 35)).toBe('finished')
  return dataViews.getViewScoped(claim.dataViewId, WORKSPACE_ID, PROFILE_ID)!
}

function checksum(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}
