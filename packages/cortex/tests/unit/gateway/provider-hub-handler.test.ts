import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createProviderHubHandlers } from '../../../src/gateway/handlers/provider-hub.js'
import type {
  OpenAICompatibleConnectionManager,
  ProviderHubOverview,
  ProviderHubService,
} from '../../../src/provider-hub/index.js'
import type { UsageEvidenceRepository } from '../../../src/storage/usage-evidence-repository.js'

interface CapturedResponse {
  status?: number
  body?: unknown
}

function request(url: string): IncomingMessage {
  return { url, headers: { host: 'localhost' } } as IncomingMessage
}

function jsonRequest(url: string, body: unknown): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]) as unknown as IncomingMessage
  req.url = url
  req.headers = { host: 'localhost', 'content-type': 'application/json' }
  return req
}

function response(captured: CapturedResponse): ServerResponse {
  return {
    statusCode: 200,
    writeHead(code: number) {
      captured.status = code
      return this
    },
    end(body?: string) {
      if (body != null) captured.body = JSON.parse(body) as unknown
      return this
    },
  } as unknown as ServerResponse
}

function overview(status: ProviderHubOverview['catalogHealth']['status']): ProviderHubOverview {
  return {
    generation: {
      id: 'models-dev:test',
      schemaVersion: 1,
      source: 'bundled',
      generatedAt: '2026-08-08T12:00:00.000Z',
      sha256: 'a'.repeat(64),
    },
    generationId: 'models-dev:test:revision',
    catalogHealth: { status, activeGenerationId: 'models-dev:test' },
    counts: { providers: 1, routes: 1, models: 1, pricebookEntries: 0, connections: 0 },
    warnings: [],
  }
}

