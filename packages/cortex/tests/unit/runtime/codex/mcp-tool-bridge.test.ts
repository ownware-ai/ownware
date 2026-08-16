import { afterEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import {
  createDefaultConfig,
  defineTool,
  type LoomEvent,
  type Tool,
  type ToolContext,
} from '@ownware/loom'
import {
  CodexMcpBridgeError,
  CodexMcpToolHub,
  type CodexMcpRunHandle,
} from '../../../../src/runtime/codex/mcp-tool-bridge.js'

const hubs: CodexMcpToolHub[] = []

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.close()))
})

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  const config = {
    ...createDefaultConfig('openai:gpt-5.4'),
    sessionId: 'session-1',
    workspacePath: process.cwd(),
  }
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    sessionId: 'session-1',
    rootSessionId: 'session-1',
    agentId: null,
    workspacePath: process.cwd(),
    additionalWorkspaceRoots: [],
    config,
    requestPermission: async () => false,
    requestCredential: async () => null,
    resolveCredential: () => null,
    listEnvCredentials: () => [],
    listAllCredentialValues: () => [],
    ...overrides,
  }
}

function tool(
  name: string,
  execute: Tool['execute'],
  options: {
    readonly readOnly?: boolean
    readonly requiresPermission?: boolean
  } = {},
): Tool {
  return defineTool({
    name,
    description: `Synthetic ${name} tool`,
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      additionalProperties: false,
    },
    isReadOnly: options.readOnly ?? true,
    requiresPermission: options.requiresPermission ?? false,
    execute,
  })
}

async function startHub(): Promise<CodexMcpToolHub> {
  const hub = await CodexMcpToolHub.start()
  hubs.push(hub)
  return hub
}

async function initialize(run: CodexMcpRunHandle): Promise<string> {
  const response = await fetch(run.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${run.bearerToken}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'codex-mcp-client', version: '0.145.0' },
      },
    }),
  })
  expect(response.status).toBe(200)
  const sessionId = response.headers.get('mcp-session-id')
  expect(sessionId).toBeTruthy()
  return sessionId!
}

