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
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import {
  createTestGateway,
  type TestGateway,
} from '../../framework/harness/index.js'

const PROVIDER_NAME = 'effectreversaljourney'
const PROFILE_ID = 'reversal-agent'
const TOOL_CALL_ID = 'root-remember-call'
const PRIVATE_CONTENT = 'User prefers the private reversal journey marker.'

function provider(): ProviderAdapter {
  let requestedRemember = false
  return {
    name: PROVIDER_NAME,
    async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      if (!requestedRemember) {
        expect(request.tools.some(tool => tool.name === 'remember')).toBe(true)
        requestedRemember = true
        yield* toolCall(TOOL_CALL_ID, 'remember', {
          content: PRIVATE_CONTENT,
          kind: 'preference',
        })
        return
      }
      yield { type: 'text_delta', text: 'done' }
      yield {
        type: 'message_complete',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: usage(),
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
      return null
    },
  }
}

async function* toolCall(
  id: string,
  name: string,
  input: Record<string, unknown>,
): AsyncGenerator<ProviderChunk> {
  yield { type: 'tool_use_start', id, name }
  yield { type: 'tool_use_args_delta', id, delta: JSON.stringify(input) }
  yield { type: 'tool_use_end', id }
  yield {
    type: 'message_complete',
    content: [{ type: 'tool_use', id, name, input }],
    stopReason: 'tool_use',
    usage: usage(),
  }
}

function usage() {
  return {
    inputTokens: 5,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }
}

