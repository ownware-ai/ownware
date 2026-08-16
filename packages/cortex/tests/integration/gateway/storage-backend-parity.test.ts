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

const PROVIDER_NAME = 'storageparity'
const PROFILE_ID = 'test-agent'
const TEST_URL = configuredPostgreSqlTestUrl()
const itPostgreSql = TEST_URL === undefined ? it.skip : it

type JsonObject = Record<string, unknown>

interface StreamEvent {
  readonly event: string
  readonly data: JsonObject
}

interface JourneyEvidence {
  readonly health: {
    readonly status: unknown
    readonly version: unknown
  }
  readonly workspaceCreated: JsonObject
  readonly threadCreated: JsonObject
  readonly run: JsonObject
  readonly stream: readonly StreamEvent[]
  readonly hydrate: JsonObject
  readonly workspaceAfterRestart: JsonObject
  readonly workspaceThreadsAfterRestart: readonly JsonObject[]
}

interface JourneyBackend {
  readonly kind: 'sqlite' | 'postgresql'
  readonly storage?: GatewayOptions['storage']
  readonly close: () => Promise<void>
}

function deterministicProvider(): ProviderAdapter {
  return {
    name: PROVIDER_NAME,
    async *stream(_request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      yield { type: 'text_delta', text: 'hello ' }
      yield { type: 'text_delta', text: 'storage parity' }
      yield {
        type: 'message_complete',
        content: [{ type: 'text', text: 'hello storage parity' }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 7,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      }
    },
    async countTokens(messages: Message[]): Promise<number> {
      return messages.length * 7
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
  if (kind === 'sqlite') {
    return { kind, close: async () => {} }
  }
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

function parseSse(raw: string): StreamEvent[] {
  const events: StreamEvent[] = []
  for (const block of raw.split('\n\n')) {
    if (block.trim() === '' || block.startsWith(':')) continue
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7)
      if (line.startsWith('data: ')) data += line.slice(6)
    }
    if (data !== '') events.push({ event, data: JSON.parse(data) as JsonObject })
  }
  return events
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

async function waitForTerminalRun(
  gateway: OwnwareGateway,
  runId: string,
): Promise<JsonObject> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const response = await fetchJson(gateway, `/api/v1/runs/${runId}`)
    expect(response.status).toBe(200)
    if (response.body['terminal'] === true) return response.body
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for the deterministic storage parity run')
}

function canonicalize(
  value: unknown,
  replacements: ReadonlyMap<string, string>,
  key = '',
): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, replacements))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as JsonObject).map(([childKey, child]) => [
      childKey,
      canonicalize(child, replacements, childKey),
    ]))
  }
  if (typeof value === 'string') {
    const replacement = replacements.get(value)
    if (replacement !== undefined) return replacement
    if (key === 'sessionId') return '<session-id>'
    if (key === 'timestamp' || key.endsWith('At')) {
      return '<timestamp>'
    }
  }
  if (typeof value === 'number' && key === 'timestamp') return '<timestamp>'
  return value
}

function assertOrderedRunStream(events: readonly StreamEvent[]): void {
  expect(events[0]?.event).toBe('stream.start')
  expect(events.at(-1)?.event).toBe('stream.replay.complete')

  const durable = events.slice(1, -1)
  const sequences = durable.map(({ data }) => data['seq'])
  expect(sequences).toEqual(Array.from(
    { length: durable.length },
    (_, index) => index + 1,
  ))
  expect(durable.map(({ event }) => event)).toContain('user.message')
  expect(durable.filter(({ event }) => event === 'text.delta').map(({ data }) => data['text']))
    .toEqual(['hello ', 'storage parity'])
  expect(durable.map(({ event }) => event)).toContain('turn.end')
  expect(events.at(-1)?.data).toMatchObject({
    since: 0,
    replayedThroughSeq: durable.length,
    maxSeqAtStart: durable.length,
    liveTail: false,
  })
}

