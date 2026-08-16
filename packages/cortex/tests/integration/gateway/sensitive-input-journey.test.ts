import { createServer, type Server } from 'node:http'
import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  connectBrowser,
  getPage,
  registerProvider,
  unregisterProvider,
  type Message,
  type ProviderAdapter,
  type ProviderChunk,
  type ProviderFeature,
  type ProviderRequest,
  type ToolDefinition,
} from '@ownware/loom'
import { SENSITIVE_INPUT_INTERACTION_CAPABILITY } from '../../../src/gateway/types.js'
import {
  createTestGateway,
  type TestGateway,
} from '../../framework/harness/index.js'

const PROVIDER_NAME = 'sensitivejourney'
const PROFILE_ID = 'sensitive-browser-journey'
const SECRET = 'plain\nJSON:{"token":"秘密🔐"}'
const PAGE_NORMALIZED_SECRET = SECRET.split('\n').join(' ')

function expectNoSecret(value: string): void {
  const representations = new Set([
    SECRET,
    JSON.stringify(SECRET).slice(1, -1),
    PAGE_NORMALIZED_SECRET,
    JSON.stringify(PAGE_NORMALIZED_SECRET).slice(1, -1),
  ])
  for (const representation of representations) {
    expect(value).not.toContain(representation)
  }
}

