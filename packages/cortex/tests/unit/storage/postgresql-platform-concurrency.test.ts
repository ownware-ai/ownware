import { describe, expect, it } from 'vitest'
import { MemoryEventBus } from '../../../src/memory/event-bus.js'
import type { CoreStorageRepositories } from '../../../src/storage/core-repositories.js'
import { validateStoragePlan, type ValidatedPostgreSqlPlan } from '../../../src/storage/config.js'
import { PostgreSqlStorageAdapter } from '../../../src/storage/postgresql-adapter.js'
import { createPostgreSqlCoreRepositories } from '../../../src/storage/postgresql-core-repositories.js'
import type { PostgreSqlPool } from '../../../src/storage/postgresql-driver.js'
import { createPostgreSqlPlatformRepositories } from '../../../src/storage/postgresql-platform-repositories.js'
import type { PlatformRepositories } from '../../../src/storage/platform-repositories.js'
import { TaskEventBus } from '../../../src/tasks/event-bus.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = process.env['POSTGRES_TEST_URL'] ?? configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe
const PROFILE_ID = 'platform-concurrency'

interface Root {
  readonly core: CoreStorageRepositories
  readonly platform: PlatformRepositories
}

interface OpenAdapter {
  readonly adapter: PostgreSqlStorageAdapter<Root, object>
  readonly poolMetrics: () => { readonly total: number; readonly idle: number; readonly waiting: number }
}

function plan(url: string): ValidatedPostgreSqlPlan {
  const value = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => url },
      tls: { mode: 'disable', allowInsecureLoopback: true },
      pool: { maxConnections: 16 },
    },
  }, '/unused.db')
  if (value.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
  return value
}

async function openAdapter(storagePlan: ValidatedPostgreSqlPlan): Promise<OpenAdapter> {
  let pool: PostgreSqlPool | undefined
  const adapter = new PostgreSqlStorageAdapter<Root, object>({
    plan: storagePlan,
    repositories: {
      createRoot: (context) => {
        pool = context.pool
        return {
          core: createPostgreSqlCoreRepositories(context),
          platform: createPostgreSqlPlatformRepositories(context, {
            taskEvents: new TaskEventBus(),
            memoryEvents: new MemoryEventBus(),
          }),
        }
      },
      createTransaction: () => ({}),
    },
  })
  await adapter.initialize()
  return {
    adapter,
    poolMetrics: () => {
      if (pool === undefined) throw new Error('PostgreSQL pool unavailable.')
      return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
    },
  }
}

function assertPoolReleased(open: OpenAdapter): void {
  const metrics = open.poolMetrics()
  expect(metrics.waiting).toBe(0)
  expect(metrics.total - metrics.idle).toBe(0)
}

async function withAdapters(
  run: (primary: OpenAdapter, peer: OpenAdapter) => Promise<void>,
): Promise<void> {
  const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
  const storagePlan = plan(database.url)
  const primary = await openAdapter(storagePlan)
  const peer = await openAdapter(storagePlan)
  try {
    await run(primary, peer)
    assertPoolReleased(primary)
    assertPoolReleased(peer)
  } finally {
    await primary.adapter.close()
    await peer.adapter.close()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await database.close()
  }
}