async function waitForRunToStop(gateway: TestGateway, threadId: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (gateway.runner.isRunning(threadId) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(gateway.runner.isRunning(threadId)).toBe(false)
}

async function fetchWithAuth(
  gateway: OwnwareGateway,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${gateway.port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${gateway.token}`,
      ...init?.headers,
    },
  })
}

describe('exact effect reversal through the public Gateway', () => {
  let first: TestGateway | undefined
  let restarted: OwnwareGateway | undefined
  let retainedTmpDir: string | undefined

  afterEach(async () => {
    await restarted?.stop()
    if (first !== undefined) await first.stop({ cleanup: false })
    if (retainedTmpDir !== undefined) {
      await rm(retainedTmpDir, { recursive: true, force: true })
    }
    unregisterProvider(PROVIDER_NAME)
  })

  it('reverses only the exact pending memory proposal after restart with one receipt', async () => {
    registerProvider(provider())
    first = await createTestGateway({
      disableAuth: false,
      profiles: [{
        name: PROFILE_ID,
        model: `${PROVIDER_NAME}:model`,
        tools: { preset: 'none' },
      }],
    })
    retainedTmpDir = first.tmpDir

    const started = await first.client.post('/api/v1/run', {
      profileId: PROFILE_ID,
      prompt: 'Remember my durable preference.',
    })
    expect(started.status).toBe(200)
    const runId = String(started.body['runId'])
    const threadId = String(started.body['threadId'])
    await waitForRunToStop(first, threadId)

    const pending = first.state.rawDbHandle.prepare(`
      SELECT id, status, proposed_content, resolution_authority_ref
      FROM memory_proposals WHERE profile_id = ? AND thread_id = ?
    `).get(PROFILE_ID, threadId) as Record<string, unknown>
    expect(pending).toMatchObject({
      status: 'pending',
      proposed_content: PRIVATE_CONTENT,
      resolution_authority_ref: null,
    })

    const unauthenticated = await fetch(
      `${first.baseUrl}/api/v1/runs/${runId}/reversal-offers`,
    )
    expect(unauthenticated.status).toBe(401)

    const beforeRestart = await fetchWithAuth(
      first.gateway,
      `/api/v1/runs/${runId}/reversal-offers`,
    )
    expect(beforeRestart.status).toBe(200)
    expect(beforeRestart.headers.get('cache-control')).toBe('no-store')
    const beforePage = await beforeRestart.json() as {
      readonly items: readonly Record<string, unknown>[]
      readonly nextCursor: string | null
    }
    expect(beforePage.items).toHaveLength(1)
    expect(beforePage.nextCursor).toBeNull()
    expect(beforePage.items[0]).toMatchObject({
      sequence: 1,
      runId,
      toolCallId: TOOL_CALL_ID,
      toolName: 'remember',
      adapterRef: 'memory.pending-proposal',
      adapterRevision: '1',
      operationKind: 'inverse',
      status: 'available',
      expiresAt: null,
      resolvedAt: null,
    })
    const offerId = String(beforePage.items[0]?.['offerId'])
    const publicOffer = JSON.stringify(beforePage)
    expect(publicOffer).not.toContain(PRIVATE_CONTENT)
    expect(publicOffer).not.toContain(String(pending['id']))
    expect(publicOffer).not.toContain('targetRef')
    expect(publicOffer).not.toContain('targetRevision')
    expect(publicOffer).not.toContain('targetProfileId')
    expect(publicOffer).not.toContain('targetThreadId')

    const effects = await first.client.get<{
      readonly items: readonly Record<string, unknown>[]
    }>(`/api/v1/runs/${runId}/effect-receipts`)
    expect(effects.status).toBe(200)
    expect(effects.body.items).toContainEqual(expect.objectContaining({
      toolCallId: TOOL_CALL_ID,
      kind: 'authority_confirmed',
      outcome: 'succeeded',
      consequence: 'effect_confirmed',
      authorityKind: 'effect_observer',
      authorityRef: 'memory.pending-proposal:1',
    }))

    await first.stop({ cleanup: false })
    first = undefined
    restarted = new OwnwareGateway({
      port: 0,
      tls: false,
      disableAuth: false,
      profilesDir: join(retainedTmpDir, 'profiles'),
      dataDir: join(retainedTmpDir, 'data'),
      dbPath: join(retainedTmpDir, 'test.db'),
    })
    await restarted.start()

    const afterRestart = await fetchWithAuth(
      restarted,
      `/api/v1/runs/${runId}/reversal-offers`,
    )
    expect(afterRestart.status).toBe(200)
    expect(await afterRestart.json()).toEqual(beforePage)

    const invalidKey = await fetchWithAuth(
      restarted,
      `/api/v1/runs/${runId}/reversal-offers/${offerId}/execute`,
      { method: 'POST', headers: { 'Idempotency-Key': 'not-a-uuid' } },
    )
    expect(invalidKey.status).toBe(400)
    expect(await invalidKey.json()).toMatchObject({ error: 'idempotency_key_invalid' })

    const idempotencyKey = randomUUID()
    const executed = await fetchWithAuth(
      restarted,
      `/api/v1/runs/${runId}/reversal-offers/${offerId}/execute`,
      { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } },
    )
    expect(executed.status).toBe(200)
    expect(executed.headers.get('cache-control')).toBe('no-store')
    const execution = await executed.json() as Record<string, any>
    expect(execution).toMatchObject({
      disposition: 'executed',
      offer: { offerId, runId, status: 'confirmed' },
      receipt: {
        sequence: 1,
        offerId,
        runId,
        outcome: 'confirmed',
        authorityRef: 'memory.pending-proposal:1',
        actorKind: 'owner',
      },
    })
    expect(JSON.stringify(execution)).not.toContain(PRIVATE_CONTENT)
    expect(JSON.stringify(execution)).not.toContain(String(pending['id']))

    const resolved = restarted.state.rawDbHandle.prepare(`
      SELECT id, status, proposed_content, resolution_authority_ref
      FROM memory_proposals WHERE id = ?
    `).get(pending['id']) as Record<string, unknown>
    expect(resolved).toMatchObject({
      id: pending['id'],
      status: 'rejected',
      proposed_content: PRIVATE_CONTENT,
      resolution_authority_ref: offerId,
    })

    const replayed = await fetchWithAuth(
      restarted,
      `/api/v1/runs/${runId}/reversal-offers/${offerId}/execute`,
      { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } },
    )
    expect(replayed.status).toBe(200)
    expect(replayed.headers.get('idempotency-replayed')).toBe('true')
    expect(await replayed.json()).toMatchObject({
      disposition: 'replayed',
      receipt: { receiptId: execution['receipt']['receiptId'] },
    })

    const receiptResponse = await fetchWithAuth(
      restarted,
      `/api/v1/runs/${runId}/reversal-receipts`,
    )
    expect(receiptResponse.status).toBe(200)
    const receiptPage = await receiptResponse.json() as {
      readonly items: readonly Record<string, unknown>[]
    }
    expect(receiptPage.items).toHaveLength(1)
    expect(receiptPage.items[0]).toEqual(execution['receipt'])
    expect(JSON.stringify(receiptPage)).not.toContain(PRIVATE_CONTENT)
    expect(JSON.stringify(receiptPage)).not.toContain(String(pending['id']))
  }, 30_000)
})
