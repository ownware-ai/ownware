import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayState } from '../../../src/gateway/state.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import {
  RunIdempotencyStore,
  principalContinuityKey,
  type SourceDeletionSnapshot,
  type SourceJobSnapshot,
  type SourceUploadSessionSnapshot,
  type SourceRegistrationSnapshot,
} from '../../../src/gateway/idempotency.js'

let dir: string
let dbPath: string
let state: GatewayState

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ownware-idempotency-'))
  dbPath = join(dir, 'ownware.db')
  state = new GatewayState(dbPath)
})

afterEach(async () => {
  state.close()
  await rm(dir, { recursive: true, force: true })
})

describe('migration 052 run idempotency', () => {
  it('is additive and creates only bounded request/result metadata', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 52)
    expect(migration?.name).toBe('052_run_idempotency')
    expect(migration?.destructive).toBeUndefined()

    const columns = state.rawDbHandle
      .prepare('PRAGMA table_info(run_idempotency)')
      .all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual([
      'id', 'principal_key', 'operation', 'idempotency_key', 'request_salt',
      'request_digest', 'state', 'lease_owner', 'status_code', 'result_json',
      'created_at', 'updated_at', 'expires_at', 'run_id', 'source_id',
      'source_mutation_kind',
    ])
  })
})