async function runJourney(kind: JourneyBackend['kind']): Promise<JourneyEvidence> {
  const root = await mkdtemp(join(tmpdir(), `ownware-storage-parity-${kind}-`))
  const profilesDir = join(root, 'profiles')
  const dataDir = join(root, 'data')
  const workspacePath = join(root, 'workspace')
  const profilePath = join(profilesDir, PROFILE_ID)
  let backend: JourneyBackend | undefined
  let gateway: OwnwareGateway | undefined

  try {
    backend = await createBackend(kind)
    await mkdir(profilePath, { recursive: true })
    await mkdir(workspacePath, { recursive: true })
    await writeFile(join(profilePath, 'agent.json'), JSON.stringify({
      name: PROFILE_ID,
      model: `${PROVIDER_NAME}:model`,
      tools: { preset: 'none' },
      context: { cwd: false, datetime: false },
    }))

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

    const health = await fetchJson(gateway, '/api/v1/health')
    expect(health.status).toBe(200)

    const workspace = await fetchJson(gateway, '/api/v1/workspaces', {
      method: 'POST',
      body: JSON.stringify({ path: workspacePath, name: 'Storage parity workspace' }),
    })
    expect(workspace.status).toBe(201)
    const workspaceId = workspace.body['id'] as string

    const thread = await fetchJson(gateway, '/api/v1/threads', {
      method: 'POST',
      body: JSON.stringify({
        profileId: PROFILE_ID,
        title: 'Storage parity thread',
        workspaceId,
      }),
    })
    expect(thread.status).toBe(201)
    const threadId = thread.body['id'] as string

    const runResponse = await fetchJson(gateway, '/api/v1/run', {
      method: 'POST',
      body: JSON.stringify({
        profileId: PROFILE_ID,
        threadId,
        prompt: 'prove public storage parity',
      }),
    })
    expect(runResponse.status).toBe(200)
    const runId = runResponse.body['runId'] as string
    const run = await waitForTerminalRun(gateway, runId)
    expect(run).toMatchObject({
      threadId,
      profileId: PROFILE_ID,
      status: 'succeeded',
      consequence: 'output_observed',
      terminal: true,
      outcomeKnown: true,
    })

    const streamResponse = await fetch(
      `http://127.0.0.1:${gateway.port}/api/v1/runs/${runId}/events?since=0`,
      { headers: { Authorization: `Bearer ${gateway.token}` } },
    )
    expect(streamResponse.status).toBe(200)
    const stream = parseSse(await streamResponse.text())
    assertOrderedRunStream(stream)

    const hydrateBefore = await fetchJson(gateway, `/api/v1/threads/${threadId}/hydrate`)
    expect(hydrateBefore.status).toBe(200)
    expect(hydrateBefore.body).toMatchObject({
      thread: {
        id: threadId,
        workspaceId,
        profileId: PROFILE_ID,
        status: 'completed',
      },
      runningAgentId: null,
    })
    expect(hydrateBefore.body['messages']).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'prove public storage parity' }),
      expect.objectContaining({ role: 'assistant', content: 'hello storage parity' }),
    ]))

    await gateway.stop()
    gateway = new OwnwareGateway(options())
    await gateway.start()

    const healthAfterRestart = await fetchJson(gateway, '/api/v1/health')
    expect(healthAfterRestart.status).toBe(200)
    const hydrateAfter = await fetchJson(gateway, `/api/v1/threads/${threadId}/hydrate`)
    expect(hydrateAfter.status).toBe(200)
    expect(hydrateAfter.body).toEqual(hydrateBefore.body)

    const runAfter = await fetchJson(gateway, `/api/v1/runs/${runId}`)
    expect(runAfter.status).toBe(200)
    expect(runAfter.body).toEqual(run)
    const streamAfterResponse = await fetch(
      `http://127.0.0.1:${gateway.port}/api/v1/runs/${runId}/events?since=0`,
      { headers: { Authorization: `Bearer ${gateway.token}` } },
    )
    expect(streamAfterResponse.status).toBe(200)
    expect(parseSse(await streamAfterResponse.text())).toEqual(stream)

    const workspaceAfter = await fetchJson(gateway, `/api/v1/workspaces/${workspaceId}`)
    expect(workspaceAfter.status).toBe(200)
    const workspaceThreadsAfter = await fetchJson(
      gateway,
      `/api/v1/workspaces/${workspaceId}/threads`,
    )
    expect(workspaceThreadsAfter.status).toBe(200)
    expect(workspaceThreadsAfter.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: threadId, workspaceId, status: 'completed' }),
    ]))

    const messages = hydrateBefore.body['messages'] as JsonObject[]
    const replacements = new Map<string, string>([
      [workspacePath, '<workspace-path>'],
      [workspaceId, '<workspace-id>'],
      [threadId, '<thread-id>'],
      [runId, '<run-id>'],
      ...messages.map((message, index) => [message['id'] as string, `<message-${index + 1}-id>`] as const),
    ])

    return {
      health: {
        status: health.body['status'],
        version: health.body['version'],
      },
      workspaceCreated: canonicalize(workspace.body, replacements) as JsonObject,
      threadCreated: canonicalize(thread.body, replacements) as JsonObject,
      run: canonicalize({
        runId: run['runId'],
        threadId: run['threadId'],
        workspaceId: run['workspaceId'],
        profileId: run['profileId'],
        model: run['model'],
        status: run['status'],
        terminal: run['terminal'],
        outcomeKnown: run['outcomeKnown'],
        startSeq: run['startSeq'],
        endSeq: run['endSeq'],
        earliestRetainedCursor: run['earliestRetainedCursor'],
      }, replacements) as JsonObject,
      stream: canonicalize(stream, replacements) as StreamEvent[],
      hydrate: canonicalize(hydrateBefore.body, replacements) as JsonObject,
      workspaceAfterRestart: canonicalize(workspaceAfter.body, replacements) as JsonObject,
      workspaceThreadsAfterRestart: canonicalize(
        workspaceThreadsAfter.body,
        replacements,
      ) as JsonObject[],
    }
  } finally {
    await gateway?.stop().catch(() => {})
    await backend?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}

