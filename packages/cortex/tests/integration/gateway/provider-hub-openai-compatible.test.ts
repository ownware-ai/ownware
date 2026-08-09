import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'

let gateway: OwnwareGateway
let fixture: Server
let baseUrl: string
let fixtureBaseUrl: string
let profilesDir: string
let dataDir: string
let connectionId: string
let fixtureCredentialHeader: string | undefined

const originalSkipRegistry = process.env['OWNWARE_SKIP_MCP_REGISTRY']

beforeAll(async () => {
  process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'
  profilesDir = await mkdtemp(join(tmpdir(), 'cortex-compatible-profiles-'))
  dataDir = await mkdtemp(join(tmpdir(), 'cortex-compatible-data-'))
  const profileDir = join(profilesDir, 'compatible-fixture')
  await mkdir(profileDir)
  await writeFile(
    join(profileDir, 'agent.json'),
    JSON.stringify({ name: 'Compatible fixture', model: 'anthropic:fixture-placeholder' }),
  )
  fixture = createServer((req, res) => {
    fixtureCredentialHeader = typeof req.headers['x-api-key'] === 'string'
      ? req.headers['x-api-key']
      : undefined
    if (req.url === '/v1/chat/completions') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream')
      res.write('data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","created":1,"model":"fixture-discovered","choices":[{"index":0,"delta":{"content":"compatible hello"},"finish_reason":null}]}\n\n')
      res.write('data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","created":1,"model":"fixture-discovered","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
      res.end('data: [DONE]\n\n')
      return
    }
    if (req.url !== '/v1/models') {
      res.statusCode = 404
      res.end()
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'fixture-discovered', object: 'model', created: 1, owned_by: 'fixture' }],
    }))
  })
  await new Promise<void>((resolve, reject) => {
    fixture.once('error', reject)
    fixture.listen(0, '127.0.0.1', resolve)
  })
  const fixtureAddress = fixture.address()
  if (fixtureAddress == null || typeof fixtureAddress === 'string') throw new Error('fixture did not bind')
  fixtureBaseUrl = `http://127.0.0.1:${fixtureAddress.port}/v1`

  gateway = new OwnwareGateway({
    port: 0,
    profilesDir,
    dataDir,
    tls: false,
    disableAuth: true,
    disableAccessLog: true,
    disableRateLimit: true,
  })
  await gateway.start()
  baseUrl = `http://127.0.0.1:${gateway.port}`
}, 20_000)

afterAll(async () => {
  await gateway.stop()
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  await rm(profilesDir, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
  if (originalSkipRegistry == null) delete process.env['OWNWARE_SKIP_MCP_REGISTRY']
  else process.env['OWNWARE_SKIP_MCP_REGISTRY'] = originalSkipRegistry
})

describe('Provider Hub OpenAI-compatible gateway lifecycle', () => {
  it('creates, discovers, projects, and removes a loopback connection', async () => {
    const created = await json('/api/v1/provider-hub/connections/openai-compatible', {
      method: 'POST',
      body: {
        label: 'Fixture inference',
        baseUrl: fixtureBaseUrl,
        auth: { kind: 'none' },
        manualModelIds: ['fixture-manual'],
        discoveryEnabled: true,
      },
    })
    expect(created.status).toBe(201)
    connectionId = String(created.body.id)
    expect(connectionId).toMatch(/^oai_[a-f0-9]{12}$/)

    const discovered = await json(
      `/api/v1/provider-hub/connections/openai-compatible/${connectionId}/discover`,
      { method: 'POST' },
    )
    expect(discovered.status).toBe(200)
    expect(discovered.body.discoveredModelIds).toEqual(['fixture-discovered'])

    const models = await json(
      `/api/v1/provider-hub/models?providerRouteId=route%3A${connectionId}&scope=connected`,
    )
    expect(models.status).toBe(200)
    expect(models.body.items.map((item: { model: { id: string } }) => item.model.id)).toEqual([
      `${connectionId}:fixture-discovered`,
      `${connectionId}:fixture-manual`,
    ])
    expect(models.body.items.every((item: { prices: unknown[] }) => item.prices.length === 0)).toBe(true)
    expect(models.body.items.every((item: { model: { availability: { verified: boolean } } }) => (
      item.model.availability.verified === false
    ))).toBe(true)

    const removed = await json(
      `/api/v1/provider-hub/connections/openai-compatible/${connectionId}`,
      { method: 'DELETE' },
    )
    expect(removed.status).toBe(200)
    const configs = await json('/api/v1/provider-hub/connections/openai-compatible')
    expect(configs.body.items).toEqual([])
  })

  it('accepts a key without returning or persisting it in provider config', async () => {
    const plaintext = 'fixture-secret-never-return'
    const created = await json('/api/v1/provider-hub/connections/openai-compatible', {
      method: 'POST',
      body: {
        label: 'Authenticated fixture',
        baseUrl: fixtureBaseUrl,
        auth: { kind: 'header', name: 'x-api-key', prefix: 'Key ', key: plaintext },
        manualModelIds: [],
        discoveryEnabled: true,
        compatibility: { maxTokensField: 'max_tokens', streamUsage: 'include' },
      },
    })
    expect(created.status).toBe(201)
    expect(JSON.stringify(created.body)).not.toContain(plaintext)
    connectionId = String(created.body.id)

    const discovered = await json(
      `/api/v1/provider-hub/connections/openai-compatible/${connectionId}/discover`,
      { method: 'POST' },
    )
    expect(discovered.status).toBe(200)
    expect(fixtureCredentialHeader).toBe(`Key ${plaintext}`)
    expect(JSON.stringify(discovered.body)).not.toContain(plaintext)
    expect(discovered.body.health.status).toBe('healthy')

    const run = await json('/api/v1/run', {
      method: 'POST',
      body: {
        profileId: 'compatible-fixture',
        prompt: 'Answer through the compatible fixture.',
        model: `${connectionId}:fixture-discovered`,
      },
    })
    expect(run.status).toBe(200)
    expect(run.body.model).toBe(`${connectionId}:fixture-discovered`)
    const eventText = await readRunToTerminal(String(run.body.runId))
    expect(eventText).toContain('compatible hello')
    expect(eventText).toContain('turn.end')

    const configs = await json('/api/v1/provider-hub/connections/openai-compatible')
    expect(JSON.stringify(configs.body)).not.toContain(plaintext)
    expect(configs.body.items[0].compatibility).toEqual({
      maxTokensField: 'max_tokens',
      streamUsage: 'include',
    })

    const removed = await json(
      `/api/v1/provider-hub/connections/openai-compatible/${connectionId}`,
      { method: 'DELETE' },
    )
    expect(removed.status).toBe(200)
    const credentials = await json('/api/v1/credentials?category=llm')
    expect(credentials.body.credentials ?? credentials.body).toEqual([])
  }, 15_000)
})

async function readRunToTerminal(runId: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch(`${baseUrl}/api/v1/runs/${runId}/events`, {
      signal: controller.signal,
    })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('turn.end')) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    await reader.cancel()
    return text
  } finally {
    clearTimeout(timeout)
  }
}

async function json(
  path: string,
  options: { readonly method?: string; readonly body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: options.body == null ? {} : { 'content-type': 'application/json' },
    body: options.body == null ? undefined : JSON.stringify(options.body),
  })
  return { status: response.status, body: await response.json() }
}