describe('RunIdempotencyStore', () => {
  const scope = 'owner'
  const key = '11111111-1111-4111-8111-111111111111'
  const body = { prompt: 'private prompt canary', profileId: 'assistant' }

  it('replays a completed result across restart without storing request data', () => {
    const first = new RunIdempotencyStore(state.rawDbHandle, 'boot-a')
    expect(first.claim({ principalKey: scope, operation: 'runs.start', key, input: body }, 1_000))
      .toMatchObject({ kind: 'claimed', recordId: expect.any(String) })
    first.complete({
      principalKey: scope,
      operation: 'runs.start',
      key,
      statusCode: 200,
      result: { threadId: 'thread_1', agentId: 'root', profileId: 'assistant', model: 'test:model', status: 'running' },
    }, 1_100)

    const stored = JSON.stringify(state.rawDbHandle
      .prepare('SELECT * FROM run_idempotency')
      .get())
    expect(stored).not.toContain('private prompt canary')

    state.close()
    state = new GatewayState(dbPath)
    const reopened = new RunIdempotencyStore(state.rawDbHandle, 'boot-b')
    expect(reopened.claim({ principalKey: scope, operation: 'runs.start', key, input: body }, 1_200))
      .toMatchObject({
        kind: 'replay',
        statusCode: 200,
        result: { threadId: 'thread_1' },
      })
  })

  it('rejects payload conflict before changing the completed result', () => {
    const store = new RunIdempotencyStore(state.rawDbHandle, 'boot-a')
    expect(store.claim({ principalKey: scope, operation: 'runs.start', key, input: body }, 1_000).kind)
      .toBe('claimed')
    expect(store.claim({
      principalKey: scope,
      operation: 'runs.start',
      key,
      input: { ...body, prompt: 'different' },
    }, 1_001)).toEqual({ kind: 'conflict' })
  })

  it('keeps same-boot work in progress and makes prior-boot work indeterminate', () => {
    const first = new RunIdempotencyStore(state.rawDbHandle, 'boot-a')
    expect(first.claim({ principalKey: scope, operation: 'runs.start', key, input: body }, 1_000).kind)
      .toBe('claimed')
    expect(first.claim({ principalKey: scope, operation: 'runs.start', key, input: body }, 1_001))
      .toEqual({ kind: 'in_progress' })

    const restarted = new RunIdempotencyStore(state.rawDbHandle, 'boot-b')
    expect(restarted.claim({ principalKey: scope, operation: 'runs.start', key, input: body }, 2_000))
      .toEqual({ kind: 'indeterminate' })
    expect(state.rawDbHandle
      .prepare('SELECT state FROM run_idempotency WHERE idempotency_key = ?')
      .pluck()
      .get(key)).toBe('indeterminate')
  })

  it('derives delegated continuity without token IDs or bearer material', () => {
    expect(principalContinuityKey({
      kind: 'delegated',
      tokenId: 'rotating-token-id',
      delegateId: 'client-1',
      workspaceId: 'workspace-1',
      profileId: 'assistant',
      purpose: 'support',
      channel: 'web',
      operations: ['runs.start'],
      issuedAt: 1,
      expiresAt: 2,
    })).toBe('delegated\0client-1\0workspace-1\0assistant\0support\0web')
  })

  it('projects source replay snapshots without unexpected persisted fields', () => {
    const store = new RunIdempotencyStore(state.rawDbHandle, 'boot-a')
    const sourceKey = '53535353-abab-4535-8535-535353535353'
    expect(store.claim({
      principalKey: scope,
      operation: 'sources.register',
      key: sourceKey,
      input: { label: 'Safe source' },
    }).kind).toBe('claimed')
    const result: SourceRegistrationSnapshot & { readonly path: string } = {
      sourceId: '54545454-abab-4545-8545-545454545454',
      kind: 'file',
      label: 'Safe source',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.support',
      sensitivityPolicyRef: 'sensitivity.internal',
      purposePolicyRef: 'purpose.support',
      retentionPolicyRef: 'retention.standard',
      freshnessPolicyRef: 'freshness.monthly',
      revision: 1,
      currentVersionId: null,
      health: {
        registration: 'pending', inspection: 'not_started',
        preparation: 'not_requested', access: 'available',
        freshness: 'unknown', conflict: 'none', deletion: 'active',
      },
      createdAt: 100,
      updatedAt: 100,
      path: '/private/replay-canary',
    }
    seedActiveSource(result.sourceId)
    store.complete({
      principalKey: scope,
      operation: 'sources.register',
      key: sourceKey,
      statusCode: 202,
      result,
    })

    const stored = state.rawDbHandle.prepare(`
      SELECT result_json FROM run_idempotency WHERE idempotency_key = ?
    `).pluck().get(sourceKey) as string
    expect(stored).not.toContain('/private/replay-canary')
    const replay = store.claim({
      principalKey: scope,
      operation: 'sources.register',
      key: sourceKey,
      input: { label: 'Safe source' },
    })
    expect(JSON.stringify(replay)).not.toContain('/private/replay-canary')
  })

  it('closes preparation replay and preserves only truthful public resource identity', () => {
    const store = new RunIdempotencyStore(state.rawDbHandle, 'boot-a')
    const preparationKey = '63636363-abab-4636-8636-636363636363'
    const input = { operation: 'extract_text' }
    expect(store.claim({
      principalKey: scope, operation: 'source_preparations.create', key: preparationKey, input,
    }).kind).toBe('claimed')
    const result: SourceJobSnapshot & { readonly objectKey: string } = {
      jobId: '64646464-abab-4646-8646-646464646464',
      sourceId: '65656565-abab-4656-8656-656565656565',
      sourceVersionId: '66666666-abab-4666-8666-666666666666',
      operation: 'extract_text',
      implementationVersion: 'text_extraction.v1',
      resourceId: null,
      state: 'queued', attempt: 0, maxAttempts: 3, checkpoint: 0,
      cancelRequestedAt: null, outcomeCode: null,
      createdAt: 100, updatedAt: 100, terminalAt: null,
      objectKey: '/private/resource-canary',
    }
    seedActiveSource(result.sourceId)
    store.complete({
      principalKey: scope,
      operation: 'source_preparations.create',
      key: preparationKey,
      statusCode: 202,
      result,
    })
    const replay = store.claim({
      principalKey: scope, operation: 'source_preparations.create', key: preparationKey, input,
    })
    expect(replay).toMatchObject({
      kind: 'replay',
      result: {
        operation: 'extract_text', implementationVersion: 'text_extraction.v1', resourceId: null,
      },
    })
    expect(JSON.stringify(replay)).not.toContain('/private/resource-canary')
  })

  it('backfills legacy inspection replay and abandons deterministic readiness failures', () => {
    const store = new RunIdempotencyStore(state.rawDbHandle, 'boot-a')
    const legacyKey = '67676767-abab-4676-8676-676767676767'
    const input = { operation: 'inspect_format' }
    expect(store.claim({
      principalKey: scope, operation: 'source_jobs.create', key: legacyKey, input,
    }).kind).toBe('claimed')
    state.rawDbHandle.prepare(`
      UPDATE run_idempotency
      SET state = 'completed', status_code = 202, result_json = ?
      WHERE idempotency_key = ?
    `).run(JSON.stringify({
      jobId: '68686868-abab-4686-8686-686868686868',
      sourceId: '69696969-abab-4696-8696-696969696969',
      sourceVersionId: '70707070-abab-4707-8707-707070707070',
      operation: 'inspect_format', state: 'queued', attempt: 0, maxAttempts: 3,
      checkpoint: 0, cancelRequestedAt: null, outcomeCode: null,
      createdAt: 100, updatedAt: 100, terminalAt: null,
    }), legacyKey)
    expect(store.claim({
      principalKey: scope, operation: 'source_jobs.create', key: legacyKey, input,
    })).toMatchObject({
      kind: 'replay',
      result: { implementationVersion: 'inspect_format.v1', resourceId: null },
    })

    const abandonedKey = '71717171-abab-4717-8717-717171717171'
    const abandoned = {
      principalKey: scope, operation: 'source_preparations.create', key: abandonedKey,
    }
    expect(store.claim({ ...abandoned, input }).kind).toBe('claimed')
    store.abandon(abandoned)
    expect(store.claim({ ...abandoned, input }).kind).toBe('claimed')
  })

  it('never completes or replays source metadata while the linked source is frozen', () => {
    const store = new RunIdempotencyStore(state.rawDbHandle, 'boot-a')
    const sourceId = '72727272-abab-4727-8727-727272727272'
    const key = '73737373-abab-4737-8737-737373737373'
    const input = { sourceId, expectedBytes: 4 }
    seedActiveSource(sourceId)
    expect(store.claim({
      principalKey: scope, operation: 'source_uploads.create', key, input,
    }).kind).toBe('claimed')
    state.rawDbHandle.prepare(`
      UPDATE runtime_sources SET deletion_state = 'frozen', revision = revision + 1
      WHERE source_id = ?
    `).run(sourceId)
    expect(() => store.complete({
      principalKey: scope,
      operation: 'source_uploads.create',
      key,
      statusCode: 201,
      result: uploadSnapshot(sourceId),
    })).toThrow('Idempotency claim is not completable')
    store.markIndeterminate({ principalKey: scope, operation: 'source_uploads.create', key })
    expect(store.claim({
      principalKey: scope, operation: 'source_uploads.create', key, input,
    })).toEqual({ kind: 'indeterminate' })

    const replayKey = '74747474-abab-4747-8747-747474747474'
    state.rawDbHandle.prepare(`
      UPDATE runtime_sources SET deletion_state = 'active' WHERE source_id = ?
    `).run(sourceId)
    expect(store.claim({
      principalKey: scope, operation: 'source_uploads.create', key: replayKey, input,
    }).kind).toBe('claimed')
    store.complete({
      principalKey: scope,
      operation: 'source_uploads.create',
      key: replayKey,
      statusCode: 201,
      result: uploadSnapshot(sourceId),
    })
    state.rawDbHandle.prepare(`
      UPDATE runtime_sources SET deletion_state = 'frozen' WHERE source_id = ?
    `).run(sourceId)
    expect(store.claim({
      principalKey: scope, operation: 'source_uploads.create', key: replayKey, input,
    })).toEqual({ kind: 'indeterminate' })
    state.rawDbHandle.prepare(`
      UPDATE runtime_sources SET deletion_state = 'active' WHERE source_id = ?
    `).run(sourceId)
    expect(store.claim({
      principalKey: scope, operation: 'source_uploads.create', key: replayKey, input,
    })).toMatchObject({ kind: 'replay', result: { sourceId } })
  })

  it('links only an owned in-progress source mutation while the source is active', () => {
    const sourceId = '75757575-abab-4757-8757-757575757575'
    const key = '76767676-abab-4767-8767-767676767670'
    seedActiveSource(sourceId)
    const store = new RunIdempotencyStore(state.rawDbHandle, 'grant-boot')
    const claim = store.claim({
      principalKey: scope,
      operation: 'private.access-grant-mutation',
      key,
      input: { resourceId: 'synthetic-resource' },
    }, 100)
    expect(claim).toMatchObject({ kind: 'claimed', recordId: expect.any(String) })
    const recordId = (claim as { kind: 'claimed'; recordId: string }).recordId

    store.linkSourceMutation(recordId, sourceId, 'access_grant', 101)
    expect(state.rawDbHandle.prepare(`
      SELECT source_id, source_mutation_kind, state, result_json
      FROM run_idempotency WHERE id = ?
    `).get(recordId)).toEqual({
      source_id: sourceId,
      source_mutation_kind: 'access_grant',
      state: 'in_progress',
      result_json: null,
    })
    expect(() => store.linkSourceMutation(
      recordId, sourceId, 'access_grant', 102,
    )).toThrow('Source mutation link is not available')
    expect(() => new RunIdempotencyStore(
      state.rawDbHandle, 'other-boot',
    ).linkSourceMutation(recordId, sourceId, 'access_grant', 102))
      .toThrow('Source mutation link is not available')

    const otherKey = '77777777-abab-4777-8777-777777777770'
    const other = store.claim({
      principalKey: scope,
      operation: 'private.access-grant-mutation',
      key: otherKey,
      input: {},
    }, 103) as { kind: 'claimed'; recordId: string }
    state.rawDbHandle.prepare(`
      UPDATE runtime_sources SET deletion_state = 'frozen' WHERE source_id = ?
    `).run(sourceId)
    expect(() => store.linkSourceMutation(
      other.recordId, sourceId, 'access_grant', 104,
    )).toThrow('Source mutation link is not available')
  })

  it('replays only a minimal immutable grant receipt and preserves its source link', () => {
    const sourceId = '78787878-abab-4787-8787-787878787878'
    const key = '79797979-abab-4797-8797-797979797979'
    const grantId = '80808080-abab-4808-8808-808080808080'
    seedActiveSource(sourceId)
    const store = new RunIdempotencyStore(state.rawDbHandle, 'grant-receipt-boot')
    const mutationInput = {
      resourceId: 'resource.synthetic',
      subjectId: 'person.synthetic',
      secret: 'grant-receipt-secret-canary',
    }
    const claim = store.claim({
      principalKey: 'owner',
      operation: 'access_grants.create',
      key,
      input: mutationInput,
    }, 100) as { kind: 'claimed'; recordId: string }
    store.linkSourceMutation(claim.recordId, sourceId, 'access_grant', 101)
    store.complete({
      principalKey: 'owner',
      operation: 'access_grants.create',
      key,
      statusCode: 201,
      result: {
        grantId,
        revision: 1,
        mutation: 'created',
        acceptedAt: 102,
      },
    }, 102)

    const row = state.rawDbHandle.prepare(`
      SELECT source_id, source_mutation_kind, result_json
      FROM run_idempotency WHERE id = ?
    `).get(claim.recordId) as {
      source_id: string
      source_mutation_kind: string
      result_json: string
    }
    expect(row.source_id).toBe(sourceId)
    expect(row.source_mutation_kind).toBe('access_grant')
    expect(row.result_json).not.toContain('lifecycle')
    expect(row.result_json).not.toContain('grant-receipt-secret-canary')
    expect(store.claim({
      principalKey: 'owner',
      operation: 'access_grants.create',
      key,
      input: mutationInput,
    }, 103)).toEqual({
      kind: 'replay',
      statusCode: 201,
      result: { grantId, revision: 1, mutation: 'created', acceptedAt: 102 },
    })
  })

  it('retains only the safe deletion creation replay without linking the removed source', () => {
    const store = new RunIdempotencyStore(state.rawDbHandle, 'boot-a')
    const deletionKey = '76767676-abab-4767-8767-767676767676'
    const sourceId = '77777777-abab-4777-8777-777777777777'
    const input = { sourceId, expectedRevision: 1 }
    expect(store.claim({
      principalKey: scope,
      operation: 'source_deletions.create',
      key: deletionKey,
      input,
    }).kind).toBe('claimed')
    const counts = {
      immutableOriginals: 0,
      uploadStaging: 0,
      placedCandidates: 0,
      derivedResources: 0,
      dataViews: 0,
      searchIndexes: 0,
      sourceJobs: 0,
      idempotencyReplays: 0,
      retrievalCacheEntries: 0,
    }
    const result: SourceDeletionSnapshot & { readonly objectKey: string } = {
      jobId: '78787878-abab-4787-8787-787878787878',
      sourceId,
      operation: 'delete_source',
      state: 'queued',
      sourceRevision: 2,
      affected: counts,
      remaining: counts,
      createdAt: 100,
      updatedAt: 100,
      terminalAt: null,
      objectKey: '/private/deletion-replay-canary',
    }
    store.complete({
      principalKey: scope,
      operation: 'source_deletions.create',
      key: deletionKey,
      statusCode: 202,
      result,
    })
    expect(state.rawDbHandle.prepare(`
      SELECT source_id, result_json FROM run_idempotency WHERE idempotency_key = ?
    `).get(deletionKey)).toMatchObject({ source_id: null })
    expect(JSON.stringify(state.rawDbHandle.prepare(`
      SELECT result_json FROM run_idempotency WHERE idempotency_key = ?
    `).get(deletionKey))).not.toContain('/private/deletion-replay-canary')

    state.close()
    state = new GatewayState(dbPath)
    const replay = new RunIdempotencyStore(state.rawDbHandle, 'boot-b').claim({
      principalKey: scope,
      operation: 'source_deletions.create',
      key: deletionKey,
      input,
    })
    expect(replay).toMatchObject({
      kind: 'replay',
      statusCode: 202,
      result: { sourceId, operation: 'delete_source', state: 'queued' },
    })
    expect(JSON.stringify(replay)).not.toContain('/private/deletion-replay-canary')
  })
})

