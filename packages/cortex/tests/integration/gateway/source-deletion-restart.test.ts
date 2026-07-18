import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { AccessGrantStore } from '../../../src/gateway/access-grant-store.js'
import { RunIdempotencyStore } from '../../../src/gateway/idempotency.js'
import { SourceDeletionStore } from '../../../src/gateway/source-deletion-store.js'
import { SourceJobStore } from '../../../src/gateway/source-job-store.js'
import { SourceStore } from '../../../src/gateway/source-store.js'
import { createTestGateway } from '../../framework/harness/gateway.js'

const VERSION_ID = '81818181-abab-4818-8818-818181818181'
const RESOURCE_ID = '82828282-abab-4828-8828-828282828282'

let cleanupDir: string | undefined
let restarted: OwnwareGateway | undefined

afterEach(async () => {
  await restarted?.stop()
  restarted = undefined
  if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true })
  cleanupDir = undefined
})

describe('source deletion plan across a real Gateway restart', () => {
  it('retains the exact freeze and inventory without deleting bytes or entering the normal worker', async () => {
    const gateway = await createTestGateway({
      disableAuth: false,
      disableSourceWorker: true,
    })
    cleanupDir = gateway.tmpDir
    const workspaceId = gateway.state.createWorkspace(
      gateway.tmpDir,
      'Source deletion restart',
    ).id
    const source = new SourceStore(gateway.state.rawDbHandle).create({
      workspaceId,
      profileId: 'mini',
      kind: 'file',
      label: 'Synthetic deletion restart source',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.test',
      sensitivityPolicyRef: 'sensitivity.test',
      purposePolicyRef: 'purpose.test',
      retentionPolicyRef: 'retention.test',
      freshnessPolicyRef: 'freshness.test',
    })
    const objectKey = `sources/${source.sourceId}/versions/${VERSION_ID}/original`
    const objectPath = join(gateway.tmpDir, 'data', 'source-storage', objectKey)
    await mkdir(dirname(objectPath), { recursive: true, mode: 0o700 })
    await writeFile(objectPath, 'Deletion restart evidence.\n', { mode: 0o600 })
    gateway.state.rawDbHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, preparation_state, created_at
      ) VALUES (?, ?, ?, 'text/plain', 27, ?, 'not_started', 'not_requested', ?)
    `).run(VERSION_ID, source.sourceId, `sha256:${'a'.repeat(64)}`, objectKey, Date.now())
    gateway.state.rawDbHandle.prepare(`
      UPDATE runtime_sources SET revision = 2, current_version_id = ?,
        registration_state = 'registered', freshness_state = 'fresh'
      WHERE source_id = ?
    `).run(VERSION_ID, source.sourceId)
    const resourceJob = new SourceJobStore(gateway.state.rawDbHandle).enqueue({
      workspaceId,
      profileId: 'mini',
      sourceId: source.sourceId,
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
    })
    gateway.state.rawDbHandle.prepare(`
      INSERT INTO source_derived_resources (
        resource_id, job_id, workspace_id, profile_id, source_id,
        source_version_id, kind, operation, implementation_version,
        source_revision, source_checksum, resource_checksum, byte_start,
        byte_end, byte_count, classification, authority, audience_policy_ref,
        sensitivity_policy_ref, purpose_policy_ref, retention_policy_ref,
        freshness_policy_ref, coverage, freshness, created_at, stale_at
      ) VALUES (
        ?, ?, ?, 'mini', ?, ?, 'text_extraction', 'extract_text', 'text_extraction.v1',
        2, ?, ?, 0, 27, 27, 'internal', 'supporting_reference', 'audience.test',
        'sensitivity.test', 'purpose.test', 'retention.test', 'freshness.test',
        'complete', 'current', ?, NULL
      )
    `).run(
      RESOURCE_ID,
      resourceJob.jobId,
      workspaceId,
      source.sourceId,
      VERSION_ID,
      `sha256:${'a'.repeat(64)}`,
      `sha256:${'a'.repeat(64)}`,
      Date.now(),
    )
    const grant = new AccessGrantStore(gateway.state.rawDbHandle).create({
      workspaceId,
      profileId: 'mini',
      subjectId: 'person.synthetic-1',
      purpose: 'customer_support',
      channel: 'web.primary',
      resourceKind: 'source_resource',
      resourceId: RESOURCE_ID,
      operation: 'source_content.read',
      fieldScope: { mode: 'all' },
      rowScope: { mode: 'all' },
      consent: { state: 'not_required' },
      autonomyCeiling: 'observe',
      effectiveAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      issuedBy: 'owner.synthetic',
    })
    const idempotency = new RunIdempotencyStore(
      gateway.state.rawDbHandle, 'restart-grant-replay',
    )
    const replay = idempotency.claim({
      principalKey: 'owner',
      operation: 'private.access-grant-mutation',
      key: '83838383-abab-4838-8838-838383838383',
      input: { resourceId: RESOURCE_ID },
    }) as { kind: 'claimed'; recordId: string }
    idempotency.linkSourceMutation(
      replay.recordId, source.sourceId, 'access_grant',
    )
    const plan = new SourceDeletionStore(gateway.state.rawDbHandle).plan({
      workspaceId,
      profileId: 'mini',
      sourceId: source.sourceId,
      expectedRevision: 2,
    })
    await gateway.stop({ cleanup: false })

    restarted = new OwnwareGateway({
      port: 0,
      profilesDir: join(cleanupDir, 'profiles'),
      dataDir: join(cleanupDir, 'data'),
      dbPath: join(cleanupDir, 'test.db'),
      tls: false,
      disableAuth: false,
      disableSourceWorker: true,
    })
    await restarted.start()
    expect(new SourceDeletionStore(restarted.state.rawDbHandle).getScoped(
      source.sourceId,
      workspaceId,
      'mini',
    )).toEqual(plan)
    expect(restarted.state.rawDbHandle.prepare(`
      SELECT revision, deletion_state FROM runtime_sources WHERE source_id = ?
    `).get(source.sourceId)).toEqual({ revision: 3, deletion_state: 'frozen' })
    await expect(stat(objectPath)).resolves.toMatchObject({ isFile: expect.any(Function) })
    expect(new SourceJobStore(restarted.state.rawDbHandle).claimNext('normal-worker'))
      .toBeNull()
    expect(new AccessGrantStore(restarted.state.rawDbHandle).getCurrentScoped(
      grant.grantId, workspaceId, 'mini',
    )).toMatchObject({ revision: 2, state: 'revoked' })
    expect(new SourceDeletionStore(restarted.state.rawDbHandle).getInventory(plan.jobId))
      .toEqual(expect.arrayContaining([
        { kind: 'access_grant_revocation', id: grant.grantId },
        { kind: 'grant_mutation_replay', id: replay.recordId },
      ]))
    expect(restarted.state.rawDbHandle.prepare(`
      SELECT state, result_json, source_mutation_kind
      FROM run_idempotency WHERE id = ?
    `).get(replay.recordId)).toEqual({
      state: 'indeterminate', result_json: null, source_mutation_kind: 'access_grant',
    })
  }, 20_000)

  it('resumes an expired irreversible claim and verifies byte absence before success', async () => {
    const gateway = await createTestGateway({
      disableAuth: false,
      disableSourceWorker: true,
    })
    cleanupDir = gateway.tmpDir
    const workspaceId = gateway.state.createWorkspace(
      gateway.tmpDir,
      'Source deletion worker restart',
    ).id
    const source = new SourceStore(gateway.state.rawDbHandle).create({
      workspaceId,
      profileId: 'mini',
      kind: 'file',
      label: 'Synthetic deletion worker restart source',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.test',
      sensitivityPolicyRef: 'sensitivity.test',
      purposePolicyRef: 'purpose.test',
      retentionPolicyRef: 'retention.test',
      freshnessPolicyRef: 'freshness.test',
    })
    const objectKey = `sources/${source.sourceId}/versions/${VERSION_ID}/original`
    const objectPath = join(gateway.tmpDir, 'data', 'source-storage', objectKey)
    await mkdir(dirname(objectPath), { recursive: true, mode: 0o700 })
    await writeFile(objectPath, 'Deletion restart evidence.\n', { mode: 0o600 })
    gateway.state.rawDbHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, preparation_state, created_at
      ) VALUES (?, ?, ?, 'text/plain', 27, ?, 'not_started', 'not_requested', ?)
    `).run(VERSION_ID, source.sourceId, `sha256:${'a'.repeat(64)}`, objectKey, Date.now())
    gateway.state.rawDbHandle.prepare(`
      UPDATE runtime_sources SET revision = 2, current_version_id = ?,
        registration_state = 'registered', freshness_state = 'fresh'
      WHERE source_id = ?
    `).run(VERSION_ID, source.sourceId)
    const deletions = new SourceDeletionStore(gateway.state.rawDbHandle)
    const plan = deletions.plan({
      workspaceId,
      profileId: 'mini',
      sourceId: source.sourceId,
      expectedRevision: 2,
    })
    const claimedAt = Date.now()
    const claim = deletions.claimNext('crashed-deletion-worker', claimedAt)!
    expect(deletions.startDestruction(plan.jobId, claim.claimToken, claimedAt + 1))
      .toBe('advanced')
    gateway.state.rawDbHandle.prepare(`
      UPDATE source_jobs SET lease_expires_at = ? WHERE job_id = ?
    `).run(Date.now() - 1, plan.jobId)
    await gateway.stop({ cleanup: false })

    restarted = new OwnwareGateway({
      port: 0,
      profilesDir: join(cleanupDir, 'profiles'),
      dataDir: join(cleanupDir, 'data'),
      dbPath: join(cleanupDir, 'test.db'),
      tls: false,
      disableAuth: false,
    })
    await restarted.start()
    await waitFor(() => new SourceDeletionStore(restarted!.state.rawDbHandle).getScoped(
      source.sourceId,
      workspaceId,
      'mini',
    )?.state === 'succeeded')
    await expect(stat(objectPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(new SourceDeletionStore(restarted.state.rawDbHandle).getInventoryEntries(plan.jobId))
      .toEqual([])
    expect(restarted.state.rawDbHandle.prepare(`
      SELECT source_id, immutable_originals FROM source_deletion_tombstones
      WHERE job_id = ?
    `).get(plan.jobId)).toEqual({
      source_id: source.sourceId,
      immutable_originals: 1,
    })

    await restarted.stop()
    restarted = new OwnwareGateway({
      port: 0,
      profilesDir: join(cleanupDir, 'profiles'),
      dataDir: join(cleanupDir, 'data'),
      dbPath: join(cleanupDir, 'test.db'),
      tls: false,
      disableAuth: false,
      disableSourceWorker: true,
    })
    await restarted.start()
    expect(new SourceDeletionStore(restarted.state.rawDbHandle).getPublicByJobScoped(
      plan.jobId,
      workspaceId,
      'mini',
    )).toMatchObject({
      sourceId: source.sourceId,
      state: 'deleted',
      affected: { immutableOriginals: 1 },
      remaining: { immutableOriginals: 0 },
    })
  }, 20_000)
})

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for source deletion worker')
}
