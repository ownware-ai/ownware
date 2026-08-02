import {
  registerProvider,
  unregisterProvider,
  type Message,
  type ProviderAdapter,
  type ProviderChunk,
  type ProviderFeature,
  type ProviderRequest,
  type ToolDefinition,
} from '@ownware/loom'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OwnwareGateway, type GatewayOptions } from '../../../src/gateway/server.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const PROVIDER_NAME = 'storagepermissionparity'
const PROFILE_ID = 'test-agent'
const TOOL_NAME = 'gated_action'
const TOOL_CALL_ID = 'storage_permission_call'
const TEST_URL = configuredPostgreSqlTestUrl()
const itPostgreSql = TEST_URL === undefined ? it.skip : it

const GATED_TOOL_SOURCE = `
export const gatedAction = {
  name: '${TOOL_NAME}',
  description: 'Perform the bounded storage permission parity action.',
  isReadOnly: false,
  requiresPermission: true,
  category: 'custom',
  inputSchema: {
    type: 'object',
    properties: {
      value: { type: 'string' },
    },
    required: ['value'],
    additionalProperties: false,
  },
  async execute(input) {
    return {
      content: 'executed:' + String(input.value),
      isError: false,
    }
  },
}
`

type JsonObject = Record<string, unknown>

interface StreamEvent {
  readonly event: string
  readonly data: JsonObject
}

interface JourneyBackend {
  readonly kind: 'sqlite' | 'postgresql'
  readonly storage?: GatewayOptions['storage']
  readonly close: () => Promise<void>
}

interface JourneyEvidence {
  readonly resume: JsonObject
  readonly stream: {
    readonly streamStartCount: number
    readonly replayCompleteCount: number
    readonly durableTimeline: readonly JsonObject[]
  }
  readonly run: JsonObject
  readonly hydrate: JsonObject
  readonly permissionHistory: JsonObject
  readonly restart: {
    readonly run: JsonObject
    readonly hydrate: JsonObject
    readonly permissionHistory: JsonObject
    readonly replayTimeline: readonly JsonObject[]
    readonly duplicateDecision: JsonObject
  }
}

function deterministicProvider(): ProviderAdapter {
  return {
    name: PROVIDER_NAME,
    async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      const hasToolResult = request.messages.some((message) =>
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'tool_result'),
      )

      if (!hasToolResult) {
        const input = { value: 'approved-value' }
        yield { type: 'tool_use_start', id: TOOL_CALL_ID, name: TOOL_NAME }
        yield {
          type: 'tool_use_args_delta',
          id: TOOL_CALL_ID,
          delta: JSON.stringify(input),
        }
        yield { type: 'tool_use_end', id: TOOL_CALL_ID }
        yield {
          type: 'message_complete',
          content: [{ type: 'tool_use', id: TOOL_CALL_ID, name: TOOL_NAME, input }],
          stopReason: 'tool_use',
          usage: {
            inputTokens: 8,
            outputTokens: 4,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        }
        return
      }

      yield { type: 'text_delta', text: 'Permission approved and action completed.' }
      yield {
        type: 'message_complete',
        content: [{ type: 'text', text: 'Permission approved and action completed.' }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 12,
          outputTokens: 6,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      }
    },
    async countTokens(messages: Message[]): Promise<number> {
      return messages.length * 8
    },
    supportsFeature(_feature: ProviderFeature): boolean {
      return true
    },
    formatTools(tools: ToolDefinition[]): unknown[] {
      return tools
    },
    getModelPricing() {
      return {
        inputPer1M: 1,
        outputPer1M: 1,
        cacheReadPer1M: 0,
        cacheWritePer1M: 0,
      }
    },
  }
}

async function createBackend(kind: JourneyBackend['kind']): Promise<JourneyBackend> {
  if (kind === 'sqlite') return { kind, close: async () => {} }
  const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
  return {
    kind,
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => database.url },
      tls: { mode: 'disable', allowInsecureLoopback: true },
    },
    close: database.close,
  }
}

