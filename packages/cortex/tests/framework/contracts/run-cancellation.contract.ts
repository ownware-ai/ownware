import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HumanInTheLoop, type LoomEvent, type Session } from '@ownware/loom'
import { createTestGateway, type TestGateway } from '../harness/gateway.js'

class NonAbortAwareSession {
  readonly sessionId = 'non-abort-aware'
  abortCalls = 0
  private releaseRun!: () => void
  private readonly releasePromise = new Promise<void>((resolve) => {
    this.releaseRun = resolve
  })

  async *submitMessage(): AsyncGenerator<LoomEvent, unknown> {
    yield { type: 'turn.start', turnIndex: 0, timestamp: Date.now() }
    await this.releasePromise
    yield {
      type: 'turn.end',
      turnIndex: 0,
      stopReason: 'end_turn',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        model: 'test',
        costUsd: 0,
      },
      timestamp: Date.now(),
    }
  }

  abort(): void { this.abortCalls++ /* deliberately ignores the signal */ }
  release(): void { this.releaseRun() }
}

class AbortAwareSession {
  readonly sessionId = 'abort-aware'
  private rejectWait: ((reason: Error) => void) | undefined
  private aborted: 'user' | 'timeout' | 'system' | undefined

  async *submitMessage(): AsyncGenerator<LoomEvent, unknown> {
    yield { type: 'turn.start', turnIndex: 0, timestamp: Date.now() }
    await new Promise<never>((_resolve, reject) => {
      if (this.aborted) {
        reject(new Error(this.aborted))
        return
      }
      this.rejectWait = reject
    })
  }

  abort(reason: 'user' | 'timeout' | 'system' = 'user'): void {
    this.aborted = reason
    this.rejectWait?.(new Error(reason))
  }
}

describe('Contract: exact run cancellation', () => {
  let gateway: TestGateway
  let stuckSession: NonAbortAwareSession | undefined

  beforeEach(async () => {
    gateway = await createTestGateway({ disableAuth: false })
  })

  afterEach(async () => {
    stuckSession?.release()
    stuckSession = undefined
    await gateway.stop()
  })

  it('persists an idempotent cancel request without watchdog-invented completion', async () => {
    const workspace = gateway.state.createWorkspace(gateway.tmpDir, 'Run cancellation contract')
    const thread = gateway.state.createThread('mini', 'stuck cancellation', workspace.id)
    const session = new NonAbortAwareSession()
    stuckSession = session
    const hitl = new HumanInTheLoop({ timeoutMs: 10_000 })
    gateway.state.setSession(thread.id, session as unknown as Session)
    gateway.state.setRuntime(thread.id, {
      session: session as unknown as Session,
      hitl,
      zoneManager: null,
    })
    const run = gateway.gateway.runStore.create({
      threadId: thread.id,
      workspaceId: workspace.id,
      profileId: 'mini',
      model: 'test:model',
      timeoutMs: 60_000,
      startSeq: 0,
    })
    const handle = gateway.runner.start({
      runId: run.runId,
      threadId: thread.id,
      profileId: 'mini',
      model: 'test:model',
      prompt: 'synthetic cancellation',
    })

    const delegation = await fetch(`${gateway.baseUrl}/api/v1/auth/delegations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        delegateId: 'synthetic-canceller',
        workspaceId: workspace.id,
        profileId: 'mini',
        purpose: 'run-cancellation-contract',
        operations: ['runs.abort'],
      }),
    })
    const delegatedToken = (await delegation.json() as { token: string }).token
    const cancel = (runId = run.runId) => fetch(
      `${gateway.baseUrl}/api/v1/runs/${runId}/cancel`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${delegatedToken}` },
      },
    )

    const first = await cancel()
    expect(first.status).toBe(202)
    await expect(first.json()).resolves.toMatchObject({
      runId: run.runId,
      status: 'cancel_requested',
      cancellation: 'requested',
      terminal: false,
    })
    const firstRequestedAt = gateway.gateway.runStore.get(run.runId)!.cancelRequestedAt

    const duplicate = await cancel()
    expect(duplicate.status).toBe(202)
    await expect(duplicate.json()).resolves.toMatchObject({ cancellation: 'already_requested' })
    expect(gateway.gateway.runStore.get(run.runId)?.cancelRequestedAt).toBe(firstRequestedAt)
    expect(session.abortCalls).toBe(2)

    const wrongRun = gateway.gateway.runStore.create({
      threadId: thread.id,
      workspaceId: workspace.id,
      profileId: 'mini',
      model: 'test:model',
      timeoutMs: 60_000,
      startSeq: 0,
    })
    const wrong = await cancel(wrongRun.runId)
    expect(wrong.status).toBe(409)
    await expect(wrong.json()).resolves.toMatchObject({ error: 'run_not_active' })
    expect(gateway.gateway.runStore.get(wrongRun.runId)?.status).toBe('accepted')

    const otherWorkspace = gateway.state.createWorkspace(`${gateway.tmpDir}/other`, 'Other scope')
    const otherThread = gateway.state.createThread('mini', 'other cancellation', otherWorkspace.id)
    const otherRun = gateway.gateway.runStore.create({
      threadId: otherThread.id,
      workspaceId: otherWorkspace.id,
      profileId: 'mini',
      model: 'test:model',
      timeoutMs: 60_000,
      startSeq: 0,
    })
    const wrongScope = await cancel(otherRun.runId)
    expect(wrongScope.status).toBe(403)
    await expect(wrongScope.json()).resolves.toMatchObject({ error: 'principal_scope_denied' })

    await new Promise((resolve) => setTimeout(resolve, 2_200))
    expect(gateway.gateway.runStore.get(run.runId)).toMatchObject({
      status: 'cancel_requested',
      terminal: false,
    })
    expect(gateway.runner.isRunning(thread.id)).toBe(true)
    expect(gateway.state.getRuntime(thread.id)).toBeDefined()
    expect(gateway.state.getThread(thread.id)?.status).toBe('active')

    session.release()
    await handle.done
    expect(gateway.gateway.runStore.get(run.runId)?.status).toBe('succeeded')

    const afterTerminal = await cancel()
    expect(afterTerminal.status).toBe(200)
    await expect(afterTerminal.json()).resolves.toMatchObject({
      status: 'succeeded',
      terminal: true,
      cancellation: 'already_terminal',
    })
  }, 10_000)

  it('reports cancelled only after an abort-aware loop finalizes', async () => {
    const thread = gateway.state.createThread('mini', 'confirmed cancellation')
    const session = new AbortAwareSession()
    const hitl = new HumanInTheLoop({ timeoutMs: 10_000 })
    gateway.state.setSession(thread.id, session as unknown as Session)
    gateway.state.setRuntime(thread.id, {
      session: session as unknown as Session,
      hitl,
      zoneManager: null,
    })
    const run = gateway.gateway.runStore.create({
      threadId: thread.id,
      profileId: 'mini',
      model: 'test:model',
      timeoutMs: 60_000,
      startSeq: 0,
    })
    const handle = gateway.runner.start({
      runId: run.runId,
      threadId: thread.id,
      profileId: 'mini',
      model: 'test:model',
      prompt: 'synthetic confirmed cancellation',
    })

    const response = await fetch(`${gateway.baseUrl}/api/v1/runs/${run.runId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${gateway.token}` },
    })
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ status: 'cancel_requested' })
    await handle.done
    expect(gateway.gateway.runStore.get(run.runId)).toMatchObject({
      status: 'cancelled',
      terminal: true,
      outcomeKnown: true,
      code: 'run_cancelled',
    })
  })
})
