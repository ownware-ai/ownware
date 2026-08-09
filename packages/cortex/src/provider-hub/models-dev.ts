import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  CapabilityVerificationSchema,
  HttpUrlSchema,
  IsoDateTimeSchema,
  ModelRouteSchema,
  PricebookEntrySchema,
  PROVIDER_HUB_SCHEMA_VERSION,
  ProviderCatalogSnapshotSchema,
  ProviderFamilySchema,
  ProviderRouteSchema,
  type ModelCapabilityStatus,
  type ModelRoute,
  type ModelVariant,
  type PricebookEntry,
  type ProviderCapability,
  type ProviderCatalogSnapshot,
  type ProviderFamily,
  type ProviderRoute,
} from './schema.js'

const RawModalitiesSchema = z.object({
  input: z.array(z.enum(['text', 'audio', 'image', 'video', 'pdf'])),
  output: z.array(z.enum(['text', 'audio', 'image', 'video', 'pdf'])),
}).strict()

const RawReasoningOptionSchema = z.union([
  z.object({
    type: z.literal('effort'),
    values: z.array(z.string().nullable()),
  }).strict(),
  z.object({ type: z.literal('toggle') }).strict(),
  z.object({
    type: z.literal('budget_tokens'),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  }).strict(),
])

const RawCostShape = {
  input: z.number().finite().nonnegative().optional(),
  output: z.number().finite().nonnegative().optional(),
  cache_read: z.number().finite().nonnegative().optional(),
  cache_write: z.number().finite().nonnegative().optional(),
  reasoning: z.number().finite().nonnegative().optional(),
  input_audio: z.number().finite().nonnegative().optional(),
  output_audio: z.number().finite().nonnegative().optional(),
}

const RawContextCostSchema = z.object(RawCostShape).passthrough()

const RawCostTierSchema = z.object({
  ...RawCostShape,
  tier: z.object({
    type: z.literal('context'),
    size: z.number().int().positive(),
  }).strict(),
}).passthrough()

const RawCostSchema = z.object({
  ...RawCostShape,
  tiers: z.array(RawCostTierSchema).optional(),
  context_over_200k: RawContextCostSchema.optional(),
}).passthrough()

const RawExperimentalModeSchema = z.object({
  cost: RawCostSchema.optional(),
  provider: z.object({
    body: z.record(z.unknown()).optional(),
    headers: z.record(z.string()).optional(),
  }).passthrough().optional(),
}).passthrough()

export const ModelsDevModelSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().optional(),
  family: z.string().optional(),
  attachment: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(RawReasoningOptionSchema).optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
  interleaved: z.unknown().optional(),
  knowledge: z.string().optional(),
  release_date: z.string().optional(),
  last_updated: z.string().optional(),
  modalities: RawModalitiesSchema.optional(),
  open_weights: z.boolean().optional(),
  status: z.enum(['alpha', 'beta', 'deprecated']).optional(),
  limit: z.object({
    context: z.number().int().nonnegative(),
    input: z.number().int().nonnegative().optional(),
    output: z.number().int().nonnegative(),
  }).passthrough(),
  cost: RawCostSchema.optional(),
  experimental: z.object({
    modes: z.record(RawExperimentalModeSchema).optional(),
  }).passthrough().optional(),
  provider: z.object({
    npm: z.string().optional(),
    api: z.string().optional(),
    shape: z.enum(['completions', 'responses']).optional(),
  }).passthrough().optional(),
}).passthrough()

export const ModelsDevProviderSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  doc: z.string().optional(),
  env: z.array(z.string()),
  npm: z.string().optional(),
  api: z.string().optional(),
  models: z.record(ModelsDevModelSchema),
}).passthrough()

export type ModelsDevModel = z.infer<typeof ModelsDevModelSchema>
export type ModelsDevProvider = z.infer<typeof ModelsDevProviderSchema>
export type ModelsDevCatalog = Record<string, ModelsDevProvider>

