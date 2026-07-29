import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type {
  CodexInbound,
  CodexNotification,
  CodexServerRequest,
} from '../../../../src/runtime/codex/app-server-client.js'
import {
  CodexOfficialRuntimeDriver,
  CodexOfficialRuntimeDriverError,
} from '../../../../src/runtime/codex/official-runtime-driver.js'
import type { CodexOfficialRunPlan } from '../../../../src/runtime/codex/official-run-plan.js'
import {
  createCodexThreadReference,
  type CodexThreadReference,
} from '../../../../src/runtime/codex/official-thread.js'
import type { RuntimeDriverEvent } from '../../../../src/runtime/port.js'

const PROMPT = 'Inspect the workspace.'
const ACCOUNT = `hmac-sha256:${'a'.repeat(64)}`

function requestDigest(value: string): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function plan(): CodexOfficialRunPlan {
  return {
    profileReportId: 'profile-report',
    sandboxReportId: 'sandbox-report',
    requestDigest: requestDigest(PROMPT),
    scopedToolNames: [],
    threadStart: {
      cwd: '/tmp/workspace',
      model: 'gpt-5.4',
      developerInstructions: 'Use verified evidence.',
      sandbox: 'workspace-write',
      approvalPolicy: {
        granular: {
          mcp_elicitations: false,
          request_permissions: false,
          rules: false,
          sandbox_approval: true,
          skill_approval: false,
        },
      },
    },
    turnStart: {
      input: [{ type: 'text', text: PROMPT }],
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/tmp/workspace'],
        networkAccess: false,
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
      },
    },
    readScope: 'host_readable',
    networkScope: 'denied',
  }
}

function threadResponse(id = 'remote-thread-1') {
  return {
    thread: {
      id,
      cwd: '/tmp/workspace',
      modelProvider: 'openai',
      turns: [],
    },
    cwd: '/tmp/workspace',
    model: 'gpt-5.4',
    modelProvider: 'openai',
    approvalPolicy: {},
    approvalsReviewer: 'appServer',
    sandbox: {},
  }
}

function turnValue(status: 'inProgress' | 'completed' | 'interrupted' | 'failed') {
  return {
    id: 'remote-turn-1',
    status,
    items: [],
    startedAt: 1_785_067_200,
    completedAt: status === 'inProgress' ? null : 1_785_067_260,
    durationMs: status === 'inProgress' ? null : 60_000,
    error: status === 'failed' ? { message: 'private' } : null,
  }
}

class ScriptedClient {
  readonly requests: Array<{ method: string; params: unknown }> = []
  readonly responses: Array<{ id: string | number; result?: unknown; error?: number }> = []
  readonly interrupts: Array<{ threadId: string; turnId: string }> = []
  readonly inbound: CodexInbound[] = []
  state: 'running' | 'failed' | 'closed' = 'running'
  failureCode: string | null = null
  closeCalls = 0

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params })
    if (method === 'thread/start' || method === 'thread/resume') {
      return threadResponse(
        method === 'thread/resume'
          ? (params as { threadId: string }).threadId
          : undefined,
      )
    }
    if (method === 'turn/start') {
      return { turn: turnValue('inProgress') }
    }
    throw new Error(`unexpected request ${method}`)
  }

  async nextInbound(): Promise<CodexInbound | undefined> {
    const value = this.inbound.shift()
    if (value !== undefined) return value
    await new Promise((resolve) => setImmediate(resolve))
    const afterTask = this.inbound.shift()
    if (afterTask !== undefined) return afterTask
    this.state = 'failed'
    this.failureCode = 'process_exited'
    return undefined
  }

  async respond(id: string | number, result: unknown): Promise<void> {
    this.responses.push({ id, result })
  }

  async respondError(id: string | number, code: number): Promise<void> {
    this.responses.push({ id, error: code })
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.interrupts.push({ threadId, turnId })
    this.inbound.push({
      kind: 'notification',
      message: {
        method: 'turn/completed',
        params: {
          threadId,
          turn: turnValue('interrupted'),
        },
      },
    })
  }

  diagnostics() {
    return {
      state: this.state,
      version: '0.145.0',
      pid: 42,
      stderrBytes: 0,
      failureCode: this.failureCode,
      exitCode: this.state === 'failed' ? 1 : null,
      signal: null,
    }
  }

  async close(): Promise<void> {
    this.closeCalls++
    this.state = 'closed'
  }

  notify(_method: string, _params: unknown): Promise<void> {
    return Promise.resolve()
  }

  nextNotification(_timeout?: number): Promise<CodexNotification | undefined> {
    return Promise.resolve(undefined)
  }

  nextServerRequest(_timeout?: number): Promise<CodexServerRequest | undefined> {
    return Promise.resolve(undefined)
  }
}

