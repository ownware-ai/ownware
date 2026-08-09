import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { providerCommand } from '../../../src/cli/provider.js'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { parseVerificationEvidenceBundleText } from '../../../src/provider-hub/index.js'

const RESPONSE_CANARY = 'provider-response-canary-must-not-persist'
const PROMPT_CANARY = 'Reply with the word OK.'
const originalSkipRegistry = process.env['OWNWARE_SKIP_MCP_REGISTRY']

let fixture: Server
let fixtureBaseUrl: string
let gateway: OwnwareGateway
let gatewayBaseUrl: string
let profilesDir: string
let dataDir: string
let requestBody = ''

beforeAll(async () => {
  process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'
  profilesDir = await mkdtemp(join(tmpdir(), 'ownware-provider-verify-profiles-'))
  dataDir = await mkdtemp(join(tmpdir(), 'ownware-provider-verify-data-'))
  const profileDir = join(profilesDir, 'fixture')
  await mkdir(profileDir)
  await writeFile(join(profileDir, 'agent.json'), JSON.stringify({
    name: 'Verification fixture',
    model: 'anthropic:fixture-placeholder',
  }))

  fixture = createServer((req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.statusCode = 404
      res.end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      requestBody = Buffer.concat(chunks).toString('utf8')
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream')
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-verification',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [{ index: 0, delta: { content: RESPONSE_CANARY }, finish_reason: null }],
      })}\n\n`)
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-verification',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
      })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
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
  gatewayBaseUrl = `http://127.0.0.1:${gateway.port}`
}, 20_000)

afterAll(async () => {
  await gateway.stop()
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  await rm(profilesDir, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
  if (originalSkipRegistry == null) delete process.env['OWNWARE_SKIP_MCP_REGISTRY']
  else process.env['OWNWARE_SKIP_MCP_REGISTRY'] = originalSkipRegistry
})

describe('provider-route verification flow', () => {
  it('persists disposable live evidence and serves the same normalized facts through Provider Hub', async () => {
    const created = await json('/api/v1/provider-hub/connections/openai-compatible', {
      method: 'POST',
      body: {
        label: 'Verification fixture',
        baseUrl: fixtureBaseUrl,
        auth: { kind: 'none' },
        manualModelIds: ['fixture-model'],
        discoveryEnabled: false,
        compatibility: { maxTokensField: 'max_tokens', streamUsage: 'include' },
      },
    })
    expect(created.status).toBe(201)
    const adapterId = String(created.body.id)
    const providerRouteId = `route:${adapterId}`
    const modelRouteId = `${adapterId}:fixture-model`

    const before = await json(
      `/api/v1/provider-hub/models?providerRouteId=${encodeURIComponent(providerRouteId)}&scope=connected`,
    )
    expect(before.status).toBe(200)
    expect(before.body.items).toHaveLength(1)
    expect(before.body.items[0].model.availability.verified).toBe(false)
    const overview = await json('/api/v1/provider-hub')
    const catalogGenerationId = String(overview.body.generation.id)

    const outputPath = join(dataDir, 'provider-hub', 'verification-evidence.json')
    const stdout: string[] = []
    await providerCommand(['verify'], {
      env: {
        OWNWARE_PROVIDER_VERIFY_LIVE: '1',
        OWNWARE_PROVIDER_VERIFY_ADAPTER: 'openai-compatible',
        OWNWARE_PROVIDER_VERIFY_ADAPTER_ID: adapterId,
        OWNWARE_PROVIDER_VERIFY_MODEL: 'fixture-model',
        OWNWARE_PROVIDER_VERIFY_PROVIDER_ROUTE_ID: providerRouteId,
        OWNWARE_PROVIDER_VERIFY_MODEL_ROUTE_ID: modelRouteId,
        OWNWARE_PROVIDER_VERIFY_CATALOG_GENERATION_ID: catalogGenerationId,
        OWNWARE_PROVIDER_VERIFY_OUTPUT: outputPath,
        OWNWARE_PROVIDER_VERIFY_BASE_URL: fixtureBaseUrl,
        OWNWARE_PROVIDER_VERIFY_AUTH_KIND: 'none',
        OWNWARE_PROVIDER_VERIFY_STREAM_USAGE: '1',
      },
      stdout: value => stdout.push(value),
    })

    expect(stdout).toHaveLength(1)
    const receipt = JSON.parse(stdout[0]!) as {
      bundleId: string
      evidenceId: string
      results: Array<{ probeId: string; status: string }>
    }
    expect(receipt.results).toEqual([
      { probeId: 'text_streaming', status: 'passed' },
      { probeId: 'terminal_events', status: 'passed' },
      { probeId: 'usage_reporting', status: 'passed' },
    ])
    expect(JSON.parse(requestBody)).toMatchObject({
      model: 'fixture-model',
      stream: true,
      stream_options: { include_usage: true },
    })

    const persistedText = await readFile(outputPath, 'utf8')
    const persisted = parseVerificationEvidenceBundleText(persistedText)
    expect(persisted.bundleId).toBe(receipt.bundleId)
    expect(persisted.entries[0]?.evidenceId).toBe(receipt.evidenceId)

    const verifications = await json('/api/v1/provider-hub/verifications')
    expect(verifications.status).toBe(200)
    expect(verifications.body.bundle.bundleId).toBe(receipt.bundleId)
    expect(verifications.body.bundle.entries[0].evidenceId).toBe(receipt.evidenceId)

    const after = await json(
      `/api/v1/provider-hub/models?providerRouteId=${encodeURIComponent(providerRouteId)}&scope=connected`,
    )
    expect(after.body.warnings).not.toEqual(expect.arrayContaining([
      expect.stringContaining('different catalog generation'),
      expect.stringContaining('does not match the provider route transport'),
    ]))
    const capabilities = new Map(after.body.items[0].model.capabilities.map(
      (capability: { capability: string; ownware: { status: string } }) => [
        capability.capability,
        capability.ownware.status,
      ],
    ))
    expect(capabilities.get('text_streaming')).toBe('verified')
    expect(capabilities.get('terminal_events')).toBe('verified')
    expect(capabilities.get('usage_reporting')).toBe('verified')
    expect(after.body.items[0].model.availability.verified).toBe(false)

    const exposed = `${stdout[0]}\n${persistedText}\n${JSON.stringify(verifications.body)}`
    expect(exposed).not.toContain(RESPONSE_CANARY)
    expect(exposed).not.toContain(PROMPT_CANARY)
    expect(exposed).not.toContain(fixtureBaseUrl)
  }, 20_000)
})

async function json(
  path: string,
  options: { readonly method?: string; readonly body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${gatewayBaseUrl}${path}`, {
    method: options.method,
    headers: options.body == null ? {} : { 'content-type': 'application/json' },
    body: options.body == null ? undefined : JSON.stringify(options.body),
  })
  return { status: response.status, body: await response.json() }
}