export interface ModelsDevArtifact {
  readonly schema_version: typeof PROVIDER_HUB_SCHEMA_VERSION
  readonly generated_at: string
  readonly source_url: string
  readonly license: {
    readonly spdx: 'MIT'
    readonly copyright: 'Copyright (c) 2025 models.dev'
    readonly notice_path: 'MODELS_DEV_LICENSE.txt'
  }
  readonly sha256: string
  readonly providers: ModelsDevCatalog
}

export const ModelsDevCatalogSchema: z.ZodType<ModelsDevCatalog> = z.record(ModelsDevProviderSchema).superRefine(
  (providers, ctx) => {
    for (const [providerKey, provider] of Object.entries(providers)) {
      if (provider.id !== providerKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [providerKey, 'id'],
          message: `Provider key "${providerKey}" does not match id "${provider.id}"`,
        })
      }
      for (const [modelKey, model] of Object.entries(provider.models)) {
        if (model.id !== modelKey) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [providerKey, 'models', modelKey, 'id'],
            message: `Model key "${modelKey}" does not match id "${model.id}"`,
          })
        }
      }
    }
  },
)

export const ModelsDevArtifactSchema: z.ZodType<ModelsDevArtifact> = z.object({
  schema_version: z.literal(PROVIDER_HUB_SCHEMA_VERSION),
  generated_at: IsoDateTimeSchema,
  source_url: HttpUrlSchema,
  license: z.object({
    spdx: z.literal('MIT'),
    copyright: z.literal('Copyright (c) 2025 models.dev'),
    notice_path: z.literal('MODELS_DEV_LICENSE.txt'),
  }).strict(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  providers: ModelsDevCatalogSchema,
}).strict().superRefine((artifact, ctx) => {
  const expected = modelsDevCatalogHash(artifact.providers)
  if (artifact.sha256 !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sha256'],
      message: `Catalog hash mismatch: expected ${expected}`,
    })
  }
})

export interface CreateModelsDevArtifactOptions {
  readonly generatedAt: string
  readonly sourceUrl: string
}

export function createModelsDevArtifact(
  input: unknown,
  options: CreateModelsDevArtifactOptions,
): ModelsDevArtifact {
  const providers = ModelsDevCatalogSchema.parse(input)
  return ModelsDevArtifactSchema.parse({
    schema_version: PROVIDER_HUB_SCHEMA_VERSION,
    generated_at: options.generatedAt,
    source_url: options.sourceUrl,
    license: {
      spdx: 'MIT',
      copyright: 'Copyright (c) 2025 models.dev',
      notice_path: 'MODELS_DEV_LICENSE.txt',
    },
    sha256: modelsDevCatalogHash(providers),
    providers,
  })
}

export function parseModelsDevArtifactText(text: string): ModelsDevArtifact {
  return ModelsDevArtifactSchema.parse(JSON.parse(text) as unknown)
}

export function modelsDevArtifactText(artifact: ModelsDevArtifact): string {
  return `${JSON.stringify(ModelsDevArtifactSchema.parse(artifact), null, 2)}\n`
}

export function modelsDevCatalogHash(providers: ModelsDevCatalog): string {
  return createHash('sha256').update(JSON.stringify(providers)).digest('hex')
}

export interface TransformModelsDevOptions {
  /** Routes that have an adapter/auth path in this Ownware build. */
  readonly connectableProviderIds?: ReadonlySet<string>
  /** Exact transport facts for built-in routes owned by this Ownware build. */
  readonly connectableProviderRoutes?: ReadonlyMap<string, ConnectableProviderRoute>
  /** `bundled` for the packaged artifact and `cache` after a safe refresh. */
  readonly source?: 'bundled' | 'cache' | 'network' | 'manual'
}

export interface ConnectableProviderRoute {
  readonly kind: ProviderRoute['kind']
  readonly billingKind?: ModelRoute['billingKind']
  readonly protocol: string
  readonly sdkPackage: string
  readonly apiBaseUrl?: string
  /** Exact model contract accepted by the owning runtime adapter. */
  readonly modelKind?: 'text-generation'
}