function pushNotification(
  client: ScriptedClient,
  method: string,
  params: Record<string, unknown>,
): void {
  client.inbound.push({
    kind: 'notification',
    message: { method, params },
  })
}

function standardSuccess(client: ScriptedClient): void {
  pushNotification(client, 'thread/started', {
    thread: {
      id: 'remote-thread-1',
      cwd: '/tmp/workspace',
      modelProvider: 'openai',
    },
  })
  pushNotification(client, 'turn/started', {
    threadId: 'remote-thread-1',
    turn: turnValue('inProgress'),
  })
  pushNotification(client, 'turn/completed', {
    threadId: 'remote-thread-1',
    turn: turnValue('completed'),
  })
}

async function collect(driver: CodexOfficialRuntimeDriver) {
  const events: RuntimeDriverEvent[] = []
  const stream = driver.start({ prompt: PROMPT })
  let result = await stream.next()
  while (!result.done) {
    events.push(result.value)
    result = await stream.next()
  }
  return { events, completion: result.value }
}

function options(client: ScriptedClient, overrides: Record<string, unknown> = {}) {
  return {
    client,
    localThreadId: 'local-thread-1',
    accountBinding: ACCOUNT,
    modelProvider: 'openai',
    plan: plan(),
    persistReference: vi.fn(async (_reference: CodexThreadReference) => {}),
    now: () => Date.parse('2026-07-26T19:40:00.000Z'),
    pollTimeoutMs: 1,
    ...overrides,
  }
}