function seedActiveSource(sourceId: string): void {
  state.rawDbHandle.prepare(`
    INSERT INTO runtime_sources (
      source_id, workspace_id, profile_id, kind, label, classification,
      authority, audience_policy_ref, sensitivity_policy_ref, purpose_policy_ref,
      retention_policy_ref, freshness_policy_ref, revision, current_version_id,
      registration_state, inspection_state, preparation_state, access_state,
      freshness_state, conflict_state, deletion_state, created_at, updated_at
    ) VALUES (
      ?, 'workspace-a', 'mini', 'file', 'Synthetic idempotency source', 'internal',
      'supporting_reference', 'audience.test', 'sensitivity.test', 'purpose.test',
      'retention.test', 'freshness.test', 1, NULL, 'pending', 'not_started',
      'not_requested', 'available', 'unknown', 'none', 'active', 10, 10
    )
  `).run(sourceId)
}

function uploadSnapshot(sourceId: string): SourceUploadSessionSnapshot {
  return {
    uploadId: '75757575-abab-4757-8757-757575757575',
    sourceId,
    state: 'open',
    offset: 0,
    expectedBytes: 4,
    expectedChecksum: `sha256:${'a'.repeat(64)}`,
    declaredMediaType: 'text/plain',
    maxChunkBytes: 1048576,
    maxChunks: 64,
    expiresAt: 200,
    createdAt: 100,
  }
}
