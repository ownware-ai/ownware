import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayState } from '../../../src/gateway/state.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import { openDatabaseSafely } from '../../../src/gateway/db/migration-safety.js'
import { CandidateStore } from '../../../src/gateway/candidate-store.js'
import {
  GatewayRunStore,
  ProfileRunNotAcceptingError,
} from '../../../src/gateway/run-store.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ownware-run-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('migration 053 gateway runs', () => {
  it('upgrades v52 additively and preserves existing thread/idempotency data', () => {
    const path = join(dir, 'upgrade.db')
    const legacy = openDatabaseSafely(
      path,
      (db) => db.pragma('foreign_keys = ON'),
      MIGRATIONS.filter((entry) => entry.version <= 52),
    )
    legacy.prepare(`
      INSERT INTO threads (id, profile_id, status) VALUES ('thread_existing', 'mini', 'completed')
    `).run()
    legacy.prepare(`
      INSERT INTO run_idempotency (
        id, principal_key, operation, idempotency_key, request_salt,
        request_digest, state, lease_owner, status_code, result_json,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, 200, ?, ?, ?, ?)
    `).run(
      'idem_existing',
      'owner',
      'runs.start',
      '77777777-7777-4777-8777-777777777777',
      'salt',
      'digest',
      'old-boot',
      JSON.stringify({ threadId: 'thread_existing', agentId: 'root', profileId: 'mini', model: 'test:model', status: 'running' }),
      1,
      2,
      10_000,
    )
    legacy.close()

    const upgraded = new GatewayState(path)
    try {
      expect(upgraded.getThread('thread_existing')?.profileId).toBe('mini')
      expect(upgraded.rawDbHandle
        .prepare('SELECT run_id FROM run_idempotency WHERE id = ?')
        .pluck()
        .get('idem_existing')).toBeNull()
      expect(upgraded.rawDbHandle
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gateway_runs'")
        .pluck()
        .get()).toBe('gateway_runs')
    } finally {
      upgraded.close()
    }
  })
})

describe('exact run permission records', () => {
  it('binds request and operation hash without persisting raw tool input', () => {
    const state = new GatewayState(join(dir, 'permissions.db'))
    try {
      const thread = state.createThread('mini')
      const store = new GatewayRunStore(state.rawDbHandle, 'a'.repeat(64))
      const run = store.create({
        threadId: thread.id,
        profileId: 'mini',
        model: 'test:model',
        timeoutMs: 1_000,
        startSeq: 0,
      })
      const first = store.recordPermissionRequest({
        runId: run.runId,
        requestId: 'permission_1',
        toolName: 'send_email',
        toolInput: { body: 'raw-secret-canary' },
      })
      const second = store.recordPermissionRequest({
        runId: run.runId,
        requestId: 'permission_2',
        toolName: 'send_email',
        toolInput: { body: 'different' },
      })
      expect(first.operationHash).toMatch(/^[0-9a-f]{64}$/)
      expect(second.operationHash).not.toBe(first.operationHash)
      expect(JSON.stringify(state.rawDbHandle
        .prepare('SELECT * FROM run_permission_requests')
        .all())).not.toContain('raw-secret-canary')

      expect(store.decidePermission(
        run.runId, first.requestId, first.operationHash, 'approve',
      )).toBe('decided')
      expect(store.decidePermission(
        run.runId, first.requestId, first.operationHash, 'deny',
      )).toBe('already_decided')
      expect(store.decidePermission(
        run.runId, second.requestId, first.operationHash, 'deny',
      )).toBe('hash_mismatch')
    } finally {
      state.close()
    }
  })
})

describe('durable run cancellation requests', () => {
  it('moves a live run to cancel_requested exactly once and never reopens terminal state', () => {
    const state = new GatewayState(join(dir, 'cancel.db'))
    try {
      const store = new GatewayRunStore(state.rawDbHandle, 'synthetic-test-secret')
      const thread = state.createThread('test')
      const run = store.create({
        threadId: thread.id,
        profileId: 'test',
        model: 'test:model',
        timeoutMs: 60_000,
        startSeq: 0,
      }, 100)
      store.markRunning(run.runId, 110)

      expect(store.requestCancel(run.runId, 120)).toBe('requested')
      expect(store.get(run.runId)).toMatchObject({
        status: 'cancel_requested',
        cancelRequestedAt: 120,
        terminal: false,
      })
      expect(store.requestCancel(run.runId, 130)).toBe('already_requested')
      expect(store.get(run.runId)?.cancelRequestedAt).toBe(120)

      store.markTerminal(run.runId, 'cancelled', { endSeq: 4, now: 140 })
      expect(store.requestCancel(run.runId, 150)).toBe('terminal')
      expect(store.get(run.runId)).toMatchObject({ status: 'cancelled', terminalAt: 140 })
      expect(store.requestCancel('00000000-0000-4000-8000-000000000000')).toBe('missing')
    } finally {
      state.close()
    }
  })
})

describe('profile deployment acceptance fence', () => {
  it('atomically rejects a paused profile and reports only its real active runs', () => {
    const state = new GatewayState(join(dir, 'paused.db'))
    try {
      const candidates = new CandidateStore(state.rawDbHandle)
      const candidateId = `sha256:${'a'.repeat(64)}`
      candidates.begin({
        candidateId, profileId: 'test', attemptId: 'attempt-a', fileCount: 1, totalBytes: 20,
      })
      candidates.markReady(candidateId, 'attempt-a')
      candidates.compareAndSetActive({
        profileId: 'test', candidateId, expectedActiveCandidateId: null,
      })
      const runs = new GatewayRunStore(state.rawDbHandle, 'synthetic-test-secret')
      const firstThread = state.createThread('test')
      const first = runs.create({
        threadId: firstThread.id, profileId: 'test', candidateId,
        model: 'test:model', timeoutMs: 60_000, startSeq: 0,
      })
      runs.markRunning(first.runId)
      expect(runs.countActiveForProfile('test')).toBe(1)

      candidates.compareAndSetRouting({
        profileId: 'test', expectedRevision: 1, routingState: 'paused',
      })
      const blockedThread = state.createThread('test')
      expect(() => runs.create({
        threadId: blockedThread.id, profileId: 'test', candidateId,
        model: 'test:model', timeoutMs: 60_000, startSeq: 0,
      })).toThrow(ProfileRunNotAcceptingError)
      expect(runs.countActiveForProfile('test')).toBe(1)

      runs.markTerminal(first.runId, 'succeeded', { endSeq: 0 })
      expect(runs.countActiveForProfile('test')).toBe(0)
    } finally {
      state.close()
    }
  })
})
