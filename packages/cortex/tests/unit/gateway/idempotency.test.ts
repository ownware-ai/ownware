import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayState } from '../../../src/gateway/state.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import {
  RunIdempotencyStore,
  principalContinuityKey,
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
      'created_at', 'updated_at', 'expires_at', 'run_id',
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
})