class LiveSse {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder()
  private buffer = ''
  readonly seen: StreamEvent[] = []

  constructor(response: Response) {
    if (response.body === null) throw new Error('SSE response had no body')
    this.reader = response.body.getReader()
  }

  async until(
    predicate: (event: StreamEvent, all: readonly StreamEvent[]) => boolean,
    timeoutMs = 10_000,
  ): Promise<StreamEvent> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      let boundary = this.buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = this.buffer.slice(0, boundary)
        this.buffer = this.buffer.slice(boundary + 2)
        const parsed = parseFrame(frame)
        if (parsed !== null) {
          this.seen.push(parsed)
          if (predicate(parsed, this.seen)) return parsed
        }
        boundary = this.buffer.indexOf('\n\n')
      }

      const remaining = deadline - Date.now()
      const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(
            `Timed out waiting for SSE event after ${this.seen.map(({ event }) => event).join(', ')}`,
          )),
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
      this.buffer += this.decoder.decode(chunk.value, { stream: true })
    }
    throw new Error(
      `Timed out waiting for SSE event after ${this.seen.map(({ event }) => event).join(', ')}`,
    )
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => {})
  }
}

function parseFrame(frame: string): StreamEvent | null {
  if (frame.trim() === '' || frame.startsWith(':')) return null
  let event = 'message'
  let data = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7)
    if (line.startsWith('data: ')) data += line.slice(6)
  }
  return data === '' ? null : { event, data: JSON.parse(data) as JsonObject }
}

function parseSse(raw: string): StreamEvent[] {
  return raw.split('\n\n')
    .map(parseFrame)
    .filter((event): event is StreamEvent => event !== null)
}