const ALL_CAPABILITIES: readonly ProviderCapability[] = [
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

export function transformModelsDevArtifact(
  artifactInput: ModelsDevArtifact,
  options: TransformModelsDevOptions = {},
): ProviderCatalogSnapshot {
  const artifact = ModelsDevArtifactSchema.parse(artifactInput)
  const connectable = options.connectableProviderIds ?? new Set<string>()
  const sourceRef = `models-dev:${artifact.sha256.slice(0, 16)}`
  const families: ProviderFamily[] = []
  const routes: ProviderRoute[] = []
  const models: ModelRoute[] = []
  const prices: PricebookEntry[] = []

  for (const [providerId, provider] of Object.entries(artifact.providers)) {
    const routeBinding = options.connectableProviderRoutes?.get(providerId)
    const family = ProviderFamilySchema.parse({
      id: providerId,
      name: provider.name,
      ...(asHttpUrl(provider.doc) == null ? {} : { websiteUrl: provider.doc }),
      lifecycle: 'active',
    })
    families.push(family)

    const routeId = `route:${providerId}`
    const routeConnectable = routeBinding != null || connectable.has(providerId)
    const providerPackage = provider.npm ?? '@ai-sdk/openai-compatible'
    routes.push(ProviderRouteSchema.parse({
      id: routeId,
      familyId: providerId,
      name: provider.name,
      kind: routeBinding?.kind ?? routeKind(providerId),
      transport: {
        runtimeId: routeConnectable ? 'loom' : 'unassigned',
        ...(routeConnectable ? { adapterId: providerId } : {}),
        protocol: routeBinding?.protocol ?? protocolForPackage(providerPackage),
        sdkPackage: routeBinding?.sdkPackage ?? providerPackage,
      },
      ...(routeBinding?.apiBaseUrl != null
        ? { apiBaseUrl: routeBinding.apiBaseUrl }
        : asHttpUrl(provider.api) == null ? {} : { apiBaseUrl: provider.api }),
      ...(asHttpUrl(provider.doc) == null ? {} : { docsUrl: provider.doc }),
      connectable: routeConnectable,
      ...(!routeConnectable
        ? { connectabilityReason: 'Catalog metadata only; no Ownware adapter/auth path is registered for this route.' }
        : {}),
      lifecycle: 'active',
      sourceRef,
    }))

    for (const [modelKey, rawModel] of Object.entries(provider.models)) {
      const modelRouteId = `${providerId}:${modelKey}`
      const modelPackage = rawModel.provider?.npm ?? providerPackage
      const modelApi = asHttpUrl(rawModel.provider?.api)
      const hasTransportOverride = modelPackage !== providerPackage
        || modelApi != null
        || rawModel.provider?.shape != null
      if (hasTransportOverride) {
        const overrideRouteId = `${routeId}:model:${modelKey}`
        routes.push(ProviderRouteSchema.parse({
          id: overrideRouteId,
          familyId: providerId,
          name: `${provider.name} — ${rawModel.name}`,
          kind: routeBinding?.kind ?? routeKind(providerId),
          transport: {
            runtimeId: 'unassigned',
            protocol: protocolForModel(modelPackage, rawModel.provider?.shape),
            sdkPackage: modelPackage,
          },
          ...(modelApi == null ? {} : { apiBaseUrl: modelApi }),
          connectable: false,
          connectabilityReason: 'Model-specific upstream transport override has not been verified by Ownware.',
          lifecycle: lifecycleForStatus(rawModel.status),
          sourceRef,
        }))
      }

      const providerRouteId = hasTransportOverride
        ? `${routeId}:model:${modelKey}`
        : routeId
      const modelTransportCompatible = modelMatchesRouteBinding(rawModel, routeBinding)
      const modelConnectable = routeConnectable
        && providerRouteId === routeId
        && modelTransportCompatible
      const model = ModelRouteSchema.parse({
        id: modelRouteId,
        providerRouteId,
        wireModelId: rawModel.id,
        name: rawModel.name,
        ...(rawModel.description == null ? {} : { description: rawModel.description }),
        ...(rawModel.family == null ? {} : { modelFamily: rawModel.family }),
        aliases: [],
        ...(validDate(rawModel.release_date) == null ? {} : { releaseDate: rawModel.release_date }),
        ...(rawModel.knowledge == null ? {} : { knowledgeCutoff: rawModel.knowledge }),
        contextWindow: positiveOrNull(rawModel.limit.context),
        maxInputTokens: positiveOrNull(rawModel.limit.input),
        maxOutputTokens: positiveOrNull(rawModel.limit.output),
        capabilities: capabilitiesFor(rawModel, sourceRef, artifact.generated_at),
        variants: variantsFor(rawModel),
        availability: {
          catalogued: true,
          connectable: modelConnectable,
          credentialed: false,
          verified: false,
          recommended: false,
          lifecycle: lifecycleForStatus(rawModel.status),
          connectionIds: [],
          ...(
            modelConnectable
              ? {}
              : {
                  reason: routeConnectable
                    && providerRouteId === routeId
                    && !modelTransportCompatible
                    ? 'Catalogued upstream; this is not a text-generation model accepted by the owning Loom adapter.'
                    : 'Catalogued upstream; this exact Ownware route is not yet connected and verified.',
                }
          ),
        },
        billingKind: billingKindFor(providerId, rawModel, routeBinding),
        catalogSourceRef: sourceRef,
      })
      models.push(model)
      prices.push(...pricesFor(artifact, providerRouteId, modelRouteId, rawModel))
    }
  }

  return ProviderCatalogSnapshotSchema.parse({
    schemaVersion: PROVIDER_HUB_SCHEMA_VERSION,
    generation: {
      id: sourceRef,
      schemaVersion: PROVIDER_HUB_SCHEMA_VERSION,
      source: options.source ?? 'bundled',
      sourceUrl: artifact.source_url,
      generatedAt: artifact.generated_at,
      fetchedAt: artifact.generated_at,
      sha256: artifact.sha256,
    },
    families,
    routes,
    models,
    prices,
  })
}

function asHttpUrl(value: string | undefined): string | null {
  if (value == null) return null
  return HttpUrlSchema.safeParse(value).success ? value : null
}

function validDate(value: string | undefined): string | null {
  if (value == null) return null
  return z.string().date().safeParse(value).success ? value : null
}

function routeKind(providerId: string): ProviderRoute['kind'] {
  if (providerId === 'anthropic' || providerId === 'openai' || providerId === 'google') {
    return 'direct'
  }
  if (providerId === 'openrouter') return 'router'
  return 'unknown'
}

function modelMatchesRouteBinding(
  model: ModelsDevModel,
  routeBinding: ConnectableProviderRoute | undefined,
): boolean {
  if (routeBinding?.modelKind !== 'text-generation') return true
  const modalities = model.modalities
  if (modalities == null) return false
  if (!modalities.input.includes('text') || !modalities.output.includes('text')) return false
  const kindHint = [model.id, model.family, model.name].filter(Boolean).join(' ').toLowerCase()
  return !/(^|[-_/\s])(embed(?:ding)?s?|whisper|voxtral|orpheus|tts|speech|transcription)([-_/\s]|$)/.test(kindHint)
}

function protocolForPackage(packageId: string): string {
  if (packageId === '@ai-sdk/anthropic') return 'anthropic-messages'
  if (packageId === '@ai-sdk/openai') return 'openai'
  if (packageId === '@ai-sdk/google') return 'google-generate-content'
  if (packageId === '@openrouter/ai-sdk-provider') return 'openrouter'
  if (packageId === '@ai-sdk/openai-compatible') return 'openai-compatible'
  return `sdk:${packageId}`
}

function protocolForModel(
  packageId: string,
  shape: 'completions' | 'responses' | undefined,
): string {
  if (shape === 'responses') return 'openai-responses'
  if (shape === 'completions') return 'openai-chat-completions'
  return protocolForPackage(packageId)
}

function lifecycleForStatus(status: ModelsDevModel['status']): ModelRoute['availability']['lifecycle'] {
  if (status === 'deprecated') return 'deprecated'
  if (status === 'alpha' || status === 'beta') return 'experimental'
  return 'active'
}

function capabilitiesFor(
  model: ModelsDevModel,
  sourceRef: string,
  observedAt: string,
): ModelCapabilityStatus[] {
  return ALL_CAPABILITIES.map((capability) => ({
    capability,
    upstream: {
      status: upstreamCapabilityStatus(model, capability),
      source: 'models_dev' as const,
      sourceRef,
      observedAt,
    },
    ownware: CapabilityVerificationSchema.parse({ status: 'untested' }),
  }))
}

function upstreamCapabilityStatus(
  model: ModelsDevModel,
  capability: ProviderCapability,
): 'supported' | 'unsupported' | 'unknown' {
  if (capability === 'tool_calls') return booleanStatus(model.tool_call)
  if (capability === 'reasoning') return booleanStatus(model.reasoning)
  if (capability === 'structured_output') return booleanStatus(model.structured_output)
  if (capability === 'image_input') return modalityStatus(model, 'image')
  if (capability === 'pdf_input') return modalityStatus(model, 'pdf')
  if (capability === 'audio_input') return modalityStatus(model, 'audio')
  if (capability === 'video_input') return modalityStatus(model, 'video')
  return 'unknown'
}

function booleanStatus(value: boolean | undefined): 'supported' | 'unsupported' | 'unknown' {
  if (value == null) return 'unknown'
  return value ? 'supported' : 'unsupported'
}

function modalityStatus(
  model: ModelsDevModel,
  modality: 'image' | 'pdf' | 'audio' | 'video',
): 'supported' | 'unsupported' | 'unknown' {
  if (model.modalities == null) return 'unknown'
  return model.modalities.input.includes(modality) ? 'supported' : 'unsupported'
}

function variantsFor(model: ModelsDevModel): ModelVariant[] {
  const variants = new Map<string, ModelVariant>()
  for (const option of model.reasoning_options ?? []) {
    if (option.type === 'toggle') {
      variants.set('reasoning:on', ModelRouteVariant({
        id: 'reasoning:on',
        kind: 'provider_option',
        label: 'Reasoning on',
        value: true,
      }))
    }
    if (option.type === 'effort') {
      for (const effort of option.values) {
        const id = effort == null ? 'reasoning:default' : `reasoning:${effort}`
        variants.set(id, ModelRouteVariant({
          id,
          kind: 'reasoning_effort',
          label: effort == null ? 'Default reasoning' : effort,
          value: effort,
        }))
      }
    }
    if (option.type === 'budget_tokens') {
      variants.set('reasoning:budget', ModelRouteVariant({
        id: 'reasoning:budget',
        kind: 'provider_option',
        label: 'Reasoning token budget',
        value: {
          ...(positiveOrNull(option.min) == null ? {} : { min: option.min }),
          ...(positiveOrNull(option.max) == null ? {} : { max: option.max }),
        },
      }))
    }
  }
  for (const mode of Object.keys(model.experimental?.modes ?? {})) {
    variants.set(`mode:${mode}`, ModelRouteVariant({
      id: `mode:${mode}`,
      kind: 'provider_option',
      label: mode,
      value: mode,
      priceKey: mode,
    }))
  }
  return [...variants.values()]
}

function ModelRouteVariant(input: {
  readonly id: string
  readonly kind: ModelVariant['kind']
  readonly label: string
  readonly value: ModelVariant['value']
  readonly priceKey?: string
}): ModelVariant {
  return {
    ...input,
    availability: 'unknown',
    verification: { status: 'untested' },
  }
}

function billingKindFor(
  providerId: string,
  _model: ModelsDevModel,
  routeBinding?: ConnectableProviderRoute,
): ModelRoute['billingKind'] {
  if (routeBinding?.billingKind != null) return routeBinding.billingKind
  if (providerId === 'openrouter') return 'provider_reported'
  if (routeBinding?.kind === 'direct') return 'metered'
  if (providerId === 'anthropic' || providerId === 'openai' || providerId === 'google') {
    return 'metered'
  }
  return 'unknown'
}

function positiveOrNull(value: number | undefined): number | null {
  return value != null && value > 0 ? value : null
}

function pricesFor(
  artifact: ModelsDevArtifact,
  providerRouteId: string,
  modelRouteId: string,
  model: ModelsDevModel,
): PricebookEntry[] {
  const priceVersion = artifact.sha256.slice(0, 16)
  const result: PricebookEntry[] = []
  if (model.cost != null) {
    const baseTiers = model.cost.tiers?.length
      ? [...model.cost.tiers].sort((a, b) => a.tier.size - b.tier.size)
      : model.cost.context_over_200k == null
        ? []
        : [{ ...model.cost.context_over_200k, tier: { type: 'context' as const, size: 200_000 } }]
    const baseMax = baseTiers[0]?.tier.size
    const baseRates = ratesFor(model.cost)
    if (baseRates.length > 0) {
      result.push(PricebookEntrySchema.parse({
        id: `price:${priceVersion}:${modelRouteId}:base`,
        version: priceVersion,
        currency: 'USD',
        scope: {
          providerRouteId,
          modelRouteId,
          ...(baseMax == null ? {} : { maximumInputTokens: baseMax + 1 }),
        },
        rates: baseRates,
        effectiveFrom: null,
        effectiveUntil: null,
        source: {
          kind: 'models_dev',
          sourceRef: artifact.source_url,
          retrievedAt: artifact.generated_at,
          upstreamVersion: artifact.sha256,
        },
      }))
    }
    baseTiers.forEach((tier, index) => {
      const rates = ratesFor(tier)
      if (rates.length === 0) return
      const next = baseTiers[index + 1]
      result.push(PricebookEntrySchema.parse({
        id: `price:${priceVersion}:${modelRouteId}:context-${tier.tier.size + 1}`,
        version: priceVersion,
        currency: 'USD',
        scope: {
          providerRouteId,
          modelRouteId,
          minimumInputTokens: tier.tier.size + 1,
          ...(next == null ? {} : { maximumInputTokens: next.tier.size + 1 }),
        },
        rates,
        effectiveFrom: null,
        effectiveUntil: null,
        source: {
          kind: 'models_dev',
          sourceRef: artifact.source_url,
          retrievedAt: artifact.generated_at,
          upstreamVersion: artifact.sha256,
        },
      }))
    })
  }
  for (const [mode, detail] of Object.entries(model.experimental?.modes ?? {})) {
    if (detail.cost == null) continue
    const rates = ratesFor(detail.cost)
    if (rates.length === 0) continue
    result.push(PricebookEntrySchema.parse({
      id: `price:${priceVersion}:${modelRouteId}:mode-${mode}`,
      version: priceVersion,
      currency: 'USD',
      scope: { providerRouteId, modelRouteId, variantId: `mode:${mode}` },
      rates,
      effectiveFrom: null,
      effectiveUntil: null,
      source: {
        kind: 'models_dev',
        sourceRef: artifact.source_url,
        retrievedAt: artifact.generated_at,
        upstreamVersion: artifact.sha256,
      },
    }))
  }
  return result
}

function ratesFor(cost: z.infer<typeof RawContextCostSchema>): PricebookEntry['rates'] {
  const candidates = [
    ['input_text_tokens', cost.input],
    ['output_text_tokens', cost.output],
    ['cache_read_tokens', cost.cache_read],
    ['cache_write_tokens', cost.cache_write],
    ['reasoning_tokens', cost.reasoning],
    ['input_audio_tokens', cost.input_audio],
    ['output_audio_tokens', cost.output_audio],
  ] as const
  return candidates.flatMap(([dimension, amountUsd]) => (
    amountUsd == null ? [] : [{ dimension, unitSize: 1_000_000, amountUsd }]
  ))
}
