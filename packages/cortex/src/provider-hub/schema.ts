import { z } from 'zod'

/**
 * Provider Hub v1 domain contract.
 *
 * These schemas are the control-plane boundary shared by catalog ingestion,
 * gateway DTOs, connections, verification, and usage persistence. Provider
 * SDK request/response objects deliberately do not cross this boundary.
 */

export const PROVIDER_HUB_SCHEMA_VERSION = 1 as const

export const StableIdSchema = z.string().trim().min(1).max(512)
export const IsoDateTimeSchema = z.string().datetime({ offset: true })
export const HttpUrlSchema = z.string().url().refine(
  (value) => value.startsWith('https://') || value.startsWith('http://'),
  'Expected an HTTP(S) URL',
)

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
)

export const ProviderFamilySchema = z.object({
  id: StableIdSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2_000).optional(),
  websiteUrl: HttpUrlSchema.optional(),
  brandId: StableIdSchema.optional(),
  lifecycle: z.enum(['active', 'experimental', 'deprecated', 'hidden']),
}).strict()

export const ProviderRouteKindSchema = z.enum([
  'direct',
  'router',
  'cloud',
  'subscription',
  'local',
  'custom',
  'unknown',
])

export const ProviderTransportSchema = z.object({
  /** Complete runtime that owns the execution loop. */
  runtimeId: StableIdSchema,
  /** Adapter registered inside that runtime, when the runtime uses adapters. */
  adapterId: StableIdSchema.optional(),
  /** Wire protocol, for example `anthropic-messages` or `openai-compatible`. */
  protocol: StableIdSchema,
  /** Informational package identity from an upstream catalog. Never executed directly. */
  sdkPackage: z.string().trim().min(1).max(300).optional(),
}).strict()

export const ProviderRouteSchema = z.object({
  id: StableIdSchema,
  familyId: StableIdSchema,
  name: z.string().trim().min(1).max(200),
  kind: ProviderRouteKindSchema,
  transport: ProviderTransportSchema,
  apiBaseUrl: HttpUrlSchema.optional(),
  docsUrl: HttpUrlSchema.optional(),
  region: z.string().trim().min(1).max(100).optional(),
  plan: z.string().trim().min(1).max(100).optional(),
  connectable: z.boolean(),
  connectabilityReason: z.string().trim().min(1).max(1_000).optional(),
  lifecycle: z.enum(['active', 'experimental', 'deprecated', 'hidden']),
  sourceRef: StableIdSchema.optional(),
}).strict().superRefine((route, ctx) => {
  if (!route.connectable && route.connectabilityReason == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['connectabilityReason'],
      message: 'A non-connectable route must explain why it cannot be connected',
    })
  }
})

const CredentialPlacementSchema = z.object({
  location: z.enum(['bearer', 'header', 'query', 'sdk']),
  name: z.string().trim().min(1).max(200).optional(),
}).strict().superRefine((placement, ctx) => {
  if ((placement.location === 'header' || placement.location === 'query') && placement.name == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['name'],
      message: `${placement.location} credentials require a parameter name`,
    })
  }
})

export const ApiKeyAuthSchema = z.object({
  kind: z.literal('api_key'),
  credentialId: StableIdSchema,
  placement: CredentialPlacementSchema,
}).strict()

export const RouterKeyAuthSchema = z.object({
  kind: z.literal('router_key'),
  credentialId: StableIdSchema,
  placement: CredentialPlacementSchema,
}).strict()

/**
 * Process-owned API key observed through a conventional environment variable.
 * The variable name is configuration metadata; its value never enters the Hub.
 */
export const AmbientApiKeyAuthSchema = z.object({
  kind: z.literal('ambient_api_key'),
  variableName: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,199}$/),
}).strict()

export const OAuthSubscriptionAuthSchema = z.object({
  kind: z.literal('oauth_subscription'),
  ownerRuntimeId: StableIdSchema,
  /** Token-blind account handle supplied by the owning runtime. */
  accountRef: StableIdSchema.optional(),
}).strict()

