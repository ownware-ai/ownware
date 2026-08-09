import { randomBytes } from 'node:crypto'
import {
  OpenAICompatibleProvider,
  assertSafeCredentialHeaderName,
  normalizeCompatibleBaseUrl,
  registerProvider,
  unregisterProvider,
} from '@ownware/loom'
import { z } from 'zod'
import type { CredentialStore } from '../credential/store/index.js'
import type { CredentialAuditRepository } from '../storage/security-repositories.js'
import type {
  ModelRoute,
  ProviderConnection,
  ProviderFamily,
  ProviderRoute,
} from './schema.js'
import type { ProviderHubDynamicProjection } from './service.js'

export const OPENAI_COMPATIBLE_SETTINGS_KEY = 'providerHub.openaiCompatibleConnections'

const RegistryIdSchema = z.string().regex(/^oai_[a-f0-9]{12}$/)
const ModelIdSchema = z.string().trim().min(1).max(1_000)
const ConnectionTemplateIdSchema = z.enum([
  'lmstudio',
  'ollama',
  'azure-openai',
  'amazon-bedrock-mantle',
])

const AuthConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({
    kind: z.literal('bearer'),
    credentialId: z.string().trim().min(1).max(512),
  }).strict(),
  z.object({
    kind: z.literal('header'),
    credentialId: z.string().trim().min(1).max(512),
    name: z.string().trim().min(1).max(200),
    prefix: z.string().max(100).regex(/^[\x20-\x7E]*$/).optional(),
  }).strict(),
])

const AuthInputSchema = z.union([
  z.object({ kind: z.literal('none') }).strict(),
  z.object({
    kind: z.literal('bearer'),
    credentialId: z.string().trim().min(1).max(512).optional(),
    key: z.string().min(1).max(65_536).optional(),
  }).strict().refine(
    auth => auth.credentialId == null || auth.key == null,
    'Provide a key or a credentialId, not both',
  ),
  z.object({
    kind: z.literal('header'),
    credentialId: z.string().trim().min(1).max(512).optional(),
    key: z.string().min(1).max(65_536).optional(),
    name: z.string().trim().min(1).max(200),
    prefix: z.string().max(100).regex(/^[\x20-\x7E]*$/).optional(),
  }).strict().refine(
    auth => auth.credentialId == null || auth.key == null,
    'Provide a key or a credentialId, not both',
  ),
])

const RequestCompatibilitySchema = z.object({
  maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
  streamUsage: z.enum(['include', 'omit']).default('omit'),
}).strict()

const ConnectionHealthSchema = z.object({
  status: z.enum(['unknown', 'healthy', 'degraded', 'failed']),
  checkedAt: z.string().datetime({ offset: true }).optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  errorCode: z.string().trim().min(1).max(200).optional(),
  errorMessage: z.string().trim().min(1).max(2_000).optional(),
}).strict()

export const OpenAICompatibleConnectionInputSchema = z.object({
  id: RegistryIdSchema.optional(),
  templateId: ConnectionTemplateIdSchema.optional(),
  label: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().min(1).max(2_000),
  auth: AuthInputSchema,
  manualModelIds: z.array(ModelIdSchema).max(1_000).default([]),
  discoveryEnabled: z.boolean().default(true),
  compatibility: RequestCompatibilitySchema.default({
    maxTokensField: 'max_tokens',
    streamUsage: 'omit',
  }),
}).strict()

