import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayState } from '../../../src/gateway/state.js'
import { StorageRepositoryError } from '../../../src/storage/contracts.js'

const DRIVER_SECRET = 'SOURCE_DRIVER_ERROR_SECRET_CANARY_791c4e'
const CUSTOMER_SECRET = 'SOURCE_CUSTOMER_SECRET_CANARY_70f19d'
const WORKSPACE_ID = 'source-boundary-workspace'
const PROFILE_ID = 'source-boundary-profile'
const CHECKSUM = `sha256:${'a'.repeat(64)}`

describe('SQLite source repository boundary', () => {
  let directory: string
  let state: GatewayState | undefined

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cortex-source-boundary-'))
    state = new GatewayState(join(directory, 'ownware.db'), {
      permissionHashSecret: 'source-boundary-permission-secret',
    })
  })

  afterEach(async () => {
    await state?.closeStorage().catch(() => {})
    state = undefined
    rmSync(directory, { recursive: true, force: true })
  })

  it('discards driver/customer text and commits no registration on failure', async () => {
    const active = state!
    active.rawDbHandle.exec(`
      CREATE TRIGGER source_registration_failure
      BEFORE INSERT ON runtime_sources
      BEGIN
        SELECT RAISE(ABORT, '${DRIVER_SECRET}');
      END;
    `)
    const consoleSpies = [
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
    ]
    try {
      const failure = await active.sourceRepositories.sources.create({
        ...registration(CUSTOMER_SECRET),
      }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(StorageRepositoryError)
      expect(failure).toMatchObject({
        code: 'write_failed',
        kind: 'sqlite',
        domain: 'sources',
        operation: 'create',
        retryable: false,
      })
      const rendered = JSON.stringify(
        failure,
        Object.getOwnPropertyNames(failure as object),
      ) + String(failure)
      expect(rendered).not.toContain(DRIVER_SECRET)
      expect(rendered).not.toContain(CUSTOMER_SECRET)
      expect(consoleSpies.flatMap(spy => spy.mock.calls).join(' '))
        .not.toContain(DRIVER_SECRET)
      expect(consoleSpies.flatMap(spy => spy.mock.calls).join(' '))
        .not.toContain(CUSTOMER_SECRET)
      expect(active.rawDbHandle.prepare(
        'SELECT COUNT(*) AS count FROM runtime_sources',
      ).get()).toEqual({ count: 0 })
    } finally {
      for (const spy of consoleSpies) spy.mockRestore()
    }
  })

  it('rolls source freeze, job cancellation and deletion plan back together', async () => {
    const active = state!
    const prepared = await prepareVersion(active)
    const inspection = await active.sourceRepositories.jobs.enqueue({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId: prepared.sourceId,
      sourceVersionId: prepared.versionId,
      operation: 'inspect_format',
    }, 100)
    active.rawDbHandle.exec(`
      CREATE TRIGGER source_deletion_inventory_failure
      BEFORE INSERT ON source_deletion_inventory
      BEGIN
        SELECT RAISE(ABORT, '${DRIVER_SECRET}');
      END;
    `)

    const failure = await active.sourceRepositories.deletions.plan({
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      sourceId: prepared.sourceId,
      expectedRevision: 2,
    }, 200).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(StorageRepositoryError)
    expect(String(failure)).not.toContain(DRIVER_SECRET)
    expect(await active.sourceRepositories.sources.getScoped(
      prepared.sourceId, WORKSPACE_ID, PROFILE_ID,
    )).toMatchObject({
      revision: 2,
      health: { deletion: 'active' },
    })
    expect(await active.sourceRepositories.jobs.getScoped(
      inspection.jobId, WORKSPACE_ID, PROFILE_ID,
    )).toMatchObject({ state: 'queued', cancelRequestedAt: null })
    expect(active.rawDbHandle.prepare(
      'SELECT COUNT(*) AS count FROM source_deletion_plans',
    ).get()).toEqual({ count: 0 })
    expect(active.rawDbHandle.prepare(`
      SELECT COUNT(*) AS count FROM source_jobs WHERE operation = 'delete_source'
    `).get()).toEqual({ count: 0 })
    expect(active.rawDbHandle.prepare(
      'SELECT COUNT(*) AS count FROM source_deletion_inventory',
    ).get()).toEqual({ count: 0 })
  })

  it('expires retained source repositories when storage closes', async () => {
    const repositories = state!.sourceRepositories
    await state!.closeStorage()
    await expect(async () => repositories.sources.listScoped(
      WORKSPACE_ID, PROFILE_ID, { limit: 10 },
    )).rejects.toMatchObject({
      name: 'StorageLifecycleError',
      code: 'repository_unavailable',
      kind: 'sqlite',
      state: 'closed',
    })
  })
})

function registration(label: string) {
  return {
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    kind: 'structured_export' as const,
    label,
    classification: 'internal' as const,
    authority: 'supporting_reference' as const,
    audiencePolicyRef: 'audience.policy.boundary',
    sensitivityPolicyRef: 'sensitivity.policy.boundary',
    purposePolicyRef: 'purpose.policy.boundary',
    retentionPolicyRef: 'retention.policy.boundary',
    freshnessPolicyRef: 'freshness.policy.boundary',
  }
}

async function prepareVersion(active: GatewayState) {
  const source = await active.sourceRepositories.sources.create(
    registration('boundary source'),
    10,
  )
  const upload = await active.sourceRepositories.uploads.create({
    sourceId: source.sourceId,
    workspaceId: WORKSPACE_ID,
    profileId: PROFILE_ID,
    principalKey: 'source-boundary-principal',
    expectedBytes: 16,
    expectedChecksum: CHECKSUM,
    declaredMediaType: 'text/plain',
    filename: 'boundary.csv',
  }, 20)
  await active.sourceRepositories.uploads.advanceChunk(
    upload.uploadId,
    0,
    { byteCount: 16, checksum: `sha256:${'b'.repeat(64)}` },
    30,
  )
  const versionId = await active.sourceRepositories.uploads.beginCompletion(
    upload.uploadId,
    40,
  )
  await active.sourceRepositories.uploads.finishCompletion(upload.uploadId, {
    versionId,
    checksum: CHECKSUM,
    verifiedMediaType: 'text/plain',
    byteCount: 16,
    objectKey: `sources/${source.sourceId}/versions/${versionId}/original`,
  }, 50)
  return { sourceId: source.sourceId, versionId }
}
