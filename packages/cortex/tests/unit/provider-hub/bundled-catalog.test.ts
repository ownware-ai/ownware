import { readFile } from 'node:fs/promises'
import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_MODELS_DEV_PATH,
  __bundledProviderHubInternal,
  ModelsDevArtifactSchema,
  ProviderHubService,
  parseModelsDevArtifactText,
  projectLlmCredentials,
  transformModelsDevArtifact,
} from '../../../src/provider-hub/index.js'
import {
  LLM_PROVIDERS,
  LLM_PROVIDER_ROUTE_BINDINGS,
} from '../../../src/gateway/llm-providers.js'

const CONNECTABLE_PROVIDER_IDS = new Set(LLM_PROVIDERS.map(provider => provider.providerId))

describe('bundled Models.dev catalog', () => {
  it('resolves the same packaged catalog directory before and after gateway bundling', () => {
    const unbundled = __bundledProviderHubInternal.providerHubAssetPath(
      'file:///Applications/Ownware/Resources/cortex/dist/provider-hub/bundled.js',
      'models-dev.snapshot.json',
    )
    const bundled = __bundledProviderHubInternal.providerHubAssetPath(
      'file:///Applications/Ownware/Resources/cortex/dist/gateway-bundle.mjs',
      'models-dev.snapshot.json',
    )

    expect(unbundled.endsWith(
      ['provider-hub', 'catalog', 'models-dev.snapshot.json'].join(sep),
    )).toBe(true)
    expect(bundled).toBe(unbundled)
  })

  it('is hash-validated, complete, and transforms without overstating verification', async () => {
    const artifact = parseModelsDevArtifactText(await readFile(BUNDLED_MODELS_DEV_PATH, 'utf8'))
    expect(ModelsDevArtifactSchema.safeParse(artifact).success).toBe(true)
    const providers = Object.values(artifact.providers)
    const rawModels = providers.flatMap((provider) => Object.values(provider.models))

    expect(providers).toHaveLength(181)
    expect(rawModels).toHaveLength(6_231)
    expect(rawModels.filter((model) => model.cost != null)).toHaveLength(5_816)
    expect(rawModels.filter((model) => model.cost == null)).toHaveLength(415)

    const snapshot = transformModelsDevArtifact(artifact, {
      source: 'bundled',
      connectableProviderIds: CONNECTABLE_PROVIDER_IDS,
      connectableProviderRoutes: LLM_PROVIDER_ROUTE_BINDINGS,
    })
    expect(snapshot.families).toHaveLength(181)
    expect(snapshot.models).toHaveLength(6_231)
    expect(snapshot.routes.length).toBeGreaterThanOrEqual(181)
    expect(snapshot.models.every((model) => model.availability.verified === false)).toBe(true)
    expect(snapshot.models.every((model) => (
      model.capabilities.every((capability) => capability.ownware.status === 'untested')
    ))).toBe(true)

    const nonOwnwareProvider = providers.find((provider) => (
      !CONNECTABLE_PROVIDER_IDS.has(provider.id)
    ))!
    const catalogOnlyRoute = snapshot.routes.find(
      (route) => route.id === `route:${nonOwnwareProvider.id}`,
    )
    expect(catalogOnlyRoute?.kind).toBe('unknown')
    expect(catalogOnlyRoute?.transport.runtimeId).toBe('unassigned')
    expect(catalogOnlyRoute?.connectable).toBe(false)

    const cachePriced = providers.flatMap((provider) => (
      Object.values(provider.models).map((model) => ({ provider, model }))
    )).find(({ model }) => model.cost?.cache_read != null)!
    const cacheCapability = snapshot.models
      .find((model) => model.id === `${cachePriced.provider.id}:${cachePriced.model.id}`)
      ?.capabilities.find((capability) => capability.capability === 'prompt_caching')
    expect(cacheCapability?.upstream.status).toBe('unknown')

    const unpriced = providers.flatMap((provider) => (
      Object.values(provider.models).map((model) => ({ provider, model }))
    )).find(({ model }) => model.cost == null)!
    expect(snapshot.prices.some(
      (price) => price.scope.modelRouteId === `${unpriced.provider.id}:${unpriced.model.id}`,
    )).toBe(false)

    const explicitlyZero = providers.flatMap((provider) => (
      Object.values(provider.models).map((model) => ({ provider, model }))
    )).find(({ model }) => model.cost?.input === 0 && model.cost.output === 0)!
    const zeroRates = snapshot.prices
      .filter((price) => price.scope.modelRouteId === `${explicitlyZero.provider.id}:${explicitlyZero.model.id}`)
      .flatMap((price) => price.rates)
    expect(zeroRates.some((rate) => rate.amountUsd === 0)).toBe(true)
    expect(snapshot.prices.every((price) => price.effectiveFrom === null)).toBe(true)

    const modePriced = providers.flatMap((provider) => (
      Object.values(provider.models).map((model) => ({ provider, model }))
    )).find(({ model }) => Object.values(model.experimental?.modes ?? {}).some(
      (mode) => mode.cost != null,
    ))!
    const modePrice = snapshot.prices.find((price) => (
      price.scope.modelRouteId === `${modePriced.provider.id}:${modePriced.model.id}`
      && price.scope.variantId?.startsWith('mode:')
    ))
    expect(modePrice?.scope.variantId).toBeDefined()

    const unknownLimit = snapshot.models.find((model) => model.id === 'openai:gpt-image-2')
    expect(unknownLimit?.contextWindow).toBeNull()
    expect(unknownLimit?.maxOutputTokens).toBeNull()
  })

  it('projects the first compatible breadth group as connectable but not verified', async () => {
    const artifact = parseModelsDevArtifactText(await readFile(BUNDLED_MODELS_DEV_PATH, 'utf8'))
    const snapshot = transformModelsDevArtifact(artifact, {
      source: 'bundled',
      connectableProviderRoutes: LLM_PROVIDER_ROUTE_BINDINGS,
    })
    const expectedCounts: Readonly<Record<string, number>> = {
      xai: 10,
      mistral: 33,
      groq: 15,
      togetherai: 35,
      deepinfra: 51,
      'fireworks-ai': 17,
      cerebras: 3,
    }

    for (const [providerId, count] of Object.entries(expectedCounts)) {
      const route = snapshot.routes.find(item => item.id === `route:${providerId}`)
      const models = snapshot.models.filter(model => model.providerRouteId === route?.id)
      const expectedBinding = LLM_PROVIDER_ROUTE_BINDINGS.get(providerId)
      expect(route).toMatchObject({
        kind: 'direct',
        connectable: true,
        apiBaseUrl: expectedBinding?.apiBaseUrl,
        transport: {
          runtimeId: 'loom',
          adapterId: providerId,
          protocol: 'openai-compatible',
          sdkPackage: 'openai',
        },
      })
      expect(models).toHaveLength(count)
      expect(models.every(model => model.billingKind === 'metered')).toBe(true)
      const textGenerationModels = models.filter(model => model.availability.connectable)
      expect(textGenerationModels.length).toBeGreaterThan(0)
      expect(models.every(model => !model.availability.credentialed)).toBe(true)
      expect(models.every(model => !model.availability.verified)).toBe(true)
    }
    expect(snapshot.models.filter(model => (
      Object.keys(expectedCounts).includes(model.id.split(':')[0] ?? '')
      && model.availability.connectable
    ))).toHaveLength(152)
    expect(snapshot.models.find(model => model.id === 'mistral:mistral-embed')?.availability)
      .toMatchObject({ connectable: false, credentialed: false, verified: false })
    expect(snapshot.models.find(model => model.id === 'xai:grok-imagine-image')?.availability)
      .toMatchObject({ connectable: false, credentialed: false, verified: false })
    expect(snapshot.models.find(model => model.id === 'groq:whisper-large-v3')?.availability)
      .toMatchObject({ connectable: false, credentialed: false, verified: false })
  })

  it('does not turn non-chat catalog rows into connected models when a provider key exists', async () => {
    const artifact = parseModelsDevArtifactText(await readFile(BUNDLED_MODELS_DEV_PATH, 'utf8'))
    const hub = new ProviderHubService({
      store: {
        load: async () => ({
          artifact,
          source: 'bundled',
          health: {
            status: 'fresh',
            activeGenerationId: `models-dev:${artifact.sha256.slice(0, 16)}`,
          },
        }),
        refresh: async () => { throw new Error('not used') },
      },
      connectableProviderRoutes: LLM_PROVIDER_ROUTE_BINDINGS,
      listConnections: async () => projectLlmCredentials([{
        id: 'cred_xai_fixture',
        name: 'xAI key',
        variableName: 'XAI_API_KEY',
        category: 'llm',
        authType: 'api-key',
        hint: '...test',
        trust: 'low',
        source: 'manual',
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
        status: 'ready',
      }]),
    })

    const connected = await hub.models({ providerFamilyId: 'xai', scope: 'connected' })
    const all = await hub.models({ providerFamilyId: 'xai', scope: 'all' })

    expect(connected.items).toHaveLength(6)
    expect(connected.items.every(item => item.model.availability.connectable)).toBe(true)
    expect(all.items.find(item => item.model.id === 'xai:grok-imagine-image')?.model.availability)
      .toMatchObject({ connectable: false, credentialed: false, verified: false })
  })

  it('projects fixed routers as metered text-generation routes without claiming verification', async () => {
    const artifact = parseModelsDevArtifactText(await readFile(BUNDLED_MODELS_DEV_PATH, 'utf8'))
    const snapshot = transformModelsDevArtifact(artifact, {
      source: 'bundled',
      connectableProviderRoutes: LLM_PROVIDER_ROUTE_BINDINGS,
    })
    const expected = {
      vercel: { total: 322, connectable: 231 },
      helicone: { total: 90, connectable: 90 },
    } as const

    for (const [providerId, counts] of Object.entries(expected)) {
      const route = snapshot.routes.find(item => item.id === `route:${providerId}`)
      const models = snapshot.models.filter(model => model.providerRouteId === route?.id)
      expect(route).toMatchObject({
        kind: 'router',
        connectable: true,
        transport: {
          runtimeId: 'loom',
          adapterId: providerId,
          protocol: 'openai-compatible',
          sdkPackage: 'openai',
        },
      })
      expect(models).toHaveLength(counts.total)
      expect(models.filter(model => model.availability.connectable)).toHaveLength(counts.connectable)
      expect(models.every(model => model.billingKind === 'metered')).toBe(true)
      expect(models.every(model => !model.availability.credentialed)).toBe(true)
      expect(models.every(model => !model.availability.verified)).toBe(true)
    }

    expect(snapshot.models.find(model => model.id === 'vercel:cohere/embed-v4.0')?.availability)
      .toMatchObject({ connectable: false, credentialed: false, verified: false })
  })
})
