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
  it('upgrades v52 additively and preserves existing thread/idempotency data', async () => {
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
      expect((await upgraded.getThread('thread_existing'))?.profileId).toBe('mini')
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
  it('binds request and operation hash without persisting raw tool input', async () => {
    const state = new GatewayState(join(dir, 'permissions.db'))
    try {
      const thread = await state.createThread('mini')
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
        policyRevision: 'b'.repeat(64),
        agentId: null,
      })
      const second = store.recordPermissionRequest({
        runId: run.runId,
        requestId: 'permission_2',
        toolName: 'send_email',
        toolInput: { body: 'different' },
        policyRevision: 'b'.repeat(64),
        agentId: null,
      })
      const sameActionNewRequest = store.recordPermissionRequest({
        runId: run.runId,
        requestId: 'permission_3',
        toolName: 'send_email',
        toolInput: { body: 'raw-secret-canary' },
        policyRevision: 'b'.repeat(64),
        agentId: null,
      })
      expect(first.operationHash).toMatch(/^[0-9a-f]{64}$/)
      expect(second.operationHash).not.toBe(first.operationHash)
      expect(sameActionNewRequest.operationHash).not.toBe(first.operationHash)
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
      expect(store.consumePermissionApproval({
        runId: run.runId,
        requestId: first.requestId,
        toolName: 'send_email',
        toolInput: { body: 'changed-after-review' },
        policyRevision: 'b'.repeat(64),
        agentId: null,
      })).toBe('intent_mismatch')
      expect(store.consumePermissionApproval({
        runId: run.runId,
        requestId: first.requestId,
        toolName: 'send_email',
        toolInput: { body: 'raw-secret-canary' },
        policyRevision: 'c'.repeat(64),
        agentId: null,
      })).toBe('intent_mismatch')
      expect(store.consumePermissionApproval({
        runId: run.runId,
        requestId: first.requestId,
        toolName: 'send_email',
        toolInput: { body: 'raw-secret-canary' },
        policyRevision: 'b'.repeat(64),
        agentId: 'agent_other',
      })).toBe('intent_mismatch')
      const exactIntent = {
        runId: run.runId,
        requestId: first.requestId,
        toolName: 'send_email',
        toolInput: { body: 'raw-secret-canary' },
        policyRevision: 'b'.repeat(64),
        agentId: null,
      } as const
      expect(store.consumePermissionApproval(exactIntent, 200)).toBe('consumed')
      expect(store.consumePermissionApproval(exactIntent, 201)).toBe('already_consumed')
      expect(store.getPermissionRequest(run.runId, first.requestId)).toMatchObject({
        intentRevision: 1,
        consumedAt: 200,
      })
      expect(() => state.rawDbHandle.prepare(`
        UPDATE run_permission_bindings SET policy_revision = ?
        WHERE run_id = ? AND request_id = ?
      `).run('d'.repeat(64), run.runId, first.requestId)).toThrow()
      expect(() => state.rawDbHandle.prepare(`
        DELETE FROM run_permission_consumptions
        WHERE run_id = ? AND request_id = ?
      `).run(run.runId, first.requestId)).toThrow()
    } finally {
      state.close()
    }
  })
})

