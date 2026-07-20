import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HumanInTheLoop, type LoomEvent, type Session } from '@ownware/loom'
import { createTestGateway, type TestGateway } from '../harness/gateway.js'
import type { DelegatedPrincipal } from '../../../src/gateway/auth/scoped-principal.js'
import { principalContinuityKey } from '../../../src/gateway/idempotency.js'
import { ThreadPrincipalBindingStore } from '../../../src/gateway/thread-principal-binding.js'

class PermissionFlowSession {
  readonly sessionId = 'permission-flow'
  private abortReason: 'user' | 'timeout' | 'system' | undefined

  constructor(private readonly hitl: HumanInTheLoop) {}

  async *submitMessage(): AsyncGenerator<LoomEvent, unknown> {
    yield { type: 'turn.start', turnIndex: 0, timestamp: Date.now() }
    yield {
      type: 'permission.request',
      turnIndex: 0,
      requestId: 'permission_reconnect',
      toolName: 'send_email',
      input: { body: 'PRIVATE_RECONNECT_CANARY' },
      reason: 'Sending needs approval',
    }
    const granted = await this.hitl.requestApproval({
      id: 'permission_reconnect',
      name: 'send_email',
      input: { body: 'PRIVATE_RECONNECT_CANARY' },
    })
    if (this.abortReason) throw new Error(this.abortReason)
    yield {
      type: 'permission.response',
      turnIndex: 0,
      requestId: 'permission_reconnect',
      granted,
    }
    yield { type: 'text.delta', turnIndex: 0, text: granted ? 'Approved.' : 'Denied.' }
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

  abort(reason: 'user' | 'timeout' | 'system' = 'user'): void {
    this.abortReason = reason
    this.hitl.denyAll()
  }
}

class SseFrames {
  private buffered = ''
  readonly seen: Array<Record<string, unknown>> = []

  constructor(readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async until(predicate: (event: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      let boundary = this.buffered.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = this.buffered.slice(0, boundary)
        this.buffered = this.buffered.slice(boundary + 2)
        const data = frame.split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data !== '') {
          const event = JSON.parse(data) as Record<string, unknown>
          this.seen.push(event)
          if (predicate(event)) return event
        }
        boundary = this.buffered.indexOf('\n\n')
      }

      const remaining = deadline - Date.now()
      const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('SSE event deadline exceeded')),
          remaining,
        )
        void this.reader.read().then(
          (result) => {
            clearTimeout(timeout)
            resolve(result)
          },
          (error: unknown) => {
            clearTimeout(timeout)
            reject(error)
          },
        )
      })
      if (chunk.done) throw new Error('SSE closed before the expected event')
      this.buffered += new TextDecoder().decode(chunk.value)
    }
    throw new Error('SSE event deadline exceeded')
  }
}

describe('Contract: reconnect through an exact permission pause', () => {
  let gateway: TestGateway

  beforeEach(async () => {
    gateway = await createTestGateway({ disableAuth: false })
  })

  afterEach(async () => {
    await gateway.stop()
  })

  it('drops, resumes from the cursor, approves exactly, and reaches a truthful terminal snapshot', async () => {
    const workspace = gateway.state.createWorkspace(gateway.tmpDir, 'Reconnect permission contract')
    const thread = gateway.state.createThread('mini', 'reconnect permission', workspace.id)
    const hitl = new HumanInTheLoop({ timeoutMs: 10_000 })
    hitl.onApprovalNeeded(() => { /* exact HTTP decision */ })
    const session = new PermissionFlowSession(hitl)
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

    const delegation = await fetch(`${gateway.baseUrl}/api/v1/auth/delegations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        delegateId: 'synthetic-reconnector',
        workspaceId: workspace.id,
        profileId: 'mini',
        purpose: 'reconnect-permission-contract',
        operations: ['runs.events', 'runs.resume', 'runs.snapshot'],
      }),
    })
    const issued = await delegation.json() as { token: string; principal: DelegatedPrincipal }
    const token = issued.token
    expect(new ThreadPrincipalBindingStore(gateway.state.rawDbHandle).bind(
      thread.id,
      principalContinuityKey(issued.principal),
    )).toBe(true)
    const handle = gateway.runner.start({
      runId: run.runId,
      threadId: thread.id,
      profileId: 'mini',
      model: 'test:model',
      prompt: 'synthetic reconnect flow',
    })

    const firstResponse = await fetch(`${gateway.baseUrl}/api/v1/runs/${run.runId}/events`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(firstResponse.status).toBe(200)
    const first = new SseFrames(firstResponse.body!.getReader())
    const permission = await first.until((event) => event['type'] === 'permission.request')
    expect(permission).toMatchObject({
      type: 'permission.request',
      requestId: 'permission_reconnect',
      toolName: 'send_email',
    })
    expect(permission['operationHash']).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(permission)).not.toContain('PRIVATE_RECONNECT_CANARY')
    await first.reader.cancel() // simulated network/tab drop

    const cursor = permission['seq'] as number
    const reconnectResponse = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${run.runId}/events?since=${cursor}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    expect(reconnectResponse.status).toBe(200)
    const reconnect = new SseFrames(reconnectResponse.body!.getReader())

    const decision = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${run.runId}/permissions/permission_reconnect/decision`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          decision: 'approve',
          operationHash: permission['operationHash'],
        }),
      },
    )
    expect(decision.status).toBe(200)

    const terminal = await reconnect.until((event) => event['type'] === 'turn.end')
    expect(terminal['seq']).toBeGreaterThan(cursor)
    expect(reconnect.seen.some((event) => event['type'] === 'permission.request')).toBe(false)
    await reconnect.reader.cancel()
    await handle.done

    const snapshot = await fetch(`${gateway.baseUrl}/api/v1/runs/${run.runId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(snapshot.status).toBe(200)
    await expect(snapshot.json()).resolves.toMatchObject({
      runId: run.runId,
      status: 'succeeded',
      terminal: true,
      outcomeKnown: true,
    })
  }, 10_000)
})
