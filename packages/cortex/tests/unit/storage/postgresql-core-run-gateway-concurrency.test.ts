import { randomUUID } from 'node:crypto'
import type { LoomEvent } from '@ownware/loom'
import { Client, Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CoreStorageRepositories } from '../../../src/storage/core-repositories.js'
import { EventBus } from '../../../src/gateway/event-bus.js'
import { EventIngestor } from '../../../src/gateway/event-ingestor.js'
import { ProfileRunNotAcceptingError } from '../../../src/gateway/run-store.js'
import { threadPrincipalScopeDigest } from '../../../src/gateway/thread-principal-binding.js'
import { PostgreSqlStorageAdapter } from '../../../src/storage/postgresql-adapter.js'
import { createPostgreSqlCoreRepositories } from '../../../src/storage/postgresql-core-repositories.js'
import { createPostgreSqlCandidateRepository } from '../../../src/storage/postgresql-candidate-repository.js'
import { createPostgreSqlGatewayRepositories } from '../../../src/storage/postgresql-gateway-repositories.js'
import {
  createPostgreSqlIdempotencyRepository,
  createPostgreSqlRunRepository,
} from '../../../src/storage/postgresql-run-repositories.js'
import { createPostgreSqlSecurityTransactionRepositories } from '../../../src/storage/postgresql-security-repositories.js'
import { validateStoragePlan } from '../../../src/storage/config.js'
import type { GatewayRepositories } from '../../../src/storage/gateway-repositories.js'
import type {
  IdempotencyRepository,
  RunRepository,
  SecurityTransactionRepositories,
} from '../../../src/storage/security-repositories.js'
import type { CandidateRepository } from '../../../src/storage/platform-repositories.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = process.env['POSTGRES_TEST_URL'] ?? configuredPostgreSqlTestUrl()
const APP_NAME = 'ownware-sto11-core-concurrency'
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe

interface CountRow {
  readonly count: string
}

async function runTogether<T>(operations: ReadonlyArray<() => Promise<T>>): Promise<T[]> {
  let release!: () => void
  const start = new Promise<void>((resolve) => { release = resolve })
  let ready = 0
  let allReady!: () => void
  const readyPromise = new Promise<void>((resolve) => { allReady = resolve })
  const running = operations.map(async (operation) => {
    ready += 1
    if (ready === operations.length) allReady()
    await start
    return operation()
  })
  await readyPromise
  release()
  return Promise.all(running)
}