async function fetchJson(
  gateway: OwnwareGateway,
  path: string,
  init?: RequestInit,
): Promise<{ readonly status: number; readonly body: JsonObject }> {
  const response = await fetch(`http://127.0.0.1:${gateway.port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${gateway.token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  return { status: response.status, body: await response.json() as JsonObject }
}

function eventIndex(events: readonly StreamEvent[], type: string): number {
  return events.findIndex(({ event }) => event === type)
}

function assertOrderedPermissionStream(
  events: readonly StreamEvent[],
  options: { readonly requireZoneMetadata?: boolean } = {},
): void {
  expect(events.filter(({ event }) => event === 'stream.start')).toHaveLength(1)
  expect(events.filter(({ event }) => event === 'stream.replay.complete')).toHaveLength(1)

  const durable = events.filter(({ data }) => typeof data['seq'] === 'number')
  expect(durable.map(({ data }) => data['seq'])).toEqual(Array.from(
    { length: durable.length },
    (_, index) => index + 1,
  ))

  const ordered = [
    'user.message',
    'tool.call.start',
    'permission.request',
    'permission.response',
    'tool.call.end',
    'text.delta',
    'session.end',
  ].map((type) => eventIndex(events, type))
  expect(ordered.every((index) => index >= 0)).toBe(true)
  expect(ordered).toEqual([...ordered].sort((left, right) => left - right))

  const request = events.find(({ event }) => event === 'permission.request')!.data
  expect(request).toMatchObject({
    requestId: TOOL_CALL_ID,
    toolName: TOOL_NAME,
  })
  if (options.requireZoneMetadata === true) {
    expect(request).toMatchObject({ zoneLevel: 2, zoneName: 'build' })
  }
  expect(request['operationHash']).toMatch(/^[0-9a-f]{64}$/)
  expect(events.find(({ event }) => event === 'permission.response')!.data)
    .toMatchObject({ requestId: TOOL_CALL_ID, granted: true })
  expect(events.find(({ event }) => event === 'tool.call.end')!.data)
    .toMatchObject({ toolName: TOOL_NAME, result: 'executed:approved-value', isError: false })
}

const STABLE_EVENT_KEYS = [
  'type',
  'turnIndex',
  'text',
  'toolCallId',
  'toolName',
  'requestId',
  'granted',
  'isError',
  'result',
  'stopReason',
  'status',
  'reason',
] as const

function normalizedTimeline(events: readonly StreamEvent[]): JsonObject[] {
  return events
    .filter(({ data }) => typeof data['seq'] === 'number')
    .map(({ event, data }) => {
      const stable: JsonObject = { event, seq: data['seq'] }
      for (const key of STABLE_EVENT_KEYS) {
        const value = data[key]
        if (
          value === null ||
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          stable[key] = value
        }
      }
      if (event === 'permission.request') {
        delete stable['reason']
        delete stable['turnIndex']
        stable['operationHash'] = '<operation-hash>'
      }
      return stable
    })
}

function normalizedRun(body: JsonObject): JsonObject {
  return {
    runId: '<run-id>',
    threadId: '<thread-id>',
    workspaceId: body['workspaceId'],
    profileId: body['profileId'],
    model: body['model'],
    status: body['status'],
    terminal: body['terminal'],
    outcomeKnown: body['outcomeKnown'],
    startSeq: body['startSeq'],
    endSeq: body['endSeq'],
    code: body['code'],
  }
}

function normalizedHydrate(body: JsonObject): JsonObject {
  const thread = body['thread'] as JsonObject
  const messages = body['messages'] as JsonObject[]
  return {
    thread: {
      id: '<thread-id>',
      profileId: thread['profileId'],
      title: thread['title'],
      status: thread['status'],
      messageCount: thread['messageCount'],
    },
    runningAgentId: body['runningAgentId'],
    messages: messages.map((message) => ({
      role: message['role'],
      content: message['content'],
      tools: ((message['tools'] as JsonObject[] | undefined) ?? []).map((tool) => ({
        name: tool['name'],
        output: tool['output'],
        isError: tool['isError'],
      })),
      permissions: ((message['permissions'] as JsonObject[] | undefined) ?? [])
        .map((permission) => ({
          requestId: permission['requestId'],
          toolName: permission['toolName'],
          decision: permission['decision'],
        })),
    })),
  }
}

function normalizedPermissionHistory(body: JsonObject): JsonObject {
  const items = body['items'] as JsonObject[]
  return {
    total: body['total'],
    items: items.map((item) => ({
      threadId: '<thread-id>',
      threadTitle: item['threadTitle'],
      profileId: item['profileId'],
      agentId: item['agentId'],
      requestId: item['requestId'],
      toolName: item['toolName'],
      reason: item['reason'],
      decision: item['decision'],
    })),
  }
}

async function terminalReplay(gateway: OwnwareGateway, runId: string): Promise<StreamEvent[]> {
  const response = await fetch(
    `http://127.0.0.1:${gateway.port}/api/v1/runs/${runId}/events?since=0`,
    { headers: { Authorization: `Bearer ${gateway.token}` } },
  )
  expect(response.status).toBe(200)
  return parseSse(await response.text())
}

async function waitForTerminalRun(gateway: OwnwareGateway, runId: string): Promise<JsonObject> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const response = await fetchJson(gateway, `/api/v1/runs/${runId}`)
    expect(response.status).toBe(200)
    if (response.body['terminal'] === true) return response.body
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for the permission run to become terminal')
}

