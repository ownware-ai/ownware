import { describe, expect, it } from 'vitest'
import {
  AmbientApiKeyAuthSchema,
  CapabilityVerificationSchema,
  ProviderHubStateSchema,
  UsageLedgerEntrySchema,
  type ModelCapabilityStatus,
  type ProviderHubState,
} from '../../../src/provider-hub/index.js'

const NOW = '2026-08-08T12:00:00.000Z'
const SHA = 'a'.repeat(64)

function untested(capability: ModelCapabilityStatus['capability']): ModelCapabilityStatus {
  return {
    capability,
    upstream: { status: 'unknown' },
    ownware: { status: 'untested' },
  }
}

function verified(capability: ModelCapabilityStatus['capability']): ModelCapabilityStatus {
  return {
    capability,
    upstream: {
      status: 'supported',
      source: 'provider',
      sourceRef: 'https://example.test/docs',
      observedAt: NOW,
    },
    ownware: {
      status: 'verified',
      evidenceId: `evidence:${capability}`,
      harnessVersion: 'provider-contract-v1',
      observedAt: NOW,
      mode: 'fixture',
    },
  }
}

function fixture(): ProviderHubState {
  const apiFamilies = ['anthropic', 'openai', 'google', 'openrouter'].map((id) => ({
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    lifecycle: 'active' as const,
  }))

  const apiRoutes = apiFamilies.map((family) => ({
    id: `${family.id}:api`,
    familyId: family.id,
    name: `${family.name} API`,
    kind: (family.id === 'openrouter' ? 'router' : 'direct') as 'router' | 'direct',
    transport: {
      runtimeId: 'loom',
      adapterId: family.id,
      protocol: family.id === 'anthropic'
        ? 'anthropic-messages'
        : family.id === 'google'
          ? 'google-generate-content'
          : 'openai-compatible',
    },
    connectable: true,
    lifecycle: 'active' as const,
  }))

  const modelFor = (familyId: string, modelId: string) => ({
    id: `${familyId}:${modelId}`,
    providerRouteId: `${familyId}:api`,
    wireModelId: modelId,
    name: modelId,
    aliases: [],
    contextWindow: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    capabilities: [untested('text_streaming')],
    variants: [],
    availability: {
      catalogued: true,
      connectable: true,
      credentialed: true,
      verified: false,
      recommended: familyId === 'anthropic',
      lifecycle: 'active' as const,
      connectionIds: [`connection:${familyId}`],
    },
    billingKind: familyId === 'openrouter' ? 'provider_reported' as const : 'metered' as const,
    catalogSourceRef: 'models-dev:2026-08-08',
  })

  return {
    schemaVersion: 1,
    catalog: {
      schemaVersion: 1,
      generation: {
        id: 'catalog:2026-08-08',
        schemaVersion: 1,
        source: 'bundled',
        sourceUrl: 'https://models.dev/api.json',
        generatedAt: NOW,
        sha256: SHA,
      },
      families: [
        ...apiFamilies,
        { id: 'openai-chatgpt', name: 'ChatGPT', lifecycle: 'experimental' },
        { id: 'amazon', name: 'Amazon', lifecycle: 'active' },
        { id: 'local', name: 'Local models', lifecycle: 'active' },
        { id: 'custom', name: 'Custom endpoint', lifecycle: 'active' },
      ],
      routes: [
        ...apiRoutes,
        {
          id: 'codex:subscription',
          familyId: 'openai-chatgpt',
          name: 'ChatGPT subscription through Codex',
          kind: 'subscription',
          transport: { runtimeId: 'codex-app-server', protocol: 'codex-app-server' },
          connectable: true,
          lifecycle: 'experimental',
        },
        {
          id: 'amazon-bedrock:us-east-1',
          familyId: 'amazon',
          name: 'Amazon Bedrock (us-east-1)',
          kind: 'cloud',
          transport: {
            runtimeId: 'loom',
            adapterId: 'amazon-bedrock',
            protocol: 'bedrock-converse',
          },
          region: 'us-east-1',
          connectable: true,
          lifecycle: 'active',
        },
        {
          id: 'local:openai-compatible',
          familyId: 'local',
          name: 'Local OpenAI-compatible endpoint',
          kind: 'local',
          transport: {
            runtimeId: 'loom',
            adapterId: 'openai-compatible',
            protocol: 'openai-compatible',
          },
          connectable: true,
          lifecycle: 'active',
        },
        {
          id: 'custom:openai-compatible',
          familyId: 'custom',
          name: 'Custom OpenAI-compatible endpoint',
          kind: 'custom',
          transport: {
            runtimeId: 'loom',
            adapterId: 'openai-compatible',
            protocol: 'openai-compatible',
          },
          connectable: true,
          lifecycle: 'active',
        },
      ],
      models: [
        modelFor('anthropic', 'claude-sonnet-4-6'),
        modelFor('openai', 'gpt-5.6-terra'),
        modelFor('google', 'gemini-3.5-flash'),
        modelFor('openrouter', 'moonshotai/kimi-k2.7'),
        {
          id: 'codex:gpt-5.6-sol',
          providerRouteId: 'codex:subscription',
          wireModelId: 'gpt-5.6-sol',
          name: 'GPT-5.6 Sol',
          aliases: [],
          contextWindow: null,
          maxInputTokens: null,
          maxOutputTokens: null,
          capabilities: [verified('text_streaming'), untested('tool_calls')],
          variants: [{
            id: 'reasoning:high',
            kind: 'reasoning_effort',
            label: 'High',
            value: 'high',
            availability: 'available',
            verification: { status: 'untested' },
          }],
          availability: {
            catalogued: true,
            connectable: true,
            credentialed: true,
            verified: true,
            recommended: true,
            lifecycle: 'experimental',
            connectionIds: ['connection:codex'],
          },
          billingKind: 'subscription',
          catalogSourceRef: 'codex:model-list',
        },
        {
          ...modelFor('anthropic', 'claude-bedrock'),
          id: 'amazon-bedrock:anthropic.claude',
          providerRouteId: 'amazon-bedrock:us-east-1',
          wireModelId: 'anthropic.claude',
          availability: {
            catalogued: true,
            connectable: true,
            credentialed: true,
            verified: false,
            recommended: false,
            lifecycle: 'active',
            connectionIds: ['connection:bedrock'],
          },
        },
        {
          ...modelFor('anthropic', 'local-model'),
          id: 'local:local-model',
          providerRouteId: 'local:openai-compatible',
          wireModelId: 'local-model',
          billingKind: 'local',
          availability: {
            catalogued: false,
            connectable: true,
            credentialed: true,
            verified: false,
            recommended: false,
            lifecycle: 'active',
            connectionIds: ['connection:local'],
          },
        },
        {
          ...modelFor('anthropic', 'vendor/new-model'),
          id: 'custom:vendor/new-model',
          providerRouteId: 'custom:openai-compatible',
          wireModelId: 'vendor/new-model',
          billingKind: 'unknown',
          availability: {
            catalogued: false,
            connectable: true,
            credentialed: true,
            verified: false,
            recommended: false,
            lifecycle: 'active',
            connectionIds: ['connection:custom'],
          },
        },
      ],
      prices: [{
        id: 'price:anthropic:sonnet:2026-08-08',
        version: '2026-08-08',
        currency: 'USD',
        scope: {
          providerRouteId: 'anthropic:api',
          modelRouteId: 'anthropic:claude-sonnet-4-6',
          maximumInputTokens: 200_001,
        },
        rates: [
          { dimension: 'input_text_tokens', unitSize: 1_000_000, amountUsd: 3 },
          { dimension: 'output_text_tokens', unitSize: 1_000_000, amountUsd: 15 },
          { dimension: 'cache_read_tokens', unitSize: 1_000_000, amountUsd: 0.3 },
          { dimension: 'cache_write_tokens', unitSize: 1_000_000, amountUsd: 3.75 },
        ],
        effectiveFrom: NOW,
        effectiveUntil: null,
        source: {
          kind: 'official',
          sourceRef: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
          retrievedAt: NOW,
        },
      }],
    },
    connections: [
      ...apiFamilies.map((family) => ({
        id: `connection:${family.id}`,
        providerRouteId: `${family.id}:api`,
        label: `${family.name} key`,
        auth: {
          kind: family.id === 'openrouter' ? 'router_key' as const : 'api_key' as const,
          credentialId: `credential:${family.id}`,
          placement: { location: 'sdk' as const },
        },
        settings: {},
        status: 'configured' as const,
        createdAt: NOW,
        updatedAt: NOW,
      })),
      {
        id: 'connection:codex',
        providerRouteId: 'codex:subscription',
        label: 'Personal ChatGPT',
        auth: {
          kind: 'oauth_subscription',
          ownerRuntimeId: 'codex-app-server',
          accountRef: 'account:redacted-handle',
        },
        settings: {},
        status: 'configured',
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'connection:bedrock',
        providerRouteId: 'amazon-bedrock:us-east-1',
        label: 'AWS development profile',
        auth: {
          kind: 'cloud_identity',
          platform: 'aws',
          source: 'profile',
          profile: 'ownware-dev',
        },
        settings: { region: 'us-east-1', profile: 'ownware-dev' },
        status: 'configured',
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'connection:local',
        providerRouteId: 'local:openai-compatible',
        label: 'Local server',
        auth: { kind: 'local_endpoint' },
        settings: { baseUrl: 'http://127.0.0.1:11434/v1' },
        status: 'configured',
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'connection:custom',
        providerRouteId: 'custom:openai-compatible',
        label: 'Custom gateway',
        auth: {
          kind: 'custom_headers',
          headers: [
            { name: 'Authorization', credentialId: 'credential:custom-auth' },
            { name: 'X-Project', credentialId: 'credential:custom-project' },
          ],
        },
        settings: {
          baseUrl: 'https://inference.example.test/v1',
          discoveryPath: '/models',
          manualModelIds: ['vendor/new-model'],
        },
        status: 'configured',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    catalogHealth: {
      status: 'fresh',
      activeGenerationId: 'catalog:2026-08-08',
      lastSuccessAt: NOW,
    },
  }
}

describe('Provider Hub v1 schemas', () => {
  it('round-trips API, subscription, cloud, local, and custom routes losslessly', () => {
    const parsed = ProviderHubStateSchema.parse(fixture())
    const roundTripped = ProviderHubStateSchema.parse(JSON.parse(JSON.stringify(parsed)))

    expect(roundTripped).toEqual(parsed)
    expect(roundTripped.connections.map((connection) => connection.auth.kind)).toEqual([
      'api_key',
      'api_key',
      'api_key',
      'router_key',
      'oauth_subscription',
      'cloud_identity',
      'local_endpoint',
      'custom_headers',
    ])
    expect(roundTripped.catalog.models.map((model) => model.id)).toContain(
      'anthropic:claude-sonnet-4-6',
    )
    expect(roundTripped.catalog.models.map((model) => model.id)).toContain(
      'codex:gpt-5.6-sol',
    )
  })

  it('does not turn local compute with unknown economics into zero dollars', () => {
    const parsed = UsageLedgerEntrySchema.safeParse({
      id: 'usage:local:test',
      occurredAt: NOW,
      providerFamilyId: 'local',
      providerRouteId: 'local:ollama',
      modelRouteId: 'local:llama3.2',
      wireModelId: 'llama3.2',
      billingKind: 'local',
      tokens: { inputTextTokens: 10, outputTextTokens: 20 },
      units: { requests: 1 },
      cost: {
        classification: 'local',
        amountUsd: 0,
        currency: 'USD',
        observedAt: NOW,
      },
      providerFacts: {},
      success: true,
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects secrets and arbitrary transport options at the connection boundary', () => {
    const state = fixture() as unknown as {
      connections: Array<Record<string, unknown>>
    }
    state.connections[0] = {
      ...state.connections[0],
      apiKey: 'must-never-enter-provider-hub',
    }
    expect(ProviderHubStateSchema.safeParse(state).success).toBe(false)
  })

  it('admits only a secret-free environment variable reference for ambient API keys', () => {
    expect(AmbientApiKeyAuthSchema.parse({
      kind: 'ambient_api_key',
      variableName: 'ANTHROPIC_API_KEY',
    })).toEqual({ kind: 'ambient_api_key', variableName: 'ANTHROPIC_API_KEY' })
    expect(AmbientApiKeyAuthSchema.safeParse({
      kind: 'ambient_api_key',
      variableName: 'ANTHROPIC_API_KEY',
      value: 'must-never-enter-provider-hub',
    }).success).toBe(false)
  })

  it('requires evidence before a model route can be marked verified', () => {
    const state = fixture()
    const model = state.catalog.models[0]!
    const result = ProviderHubStateSchema.safeParse({
      ...state,
      catalog: {
        ...state.catalog,
        models: [{
          ...model,
          availability: { ...model.availability, verified: true },
        }, ...state.catalog.models.slice(1)],
      },
    })
    expect(result.success).toBe(false)
  })

  it('does not accept a bare verified capability badge without evidence metadata', () => {
    expect(CapabilityVerificationSchema.safeParse({ status: 'verified' }).success).toBe(false)
    expect(CapabilityVerificationSchema.safeParse({
      status: 'verified',
      evidenceId: 'evidence:1',
      harnessVersion: 'v1',
      observedAt: NOW,
      mode: 'live',
    }).success).toBe(true)
  })

  it('preserves truthful cost provenance and rejects unknown/subscription USD', () => {
    const base = {
      id: 'usage:1',
      occurredAt: NOW,
      providerFamilyId: 'anthropic',
      providerRouteId: 'anthropic:api',
      modelRouteId: 'anthropic:claude-sonnet-4-6',
      connectionId: 'connection:anthropic',
      wireModelId: 'claude-sonnet-4-6',
      billingKind: 'metered',
      tokens: {
        inputTextTokens: 1_000,
        outputTextTokens: 200,
        cacheReadTokens: 500,
        cacheWriteTokens: 0,
      },
      units: { requests: 1 },
      providerFacts: { requestId: 'request:1' },
      success: true,
    } as const

    expect(UsageLedgerEntrySchema.parse({
      ...base,
      cost: {
        classification: 'estimated',
        amountUsd: 0.01,
        currency: 'USD',
        pricebookEntryId: 'price:1',
        pricebookVersion: '2026-08-08',
        observedAt: NOW,
      },
    }).cost.classification).toBe('estimated')

    expect(UsageLedgerEntrySchema.safeParse({
      ...base,
      cost: {
        classification: 'unknown',
        amountUsd: 0,
        currency: 'USD',
        observedAt: NOW,
      },
    }).success).toBe(false)

    expect(UsageLedgerEntrySchema.safeParse({
      ...base,
      billingKind: 'subscription',
      cost: {
        classification: 'subscription',
        amountUsd: null,
        currency: 'USD',
        observedAt: NOW,
      },
    }).success).toBe(true)
  })

  it('rejects dangling route references and duplicate stable ids', () => {
    const state = fixture()
    const duplicate = state.catalog.routes[0]!
    const result = ProviderHubStateSchema.safeParse({
      ...state,
      catalog: {
        ...state.catalog,
        routes: [
          ...state.catalog.routes,
          { ...duplicate },
        ],
      },
    })
    expect(result.success).toBe(false)
  })
})