describe('durable run cancellation requests', () => {
  it('moves a live run to cancel_requested exactly once and never reopens terminal state', async () => {
    const state = new GatewayState(join(dir, 'cancel.db'))
    try {
      const store = new GatewayRunStore(state.rawDbHandle, 'synthetic-test-secret')
      const thread = await state.createThread('test')
      const run = store.create({
        threadId: thread.id,
        profileId: 'test',
        model: 'test:model',
        timeoutMs: 60_000,
        startSeq: 0,
      }, 100)
      store.markRunning(run.runId, 110)
      expect(store.get(run.runId)?.consequence).toBe('none_observed')

      store.advanceConsequence(run.runId, 'output_observed', 111)
      store.advanceConsequence(run.runId, 'effect_possible', 112)
      store.advanceConsequence(run.runId, 'output_observed', 113)
      expect(store.get(run.runId)).toMatchObject({
        consequence: 'effect_possible',
        updatedAt: 112,
      })

      const approval = store.recordPermissionRequest({
        runId: run.runId,
        requestId: 'cancel_race',
        toolName: 'write_file',
        toolInput: { path: 'a' },
        policyRevision: 'e'.repeat(64),
        agentId: null,
      }, 114)
      expect(store.decidePermission(
        run.runId,
        approval.requestId,
        approval.operationHash,
        'approve',
        115,
      )).toBe('decided')

      expect(store.requestCancel(run.runId, 120)).toBe('requested')
      expect(store.get(run.runId)).toMatchObject({
        status: 'cancel_requested',
        cancelRequestedAt: 120,
        terminal: false,
      })
      expect(store.getPermissionRequest(run.runId, approval.requestId)?.status).toBe('expired')
      expect(store.consumePermissionApproval({
        runId: run.runId,
        requestId: approval.requestId,
        toolName: 'write_file',
        toolInput: { path: 'a' },
        policyRevision: 'e'.repeat(64),
        agentId: null,
      })).toBe('not_approved')
      expect(store.requestCancel(run.runId, 130)).toBe('already_requested')
      expect(store.get(run.runId)?.cancelRequestedAt).toBe(120)

      store.markTerminal(run.runId, 'cancelled', {
        endSeq: 4,
        consequence: 'effect_confirmed',
        now: 140,
      })
      expect(store.requestCancel(run.runId, 150)).toBe('terminal')
      expect(store.get(run.runId)).toMatchObject({
        status: 'cancelled',
        consequence: 'effect_confirmed',
        terminalAt: 140,
      })
      expect(store.requestCancel('00000000-0000-4000-8000-000000000000')).toBe('missing')

      const interrupted = store.create({
        threadId: thread.id,
        profileId: 'test',
        model: 'test:model',
        timeoutMs: 60_000,
        startSeq: 4,
      }, 160)
      store.markRunning(interrupted.runId, 161)
      store.advanceConsequence(interrupted.runId, 'effect_possible', 162)
      expect(store.recoverInterrupted(170)).toBe(1)
      expect(store.get(interrupted.runId)).toMatchObject({
        status: 'indeterminate',
        consequence: 'effect_possible',
        outcomeKnown: false,
        code: 'gateway_restarted',
      })
    } finally {
      state.close()
    }
  })
})

describe('profile deployment acceptance fence', () => {
  it('atomically rejects a paused profile and reports only its real active runs', async () => {
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
      const firstThread = await state.createThread('test')
      const first = runs.create({
        threadId: firstThread.id, profileId: 'test', candidateId,
        model: 'test:model', timeoutMs: 60_000, startSeq: 0,
      })
      runs.markRunning(first.runId)
      expect(runs.countActiveForProfile('test')).toBe(1)

      candidates.compareAndSetRouting({
        profileId: 'test', expectedRevision: 1, routingState: 'paused',
      })
      expect(candidates.compareAndSetUndeployed({
        profileId: 'test',
        expectedActiveCandidateId: candidateId,
        expectedDeploymentRevision: 2,
      })).toMatchObject({
        status: 'active_runs',
        activeCandidateId: candidateId,
        deploymentRevision: 2,
        activeRunCount: 1,
      })
      const blockedThread = await state.createThread('test')
      expect(() => runs.create({
        threadId: blockedThread.id, profileId: 'test', candidateId,
        model: 'test:model', timeoutMs: 60_000, startSeq: 0,
      })).toThrow(ProfileRunNotAcceptingError)
      expect(runs.countActiveForProfile('test')).toBe(1)

      runs.markTerminal(first.runId, 'succeeded', {
        endSeq: 0,
        consequence: 'none_observed',
      })
      expect(runs.countActiveForProfile('test')).toBe(0)
      expect(candidates.compareAndSetUndeployed({
        profileId: 'test',
        expectedActiveCandidateId: candidateId,
        expectedDeploymentRevision: 2,
      })).toMatchObject({
        status: 'undeployed',
        activeCandidateId: null,
        deploymentRevision: 3,
      })
      const undeployedThread = await state.createThread('test')
      expect(() => runs.create({
        threadId: undeployedThread.id,
        profileId: 'test',
        candidateId,
        model: 'test:model',
        timeoutMs: 60_000,
        startSeq: 0,
      })).toThrow(expect.objectContaining({
        routingState: 'undeployed',
        deploymentRevision: 3,
      }))
    } finally {
      state.close()
    }
  })
})