export const CloudIdentityAuthSchema = z.object({
  kind: z.literal('cloud_identity'),
  platform: z.enum(['aws', 'gcp', 'azure', 'custom']),
  source: z.enum(['ambient', 'profile', 'workload_identity', 'service_account']),
  /** Non-secret profile/config name, not an access token. */
  profile: z.string().trim().min(1).max(200).optional(),
  /** Credential-store reference when a service-account document is required. */
  credentialId: StableIdSchema.optional(),
}).strict().superRefine((auth, ctx) => {
  if (auth.source === 'profile' && auth.profile == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['profile'],
      message: 'Profile cloud identity requires a profile name',
    })
  }
  if (auth.source === 'service_account' && auth.credentialId == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['credentialId'],
      message: 'Service-account cloud identity requires a credential reference',
    })
  }
})

export const LocalEndpointAuthSchema = z.object({
  kind: z.literal('local_endpoint'),
}).strict()

/** Explicitly unauthenticated remote/loopback connection. */
export const NoAuthSchema = z.object({
  kind: z.literal('none'),
}).strict()

export const CustomHeaderAuthSchema = z.object({
  kind: z.literal('custom_headers'),
  headers: z.array(z.object({
    name: z.string().trim().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
    /** Non-secret literal prepended to the resolved value, such as `Key `. */
    prefix: z.string().max(100).regex(/^[\x20-\x7E]*$/).optional(),
    /** Secret value is resolved from the credential store only at execution. */
    credentialId: StableIdSchema,
  }).strict()).min(1).max(32),
}).strict()

export const AuthStrategySchema = z.union([
  ApiKeyAuthSchema,
  RouterKeyAuthSchema,
  AmbientApiKeyAuthSchema,
  OAuthSubscriptionAuthSchema,
  CloudIdentityAuthSchema,
  LocalEndpointAuthSchema,
  NoAuthSchema,
  CustomHeaderAuthSchema,
])

export const ConnectionSettingsSchema = z.object({
  baseUrl: HttpUrlSchema.optional(),
  region: z.string().trim().min(1).max(100).optional(),
  project: z.string().trim().min(1).max(300).optional(),
  account: z.string().trim().min(1).max(300).optional(),
  deployment: z.string().trim().min(1).max(300).optional(),
  profile: z.string().trim().min(1).max(200).optional(),
  discoveryPath: z.string().trim().min(1).max(500).optional(),
  manualModelIds: z.array(z.string().trim().min(1).max(500)).max(1_000).optional(),
  openaiCompatibility: z.object({
    maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']),
    streamUsage: z.enum(['include', 'omit']),
  }).strict().optional(),
}).strict()

export const ConnectionHealthSchema = z.object({
  status: z.enum(['unknown', 'healthy', 'degraded', 'failed']),
  checkedAt: IsoDateTimeSchema.optional(),
  latencyMs: z.number().finite().nonnegative().optional(),
  errorCode: z.string().trim().min(1).max(200).optional(),
  errorMessage: z.string().trim().min(1).max(2_000).optional(),
}).strict()

export const ProviderConnectionSchema = z.object({
  id: StableIdSchema,
  providerRouteId: StableIdSchema,
  label: z.string().trim().min(1).max(200),
  auth: AuthStrategySchema,
  settings: ConnectionSettingsSchema,
  status: z.enum(['configured', 'disabled', 'error']),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  health: ConnectionHealthSchema.optional(),
}).strict().superRefine((connection, ctx) => {
  if (connection.auth.kind === 'custom_headers') {
    const names = connection.auth.headers.map((header) => header.name.toLowerCase())
    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['auth', 'headers'],
        message: 'Custom credential header names must be unique (case-insensitive)',
      })
    }
  }
})

export const ProviderCapabilitySchema = z.enum([
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
])

export const UpstreamCapabilityClaimSchema = z.object({
  status: z.enum(['supported', 'unsupported', 'unknown']),
  source: z.enum(['models_dev', 'provider', 'runtime', 'manual']).optional(),
  sourceRef: z.string().trim().min(1).max(1_000).optional(),
  observedAt: IsoDateTimeSchema.optional(),
}).strict()

