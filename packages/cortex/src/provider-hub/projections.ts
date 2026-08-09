import type { Credential } from '../credential/schema.js'
import type {
  CodexAccountState,
  CodexModel,
  CodexModelCatalog,
} from '../runtime/codex/account.js'
import {
  VARIABLE_NAME_TO_PROVIDER_ID,
  llmProviderById,
} from '../gateway/llm-providers.js'
import {
  ModelRouteSchema,
  ProviderConnectionSchema,
  ProviderFamilySchema,
  ProviderRouteSchema,
  type ModelCapabilityStatus,
  type ProviderCapability,
  type ProviderConnection,
} from './schema.js'
import type { ProviderHubDynamicProjection } from './service.js'
import type { ProviderHubLegacyModelPolicy } from './service.js'

const CAPABILITIES: readonly ProviderCapability[] = [
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

export interface LegacyCatalogModel {
  readonly id: string
  readonly name: string
  readonly provider: string
  readonly tier: 'flagship' | 'balanced' | 'fast' | 'legacy' | 'preview'
  readonly description?: string
  readonly aliases: readonly string[]
  readonly releaseDate?: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly capabilities: readonly string[]
  readonly default?: boolean
  readonly deprecated?: boolean
  readonly orSlug?: string
}

/**
 * Stable-id/default compatibility metadata. Objective facts come from
 * Models.dev unless an explicitly retained historical row is absent there;
 * those narrow fallback facts are still ingested into Provider Hub rather
 * than read directly by a consumer.
 */
export function projectLegacyModelPolicies(
  models: readonly LegacyCatalogModel[],
): ProviderHubLegacyModelPolicy[] {
  return models.map(model => ({
    id: model.id,
    providerId: model.provider,
    tier: model.tier,
    sourceModelRouteId: model.provider === 'openrouter' && model.orSlug != null
      ? `openrouter:${model.orSlug}`
      : model.id,
    providerRouteId: `route:${model.provider}`,
    wireModelId: model.provider === 'openrouter' && model.orSlug != null
      ? model.orSlug
      : model.id.slice(model.provider.length + 1),
    name: model.name,
    ...(model.description == null ? {} : { description: model.description }),
    aliases: model.aliases,
    ...(model.releaseDate == null ? {} : { releaseDate: model.releaseDate }),
    ...(model.contextWindow == null ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxOutputTokens == null ? {} : { maxOutputTokens: model.maxOutputTokens }),
    capabilities: model.capabilities,
    recommended: model.default === true,
    deprecated: model.deprecated === true,
    ...(model.orSlug == null ? {} : { openRouterSlug: model.orSlug }),
    billingKind: model.provider === 'openrouter'
      ? 'provider_reported'
      : model.provider === 'ollama' ? 'local' : 'metered',
  }))
}

/** Secret-free projections for API keys owned by this process environment. */
export function projectAmbientLlmConnections(
  providerIds: readonly string[],
  observedAt: string,
): ProviderConnection[] {
  return [...new Set(providerIds)].flatMap(providerId => {
    const descriptor = llmProviderById(providerId)
    if (descriptor == null) return []
    return [ProviderConnectionSchema.parse({
      id: `connection:ambient:${providerId}`,
      providerRouteId: `route:${providerId}`,
      label: `${descriptor.name} (environment)`,
      auth: {
        kind: 'ambient_api_key',
        variableName: descriptor.variableName,
      },
      settings: {},
      status: 'configured',
      createdAt: observedAt,
      updatedAt: observedAt,
      health: { status: 'unknown' },
    })]
  })
}

/** Route and live connection projection for Ownware's keyless Ollama adapter. */
export function projectOllamaLocal(
  reachable: boolean,
  observedAt: string,
): ProviderHubDynamicProjection {
  const family = ProviderFamilySchema.parse({
    id: 'ollama',
    name: 'Ollama',
    description: 'Keyless models served by the operator\'s Ollama runtime.',
    websiteUrl: 'https://ollama.com/',
    lifecycle: 'active',
  })
  const route = ProviderRouteSchema.parse({
    id: 'route:ollama',
    familyId: family.id,
    name: 'Local Ollama',
    kind: 'local',
    transport: {
      runtimeId: 'loom',
      adapterId: 'ollama',
      protocol: 'ollama-openai-compatible',
      sdkPackage: 'openai',
    },
    connectable: true,
    lifecycle: 'active',
    sourceRef: 'runtime:loom:ollama',
  })
  return {
    families: [family],
    routes: [route],
    connections: reachable
      ? [ProviderConnectionSchema.parse({
          id: 'connection:ollama-local',
          providerRouteId: route.id,
          label: 'Local Ollama',
          auth: { kind: 'local_endpoint' },
          settings: {},
          status: 'configured',
          createdAt: observedAt,
          updatedAt: observedAt,
          health: { status: 'healthy', checkedAt: observedAt },
        })]
      : [],
  }
}

/** Converts the unified credential metadata into secret-free provider connections. */
export function projectLlmCredentials(credentials: readonly Credential[]): ProviderConnection[] {
  return credentials.flatMap(credential => {
    const providerId = VARIABLE_NAME_TO_PROVIDER_ID[credential.variableName ?? '']
    if (credential.category !== 'llm' || providerId == null) return []
    const isRouter = llmProviderById(providerId)?.routeKind === 'router'
    return [ProviderConnectionSchema.parse({
      id: `connection:${credential.id}`,
      providerRouteId: `route:${providerId}`,
      label: credential.name,
      auth: {
        kind: isRouter ? 'router_key' : 'api_key',
        credentialId: credential.id,
        placement: { location: 'bearer' },
      },
      settings: {},
      status: credential.status === 'ready'
        ? 'configured'
        : credential.status === 'revoked'
          ? 'disabled'
          : 'error',
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
      health: credential.status === 'ready'
        ? { status: 'unknown' }
        : {
            status: 'failed',
            errorCode: `credential_${credential.status}`,
            errorMessage: credential.statusReason ?? `Credential is ${credential.status}`,
          },
    })]
  })
}

/** Token-blind projection of the Codex App Server's account and model catalog. */
export function projectCodexSubscription(
  account: CodexAccountState,
  catalog: CodexModelCatalog,
): ProviderHubDynamicProjection {
  const connected = account.state === 'authenticated'
  const observedAt = catalog.observedAt
  const family = ProviderFamilySchema.parse({
    id: 'openai-chatgpt',
    name: 'OpenAI ChatGPT',
    description: 'ChatGPT subscription models executed by the Codex App Server runtime.',
    websiteUrl: 'https://chatgpt.com/',
    brandId: 'openai',
    lifecycle: 'active',
  })
  const route = ProviderRouteSchema.parse({
    id: 'route:codex-subscription',
    familyId: family.id,
    name: 'Codex subscription',
    kind: 'subscription',
    transport: {
      runtimeId: 'codex-app-server',
      protocol: 'codex-app-server-jsonrpc',
    },
    connectable: true,
    ...(connected ? { plan: account.plan } : {}),
    lifecycle: 'active',
    sourceRef: 'runtime:codex:model-list',
  })
  const connection = connected
    ? [ProviderConnectionSchema.parse({
        id: 'connection:codex-subscription',
        providerRouteId: route.id,
        label: 'ChatGPT account',
        auth: {
          kind: 'oauth_subscription',
          ownerRuntimeId: 'openai-codex',
        },
        settings: {
          account: account.plan,
        },
        status: 'configured',
        createdAt: observedAt,
        updatedAt: observedAt,
        health: { status: 'healthy', checkedAt: observedAt },
      })]
    : []
  return {
    families: [family],
    routes: [route],
    connections: connection,
    models: catalog.models.map(model => ModelRouteSchema.parse({
      id: `codex:${model.model}`,
      providerRouteId: route.id,
      wireModelId: model.model,
      name: model.displayName,
      ...(model.description == null ? {} : { description: model.description }),
      aliases: model.id === model.model ? [] : [model.id],
      contextWindow: null,
      maxInputTokens: null,
      maxOutputTokens: null,
      capabilities: codexCapabilities(model),
      variants: [
        ...model.reasoningEfforts.map(effort => ({
          id: `reasoning:${effort}`,
          kind: 'reasoning_effort' as const,
          label: effort,
          value: effort,
          availability: 'available' as const,
          verification: { status: 'untested' as const },
        })),
        ...model.serviceTiers.map(tier => ({
          id: `service-tier:${tier}`,
          kind: 'service_tier' as const,
          label: tier,
          value: tier,
          availability: 'available' as const,
          verification: { status: 'untested' as const },
        })),
        ...(model.supportsPersonality === true ? [{
          id: 'personality:selectable',
          kind: 'personality' as const,
          label: 'Selectable personality',
          value: true,
          availability: 'available' as const,
          verification: { status: 'untested' as const },
        }] : []),
      ],
      defaultVariantIds: [
        ...(!model.reasoningEfforts.includes(model.defaultReasoningEffort)
          ? []
          : [`reasoning:${model.defaultReasoningEffort}`]),
        ...(model.defaultServiceTier == null
          || !model.serviceTiers.includes(model.defaultServiceTier)
          ? []
          : [`service-tier:${model.defaultServiceTier}`]),
      ],
      availability: {
        catalogued: true,
        connectable: true,
        credentialed: connected,
        verified: false,
        recommended: model.isDefault === true,
        lifecycle: model.hidden === true ? 'hidden' : 'active',
        connectionIds: connected ? ['connection:codex-subscription'] : [],
        reason: 'Catalogued by Codex App Server; Ownware capability verification remains independent.',
      },
      billingKind: 'subscription',
      catalogSourceRef: 'runtime:codex:model-list',
    })),
    prices: [],
  }
}

function codexCapabilities(model: CodexModel): ModelCapabilityStatus[] {
  return CAPABILITIES.map(capability => ({
    capability,
    upstream: {
      status: codexCapabilityStatus(model, capability),
      source: 'runtime',
      sourceRef: 'codex:model-list',
    },
    ownware: { status: 'untested' },
  }))
}

function codexCapabilityStatus(
  model: CodexModel,
  capability: ProviderCapability,
): 'supported' | 'unsupported' | 'unknown' {
  if (capability === 'reasoning') {
    return model.reasoningEfforts.length > 0 ? 'supported' : 'unknown'
  }
  if (capability === 'image_input') {
    return model.inputModalities == null
      ? 'unknown'
      : model.inputModalities.includes('image') ? 'supported' : 'unsupported'
  }
  if (capability === 'provider_reported_cost') return 'unsupported'
  return 'unknown'
}
