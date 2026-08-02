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
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import { OwnwareGateway, type GatewayOptions } from '../../../src/gateway/server.js'
import {
  PostgreSqlStorageAdapter,
  type PostgreSqlRepositoryFactories,
} from '../../../src/storage/postgresql-adapter.js'
import { validateStoragePlan, type ValidatedPostgreSqlPlan } from '../../../src/storage/config.js'
import { preflightPostgreSqlTransferTarget } from '../../../src/storage/postgresql-transfer-preflight.js'
import { transferOfflineSqliteToPostgreSql } from '../../../src/storage/sqlite-to-postgresql-transfer.js'
import { preflightSqliteTransferSource } from '../../../src/storage/sqlite-transfer-preflight.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe
const PROFILE_ID = 'transfer-agent'
const PROVIDER_NAME = 'storagetransferjourney'
const CREDENTIAL_SECRET = 'transfer-secret-never-in-receipts'
const EMPTY_FACTORIES: PostgreSqlRepositoryFactories<object, object> = {
  createRoot: () => ({}),
  createTransaction: () => ({}),
}

type JsonObject = Record<string, unknown>

function deterministicProvider(): ProviderAdapter {
  return {
    name: PROVIDER_NAME,
    async *stream(_request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      yield { type: 'text_delta', text: 'hello transferred target' }
      yield {
        type: 'message_complete',
        content: [{ type: 'text', text: 'hello transferred target' }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 3,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      }
    },
    async countTokens(messages: Message[]): Promise<number> {
      return messages.length * 3
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

function plan(url: string): ValidatedPostgreSqlPlan {
  const selected = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => url },
      tls: { mode: 'disable', allowInsecureLoopback: true },
    },
  }, '/unused.db')
  if (selected.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
  return selected
}

async function fetchJson(
  gateway: OwnwareGateway,
  path: string,
  init: RequestInit = {},
): Promise<{ readonly status: number; readonly body: JsonObject }> {
  const response = await fetch(`http://127.0.0.1:${gateway.port}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${gateway.token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  })
  return { status: response.status, body: await response.json() as JsonObject }
}

async function waitForTerminal(gateway: OwnwareGateway, runId: string): Promise<JsonObject> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const response = await fetchJson(gateway, `/api/v1/runs/${runId}`)
    if (response.status === 200 && response.body['terminal'] === true) return response.body
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Transferred target run did not become terminal.')
}

describePostgreSql('offline transfer production-shaped gateway journey', () => {
  it('moves core/source/security state, then runs SSE and restarts only after explicit selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ownware-transfer-journey-'))
    const profilesDir = join(root, 'profiles')
    const dataDir = join(root, 'data')
    const sourcePath = join(root, 'source.sqlite')
    const workspacePath = join(root, 'workspace')
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const previousMasterKey = process.env['OWNWARE_MASTER_KEY']
    let gateway: OwnwareGateway | undefined
    let migration: Client | undefined
    let runtime: Client | undefined
    registerProvider(deterministicProvider())
    process.env['OWNWARE_MASTER_KEY'] = 'd7'.repeat(32)
    __resetMasterKeyCacheForTests()

    const baseOptions = {
      port: 0,
      tls: false as const,
      profilesDir,
      dataDir,
      disableAuth: false,
      disableRateLimit: true,
      disableAccessLog: true,
      disableSourceWorker: true,
    }
    const sqliteOptions = (): GatewayOptions => ({
      ...baseOptions,
      storage: { kind: 'sqlite', path: sourcePath },
    })
    const postgresqlOptions = (): GatewayOptions => ({
      ...baseOptions,
      storage: {
        kind: 'postgresql',
        runtimeConnection: { source: 'provider', resolve: () => database.url },
        tls: { mode: 'disable', allowInsecureLoopback: true },
      },
    })

    try {
      await mkdir(join(profilesDir, PROFILE_ID), { recursive: true })
      await mkdir(workspacePath)
      await writeFile(join(profilesDir, PROFILE_ID, 'agent.json'), JSON.stringify({
        name: PROFILE_ID,
        model: `${PROVIDER_NAME}:model`,
        tools: { preset: 'none' },
        context: { cwd: false, datetime: false },
      }))

      gateway = new OwnwareGateway(sqliteOptions())
      await gateway.start()
      const originalToken = gateway.token
      const workspace = await gateway.state.createWorkspace(workspacePath, 'Transfer workspace')
      const thread = await gateway.state.createThread(
        PROFILE_ID,
        'Thread created on SQLite',
        workspace.id,
      )
      await gateway.state.addMessage(thread.id, {
        id: 'sqlite-message',
        role: 'user',
        content: 'durable source message',
        timestamp: '2026-08-02T00:00:00.000Z',
      })
      const source = await gateway.state.sourceRepositories.sources.create({
        workspaceId: workspace.id,
        profileId: PROFILE_ID,
        kind: 'structured_export',
        label: 'Transferred source',
        classification: 'internal',
        authority: 'supporting_reference',
        audiencePolicyRef: 'audience.transfer',
        sensitivityPolicyRef: 'sensitivity.transfer',
        purposePolicyRef: 'purpose.transfer',
        retentionPolicyRef: 'retention.transfer',
        freshnessPolicyRef: 'freshness.transfer',
      }, 1_000)

      const credentialResponse = await fetchJson(gateway, '/api/v1/credentials', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Transferred API credential',
          value: CREDENTIAL_SECRET,
          category: 'llm',
          authType: 'api-key',
          variableName: 'TRANSFER_TEST_API_KEY',
          source: 'manual',
        }),
      })
      expect(credentialResponse.status).toBe(201)
      expect(JSON.stringify(credentialResponse.body)).not.toContain(CREDENTIAL_SECRET)
      await gateway.stop()
      gateway = undefined

      const sourceFileBefore = createHash('sha256')
        .update(await readFile(sourcePath))
        .digest('hex')
      const expectedSource = preflightSqliteTransferSource(sourcePath)

      const initializer = new PostgreSqlStorageAdapter({
        plan: plan(database.url),
        repositories: EMPTY_FACTORIES,
      })
      await initializer.initialize()
      await initializer.close()
      migration = new Client({ connectionString: database.url, ssl: false })
      runtime = new Client({ connectionString: database.url, ssl: false })
      await migration.connect()
      await runtime.connect()
      const expectedTarget = await preflightPostgreSqlTransferTarget(migration, runtime)
      const transfer = await transferOfflineSqliteToPostgreSql({
        sourcePath,
        expectedSource,
        expectedTarget,
        targetMigration: migration,
        targetRuntime: runtime,
      })
      expect(transfer).toMatchObject({
        status: 'ready-for-explicit-cutover',
        sourceRemainsAuthoritative: true,
        targetCommitted: true,
        targetVerified: true,
        cutoverAutomatic: false,
      })
      expect(JSON.stringify(transfer)).not.toContain(CREDENTIAL_SECRET)
      await migration.end()
      await runtime.end()
      migration = undefined
      runtime = undefined

      // This constructor is the explicit test cutover. The transfer function
      // itself never changes configuration or starts the PostgreSQL gateway.
      gateway = new OwnwareGateway(postgresqlOptions())
      await gateway.start()
      expect(gateway.token).toBe(originalToken)
      const health = await fetchJson(gateway, '/api/v1/health')
      expect(health).toMatchObject({ status: 200, body: { status: 'ok' } })
      await expect(gateway.state.getWorkspace(workspace.id)).resolves.toMatchObject({
        name: 'Transfer workspace',
      })
      await expect(gateway.state.getMessages(thread.id)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'sqlite-message', content: 'durable source message' }),
      ]))
      await expect(gateway.state.sourceRepositories.sources.getScoped(
        source.sourceId,
        workspace.id,
        PROFILE_ID,
      )).resolves.toMatchObject({ sourceId: source.sourceId, label: 'Transferred source' })

      const handle = await gateway.credentialResolver.resolve('TRANSFER_TEST_API_KEY', {
        agentId: 'root',
        sessionId: 'transfer-journey-session',
        threadId: thread.id,
        toolName: 'transfer-journey-tool',
      })
      const decryptedThroughNormalGate = await gateway.credentialInjector
        .runWithCredential(handle, (value) => value)
      expect(decryptedThroughNormalGate).toBe(CREDENTIAL_SECRET)

      const started = await fetchJson(gateway, '/api/v1/run', {
        method: 'POST',
        body: JSON.stringify({
          profileId: PROFILE_ID,
          threadId: thread.id,
          prompt: 'Run after explicit PostgreSQL cutover.',
        }),
      })
      expect(started.status).toBe(200)
      const runId = String(started.body['runId'])
      await expect(waitForTerminal(gateway, runId)).resolves.toMatchObject({
        status: 'succeeded',
        terminal: true,
        outcomeKnown: true,
      })
      const stream = await fetch(
        `http://127.0.0.1:${gateway.port}/api/v1/runs/${runId}/events?since=0`,
        { headers: { authorization: `Bearer ${gateway.token}` } },
      )
      expect(stream.status).toBe(200)
      const streamText = await stream.text()
      expect(streamText).toContain('hello transferred target')
      expect(streamText).toContain('stream.replay.complete')
      expect(streamText).not.toContain(CREDENTIAL_SECRET)

      await gateway.stop()
      gateway = new OwnwareGateway(postgresqlOptions())
      await gateway.start()
      await expect(gateway.state.getMessages(thread.id)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'sqlite-message' }),
        expect.objectContaining({ content: 'hello transferred target' }),
      ]))
      await expect(waitForTerminal(gateway, runId)).resolves.toMatchObject({
        status: 'succeeded',
        terminal: true,
      })

      // PostgreSQL runtime writes never flow backwards. The untouched source is
      // still the exact pre-transfer authority and is usable only as rollback
      // before accepting new target writes.
      expect(preflightSqliteTransferSource(sourcePath)).toEqual(expectedSource)
      expect(createHash('sha256').update(await readFile(sourcePath)).digest('hex'))
        .toBe(sourceFileBefore)
    } finally {
      await gateway?.stop().catch(() => {})
      await migration?.end().catch(() => {})
      await runtime?.end().catch(() => {})
      await database.close().catch(() => {})
      unregisterProvider(PROVIDER_NAME)
      if (previousMasterKey === undefined) delete process.env['OWNWARE_MASTER_KEY']
      else process.env['OWNWARE_MASTER_KEY'] = previousMasterKey
      __resetMasterKeyCacheForTests()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
