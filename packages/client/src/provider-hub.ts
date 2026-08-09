/** Stable public wire types for Ownware's central provider control plane. */

export type ProviderHubLifecycle = 'active' | 'experimental' | 'deprecated' | 'hidden'
export type ProviderHubRouteKind =
  | 'direct'
  | 'router'
  | 'cloud'
  | 'subscription'
  | 'local'
  | 'custom'
  | 'unknown'
export type ProviderHubBillingKind =
  | 'metered'
  | 'provider_reported'
  | 'subscription'
  | 'local'
  | 'unknown'

export interface ProviderHubFamily {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly websiteUrl?: string
  readonly brandId?: string
  readonly lifecycle: ProviderHubLifecycle
}

export interface ProviderHubRoute {
  readonly id: string
  readonly familyId: string
  readonly name: string
  readonly kind: ProviderHubRouteKind
  readonly transport: {
    readonly runtimeId: string
    readonly adapterId?: string
    readonly protocol: string
    readonly sdkPackage?: string
  }
  readonly apiBaseUrl?: string
  readonly docsUrl?: string
  readonly region?: string
  readonly plan?: string
  readonly connectable: boolean
  readonly connectabilityReason?: string
  readonly lifecycle: ProviderHubLifecycle
  readonly sourceRef?: string
}

export type ProviderHubAuth =
  | {
      readonly kind: 'api_key' | 'router_key'
      readonly credentialId: string
      readonly placement: {
        readonly location: 'bearer' | 'header' | 'query' | 'sdk'
        readonly name?: string
      }
    }
  | {
      /** Process-owned API key; the value is never exposed by Provider Hub. */
      readonly kind: 'ambient_api_key'
      readonly variableName: string
    }
  | {
      readonly kind: 'oauth_subscription'
      readonly ownerRuntimeId: string
      readonly accountRef?: string
    }
  | {
      readonly kind: 'cloud_identity'
      readonly platform: 'aws' | 'gcp' | 'azure' | 'custom'
      readonly source: 'ambient' | 'profile' | 'workload_identity' | 'service_account'
      readonly profile?: string
      readonly credentialId?: string
    }
  | { readonly kind: 'local_endpoint' | 'none' }
  | {
      readonly kind: 'custom_headers'
      readonly headers: readonly {
        readonly name: string
        readonly prefix?: string
        readonly credentialId: string
      }[]
    }

export interface ProviderHubConnection {
  readonly id: string
  readonly providerRouteId: string
  readonly label: string
  readonly auth: ProviderHubAuth
  readonly settings: {
    readonly baseUrl?: string
    readonly region?: string
    readonly project?: string
    readonly account?: string
    readonly deployment?: string
    readonly profile?: string
    readonly discoveryPath?: string
    readonly manualModelIds?: readonly string[]
    readonly openaiCompatibility?: OpenAICompatibility
  }
  readonly status: 'configured' | 'disabled' | 'error'
  readonly createdAt: string
  readonly updatedAt: string
  readonly health?: ProviderHubConnectionHealth
}

export interface ProviderHubConnectionHealth {
  readonly status: 'unknown' | 'healthy' | 'degraded' | 'failed'
  readonly checkedAt?: string
  readonly latencyMs?: number
  readonly errorCode?: string
  readonly errorMessage?: string
}

export type ProviderHubCapability =
  | 'text_streaming'
  | 'terminal_events'
  | 'error_semantics'
  | 'tool_calls'
  | 'parallel_tool_calls'
  | 'cancellation'
  | 'reasoning'
  | 'image_input'
  | 'pdf_input'
  | 'audio_input'
  | 'video_input'
  | 'structured_output'
  | 'prompt_caching'
  | 'usage_reporting'
  | 'provider_reported_cost'

export interface ProviderHubModelRoute {
  readonly id: string
  readonly providerRouteId: string
  readonly wireModelId: string
  readonly name: string
  readonly description?: string
  readonly modelFamily?: string
  readonly modelAuthor?: string
  readonly aliases: readonly string[]
  readonly releaseDate?: string
  readonly knowledgeCutoff?: string
  readonly contextWindow: number | null
  readonly maxInputTokens: number | null
  readonly maxOutputTokens: number | null
  readonly capabilities: readonly {
    readonly capability: ProviderHubCapability
    readonly upstream: {
      readonly status: 'supported' | 'unsupported' | 'unknown'
      readonly source?: 'models_dev' | 'provider' | 'runtime' | 'manual'
      readonly sourceRef?: string
      readonly observedAt?: string
    }
    readonly ownware: ProviderHubVerification
  }[]
  readonly variants: readonly {
    readonly id: string
    readonly kind:
      | 'reasoning_effort'
      | 'service_tier'
      | 'personality'
      | 'context_tier'
      | 'provider_option'
    readonly label: string
    readonly value: unknown
    readonly availability: 'available' | 'unsupported' | 'unknown'
    readonly verification: ProviderHubVerification
    readonly priceKey?: string
  }[]
  readonly defaultVariantIds?: readonly string[]
  readonly availability: {
    readonly catalogued: boolean
    readonly connectable: boolean
    readonly credentialed: boolean
    readonly verified: boolean
    readonly recommended: boolean
    readonly lifecycle: ProviderHubLifecycle
    readonly connectionIds: readonly string[]
    readonly reason?: string
  }
  readonly billingKind: ProviderHubBillingKind
  readonly catalogSourceRef: string
}

