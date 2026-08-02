import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import {
  createTestGateway,
  type TestGateway,
} from '../../framework/harness/index.js'

interface ThreadResponse {
  readonly id: string
  readonly profileId: string
  readonly title: string | null
}

interface ThreadListResponse {
  readonly items: readonly ThreadResponse[]
}

interface SearchResponse {
  readonly type: string
  readonly id: string
  readonly name: string
}

interface HydrateResponse {
  readonly thread: ThreadResponse & {
    readonly messageCount: number
    readonly totalTokens: number
    readonly totalCost: number
  }
  readonly messages: ReadonlyArray<{
    readonly id: string
    readonly role: string
    readonly content: string
    readonly thinking?: string
    readonly tools?: ReadonlyArray<{
      readonly name: string
      readonly input: unknown
      readonly output?: string
    }>
    readonly usage?: {
      readonly inputTokens: number
      readonly outputTokens: number
    }
  }>
}

async function json<T>(
  gateway: OwnwareGateway,
  path: string,
  init?: RequestInit,
): Promise<{ readonly status: number; readonly body: T }> {
  const response = await fetch(`http://127.0.0.1:${gateway.port}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${gateway.token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  return { status: response.status, body: await response.json() as T }
}

describe('SQLite storage value gateway journey', () => {
  let first: TestGateway | undefined
  let restarted: OwnwareGateway | undefined
  let retainedTmpDir: string | undefined

  afterEach(async () => {
    await restarted?.stop()
    if (first !== undefined) await first.stop({ cleanup: false })
    if (retainedTmpDir !== undefined) {
      await rm(retainedTmpDir, { recursive: true, force: true })
    }
  })

  it('lists, searches and hydrates typed values through HTTP after restart', async () => {
    first = await createTestGateway()
    retainedTmpDir = first.tmpDir
    const title = 'Adapter Ω storage journey'
    const created = await json<ThreadResponse>(first.gateway, '/api/v1/threads', {
      method: 'POST',
      body: JSON.stringify({ profileId: 'mini', title }),
    })
    expect(created.status).toBe(201)

    const message = {
      id: 'msg_storage_value_journey',
      role: 'assistant' as const,
      content: 'line one\nline two\0',
      thinking: 'typed storage boundary',
      tools: [{
        name: 'storage_probe',
        input: { z: 1, a: [true, null, 1.25] },
        output: 'ok',
        isError: false,
        durationMs: 7,
      }],
      usage: { inputTokens: 9, outputTokens: 4 },
      timestamp: '2026-08-02T04:05:06.123Z',
    }
    await first.state.addMessage(created.body.id, message)
    await first.state.updateThread(created.body.id, {
      messageCount: 1,
      totalTokens: 13,
      totalCost: 0.000_001_25,
    })

    const beforeList = await json<ThreadListResponse>(
      first.gateway,
      '/api/v1/threads?profileId=mini',
    )
    expect(beforeList.status).toBe(200)
    expect(beforeList.body.items.map((thread) => thread.id)).toContain(created.body.id)

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

    const list = await json<ThreadListResponse>(
      restarted,
      '/api/v1/threads?profileId=mini',
    )
    expect(list.status).toBe(200)
    expect(list.body.items).toContainEqual(expect.objectContaining({
      id: created.body.id,
      profileId: 'mini',
      title,
    }))

    const search = await json<readonly SearchResponse[]>(
      restarted,
      `/api/v1/search?scope=threads&q=${encodeURIComponent('adapter Ω')}`,
    )
    expect(search.status).toBe(200)
    expect(search.body).toContainEqual(expect.objectContaining({
      type: 'thread',
      id: created.body.id,
      name: title,
    }))

    const hydrate = await json<HydrateResponse>(
      restarted,
      `/api/v1/threads/${created.body.id}/hydrate`,
    )
    expect(hydrate.status).toBe(200)
    expect(hydrate.body.thread).toMatchObject({
      id: created.body.id,
      messageCount: 1,
      totalTokens: 13,
      totalCost: 0.000_001_25,
    })
    expect(hydrate.body.messages).toContainEqual(expect.objectContaining({
      id: message.id,
      content: message.content,
      thinking: message.thinking,
      tools: [expect.objectContaining({
        name: 'storage_probe',
        input: message.tools[0]!.input,
        output: 'ok',
      })],
      usage: message.usage,
    }))
  }, 30_000)
})
