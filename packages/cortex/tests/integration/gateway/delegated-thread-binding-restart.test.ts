import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  registerProvider,
  unregisterProvider,
  type ProviderAdapter,
  type ProviderChunk,
} from '@ownware/loom'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'

const PROVIDER_NAME = 'delegatedbindingtest'
const PROFILE_ID = 'delegated-binding-test'

const deterministicProvider: ProviderAdapter = {
  name: PROVIDER_NAME,
  async *stream(): AsyncGenerator<ProviderChunk> {
    yield { type: 'text_delta', text: 'completed' }
    yield {
      type: 'message_complete',
      content: [{ type: 'text', text: 'completed' }],
      stopReason: 'end_turn',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    }
  },
  async countTokens(): Promise<number> {
    return 1
  },
  supportsFeature(): boolean {
    return false
  },
  formatTools(): unknown[] {
    return []
  },
  getModelPricing() {
    return null
  },
}

describe('delegated thread authority across restart', () => {
  const cleanup: string[] = []
  let gateway: TestGateway | undefined

  afterEach(async () => {
    await gateway?.stop()
    gateway = undefined
    unregisterProvider(PROVIDER_NAME)
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('keeps a delegated-created thread unavailable to another subject', async () => {
    const persistent = await mkdtemp(join(tmpdir(), 'delegated-thread-restart-'))
    cleanup.push(persistent)
    const dbPath = join(persistent, 'ownware.db')
    registerProvider(deterministicProvider)
    gateway = await createTestGateway({
      disableAuth: false,
      dbPath,
      profiles: [{
        name: PROFILE_ID,
        model: `${PROVIDER_NAME}:model`,
        tools: { preset: 'none' },
      }],
    })
    const firstTmp = gateway.tmpDir
    const workspaceId = (await gateway.state.createWorkspace(firstTmp, 'Thread binding restart')).id

    const issue = async (subjectId: string) => {
      const response = await gateway!.client.post('/api/v1/auth/delegations', {
        delegateId: `browser-${subjectId}`,
        workspaceId,
        profileId: PROFILE_ID,
        subjectId,
        purpose: 'customer-support',
        channel: 'web',
        operations: ['runs.start'],
      })
      expect(response.status).toBe(201)
      return (response.body as { token: string }).token
    }
    const subjectAToken = await issue('subject-a')
    const startedResponse = await fetch(`${gateway.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${subjectAToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      },
      body: JSON.stringify({ profileId: PROFILE_ID, workspaceId, prompt: 'subject A turn' }),
    })
    expect(startedResponse.status).toBe(200)
    const { threadId } = await startedResponse.json() as { threadId: string }
    const deadline = Date.now() + 10_000
    while (gateway.runner.isRunning(threadId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(gateway.runner.isRunning(threadId)).toBe(false)

    await gateway.stop({ cleanup: false })
    gateway = await createTestGateway({
      disableAuth: false,
      dbPath,
      profiles: [{
        name: PROFILE_ID,
        model: `${PROVIDER_NAME}:model`,
        tools: { preset: 'none' },
      }],
    })
    cleanup.push(firstTmp)
    const refreshedSubjectAToken = await issue('subject-a')
    const continued = await fetch(`${gateway.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${refreshedSubjectAToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      },
      body: JSON.stringify({
        profileId: PROFILE_ID, workspaceId, threadId, prompt: 'subject A after restart',
      }),
    })
    expect(continued.status).toBe(200)
    const continuedDeadline = Date.now() + 10_000
    while (gateway.runner.isRunning(threadId) && Date.now() < continuedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(gateway.runner.isRunning(threadId)).toBe(false)
    const beforeMessages = (await gateway.state.getMessages(threadId)).length
    const subjectBToken = await issue('subject-b')
    const denied = await fetch(`${gateway.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${subjectBToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      },
      body: JSON.stringify({
        profileId: PROFILE_ID, workspaceId, threadId, prompt: 'subject B turn',
      }),
    })
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({ error: 'principal_scope_denied' })
    await expect(gateway.state.getMessages(threadId)).resolves.toHaveLength(beforeMessages)
  })
})