export interface ProviderHubVerification {
  readonly status: 'verified' | 'failed' | 'untested' | 'not_applicable'
  readonly evidenceId?: string
  readonly harnessVersion?: string
  readonly observedAt?: string
  readonly mode?: 'fixture' | 'live'
  readonly note?: string
}

export interface ProviderHubPricebookEntry {
  readonly id: string
  readonly version: string
  readonly currency: 'USD'
  readonly scope: {
    readonly providerRouteId: string
    readonly modelRouteId: string
    readonly variantId?: string
    readonly serviceTier?: string
    readonly region?: string
    readonly plan?: string
    readonly modality?: 'text' | 'image' | 'audio' | 'video' | 'pdf'
    readonly minimumInputTokens?: number
    readonly maximumInputTokens?: number
  }
  readonly rates: readonly {
    readonly dimension: string
    readonly unitSize: number
    readonly amountUsd: number
  }[]
  readonly effectiveFrom: string | null
  readonly effectiveUntil: string | null
  readonly source: {
    readonly kind: 'official' | 'models_dev' | 'provider_reported' | 'manual'
    readonly sourceRef: string
    readonly retrievedAt: string
    readonly upstreamVersion?: string
  }
}

export type ProviderHubCostClassification =
  | 'estimated'
  | 'provider_reported'
  | 'reconciled'
  | 'subscription'
  | 'local'
  | 'unknown'

export interface ProviderHubUsageCost {
  readonly classification: ProviderHubCostClassification
  readonly amountUsd: number | null
  readonly currency: 'USD'
  readonly pricebookEntryId?: string
  readonly pricebookVersion?: string
  readonly observedAt: string
  readonly reconciledAt?: string
}

export interface ProviderHubUsageEntry {
  readonly id: string
  readonly occurredAt: string
  readonly threadId?: string
  readonly profileId?: string
  readonly providerFamilyId: string
  readonly providerRouteId: string
  readonly modelRouteId: string
  readonly connectionId?: string
  readonly wireModelId: string
  readonly serviceTier?: string
  readonly contextTier?: string
  readonly region?: string
  readonly billingKind: ProviderHubBillingKind
  readonly tokens: {
    readonly inputTextTokens?: number
    readonly outputTextTokens?: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
    readonly reasoningTokens?: number
    readonly inputAudioTokens?: number
    readonly outputAudioTokens?: number
  }
  readonly units: {
    readonly inputImages?: number
    readonly outputImages?: number
    readonly requests?: number
    readonly toolCalls?: number
  }
  readonly cost: ProviderHubUsageCost
  readonly providerFacts: {
    readonly requestId?: string
    readonly generationId?: string
    readonly servedModelId?: string
    readonly servedProvider?: string
    readonly servedTier?: string
    readonly finishReason?: string
    readonly usagePayloadHash?: string
  }
  readonly durationMs?: number
  readonly success: boolean
}

export interface ProviderHubUsageQuery {
  readonly from?: string
  readonly until?: string
  readonly profileId?: string
  readonly threadId?: string
  readonly classification?: ProviderHubCostClassification
  readonly limit?: number
}

export interface ProviderHubUsagePage {
  readonly items: readonly ProviderHubUsageEntry[]
}

export interface ProviderHubUsageSummary {
  readonly observations: Record<ProviderHubCostClassification, {
    readonly requestCount: number
    readonly amountUsd: number | null
  }>
  readonly tokens: {
    readonly inputTextTokens: number
    readonly outputTextTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
    readonly reasoningTokens: number
  }
}

export interface ProviderHubUsageEvidenceExport {
  readonly entries: readonly {
    readonly fact: Omit<ProviderHubUsageEntry, 'cost'>
    readonly recordedAt: string
    readonly costObservations: readonly {
      readonly id: string
      readonly sequence: number
      readonly cost: ProviderHubUsageCost
      readonly recordedAt: string
    }[]
  }[]
  readonly pricebookSnapshots: readonly {
    readonly entry: ProviderHubPricebookEntry
    readonly recordedAt: string
  }[]
}

export interface ProviderHubReconciledCostInput extends ProviderHubUsageCost {
  readonly classification: 'reconciled'
  readonly amountUsd: number
  readonly reconciledAt: string
}