describePostgreSql('PostgreSQL platform concurrency authority', () => {
  it('deduplicates connector setup and fences two channel workers for 200 claim rounds', async () => {
    await withAdapters(async (primary, peer) => {
      const repositories = [
        primary.adapter.repositories.platform,
        peer.adapter.repositories.platform,
      ]
      const connectionContenders = await Promise.all(Array.from({ length: 24 }, (_, index) =>
        repositories[index % 2]!.connectorConnections.upsertPending({
          connectionId: `platform-connection-${index}`,
          connectorId: 'gmail',
          source: 'composio',
          entityId: 'platform-concurrency-owner',
        }),
      ))
      expect(new Set(connectionContenders.map((item) => item.connectionId)).size).toBe(1)
      expect(await repositories[0]!.connectorConnections.listInventory(
        'platform-concurrency-owner',
        { limit: 100 },
      )).toMatchObject({ items: [{ status: 'pending' }] })

      const enqueueContenders = await Promise.allSettled(Array.from({ length: 24 }, (_, index) =>
        repositories[index % 2]!.channelJobs.enqueue({
          profileId: PROFILE_ID,
          operation: 'deduplicated_enqueue',
          channelKind: 'chat',
          params: { contender: index },
          stepCount: 1,
        }, 900),
      ))
      const enqueued = enqueueContenders.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      )
      expect(enqueued).toHaveLength(1)
      expect(enqueueContenders.filter((result) => result.status === 'rejected')).toHaveLength(23)
      const deduplicatedClaim = await repositories[0]!.channelJobs.claimNext('dedupe-worker', 901)
      expect(deduplicatedClaim?.jobId).toBe(enqueued[0]!.jobId)
      expect(await repositories[0]!.channelJobs.advanceCheckpoint(
        enqueued[0]!.jobId, deduplicatedClaim!.claimToken, 0, {}, 902,
      )).toBe('advanced')
      expect(await repositories[0]!.channelJobs.finish(
        enqueued[0]!.jobId, deduplicatedClaim!.claimToken, 'succeeded', 'complete', 903,
      )).toBe('finished')

      for (let round = 0; round < 200; round += 1) {
        const job = await repositories[round % 2]!.channelJobs.enqueue({
          profileId: PROFILE_ID,
          operation: `claim_${round}`,
          channelKind: 'chat',
          params: { round },
          stepCount: 1,
        }, 1_000 + round * 10)
        const claims = await Promise.all([
          repositories[round % 2]!.channelJobs.claimNext(`worker-a-${round}`, 2_000 + round * 10),
          repositories[(round + 1) % 2]!.channelJobs.claimNext(`worker-b-${round}`, 2_000 + round * 10),
        ])
        const live = claims.filter((claim) => claim !== null)
        expect(live).toHaveLength(1)
        const claim = live[0]!
        expect(claim.jobId).toBe(job.jobId)

        if (round === 0) {
          const checkpointRace = await Promise.all([
            repositories[0]!.channelJobs.advanceCheckpoint(
              job.jobId, claim.claimToken, 0, { winner: 'a' }, 2_001,
            ),
            repositories[1]!.channelJobs.advanceCheckpoint(
              job.jobId, claim.claimToken, 0, { winner: 'b' }, 2_001,
            ),
          ])
          expect(checkpointRace.sort()).toEqual(['advanced', 'checkpoint_conflict'])
          const workLines = await Promise.all(Array.from({ length: 16 }, (_, index) =>
            repositories[index % 2]!.channelJobs.appendWorkLine(
              job.jobId, claim.claimToken, `line-${index}`, undefined, 2_002,
            ),
          ))
          expect(workLines.every((result) => result === 'ok')).toBe(true)
          expect((await repositories[0]!.channelJobs.workLines(job.jobId)).map((line) => line.seq))
            .toEqual(Array.from({ length: 16 }, (_, index) => index + 1))
        } else {
          expect(await repositories[round % 2]!.channelJobs.advanceCheckpoint(
            job.jobId, claim.claimToken, 0, { round }, 2_001 + round * 10,
          )).toBe('advanced')
        }
        expect(await repositories[(round + 1) % 2]!.channelJobs.finish(
          job.jobId, claim.claimToken, 'succeeded', 'complete', 2_003 + round * 10,
        )).toBe('finished')
      }

      const expiring = await repositories[0]!.channelJobs.enqueue({
        profileId: PROFILE_ID,
        operation: 'stale_claim',
        channelKind: 'chat',
        params: {},
        stepCount: 1,
      }, 10_000)
      const oldClaim = await repositories[0]!.channelJobs.claimNext('old-worker', 10_001)
      expect(oldClaim?.jobId).toBe(expiring.jobId)
      expect(await repositories[1]!.channelJobs.recoverExpiredClaims(oldClaim!.leaseExpiresAt + 1))
        .toEqual({ requeued: 1, failed: 0, cancelled: 0 })
      expect(await repositories[0]!.channelJobs.advanceCheckpoint(
        expiring.jobId, oldClaim!.claimToken, 0, {}, oldClaim!.leaseExpiresAt + 2,
      )).toBe('stale_claim')
      const successor = await repositories[1]!.channelJobs.claimNext(
        'successor', oldClaim!.leaseExpiresAt + 2,
      )
      expect(successor).toMatchObject({ jobId: expiring.jobId, attempt: 1 })
    })
  }, 120_000)

  it('keeps schedule/run tuples atomic and serializes approvals and whole task-list replacement', async () => {
    await withAdapters(async (primary, peer) => {
      const core = primary.adapter.repositories.core
      const platforms = [
        primary.adapter.repositories.platform,
        peer.adapter.repositories.platform,
      ]
      const thread = await core.threads.create(PROFILE_ID)
      const schedule = await platforms[0]!.schedules.create({
        profileId: PROFILE_ID,
        name: 'Concurrency schedule',
        prompt: 'Prove one durable transaction tuple.',
        cadenceKind: 'daily',
        cadenceExpr: '{"time":"09:00"}',
        cadenceDisplay: 'Every day at 9:00 AM',
        timezone: 'UTC',
        nextRunAt: 100,
      })
      const advances = [
        { scheduledFor: 100, nextRunAt: 200, lastRunAt: 100 },
        { scheduledFor: 101, nextRunAt: 300, lastRunAt: 101 },
      ] as const
      const runs = await Promise.all(advances.map((advance, index) =>
        platforms[index]!.schedules.recordRunAndAdvance({
          scheduleId: schedule.id,
          run: {
            scheduleId: schedule.id,
            threadId: thread.id,
            scheduledFor: advance.scheduledFor,
            startedAt: advance.scheduledFor,
            runStatus: 'running',
          },
          advance: { nextRunAt: advance.nextRunAt, lastRunAt: advance.lastRunAt },
        }),
      ))
      const durableSchedule = await platforms[0]!.schedules.get(schedule.id)
      const winnerIndex = runs.findIndex((run) => run.id === durableSchedule?.lastRunId)
      expect(winnerIndex).toBeGreaterThanOrEqual(0)
      expect(durableSchedule).toMatchObject({
        nextRunAt: advances[winnerIndex]!.nextRunAt,
        lastRunAt: advances[winnerIndex]!.lastRunAt,
        lastRunId: runs[winnerIndex]!.id,
      })
      expect(await platforms[0]!.schedules.listRuns(schedule.id)).toHaveLength(2)

      const runCount = (await platforms[0]!.schedules.listRecentRuns()).length
      await expect(platforms[1]!.schedules.recordRunAndAdvance({
        scheduleId: 'missing-schedule',
        run: {
          scheduleId: 'missing-schedule',
          threadId: thread.id,
          scheduledFor: 102,
          startedAt: 102,
          runStatus: 'running',
        },
        advance: { nextRunAt: 400, lastRunAt: 102 },
      })).rejects.toThrow()
      expect(await platforms[0]!.schedules.listRecentRuns()).toHaveLength(runCount)
      await expect(platforms[1]!.schedules.recordRun({
        scheduleId: schedule.id,
        threadId: thread.id,
        scheduledFor: 103,
        startedAt: 103,
        runStatus: 'running',
      })).resolves.toMatchObject({ scheduleId: schedule.id })

      const approval = await platforms[0]!.approvals.create({
        scheduleId: schedule.id,
        runId: runs[0]!.id,
        threadId: thread.id,
        toolName: 'send_message',
        toolInput: { draft: true },
        summary: 'Hold the draft',
        policyRevision: 'a'.repeat(64),
        toolRevision: 'b'.repeat(64),
        targetRevision: null,
      })
      const claims = await Promise.all(Array.from({ length: 24 }, (_, index) =>
        platforms[index % 2]!.approvals.claim(approval.id),
      ))
      expect(claims.filter((claim) => claim.status === 'claimed')).toHaveLength(1)
      const decisions = await Promise.all(Array.from({ length: 24 }, (_, index) =>
        platforms[index % 2]!.approvals.decide(approval.id, {
          status: 'approved', result: { contender: index },
        }),
      ))
      const durableApproval = await platforms[0]!.approvals.get(approval.id)
      expect(durableApproval?.status).not.toBe('pending')
      expect(decisions.every((decision) => decision?.status === durableApproval?.status)).toBe(true)
      expect(decisions.every((decision) =>
        JSON.stringify(decision?.result) === JSON.stringify(durableApproval?.result),
      )).toBe(true)

      const replacementA = [
        { content: 'A-1', status: 'pending' as const },
        { content: 'A-2', status: 'in_progress' as const },
      ]
      const replacementB = [
        { content: 'B-1', status: 'completed' as const },
        { content: 'B-2', status: 'pending' as const },
        { content: 'B-3', status: 'pending' as const },
      ]
      await expect(Promise.all([
        platforms[0]!.tasks.replaceAllForThread(thread.id, replacementA),
        platforms[1]!.tasks.replaceAllForThread(thread.id, replacementB),
      ])).resolves.toHaveLength(2)
      const durableTasks = await platforms[0]!.tasks.listForThread(thread.id)
      expect([
        replacementA.map((item) => item.content),
        replacementB.map((item) => item.content),
      ]).toContainEqual(durableTasks.map((item) => item.content))
      expect(durableTasks.map((item) => item.order))
        .toEqual(Array.from({ length: durableTasks.length }, (_, index) => index))
    })
  }, 60_000)

  it('gives one candidate CAS winner and preserves team sequences, leases, snapshots, and memory lineage', async () => {
    await withAdapters(async (primary, peer) => {
      const core = primary.adapter.repositories.core
      const platforms = [
        primary.adapter.repositories.platform,
        peer.adapter.repositories.platform,
      ]
      const candidateId = `sha256:${'d'.repeat(64)}`
      await platforms[0]!.candidates.begin({
        candidateId,
        profileId: PROFILE_ID,
        attemptId: 'candidate-attempt',
        fileCount: 2,
        totalBytes: 64,
      }, 100)
      await platforms[0]!.candidates.markReady(candidateId, 'candidate-attempt', 101)
      const activations = await Promise.all(Array.from({ length: 24 }, (_, index) =>
        platforms[index % 2]!.candidates.compareAndSetActive({
          profileId: PROFILE_ID,
          candidateId,
          expectedActiveCandidateId: null,
        }, 102),
      ))
      expect(activations.filter((result) => result.status === 'activated')).toHaveLength(1)
      expect(activations.filter((result) => result.status === 'conflict')).toHaveLength(23)
      const active = await platforms[0]!.candidates.getActive(PROFILE_ID, 103)
      const routing = await Promise.all(Array.from({ length: 24 }, (_, index) =>
        platforms[index % 2]!.candidates.compareAndSetRouting({
          profileId: PROFILE_ID,
          expectedRevision: active!.deploymentRevision,
          routingState: 'paused',
        }, 104),
      ))
      expect(routing.filter((result) => result.status === 'changed')).toHaveLength(1)
      expect(routing.filter((result) => result.status === 'conflict')).toHaveLength(23)

      const deletionCandidateId = `sha256:${'e'.repeat(64)}`
      await platforms[0]!.candidates.begin({
        candidateId: deletionCandidateId,
        profileId: PROFILE_ID,
        attemptId: 'deletion-attempt',
        fileCount: 1,
        totalBytes: 16,
      }, 105)
      await platforms[0]!.candidates.markReady(
        deletionCandidateId, 'deletion-attempt', 106,
      )
      const deletionClaims = await Promise.all(Array.from({ length: 24 }, (_, index) =>
        platforms[index % 2]!.candidates.beginDeletion({
          profileId: PROFILE_ID,
          candidateId: deletionCandidateId,
        }, 107),
      ))
      expect(deletionClaims.filter((result) => result.status === 'started')).toHaveLength(1)
      expect(deletionClaims.filter((result) => result.status === 'in_progress')).toHaveLength(23)

      const team = await platforms[0]!.teams.createTeam({
        name: 'platform-concurrency-team',
        displayName: 'Platform Concurrency Team',
        charter: 'Preserve complete snapshots.',
        conductorName: 'Juno',
        members: [{ slug: 'seed', profileId: 'seed-profile', role: 'Seed' }],
      })
      const snapshots = [
        {
          displayName: 'Snapshot A',
          members: [{ slug: 'alpha', profileId: 'alpha-profile', role: 'Alpha' }],
          references: [{ name: 'A', content: 'Reference A' }],
          composioToolkits: ['gmail'],
        },
        {
          displayName: 'Snapshot B',
          members: [{ slug: 'beta', profileId: 'beta-profile', role: 'Beta' }],
          references: [{ name: 'B', content: 'Reference B' }],
          composioToolkits: ['slack'],
        },
      ] as const
      await expect(Promise.all(snapshots.map((snapshot, index) =>
        platforms[index]!.teams.updateTeam(team.id, snapshot),
      ))).resolves.toHaveLength(2)
      const durableTeam = await platforms[0]!.teams.getTeam(team.id)
      const teamShape = durableTeam === null ? null : {
        displayName: durableTeam.displayName,
        member: durableTeam.members[0]?.slug,
        reference: durableTeam.references[0]?.name,
        toolkit: durableTeam.composioToolkits[0],
      }
      expect([
        { displayName: 'Snapshot A', member: 'alpha', reference: 'A', toolkit: 'gmail' },
        { displayName: 'Snapshot B', member: 'beta', reference: 'B', toolkit: 'slack' },
      ]).toContainEqual(teamShape)

      const thread = await core.threads.create(PROFILE_ID)
      const run = await platforms[0]!.teams.createRun(team.id, thread.id, null)
      const tasks = await Promise.all(Array.from({ length: 32 }, (_, index) =>
        platforms[index % 2]!.teams.insertTask(run.id, {
          kind: 'work',
          title: `Task ${index}`,
          brief: `Brief ${index}`,
          filedBy: 'conductor',
        }),
      ))
      expect(tasks.map((task) => task.seq).sort((a, b) => a - b))
        .toEqual(Array.from({ length: 32 }, (_, index) => index + 1))
      const leases = await Promise.all(tasks.map((task, index) =>
        platforms[index % 2]!.teams.acquireLease({
          runId: run.id,
          resourceKey: 'shared/platform-resource',
          taskId: task.id,
          agentId: `agent-${index}`,
        }),
      ))
      expect(leases.filter((lease) => lease.acquired)).toHaveLength(1)
      expect(await platforms[0]!.teams.listLeases(run.id)).toHaveLength(1)
      expect(await platforms[0]!.teams.setTaskStatus(tasks[0]!.id, 'active'))
        .toMatchObject({ status: 'active' })
      expect(await platforms[0]!.teams.acquireLease({
        runId: run.id,
        resourceKey: 'task-status-resource',
        taskId: tasks[0]!.id,
        agentId: 'task-status-owner',
      })).toEqual({ acquired: true })
      const statusRace = await Promise.allSettled([
        platforms[0]!.teams.setTaskStatus(tasks[0]!.id, 'done'),
        platforms[1]!.teams.setTaskStatus(tasks[0]!.id, 'failed', 'contender failed'),
      ])
      expect(statusRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(statusRace.filter((result) => result.status === 'rejected')).toHaveLength(1)
      expect(await platforms[0]!.teams.getTask(tasks[0]!.id)).toMatchObject({
        status: expect.stringMatching(/^(done|failed)$/),
      })
      expect((await platforms[0]!.teams.listLeases(run.id))
        .some((lease) => lease.resourceKey === 'task-status-resource')).toBe(false)

      const originalMemory = await platforms[0]!.memories.create({
        profileId: PROFILE_ID,
        content: 'One memory may have one authoritative replacement.',
        source: 'user_pinned',
      })
      await Promise.all(Array.from({ length: 24 }, (_, index) =>
        platforms[index % 2]!.memories.recordReferences([originalMemory.id]),
      ))
      expect(await platforms[0]!.memories.getById(originalMemory.id)).toMatchObject({
        referenceCount: 24,
      })
      const supersessions = await Promise.allSettled(Array.from({ length: 16 }, (_, index) =>
        platforms[index % 2]!.memories.supersede(originalMemory.id, {
          profileId: PROFILE_ID,
          content: `Replacement contender ${index}`,
          source: 'reflection',
        }),
      ))
      const replacementWinners = supersessions.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      )
      expect(replacementWinners).toHaveLength(1)
      expect(supersessions.filter((result) => result.status === 'rejected')).toHaveLength(15)
      expect(await platforms[0]!.memories.getById(originalMemory.id)).toMatchObject({
        status: 'superseded',
        supersededBy: replacementWinners[0]!.id,
      })
      expect((await platforms[0]!.memories.listForProfile(PROFILE_ID, { status: 'all' }))
        .filter((memory) => memory.content.startsWith('Replacement contender'))).toHaveLength(1)

      const proposal = await platforms[0]!.memoryProposals.propose({
        profileId: PROFILE_ID,
        threadId: thread.id,
        content: 'Keep one authoritative proposal lineage.',
        kind: 'preference',
      })
      const acceptances = await Promise.allSettled(Array.from({ length: 16 }, (_, index) =>
        platforms[index % 2]!.memoryProposals.accept(proposal.id, {
          content: `Accepted contender ${index}`,
        }),
      ))
      const accepted = acceptances.flatMap((result) =>
        result.status === 'fulfilled' && result.value !== null ? [result.value] : [],
      )
      expect(accepted).toHaveLength(1)
      expect(acceptances.filter((result) => result.status === 'rejected')).toHaveLength(15)
      expect(await platforms[0]!.memoryProposals.getById(proposal.id)).toMatchObject({
        resolvedMemoryId: accepted[0]!.memory.id,
      })
      expect(await platforms[0]!.memories.getById(accepted[0]!.memory.id)).toMatchObject({
        sourceProposalId: proposal.id,
      })
      await expect(platforms[1]!.memories.create({
        profileId: PROFILE_ID,
        content: 'The pool remains reusable after rollback losers.',
        source: 'user_pinned',
        pinned: true,
      })).resolves.toMatchObject({ status: 'active' })
    })
  }, 60_000)
})