async function runJourney(kind: JourneyBackend['kind']): Promise<JourneyEvidence> {
  const root = await mkdtemp(join(tmpdir(), `ownware-storage-permission-${kind}-`))
  const profilesDir = join(root, 'profiles')
  const dataDir = join(root, 'data')
  const profileDir = join(profilesDir, PROFILE_ID)
  let backend: JourneyBackend | undefined
  let gateway: OwnwareGateway | undefined

  try {
    backend = await createBackend(kind)
    await mkdir(join(profileDir, 'tools'), { recursive: true })
    await writeFile(join(profileDir, 'agent.json'), JSON.stringify({
      name: PROFILE_ID,
      model: `${PROVIDER_NAME}:model`,
      maxTurns: 3,
      tools: {
        preset: 'none',
        custom: [{ path: './tools/gated.mjs' }],
      },
      security: {
        permissionMode: 'ask',
        hitlTimeoutMs: 10_000,
        zones: {
          combinationRules: 'none',
          overrides: [{
            tool: TOOL_NAME,
            zone: 'build',
            reason: 'Bounded storage permission parity action',
          }],
        },
      },
      context: { cwd: false, datetime: false },
    }))
    await writeFile(join(profileDir, 'tools', 'gated.mjs'), GATED_TOOL_SOURCE)

    const selectedStorage = backend.storage
    const options = (): GatewayOptions => ({
      port: 0,
      tls: false,
      profilesDir,
      dataDir,
      disableRateLimit: true,
      disableAccessLog: true,
      disableSourceWorker: true,
      ...(selectedStorage === undefined ? {} : { storage: selectedStorage }),
    })

    gateway = new OwnwareGateway(options())
    await gateway.start()

    const threadResponse = await fetchJson(gateway, '/api/v1/threads', {
      method: 'POST',
      body: JSON.stringify({
        profileId: PROFILE_ID,
        title: 'Storage permission parity',
      }),
    })
    expect(threadResponse.status).toBe(201)
    const threadId = threadResponse.body['id'] as string

    const runResponse = await fetchJson(gateway, '/api/v1/run', {
      method: 'POST',
      body: JSON.stringify({
        profileId: PROFILE_ID,
        threadId,
        prompt: 'Perform the bounded action after I approve it.',
      }),
    })
    expect(runResponse.status).toBe(200)
    const runId = runResponse.body['runId'] as string

    const streamResponse = await fetch(
      `http://127.0.0.1:${gateway.port}/api/v1/threads/${threadId}/agents/root/events?since=0`,
      { headers: { Authorization: `Bearer ${gateway.token}` } },
    )
    expect(streamResponse.status).toBe(200)
    const live = new LiveSse(streamResponse)
    const permissionEvent = await live.until(({ event }) => event === 'permission.request')
    const operationHash = permissionEvent.data['operationHash'] as string

    const resumeResponse = await fetchJson(
      gateway,
      `/api/v1/threads/${threadId}/resume`,
      {
        method: 'POST',
        body: JSON.stringify({ action: 'approve', requestId: TOOL_CALL_ID }),
      },
    )
    expect(resumeResponse.status).toBe(200)
    expect(resumeResponse.body).toMatchObject({
      threadId,
      action: 'approve',
      approved: true,
    })

    await live.until(({ event }) => event === 'session.end')
    await live.cancel()
    assertOrderedPermissionStream(live.seen, { requireZoneMetadata: true })

    const runBefore = await waitForTerminalRun(gateway, runId)
    expect(runBefore).toMatchObject({
      status: 'succeeded',
      terminal: true,
      outcomeKnown: true,
    })
    const hydrateBefore = await fetchJson(gateway, `/api/v1/threads/${threadId}/hydrate`)
    expect(hydrateBefore.status).toBe(200)
    const normalizedHydrateBefore = normalizedHydrate(hydrateBefore.body)
    expect(normalizedHydrateBefore).toMatchObject({
      thread: { status: 'completed', messageCount: 3 },
      runningAgentId: null,
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          tools: expect.arrayContaining([
            expect.objectContaining({
              name: TOOL_NAME,
              output: 'executed:approved-value',
              isError: false,
            }),
          ]),
          permissions: expect.arrayContaining([
            expect.objectContaining({
              requestId: TOOL_CALL_ID,
              toolName: TOOL_NAME,
              decision: 'approved',
            }),
          ]),
        }),
        expect.objectContaining({
          role: 'assistant',
          content: 'Permission approved and action completed.',
        }),
      ]),
    })
    const permissionHistoryBefore = await fetchJson(gateway, '/api/v1/permissions')
    expect(permissionHistoryBefore.status).toBe(200)
    expect(permissionHistoryBefore.body).toMatchObject({
      total: 1,
      items: [expect.objectContaining({
        requestId: TOOL_CALL_ID,
        toolName: TOOL_NAME,
        decision: 'granted',
      })],
    })

    await gateway.stop()
    gateway = new OwnwareGateway(options())
    await gateway.start()

    const runAfter = await fetchJson(gateway, `/api/v1/runs/${runId}`)
    expect(runAfter.status).toBe(200)
    const hydrateAfter = await fetchJson(gateway, `/api/v1/threads/${threadId}/hydrate`)
    expect(hydrateAfter.status).toBe(200)
    const permissionHistoryAfter = await fetchJson(gateway, '/api/v1/permissions')
    expect(permissionHistoryAfter.status).toBe(200)
    const replayAfter = await terminalReplay(gateway, runId)
    assertOrderedPermissionStream(replayAfter)

    const duplicateDecision = await fetchJson(
      gateway,
      `/api/v1/runs/${runId}/permissions/${TOOL_CALL_ID}/decision`,
      {
        method: 'POST',
        body: JSON.stringify({ decision: 'deny', operationHash }),
      },
    )
    expect(duplicateDecision.status).toBe(409)
    expect(duplicateDecision.body).toMatchObject({ error: 'permission_already_decided' })

    const run = normalizedRun(runBefore)
    const hydrate = normalizedHydrateBefore
    const permissionHistory = normalizedPermissionHistory(permissionHistoryBefore.body)
    const restartedRun = normalizedRun(runAfter.body)
    const restartedHydrate = normalizedHydrate(hydrateAfter.body)
    const restartedPermissionHistory = normalizedPermissionHistory(permissionHistoryAfter.body)
    const timeline = normalizedTimeline(live.seen)
    const replayTimeline = normalizedTimeline(replayAfter)

    expect(restartedRun).toEqual(run)
    expect(restartedHydrate).toEqual(hydrate)
    expect(restartedPermissionHistory).toEqual(permissionHistory)
    expect(replayTimeline).toEqual(timeline)

    return {
      resume: {
        threadId: '<thread-id>',
        action: resumeResponse.body['action'],
        approved: resumeResponse.body['approved'],
        pendingCount: resumeResponse.body['pendingCount'],
      },
      stream: {
        streamStartCount: live.seen.filter(({ event }) => event === 'stream.start').length,
        replayCompleteCount: live.seen.filter(({ event }) => event === 'stream.replay.complete').length,
        durableTimeline: timeline,
      },
      run,
      hydrate,
      permissionHistory,
      restart: {
        run: restartedRun,
        hydrate: restartedHydrate,
        permissionHistory: restartedPermissionHistory,
        replayTimeline,
        duplicateDecision: {
          status: duplicateDecision.status,
          error: duplicateDecision.body['error'],
        },
      },
    }
  } finally {
    await gateway?.stop().catch(() => {})
    await backend?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}

describe('public gateway permission storage backend parity', () => {
  it('approves and durably preserves the public permission journey with SQLite', async () => {
    registerProvider(deterministicProvider())
    try {
      const evidence = await runJourney('sqlite')
      expect(evidence.restart.duplicateDecision).toEqual({
        status: 409,
        error: 'permission_already_decided',
      })
    } finally {
      unregisterProvider(PROVIDER_NAME)
    }
  }, 30_000)

  itPostgreSql('matches SQLite permission, SSE and restart authority with PostgreSQL', async () => {
    registerProvider(deterministicProvider())
    try {
      const sqlite = await runJourney('sqlite')
      const postgresql = await runJourney('postgresql')
      expect(postgresql).toEqual(sqlite)
    } finally {
      unregisterProvider(PROVIDER_NAME)
    }
  }, 60_000)
})