function deterministicProvider(requests: ProviderRequest[]): ProviderAdapter {
  let sensitiveStep = 0
  return {
    name: PROVIDER_NAME,
    async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      requests.push(request)
      const hasSensitiveTool = request.tools.some(tool =>
        tool.name === 'browser_sensitive_type')
      if (!hasSensitiveTool || sensitiveStep > 1) {
        yield { type: 'text_delta', text: 'done' }
        yield {
          type: 'message_complete',
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'end_turn',
          usage: {
            inputTokens: 5,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        }
        return
      }

      const isSensitiveStep = sensitiveStep++ === 0
      const id = isSensitiveStep ? 'sensitive-call' : 'capture-after-sensitive'
      const name = isSensitiveStep ? 'browser_sensitive_type' : 'browser_snapshot'
      const input = isSensitiveStep
        ? { selector: '#password', submit: false }
        : {}
      yield { type: 'tool_use_start', id, name }
      yield { type: 'tool_use_args_delta', id, delta: JSON.stringify(input) }
      yield { type: 'tool_use_end', id }
      yield {
        type: 'message_complete',
        content: [{
          type: 'tool_use',
          id,
          name,
          input,
        }],
        stopReason: 'tool_use',
        usage: {
          inputTokens: 5,
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
      return null
    },
  }
}

async function waitForRunToStop(gateway: TestGateway, threadId: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (gateway.runner.isRunning(threadId) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(gateway.runner.isRunning(threadId)).toBe(false)
}

describe('sensitive input through the public Gateway and a real managed browser', () => {
  let gateway: TestGateway | undefined
  let fixtureServer: Server | undefined

  afterEach(async () => {
    await gateway?.stop()
    gateway = undefined
    if (fixtureServer !== undefined) {
      await new Promise<void>(resolve => fixtureServer!.close(() => resolve()))
      fixtureServer = undefined
    }
    unregisterProvider(PROVIDER_NAME)
    vi.restoreAllMocks()
  })

  it('negotiates the tool, injects once, and keeps the value out of model, SSE, DB, logs, messages and snapshots', async () => {
    fixtureServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><label>Password <input id="password" type="password" autocomplete="current-password"></label>')
    })
    await new Promise<void>(resolve => fixtureServer!.listen(0, '127.0.0.1', resolve))
    const address = fixtureServer.address()
    if (address === null || typeof address === 'string') throw new Error('missing fixture port')
    const origin = `http://127.0.0.1:${address.port}`

    const providerRequests: ProviderRequest[] = []
    registerProvider(deterministicProvider(providerRequests))
    gateway = await createTestGateway({
      profiles: [{
        name: PROFILE_ID,
        model: `${PROVIDER_NAME}:model`,
        tools: { preset: 'full' },
        browser: {
          autoLaunch: true,
          headless: true,
          readyTimeoutMs: 20_000,
          extraArgs: [origin],
        },
        security: {
          permissionMode: 'auto',
          zones: { enabled: false },
        },
      }],
    })

    const unsupported = await gateway.client.post('/api/v1/run', {
      profileId: PROFILE_ID,
      prompt: 'capability control',
    })
    expect(unsupported.status).toBe(200)
    const unsupportedThreadId = String(unsupported.body['threadId'])
    await waitForRunToStop(gateway, unsupportedThreadId)
    expect(providerRequests[0]?.tools.some(tool =>
      tool.name === 'browser_sensitive_type')).toBe(false)
    expect(gateway.state.getChromeLaunch(unsupportedThreadId)).toBeUndefined()

    const widenedCachedThread = await gateway.client.post('/api/v1/run', {
      profileId: PROFILE_ID,
      threadId: unsupportedThreadId,
      prompt: 'try to widen the existing thread',
      interactionCapabilities: [SENSITIVE_INPUT_INTERACTION_CAPABILITY],
    })
    expect(widenedCachedThread.status).toBe(409)
    expect(widenedCachedThread.body).toMatchObject({
      error: 'interaction_capabilities_session_mismatch',
    })
    expect(providerRequests).toHaveLength(1)

    const logSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ]
    const started = await gateway.client.post('/api/v1/run', {
      profileId: PROFILE_ID,
      prompt: 'enter the password',
      interactionCapabilities: [SENSITIVE_INPUT_INTERACTION_CAPABILITY],
    })
    expect(started.status).toBe(200)
    const runId = String(started.body['runId'])
    const threadId = String(started.body['threadId'])

    const requestDeadline = Date.now() + 20_000
    let rows = await gateway.state.listAgentEvents({ threadId, agentId: 'root' })
    let requestRow = rows.find(row => row.type === 'sensitive.input.request')
    while (requestRow === undefined && Date.now() < requestDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      rows = await gateway.state.listAgentEvents({ threadId, agentId: 'root' })
      requestRow = rows.find(row => row.type === 'sensitive.input.request')
    }
    expect(requestRow).toBeDefined()
    expect(requestRow!.payload).not.toHaveProperty('binding')
    const requestId = String(requestRow!.payload['requestId'])

    const submitResponse = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/sensitive-input/${encodeURIComponent(requestId)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${gateway.token}`,
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body: SECRET,
      },
    )
    expect(submitResponse.status).toBe(200)
    expect(submitResponse.headers.get('cache-control')).toBe('no-store')
    const submitBody = await submitResponse.text()
    expectNoSecret(submitBody)
    expect(JSON.parse(submitBody)).toMatchObject({
      runId,
      requestId,
      accepted: true,
      status: 'provided',
    })

    await waitForRunToStop(gateway, threadId)

    const runningChrome = gateway.state.getChromeLaunch(threadId)
    expect(runningChrome).toBeDefined()
    const connection = await connectBrowser(runningChrome!.cdpUrl)
    const page = await getPage(connection)
    expect(page.url()).toBe(origin + '/')
    // HTML single-line inputs normalize line breaks. The page is the intended
    // recipient, so observe that authoritative browser result explicitly
    // without claiming byte-for-byte remote application.
    await expect(page.locator('#password').inputValue())
      .resolves.toBe(PAGE_NORMALIZED_SECRET)

    const storedEvents = await gateway.state.listAgentEvents({
      threadId,
      agentId: 'root',
    })
    expect(storedEvents.some(row => row.type === 'sensitive.input.response')).toBe(true)
    expect(storedEvents.find(row =>
      row.type === 'tool.call.end'
      && row.payload['toolName'] === 'browser_snapshot',
    )?.payload).toMatchObject({ isError: true })
    expectNoSecret(JSON.stringify(storedEvents))

    const streamResponse = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/events?since=0`,
      { headers: { Authorization: `Bearer ${gateway.token}` } },
    )
    expect(streamResponse.status).toBe(200)
    const streamBody = await streamResponse.text()
    expect(streamBody).toContain('event: sensitive.input.request')
    expect(streamBody).toContain('event: sensitive.input.response')
    expectNoSecret(streamBody)

    const snapshotResponse = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${encodeURIComponent(runId)}`,
      { headers: { Authorization: `Bearer ${gateway.token}` } },
    )
    expect(snapshotResponse.status).toBe(200)
    expectNoSecret(await snapshotResponse.text())
    expectNoSecret(JSON.stringify(await gateway.state.getMessages(threadId)))
    expectNoSecret(JSON.stringify(providerRequests.map(request => ({
      model: request.model,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      providerOptions: request.providerOptions,
    }))))
    expectNoSecret(logSpies
      .flatMap(spy => spy.mock.calls)
      .flatMap(call => call.map(value => inspect(value, { depth: 10 })))
      .join('\n'))

    const replay = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/sensitive-input/${encodeURIComponent(requestId)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${gateway.token}`,
          'Content-Type': 'text/plain',
        },
        body: 'replacement',
      },
    )
    expect(replay.status).toBe(409)
  }, 45_000)
})
