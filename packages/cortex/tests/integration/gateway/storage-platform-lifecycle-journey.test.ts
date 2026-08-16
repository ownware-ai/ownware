import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import {
  createTestGateway,
  type TestGateway,
} from '../../framework/harness/gateway.js'

interface JsonResponse<T> {
  readonly status: number
  readonly body: T
}

async function request<T>(
  baseUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<JsonResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  })
  return { status: response.status, body: await response.json() as T }
}

describe('remaining platform storage through a real gateway restart', () => {
  let first: TestGateway | undefined
  let restarted: OwnwareGateway | undefined
  let retainedDirectory: string | undefined

  afterEach(async () => {
    await restarted?.stop()
    restarted = undefined
    if (first !== undefined) await first.stop({ cleanup: false })
    first = undefined
    if (retainedDirectory !== undefined) {
      await rm(retainedDirectory, { recursive: true, force: true })
    }
    retainedDirectory = undefined
  })

  it('preserves customer HTTP state and internal fenced authorities across restart', async () => {
    first = await createTestGateway({ disableAuth: false })
    retainedDirectory = first.tmpDir

    const threadResponse = await request<{ id: string }>(
      first.baseUrl,
      first.token,
      '/api/v1/threads',
      {
        method: 'POST',
        body: JSON.stringify({ profileId: 'mini', title: 'Platform lifecycle' }),
      },
    )
    expect(threadResponse.status).toBe(201)
    const threadId = threadResponse.body.id

    const scheduleResponse = await request<{ schedule: { id: string } }>(
      first.baseUrl,
      first.token,
      '/api/v1/schedules',
      {
        method: 'POST',
        body: JSON.stringify({
          profileId: 'mini',
          name: 'Platform lifecycle schedule',
          prompt: 'Review work and hold every external effect.',
          cadenceKind: 'daily',
          cadenceExpr: '{"time":"09:00"}',
          cadenceDisplay: 'Every day at 9:00 AM',
          timezone: 'UTC',
        }),
      },
    )
    expect(scheduleResponse.status).toBe(201)
    const scheduleId = scheduleResponse.body.schedule.id

    const memoryResponse = await request<{ memory: { id: string } }>(
      first.baseUrl,
      first.token,
      '/api/v1/profiles/mini/memories',
      {
        method: 'POST',
        body: JSON.stringify({ content: 'Use Bun for this workspace.', pinned: true }),
      },
    )
    expect(memoryResponse.status).toBe(201)
    const memoryId = memoryResponse.body.memory.id
    expect((await request(
      first.baseUrl,
      first.token,
      '/api/v1/user/identity',
      {
        method: 'PUT',
        body: JSON.stringify({ name: 'Sam', role: 'Operator', timezone: 'Australia/Sydney' }),
      },
    )).status).toBe(200)

    const proposal = await first.state.platformRepositories.memoryProposals.propose({
      profileId: 'mini',
      threadId,
      content: 'Sam prefers short evidence-backed updates.',
      kind: 'preference',
    })
    const accepted = await request<{ proposal: { status: string }; memory: { id: string } }>(
      first.baseUrl,
      first.token,
      `/api/v1/memories/proposals/${proposal.id}/accept`,
      { method: 'POST', body: JSON.stringify({ pinned: true }) },
    )
    expect(accepted).toMatchObject({ status: 200, body: { proposal: { status: 'accepted' } } })

    const teamResponse = await request<{ id: string }>(
      first.baseUrl,
      first.token,
      '/api/v1/teams',
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'platform-lifecycle-team',
          displayName: 'Platform Lifecycle Team',
          charter: 'Coordinate one durable customer task.',
          conductorName: 'Juno',
          members: [{ slug: 'mini-member', profileId: 'mini', role: 'Operator' }],
        }),
      },
    )
    expect(teamResponse.status).toBe(201)
    const teamId = teamResponse.body.id

    const repositories = first.state.platformRepositories
    const nextRunAt = Date.now() + 86_400_000
    const scheduleRun = await repositories.schedules.recordRunAndAdvance({
      scheduleId,
      run: {
        scheduleId,
        threadId,
        scheduledFor: 100,
        startedAt: 100,
        finishedAt: 110,
        runStatus: 'succeeded',
      },
      advance: { nextRunAt, lastRunAt: 100 },
    })
    const approval = await repositories.approvals.create({
      scheduleId,
      runId: scheduleRun.id,
      threadId,
      toolName: 'gmail_send',
      toolInput: { to: 'customer@example.test', body: 'Draft, not sent' },
      summary: 'Draft email awaiting approval',
      policyRevision: 'a'.repeat(64),
      toolRevision: 'b'.repeat(64),
      targetRevision: null,
    })
    const threadTasks = await repositories.tasks.replaceAllForThread(threadId, [
      { content: 'Verify durable state', status: 'in_progress' },
      { content: 'Write the restart receipt', status: 'pending' },
    ])
    await repositories.tasks.updateStatus(threadId, threadTasks[0]!.id, 'completed')

    const teamRun = await repositories.teams.createRun(teamId, threadId, null)
    const teamTask = await repositories.teams.insertTask(teamRun.id, {
      kind: 'work',
      title: 'Verify storage',
      brief: 'Check the durable repository state.',
      filedBy: 'conductor',
      owner: 'mini-member',
    })
    expect(await repositories.teams.acquireLease({
      runId: teamRun.id,
      resourceKey: 'storage/platform',
      taskId: teamTask.id,
      agentId: 'mini-member',
    })).toEqual({ acquired: true })
    await repositories.teams.setRunStatus(teamRun.id, 'cancelled', null)

    await repositories.connectorConnections.upsertPending({
      connectionId: 'platform-lifecycle-connection',
      connectorId: 'gmail',
      source: 'composio',
      entityId: 'cortex-default-user',
    })
    await repositories.connectorConnections.markReady({
      connectionId: 'platform-lifecycle-connection',
      vendorAccountId: 'vendor-account-handle',
    })
    const channelJob = await repositories.channelJobs.enqueue({
      profileId: 'mini',
      operation: 'connect_demo',
      channelKind: 'whatsapp',
      params: { phoneNumber: '0400555210' },
      stepCount: 1,
    }, 100)
    const claim = await repositories.channelJobs.claimNext('platform-worker', 200)
    expect(claim).not.toBeNull()
    await repositories.channelJobs.advanceCheckpoint(
      channelJob.jobId,
      claim!.claimToken,
      0,
      { connected: true },
      210,
    )
    await repositories.channelJobs.finish(
      channelJob.jobId,
      claim!.claimToken,
      'succeeded',
      'procedure_complete',
      220,
    )

    const candidateId = `sha256:${'b'.repeat(64)}`
    await repositories.candidates.begin({
      candidateId,
      profileId: 'mini',
      attemptId: 'platform-lifecycle-attempt',
      fileCount: 1,
      totalBytes: 16,
    }, 100)
    await repositories.candidates.markReady(candidateId, 'platform-lifecycle-attempt', 110)
    expect((await repositories.candidates.compareAndSetActive({
      profileId: 'mini',
      candidateId,
      expectedActiveCandidateId: null,
    }, 120)).status).toBe('activated')

    await first.stop({ cleanup: false })
    first = undefined
    restarted = new OwnwareGateway({
      port: 0,
      profilesDir: join(retainedDirectory, 'profiles'),
      dataDir: join(retainedDirectory, 'data'),
      dbPath: join(retainedDirectory, 'test.db'),
      tls: false,
      disableAuth: false,
    })
    await restarted.start()
    const baseUrl = `http://127.0.0.1:${restarted.port}`

    expect(await request<{ schedule: { id: string; lastRunId: string } }>(
      baseUrl,
      restarted.token,
      `/api/v1/schedules/${scheduleId}`,
    )).toMatchObject({
      status: 200,
      body: { schedule: { id: scheduleId, lastRunId: scheduleRun.id } },
    })
    expect(await request<{ approval: { status: string } }>(
      baseUrl,
      restarted.token,
      `/api/v1/approvals/${approval.id}`,
    )).toMatchObject({ status: 200, body: { approval: { status: 'pending' } } })
    expect(await request<{ approval: { status: string } }>(
      baseUrl,
      restarted.token,
      `/api/v1/approvals/${approval.id}/discard`,
      { method: 'POST' },
    )).toMatchObject({ status: 200, body: { approval: { status: 'discarded' } } })
    const memories = await request<{ items: Array<{ id: string }> }>(
      baseUrl,
      restarted.token,
      '/api/v1/profiles/mini/memories',
    )
    expect(memories.status).toBe(200)
    expect(memories.body.items.map(item => item.id)).toEqual(
      expect.arrayContaining([memoryId, accepted.body.memory.id]),
    )
    expect(await request<{ identity: { name: string; timezone: string } }>(
      baseUrl,
      restarted.token,
      '/api/v1/user/identity',
    )).toMatchObject({
      status: 200,
      body: { identity: { name: 'Sam', timezone: 'Australia/Sydney' } },
    })
    expect(await request<{ id: string }>(
      baseUrl,
      restarted.token,
      `/api/v1/teams/${teamId}`,
    )).toMatchObject({ status: 200, body: { id: teamId } })
    expect(await request<{ run: { id: string; status: string }; tasks: Array<{ id: string }> }>(
      baseUrl,
      restarted.token,
      `/api/v1/threads/${threadId}/team-board`,
    )).toMatchObject({
      status: 200,
      body: {
        run: { id: teamRun.id, status: 'cancelled' },
        tasks: [{ id: teamTask.id }],
      },
    })

    const reopened = restarted.state.platformRepositories
    expect(await reopened.connectorConnections.findByConnectionId(
      'platform-lifecycle-connection',
    )).toMatchObject({ status: 'ready', vendorAccountId: 'vendor-account-handle' })
    expect(await reopened.channelJobs.get(channelJob.jobId)).toMatchObject({
      state: 'succeeded', checkpoint: 1, outcomeCode: 'procedure_complete',
    })
    expect(await reopened.candidates.getActive('mini', 120)).toMatchObject({
      candidateId, deploymentRevision: 1,
    })
    expect(await reopened.tasks.listForThread(threadId)).toMatchObject([
      { content: 'Verify durable state', status: 'completed' },
      { content: 'Write the restart receipt', status: 'pending' },
    ])
    expect(await reopened.teams.listLeases(teamRun.id)).toMatchObject([
      { taskId: teamTask.id, agentId: 'mini-member', resourceKey: 'storage/platform' },
    ])
  }, 30_000)
})
