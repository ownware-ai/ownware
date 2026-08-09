import { describe, expect, it } from 'vitest'
import {
  PROVIDER_VERIFICATION_HARNESS_VERSION,
  ProviderHubCursorError,
  ProviderHubService,
  createModelsDevArtifact,
  createVerificationEvidence,
  createVerificationEvidenceBundle,
  evaluateVerificationProbe,
  projectAmbientLlmConnections,
  projectCodexSubscription,
  projectLlmCredentials,
  projectOllamaLocal,
  type CatalogRefreshHealth,
  type ModelsDevCatalog,
  type ProviderCatalogStoreState,
} from '../../../src/provider-hub/index.js'

const NOW = '2026-08-08T12:00:00.000Z'
const SOURCE_URL = 'https://models.opencode.ai/api.json'

const RAW: ModelsDevCatalog = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY'],
    npm: '@ai-sdk/anthropic',
    models: {
      'claude-fast': {
        id: 'claude-fast',
        name: 'Claude Fast',
        tool_call: true,
        limit: { context: 100_000, output: 8_000 },
        cost: { input: 1, output: 2 },
      },
      'claude-large': {
        id: 'claude-large',
        name: 'Claude Large',
        reasoning: true,
        limit: { context: 200_000, output: 16_000 },
        cost: { input: 3, output: 9 },
      },
    },
  },
  catalog_only: {
    id: 'catalog_only',
    name: 'Catalog only',
    env: ['CATALOG_ONLY_KEY'],
    npm: '@ai-sdk/openai-compatible',
    models: {
      remote: {
        id: 'remote',
        name: 'Remote model',
        limit: { context: 32_000, output: 4_000 },
      },
    },
  },
}

function service(options: {
  readonly dynamic?: boolean
  readonly hiddenDynamicModel?: boolean
  readonly legacy?: boolean
  readonly runtimeProviderAvailable?: boolean
  readonly catalogHealth?: CatalogRefreshHealth
  readonly verificationMode?: 'fixture' | 'live'
} = {}): ProviderHubService {
  const artifact = createModelsDevArtifact(RAW, { generatedAt: NOW, sourceUrl: SOURCE_URL })
  const health: CatalogRefreshHealth = {
    status: 'fresh',
    activeGenerationId: `models-dev:${artifact.sha256.slice(0, 16)}`,
    lastSuccessAt: NOW,
  }
  const state: ProviderCatalogStoreState = {
    artifact,
    source: 'bundled',
    health: options.catalogHealth ?? health,
  }
  return new ProviderHubService({
    store: {
      load: async () => state,
      refresh: async () => state,
    },
    connectableProviderIds: new Set(['anthropic']),
    ...(options.runtimeProviderAvailable == null ? {} : {
      isRuntimeProviderAvailable: () => options.runtimeProviderAvailable!,
    }),
    ...(options.verificationMode == null ? {} : {
      loadVerificationEvidence: async () => {
        const entry = createVerificationEvidence({
          schemaVersion: 1,
          harnessVersion: PROVIDER_VERIFICATION_HARNESS_VERSION,
          providerRouteId: 'route:anthropic',
          modelRouteId: 'anthropic:claude-fast',
          runtimeId: 'loom',
          adapterId: 'anthropic',
          protocol: 'anthropic_messages',
          mode: options.verificationMode!,
          observedAt: NOW,
          catalogGenerationId: health.activeGenerationId,
          results: [
            evaluateVerificationProbe('text_streaming', {
              eventTypes: ['text_delta', 'message_complete'],
              terminalOutcome: 'completed',
              toolCallBatches: [],
              cancellationRequested: false,
              timeoutConfigured: false,
              request: {
                reasoningOption: false,
                inputKinds: ['text'],
                structuredOutputSchema: false,
                cacheMarkers: 0,
              },
              response: { reasoningObserved: false, structuredOutputValid: false },
              usage: { inputTokens: 8, outputTokens: 2 },
              errorCategory: 'none',
            }),
            evaluateVerificationProbe('sequential_tool_calls', {
              eventTypes: ['tool_use_start', 'tool_use_end', 'message_complete'],
              terminalOutcome: 'completed',
              toolCallBatches: [1, 1],
              cancellationRequested: false,
              timeoutConfigured: false,
              request: {
                reasoningOption: false,
                inputKinds: ['text'],
                structuredOutputSchema: false,
                cacheMarkers: 0,
              },
              response: { reasoningObserved: false, structuredOutputValid: false },
              usage: { inputTokens: 12, outputTokens: 3 },
              errorCategory: 'none',
            }),
          ],
        })
        return {
          status: 'active' as const,
          bundle: createVerificationEvidenceBundle({
            harnessVersion: PROVIDER_VERIFICATION_HARNESS_VERSION,
            mode: options.verificationMode!,
            createdAt: NOW,
            entries: [entry],
          }),
        }
      },
    }),
    ...(options.legacy === true ? {
      legacyModelPolicies: [{
        id: 'anthropic:stable-legacy-id',
        providerId: 'anthropic',
        tier: 'balanced',
        sourceModelRouteId: 'anthropic:claude-large',
        providerRouteId: 'route:anthropic',
        wireModelId: 'claude-large',
        name: 'Stable legacy selection',
        aliases: ['legacy-large'],
        contextWindow: 200_000,
        maxOutputTokens: 16_000,
        capabilities: ['streaming', 'tools'],
        recommended: true,
        deprecated: false,
        billingKind: 'metered' as const,
      }, {
        id: 'anthropic:retired-but-pinned',
        providerId: 'anthropic',
        tier: 'legacy',
        sourceModelRouteId: 'anthropic:no-longer-catalogued',
        providerRouteId: 'route:anthropic',
        wireModelId: 'retired-but-pinned',
        name: 'Retired but pinned',
        aliases: [],
        capabilities: ['streaming'],
        recommended: false,
        deprecated: true,
        billingKind: 'metered' as const,
      }],
    } : {}),
    listConnections: async () => projectLlmCredentials([{
      id: 'cred_0123456789ab',
      name: 'Anthropic work key',
      variableName: 'ANTHROPIC_API_KEY',
      category: 'llm',
      authType: 'api-key',
      hint: '...test',
      trust: 'low',
      source: 'manual',
      createdAt: NOW,
      updatedAt: NOW,
      status: 'ready',
    }]),
    ...(options.dynamic === true ? {
      loadDynamicProjection: async () => projectCodexSubscription({
        state: 'authenticated',
        authMode: 'chatgpt',
        plan: 'plus',
        requiresOpenaiAuth: false,
        authority: 'account/read',
        observedAt: NOW,
        validUntil: null,
      }, {
        authority: 'model/list',
        observedAt: NOW,
        validUntil: null,
        models: [{
          id: 'gpt-main',
          model: 'gpt-main',
          displayName: 'GPT Main',
          description: 'Fixture model',
          hidden: options.hiddenDynamicModel === true,
          isDefault: true,
          defaultReasoningEffort: 'high',
          reasoningEfforts: ['high'],
          inputModalities: ['text', 'image'],
          serviceTiers: ['fast'],
          defaultServiceTier: 'fast',
          supportsPersonality: false,
        }],
      }),
    } : {}),
  })
}

