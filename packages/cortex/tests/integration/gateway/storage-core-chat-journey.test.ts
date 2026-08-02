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
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import {
  createTestGateway,
  type TestGateway,
} from '../../framework/harness/index.js'

const PROVIDER_NAME = 'storagejourney'

function deterministicProvider(): ProviderAdapter {
  return {
    name: PROVIDER_NAME,
    async *stream(_request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      yield { type: 'text_delta', text: 'hello ' }
      await new Promise((resolve) => setTimeout(resolve, 100))
      yield { type: 'text_delta', text: 'durable world' }
      await new Promise((resolve) => setTimeout(resolve, 25))
      yield {
        type: 'message_complete',
        content: [{ type: 'text', text: 'hello durable world' }],
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

interface StreamEvent {
  readonly event: string
  readonly data: Record<string, unknown>
}

async function readStreamUntil(
  response: Response,
  predicate: (events: readonly StreamEvent[]) => boolean,
  timeoutMs = 5_000,
): Promise<StreamEvent[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const events: StreamEvent[] = []
  let buffer = ''
  const deadline = Date.now() + timeoutMs

  try {
    while (Date.now() < deadline && !predicate(events)) {
      const remaining = deadline - Date.now()
      const result = await Promise.race([
        reader.read(),
        new Promise<{ readonly done: true; readonly value: undefined }>((resolve) => {
          setTimeout(() => resolve({ done: true, value: undefined }), Math.min(remaining, 100))
        }),
      ])
      if (result.done && result.value === undefined) continue
      if (result.done) break
      buffer += decoder.decode(result.value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        let event = 'message'
        let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7)
          if (line.startsWith('data: ')) data = line.slice(6)
        }
        if (data !== '') events.push({ event, data: JSON.parse(data) as Record<string, unknown> })
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  if (!predicate(events)) throw new Error('Timed out waiting for the expected SSE boundary')
  return events
}

async function fetchWithAuth(gateway: OwnwareGateway, path: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${gateway.port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${gateway.token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
}

describe('core chat storage journey', () => {
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

  it('runs, disconnects, resumes, hydrates and replays after restart', async () => {
    registerProvider(deterministicProvider())
    first = await createTestGateway({
      profiles: [{
        name: 'storage-chat',
        model: `${PROVIDER_NAME}:model`,
        tools: { preset: 'none' },
      }],
    })
    retainedTmpDir = first.tmpDir

    const createResponse = await fetchWithAuth(first.gateway, '/api/v1/threads', {
      method: 'POST',
      body: JSON.stringify({ profileId: 'storage-chat', title: 'Durable chat' }),
    })
    expect(createResponse.status).toBe(201)
    const { id: threadId } = await createResponse.json() as { readonly id: string }

    const firstStream = await fetchWithAuth(
      first.gateway,
      `/api/v1/threads/${threadId}/agents/root/events?since=0`,
    )
    expect(firstStream.status).toBe(200)

    const runResponse = await fetchWithAuth(first.gateway, '/api/v1/run', {
      method: 'POST',
      body: JSON.stringify({
        profileId: 'storage-chat',
        threadId,
        prompt: 'prove durable reconnect',
      }),
    })
    expect(runResponse.status).toBe(200)
    const run = await runResponse.json() as { readonly runId: string }

    const beforeDisconnect = await readStreamUntil(
      firstStream,
      (events) => events.some(({ event }) => event === 'text.delta'),
    )
    const firstText = beforeDisconnect.find(({ event }) => event === 'text.delta')!
    expect(firstText.data['text']).toBe('hello ')
    const cursor = firstText.data['seq'] as number
    expect(cursor).toBeGreaterThan(0)

    const runDeadline = Date.now() + 5_000
    while (first.runner.isRunning(threadId) && Date.now() < runDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(first.runner.isRunning(threadId)).toBe(false)

    const snapshotResponse = await fetchWithAuth(first.gateway, `/api/v1/runs/${run.runId}`)
    expect(snapshotResponse.status).toBe(200)
    await expect(snapshotResponse.json()).resolves.toMatchObject({
      threadId,
      status: 'succeeded',
      terminal: true,
      outcomeKnown: true,
    })

    const resumedResponse = await fetchWithAuth(
      first.gateway,
      `/api/v1/threads/${threadId}/agents/root/events?since=${cursor}`,
    )
    expect(resumedResponse.status).toBe(200)
    const resumed = await readStreamUntil(
      resumedResponse,
      (events) => events.some(({ event }) => event === 'turn.end') &&
        events.some(({ event }) => event === 'stream.replay.complete'),
    )
    const resumedAgentEvents = resumed.filter(({ data }) => typeof data['seq'] === 'number')
    expect(resumedAgentEvents.every(({ data }) => (data['seq'] as number) > cursor)).toBe(true)
    expect(resumed.some(({ event, data }) =>
      event === 'text.delta' && data['text'] === 'durable world')).toBe(true)

    const hydrateBefore = await fetchWithAuth(first.gateway, `/api/v1/threads/${threadId}/hydrate`)
    expect(hydrateBefore.status).toBe(200)
    const beforeSnapshot = await hydrateBefore.json() as {
      readonly thread: { readonly id: string; readonly status: string }
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>
      readonly maxSeq: number
    }
    expect(beforeSnapshot.thread).toMatchObject({ id: threadId, status: 'completed' })
    expect(beforeSnapshot.messages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      content: 'hello durable world',
    }))
    expect(beforeSnapshot.maxSeq).toBeGreaterThan(cursor)

    await first.stop({ cleanup: false })
    first = undefined
    restarted = new OwnwareGateway({
      port: 0,
      tls: false,
      profilesDir: join(retainedTmpDir, 'profiles'),
      dataDir: join(retainedTmpDir, 'data'),
      dbPath: join(retainedTmpDir, 'test.db'),
    })
    await restarted.start()

    const hydrateAfter = await fetchWithAuth(restarted, `/api/v1/threads/${threadId}/hydrate`)
    expect(hydrateAfter.status).toBe(200)
    expect(await hydrateAfter.json()).toEqual(beforeSnapshot)

    const replayResponse = await fetchWithAuth(
      restarted,
      `/api/v1/threads/${threadId}/agents/root/events?since=0`,
    )
    expect(replayResponse.status).toBe(200)
    const replayed = await readStreamUntil(
      replayResponse,
      (events) => events.some(({ event }) => event === 'turn.end') &&
        events.some(({ event }) => event === 'stream.replay.complete'),
    )
    const replayedSeqs = replayed
      .map(({ data }) => data['seq'])
      .filter((seq): seq is number => typeof seq === 'number')
    expect(replayedSeqs).toEqual(Array.from(
      { length: beforeSnapshot.maxSeq },
      (_, index) => index + 1,
    ))
  }, 30_000)
})