export const OpenAICompatibleConnectionConfigSchema = z.object({
  schemaVersion: z.literal(1),
  id: RegistryIdSchema,
  templateId: ConnectionTemplateIdSchema.optional(),
  label: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().min(1).max(2_000),
  auth: AuthConfigSchema,
  manualModelIds: z.array(ModelIdSchema).max(1_000),
  discoveredModelIds: z.array(ModelIdSchema).max(1_000),
  discoveredAt: z.string().datetime({ offset: true }).optional(),
  discoveryEnabled: z.boolean(),
  compatibility: RequestCompatibilitySchema.default({
    maxTokensField: 'max_tokens',
    streamUsage: 'omit',
  }),
  health: ConnectionHealthSchema.default({ status: 'unknown' }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict()

const ConfigListSchema = z.array(OpenAICompatibleConnectionConfigSchema).max(100)

export type OpenAICompatibleConnectionInput = z.infer<typeof OpenAICompatibleConnectionInputSchema>
export type OpenAICompatibleConnectionConfig = z.infer<typeof OpenAICompatibleConnectionConfigSchema>

interface SettingsStore {
  getSetting(key: string): Promise<{ readonly value: string } | undefined>
  setSetting(key: string, value: string): Promise<unknown>
}

interface CompatibleProvider {
  discoverModels(signal?: AbortSignal): Promise<readonly string[]>
}

export interface OpenAICompatibleConnectionManagerOptions {
  readonly settings: SettingsStore
  readonly credentials: Pick<CredentialStore, 'get' | 'save' | 'update' | 'delete'>
  readonly credentialProviderFor: (variableName: string) => () => Promise<string>
  readonly audit?: Pick<CredentialAuditRepository, 'recordEvent'>
  readonly now?: () => string
  readonly providerFactory?: (options: ConstructorParameters<typeof OpenAICompatibleProvider>[0]) => CompatibleProvider
  readonly register?: (provider: OpenAICompatibleProvider) => void
  readonly unregister?: (id: string) => boolean
}

/** Secret-free persisted configuration + connection-scoped Loom registration. */
export class OpenAICompatibleConnectionManager {
  private readonly now: () => string
  private readonly providerFactory: NonNullable<OpenAICompatibleConnectionManagerOptions['providerFactory']>
  private readonly register: NonNullable<OpenAICompatibleConnectionManagerOptions['register']>
  private readonly unregister: NonNullable<OpenAICompatibleConnectionManagerOptions['unregister']>
  private registeredIds = new Set<string>()

  constructor(private readonly options: OpenAICompatibleConnectionManagerOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.providerFactory = options.providerFactory ?? (providerOptions => new OpenAICompatibleProvider(providerOptions))
    this.register = options.register ?? registerProvider
    this.unregister = options.unregister ?? unregisterProvider
  }

  async list(): Promise<readonly OpenAICompatibleConnectionConfig[]> {
    const raw = (await this.options.settings.getSetting(OPENAI_COMPATIBLE_SETTINGS_KEY))?.value
    if (raw == null || raw.trim().length === 0) return []
    return ConfigListSchema.parse(JSON.parse(raw))
  }

  async save(value: unknown): Promise<OpenAICompatibleConnectionConfig> {
    const input = OpenAICompatibleConnectionInputSchema.parse(value)
    const id = input.id ?? `oai_${randomBytes(6).toString('hex')}`
    const current = await this.list()
    const previous = current.find(connection => connection.id === id)
    const normalizedBaseUrl = normalizeCompatibleBaseUrl(input.baseUrl)
    const templateId = validateConnectionTemplate(input, normalizedBaseUrl)
    const authResult = await this.materializeAuth(id, input.label, input.auth, previous)
    const timestamp = this.now()
    const endpointChanged = previous != null && previous.baseUrl !== normalizedBaseUrl
    const templateChanged = previous != null && previous.templateId !== templateId
    const discoveryContractChanged = endpointChanged || templateChanged
    let next: OpenAICompatibleConnectionConfig
    try {
      next = OpenAICompatibleConnectionConfigSchema.parse({
        schemaVersion: 1,
        id,
        ...(templateId == null ? {} : { templateId }),
        label: input.label,
        baseUrl: normalizedBaseUrl,
        auth: authResult.auth,
        manualModelIds: normalizeModelIds(input.manualModelIds),
        discoveredModelIds: discoveryContractChanged ? [] : previous?.discoveredModelIds ?? [],
        ...(discoveryContractChanged || previous?.discoveredAt == null ? {} : { discoveredAt: previous.discoveredAt }),
        discoveryEnabled: input.discoveryEnabled,
        compatibility: input.compatibility,
        health: { status: 'unknown' },
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      })
      await this.persist([...current.filter(connection => connection.id !== id), next])
      await this.registerOne(next)
    } catch (error) {
      // Settings and the runtime registry form one logical connection state.
      // Restore both sides if validation, persistence, or registration fails.
      try {
        await this.persist(current)
      } catch {
        // Preserve the original failure; a settings-store failure cannot be
        // repaired here, but the runtime rollback below is still worthwhile.
      }
      try {
        this.unregister(id)
        this.registeredIds.delete(id)
        if (previous != null) await this.registerOne(previous)
      } catch {
        // Preserve the original save failure rather than masking it with a
        // best-effort rollback failure.
      }
      if (authResult.createdCredentialId != null) {
        await this.options.credentials.delete(authResult.createdCredentialId).catch(() => false)
      }
      throw error
    }
    const previousCredentialId = previous == null || previous.auth.kind === 'none'
      ? null
      : previous.auth.credentialId
    const nextCredentialId = next.auth.kind === 'none' ? null : next.auth.credentialId
    if (previousCredentialId != null && previousCredentialId !== nextCredentialId) {
      await this.options.audit?.recordEvent({
        credentialId: previousCredentialId,
        eventType: 'delete',
        outcome: 'ok',
        detail: { connectionId: id, reason: 'compatible auth replaced' },
      })
      await this.options.credentials.delete(previousCredentialId)
    }
    if (nextCredentialId != null) {
      await this.options.audit?.recordEvent({
        credentialId: nextCredentialId,
        eventType: previous == null ? 'create' : 'update',
        outcome: 'ok',
        detail: { connectionId: id, provider: 'openai-compatible' },
      })
    }
    return next
  }

  async remove(id: string): Promise<boolean> {
    const registryId = RegistryIdSchema.parse(id)
    const current = await this.list()
    if (!current.some(connection => connection.id === registryId)) return false
    const connection = current.find(item => item.id === registryId)!
    await this.persist(current.filter(item => item.id !== registryId))
    this.unregister(registryId)
    this.registeredIds.delete(registryId)
    if (connection.auth.kind !== 'none') {
      await this.options.audit?.recordEvent({
        credentialId: connection.auth.credentialId,
        eventType: 'delete',
        outcome: 'ok',
        detail: { connectionId: registryId, provider: 'openai-compatible' },
      })
      await this.options.credentials.delete(connection.auth.credentialId)
    }
    return true
  }

  async registerAll(): Promise<void> {
    const connections = await this.list()
    const configuredIds = new Set(connections.map(connection => connection.id))
    for (const id of this.registeredIds) {
      if (!configuredIds.has(id)) this.unregister(id)
    }
    for (const connection of connections) await this.registerOne(connection)
    this.registeredIds = configuredIds
  }

  async discover(id: string, signal?: AbortSignal): Promise<OpenAICompatibleConnectionConfig> {
    const registryId = RegistryIdSchema.parse(id)
    const current = await this.list()
    const connection = current.find(item => item.id === registryId)
    if (connection == null) throw new OpenAICompatibleConnectionNotFoundError(registryId)
    if (!connection.discoveryEnabled) throw new Error('Model discovery is disabled for this connection')
    const provider = await this.createProvider(connection)
    const startedAt = performance.now()
    try {
      const discoveredModelIds = normalizeModelIds(await provider.discoverModels(signal))
      const timestamp = this.now()
      const updated = OpenAICompatibleConnectionConfigSchema.parse({
        ...connection,
        discoveredModelIds,
        discoveredAt: timestamp,
        health: {
          status: 'healthy',
          checkedAt: timestamp,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        },
        updatedAt: timestamp,
      })
      await this.persist(current.map(item => item.id === registryId ? updated : item))
      await this.registerOne(updated)
      return updated
    } catch (error) {
      const timestamp = this.now()
      const failed = OpenAICompatibleConnectionConfigSchema.parse({
        ...connection,
        health: {
          status: connection.discoveredModelIds.length > 0 ? 'degraded' : 'failed',
          checkedAt: timestamp,
          errorCode: signal?.aborted === true ? 'discovery_timeout' : 'discovery_failed',
          errorMessage: signal?.aborted === true
            ? 'Model discovery timed out.'
            : 'The endpoint did not return a compatible model list.',
        },
        updatedAt: timestamp,
      })
      await this.persist(current.map(item => item.id === registryId ? failed : item))
      void error
      throw new Error(failed.health.errorMessage)
    }
  }

  async projection(): Promise<ProviderHubDynamicProjection> {
    const configs = await this.list()
    const credentialStates = new Map<string, 'ready' | 'error'>()
    for (const config of configs) {
      if (config.auth.kind === 'none') continue
      const credential = await this.options.credentials.get(config.auth.credentialId)
      credentialStates.set(config.id, credential?.status === 'ready' ? 'ready' : 'error')
    }
    return {
      families: configs.map(projectFamily),
      routes: configs.map(projectRoute),
      connections: configs.map(config => projectConnection(config, credentialStates.get(config.id))),
      models: configs.flatMap(config => projectModels(config, credentialStates.get(config.id))),
    }
  }

  private async validateAuth(
    id: string,
    auth: z.infer<typeof AuthConfigSchema>,
  ): Promise<z.infer<typeof AuthConfigSchema>> {
    if (auth.kind === 'none') return auth
    if (auth.kind === 'header') assertSafeCredentialHeaderName(auth.name)
    const credential = await this.options.credentials.get(auth.credentialId)
    if (credential == null || credential.category !== 'llm') {
      throw new Error('OpenAI-compatible auth must reference an existing LLM credential')
    }
    const expectedVariableName = credentialVariableName(id)
    if (credential.variableName !== expectedVariableName) {
      throw new Error(`Compatible credential variableName must be ${expectedVariableName}`)
    }
    return auth
  }

  private async materializeAuth(
    id: string,
    label: string,
    auth: OpenAICompatibleConnectionInput['auth'],
    previous: OpenAICompatibleConnectionConfig | undefined,
  ): Promise<{
    readonly auth: z.infer<typeof AuthConfigSchema>
    readonly createdCredentialId: string | null
  }> {
    if (auth.kind === 'none') return { auth, createdCredentialId: null }
    if (auth.kind === 'header') assertSafeCredentialHeaderName(auth.name)
    const previousCredentialId = previous == null || previous.auth.kind === 'none'
      ? null
      : previous.auth.credentialId
    let credentialId = auth.credentialId ?? previousCredentialId
    let createdCredentialId: string | null = null
    if (auth.key != null) {
      if (previousCredentialId == null) {
        const credential = await this.options.credentials.save({
          name: `${label} API key`,
          value: auth.key,
          category: 'llm',
          authType: auth.kind === 'bearer' ? 'bearer-token' : 'api-key',
          variableName: credentialVariableName(id),
          forConnector: `connection:${id}`,
          source: 'manual',
          tags: ['provider-hub', 'openai-compatible'],
        })
        credentialId = credential.id
        createdCredentialId = credential.id
      } else {
        const updated = await this.options.credentials.update(previousCredentialId, {
          name: `${label} API key`,
          value: auth.key,
        })
        if (updated == null) throw new Error('The existing compatible credential no longer exists')
      }
    }
    if (credentialId == null) {
      throw new Error('A key or dedicated credentialId is required for compatible authentication')
    }
    const configAuth = auth.kind === 'bearer'
      ? { kind: 'bearer' as const, credentialId }
      : {
          kind: 'header' as const,
          credentialId,
          name: auth.name,
          ...(auth.prefix == null ? {} : { prefix: auth.prefix }),
        }
    try {
      return {
        auth: await this.validateAuth(id, configAuth),
        createdCredentialId,
      }
    } catch (error) {
      if (createdCredentialId != null) {
        await this.options.credentials.delete(createdCredentialId).catch(() => false)
      }
      throw error
    }
  }

  private async createProvider(config: OpenAICompatibleConnectionConfig): Promise<CompatibleProvider> {
    const auth = config.auth.kind === 'none'
      ? { kind: 'none' as const }
      : config.auth.kind === 'bearer'
        ? {
            kind: 'bearer' as const,
            credentialProvider: this.options.credentialProviderFor(credentialVariableName(config.id)),
          }
        : {
            kind: 'header' as const,
            name: config.auth.name,
            ...(config.auth.prefix == null ? {} : { prefix: config.auth.prefix }),
            credentialProvider: this.options.credentialProviderFor(credentialVariableName(config.id)),
          }
    return this.providerFactory({
      name: config.id,
      baseURL: config.baseUrl,
      auth,
      maxTokensField: config.compatibility.maxTokensField,
      includeUsage: config.compatibility.streamUsage === 'include',
    })
  }

  private async registerOne(config: OpenAICompatibleConnectionConfig): Promise<void> {
    const provider = await this.createProvider(config)
    // The default factory is always the concrete Loom adapter. Tests can
    // replace both factory and registration to observe behavior in isolation.
    this.register(provider as OpenAICompatibleProvider)
    this.registeredIds.add(config.id)
  }

  private async persist(configs: readonly OpenAICompatibleConnectionConfig[]): Promise<void> {
    const validated = ConfigListSchema.parse([...configs].sort((a, b) => a.id.localeCompare(b.id)))
    await this.options.settings.setSetting(OPENAI_COMPATIBLE_SETTINGS_KEY, JSON.stringify(validated))
  }
}

export class OpenAICompatibleConnectionNotFoundError extends Error {
  readonly name = 'OpenAICompatibleConnectionNotFoundError'
}

export function credentialVariableName(id: string): string {
  return `OWNWARE_OAI_${RegistryIdSchema.parse(id).slice(4).toUpperCase()}_KEY`
}

function normalizeModelIds(values: readonly string[]): string[] {
  return [...new Set(values.map(value => ModelIdSchema.parse(value)))].sort((a, b) => a.localeCompare(b))
}

function validateConnectionTemplate(
  input: OpenAICompatibleConnectionInput,
  normalizedBaseUrl: string,
): OpenAICompatibleConnectionConfig['templateId'] {
  const templateId = input.templateId
  if (templateId == null) return undefined
  const url = new URL(normalizedBaseUrl)

  if (templateId === 'lmstudio' || templateId === 'ollama') {
    if (!isLoopbackEndpoint(normalizedBaseUrl)) {
      throw new Error(`${templateId === 'lmstudio' ? 'LM Studio' : 'Ollama'} templates require a loopback endpoint`)
    }
    return templateId
  }

  if (templateId === 'azure-openai') {
    const resourceName = url.hostname.split('.')[0]
    const validHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:openai\.azure\.com|services\.ai\.azure\.com)$/
      .test(url.hostname.toLowerCase())
    if (resourceName === 'resource-name' || !validHost || url.pathname !== '/openai/v1') {
      throw new Error('Azure OpenAI requires an exact resource URL ending in .openai.azure.com/openai/v1 or .services.ai.azure.com/openai/v1')
    }
    if (
      input.auth.kind !== 'header'
      || input.auth.name.toLowerCase() !== 'api-key'
      || (input.auth.prefix ?? '').length > 0
    ) {
      throw new Error('Azure OpenAI API-key connections require the api-key credential header without a prefix')
    }
    if (input.discoveryEnabled) {
      throw new Error('Azure OpenAI template discovery is disabled; provide exact deployment names')
    }
    if (normalizeModelIds(input.manualModelIds).length === 0) {
      throw new Error('Azure OpenAI requires at least one deployment name')
    }
    return templateId
  }

  const region = bedrockRegion(normalizedBaseUrl)
  if (region == null || url.pathname !== '/v1') {
    throw new Error('Amazon Bedrock Mantle requires https://bedrock-mantle.<region>.api.aws/v1')
  }
  if (input.auth.kind !== 'bearer') {
    throw new Error('Amazon Bedrock Mantle API keys require bearer authentication')
  }
  if (!input.discoveryEnabled && normalizeModelIds(input.manualModelIds).length === 0) {
    throw new Error('Amazon Bedrock Mantle requires model discovery or at least one manual model ID')
  }
  return templateId
}

function projectFamily(config: OpenAICompatibleConnectionConfig): ProviderFamily {
  return {
    id: `custom:${config.id}`,
    name: config.label,
    description: `User-configured OpenAI-compatible endpoint at ${new URL(config.baseUrl).host}.`,
    lifecycle: 'experimental',
  }
}

function isLoopbackEndpoint(baseUrl: string): boolean {
  const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function isCloudTemplate(templateId: OpenAICompatibleConnectionConfig['templateId']): boolean {
  return templateId === 'azure-openai' || templateId === 'amazon-bedrock-mantle'
}

function bedrockRegion(baseUrl: string): string | undefined {
  const hostname = new URL(baseUrl).hostname.toLowerCase()
  const match = /^bedrock-mantle\.([a-z]{2}(?:-[a-z0-9]+)+-\d)\.api\.aws$/.exec(hostname)
  return match?.[1]
}

function projectRoute(config: OpenAICompatibleConnectionConfig): ProviderRoute {
  const region = config.templateId === 'amazon-bedrock-mantle'
    ? bedrockRegion(config.baseUrl)
    : undefined
  return {
    id: `route:${config.id}`,
    familyId: `custom:${config.id}`,
    name: config.label,
    kind: isLoopbackEndpoint(config.baseUrl)
      ? 'local'
      : isCloudTemplate(config.templateId)
        ? 'cloud'
        : 'custom',
    transport: {
      runtimeId: 'loom',
      adapterId: config.id,
      protocol: 'openai-chat-completions',
    },
    apiBaseUrl: config.baseUrl,
    ...(region == null ? {} : { region }),
    connectable: true,
    lifecycle: 'experimental',
    sourceRef: `user-settings:${OPENAI_COMPATIBLE_SETTINGS_KEY}`,
  }
}

function projectConnection(
  config: OpenAICompatibleConnectionConfig,
  credentialState: 'ready' | 'error' | undefined,
): ProviderConnection {
  const region = config.templateId === 'amazon-bedrock-mantle'
    ? bedrockRegion(config.baseUrl)
    : undefined
  const status = config.auth.kind === 'none' || credentialState === 'ready' ? 'configured' : 'error'
  const auth: ProviderConnection['auth'] = config.auth.kind === 'none'
    ? { kind: 'none' }
    : config.auth.kind === 'bearer'
      ? {
          kind: 'api_key',
          credentialId: config.auth.credentialId,
          placement: { location: 'bearer' },
        }
      : {
          kind: 'custom_headers',
          headers: [{
            name: config.auth.name,
            ...(config.auth.prefix == null ? {} : { prefix: config.auth.prefix }),
            credentialId: config.auth.credentialId,
          }],
        }
  return {
    id: `connection:${config.id}`,
    providerRouteId: `route:${config.id}`,
    label: config.label,
    auth,
    settings: {
      baseUrl: config.baseUrl,
      ...(region == null ? {} : { region }),
      ...(config.templateId === 'azure-openai' && config.manualModelIds.length === 1
        ? { deployment: config.manualModelIds[0] }
        : {}),
      ...(config.discoveryEnabled ? { discoveryPath: '/models' } : {}),
      manualModelIds: config.manualModelIds,
      openaiCompatibility: config.compatibility,
    },
    status,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
    ...(status === 'error'
      ? { health: { status: 'failed', errorCode: 'credential_unavailable', errorMessage: 'Referenced credential is missing or unavailable.' } }
      : { health: config.health }),
  }
}

const CAPABILITIES: ModelRoute['capabilities'][number]['capability'][] = [
  'text_streaming',
  'terminal_events',
  'error_semantics',
  'tool_calls',
  'parallel_tool_calls',
  'cancellation',
  'reasoning',
  'image_input',
  'pdf_input',
  'audio_input',
  'video_input',
  'structured_output',
  'prompt_caching',
  'usage_reporting',
  'provider_reported_cost',
]

function projectModels(
  config: OpenAICompatibleConnectionConfig,
  credentialState: 'ready' | 'error' | undefined,
): ModelRoute[] {
  const ids = normalizeModelIds([...config.manualModelIds, ...config.discoveredModelIds])
  const discoveredIds = new Set(config.discoveredModelIds)
  const credentialed = config.auth.kind === 'none' || credentialState === 'ready'
  return ids.map(wireModelId => ({
    id: `${config.id}:${wireModelId}`,
    providerRouteId: `route:${config.id}`,
    wireModelId,
    name: wireModelId,
    aliases: [],
    contextWindow: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    capabilities: CAPABILITIES.map(capability => ({
      capability,
      upstream: { status: 'unknown' as const },
      ownware: { status: 'untested' as const },
    })),
    variants: [],
    availability: {
      catalogued: true,
      connectable: true,
      credentialed,
      verified: false,
      recommended: false,
      lifecycle: 'experimental',
      connectionIds: credentialed ? [`connection:${config.id}`] : [],
      reason: 'User-supplied compatible route; model capabilities and pricing have not been verified.',
    },
    billingKind: isLoopbackEndpoint(config.baseUrl) ? 'local' : 'unknown',
    catalogSourceRef: discoveredIds.has(wireModelId)
      ? `connection:${config.id}:models:${config.discoveredAt ?? 'unknown'}`
      : `connection:${config.id}:manual`,
  }))
}
