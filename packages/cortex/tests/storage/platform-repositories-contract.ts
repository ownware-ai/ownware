import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreStorageRepositories } from '../../src/storage/core-repositories.js'
import type { PlatformRepositories } from '../../src/storage/platform-repositories.js'

export interface PlatformRepositoryPeer {
  readonly repositories: PlatformRepositories
  close(): Promise<void>
}

export interface PlatformRepositoryHarness {
  readonly repositories: PlatformRepositories
  readonly core: CoreStorageRepositories
  openPeer(): Promise<PlatformRepositoryPeer>
  reopen(): Promise<void>
  close(): Promise<void>
}

export type PlatformRepositoryHarnessFactory = () => Promise<PlatformRepositoryHarness>

const candidateId = (character: string): string => `sha256:${character.repeat(64)}`

/**
 * Backend-neutral contract for the persistent platform domains moved in
 * STO-07. Every adapter runs these exact state, contention and reopen cases.
 */
export function runPlatformRepositoryContract(
  name: string,
  createHarness: PlatformRepositoryHarnessFactory,
): void {
  describe(`platform storage repository contract — ${name}`, () => {
    let harness: PlatformRepositoryHarness

    beforeEach(async () => {
      harness = await createHarness()
    })

    afterEach(async () => {
      await harness.close()
    })

    it('persists connector completion and gives one channel worker the fenced claim', async () => {
      const peer = await harness.openPeer()
      try {
        const connection = await harness.repositories.connectorConnections.upsertPending({
          connectionId: 'contract-connection',
          connectorId: 'gmail',
          source: 'composio',
          entityId: 'contract-user',
          metadata: {
            sessionHandle: 'connection-session.11111111-1111-4111-8111-111111111111',
          },
        })
        expect(connection.status).toBe('pending')
        const reused = await peer.repositories.connectorConnections.upsertPending({
          connectionId: 'contract-connection-racer',
          connectorId: 'gmail',
          source: 'composio',
          entityId: 'contract-user',
        })
        expect(reused.connectionId).toBe(connection.connectionId)
        expect((await harness.repositories.connectorConnections.markReady({
          connectionId: connection.connectionId,
          vendorAccountId: 'vendor-account-handle',
        })).transitioned).toBe(true)

        const job = await harness.repositories.channelJobs.enqueue({
          profileId: 'platform-contract',
          operation: 'connect_demo',
          channelKind: 'whatsapp',
          params: { phoneNumber: '0400555210' },
          stepCount: 1,
        }, 100)
        const claims = await Promise.all([
          harness.repositories.channelJobs.claimNext('worker-a', 200),
          peer.repositories.channelJobs.claimNext('worker-b', 200),
        ])
        const winners = claims.filter(claim => claim !== null)
        expect(winners).toHaveLength(1)
        const claim = winners[0]!
        expect(await harness.repositories.channelJobs.advanceCheckpoint(
          job.jobId,
          'stale-token',
          0,
          { connected: true },
          210,
        )).toBe('stale_claim')
        expect(await harness.repositories.channelJobs.advanceCheckpoint(
          job.jobId,
          claim.claimToken,
          0,
          { connected: true },
          210,
        )).toBe('advanced')
        expect(await harness.repositories.channelJobs.appendWorkLine(
          job.jobId,
          claim.claimToken,
          'Number connected',
          undefined,
          220,
        )).toBe('ok')
        expect(await harness.repositories.channelJobs.finish(
          job.jobId,
          claim.claimToken,
          'succeeded',
          'procedure_complete',
          230,
        )).toBe('finished')

        await harness.reopen()
        expect(await harness.repositories.connectorConnections.findByConnectionId(
          connection.connectionId,
        )).toMatchObject({
          status: 'ready',
          metadata: null,
          vendorAccountId: 'vendor-account-handle',
        })
        expect(await harness.repositories.channelJobs.get(job.jobId)).toMatchObject({
          state: 'succeeded',
          checkpoint: 1,
          outcomeCode: 'procedure_complete',
        })
        expect(await harness.repositories.channelJobs.workLines(job.jobId)).toEqual([
          { seq: 1, title: 'Number connected', detail: null, createdAt: 220 },
        ])
      } finally {
        await peer.close()
      }
    })

    it('atomically advances schedules and preserves approvals and thread tasks', async () => {
      const thread = await harness.core.threads.create('platform-contract')
      const schedule = await harness.repositories.schedules.create({
        profileId: 'platform-contract',
        name: 'Morning review',
        prompt: 'Review the inbox and hold writes for approval.',
        cadenceKind: 'daily',
        cadenceExpr: '{"time":"09:00"}',
        cadenceDisplay: 'Every day at 9:00 AM',
        timezone: 'UTC',
        nextRunAt: 100,
      })
      const run = await harness.repositories.schedules.recordRunAndAdvance({
        scheduleId: schedule.id,
        run: {
          scheduleId: schedule.id,
          threadId: thread.id,
          scheduledFor: 100,
          startedAt: 100,
          runStatus: 'running',
        },
        advance: { nextRunAt: 200, lastRunAt: 100 },
      })
      const approval = await harness.repositories.approvals.create({
        scheduleId: schedule.id,
        runId: run.id,
        threadId: thread.id,
        toolName: 'gmail_send',
        toolInput: { to: 'customer@example.test', body: 'Draft only' },
        summary: 'Draft email to customer',
      })
      const decided = await harness.repositories.approvals.decide(approval.id, {
        status: 'discarded',
      })
      expect(decided?.status).toBe('discarded')
      expect((await harness.repositories.approvals.decide(approval.id, {
        status: 'approved',
        result: { sent: true },
      }))?.status).toBe('discarded')

      const tasks = await harness.repositories.tasks.replaceAllForThread(thread.id, [
        { content: 'Inspect the draft', status: 'in_progress' },
        { content: 'Record the decision', status: 'pending' },
      ])
      await harness.repositories.tasks.updateStatus(thread.id, tasks[0]!.id, 'completed')

      await harness.reopen()
      expect(await harness.repositories.schedules.get(schedule.id)).toMatchObject({
        nextRunAt: 200,
        lastRunAt: 100,
        lastRunId: run.id,
      })
      expect(await harness.repositories.schedules.getRun(run.id)).toMatchObject({
        threadId: thread.id,
        runStatus: 'running',
      })
      expect(await harness.repositories.approvals.get(approval.id)).toMatchObject({
        status: 'discarded',
        result: null,
      })
      expect(await harness.repositories.tasks.listForThread(thread.id)).toMatchObject([
        { content: 'Inspect the draft', status: 'completed', order: 0 },
        { content: 'Record the decision', status: 'pending', order: 1 },
      ])
    })

    it('persists memory review and identity without collapsing proposal lineage', async () => {
      const pinned = await harness.repositories.memories.create({
        profileId: 'platform-contract',
        content: 'The operator uses Bun, not npm.',
        source: 'user_pinned',
        pinned: true,
      })
      const proposal = await harness.repositories.memoryProposals.propose({
        profileId: 'platform-contract',
        threadId: 'thread-memory-contract',
        content: 'The operator prefers concise status updates.',
        kind: 'preference',
      })
      const accepted = await harness.repositories.memoryProposals.accept(proposal.id, {
        content: 'The operator prefers concise, evidence-backed status updates.',
      })
      expect(accepted?.proposal.status).toBe('edited')
      await harness.repositories.userIdentity.set({
        name: 'Sam',
        role: 'Operator',
        timezone: 'Australia/Sydney',
      })

      await harness.reopen()
      expect(await harness.repositories.memories.getById(pinned.id)).toMatchObject({
        content: 'The operator uses Bun, not npm.',
        pinned: true,
        status: 'active',
      })
      expect(await harness.repositories.memoryProposals.getById(proposal.id)).toMatchObject({
        status: 'edited',
        resolvedMemoryId: accepted?.memory.id,
      })
      expect(await harness.repositories.memories.getById(accepted!.memory.id)).toMatchObject({
        source: 'agent_proposed',
        sourceProposalId: proposal.id,
      })
      expect(await harness.repositories.userIdentity.get()).toMatchObject({
        name: 'Sam',
        role: 'Operator',
        timezone: 'Australia/Sydney',
      })
      expect(await harness.repositories.userIdentity.renderForPrompt()).toContain('## About the user')
    })

    it('serializes candidate activation, team task ordinals and resource leases', async () => {
      const peer = await harness.openPeer()
      try {
        const candidate = candidateId('a')
        expect(await harness.repositories.candidates.begin({
          candidateId: candidate,
          profileId: 'platform-contract',
          attemptId: 'placement-attempt',
          fileCount: 2,
          totalBytes: 64,
        }, 100)).toBe('started')
        await harness.repositories.candidates.markReady(candidate, 'placement-attempt', 110)
        const activations = await Promise.all([
          harness.repositories.candidates.compareAndSetActive({
            profileId: 'platform-contract',
            candidateId: candidate,
            expectedActiveCandidateId: null,
          }, 120),
          peer.repositories.candidates.compareAndSetActive({
            profileId: 'platform-contract',
            candidateId: candidate,
            expectedActiveCandidateId: null,
          }, 120),
        ])
        expect(activations.map(result => result.status).sort()).toEqual(['activated', 'conflict'])
        const active = await harness.repositories.candidates.getActive('platform-contract', 121)
        expect(active?.deploymentRevision).toBe(1)
        await expect(harness.repositories.candidates.compareAndSetRouting({
          profileId: 'platform-contract',
          expectedRevision: 1,
          routingState: 'paused',
        }, 122)).resolves.toMatchObject({ status: 'changed', deploymentRevision: 2 })
        await expect(peer.repositories.candidates.compareAndSetUndeployed({
          profileId: 'platform-contract',
          expectedActiveCandidateId: candidate,
          expectedDeploymentRevision: 2,
        }, 123)).resolves.toMatchObject({
          status: 'undeployed', activeCandidateId: null, deploymentRevision: 3,
        })
        await expect(harness.repositories.candidates.getDeploymentState(
          'platform-contract', 124,
        )).resolves.toMatchObject({
          state: 'undeployed', previousCandidateId: candidate, deploymentRevision: 3,
        })
        await expect(harness.repositories.candidates.compareAndSetActive({
          profileId: 'platform-contract',
          candidateId: candidate,
          expectedActiveCandidateId: null,
        }, 125)).resolves.toMatchObject({ status: 'conflict', deploymentRevision: 3 })
        await expect(harness.repositories.candidates.compareAndSetActive({
          profileId: 'platform-contract',
          candidateId: candidate,
          expectedActiveCandidateId: null,
          expectedDeploymentRevision: 3,
        }, 126)).resolves.toMatchObject({ status: 'activated', deploymentRevision: 4 })

        const team = await harness.repositories.teams.createTeam({
          name: 'platform-contract-team',
          displayName: 'Platform Contract Team',
          charter: 'Prove durable coordination.',
          conductorName: 'Juno',
          members: [
            { slug: 'maya', profileId: 'backend-profile', role: 'Backend' },
            { slug: 'rex', profileId: 'frontend-profile', role: 'Frontend' },
          ],
        })
        const thread = await harness.core.threads.create('platform-contract')
        const teamRun = await harness.repositories.teams.createRun(team.id, thread.id, null)
        const tasks = await Promise.all([
          harness.repositories.teams.insertTask(teamRun.id, {
            kind: 'work', title: 'Backend', brief: 'Build it', filedBy: 'conductor', owner: 'maya',
          }),
          peer.repositories.teams.insertTask(teamRun.id, {
            kind: 'work', title: 'Frontend', brief: 'Use it', filedBy: 'conductor', owner: 'rex',
          }),
        ])
        expect(tasks.map(task => task.seq).sort((a, b) => a - b)).toEqual([1, 2])
        const leases = await Promise.all([
          harness.repositories.teams.acquireLease({
            runId: teamRun.id,
            resourceKey: 'src/shared.ts',
            taskId: tasks[0]!.id,
            agentId: 'maya',
          }),
          peer.repositories.teams.acquireLease({
            runId: teamRun.id,
            resourceKey: 'src/shared.ts',
            taskId: tasks[1]!.id,
            agentId: 'rex',
          }),
        ])
        expect(leases.filter(result => result.acquired)).toHaveLength(1)

        await harness.reopen()
        expect(await harness.repositories.candidates.getActive('platform-contract', 127)).toMatchObject({
          candidateId: candidate,
          deploymentRevision: 4,
        })
        expect((await harness.repositories.teams.listTasks(teamRun.id)).map(task => task.seq))
          .toEqual([1, 2])
        expect(await harness.repositories.teams.listLeases(teamRun.id)).toHaveLength(1)
      } finally {
        await peer.close()
      }
    })
  })
}
