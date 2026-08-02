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
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { OwnwareGateway, type GatewayOptions } from '../../../src/gateway/server.js'
import { ROOT_AGENT_ID, type BusEvent } from '../../../src/gateway/event-bus.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const itPostgreSql = TEST_URL === undefined ? it.skip : it
const PROVIDER_NAME = 'storageoutage'
const PROFILE_ID = 'outage-agent'

type JsonObject = Record<string, unknown>

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function createGate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open!: () => void
  const wait = new Promise<void>((resolve) => { open = resolve })
  return { wait, open }
}

function outageProvider(gate: Promise<void>, calls: { count: number }): ProviderAdapter {
  return {
    name: PROVIDER_NAME,
    async *stream(_request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      calls.count += 1
      yield { type: 'text_delta', text: 'durable before outage' }
      await gate
      yield { type: 'text_delta', text: 'must not survive outage' }
      yield {
        type: 'message_complete',
        content: [{ type: 'text', text: 'fabricated completion' }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      }
    },
    async countTokens(messages: Message[]): Promise<number> {
      return messages.length
    },
    supportsFeature(_feature: ProviderFeature): boolean {
      return true
    },
    formatTools(tools: ToolDefinition[]): unknown[] {
      return tools
    },
    getModelPricing() {
      return {
        inputPer1M: 0,
        outputPer1M: 0,
        cacheReadPer1M: 0,
        cacheWritePer1M: 0,
      }
    },
  }
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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

function parseEventTypes(raw: string): string[] {
  const types: string[] = []
  for (const block of raw.split('\n\n')) {
    const event = block.split('\n').find((line) => line.startsWith('event: '))
    if (event !== undefined) types.push(event.slice('event: '.length))
  }
  return types
}

describe('PostgreSQL mid-run authority outage', () => {
  itPostgreSql(
    'preserves only committed output, recovers the run as indeterminate and never falls back',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'ownware-postgresql-mid-run-outage-'))
      const profilesDir = join(root, 'profiles')
      const dataDir = join(root, 'data')
      const profilePath = join(profilesDir, PROFILE_ID)
      const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
      const migration = await database.createRole('migration')
      const runtime = await database.createRole('runtime')
      const gate = createGate()
      const providerCalls = { count: 0 }
      const control = new Client({ connectionString: database.adminUrl, ssl: false })
      let runtimeLoginDisabled = false
      let gateway: OwnwareGateway | undefined

      await database.transferOwnershipTo(migration.name)
      await mkdir(profilePath, { recursive: true })
      await writeFile(join(profilePath, 'agent.json'), JSON.stringify({
        name: PROFILE_ID,
        model: `${PROVIDER_NAME}:model`,
        tools: { preset: 'none' },
        context: { cwd: false, datetime: false },
      }))
      registerProvider(outageProvider(gate.wait, providerCalls))

      const options = (): GatewayOptions => ({
        port: 0,
        tls: false,
        profilesDir,
        dataDir,
        disableRateLimit: true,
        disableAccessLog: true,
        disableSourceWorker: true,
        storage: {
          kind: 'postgresql',
          runtimeConnection: { source: 'provider', resolve: () => runtime.url },
          migrationConnection: { source: 'provider', resolve: () => migration.url },
          tls: { mode: 'disable', allowInsecureLoopback: true },
          pool: { connectionTimeoutMs: 250 },
        },
      })

      try {
        await control.connect()
        gateway = new OwnwareGateway(options())
        await gateway.start()
        expect(gateway.state.storageKind).toBe('postgresql')

        const thread = await fetchJson(gateway, '/api/v1/threads', {
          method: 'POST',
          body: JSON.stringify({ profileId: PROFILE_ID, title: 'Outage proof' }),
        })
        expect(thread.status).toBe(201)
        const threadId = thread.body['id'] as string

        let unsubscribe = (): void => {}
        const firstCommittedOutput = new Promise<BusEvent>((resolve) => {
          unsubscribe = gateway!.state.eventBus.subscribe(
            threadId,
            ROOT_AGENT_ID,
            (entry) => {
              if (entry.event.type !== 'text.delta') return
              unsubscribe()
              resolve(entry)
            },
          )
        })

        const started = await fetchJson(gateway, '/api/v1/run', {
          method: 'POST',
          body: JSON.stringify({
            profileId: PROFILE_ID,
            threadId,
            prompt: 'prove an honest mid-run database outage',
          }),
        })
        expect(started.status).toBe(200)
        const runId = started.body['runId'] as string
        await expect(firstCommittedOutput).resolves.toMatchObject({
          event: { type: 'text.delta', text: 'durable before outage' },
        })

        await control.query(`ALTER ROLE ${identifier(runtime.name)} NOLOGIN`)
        runtimeLoginDisabled = true
        const terminated = await control.query<{ readonly terminated: boolean }>(`
          SELECT pg_terminate_backend(pid) AS terminated
          FROM pg_catalog.pg_stat_activity
          WHERE datname = $1 AND usename = $2 AND pid <> pg_backend_pid()
        `, [database.name, runtime.name])
        expect(terminated.rows.some((row) => row.terminated)).toBe(true)

        gate.open()
        await waitFor(
          () => !gateway!.runner.isRunning(threadId),
          'Run did not leave process-local execution after PostgreSQL disappeared',
        )

        await control.query(`ALTER ROLE ${identifier(runtime.name)} LOGIN`)
        runtimeLoginDisabled = false
        await waitFor(async () => (await gateway!.state.storageHealth()).state === 'ready',
          'PostgreSQL runtime pool did not recover after authority returned')

        const beforeRestart = await fetchJson(gateway, `/api/v1/runs/${runId}`)
        expect(beforeRestart).toEqual({
          status: 200,
          body: expect.objectContaining({
            runId,
            status: 'running',
            terminal: false,
            outcomeKnown: true,
          }),
        })

        await gateway.stop()
        gateway = new OwnwareGateway(options())
        await gateway.start()

        const recovered = await fetchJson(gateway, `/api/v1/runs/${runId}`)
        expect(recovered).toEqual({
          status: 200,
          body: expect.objectContaining({
            runId,
            status: 'indeterminate',
            terminal: true,
            outcomeKnown: false,
            code: 'gateway_restarted',
            endSeq: null,
          }),
        })

        const replay = await fetch(
          `http://127.0.0.1:${gateway.port}/api/v1/runs/${runId}/events?since=0`,
          { headers: { Authorization: `Bearer ${gateway.token}` } },
        )
        expect(replay.status).toBe(200)
        const eventTypes = parseEventTypes(await replay.text())
        expect(eventTypes.filter((type) => type === 'text.delta')).toHaveLength(1)
        expect(eventTypes).not.toContain('turn.end')
        expect(eventTypes).not.toContain('error')
        expect(providerCalls.count).toBe(1)
        expect(gateway.state.storageKind).toBe('postgresql')
        await expect(access(join(dataDir, 'ownware.db'))).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        gate.open()
        if (runtimeLoginDisabled) {
          await control.query(`ALTER ROLE ${identifier(runtime.name)} LOGIN`).catch(() => {})
        }
        await gateway?.stop().catch(() => {})
        await control.end().catch(() => {})
        unregisterProvider(PROVIDER_NAME)
        await database.close().catch(() => {})
        await rm(root, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