describe('ProviderHubService', () => {
  it('projects independently versioned verification evidence without treating fixtures as live reliability', async () => {
    const fixtureHub = service({ verificationMode: 'fixture' })
    const fixture = await fixtureHub.models({ scope: 'verified' })
    expect(fixture.items).toEqual([])
    const fixtureEvidence = await fixtureHub.verifications()
    expect(fixtureEvidence.bundle).toMatchObject({ mode: 'fixture' })
    expect(fixtureEvidence.generationId).not.toBe((await service().overview()).generationId)

    const liveHub = service({ verificationMode: 'live' })
    const live = await liveHub.models({ scope: 'verified' })
    expect(live.items.map(item => item.model.id)).toEqual(['anthropic:claude-fast'])
    expect(live.items[0]?.model.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capability: 'text_streaming',
        ownware: expect.objectContaining({ status: 'verified', mode: 'live' }),
      }),
    ]))
  })

  it('paginates and searches the full catalog with generation-bound cursors', async () => {
    const hub = service()
    const first = await hub.models({ providerFamilyId: 'anthropic', limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.page.total).toBe(2)
    expect(first.page.nextCursor).not.toBeNull()

    const second = await hub.models({
      providerFamilyId: 'anthropic',
      limit: 1,
      cursor: first.page.nextCursor!,
    })
    expect(second.items).toHaveLength(1)
    expect(second.items[0]?.model.id).not.toBe(first.items[0]?.model.id)
    await expect(hub.models({ q: 'changed', cursor: first.page.nextCursor! }))
      .rejects.toBeInstanceOf(ProviderHubCursorError)

    const searched = await hub.models({ q: 'remote model' })
    expect(searched.items.map(item => item.model.id)).toEqual(['catalog_only:remote'])
  })

  it('overlays credential state without returning credential hints or values', async () => {
    const hub = service()
    const connected = await hub.models({ scope: 'connected' })
    expect(connected.items.map(item => item.model.id).sort()).toEqual([
      'anthropic:claude-fast',
      'anthropic:claude-large',
    ])
    const response = await hub.connections()
    expect(response.items[0]?.auth).toEqual({
      kind: 'api_key',
      credentialId: 'cred_0123456789ab',
      placement: { location: 'bearer' },
    })
    expect(JSON.stringify(response)).not.toContain('...test')
  })

  it('merges the token-blind Codex projection and preserves subscription billing semantics', async () => {
    const hub = service({ dynamic: true })
    const recommended = await hub.models({ scope: 'recommended' })
    expect(recommended.items).toHaveLength(1)
    expect(recommended.items[0]?.model).toMatchObject({
      id: 'codex:gpt-main',
      billingKind: 'subscription',
      availability: {
        credentialed: true,
        verified: false,
        recommended: true,
      },
    })
    expect(recommended.items[0]?.prices).toEqual([])
    const connections = await hub.connections()
    expect(connections.items.some(item => item.auth.kind === 'oauth_subscription')).toBe(true)
  })

  it('excludes hidden runtime models unless hidden lifecycle is requested explicitly', async () => {
    const hub = service({ dynamic: true, hiddenDynamicModel: true })

    expect((await hub.models()).items.map(item => item.model.id)).not.toContain('codex:gpt-main')
    expect((await hub.models({ scope: 'recommended' })).items).toHaveLength(0)
    expect((await hub.models({ lifecycle: 'hidden' })).items.map(item => item.model.id))
      .toEqual(['codex:gpt-main'])
  })

  it('returns broad provider summaries while keeping catalog-only routes visibly non-connectable', async () => {
    const result = await service().providers()
    expect(result.items).toHaveLength(2)
    const catalogOnly = result.items.find(item => item.family.id === 'catalog_only')
    expect(catalogOnly).toMatchObject({ modelCount: 1, connectableModelCount: 0 })
    expect(catalogOnly?.routes[0]?.connectabilityReason).toContain('metadata only')
  })

  it('surfaces last-known-good catalog health as a non-secret warning', async () => {
    const hub = service({
      catalogHealth: {
        status: 'offline',
        activeGenerationId: 'models-dev:test-offline',
        lastSuccessAt: NOW,
        errorCode: 'network_error',
        errorMessage: 'Official catalog host was unreachable',
      },
    })

    const result = await hub.models({ scope: 'recommended' })
    expect(result.warnings).toEqual([
      expect.stringContaining('serving last-known-good generation models-dev:test-offline'),
    ])
  })

  it('retains legacy canonical ids/defaults and pinned models without inventing prices', async () => {
    const hub = service({ legacy: true })
    const recommended = await hub.models({ scope: 'recommended' })
    expect(recommended.items.map(item => item.model.id)).toEqual(['anthropic:stable-legacy-id'])
    expect(recommended.items[0]?.model).toMatchObject({
      wireModelId: 'claude-large',
      aliases: expect.arrayContaining(['anthropic:claude-large', 'legacy-large']),
    })
    expect(recommended.items[0]?.prices.every(
      price => price.scope.modelRouteId === 'anthropic:stable-legacy-id',
    )).toBe(true)

    const pinned = await hub.models({ q: 'retired but pinned' })
    expect(pinned.items[0]?.model).toMatchObject({
      id: 'anthropic:retired-but-pinned',
      catalogSourceRef: 'legacy-curated:v1',
      availability: { lifecycle: 'deprecated', verified: false },
    })
    expect(pinned.items[0]?.prices).toEqual([])

    const compatibility = await hub.compatibilityModels()
    expect(compatibility).toEqual([
      expect.objectContaining({
        id: 'anthropic:stable-legacy-id',
        provider: 'anthropic',
        tier: 'balanced',
        contextWindow: 200_000,
        maxOutputTokens: 16_000,
        costPer1kInput: 0.003,
        costPer1kOutput: 0.009,
        default: true,
        hasCredentials: true,
      }),
      expect.objectContaining({
        id: 'anthropic:retired-but-pinned',
        costPer1kInput: null,
        costPer1kOutput: null,
        deprecated: true,
        hasCredentials: true,
      }),
    ])
  })

  it('projects ambient keys and reachable Ollama through the same connection model', async () => {
    const ambient = projectAmbientLlmConnections(['anthropic'], NOW)
    expect(ambient[0]).toMatchObject({
      id: 'connection:ambient:anthropic',
      providerRouteId: 'route:anthropic',
      auth: { kind: 'ambient_api_key', variableName: 'ANTHROPIC_API_KEY' },
    })
    expect(JSON.stringify(ambient)).not.toContain('secret')

    const local = projectOllamaLocal(true, NOW)
    expect(local.routes?.[0]).toMatchObject({
      id: 'route:ollama',
      kind: 'local',
      transport: { runtimeId: 'loom', adapterId: 'ollama' },
    })
    expect(local.connections?.[0]).toMatchObject({
      id: 'connection:ollama-local',
      auth: { kind: 'local_endpoint' },
      health: { status: 'healthy' },
    })
  })

  it('selects automatic execution from the same Hub view and excludes subscription-only routes', async () => {
    const hub = service({ legacy: true, dynamic: true })
    await expect(hub.pickRunnableDefaultModel())
      .resolves.toBe('anthropic:stable-legacy-id')
  })

  it('does not treat configured credentials as proof that a runtime adapter can dispatch', async () => {
    const hub = service({ legacy: true, runtimeProviderAvailable: false })
    await expect(hub.pickRunnableDefaultModel()).resolves.toBeNull()
  })
})