describe('Codex official runtime driver', () => {
  it('starts one bound thread/turn, streams canonical events, and persists terminal authority', async () => {
    const client = new ScriptedClient()
    standardSuccess(client)
    const configured = options(client)
    const driver = new CodexOfficialRuntimeDriver(configured)

    const result = await collect(driver)

    expect(result.events.map((event) =>
      event.kind === 'canonical' ? event.event.type : event.sourceType)).toEqual([
      'session.start',
      'turn.start',
      'turn.end',
      'session.end',
    ])
    expect(result.completion).toEqual({
      outcome: 'succeeded',
      authority: 'turn/completed',
    })
    expect(client.requests).toEqual([
      {
        method: 'thread/start',
        params: {
          ...plan().threadStart,
          config: { web_search: 'disabled' },
        },
      },
      {
        method: 'turn/start',
        params: {
          threadId: 'remote-thread-1',
          ...plan().turnStart,
        },
      },
    ])
    const persisted = vi.mocked(configured.persistReference).mock.calls
      .map(([reference]) => reference)
    expect(persisted).toHaveLength(3)
    expect(persisted[0]).toMatchObject({
      remoteThreadId: 'remote-thread-1',
      activeTurn: null,
    })
    expect(persisted[1]).toMatchObject({
      activeTurn: {
        id: 'remote-turn-1',
        consequence: 'none_observed',
      },
    })
    expect(persisted[2]).toMatchObject({
      activeTurn: null,
      recoveryState: 'ready',
      lastTerminalTurn: {
        id: 'remote-turn-1',
        status: 'completed',
        authority: 'turn/completed',
      },
    })
  })

  it('rejects a prompt not represented by the accepted run plan before any RPC', async () => {
    const client = new ScriptedClient()
    const driver = new CodexOfficialRuntimeDriver(options(client))
    const stream = driver.start({ prompt: 'Different prompt' })

    await expect(stream.next()).rejects.toMatchObject({
      code: 'request_plan_mismatch',
    })
    expect(client.requests).toEqual([])
  })

  it('resumes only an exact account/model/plan binding', async () => {
    const client = new ScriptedClient()
    standardSuccess(client)
    const reference = createCodexThreadReference({
      localThreadId: 'local-thread-1',
      remoteThreadId: 'remote-thread-1',
      accountBinding: ACCOUNT,
      model: 'gpt-5.4',
      modelProvider: 'openai',
      profileReportId: 'profile-report',
      sandboxReportId: 'sandbox-report',
      boundAt: '2026-07-26T19:00:00.000Z',
    })
    const configured = options(client, { threadReference: reference })
    await collect(new CodexOfficialRuntimeDriver(configured))
    expect(client.requests[0]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'remote-thread-1' },
    })

    const changed = new ScriptedClient()
    const denied = new CodexOfficialRuntimeDriver(options(changed, {
      threadReference: reference,
      accountBinding: `hmac-sha256:${'b'.repeat(64)}`,
    }))
    await expect(denied.start({ prompt: PROMPT }).next()).rejects.toMatchObject({
      code: 'account_changed',
    })
    expect(changed.requests).toEqual([])
  })

  it('treats interrupt acknowledgement as requested and waits for interrupted turn/completed', async () => {
    const client = new ScriptedClient()
    pushNotification(client, 'turn/started', {
      threadId: 'remote-thread-1',
      turn: turnValue('inProgress'),
    })
    const driver = new CodexOfficialRuntimeDriver(options(client))
    const stream = driver.start({ prompt: PROMPT })

    await expect(stream.next()).resolves.toMatchObject({
      value: { event: { type: 'session.start' } },
    })
    await expect(stream.next()).resolves.toMatchObject({
      value: { event: { type: 'turn.start' } },
    })
    await driver.cancel('user')
    expect(client.interrupts).toEqual([{
      threadId: 'remote-thread-1',
      turnId: 'remote-turn-1',
    }])

    await expect(stream.next()).resolves.toMatchObject({
      value: { event: { type: 'turn.end', stopReason: 'aborted' } },
    })
    await expect(stream.next()).resolves.toMatchObject({
      value: { event: { type: 'session.end', reason: 'aborted' } },
    })
    await expect(stream.next()).resolves.toEqual({
      done: true,
      value: {
        outcome: 'cancelled',
        authority: 'turn/completed',
        reason: 'user',
      },
    })
  })

  it('leaves effectful process death indeterminate and never starts a replacement turn', async () => {
    const client = new ScriptedClient()
    pushNotification(client, 'turn/started', {
      threadId: 'remote-thread-1',
      turn: turnValue('inProgress'),
    })
    pushNotification(client, 'item/started', {
      threadId: 'remote-thread-1',
      turnId: 'remote-turn-1',
      startedAtMs: 1_785_067_201_000,
      item: {
        id: 'command-1',
        type: 'commandExecution',
        command: 'touch result',
        commandActions: [],
        cwd: '/tmp/workspace',
        status: 'inProgress',
      },
    })
    const configured = options(client)
    const result = await collect(new CodexOfficialRuntimeDriver(configured))

    expect(result.completion).toEqual({
      outcome: 'indeterminate',
      authority: 'codex_app_server_process_exited',
    })
    expect(client.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1)
    const last = vi.mocked(configured.persistReference).mock.calls.at(-1)?.[0]
    expect(last).toMatchObject({
      activeTurn: {
        id: 'remote-turn-1',
        consequence: 'effect_possible',
      },
    })
  })

  it('round-trips an exact native approval through canonical permission events', async () => {
    const client = new ScriptedClient()
    pushNotification(client, 'turn/started', {
      threadId: 'remote-thread-1',
      turn: turnValue('inProgress'),
    })
    pushNotification(client, 'item/started', {
      threadId: 'remote-thread-1',
      turnId: 'remote-turn-1',
      startedAtMs: 1_785_067_201_000,
      item: {
        id: 'command-approval',
        type: 'commandExecution',
        command: 'touch result',
        commandActions: [],
        cwd: '/tmp/workspace',
        status: 'inProgress',
      },
    })
    client.inbound.push({
      kind: 'server_request',
      message: {
        id: 'approval-rpc-1',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'remote-thread-1',
          turnId: 'remote-turn-1',
          itemId: 'command-approval',
          startedAtMs: 1_785_067_201_000,
          command: 'touch result',
          cwd: '/tmp/workspace',
          networkApprovalContext: null,
        },
      },
    })
    const driver = new CodexOfficialRuntimeDriver(options(client))
    const stream = driver.start({ prompt: PROMPT })

    await stream.next()
    await stream.next()
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        event: {
          type: 'tool.call.start',
          toolCallId: 'command-approval',
        },
      },
    })
    const permission = await stream.next()
    expect(permission).toMatchObject({
      value: {
        event: {
          type: 'permission.request',
          toolName: 'codex_native_command',
        },
      },
    })
    const requestId = (
      permission.value as Extract<RuntimeDriverEvent, { kind: 'canonical' }>
    ).event.type === 'permission.request'
      ? (
          permission.value as Extract<RuntimeDriverEvent, { kind: 'canonical' }>
        ).event.requestId
      : ''
    await expect(driver.answerPermission({
      requestId,
      decision: 'approve',
    })).resolves.toEqual({ status: 'delivered' })
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        event: {
          type: 'permission.response',
          requestId,
          granted: true,
        },
      },
    })
    await vi.waitFor(() => {
      expect(client.responses).toContainEqual({
        id: 'approval-rpc-1',
        result: { decision: 'accept' },
      })
    })

    pushNotification(client, 'item/completed', {
      threadId: 'remote-thread-1',
      turnId: 'remote-turn-1',
      completedAtMs: 1_785_067_202_000,
      item: {
        id: 'command-approval',
        type: 'commandExecution',
        command: 'touch result',
        commandActions: [],
        cwd: '/tmp/workspace',
        status: 'completed',
        aggregatedOutput: '',
        durationMs: 1_000,
      },
    })
    pushNotification(client, 'turn/completed', {
      threadId: 'remote-thread-1',
      turn: turnValue('completed'),
    })

    await expect(stream.next()).resolves.toMatchObject({
      value: { event: { type: 'tool.call.end', isError: false } },
    })
    await stream.next()
    await stream.next()
    await expect(stream.next()).resolves.toMatchObject({
      done: true,
      value: { outcome: 'succeeded' },
    })
  })

  it('surfaces unknown protocol events without retaining their payload', async () => {
    const client = new ScriptedClient()
    pushNotification(client, 'turn/started', {
      threadId: 'remote-thread-1',
      turn: turnValue('inProgress'),
    })
    pushNotification(client, 'future/event', {
      token: 'private-value',
    })
    const result = await collect(new CodexOfficialRuntimeDriver(options(client)))
    expect(result.events.at(-1)).toMatchObject({
      kind: 'unknown',
      sourceType: 'future/event',
    })
    expect(JSON.stringify(result.events)).not.toContain('private-value')
  })
})

describe('CodexOfficialRuntimeDriverError', () => {
  it('contains only a stable classification', () => {
    const error = new CodexOfficialRuntimeDriverError('thread_response_invalid')
    expect(error.message).toBe(
      'Codex official runtime failed (thread_response_invalid).',
    )
    expect(error).not.toHaveProperty('payload')
  })
})