async function rpc(
  run: CodexMcpRunHandle,
  sessionId: string,
  id: string | number,
  method: string,
  params: unknown = {},
): Promise<{ readonly response: Response; readonly body: any }> {
  const response = await fetch(run.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${run.bearerToken}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  return { response, body: await response.json() }
}

describe('CodexMcpToolHub', () => {
  it('lists only the immutable tools registered for that exact run', async () => {
    const hub = await startHub()
    const first = hub.registerRun({
      runId: 'run-first',
      tools: [
        tool('approved_read', async () => ({ content: 'ok', isError: false })),
      ],
      context: context(),
    })
    const second = hub.registerRun({
      runId: 'run-second',
      tools: [
        tool('different_tool', async () => ({ content: 'ok', isError: false })),
      ],
      context: context(),
    })

    const firstSession = await initialize(first)
    const secondSession = await initialize(second)
    const firstList = await rpc(first, firstSession, 2, 'tools/list')
    const secondList = await rpc(second, secondSession, 2, 'tools/list')

    expect(firstList.body.result.tools.map((item: any) => item.name)).toEqual([
      'approved_read',
    ])
    expect(secondList.body.result.tools.map((item: any) => item.name)).toEqual([
      'different_tool',
    ])
    expect(JSON.stringify(firstList.body)).not.toContain('different_tool')
  })

  it('requires the exact per-run bearer capability and revokes it on close', async () => {
    const hub = await startHub()
    const run = hub.registerRun({
      runId: 'run-auth',
      tools: [],
      context: context(),
    })

    const missing = await fetch(run.endpoint, { method: 'POST', body: '{}' })
    const wrong = await fetch(run.endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
      body: '{}',
    })
    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)

    await run.close()
    const revoked = await fetch(run.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${run.bearerToken}` },
      body: '{}',
    })
    expect(revoked.status).toBe(401)
  })

  it('invokes the handler with exact arguments and records content-free evidence', async () => {
    const execute = vi.fn(async (input: Record<string, unknown>) => ({
      content: `read:${String(input['value'])}`,
      isError: false,
    }))
    const events: LoomEvent[] = []
    const hub = await startHub()
    const run = hub.registerRun({
      runId: 'run-invoke',
      tools: [tool('approved_read', execute)],
      context: context(),
      onEvent: (event) => { events.push(event) },
    })

    const sessionId = await initialize(run)
    const result = await rpc(run, sessionId, 'call-1', 'tools/call', {
      name: 'approved_read',
      arguments: { value: 'evidence' },
    })

    expect(result.body.result).toEqual({
      content: [{ type: 'text', text: 'read:evidence' }],
      isError: false,
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toEqual({ value: 'evidence' })
    expect(events.map((event) => event.type)).toEqual([
      'tool.call.start',
      'tool.call.end',
    ])

    const [receipt] = run.receipts()
    expect(receipt).toMatchObject({
      runId: 'run-invoke',
      toolName: 'approved_read',
      state: 'completed',
      consequence: 'none_observed',
      responseState: 'written',
      executionCount: 1,
    })
    expect(JSON.stringify(receipt)).not.toContain('evidence')
    expect(JSON.stringify(receipt)).not.toContain('read:evidence')

    expect(run.confirmAppServerDelivery({
      toolName: 'approved_read',
      input: { value: 'evidence' },
      status: 'completed',
      authority: 'item/completed',
    })).toEqual({
      status: 'confirmed',
      consequence: 'none_observed',
      receiptState: 'completed',
    })
    expect(run.receipts()[0]).toMatchObject({
      deliveryEvidence: 'app_server_item_completed',
      appServerOutcome: 'completed',
    })
  })

  it('does not guess delivery when two invocations share the same surface input', async () => {
    const hub = await startHub()
    const run = hub.registerRun({
      runId: 'run-ambiguous-delivery',
      tools: [tool('same_input', async () => ({ content: 'ok', isError: false }))],
      context: context(),
    })
    const sessionId = await initialize(run)
    await rpc(run, sessionId, 'first', 'tools/call', {
      name: 'same_input',
      arguments: { value: 'same' },
    })
    await rpc(run, sessionId, 'second', 'tools/call', {
      name: 'same_input',
      arguments: { value: 'same' },
    })

    expect(run.confirmAppServerDelivery({
      toolName: 'same_input',
      input: { value: 'same' },
      status: 'completed',
      authority: 'item/completed',
    })).toEqual({ status: 'ambiguous' })
    expect(run.receipts().every((receipt) =>
      receipt.deliveryEvidence === 'unknown')).toBe(true)
  })

  it('makes a denial visible to the model and the Ownware permission stream', async () => {
    const execute = vi.fn(async () => ({ content: 'must not run', isError: false }))
    const events: LoomEvent[] = []
    const hub = await startHub()
    const run = hub.registerRun({
      runId: 'run-denied',
      tools: [tool('dangerous_write', execute, {
        readOnly: false,
        requiresPermission: true,
      })],
      context: context(),
      checkPermission: async () => ({
        decision: 'ask',
        zoneLevel: 5,
        zoneName: 'machine',
        explanation: 'This action changes the machine.',
        severityTag: 'critical',
      }),
      requestApproval: async () => false,
      onEvent: (event) => { events.push(event) },
    })

    const sessionId = await initialize(run)
    const result = await rpc(run, sessionId, 7, 'tools/call', {
      name: 'dangerous_write',
      arguments: { value: 'x' },
    })

    expect(result.body.result.isError).toBe(true)
    expect(result.body.result.content[0].text).toContain('denied')
    expect(execute).not.toHaveBeenCalled()
    expect(events.map((event) => event.type)).toEqual([
      'tool.call.start',
      'permission.request',
      'permission.response',
      'tool.call.end',
    ])
    expect(events[1]).toMatchObject({
      type: 'permission.request',
      zoneLevel: 5,
      severityTag: 'critical',
    })
    expect(run.receipts()[0]).toMatchObject({
      state: 'denied',
      consequence: 'none_observed',
    })
  })

  it('executes a permission-required tool only after exact final authorization', async () => {
    const execute = vi.fn(async () => ({ content: 'changed', isError: false }))
    const authorizeToolExecution = vi.fn(async () => true)
    const events: LoomEvent[] = []
    const hub = await startHub()
    const run = hub.registerRun({
      runId: 'run-exact-permission',
      tools: [tool('bound_write', execute, {
        readOnly: false,
        requiresPermission: true,
      })],
      context: context(),
      permissionPolicyRevision: 'a'.repeat(64),
      checkPermission: async () => ({
        decision: 'ask',
        policyRevision: 'a'.repeat(64),
      }),
      requestApproval: async () => true,
      authorizeToolExecution,
      onEvent: (event) => { events.push(event) },
    })

    const sessionId = await initialize(run)
    const result = await rpc(run, sessionId, 71, 'tools/call', {
      name: 'bound_write',
      arguments: { value: 'exact' },
    })

    expect(result.body.result.isError).toBe(false)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(authorizeToolExecution).toHaveBeenCalledTimes(1)
    expect(authorizeToolExecution.mock.calls[0]?.[0]).toMatchObject({
      name: 'bound_write',
      input: { value: 'exact' },
    })
    expect(authorizeToolExecution.mock.calls[0]?.[1]).toMatchObject({
      agentId: null,
      approvalRequested: true,
      policyRevision: 'a'.repeat(64),
    })
    expect(events.map((event) => event.type)).toEqual([
      'tool.call.start',
      'permission.request',
      'permission.response',
      'tool.call.end',
    ])
  })

  it('blocks dispatch when the final permission binding is absent or stale', async () => {
    for (const authorizeToolExecution of [undefined, async () => false] as const) {
      const execute = vi.fn(async () => ({ content: 'must not run', isError: false }))
      const events: LoomEvent[] = []
      const hub = await startHub()
      const run = hub.registerRun({
        runId: `run-stale-permission-${authorizeToolExecution === undefined ? 'absent' : 'false'}`,
        tools: [tool('blocked_write', execute, {
          readOnly: false,
          requiresPermission: true,
        })],
        context: context(),
        checkPermission: async () => ({ decision: 'ask' }),
        requestApproval: async () => true,
        ...(authorizeToolExecution === undefined ? {} : { authorizeToolExecution }),
        onEvent: (event) => { events.push(event) },
      })
      const sessionId = await initialize(run)
      const result = await rpc(run, sessionId, 72, 'tools/call', {
        name: 'blocked_write',
        arguments: {},
      })
      expect(result.body.result.isError).toBe(true)
      expect(execute).not.toHaveBeenCalled()
      expect(events.some((event) => event.type === 'security.block')).toBe(true)
      await run.close()
    }
  })

  it('fails closed when the permission observer or approval channel fails', async () => {
    for (const failure of ['observer', 'approval'] as const) {
      const execute = vi.fn(async () => ({ content: 'must not run', isError: false }))
      const hub = await startHub()
      const run = hub.registerRun({
        runId: `run-${failure}`,
        tools: [tool('requires_approval', execute, {
          readOnly: false,
          requiresPermission: true,
        })],
        context: context(),
        checkPermission: async () => ({ decision: 'ask' }),
        requestApproval: async () => {
          if (failure === 'approval') throw new Error('private approval failure')
          return true
        },
        onEvent: (event) => {
          if (failure === 'observer' && event.type === 'permission.request') {
            throw new Error('private observer failure')
          }
        },
      })
      const sessionId = await initialize(run)
      const result = await rpc(run, sessionId, 8, 'tools/call', {
        name: 'requires_approval',
        arguments: {},
      })
      expect(result.body.result.isError).toBe(true)
      expect(JSON.stringify(result.body)).not.toContain('private')
      expect(execute).not.toHaveBeenCalled()
      await run.close()
    }
  })

  it('executes duplicate request ids once and rejects conflicting reuse', async () => {
    let resolveExecution!: () => void
    const gate = new Promise<void>((resolve) => { resolveExecution = resolve })
    const execute = vi.fn(async () => {
      await gate
      return { content: 'one effect', isError: false }
    })
    const hub = await startHub()
    const run = hub.registerRun({
      runId: 'run-idempotency',
      tools: [tool('mutate_once', execute, { readOnly: false })],
      context: context(),
    })
    const sessionId = await initialize(run)
    const first = rpc(run, sessionId, 'same-id', 'tools/call', {
      name: 'mutate_once',
      arguments: { value: 'same' },
    })
    const duplicate = rpc(run, sessionId, 'same-id', 'tools/call', {
      name: 'mutate_once',
      arguments: { value: 'same' },
    })
    resolveExecution()

    expect((await first).body.result.isError).toBe(false)
    expect((await duplicate).body.result.isError).toBe(false)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(run.receipts()[0]).toMatchObject({
      executionCount: 1,
      replayCount: 1,
      consequence: 'effect_possible',
    })

    const conflict = await rpc(run, sessionId, 'same-id', 'tools/call', {
      name: 'mutate_once',
      arguments: { value: 'different' },
    })
    expect(conflict.body.error.code).toBe(-32600)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('never returns credential values and only confirms effects through an authority', async () => {
    const secret = 'synthetic-secret-value'
    const hub = await startHub()
    const run = hub.registerRun({
      runId: 'run-effect',
      tools: [tool('confirmed_write', async () => ({
        content: `saved ${secret}`,
        isError: false,
      }), { readOnly: false })],
      context: context({
        listAllCredentialValues: () => [{
          credentialId: 'credential-1',
          value: secret,
        }],
      }),
      confirmEffect: async () => ({
        consequence: 'effect_confirmed',
        authority: 'synthetic-store/read-after-write',
      }),
    })
    const sessionId = await initialize(run)
    const result = await rpc(run, sessionId, 11, 'tools/call', {
      name: 'confirmed_write',
      arguments: {},
    })

    expect(JSON.stringify(result.body)).not.toContain(secret)
    expect(result.body.result.content[0].text).toContain('[REDACTED]')
    expect(run.receipts()[0]).toMatchObject({
      consequence: 'effect_confirmed',
      effectAuthority: 'synthetic-store/read-after-write',
    })
    expect(JSON.stringify(run.receipts())).not.toContain(secret)
  })

  it('treats an effect-observer failure as possible, never confirmed', async () => {
    const hub = await startHub()
    const run = hub.registerRun({
      runId: 'run-observer-error',
      tools: [tool('mutating_tool', async () => ({
        content: 'handler returned',
        isError: false,
      }), { readOnly: false })],
      context: context(),
      confirmEffect: async () => {
        throw new Error('private observer detail')
      },
    })
    const sessionId = await initialize(run)
    const result = await rpc(run, sessionId, 12, 'tools/call', {
      name: 'mutating_tool',
      arguments: {},
    })

    expect(result.body.result.isError).toBe(true)
    expect(result.body.result.content[0].text).toContain('outcome is uncertain')
    expect(JSON.stringify(result.body)).not.toContain('private')
    expect(run.receipts()[0]).toMatchObject({
      state: 'outcome_unknown',
      consequence: 'effect_possible',
      observerState: 'failed',
    })
  })

  it('returns bounded errors for malformed JSON, arguments, and unknown tools', async () => {
    const hub = await startHub()
    const run = hub.registerRun({
      runId: 'run-errors',
      tools: [tool('known_tool', async () => ({ content: 'ok', isError: false }))],
      context: context(),
    })
    const sessionId = await initialize(run)

    const malformed = await fetch(run.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${run.bearerToken}`,
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
      },
      body: '{',
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({
      error: { code: -32700, message: 'Invalid JSON.' },
    })

    const badArgs = await rpc(run, sessionId, 13, 'tools/call', {
      name: 'known_tool',
      arguments: 'not-an-object',
    })
    expect(badArgs.body.result.isError).toBe(true)

    const unknown = await rpc(run, sessionId, 14, 'tools/call', {
      name: 'private-secret-not-registered',
      arguments: {},
    })
    expect(unknown.body.result.isError).toBe(true)
    expect(unknown.body.result.content[0].text).toContain('not available')
    expect(JSON.stringify(unknown.body)).not.toContain('private-secret')
    expect(run.receipts()).toHaveLength(0)
  })

  it('validates the declared schema before entering a handler', async () => {
    const execute = vi.fn(async () => ({ content: 'must not run', isError: false }))
    const hub = await startHub()
    const requiredTool = defineTool({
      name: 'required_input',
      description: 'Needs one string',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string', enum: ['allowed'] } },
        required: ['value'],
        additionalProperties: false,
      },
      execute,
    })
    const run = hub.registerRun({
      runId: 'run-schema',
      tools: [requiredTool],
      context: context(),
    })
    const sessionId = await initialize(run)

    for (const argumentsValue of [
      {},
      { value: 3 },
      { value: 'other' },
      { value: 'allowed', extra: true },
    ]) {
      const result = await rpc(run, sessionId, JSON.stringify(argumentsValue), 'tools/call', {
        name: 'required_input',
        arguments: argumentsValue,
      })
      expect(result.body.result.isError).toBe(true)
      expect(result.body.result.content[0].text).toContain('schema')
    }
    expect(execute).not.toHaveBeenCalled()
    expect(run.receipts()).toHaveLength(0)
  })

  it('never mistakes a socket write for client delivery when the connection disappears', async () => {
    let entered!: () => void
    let release!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const hub = await startHub()
    const run = hub.registerRun({
      runId: 'run-lost-response',
      tools: [tool('mutate_then_wait', async () => {
        entered()
        await gate
        return { content: 'effect may exist', isError: false }
      }, { readOnly: false })],
      context: context(),
    })
    const sessionId = await initialize(run)
    const requestClosed = new Promise<void>((resolve) => {
      const request = httpRequest(run.endpoint, {
        method: 'POST',
        headers: {
        authorization: `Bearer ${run.bearerToken}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
        },
      }, (response) => response.resume())
      request.on('error', () => resolve())
      request.on('close', () => resolve())
      request.end(JSON.stringify({
        jsonrpc: '2.0',
        id: 88,
        method: 'tools/call',
        params: { name: 'mutate_then_wait', arguments: {} },
      }))
      void enteredPromise.then(() => request.destroy())
    })

    await enteredPromise
    await requestClosed
    release()
    await vi.waitFor(() => {
      expect(run.receipts()[0]).toMatchObject({
        responseState: 'written',
        deliveryEvidence: 'unknown',
        state: 'completed',
        consequence: 'effect_possible',
      })
    })
  })

  it('aborts in-flight handlers and closes active sockets on hub teardown', async () => {
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const execute = vi.fn(async (
      _input: Record<string, unknown>,
      toolContext: ToolContext,
    ) => {
      entered()
      await new Promise<void>((_resolve, reject) => {
        toolContext.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
      return { content: 'unreachable', isError: false }
    })
    const hub = await startHub()
    const run = hub.registerRun({
      runId: 'run-close',
      tools: [tool('long_running_write', execute, { readOnly: false })],
      context: context(),
    })
    const sessionId = await initialize(run)
    const pending = rpc(run, sessionId, 89, 'tools/call', {
      name: 'long_running_write',
      arguments: {},
    }).catch(() => null)
    await enteredPromise

    await hub.close()
    await pending
    expect(execute).toHaveBeenCalledOnce()
    expect(run.receipts()[0]).toMatchObject({
      state: 'outcome_unknown',
      responseState: 'lost',
      consequence: 'effect_possible',
    })
  }, 2_000)

  it('rejects hostile names, duplicate names, and non-object schemas at registration', async () => {
    const hub = await startHub()
    const valid = tool('safe_name', async () => ({ content: 'ok', isError: false }))
    const cyclic: Record<string, unknown> = { type: 'object' }
    cyclic['self'] = cyclic

    expect(() => hub.registerRun({
      runId: 'hostile-name',
      tools: [{ ...valid, name: '../escape' }],
      context: context(),
    })).toThrowError(CodexMcpBridgeError)
    expect(() => hub.registerRun({
      runId: 'duplicate-name',
      tools: [valid, valid],
      context: context(),
    })).toThrowError(CodexMcpBridgeError)
    expect(() => hub.registerRun({
      runId: 'cyclic-schema',
      tools: [{ ...valid, inputSchema: cyclic as any }],
      context: context(),
    })).toThrowError(CodexMcpBridgeError)
  })
})