describePostgreSql('PostgreSQL core/run/gateway concurrency invariants', () => {
  let database: Awaited<ReturnType<typeof createDisposablePostgreSqlDatabase>>
  let pool: Pool
  let authorityAdapter: PostgreSqlStorageAdapter<object, SecurityTransactionRepositories>
  let backgroundPoolErrors = 0
  let active = false
  let core: CoreStorageRepositories
  let gateway: GatewayRepositories
  let runs: RunRepository
  let idempotency: IdempotencyRepository
  let candidates: CandidateRepository

  beforeAll(async () => {
    database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const plan = validateStoragePlan({
      storage: {
        kind: 'postgresql',
        runtimeConnection: { source: 'provider', resolve: () => database.url },
        tls: { mode: 'disable', allowInsecureLoopback: true },
      },
    }, '/unused.db')
    if (plan.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')

    authorityAdapter = new PostgreSqlStorageAdapter<object, SecurityTransactionRepositories>({
      plan,
      repositories: {
        createRoot: () => ({}),
        createTransaction: createPostgreSqlSecurityTransactionRepositories,
      },
    })
    await authorityAdapter.initialize()

    pool = new Pool({
      connectionString: database.url,
      ssl: false,
      max: 12,
      application_name: APP_NAME,
      statement_timeout: 10_000,
      lock_timeout: 5_000,
    })
    pool.on('error', () => { backgroundPoolErrors += 1 })
    active = true
    const context = {
      pool,
      assertActive() {
        if (!active) throw new Error('PostgreSQL concurrency test context is closed.')
      },
    }
    core = createPostgreSqlCoreRepositories(context)
    gateway = createPostgreSqlGatewayRepositories(context)
    runs = createPostgreSqlRunRepository(context, 'sto11-permission-hash-secret')
    idempotency = createPostgreSqlIdempotencyRepository(context, 'sto11-idempotency-owner')
    candidates = createPostgreSqlCandidateRepository(context)
  }, 30_000)

  afterEach(() => {
    expect(backgroundPoolErrors).toBe(0)
    expect(pool.waitingCount).toBe(0)
    expect(pool.idleCount).toBe(pool.totalCount)
  })

  afterAll(async () => {
    active = false
    await authorityAdapter?.close()
    await pool?.end()
    if (database === undefined) return

    const admin = new Client({ connectionString: database.adminUrl, ssl: false })
    try {
      await admin.connect()
      const deadline = Date.now() + 5_000
      let connections = Number.POSITIVE_INFINITY
      while (Date.now() < deadline) {
        const result = await admin.query<CountRow>(`
          SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1
        `, [database.name])
        connections = Number(result.rows[0]?.count ?? '0')
        if (connections === 0) break
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      if (connections !== 0) {
        throw new Error(`PostgreSQL concurrency suite leaked ${connections} database clients.`)
      }
    } finally {
      await admin.end().catch(() => {})
    }
    await database?.close()
  })

  async function waitForLockWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const result = await pool.query<CountRow>(`
        SELECT count(*)::text AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = $1
          AND wait_event_type = 'Lock'
      `, [APP_NAME])
      if (Number(result.rows[0]?.count ?? '0') >= expected) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`Timed out waiting for ${expected} PostgreSQL row-lock waiters.`)
  }

  async function release(client: PoolClient, committed: boolean): Promise<void> {
    if (!committed) await client.query('ROLLBACK').catch(() => {})
    client.release()
  }

  it('serializes read-full-row updates so disjoint thread and workspace fields cannot be lost', async () => {
    const workspace = await gateway.workspaces.create(
      `/tmp/sto11-workspace-${randomUUID()}`,
      'Before',
    )
    const thread = await core.threads.create('sto11-update-profile', 'Before', workspace.id)

    const threadBlocker = await pool.connect()
    let threadCommitted = false
    try {
      await threadBlocker.query('BEGIN')
      await threadBlocker.query(
        'SELECT id FROM ownware.threads WHERE id = $1 FOR UPDATE',
        [thread.id],
      )
      const updates = [
        core.threads.update(thread.id, { title: 'Concurrent title' }),
        core.threads.update(thread.id, { status: 'completed' }),
      ]
      await waitForLockWaiters(2)
      await threadBlocker.query('COMMIT')
      threadCommitted = true
      await Promise.all(updates)
    } finally {
      await release(threadBlocker, threadCommitted)
    }
    expect(await core.threads.get(thread.id)).toMatchObject({
      title: 'Concurrent title',
      status: 'completed',
    })

    const workspaceBlocker = await pool.connect()
    let workspaceCommitted = false
    try {
      await workspaceBlocker.query('BEGIN')
      await workspaceBlocker.query(
        'SELECT id FROM ownware.workspaces WHERE id = $1 FOR UPDATE',
        [workspace.id],
      )
      const updates = [
        gateway.workspaces.update(workspace.id, { name: 'Concurrent workspace' }),
        gateway.workspaces.update(workspace.id, { pinned: true }),
      ]
      await waitForLockWaiters(2)
      await workspaceBlocker.query('COMMIT')
      workspaceCommitted = true
      await Promise.all(updates)
    } finally {
      await release(workspaceBlocker, workspaceCommitted)
    }
    expect(await gateway.workspaces.get(workspace.id)).toMatchObject({
      name: 'Concurrent workspace',
      pinned: true,
    })
  })

  it('keeps workspace membership, messages and usage aggregates exact under high contention', async () => {
    const workspace = await gateway.workspaces.create(
      `/tmp/sto11-aggregate-${randomUUID()}`,
      'Aggregate',
    )
    const threads = await runTogether(Array.from({ length: 24 }, (_, index) => () =>
      core.threads.create('sto11-aggregate-profile', `Thread ${index}`, workspace.id)))
    const thread = threads[0]!

    const messageWrites = Array.from({ length: 48 }, (_, index) => () =>
      core.messages.add(thread.id, {
        id: `sto11-message-${index}`,
        role: 'user' as const,
        content: `message-${index}`,
        timestamp: `2026-08-02T10:00:${String(index).padStart(2, '0')}.000Z`,
      }))
    const usageWrites = Array.from({ length: 48 }, () => () =>
      core.usage.add({
        threadId: thread.id,
        profileId: 'sto11-aggregate-profile',
        model: 'sto11:model',
        provider: 'sto11',
        inputTokens: 1,
        outputTokens: 2,
        costUsd: 0.01,
      }))
    await runTogether([...messageWrites, ...usageWrites])

    expect(await core.messages.list(thread.id)).toHaveLength(48)
    expect(await core.threads.get(thread.id)).toMatchObject({
      messageCount: 48,
      totalTokens: 144,
    })
    expect((await core.threads.get(thread.id))?.totalCost).toBeCloseTo(0.48, 10)
    expect(await gateway.workspaces.detail(workspace.id)).toMatchObject({
      totalThreads: 24,
      profiles: [{ profileId: 'sto11-aggregate-profile', threadCount: 24 }],
    })
    const usageCount = await pool.query<CountRow>(`
      SELECT count(*)::text AS count FROM ownware.usage_records WHERE thread_id = $1
    `, [thread.id])
    expect(usageCount.rows[0]?.count).toBe('48')
  })

  it('converges a thread delete racing a child insert without an orphan or partial aggregate', async () => {
    const thread = await core.threads.create('sto11-delete-profile')
    const blocker = await pool.connect()
    let committed = false
    let results: PromiseSettledResult<unknown>[] = []
    try {
      await blocker.query('BEGIN')
      await blocker.query(
        'SELECT id FROM ownware.threads WHERE id = $1 FOR UPDATE',
        [thread.id],
      )
      const operations = [
        core.messages.add(thread.id, {
          id: 'sto11-delete-race-message',
          role: 'user',
          content: 'must commit with its aggregate or not exist',
          timestamp: '2026-08-02T10:30:00.000Z',
        }),
        core.threads.delete(thread.id),
      ]
      await waitForLockWaiters(2)
      await blocker.query('COMMIT')
      committed = true
      results = await Promise.allSettled(operations)
    } finally {
      await release(blocker, committed)
    }

    expect(results[1]).toMatchObject({ status: 'fulfilled', value: true })
    expect(await core.threads.get(thread.id)).toBeUndefined()
    expect(await core.messages.list(thread.id)).toEqual([])
    const messageRows = await pool.query<CountRow>(`
      SELECT count(*)::text AS count FROM ownware.messages
      WHERE id = 'sto11-delete-race-message'
    `)
    expect(messageRows.rows[0]?.count).toBe('0')
  })

  it('allocates one contiguous cross-instance event sequence and rolls back post-allocation failure', async () => {
    const thread = await core.threads.create('sto11-events-profile')
    const context = {
      pool,
      assertActive() {
        if (!active) throw new Error('PostgreSQL concurrency test context is closed.')
      },
    }
    const peers = Array.from({ length: 8 }, () => createPostgreSqlCoreRepositories(context))
    const sequences = await runTogether(Array.from({ length: 80 }, (_, ordinal) => () =>
      peers[ordinal % peers.length]!.events.append({
        threadId: thread.id,
        agentId: 'root',
        parentAgentId: null,
        type: 'sto11.event',
        payload: { type: 'sto11.event', ordinal },
      })))
    expect([...sequences].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 80 }, (_, index) => index + 1),
    )
    const durable = await core.events.list({
      threadId: thread.id,
      agentId: 'root',
      limit: 100,
    })
    expect(durable.map((event) => event.seq)).toEqual(
      Array.from({ length: 80 }, (_, index) => index + 1),
    )
    expect(new Set(durable.map((event) =>
      (event.payload as { readonly ordinal: number }).ordinal)).size).toBe(80)

    await pool.query(`
      CREATE FUNCTION ownware.sto11_reject_event() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.type = 'sto11.reject' THEN
          RAISE EXCEPTION USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END
      $$
    `)
    await pool.query(`
      CREATE TRIGGER sto11_reject_event
      BEFORE INSERT ON ownware.agent_events
      FOR EACH ROW EXECUTE FUNCTION ownware.sto11_reject_event()
    `)
    const eventBus = new EventBus()
    const eventIngestor = new EventIngestor(core.events, eventBus)
    const published: Array<{ readonly seq: number; readonly type: string }> = []
    eventBus.subscribe(thread.id, 'root', ({ seq, event }) => {
      published.push({ seq, type: event.type })
    })
    await expect(eventIngestor.ingestParentEvent(thread.id, {
      type: 'sto11.reject',
    } as unknown as LoomEvent)).rejects.toMatchObject({
      name: 'StorageRepositoryError',
      domain: 'events',
      operation: 'append',
    })
    expect(published).toEqual([])
    expect(await core.events.maxSeq(thread.id, 'root')).toBe(80)
    await expect(eventIngestor.ingestParentEvent(thread.id, {
      type: 'sto11.after-rejection',
    } as unknown as LoomEvent)).resolves.toBe(81)
    expect(published).toEqual([{ seq: 81, type: 'sto11.after-rejection' }])
    expect((await core.events.list({
      threadId: thread.id,
      agentId: 'root',
      since: 80,
    })).map(({ seq, type }) => ({ seq, type }))).toEqual([
      { seq: 81, type: 'sto11.after-rejection' },
    ])

    await pool.query(`
      CREATE FUNCTION ownware.sto11_hold_prune_delete() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(20260802, 31);
        RETURN NULL;
      END
      $$
    `)
    await pool.query(`
      CREATE TRIGGER sto11_hold_prune_delete
      BEFORE DELETE ON ownware.agent_events
      FOR EACH STATEMENT EXECUTE FUNCTION ownware.sto11_hold_prune_delete()
    `)
    const pruneBlocker = await pool.connect()
    let pruneAdvisoryHeld = false
    try {
      await pruneBlocker.query('SELECT pg_advisory_lock(20260802, 31)')
      pruneAdvisoryHeld = true
      const prune = core.events.pruneRootStream(thread.id)
      await waitForLockWaiters(1)
      const append = peers[0]!.events.append({
        threadId: thread.id,
        agentId: 'root',
        parentAgentId: null,
        type: 'sto11.prune-race',
        payload: { type: 'sto11.prune-race' },
      })
      await waitForLockWaiters(2)
      await pruneBlocker.query('SELECT pg_advisory_unlock(20260802, 31)')
      pruneAdvisoryHeld = false
      await expect(prune).resolves.toBe(81)
      await expect(append).resolves.toBe(82)
    } finally {
      if (pruneAdvisoryHeld) {
        await pruneBlocker.query('SELECT pg_advisory_unlock(20260802, 31)').catch(() => {})
      }
      pruneBlocker.release()
    }
    expect(await core.events.maxSeq(thread.id, 'root')).toBe(82)
    const retained = await core.events.list({
      threadId: thread.id,
      agentId: 'root',
      limit: 200,
    })
    expect(retained.map((event) => event.seq)).toEqual([82])
    expect(await core.events.append({
      threadId: thread.id,
      agentId: 'root',
      parentAgentId: null,
      type: 'sto11.after-prune',
      payload: { type: 'sto11.after-prune' },
    })).toBe(83)
  })

  it('rolls back delegated thread, workspace membership and binding as one authority unit', async () => {
    const workspace = await gateway.workspaces.create(
      `/tmp/sto11-delegated-${randomUUID()}`,
      'Delegated authority',
    )
    const profileId = 'sto11-delegated-profile'
    const principalKey = 'delegated\0sto11\0subject-a'
    await pool.query(`
      CREATE FUNCTION ownware.sto11_reject_thread_binding() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION USING ERRCODE = '23514';
      END
      $$
    `)
    await pool.query(`
      CREATE TRIGGER sto11_reject_thread_binding
      BEFORE INSERT ON ownware.thread_principal_bindings
      FOR EACH ROW EXECUTE FUNCTION ownware.sto11_reject_thread_binding()
    `)

    await expect(authorityAdapter.transaction(
      { mode: 'write', isolation: 'serializable', retry: 'never' },
      (transaction) => transaction.repositories.threadAuthority.createAndBind(
        profileId,
        workspace.id,
        principalKey,
      ),
    )).rejects.toMatchObject({
      name: 'StorageRepositoryError',
      domain: 'thread_bindings',
      operation: 'create_thread_and_bind',
    })
    const rolledBack = await pool.query<CountRow>(`
      SELECT (
        (SELECT count(*) FROM ownware.threads WHERE profile_id = $1) +
        (SELECT count(*) FROM ownware.workspace_profiles
          WHERE workspace_id = $2 AND profile_id = $1) +
        (SELECT count(*) FROM ownware.thread_principal_bindings)
      )::text AS count
    `, [profileId, workspace.id])
    expect(rolledBack.rows[0]?.count).toBe('0')

    await pool.query(
      'DROP TRIGGER sto11_reject_thread_binding ON ownware.thread_principal_bindings',
    )
    const committed = await authorityAdapter.transaction(
      { mode: 'write', isolation: 'serializable', retry: 'never' },
      (transaction) => transaction.repositories.threadAuthority.createAndBind(
        profileId,
        workspace.id,
        principalKey,
      ),
    )
    const durable = await pool.query<{
      readonly principal_scope_digest: string
      readonly thread_count: string
    }>(`
      SELECT binding.principal_scope_digest,
        workspace_profile.thread_count::text AS thread_count
      FROM ownware.thread_principal_bindings AS binding
      JOIN ownware.workspace_profiles AS workspace_profile
        ON workspace_profile.workspace_id = $2 AND workspace_profile.profile_id = $3
      WHERE binding.thread_id = $1
    `, [committed.id, workspace.id, profileId])
    expect(durable.rows[0]).toEqual({
      principal_scope_digest: threadPrincipalScopeDigest(principalKey),
      thread_count: '1',
    })
  })

  it('gives conditional run transitions and one same-owner idempotency key a single durable result', async () => {
    const cancelThread = await core.threads.create('sto11-run-profile')
    const cancelRun = await runs.create({
      threadId: cancelThread.id,
      profileId: 'sto11-run-profile',
      model: 'sto11:model',
      timeoutMs: 60_000,
      startSeq: 0,
    }, 1_000)
    await runs.markRunning(cancelRun.runId, 1_001)
    const cancelResults = await runTogether(Array.from({ length: 32 }, (_, index) => () =>
      runs.requestCancel(cancelRun.runId, 1_010 + index)))
    expect(cancelResults.filter((result) => result === 'requested')).toHaveLength(1)
    expect(cancelResults.filter((result) => result === 'already_requested')).toHaveLength(31)

    const terminalThread = await core.threads.create('sto11-run-profile')
    const terminalRun = await runs.create({
      threadId: terminalThread.id,
      profileId: 'sto11-run-profile',
      model: 'sto11:model',
      timeoutMs: 60_000,
      startSeq: 0,
    }, 2_000)
    await runs.markRunning(terminalRun.runId, 2_001)
    const terminalContenders = Array.from({ length: 32 }, (_, index) => ({
      status: (index % 2 === 0 ? 'succeeded' : 'failed') as 'succeeded' | 'failed',
      endSeq: 100 + index,
      consequence: (index % 3 === 0
        ? 'effect_possible'
        : 'output_observed') as 'effect_possible' | 'output_observed',
      code: `sto11-terminal-${index}`,
      now: 2_100 + index,
    }))
    await runTogether(terminalContenders.map((contender) => () =>
      runs.markTerminal(terminalRun.runId, contender.status, contender)))
    const terminal = await runs.get(terminalRun.runId)
    const matching = terminalContenders.filter((contender) =>
      contender.status === terminal?.status && contender.endSeq === terminal?.endSeq &&
      contender.code === terminal?.code && contender.now === terminal?.terminalAt &&
      contender.consequence === terminal?.consequence)
    expect(matching).toHaveLength(1)

    const key = randomUUID()
    const input = {
      principalKey: 'owner',
      operation: 'runs.start',
      key,
      input: { profileId: 'sto11-run-profile', prompt: 'same material' },
    }
    const claims = await runTogether(Array.from({ length: 32 }, () => () =>
      idempotency.claim(input, 3_000)))
    expect(claims.filter((claim) => claim.kind === 'claimed')).toHaveLength(1)
    expect(claims.filter((claim) => claim.kind === 'in_progress')).toHaveLength(31)
    const claimed = claims.find((claim) => claim.kind === 'claimed')
    if (claimed?.kind !== 'claimed') throw new Error('No idempotency winner.')
    await idempotency.linkRun(claimed.recordId, cancelRun.runId)
    await idempotency.complete({
      principalKey: input.principalKey,
      operation: input.operation,
      key: input.key,
      statusCode: 200,
      result: {
        runId: cancelRun.runId,
        threadId: cancelThread.id,
        agentId: 'root',
        profileId: 'sto11-run-profile',
        candidateId: null,
        model: 'sto11:model',
        status: 'running',
        timeoutMs: 60_000,
      },
    }, 3_100)
    const replays = await runTogether(Array.from({ length: 16 }, () => () =>
      idempotency.claim(input, 3_101)))
    expect(replays.every((claim) => claim.kind === 'replay')).toBe(true)
    const rows = await pool.query<CountRow>(`
      SELECT count(*)::text AS count FROM ownware.run_idempotency
      WHERE operation = $1 AND idempotency_key = $2
    `, [input.operation, key])
    expect(rows.rows[0]?.count).toBe('1')
  })

  it('holds one deployment revision through run commit and rejects the later paused revision', async () => {
    const profileId = 'sto11-pause-profile'
    const candidateId = `sha256:${'a'.repeat(64)}`
    const nextCandidateId = `sha256:${'b'.repeat(64)}`
    await pool.query(`
      INSERT INTO ownware.profile_candidates (
        candidate_id, profile_id, attempt_id, state, file_count, total_bytes,
        code, created_at, updated_at
      ) VALUES
        ($1, $3, NULL, 'ready', 1, 1, NULL, 4_000, 4_000),
        ($2, $3, NULL, 'ready', 1, 1, NULL, 4_000, 4_000)
    `, [candidateId, nextCandidateId, profileId])
    await pool.query(`
      INSERT INTO ownware.profile_candidate_activations (
        profile_id, candidate_id, deployment_revision, routing_state,
        health, health_observed_at, updated_at
      ) VALUES ($1, $2, 1, 'active', 'healthy', 4_000, 4_000)
    `, [profileId, candidateId])
    await pool.query(`
      CREATE FUNCTION ownware.sto11_hold_run_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.profile_id = 'sto11-pause-profile' THEN
          PERFORM pg_advisory_xact_lock(20260802, 11);
        END IF;
        RETURN NEW;
      END
      $$
    `)
    await pool.query(`
      CREATE TRIGGER sto11_hold_run_insert
      BEFORE INSERT ON ownware.gateway_runs
      FOR EACH ROW EXECUTE FUNCTION ownware.sto11_hold_run_insert()
    `)

    const thread = await core.threads.create(profileId)
    const blocker = await pool.connect()
    let advisoryHeld = false
    try {
      await blocker.query('SELECT pg_advisory_lock(20260802, 11)')
      advisoryHeld = true
      const create = runs.create({
        threadId: thread.id,
        profileId,
        candidateId,
        model: 'sto11:model',
        timeoutMs: 60_000,
        startSeq: 0,
      }, 4_010)
      await waitForLockWaiters(1)
      const activate = pool.query(`
        UPDATE ownware.profile_candidate_activations
        SET candidate_id = $2, deployment_revision = 2, updated_at = 4_020
        WHERE profile_id = $1
      `, [profileId, nextCandidateId])
      await waitForLockWaiters(2)
      await blocker.query('SELECT pg_advisory_unlock(20260802, 11)')
      advisoryHeld = false
      const [accepted] = await Promise.all([create, activate])
      expect(accepted).toMatchObject({
        profileId,
        candidateId,
        status: 'accepted',
      })
    } finally {
      if (advisoryHeld) {
        await blocker.query('SELECT pg_advisory_unlock(20260802, 11)').catch(() => {})
      }
      blocker.release()
    }

    await expect(pool.query(`
      SELECT candidate_id, deployment_revision::text AS deployment_revision
      FROM ownware.profile_candidate_activations WHERE profile_id = $1
    `, [profileId])).resolves.toMatchObject({
      rows: [{ candidate_id: nextCandidateId, deployment_revision: '2' }],
    })
    await pool.query(`
      UPDATE ownware.profile_candidate_activations
      SET routing_state = 'paused', deployment_revision = 3, updated_at = 4_025
      WHERE profile_id = $1
    `, [profileId])
    const laterThread = await core.threads.create(profileId)
    const rejection = await runs.create({
      threadId: laterThread.id,
      profileId,
      candidateId: nextCandidateId,
      model: 'sto11:model',
      timeoutMs: 60_000,
      startSeq: 0,
    }, 4_030).catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(ProfileRunNotAcceptingError)
    expect(rejection).toMatchObject({
      profileId,
      deploymentRevision: 3,
      routingState: 'paused',
    })
  })

  it('serializes run acceptance before pause and refuses undeploy until that run drains', async () => {
    const profileId = 'sto11-undeploy-profile'
    const candidateId = `sha256:${'c'.repeat(64)}`
    await candidates.begin({
      candidateId,
      profileId,
      attemptId: 'sto11-undeploy-attempt',
      fileCount: 1,
      totalBytes: 1,
    }, 5_000)
    await candidates.markReady(candidateId, 'sto11-undeploy-attempt', 5_001)
    await expect(candidates.compareAndSetActive({
      profileId,
      candidateId,
      expectedActiveCandidateId: null,
    }, 5_002)).resolves.toMatchObject({ status: 'activated', deploymentRevision: 1 })

    await pool.query(`
      CREATE FUNCTION ownware.sto11_hold_undeploy_run_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.profile_id = 'sto11-undeploy-profile' THEN
          PERFORM pg_advisory_xact_lock(20260812, 86);
        END IF;
        RETURN NEW;
      END
      $$
    `)
    await pool.query(`
      CREATE TRIGGER sto11_hold_undeploy_run_insert
      BEFORE INSERT ON ownware.gateway_runs
      FOR EACH ROW EXECUTE FUNCTION ownware.sto11_hold_undeploy_run_insert()
    `)

    const thread = await core.threads.create(profileId)
    const blocker = await pool.connect()
    let advisoryHeld = false
    try {
      await blocker.query('SELECT pg_advisory_lock(20260812, 86)')
      advisoryHeld = true
      const create = runs.create({
        threadId: thread.id,
        profileId,
        candidateId,
        model: 'sto11:model',
        timeoutMs: 60_000,
        startSeq: 0,
      }, 5_010)
      await waitForLockWaiters(1)
      const pause = candidates.compareAndSetRouting({
        profileId,
        expectedRevision: 1,
        routingState: 'paused',
      }, 5_020)
      await waitForLockWaiters(2)
      await blocker.query('SELECT pg_advisory_unlock(20260812, 86)')
      advisoryHeld = false
      const [accepted, paused] = await Promise.all([create, pause])
      expect(accepted).toMatchObject({ profileId, candidateId, status: 'accepted' })
      expect(paused).toMatchObject({ status: 'changed', deploymentRevision: 2 })

      await expect(candidates.compareAndSetUndeployed({
        profileId,
        expectedActiveCandidateId: candidateId,
        expectedDeploymentRevision: 2,
      }, 5_030)).resolves.toMatchObject({
        status: 'active_runs', deploymentRevision: 2, activeRunCount: 1,
      })
      await runs.markTerminal(accepted.runId, 'succeeded', {
        endSeq: 0,
        consequence: 'none_observed',
        now: 5_040,
      })
      await expect(candidates.compareAndSetUndeployed({
        profileId,
        expectedActiveCandidateId: candidateId,
        expectedDeploymentRevision: 2,
      }, 5_050)).resolves.toMatchObject({
        status: 'undeployed', activeCandidateId: null, deploymentRevision: 3,
      })
      const laterThread = await core.threads.create(profileId)
      await expect(runs.create({
        threadId: laterThread.id,
        profileId,
        candidateId,
        model: 'sto11:model',
        timeoutMs: 60_000,
        startSeq: 0,
      }, 5_060)).rejects.toMatchObject({
        profileId, deploymentRevision: 3, routingState: 'undeployed',
      })
    } finally {
      if (advisoryHeld) {
        await blocker.query('SELECT pg_advisory_unlock(20260812, 86)').catch(() => {})
      }
      blocker.release()
    }
  })

  it('keeps settings singular and audit appends complete under high contention', async () => {
    const settings = Array.from({ length: 64 }, (_, index) => `value-${index}`)
    await runTogether(settings.map((value) => () => gateway.settings.set('sto11-setting', value)))
    const setting = await gateway.settings.get('sto11-setting')
    expect(settings).toContain(setting?.value)
    const settingRows = await pool.query<CountRow>(`
      SELECT count(*)::text AS count FROM ownware.user_settings WHERE key = 'sto11-setting'
    `)
    expect(settingRows.rows[0]?.count).toBe('1')

    const auditEntries = await runTogether(Array.from({ length: 64 }, (_, index) => () =>
      gateway.auditLog.add({
        action: 'sto11.concurrent',
        entityType: 'concurrency-test',
        entityId: `entity-${index}`,
        detail: `detail-${index}`,
      })))
    expect(new Set(auditEntries.map((entry) => entry.id)).size).toBe(64)
    const auditRows = await pool.query<CountRow>(`
      SELECT count(*)::text AS count FROM ownware.audit_log
      WHERE action = 'sto11.concurrent'
    `)
    expect(auditRows.rows[0]?.count).toBe('64')
  })
})