export interface ProviderHubOverview {
  readonly generation: {
    readonly schemaVersion: number
    readonly id: string
    readonly source: 'bundled' | 'cache' | 'network' | 'manual'
    readonly generatedAt: string
    readonly sourceUrl?: string
    readonly fetchedAt?: string
    readonly upstreamVersion?: string
    readonly sha256: string
  }
  readonly generationId: string
  readonly catalogHealth: {
    readonly status: 'fresh' | 'stale' | 'offline' | 'error'
    readonly activeGenerationId: string
    readonly lastAttemptAt?: string
    readonly lastSuccessAt?: string
    readonly nextRefreshAt?: string
    readonly errorCode?: string
    readonly errorMessage?: string
  }
  readonly counts: {
    readonly providers: number
    readonly routes: number
    readonly models: number
    readonly pricebookEntries: number
    readonly connections: number
  }
  readonly warnings: readonly string[]
}

export interface ProviderHubProviderPage {
  readonly generationId: string
  readonly items: readonly {
    readonly family: ProviderHubFamily
    readonly routes: readonly ProviderHubRoute[]
    readonly modelCount: number
    readonly connectableModelCount: number
    readonly connectedModelCount: number
    readonly verifiedModelCount: number
    readonly recommendedModelCount: number
  }[]
  readonly warnings: readonly string[]
}

export interface ProviderHubConnectionPage {
  readonly generationId: string
  readonly items: readonly ProviderHubConnection[]
  readonly warnings: readonly string[]
}

export interface ProviderHubVerificationOverview {
  readonly generationId: string
  /** Independently versioned secret-free evidence, or null before a harness run. */
  readonly bundle: unknown | null
  readonly warnings: readonly string[]
}

export type ProviderHubModelScope =
  | 'all'
  | 'connectable'
  | 'connected'
  | 'verified'
  | 'recommended'

export interface ProviderHubModelQuery {
  readonly q?: string
  readonly providerFamilyId?: string
  readonly providerRouteId?: string
  readonly connectionId?: string
  readonly lifecycle?: ProviderHubLifecycle
  readonly scope?: ProviderHubModelScope
  readonly limit?: number
  readonly cursor?: string
}

export interface ProviderHubModelPage {
  readonly generationId: string
  readonly items: readonly {
    readonly model: ProviderHubModelRoute
    readonly prices: readonly ProviderHubPricebookEntry[]
  }[]
  readonly page: {
    readonly limit: number
    readonly total: number
    readonly nextCursor: string | null
  }
  readonly warnings: readonly string[]
}

export interface OpenAICompatibility {
  readonly maxTokensField: 'max_tokens' | 'max_completion_tokens'
  readonly streamUsage: 'include' | 'omit'
}

export type OpenAICompatibleAuthInput =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'bearer'
      readonly credentialId?: string
      /** Write-only. Never returned or persisted in provider configuration. */
      readonly key?: string
    }
  | {
      readonly kind: 'header'
      readonly credentialId?: string
      /** Write-only. Never returned or persisted in provider configuration. */
      readonly key?: string
      readonly name: string
      readonly prefix?: string
    }

export interface OpenAICompatibleConnectionInput {
  readonly id?: string
  readonly templateId?: 'lmstudio' | 'ollama' | 'azure-openai' | 'amazon-bedrock-mantle'
  readonly label: string
  readonly baseUrl: string
  readonly auth: OpenAICompatibleAuthInput
  readonly manualModelIds?: readonly string[]
  readonly discoveryEnabled?: boolean
  readonly compatibility?: OpenAICompatibility
}

export interface OpenAICompatibleConnectionConfig {
  readonly schemaVersion: 1
  readonly id: string
  readonly templateId?: 'lmstudio' | 'ollama' | 'azure-openai' | 'amazon-bedrock-mantle'
  readonly label: string
  readonly baseUrl: string
  readonly auth:
    | { readonly kind: 'none' }
    | { readonly kind: 'bearer'; readonly credentialId: string }
    | {
        readonly kind: 'header'
        readonly credentialId: string
        readonly name: string
        readonly prefix?: string
      }
  readonly manualModelIds: readonly string[]
  readonly discoveredModelIds: readonly string[]
  readonly discoveredAt?: string
  readonly discoveryEnabled: boolean
  readonly compatibility: OpenAICompatibility
  readonly health: ProviderHubConnectionHealth
  readonly createdAt: string
  readonly updatedAt: string
}

export interface OpenAICompatibleConnectionList {
  readonly items: readonly OpenAICompatibleConnectionConfig[]
}

export function providerHubModelQueryString(query: ProviderHubModelQuery): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  return params.size === 0 ? '' : `?${params.toString()}`
}

export function providerHubUsageQueryString(query: ProviderHubUsageQuery): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  return params.size === 0 ? '' : `?${params.toString()}`
}
