import { describe, expect, it, vi } from 'vitest'
import type { Credential } from '../../../src/credential/schema.js'
import {
  ModelRouteSchema,
  ProviderConnectionSchema,
  ProviderFamilySchema,
  ProviderRouteSchema,
} from '../../../src/provider-hub/schema.js'
import {
  OPENAI_COMPATIBLE_SETTINGS_KEY,
  OpenAICompatibleConnectionManager,
  credentialVariableName,
} from '../../../src/provider-hub/openai-compatible.js'

const CONNECTION_ID = 'oai_0123456789ab'
const CREDENTIAL_ID = 'cred_0123456789ab'

describe('OpenAICompatibleConnectionManager', () => {
  it('persists only secret-free config, registers a scoped adapter, and projects unverified models', async () => {
    const settings = memorySettings()
    const register = vi.fn()
    const providerFactory = vi.fn(() => ({
      discoverModels: async () => ['discovered/model', 'manual-model'],
    }))
    const credentialProviderFor = vi.fn(() => async () => 'never-persist-this-secret')
    const manager = new OpenAICompatibleConnectionManager({
      settings,
      credentials: { get: async () => credential() },
      credentialProviderFor,
      now: () => '2026-08-09T00:00:00.000Z',
      providerFactory,
      register,
      unregister: vi.fn(() => true),
    })

    const saved = await manager.save({
      id: CONNECTION_ID,
      label: 'Fixture Cloud',
      baseUrl: 'https://llm.example.test/v1/',
      auth: {
        kind: 'header',
        name: 'x-api-key',
        prefix: 'Key ',
        credentialId: CREDENTIAL_ID,
      },
      manualModelIds: ['manual-model'],
      discoveryEnabled: true,
    })

    expect(saved.baseUrl).toBe('https://llm.example.test/v1')
    expect(register).toHaveBeenCalledOnce()
    expect(credentialProviderFor).toHaveBeenCalledWith('OWNWARE_OAI_0123456789AB_KEY')
    const persisted = (await settings.getSetting(OPENAI_COMPATIBLE_SETTINGS_KEY))?.value ?? ''
    expect(persisted).not.toContain('never-persist-this-secret')
    expect(persisted).toContain(CREDENTIAL_ID)

    const discovered = await manager.discover(CONNECTION_ID)
    expect(discovered.discoveredModelIds).toEqual(['discovered/model', 'manual-model'])

    const projection = await manager.projection()
    expect(projection.families?.map(value => ProviderFamilySchema.parse(value))).toHaveLength(1)
    expect(projection.routes?.map(value => ProviderRouteSchema.parse(value))).toHaveLength(1)
    expect(projection.connections?.map(value => ProviderConnectionSchema.parse(value))).toHaveLength(1)
    const models = projection.models?.map(value => ModelRouteSchema.parse(value)) ?? []
    expect(models.map(model => model.id)).toEqual([
      `${CONNECTION_ID}:discovered/model`,
      `${CONNECTION_ID}:manual-model`,
    ])
    expect(models.every(model => !model.availability.verified)).toBe(true)
    expect(models.every(model => model.billingKind === 'unknown')).toBe(true)
    expect(projection.prices).toBeUndefined()
  })

  it('allows unauthenticated loopback endpoints and removes their registry entry', async () => {
    const settings = memorySettings()
    const unregister = vi.fn(() => true)
    const manager = new OpenAICompatibleConnectionManager({
      settings,
      credentials: { get: async () => null },
      credentialProviderFor: () => async () => '',
      now: () => '2026-08-09T00:00:00.000Z',
      providerFactory: () => ({ discoverModels: async () => [] }),
      register: vi.fn(),
      unregister,
    })
    await manager.save({
      id: CONNECTION_ID,
      templateId: 'ollama',
      label: 'Local fixture',
      baseUrl: 'http://127.0.0.1:11434/v1',
      auth: { kind: 'none' },
      manualModelIds: ['local-model'],
      discoveryEnabled: false,
    })

    const projection = await manager.projection()
    expect(projection.routes?.[0]?.kind).toBe('local')
    expect(projection.connections?.[0]?.auth).toEqual({ kind: 'none' })
    expect(projection.connections?.[0]?.status).toBe('configured')
    await expect(manager.discover(CONNECTION_ID)).rejects.toThrow(/disabled/)
    await expect(manager.remove(CONNECTION_ID)).resolves.toBe(true)
    expect(unregister).toHaveBeenCalledWith(CONNECTION_ID)
    expect(await manager.list()).toEqual([])
  })

  it('projects a validated Azure OpenAI v1 deployment connection as an unverified cloud route', async () => {
    const manager = new OpenAICompatibleConnectionManager({
      settings: memorySettings(),
      credentials: { get: async () => credential() },
      credentialProviderFor: () => async () => 'resolved-at-request-time',
      providerFactory: () => ({ discoverModels: async () => [] }),
      register: vi.fn(),
      now: () => '2026-08-09T00:00:00.000Z',
    })

    const saved = await manager.save({
      id: CONNECTION_ID,
      templateId: 'azure-openai',
      label: 'Azure production',
      baseUrl: 'https://ownware-prod.openai.azure.com/openai/v1/',
      auth: { kind: 'header', name: 'api-key', credentialId: CREDENTIAL_ID },
      manualModelIds: ['chat-production'],
      discoveryEnabled: false,
    })

    expect(saved.templateId).toBe('azure-openai')
    expect(saved.baseUrl).toBe('https://ownware-prod.openai.azure.com/openai/v1')
    const projection = await manager.projection()
    expect(ProviderRouteSchema.parse(projection.routes?.[0])).toMatchObject({
      kind: 'cloud',
      apiBaseUrl: 'https://ownware-prod.openai.azure.com/openai/v1',
    })
    expect(ProviderConnectionSchema.parse(projection.connections?.[0])).toMatchObject({
      auth: {
        kind: 'custom_headers',
        headers: [{ name: 'api-key', credentialId: CREDENTIAL_ID }],
      },
      settings: { deployment: 'chat-production' },
    })
    expect(projection.models?.[0]).toMatchObject({
      wireModelId: 'chat-production',
      billingKind: 'unknown',
      availability: { verified: false },
    })
  })

  it('rejects Azure template shortcuts that could target the wrong host, auth, or model name', async () => {
    const manager = new OpenAICompatibleConnectionManager({
      settings: memorySettings(),
      credentials: { get: async () => credential() },
      credentialProviderFor: () => async () => 'resolved-at-request-time',
      providerFactory: () => ({ discoverModels: async () => [] }),
      register: vi.fn(),
    })
    const baseInput = {
      id: CONNECTION_ID,
      templateId: 'azure-openai' as const,
      label: 'Azure invalid fixture',
      auth: { kind: 'header' as const, name: 'api-key', credentialId: CREDENTIAL_ID },
      manualModelIds: ['deployment-name'],
      discoveryEnabled: false,
    }

    await expect(manager.save({
      ...baseInput,
      baseUrl: 'https://RESOURCE-NAME.openai.azure.com/openai/v1',
    })).rejects.toThrow(/exact resource URL/)
    await expect(manager.save({
      ...baseInput,
      baseUrl: 'https://ownware-prod.openai.azure.com/openai/v1',
      auth: { kind: 'bearer', credentialId: CREDENTIAL_ID },
    })).rejects.toThrow(/api-key credential header/)
    await expect(manager.save({
      ...baseInput,
      baseUrl: 'https://ownware-prod.openai.azure.com/openai/v1',
      manualModelIds: [],
    })).rejects.toThrow(/deployment name/)
  })

  it('discovers regional Amazon Bedrock Mantle model IDs through an unverified cloud route', async () => {
    const manager = new OpenAICompatibleConnectionManager({
      settings: memorySettings(),
      credentials: { get: async () => credential() },
      credentialProviderFor: () => async () => 'resolved-at-request-time',
      providerFactory: () => ({
        discoverModels: async () => ['anthropic.claude-sonnet-4-5-20250929-v1:0'],
      }),
      register: vi.fn(),
      now: () => '2026-08-09T00:00:00.000Z',
    })

    await expect(manager.save({
      id: CONNECTION_ID,
      templateId: 'amazon-bedrock-mantle',
      label: 'Bedrock unresolved',
      baseUrl: 'https://bedrock-mantle.REGION.api.aws/v1',
      auth: { kind: 'bearer', credentialId: CREDENTIAL_ID },
      manualModelIds: [],
      discoveryEnabled: true,
    })).rejects.toThrow(/bedrock-mantle/)

    await manager.save({
      id: CONNECTION_ID,
      templateId: 'amazon-bedrock-mantle',
      label: 'Bedrock us-east-1',
      baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/v1',
      auth: { kind: 'bearer', credentialId: CREDENTIAL_ID },
      manualModelIds: [],
      discoveryEnabled: true,
    })
    const discovered = await manager.discover(CONNECTION_ID)
    expect(discovered.discoveredModelIds).toEqual(['anthropic.claude-sonnet-4-5-20250929-v1:0'])

    const projection = await manager.projection()
    expect(ProviderRouteSchema.parse(projection.routes?.[0])).toMatchObject({
      kind: 'cloud',
      region: 'us-east-1',
    })
    expect(ProviderConnectionSchema.parse(projection.connections?.[0])).toMatchObject({
      auth: { kind: 'api_key', placement: { location: 'bearer' } },
      settings: { region: 'us-east-1', discoveryPath: '/models' },
    })
    expect(projection.models?.[0]).toMatchObject({
      billingKind: 'unknown',
      availability: { verified: false },
    })
  })

  it('classifies HTTPS loopback routes as local for both routing and billing', async () => {
    const manager = new OpenAICompatibleConnectionManager({
      settings: memorySettings(),
      credentials: { get: async () => null },
      credentialProviderFor: () => async () => '',
      providerFactory: () => ({ discoverModels: async () => [] }),
      register: vi.fn(),
    })
    await manager.save({
      id: CONNECTION_ID,
      label: 'TLS local fixture',
      baseUrl: 'https://localhost:1234/v1',
      auth: { kind: 'none' },
      manualModelIds: ['local-model'],
      discoveryEnabled: false,
    })

    const projection = await manager.projection()
    expect(projection.routes?.[0]?.kind).toBe('local')
    expect(projection.models?.[0]?.billingKind).toBe('local')
  })

  it('rejects remote HTTP and credentials not dedicated to the connection', async () => {
    const manager = new OpenAICompatibleConnectionManager({
      settings: memorySettings(),
      credentials: { get: async () => credential({ variableName: 'SHARED_KEY' }) },
      credentialProviderFor: () => async () => 'secret',
      providerFactory: () => ({ discoverModels: async () => [] }),
      register: vi.fn(),
    })
    await expect(manager.save({
      id: CONNECTION_ID,
      label: 'Unsafe',
      baseUrl: 'http://example.test/v1',
      auth: { kind: 'none' },
      manualModelIds: [],
      discoveryEnabled: false,
    })).rejects.toThrow(/HTTPS/)
    await expect(manager.save({
      id: CONNECTION_ID,
      label: 'Wrong key',
      baseUrl: 'https://example.test/v1',
      auth: { kind: 'bearer', credentialId: CREDENTIAL_ID },
      manualModelIds: [],
      discoveryEnabled: false,
    })).rejects.toThrow(credentialVariableName(CONNECTION_ID))
  })

  it('stores a submitted key only in the credential store and deletes it with the connection', async () => {
    const settings = memorySettings()
    const savedCredential = credential()
    const credentials = {
      get: vi.fn(async (id: string) => id === savedCredential.id ? savedCredential : null),
      save: vi.fn(async () => savedCredential),
      update: vi.fn(async () => savedCredential),
      delete: vi.fn(async () => true),
    }
    const providerFactory = vi.fn(() => ({ discoverModels: async () => [] }))
    const manager = new OpenAICompatibleConnectionManager({
      settings,
      credentials,
      credentialProviderFor: () => async () => 'resolved-at-request-time',
      providerFactory,
      register: vi.fn(),
      unregister: vi.fn(() => true),
      now: () => '2026-08-09T00:00:00.000Z',
    })

    const saved = await manager.save({
      id: CONNECTION_ID,
      label: 'Secret fixture',
      baseUrl: 'https://llm.example.test/v1',
      auth: { kind: 'bearer', key: 'fixture-plaintext-secret' },
      manualModelIds: ['fixture-model'],
      discoveryEnabled: false,
      compatibility: {
        maxTokensField: 'max_completion_tokens',
        streamUsage: 'include',
      },
    })

    expect(credentials.save).toHaveBeenCalledWith(expect.objectContaining({
      value: 'fixture-plaintext-secret',
      variableName: credentialVariableName(CONNECTION_ID),
      forConnector: `connection:${CONNECTION_ID}`,
    }))
    expect(JSON.stringify(saved)).not.toContain('fixture-plaintext-secret')
    expect((await settings.getSetting(OPENAI_COMPATIBLE_SETTINGS_KEY))?.value).not.toContain('fixture-plaintext-secret')
    expect(providerFactory).toHaveBeenCalledWith(expect.objectContaining({
      maxTokensField: 'max_completion_tokens',
      includeUsage: true,
    }))

    await expect(manager.remove(CONNECTION_ID)).resolves.toBe(true)
    expect(credentials.delete).toHaveBeenCalledWith(CREDENTIAL_ID)
  })

  it('rolls back persisted config and a newly created credential when registration fails', async () => {
    const settings = memorySettings()
    const savedCredential = credential()
    const credentials = {
      get: vi.fn(async (id: string) => id === savedCredential.id ? savedCredential : null),
      save: vi.fn(async () => savedCredential),
      update: vi.fn(async () => savedCredential),
      delete: vi.fn(async () => true),
    }
    const manager = new OpenAICompatibleConnectionManager({
      settings,
      credentials,
      credentialProviderFor: () => async () => 'request-only',
      providerFactory: () => { throw new Error('adapter registration failed') },
      register: vi.fn(),
      unregister: vi.fn(() => true),
    })

    await expect(manager.save({
      id: CONNECTION_ID,
      label: 'Failed fixture',
      baseUrl: 'https://llm.example.test/v1',
      auth: { kind: 'bearer', key: 'fixture-plaintext-secret' },
      manualModelIds: ['fixture-model'],
      discoveryEnabled: false,
    })).rejects.toThrow('adapter registration failed')

    expect(await manager.list()).toEqual([])
    expect(credentials.delete).toHaveBeenCalledWith(CREDENTIAL_ID)
  })

  it('keeps discovered last-known-good model ids when refresh fails', async () => {
    const settings = memorySettings()
    let failDiscovery = false
    const manager = new OpenAICompatibleConnectionManager({
      settings,
      credentials: {
        get: async () => null,
        save: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(async () => true),
      },
      credentialProviderFor: () => async () => '',
      providerFactory: () => ({
        discoverModels: async () => {
          if (failDiscovery) throw new Error('upstream echoed unsafe detail')
          return ['last-known-good']
        },
      }),
      register: vi.fn(),
      now: () => '2026-08-09T00:00:00.000Z',
    })
    await manager.save({
      id: CONNECTION_ID,
      label: 'Local fixture',
      baseUrl: 'http://127.0.0.1:11434/v1',
      auth: { kind: 'none' },
      manualModelIds: [],
      discoveryEnabled: true,
    })
    const healthy = await manager.discover(CONNECTION_ID)
    expect(healthy.discoveredModelIds).toEqual(['last-known-good'])
    expect(healthy.health.status).toBe('healthy')

    failDiscovery = true
    await expect(manager.discover(CONNECTION_ID)).rejects.toThrow(/compatible model list/)
    const degraded = (await manager.list())[0]!
    expect(degraded.discoveredModelIds).toEqual(['last-known-good'])
    expect(degraded.health).toMatchObject({
      status: 'degraded',
      errorCode: 'discovery_failed',
    })
    expect(degraded.health.errorMessage).not.toContain('unsafe detail')
  })
})

function memorySettings() {
  const values = new Map<string, string>()
  return {
    getSetting: async (key: string) => {
      const value = values.get(key)
      return value == null ? undefined : { value }
    },
    setSetting: async (key: string, value: string) => {
      values.set(key, value)
      return { value }
    },
  }
}

function credential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: CREDENTIAL_ID,
    name: 'Fixture compatible key',
    category: 'llm',
    authType: 'api-key',
    variableName: credentialVariableName(CONNECTION_ID),
    hint: '...cret',
    trust: 'low',
    source: 'manual',
    tags: [],
    status: 'ready',
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
    ...overrides,
  }
}