async function runConcurrentPostgreSqlJourney(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ownware-storage-pg-concurrent-'))
  const profilesDir = join(root, 'profiles')
  const dataDir = join(root, 'data')
  const workspacePath = join(root, 'workspace')
  const profilePath = join(profilesDir, PROFILE_ID)
  let backend: JourneyBackend | undefined
  let gateway: OwnwareGateway | undefined

  try {
    backend = await createBackend('postgresql')
    await mkdir(profilePath, { recursive: true })
    await mkdir(workspacePath, { recursive: true })
    await writeFile(join(profilePath, 'agent.json'), JSON.stringify({
      name: PROFILE_ID,
      model: `${PROVIDER_NAME}:model`,
      tools: { preset: 'none' },
      context: { cwd: false, datetime: false },
    }))
    const options = (): GatewayOptions => ({
      port: 0,
      tls: false,
      profilesDir,
      dataDir,
      disableRateLimit: true,
      disableAccessLog: true,
      disableSourceWorker: true,
      storage: backend!.storage!,
    })

    gateway = new OwnwareGateway(options())
    await gateway.start()
    const workspace = await fetchJson(gateway, '/api/v1/workspaces', {
      method: 'POST',
      body: JSON.stringify({ path: workspacePath, name: 'Concurrent PostgreSQL workspace' }),
    })
    expect(workspace.status).toBe(201)
    const workspaceId = workspace.body['id'] as string

    const threads = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      fetchJson(gateway!, '/api/v1/threads', {
        method: 'POST',
        body: JSON.stringify({
          profileId: PROFILE_ID,
          title: `Concurrent PostgreSQL thread ${index}`,
          workspaceId,
        }),
      })))
    expect(threads.every((thread) => thread.status === 201)).toBe(true)

    const starts = await Promise.all(threads.map((thread, index) =>
      fetchJson(gateway!, '/api/v1/run', {
        method: 'POST',
        body: JSON.stringify({
          profileId: PROFILE_ID,
          threadId: thread.body['id'],
          prompt: `concurrent PostgreSQL run ${index}`,
        }),
      })))
    expect(starts.every((start) => start.status === 200)).toBe(true)

    const runs = await Promise.all(starts.map((start) =>
      waitForTerminalRun(gateway!, start.body['runId'] as string)))
    expect(runs.every((run) => run['status'] === 'succeeded' && run['terminal'] === true))
      .toBe(true)

    const streams = await Promise.all(starts.map(async (start) => {
      const response = await fetch(
        `http://127.0.0.1:${gateway!.port}/api/v1/runs/${String(start.body['runId'])}/events?since=0`,
        { headers: { Authorization: `Bearer ${gateway!.token}` } },
      )
      expect(response.status).toBe(200)
      return parseSse(await response.text())
    }))
    streams.forEach(assertOrderedRunStream)

    const hydrates = await Promise.all(threads.map((thread) =>
      fetchJson(gateway!, `/api/v1/threads/${String(thread.body['id'])}/hydrate`)))
    expect(hydrates.every((hydrate) => hydrate.status === 200)).toBe(true)

    await gateway.stop()
    gateway = new OwnwareGateway(options())
    await gateway.start()

    for (const [index, start] of starts.entries()) {
      const runId = start.body['runId'] as string
      const threadId = threads[index]!.body['id'] as string
      expect(await fetchJson(gateway, `/api/v1/runs/${runId}`)).toEqual({
        status: 200,
        body: runs[index],
      })
      expect(await fetchJson(gateway, `/api/v1/threads/${threadId}/hydrate`)).toEqual(
        hydrates[index],
      )
      const replay = await fetch(
        `http://127.0.0.1:${gateway.port}/api/v1/runs/${runId}/events?since=0`,
        { headers: { Authorization: `Bearer ${gateway.token}` } },
      )
      expect(replay.status).toBe(200)
      expect(parseSse(await replay.text())).toEqual(streams[index])
    }
    const durableThreads = await fetchJson(
      gateway,
      `/api/v1/workspaces/${workspaceId}/threads`,
    )
    expect(durableThreads.status).toBe(200)
    expect(durableThreads.body).toHaveLength(8)
  } finally {
    await gateway?.stop().catch(() => {})
    await backend?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}

describe('public gateway storage backend parity', () => {
  it('runs the complete customer journey with configuration-free SQLite', async () => {
    registerProvider(deterministicProvider())
    try {
      const evidence = await runJourney('sqlite')
      expect(evidence.health.status).toBe('ok')
      expect(evidence.hydrate).toMatchObject({
        thread: { profileId: PROFILE_ID, status: 'completed', messageCount: 2 },
        runningAgentId: null,
      })
    } finally {
      unregisterProvider(PROVIDER_NAME)
    }
  }, 30_000)

  itPostgreSql('matches SQLite HTTP, SSE ordering and restart evidence with PostgreSQL', async () => {
    registerProvider(deterministicProvider())
    try {
      const sqlite = await runJourney('sqlite')
      const postgresql = await runJourney('postgresql')
      expect(postgresql).toEqual(sqlite)
    } finally {
      unregisterProvider(PROVIDER_NAME)
    }
  }, 60_000)

  itPostgreSql('persists concurrent runs and SSE consumers through PostgreSQL restart', async () => {
    registerProvider(deterministicProvider())
    try {
      await runConcurrentPostgreSqlJourney()
    } finally {
      unregisterProvider(PROVIDER_NAME)
    }
  }, 60_000)
})
