import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HumanInTheLoop, type LoomEvent, type Session } from '@ownware/loom'
import { createTestGateway, type TestGateway } from '../harness/gateway.js'

describe('Contract: exact run permission decisions', () => {
  let gateway: TestGateway

  beforeEach(async () => {
    gateway = await createTestGateway({ disableAuth: false })
  })

  afterEach(async () => {
    await gateway.stop()
  })

  it('decides only the matching run, request and operation hash once', async () => {
    const workspace = gateway.state.createWorkspace(gateway.tmpDir, 'Exact permission contract')
    const thread = gateway.state.createThread('mini', 'exact permission', workspace.id)
    const run = gateway.gateway.runStore.create({
      threadId: thread.id,
      workspaceId: workspace.id,
      profileId: 'mini',
      model: 'test:model',
      timeoutMs: 60_000,
      startSeq: 0,
    })
    gateway.gateway.runStore.markRunning(run.runId)
    gateway.gateway.runStore.markWaiting(run.runId)

    const hitl = new HumanInTheLoop({ timeoutMs: 10_000 })
    hitl.onApprovalNeeded(() => { /* decision arrives through HTTP */ })
    const firstDecision = hitl.requestApproval(
      { id: 'permission_1', name: 'send_email', input: { body: 'private body' } },
      'Sending needs approval',
    )
    const secondDecision = hitl.requestApproval(
      { id: 'permission_2', name: 'delete_file', input: { path: '/tmp/example' } },
      'Deleting needs approval',
    )
    gateway.state.setRuntime(thread.id, {
      session: {} as Session,
      hitl,
      zoneManager: null,
    })
    const first = gateway.gateway.runStore.recordPermissionRequest({
      runId: run.runId,
      requestId: 'permission_1',
      toolName: 'send_email',
      toolInput: { body: 'private body' },
    })
    const second = gateway.gateway.runStore.recordPermissionRequest({
      runId: run.runId,
      requestId: 'permission_2',
      toolName: 'delete_file',
      toolInput: { path: '/tmp/example' },
    })
    gateway.state.eventIngestor.ingestParentEvent(thread.id, {
      type: 'permission.request',
      turnIndex: 0,
      requestId: first.requestId,
      toolName: first.toolName,
      input: { body: 'PUBLIC_PERMISSION_RAW_INPUT_CANARY' },
      reason: 'Sending needs approval',
      operationHash: first.operationHash,
    } as unknown as LoomEvent)

    const delegation = await fetch(`${gateway.baseUrl}/api/v1/auth/delegations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        delegateId: 'synthetic-channel',
        workspaceId: workspace.id,
        profileId: 'mini',
        purpose: 'exact-permission-contract',
        operations: ['runs.events', 'runs.resume'],
      }),
    })
    expect(delegation.status).toBe(201)
    const delegatedToken = (await delegation.json() as { token: string }).token

    const publicEvents = await fetch(`${gateway.baseUrl}/api/v1/runs/${run.runId}/events`, {
      headers: { authorization: `Bearer ${delegatedToken}` },
    })
    expect(publicEvents.status).toBe(200)
    const reader = publicEvents.body!.getReader()
    let eventText = ''
    for (let i = 0; i < 10 && !eventText.includes('permission.request'); i++) {
      const chunk = await reader.read()
      if (chunk.done) break
      eventText += new TextDecoder().decode(chunk.value)
    }
    await reader.cancel()
    expect(eventText).toContain(first.operationHash)
    expect(eventText).not.toContain('PUBLIC_PERMISSION_RAW_INPUT_CANARY')
    expect(eventText).not.toContain('"input"')

    const decide = (
      requestId: string,
      operationHash: string,
      decision: 'approve' | 'deny',
      targetRunId = run.runId,
    ) =>
      fetch(`${gateway.baseUrl}/api/v1/runs/${targetRunId}/permissions/${requestId}/decision`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${delegatedToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operationHash, decision }),
      })

    const otherRun = gateway.gateway.runStore.create({
      threadId: thread.id,
      workspaceId: workspace.id,
      profileId: 'mini',
      model: 'test:model',
      timeoutMs: 60_000,
      startSeq: 0,
    })
    const wrongRun = await decide(first.requestId, first.operationHash, 'approve', otherRun.runId)
    expect(wrongRun.status).toBe(404)
    await expect(wrongRun.json()).resolves.toMatchObject({ error: 'permission_request_not_found' })
    expect(hitl.hasPending(first.requestId)).toBe(true)

    const otherWorkspace = gateway.state.createWorkspace(`${gateway.tmpDir}/other`, 'Other scope')
    const otherThread = gateway.state.createThread('mini', 'wrong scope', otherWorkspace.id)
    const wrongScopeRun = gateway.gateway.runStore.create({
      threadId: otherThread.id,
      workspaceId: otherWorkspace.id,
      profileId: 'mini',
      model: 'test:model',
      timeoutMs: 60_000,
      startSeq: 0,
    })
    gateway.gateway.runStore.recordPermissionRequest({
      runId: wrongScopeRun.runId,
      requestId: 'permission_wrong_scope',
      toolName: 'send_email',
      toolInput: { body: 'synthetic' },
    })
    const wrongScope = await decide(
      'permission_wrong_scope',
      gateway.gateway.runStore.getPermissionRequest(
        wrongScopeRun.runId,
        'permission_wrong_scope',
      )!.operationHash,
      'approve',
      wrongScopeRun.runId,
    )
    expect(wrongScope.status).toBe(403)
    await expect(wrongScope.json()).resolves.toMatchObject({ error: 'principal_scope_denied' })

    const approved = await decide(first.requestId, first.operationHash, 'approve')
    expect(approved.status).toBe(200)
    await expect(firstDecision).resolves.toBe(true)
    expect(hitl.hasPending(second.requestId)).toBe(true)
    expect(gateway.gateway.runStore.get(run.runId)?.status).toBe('waiting')

    const duplicate = await decide(first.requestId, first.operationHash, 'deny')
    expect(duplicate.status).toBe(409)
    await expect(duplicate.json()).resolves.toMatchObject({ error: 'permission_already_decided' })

    const wrongHash = await decide(second.requestId, first.operationHash, 'deny')
    expect(wrongHash.status).toBe(409)
    await expect(wrongHash.json()).resolves.toMatchObject({ error: 'permission_operation_mismatch' })
    expect(hitl.hasPending(second.requestId)).toBe(true)

    const denied = await decide(second.requestId, second.operationHash, 'deny')
    expect(denied.status).toBe(200)
    await expect(secondDecision).resolves.toBe(false)
    expect(gateway.gateway.runStore.get(run.runId)?.status).toBe('running')
  })
})