export const CapabilityVerificationSchema = z.object({
  status: z.enum(['verified', 'failed', 'untested', 'not_applicable']),
  evidenceId: StableIdSchema.optional(),
  harnessVersion: z.string().trim().min(1).max(200).optional(),
  observedAt: IsoDateTimeSchema.optional(),
  mode: z.enum(['fixture', 'live']).optional(),
  note: z.string().trim().min(1).max(2_000).optional(),
}).strict().superRefine((verification, ctx) => {
  if (verification.status !== 'verified' && verification.status !== 'failed') return
  for (const field of ['evidenceId', 'harnessVersion', 'observedAt', 'mode'] as const) {
    if (verification[field] == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${verification.status} capability status requires ${field}`,
      })
    }
  }
})

export const ModelCapabilityStatusSchema = z.object({
  capability: ProviderCapabilitySchema,
  upstream: UpstreamCapabilityClaimSchema,
  ownware: CapabilityVerificationSchema,
}).strict()

export const ModelVariantSchema = z.object({
  id: StableIdSchema,
  kind: z.enum([
    'reasoning_effort',
    'service_tier',
    'personality',
    'context_tier',
    'provider_option',
  ]),
  label: z.string().trim().min(1).max(200),
  value: JsonValueSchema,
  availability: z.enum(['available', 'unsupported', 'unknown']),
  verification: CapabilityVerificationSchema,
  priceKey: StableIdSchema.optional(),
}).strict()

export const ModelAvailabilitySchema = z.object({
  catalogued: z.boolean(),
  connectable: z.boolean(),
  credentialed: z.boolean(),
  verified: z.boolean(),
  recommended: z.boolean(),
  lifecycle: z.enum(['active', 'experimental', 'deprecated', 'hidden']),
  connectionIds: z.array(StableIdSchema),
  reason: z.string().trim().min(1).max(2_000).optional(),
}).strict()

export const BillingKindSchema = z.enum([
  'metered',
  'provider_reported',
  'subscription',
  'local',
  'unknown',
])

export const ModelRouteSchema = z.object({
  /** Stable Ownware selection id; legacy ids remain valid here. */
  id: StableIdSchema,
  providerRouteId: StableIdSchema,
  wireModelId: z.string().trim().min(1).max(1_000),
  name: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(2_000).optional(),
  modelFamily: z.string().trim().min(1).max(300).optional(),
  modelAuthor: z.string().trim().min(1).max(300).optional(),
  aliases: z.array(z.string().trim().min(1).max(500)).max(100),
  releaseDate: z.string().date().optional(),
  knowledgeCutoff: z.string().trim().min(1).max(100).optional(),
  contextWindow: z.number().int().positive().nullable(),
  maxInputTokens: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  capabilities: z.array(ModelCapabilityStatusSchema),
  variants: z.array(ModelVariantSchema),
  /** Variant ids the owning runtime/catalog recommends for a new selection. */
  defaultVariantIds: z.array(StableIdSchema).max(20).optional(),
  availability: ModelAvailabilitySchema,
  billingKind: BillingKindSchema,
  catalogSourceRef: StableIdSchema,
}).strict().superRefine((model, ctx) => {
  const capabilityNames = model.capabilities.map((capability) => capability.capability)
  if (new Set(capabilityNames).size !== capabilityNames.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capabilities'],
      message: 'Each capability may appear only once per model route',
    })
  }
  const variantIds = model.variants.map((variant) => variant.id)
  if (new Set(variantIds).size !== variantIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['variants'],
      message: 'Variant ids must be unique per model route',
    })
  }
  for (const [index, defaultId] of (model.defaultVariantIds ?? []).entries()) {
    if (!variantIds.includes(defaultId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultVariantIds', index],
        message: `Unknown default model variant "${defaultId}"`,
      })
    }
  }
  if (model.availability.verified) {
    const streaming = model.capabilities.find(
      (capability) => capability.capability === 'text_streaming',
    )
    if (streaming?.ownware.status !== 'verified') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['availability', 'verified'],
        message: 'A verified model route requires verified text-streaming evidence',
      })
    }
  }
})

export const PriceDimensionSchema = z.enum([
  'input_text_tokens',
  'output_text_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'input_audio_tokens',
  'output_audio_tokens',
  'input_images',
  'output_images',
  'requests',
  'tool_calls',
])

export const PriceRateSchema = z.object({
  dimension: PriceDimensionSchema,
  unitSize: z.number().int().positive(),
  amountUsd: z.number().finite().nonnegative(),
}).strict()

export const PriceScopeSchema = z.object({
  providerRouteId: StableIdSchema,
  modelRouteId: StableIdSchema,
  variantId: StableIdSchema.optional(),
  serviceTier: z.string().trim().min(1).max(200).optional(),
  region: z.string().trim().min(1).max(100).optional(),
  plan: z.string().trim().min(1).max(100).optional(),
  modality: z.enum(['text', 'image', 'audio', 'video', 'pdf']).optional(),
  minimumInputTokens: z.number().int().nonnegative().optional(),
  maximumInputTokens: z.number().int().positive().optional(),
}).strict().superRefine((scope, ctx) => {
  if (
    scope.minimumInputTokens != null &&
    scope.maximumInputTokens != null &&
    scope.minimumInputTokens >= scope.maximumInputTokens
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maximumInputTokens'],
      message: 'maximumInputTokens must be greater than minimumInputTokens',
    })
  }
})

export const PriceSourceSchema = z.object({
  kind: z.enum(['official', 'models_dev', 'provider_reported', 'manual']),
  sourceRef: z.string().trim().min(1).max(1_000),
  retrievedAt: IsoDateTimeSchema,
  upstreamVersion: z.string().trim().min(1).max(300).optional(),
}).strict()

export const PricebookEntrySchema = z.object({
  id: StableIdSchema,
  version: StableIdSchema,
  currency: z.literal('USD'),
  scope: PriceScopeSchema,
  rates: z.array(PriceRateSchema).min(1),
  /** Null when a catalog reports a rate without its historical effective date. */
  effectiveFrom: IsoDateTimeSchema.nullable(),
  effectiveUntil: IsoDateTimeSchema.nullable(),
  source: PriceSourceSchema,
}).strict().superRefine((entry, ctx) => {
  const dimensions = entry.rates.map((rate) => rate.dimension)
  if (new Set(dimensions).size !== dimensions.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rates'],
      message: 'A pricebook scope may define each rate dimension only once',
    })
  }
  if (
    entry.effectiveFrom != null &&
    entry.effectiveUntil != null &&
    Date.parse(entry.effectiveUntil) <= Date.parse(entry.effectiveFrom)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['effectiveUntil'],
      message: 'effectiveUntil must be later than effectiveFrom',
    })
  }
})

export const CostClassificationSchema = z.enum([
  'estimated',
  'provider_reported',
  'reconciled',
  'subscription',
  'local',
  'unknown',
])

export const TokenUsageSchema = z.object({
  inputTextTokens: z.number().int().safe().nonnegative().optional(),
  outputTextTokens: z.number().int().safe().nonnegative().optional(),
  cacheReadTokens: z.number().int().safe().nonnegative().optional(),
  cacheWriteTokens: z.number().int().safe().nonnegative().optional(),
  reasoningTokens: z.number().int().safe().nonnegative().optional(),
  inputAudioTokens: z.number().int().safe().nonnegative().optional(),
  outputAudioTokens: z.number().int().safe().nonnegative().optional(),
}).strict()

export const UnitUsageSchema = z.object({
  inputImages: z.number().int().safe().nonnegative().optional(),
  outputImages: z.number().int().safe().nonnegative().optional(),
  requests: z.number().int().safe().nonnegative().optional(),
  toolCalls: z.number().int().safe().nonnegative().optional(),
}).strict()

export const UsageCostSchema = z.object({
  classification: CostClassificationSchema,
  amountUsd: z.number().finite().nonnegative().nullable(),
  currency: z.literal('USD'),
  pricebookEntryId: StableIdSchema.optional(),
  pricebookVersion: StableIdSchema.optional(),
  observedAt: IsoDateTimeSchema,
  reconciledAt: IsoDateTimeSchema.optional(),
}).strict().superRefine((cost, ctx) => {
  if (
    cost.classification === 'unknown' ||
    cost.classification === 'subscription' ||
    cost.classification === 'local'
  ) {
    if (cost.amountUsd !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amountUsd'],
        message: `${cost.classification} usage must not fabricate a USD amount`,
      })
    }
  } else if (cost.amountUsd == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['amountUsd'],
      message: `${cost.classification} usage requires a USD amount`,
    })
  }
  if (cost.classification === 'estimated') {
    if (cost.pricebookEntryId == null || cost.pricebookVersion == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pricebookEntryId'],
        message: 'Estimated cost requires the exact pricebook entry and version',
      })
    }
  }
  if (cost.classification === 'reconciled' && cost.reconciledAt == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reconciledAt'],
      message: 'Reconciled cost requires a reconciliation timestamp',
    })
  }
})

export const ProviderUsageFactsSchema = z.object({
  requestId: z.string().trim().min(1).max(500).optional(),
  generationId: z.string().trim().min(1).max(500).optional(),
  servedModelId: z.string().trim().min(1).max(1_000).optional(),
  servedProvider: z.string().trim().min(1).max(300).optional(),
  servedTier: z.string().trim().min(1).max(200).optional(),
  finishReason: z.string().trim().min(1).max(200).optional(),
  usagePayloadHash: z.string().trim().min(1).max(300).optional(),
}).strict()

export const UsageLedgerEntrySchema = z.object({
  id: StableIdSchema,
  occurredAt: IsoDateTimeSchema,
  threadId: StableIdSchema.optional(),
  profileId: StableIdSchema.optional(),
  providerFamilyId: StableIdSchema,
  providerRouteId: StableIdSchema,
  modelRouteId: StableIdSchema,
  connectionId: StableIdSchema.optional(),
  wireModelId: z.string().trim().min(1).max(1_000),
  serviceTier: z.string().trim().min(1).max(200).optional(),
  contextTier: z.string().trim().min(1).max(200).optional(),
  region: z.string().trim().min(1).max(100).optional(),
  billingKind: BillingKindSchema,
  tokens: TokenUsageSchema,
  units: UnitUsageSchema,
  cost: UsageCostSchema,
  providerFacts: ProviderUsageFactsSchema,
  durationMs: z.number().finite().nonnegative().optional(),
  success: z.boolean(),
}).strict()

export const CatalogGenerationSchema = z.object({
  id: StableIdSchema,
  schemaVersion: z.literal(PROVIDER_HUB_SCHEMA_VERSION),
  source: z.enum(['bundled', 'cache', 'network', 'manual']),
  sourceUrl: HttpUrlSchema.optional(),
  generatedAt: IsoDateTimeSchema,
  fetchedAt: IsoDateTimeSchema.optional(),
  upstreamVersion: z.string().trim().min(1).max(500).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const ProviderCatalogSnapshotSchema = z.object({
  schemaVersion: z.literal(PROVIDER_HUB_SCHEMA_VERSION),
  generation: CatalogGenerationSchema,
  families: z.array(ProviderFamilySchema),
  routes: z.array(ProviderRouteSchema),
  models: z.array(ModelRouteSchema),
  prices: z.array(PricebookEntrySchema),
}).strict().superRefine((snapshot, ctx) => {
  validateUnique(snapshot.families.map((family) => family.id), ['families'], 'provider family', ctx)
  validateUnique(snapshot.routes.map((route) => route.id), ['routes'], 'provider route', ctx)
  validateUnique(snapshot.models.map((model) => model.id), ['models'], 'model route', ctx)
  validateUnique(snapshot.prices.map((price) => price.id), ['prices'], 'price entry', ctx)

  const familyIds = new Set(snapshot.families.map((family) => family.id))
  const routeIds = new Set(snapshot.routes.map((route) => route.id))
  const modelIds = new Set(snapshot.models.map((model) => model.id))
  const variantIdsByModel = new Map(
    snapshot.models.map((model) => [
      model.id,
      new Set(model.variants.map((variant) => variant.id)),
    ]),
  )
  snapshot.routes.forEach((route, index) => {
    if (!familyIds.has(route.familyId)) {
      addMissingReference(ctx, ['routes', index, 'familyId'], 'provider family', route.familyId)
    }
  })
  snapshot.models.forEach((model, index) => {
    if (!routeIds.has(model.providerRouteId)) {
      addMissingReference(ctx, ['models', index, 'providerRouteId'], 'provider route', model.providerRouteId)
    }
  })
  snapshot.prices.forEach((price, index) => {
    if (!routeIds.has(price.scope.providerRouteId)) {
      addMissingReference(
        ctx,
        ['prices', index, 'scope', 'providerRouteId'],
        'provider route',
        price.scope.providerRouteId,
      )
    }
    if (!modelIds.has(price.scope.modelRouteId)) {
      addMissingReference(
        ctx,
        ['prices', index, 'scope', 'modelRouteId'],
        'model route',
        price.scope.modelRouteId,
      )
    }
    if (price.scope.variantId != null) {
      if (!variantIdsByModel.get(price.scope.modelRouteId)?.has(price.scope.variantId)) {
        addMissingReference(
          ctx,
          ['prices', index, 'scope', 'variantId'],
          'model variant',
          price.scope.variantId,
        )
      }
    }
  })
})

export const CatalogRefreshHealthSchema = z.object({
  status: z.enum(['fresh', 'stale', 'offline', 'error']),
  activeGenerationId: StableIdSchema,
  lastAttemptAt: IsoDateTimeSchema.optional(),
  lastSuccessAt: IsoDateTimeSchema.optional(),
  nextRefreshAt: IsoDateTimeSchema.optional(),
  errorCode: z.string().trim().min(1).max(200).optional(),
  errorMessage: z.string().trim().min(1).max(2_000).optional(),
}).strict()

export const ProviderHubStateSchema = z.object({
  schemaVersion: z.literal(PROVIDER_HUB_SCHEMA_VERSION),
  catalog: ProviderCatalogSnapshotSchema,
  connections: z.array(ProviderConnectionSchema),
  catalogHealth: CatalogRefreshHealthSchema,
}).strict().superRefine((state, ctx) => {
  validateUnique(state.connections.map((connection) => connection.id), ['connections'], 'connection', ctx)
  const routeIds = new Set(state.catalog.routes.map((route) => route.id))
  state.connections.forEach((connection, index) => {
    if (!routeIds.has(connection.providerRouteId)) {
      addMissingReference(
        ctx,
        ['connections', index, 'providerRouteId'],
        'provider route',
        connection.providerRouteId,
      )
    }
  })
})

function validateUnique(
  ids: readonly string[],
  path: Array<string | number>,
  label: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>()
  const duplicate = ids.find((id) => {
    if (seen.has(id)) return true
    seen.add(id)
    return false
  })
  if (duplicate == null) return
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: `Duplicate ${label} id "${duplicate}"`,
  })
}

function addMissingReference(
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  label: string,
  id: string,
): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: `Unknown ${label} reference "${id}"`,
  })
}

export type ProviderFamily = z.infer<typeof ProviderFamilySchema>
export type ProviderRoute = z.infer<typeof ProviderRouteSchema>
export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>
export type AuthStrategy = z.infer<typeof AuthStrategySchema>
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>
export type ModelCapabilityStatus = z.infer<typeof ModelCapabilityStatusSchema>
export type ModelVariant = z.infer<typeof ModelVariantSchema>
export type ModelAvailability = z.infer<typeof ModelAvailabilitySchema>
export type BillingKind = z.infer<typeof BillingKindSchema>
export type ModelRoute = z.infer<typeof ModelRouteSchema>
export type PriceDimension = z.infer<typeof PriceDimensionSchema>
export type PricebookEntry = z.infer<typeof PricebookEntrySchema>
export type CostClassification = z.infer<typeof CostClassificationSchema>
export type UsageLedgerEntry = z.infer<typeof UsageLedgerEntrySchema>
export type CatalogGeneration = z.infer<typeof CatalogGenerationSchema>
export type ProviderCatalogSnapshot = z.infer<typeof ProviderCatalogSnapshotSchema>
export type CatalogRefreshHealth = z.infer<typeof CatalogRefreshHealthSchema>
export type ProviderHubState = z.infer<typeof ProviderHubStateSchema>
