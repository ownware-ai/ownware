import { describe, expect, it } from 'vitest'
import { OwnwareClient } from '../client.js'
import {
  providerHubModelQueryString,
  providerHubUsageQueryString,
} from '../provider-hub.js'

describe('Provider Hub client contract', () => {
  it('encodes only supplied model filters', () => {
    expect(providerHubModelQueryString({
      q: 'grok 4',
      providerRouteId: 'route:xai',
      scope: 'connected',
      limit: 25,
    })).toBe('?q=grok+4&providerRouteId=route%3Axai&scope=connected&limit=25')
    expect(providerHubModelQueryString({})).toBe('')
  })

  it('encodes only supplied usage filters', () => {
    expect(providerHubUsageQueryString({
      from: '2026-08-09T00:00:00.000Z',
      profileId: 'profile:finance',
      classification: 'provider_reported',
      limit: 25,
    })).toBe(
      '?from=2026-08-09T00%3A00%3A00.000Z&profileId=profile%3Afinance'
      + '&classification=provider_reported&limit=25',
    )
    expect(providerHubUsageQueryString({})).toBe('')
  })

  it('drives usage reads, evidence export, and reconciliation', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new OwnwareClient({
      baseUrl: 'http://127.0.0.1:3011/',
      token: 'fixture-token',
      fetch: (async (input, init) => {
        calls.push({ url: String(input), init })
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
    })

    await client.providerHubUsage({
      threadId: 'thread:1',
      classification: 'estimated',
      limit: 10,
    })
    await client.providerHubUsageSummary({ profileId: 'profile:1' })
    await client.exportProviderHubUsageEvidence()
    await client.reconcileProviderHubUsageCost('usage/id', {
      classification: 'reconciled',
      amountUsd: 0.5,
      currency: 'USD',
      observedAt: '2026-08-09T00:00:00.000Z',
      reconciledAt: '2026-08-09T00:01:00.000Z',
    })

    expect(calls.map(call => call.url)).toEqual([
      'http://127.0.0.1:3011/api/v1/provider-hub/usage?threadId=thread%3A1&classification=estimated&limit=10',
      'http://127.0.0.1:3011/api/v1/provider-hub/usage/summary?profileId=profile%3A1',
      'http://127.0.0.1:3011/api/v1/provider-hub/usage/export',
      'http://127.0.0.1:3011/api/v1/provider-hub/usage/usage%2Fid/cost-observations',
    ])
    expect(calls[3]?.init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer fixture-token',
        'Content-Type': 'application/json',
      },
    })
    expect(JSON.parse(String(calls[3]?.init?.body))).toMatchObject({
      classification: 'reconciled',
      amountUsd: 0.5,
    })
  })

  it('drives central reads and the complete compatible-connection lifecycle', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new OwnwareClient({
      baseUrl: 'http://127.0.0.1:3011/',
      token: 'fixture-token',
      fetch: (async (input, init) => {
        calls.push({ url: String(input), init })
        const url = String(input)
        const body = url.endsWith('/connections/openai-compatible') && init?.method === 'POST'
          ? compatibleConfig()
          : url.endsWith('/discover')
            ? { ...compatibleConfig(), discoveredModelIds: ['fixture-model'] }
            : url.endsWith('/connections/openai-compatible')
              ? { items: [compatibleConfig()] }
              : url.includes('/provider-hub/models')
                ? { generationId: 'generation:1', items: [], page: { limit: 10, total: 0, nextCursor: null }, warnings: [] }
                : url.includes('/catalog/refresh')
                  ? overview()
                  : url.includes('/connections/openai-compatible/') && init?.method === 'DELETE'
                    ? { removed: true }
                    : overview()
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
    })

    await client.providerHubOverview()
    await client.providerHubModels({ providerRouteId: 'route:xai', scope: 'connected', limit: 10 })
    await client.openAICompatibleConnections()
    await client.saveOpenAICompatibleConnection({
      label: 'Fixture',
      baseUrl: 'https://llm.example.test/v1',
      auth: { kind: 'bearer', key: 'write-only-fixture' },
      manualModelIds: ['fixture-model'],
      discoveryEnabled: false,
    })
    await client.discoverOpenAICompatibleModels('oai_0123456789ab')
    await client.removeOpenAICompatibleConnection('oai_0123456789ab')
    await client.refreshProviderHub(true)

    expect(calls.map(call => call.url)).toEqual([
      'http://127.0.0.1:3011/api/v1/provider-hub',
      'http://127.0.0.1:3011/api/v1/provider-hub/models?providerRouteId=route%3Axai&scope=connected&limit=10',
      'http://127.0.0.1:3011/api/v1/provider-hub/connections/openai-compatible',
      'http://127.0.0.1:3011/api/v1/provider-hub/connections/openai-compatible',
      'http://127.0.0.1:3011/api/v1/provider-hub/connections/openai-compatible/oai_0123456789ab/discover',
      'http://127.0.0.1:3011/api/v1/provider-hub/connections/openai-compatible/oai_0123456789ab',
      'http://127.0.0.1:3011/api/v1/provider-hub/catalog/refresh?force=true',
    ])
    expect(calls[3]?.init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer fixture-token',
        'Content-Type': 'application/json',
      },
    })
    expect(String(calls[3]?.init?.body)).toContain('write-only-fixture')
    expect(calls[5]?.init?.method).toBe('DELETE')
  })
})

function compatibleConfig() {
  return {
    schemaVersion: 1,
    id: 'oai_0123456789ab',
    label: 'Fixture',
    baseUrl: 'https://llm.example.test/v1',
    auth: { kind: 'bearer', credentialId: 'cred_fixture' },
    manualModelIds: ['fixture-model'],
    discoveredModelIds: [],
    discoveryEnabled: false,
    compatibility: { maxTokensField: 'max_tokens', streamUsage: 'omit' },
    health: { status: 'unknown' },
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  }
}

function overview() {
  return {
    generation: {
      id: 'generation:1',
      schemaVersion: 1,
      source: 'bundled',
      generatedAt: '2026-08-09T00:00:00.000Z',
      sha256: '0'.repeat(64),
    },
    generationId: 'generation:1',
    catalogHealth: { status: 'fresh', activeGenerationId: 'generation:1' },
    counts: { providers: 1, routes: 1, models: 1, pricebookEntries: 0, connections: 0 },
    warnings: [],
  }
}