describe('provider hub HTTP handlers', () => {
  it('returns the current secret-free verification bundle independently from catalog reads', async () => {
    const verifications = vi.fn(async () => ({
      generationId: 'generation',
      bundle: null,
      warnings: [],
    }))
    const handlers = createProviderHubHandlers({ verifications } as unknown as ProviderHubService)
    const captured: CapturedResponse = {}
    await handlers.verifications(
      request('/api/v1/provider-hub/verifications'),
      response(captured),
    )

    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ generationId: 'generation', bundle: null, warnings: [] })
    expect(verifications).toHaveBeenCalledOnce()
  })

  it('validates and forwards model pagination/filter query parameters', async () => {
    const models = vi.fn(async () => ({
      generationId: 'generation',
      items: [],
      page: { limit: 25, total: 0, nextCursor: null },
      warnings: [],
    }))
    const handlers = createProviderHubHandlers({ models } as unknown as ProviderHubService)
    const captured: CapturedResponse = {}
    await handlers.models(
      request('/api/v1/provider-hub/models?q=claude&scope=connected&limit=25'),
      response(captured),
    )

    expect(captured.status).toBe(200)
    expect(models).toHaveBeenCalledWith({ q: 'claude', scope: 'connected', limit: 25 })
  })

  it('rejects unknown or out-of-range query parameters', async () => {
    const models = vi.fn()
    const handlers = createProviderHubHandlers({ models } as unknown as ProviderHubService)
    const captured: CapturedResponse = {}
    await handlers.models(
      request('/api/v1/provider-hub/models?limit=1000&secret=should-not-pass'),
      response(captured),
    )

    expect(captured.status).toBe(400)
    expect(models).not.toHaveBeenCalled()
  })

  it('returns 202 when a refresh retains a usable but offline last-known-good catalog', async () => {
    const refresh = vi.fn(async () => overview('offline'))
    const handlers = createProviderHubHandlers({ refresh } as unknown as ProviderHubService)
    const captured: CapturedResponse = {}
    await handlers.refresh(
      request('/api/v1/provider-hub/catalog/refresh?force=true'),
      response(captured),
    )

    expect(captured.status).toBe(202)
    expect(refresh).toHaveBeenCalledWith(true)
    expect(captured.body).toMatchObject({ catalogHealth: { status: 'offline' } })
  })

  it('validates and saves a secret-free OpenAI-compatible connection request', async () => {
    const save = vi.fn(async (value: unknown) => value)
    const manager = { save } as unknown as OpenAICompatibleConnectionManager
    const handlers = createProviderHubHandlers({} as ProviderHubService, {
      openAICompatible: manager,
    })
    const captured: CapturedResponse = {}
    await handlers.saveCompatibleConnection(
      jsonRequest('/api/v1/provider-hub/connections/openai-compatible', {
        label: 'Local inference',
        baseUrl: 'http://127.0.0.1:11434/v1',
        auth: { kind: 'none' },
        manualModelIds: ['fixture-model'],
      }),
      response(captured),
    )

    expect(captured.status).toBe(201)
    expect(save).toHaveBeenCalledWith({
      label: 'Local inference',
      baseUrl: 'http://127.0.0.1:11434/v1',
      auth: { kind: 'none' },
      manualModelIds: ['fixture-model'],
      discoveryEnabled: true,
      compatibility: {
        maxTokensField: 'max_tokens',
        streamUsage: 'omit',
      },
    })
  })

  it('maps compatible connection discovery and removal outcomes', async () => {
    const discover = vi.fn(async () => { throw new Error('upstream unavailable') })
    const remove = vi.fn(async () => false)
    const manager = { discover, remove } as unknown as OpenAICompatibleConnectionManager
    const handlers = createProviderHubHandlers({} as ProviderHubService, {
      openAICompatible: manager,
    })
    const discoveryResponse: CapturedResponse = {}
    await handlers.discoverCompatibleModels(
      request('/api/v1/provider-hub/connections/openai-compatible/oai_0123456789ab/discover'),
      response(discoveryResponse),
      { connectionId: 'oai_0123456789ab' },
    )
    expect(discoveryResponse.status).toBe(502)
    expect(discoveryResponse.body).toMatchObject({
      message: 'The endpoint did not return a compatible model list',
    })
    expect(JSON.stringify(discoveryResponse.body)).not.toContain('upstream unavailable')

    const removalResponse: CapturedResponse = {}
    await handlers.removeCompatibleConnection(
      request('/api/v1/provider-hub/connections/openai-compatible/oai_0123456789ab'),
      response(removalResponse),
      { connectionId: 'oai_0123456789ab' },
    )
    expect(removalResponse.status).toBe(404)
  })

  it('reads classification-separated usage and appends only reconciliation', async () => {
    const list = vi.fn(async () => [])
    const appendCostObservation = vi.fn(async (_id, cost) => ({ cost }))
    const usageEvidence = {
      list,
      appendCostObservation,
    } as unknown as UsageEvidenceRepository
    const handlers = createProviderHubHandlers({} as ProviderHubService, { usageEvidence })

    const listResponse: CapturedResponse = {}
    await handlers.usage(
      request('/api/v1/provider-hub/usage?classification=reconciled&limit=25'),
      response(listResponse),
    )
    expect(listResponse.status).toBe(200)
    expect(list).toHaveBeenCalledWith({ classification: 'reconciled', limit: 25 })

    const cost = {
      classification: 'reconciled' as const,
      amountUsd: 0.5,
      currency: 'USD' as const,
      observedAt: '2026-08-09T00:00:00.000Z',
      reconciledAt: '2026-08-09T00:00:00.000Z',
    }
    const writeResponse: CapturedResponse = {}
    await handlers.appendUsageCostObservation(
      jsonRequest('/api/v1/provider-hub/usage/usage-1/cost-observations', cost),
      response(writeResponse),
      { usageId: 'usage-1' },
    )
    expect(writeResponse.status).toBe(201)
    expect(appendCostObservation).toHaveBeenCalledWith('usage-1', cost)

    const invalidResponse: CapturedResponse = {}
    await handlers.appendUsageCostObservation(
      jsonRequest('/api/v1/provider-hub/usage/usage-1/cost-observations', {
        ...cost,
        classification: 'estimated',
      }),
      response(invalidResponse),
      { usageId: 'usage-1' },
    )
    expect(invalidResponse.status).toBe(400)
    expect(appendCostObservation).toHaveBeenCalledTimes(1)
  })
})
