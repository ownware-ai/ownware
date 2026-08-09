import { createHash } from 'node:crypto'
import { transformModelsDevArtifact } from './models-dev.js'
import type { ConnectableProviderRoute } from './models-dev.js'
import type {
  CatalogRefreshHealth,
  ModelRoute,
  PricebookEntry,
  ProviderCatalogSnapshot,
  ProviderConnection,
  ProviderFamily,
  ProviderRoute,
} from './schema.js'
import type {
  ProviderCatalogStore,
  ProviderCatalogStoreState,
} from './catalog-store.js'
import {
  applyVerificationEvidenceBundle,
  type VerificationEvidenceBundle,
} from './verification.js'
import type { VerificationEvidenceStoreState } from './verification-store.js'

export const PROVIDER_HUB_DEFAULT_PAGE_SIZE = 50
export const PROVIDER_HUB_MAX_PAGE_SIZE = 200

export interface ProviderHubDynamicProjection {
  readonly families?: readonly ProviderFamily[]
  readonly routes?: readonly ProviderRoute[]
  readonly models?: readonly ModelRoute[]
  readonly prices?: readonly PricebookEntry[]
  readonly connections?: readonly ProviderConnection[]
}

export interface ProviderHubServiceOptions {
  readonly store: Pick<ProviderCatalogStore, 'load' | 'refresh'>
  readonly connectableProviderIds?: ReadonlySet<string>
  readonly connectableProviderRoutes?: ReadonlyMap<string, ConnectableProviderRoute>
  readonly listConnections?: () => Promise<readonly ProviderConnection[]>
  /** Token-blind runtime-owned additions, such as the connected Codex catalog. */
  readonly loadDynamicProjection?: () => Promise<ProviderHubDynamicProjection>
  /** Independently versioned, secret-free provider/model route evidence. */
  readonly loadVerificationEvidence?: () => Promise<VerificationEvidenceStoreState>
  /** Temporary compatibility policy for stable pre-Hub model ids/defaults. */
  readonly legacyModelPolicies?: readonly ProviderHubLegacyModelPolicy[]
  /** Exact installed local-model resolver used only after connected cloud defaults. */
  readonly pickLocalModel?: () => Promise<string | null>
  /** Runtime effect-boundary check: a configured route is not runnable until its adapter exists. */
  readonly isRuntimeProviderAvailable?: (providerId: string) => boolean
}

export interface ProviderHubLegacyModelPolicy {
  /** Existing canonical Ownware id retained in profiles and API responses. */
  readonly id: string
  readonly providerId: string
  readonly tier: 'flagship' | 'balanced' | 'fast' | 'legacy' | 'preview'
  /** Models.dev-derived id whose objective facts should back this row when present. */
  readonly sourceModelRouteId: string
  readonly providerRouteId: string
  readonly wireModelId: string
  readonly name: string
  readonly description?: string
  readonly aliases: readonly string[]
  readonly releaseDate?: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly capabilities: readonly string[]
  readonly recommended: boolean
  readonly deprecated: boolean
  readonly openRouterSlug?: string
  readonly billingKind: ModelRoute['billingKind']
}

export type ProviderHubCompatibilityCapability =
  | 'vision'
  | 'pdf'
  | 'tools'
  | 'thinking'
  | 'streaming'
  | 'cache'
  | 'structured'
  | 'code_exec'
  | 'citations'

/**
 * Deprecated `/api/v1/models` shape projected from the canonical Hub view.
 * It is deliberately owned here so the compatibility route cannot reintroduce
 * a second model/pricing/availability authority.
 */
export interface ProviderHubCompatibilityModel {
  readonly id: string
  readonly name: string
  readonly provider: string
  readonly tier: ProviderHubLegacyModelPolicy['tier']
  readonly description: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly costPer1kInput: number | null
  readonly costPer1kOutput: number | null
  readonly capabilities: readonly ProviderHubCompatibilityCapability[]
  readonly aliases: readonly string[]
  readonly releaseDate: string
  readonly default?: boolean
  readonly deprecated?: boolean
  readonly hasCredentials: boolean
  readonly orSlug?: string
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
  readonly lifecycle?: ModelRoute['availability']['lifecycle']
  readonly scope?: ProviderHubModelScope
  readonly limit?: number
  readonly cursor?: string
}

export interface ProviderHubModelItem {
  readonly model: ModelRoute
  readonly prices: readonly PricebookEntry[]
}

export interface ProviderHubModelPage {
  readonly generationId: string
  readonly items: readonly ProviderHubModelItem[]
  readonly page: {
    readonly limit: number
    readonly total: number
    readonly nextCursor: string | null
  }
  readonly warnings: readonly string[]
}

export interface ProviderHubUsageModel {
  readonly family: ProviderFamily
  readonly route: ProviderRoute
  readonly model: ModelRoute
  readonly connections: readonly ProviderConnection[]
  readonly prices: readonly PricebookEntry[]
}

export interface ProviderHubProviderSummary {
  readonly family: ProviderFamily
  readonly routes: readonly ProviderRoute[]
  readonly modelCount: number
  readonly connectableModelCount: number
  readonly connectedModelCount: number
  readonly verifiedModelCount: number
  readonly recommendedModelCount: number
}

export interface ProviderHubOverview {
  readonly generation: ProviderCatalogSnapshot['generation']
  readonly generationId: string
  readonly catalogHealth: CatalogRefreshHealth
  readonly counts: {
    readonly providers: number
    readonly routes: number
    readonly models: number
    readonly pricebookEntries: number
    readonly connections: number
  }
  readonly warnings: readonly string[]
}

export interface ProviderHubVerificationOverview {
  readonly generationId: string
  readonly bundle: VerificationEvidenceBundle | null
  readonly warnings: readonly string[]
}

interface ProviderHubView {
  readonly catalog: ProviderCatalogSnapshot
  readonly catalogHealth: CatalogRefreshHealth
  readonly connections: readonly ProviderConnection[]
  readonly generationId: string
  readonly verificationBundle: VerificationEvidenceBundle | null
  readonly warnings: readonly string[]
}

interface CursorPayload {
  readonly generationId: string
  readonly queryHash: string
  readonly offset: number
}

/** Query/control-plane facade over the validated catalog and secret-free connection projections. */
export class ProviderHubService {
  private transformed: { readonly hash: string; readonly catalog: ProviderCatalogSnapshot } | null = null

  constructor(private readonly options: ProviderHubServiceOptions) {}

  async overview(): Promise<ProviderHubOverview> {
    const view = await this.view()
    return {
      generation: view.catalog.generation,
      generationId: view.generationId,
      catalogHealth: view.catalogHealth,
      counts: {
        providers: view.catalog.families.length,
        routes: view.catalog.routes.length,
        models: view.catalog.models.length,
        pricebookEntries: view.catalog.prices.length,
        connections: view.connections.length,
      },
      warnings: view.warnings,
    }
  }

  async providers(): Promise<{
    readonly generationId: string
    readonly items: readonly ProviderHubProviderSummary[]
    readonly warnings: readonly string[]
  }> {
    const view = await this.view()
    const routeByFamily = groupBy(view.catalog.routes, route => route.familyId)
    const routeById = new Map(view.catalog.routes.map(route => [route.id, route]))
    const modelByFamily = groupBy(view.catalog.models, model => routeById.get(model.providerRouteId)?.familyId ?? '')
    const items = view.catalog.families.map(family => {
      const models = modelByFamily.get(family.id) ?? []
      return {
        family,
        routes: routeByFamily.get(family.id) ?? [],
        modelCount: models.length,
        connectableModelCount: models.filter(model => model.availability.connectable).length,
        connectedModelCount: models.filter(model => model.availability.credentialed).length,
        verifiedModelCount: models.filter(model => model.availability.verified).length,
        recommendedModelCount: models.filter(model => model.availability.recommended).length,
      }
    }).sort((left, right) => left.family.name.localeCompare(right.family.name))
    return { generationId: view.generationId, items, warnings: view.warnings }
  }

  async connections(): Promise<{
    readonly generationId: string
    readonly items: readonly ProviderConnection[]
    readonly warnings: readonly string[]
  }> {
    const view = await this.view()
    return {
      generationId: view.generationId,
      items: [...view.connections].sort((left, right) => left.label.localeCompare(right.label)),
      warnings: view.warnings,
    }
  }

  async verifications(): Promise<ProviderHubVerificationOverview> {
    const view = await this.view()
    return {
      generationId: view.generationId,
      bundle: view.verificationBundle,
      warnings: view.warnings,
    }
  }

  async models(query: ProviderHubModelQuery = {}): Promise<ProviderHubModelPage> {
    const view = await this.view()
    const routeById = new Map(view.catalog.routes.map(route => [route.id, route]))
    const familyById = new Map(view.catalog.families.map(family => [family.id, family]))
    const normalizedQ = query.q?.trim().toLocaleLowerCase()
    const scope = query.scope ?? 'all'
    const queryHash = hashQuery({
      q: normalizedQ,
      providerFamilyId: query.providerFamilyId,
      providerRouteId: query.providerRouteId,
      connectionId: query.connectionId,
      lifecycle: query.lifecycle,
      scope,
    })
    const priceByModel = groupBy(view.catalog.prices, price => price.scope.modelRouteId)
    const filtered = view.catalog.models.filter(model => {
      const route = routeById.get(model.providerRouteId)
      if (route == null) return false
      if (query.providerFamilyId != null && route.familyId !== query.providerFamilyId) return false
      if (query.providerRouteId != null && route.id !== query.providerRouteId) return false
      if (query.connectionId != null && !model.availability.connectionIds.includes(query.connectionId)) return false
      // Hidden means hidden from ordinary discovery, including the broad
      // `all` and `recommended` scopes. Diagnostics can still request the
      // lifecycle explicitly.
      if (model.availability.lifecycle === 'hidden' && query.lifecycle !== 'hidden') return false
      if (query.lifecycle != null && model.availability.lifecycle !== query.lifecycle) return false
      if (!matchesScope(model, scope)) return false
      if (normalizedQ != null && normalizedQ.length > 0) {
        const family = familyById.get(route.familyId)
        const haystack = [
          model.id,
          model.wireModelId,
          model.name,
          model.description,
          model.modelFamily,
          model.modelAuthor,
          ...model.aliases,
          route.id,
          route.name,
          family?.id,
          family?.name,
        ].filter((value): value is string => value != null).join('\n').toLocaleLowerCase()
        if (!haystack.includes(normalizedQ)) return false
      }
      return true
    }).sort(compareModels)

    const limit = Math.min(
      PROVIDER_HUB_MAX_PAGE_SIZE,
      Math.max(1, Math.floor(query.limit ?? PROVIDER_HUB_DEFAULT_PAGE_SIZE)),
    )
    const offset = query.cursor == null
      ? 0
      : decodeCursor(query.cursor, view.generationId, queryHash)
    const models = filtered.slice(offset, offset + limit)
    const nextOffset = offset + models.length
    return {
      generationId: view.generationId,
      items: models.map(model => ({ model, prices: priceByModel.get(model.id) ?? [] })),
      page: {
        limit,
        total: filtered.length,
        nextCursor: nextOffset < filtered.length
          ? encodeCursor({ generationId: view.generationId, queryHash, offset: nextOffset })
          : null,
      },
      warnings: view.warnings,
    }
  }

  /** Legacy wire view backed entirely by the same assembled Hub generation. */
  async compatibilityModels(): Promise<readonly ProviderHubCompatibilityModel[]> {
    const view = await this.view()
    const modelById = new Map(view.catalog.models.map(model => [model.id, model]))
    const pricesByModel = groupBy(view.catalog.prices, price => price.scope.modelRouteId)
    return (this.options.legacyModelPolicies ?? []).flatMap(policy => {
      const model = modelById.get(policy.id)
      if (model == null) return []
      const prices = pricesByModel.get(model.id) ?? []
      return [{
        id: model.id,
        name: model.name,
        provider: policy.providerId,
        tier: policy.tier,
        description: model.description ?? policy.description ?? '',
        ...(model.contextWindow == null ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxOutputTokens == null ? {} : { maxOutputTokens: model.maxOutputTokens }),
        costPer1kInput: pricePer1k(prices, 'input_text_tokens'),
        costPer1kOutput: pricePer1k(prices, 'output_text_tokens'),
        capabilities: policy.capabilities as readonly ProviderHubCompatibilityCapability[],
        aliases: model.aliases,
        releaseDate: model.releaseDate ?? policy.releaseDate ?? '',
        ...(model.availability.recommended ? { default: true } : {}),
        ...(model.availability.lifecycle === 'deprecated' ? { deprecated: true } : {}),
        hasCredentials: model.availability.credentialed,
        ...(policy.openRouterSlug == null ? {} : { orSlug: policy.openRouterSlug }),
      }]
    })
  }

  /** Pick one runnable default from this exact Hub generation. */
  async pickRunnableDefaultModel(): Promise<string | null> {
    const view = await this.view()
    const routeById = new Map(view.catalog.routes.map(route => [route.id, route]))
    const connectedDefault = view.catalog.models
      .filter(model => {
        const route = routeById.get(model.providerRouteId)
        return model.availability.credentialed
          && model.availability.connectable
          && model.availability.recommended
          && model.availability.lifecycle !== 'deprecated'
          && model.availability.lifecycle !== 'hidden'
          && route?.transport.runtimeId === 'loom'
          && route.kind !== 'local'
          && (this.options.isRuntimeProviderAvailable?.(route.transport.adapterId ?? '') ?? true)
      })
      .sort(compareModels)[0]
    if (connectedDefault != null) return connectedDefault.id
    return this.options.pickLocalModel?.() ?? null
  }

  /** Resolve one execution model to its canonical Hub route and price scopes. */
  async resolveUsageModel(modelId: string): Promise<ProviderHubUsageModel | null> {
    const view = await this.view()
    const routeById = new Map(view.catalog.routes.map(route => [route.id, route]))
    const familyById = new Map(view.catalog.families.map(family => [family.id, family]))
    const exact = view.catalog.models.find(model => model.id === modelId)
    const aliased = exact ?? view.catalog.models.find(model => model.aliases.includes(modelId))
    const adapterWire = aliased ?? view.catalog.models.find(model => {
      const route = routeById.get(model.providerRouteId)
      const adapterId = route?.transport.adapterId
      return adapterId != null && `${adapterId}:${model.wireModelId}` === modelId
    })
    if (adapterWire == null) return null

    const route = routeById.get(adapterWire.providerRouteId)
    if (route == null) return null
    const family = familyById.get(route.familyId)
    if (family == null) return null
    const connectionIds = new Set(adapterWire.availability.connectionIds)
    return {
      family,
      route,
      model: adapterWire,
      connections: view.connections.filter(connection => connectionIds.has(connection.id)),
      prices: view.catalog.prices.filter(price => price.scope.modelRouteId === adapterWire.id),
    }
  }

  async health(): Promise<ProviderHubOverview> {
    return this.overview()
  }

  async refresh(force = false): Promise<ProviderHubOverview> {
    await this.options.store.refresh(force)
    return this.overview()
  }

  private async view(): Promise<ProviderHubView> {
    const state = await this.options.store.load()
    const base = this.baseCatalog(state)
    const warnings: string[] = []
    if (state.health.status !== 'fresh') {
      const detail = state.health.errorMessage == null ? '' : `: ${state.health.errorMessage}`
      warnings.push(
        `Provider catalog refresh is ${state.health.status}; serving last-known-good generation ${state.health.activeGenerationId}${detail}`,
      )
    }
    const [connections, dynamic, verification] = await Promise.all([
      this.safeConnections(warnings),
      this.safeDynamicProjection(warnings),
      this.safeVerificationEvidence(warnings),
    ])
    const allConnections = dedupeById([...connections, ...(dynamic.connections ?? [])])
    const mergedCatalog = mergeCatalog(
      base,
      dynamic,
      allConnections,
      this.options.legacyModelPolicies ?? [],
    )
    const verificationApplication = verification.bundle == null
      ? { catalog: mergedCatalog, warnings: [] as readonly string[], appliedEvidenceIds: [] as readonly string[] }
      : applyVerificationEvidenceBundle(mergedCatalog, verification.bundle)
    warnings.push(...verificationApplication.warnings)
    const catalog = verificationApplication.catalog
    const revision = createHash('sha256')
      .update(catalog.generation.id)
      .update('\u0000')
      .update(catalog.models.map(model => model.id).join('\u0000'))
      .update('\u0000')
      .update(allConnections.map(connection => `${connection.id}:${connection.updatedAt}`).join('\u0000'))
      .update('\u0000')
      .update(verification.bundle?.bundleId ?? 'verification:none')
      .digest('hex')
      .slice(0, 16)
    return {
      catalog,
      catalogHealth: state.health,
      connections: allConnections,
      generationId: `${catalog.generation.id}:${revision}`,
      verificationBundle: verification.bundle,
      warnings,
    }
  }

  private baseCatalog(state: ProviderCatalogStoreState): ProviderCatalogSnapshot {
    if (this.transformed?.hash === state.artifact.sha256) return this.transformed.catalog
    const catalog = transformModelsDevArtifact(state.artifact, {
      connectableProviderIds: this.options.connectableProviderIds,
      connectableProviderRoutes: this.options.connectableProviderRoutes,
      source: state.source,
    })
    this.transformed = { hash: state.artifact.sha256, catalog }
    return catalog
  }

  private async safeConnections(warnings: string[]): Promise<readonly ProviderConnection[]> {
    if (this.options.listConnections == null) return []
    try {
      return await this.options.listConnections()
    } catch (error) {
      warnings.push(`Provider connections unavailable: ${safeMessage(error)}`)
      return []
    }
  }

  private async safeDynamicProjection(warnings: string[]): Promise<ProviderHubDynamicProjection> {
    if (this.options.loadDynamicProjection == null) return {}
    try {
      return await this.options.loadDynamicProjection()
    } catch (error) {
      warnings.push(`Runtime provider projection unavailable: ${safeMessage(error)}`)
      return {}
    }
  }

  private async safeVerificationEvidence(
    warnings: string[],
  ): Promise<VerificationEvidenceStoreState> {
    if (this.options.loadVerificationEvidence == null) {
      return { bundle: null, status: 'missing' }
    }
    try {
      const state = await this.options.loadVerificationEvidence()
      if (state.warning != null) warnings.push(state.warning)
      return state
    } catch {
      warnings.push('Provider verification evidence is unavailable; no verification claims were loaded.')
      return { bundle: null, status: 'error' }
    }
  }
}

export class ProviderHubCursorError extends Error {
  readonly name = 'ProviderHubCursorError'
}

function mergeCatalog(
  base: ProviderCatalogSnapshot,
  dynamic: ProviderHubDynamicProjection,
  connections: readonly ProviderConnection[],
  legacyPolicies: readonly ProviderHubLegacyModelPolicy[],
): ProviderCatalogSnapshot {
  const families = dedupeById([...base.families, ...(dynamic.families ?? [])])
  const routes = dedupeById([...base.routes, ...(dynamic.routes ?? [])])
  const routeIds = new Set(routes.map(route => route.id))
  const policyBySourceId = new Map(legacyPolicies.map(policy => [policy.sourceModelRouteId, policy]))
  const matchedPolicies = new Set<string>()
  const connectionByRoute = groupBy(
    connections.filter(connection => connection.status === 'configured'),
    connection => connection.providerRouteId,
  )
  const canonicalBaseModels = base.models.map(model => {
    const policy = policyBySourceId.get(model.id)
    if (policy == null) return model
    matchedPolicies.add(policy.id)
    return applyLegacyPolicy(model, policy)
  })
  const fallbackModels = legacyPolicies
    .filter(policy => !matchedPolicies.has(policy.id) && routeIds.has(policy.providerRouteId))
    .map(legacyFallbackModel)
  const models = dedupeById([
    ...canonicalBaseModels,
    ...fallbackModels,
    ...(dynamic.models ?? []),
  ]).filter(
    model => routeIds.has(model.providerRouteId),
  ).map(model => {
    const connectionIds = model.availability.connectable
      ? (connectionByRoute.get(model.providerRouteId) ?? []).map(connection => connection.id)
      : []
    return {
      ...model,
      availability: {
        ...model.availability,
        credentialed: connectionIds.length > 0,
        connectionIds,
      },
    }
  })
  const canonicalIdBySourceId = new Map(
    legacyPolicies.map(policy => [policy.sourceModelRouteId, policy.id]),
  )
  const prices = dedupeById([...base.prices, ...(dynamic.prices ?? [])]).map(price => {
    const canonicalModelId = canonicalIdBySourceId.get(price.scope.modelRouteId)
    return canonicalModelId == null
      ? price
      : { ...price, scope: { ...price.scope, modelRouteId: canonicalModelId } }
  })
  return { ...base, families, routes, models, prices }
}

function applyLegacyPolicy(model: ModelRoute, policy: ProviderHubLegacyModelPolicy): ModelRoute {
  return {
    ...model,
    id: policy.id,
    aliases: [...new Set([
      ...model.aliases,
      ...policy.aliases,
      ...(model.id === policy.id ? [] : [model.id]),
    ])],
    availability: {
      ...model.availability,
      recommended: policy.recommended,
      ...(policy.deprecated ? { lifecycle: 'deprecated' as const } : {}),
    },
  }
}

function legacyFallbackModel(policy: ProviderHubLegacyModelPolicy): ModelRoute {
  return {
    id: policy.id,
    providerRouteId: policy.providerRouteId,
    wireModelId: policy.wireModelId,
    name: policy.name,
    ...(policy.description == null ? {} : { description: policy.description }),
    aliases: [...policy.aliases],
    ...(policy.releaseDate == null ? {} : { releaseDate: policy.releaseDate }),
    contextWindow: positiveOrNull(policy.contextWindow),
    maxInputTokens: null,
    maxOutputTokens: positiveOrNull(policy.maxOutputTokens),
    capabilities: LEGACY_CAPABILITIES.map(capability => ({
      capability,
      upstream: {
        status: legacyCapabilityClaim(policy.capabilities, capability),
        source: 'manual' as const,
        sourceRef: 'legacy-curated-catalog',
      },
      ownware: { status: 'untested' as const },
    })),
    variants: [],
    availability: {
      catalogued: true,
      connectable: true,
      credentialed: false,
      verified: false,
      recommended: policy.recommended,
      lifecycle: policy.deprecated ? 'deprecated' : 'active',
      connectionIds: [],
      reason: 'Retained for existing Ownware profiles; absent from the active Models.dev generation.',
    },
    billingKind: policy.billingKind,
    catalogSourceRef: 'legacy-curated:v1',
  }
}

const LEGACY_CAPABILITIES = [
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
] as const

function legacyCapabilityClaim(
  capabilities: readonly string[],
  capability: typeof LEGACY_CAPABILITIES[number],
): 'supported' | 'unknown' {
  const mapping: Partial<Record<typeof LEGACY_CAPABILITIES[number], string>> = {
    text_streaming: 'streaming',
    tool_calls: 'tools',
    reasoning: 'thinking',
    image_input: 'vision',
    pdf_input: 'pdf',
    structured_output: 'structured',
    prompt_caching: 'cache',
  }
  const legacy = mapping[capability]
  return legacy != null && capabilities.includes(legacy) ? 'supported' : 'unknown'
}

function positiveOrNull(value: number | undefined): number | null {
  return value != null && value > 0 ? value : null
}

function matchesScope(model: ModelRoute, scope: ProviderHubModelScope): boolean {
  if (scope === 'connectable') return model.availability.connectable
  if (scope === 'connected') return model.availability.credentialed
  if (scope === 'verified') return model.availability.verified
  if (scope === 'recommended') return model.availability.recommended
  return true
}

function pricePer1k(
  prices: readonly PricebookEntry[],
  dimension: 'input_text_tokens' | 'output_text_tokens',
): number | null {
  const base = prices.find(price => (
    price.scope.variantId == null
    && price.scope.serviceTier == null
    && price.scope.region == null
    && price.scope.plan == null
    && price.scope.modality == null
    && price.scope.minimumInputTokens == null
  ))
  const rate = base?.rates.find(candidate => candidate.dimension === dimension)
  if (rate == null) return null
  return Number(((rate.amountUsd * 1_000) / rate.unitSize).toFixed(10))
}

function compareModels(left: ModelRoute, right: ModelRoute): number {
  const recommended = Number(right.availability.recommended) - Number(left.availability.recommended)
  if (recommended !== 0) return recommended
  const connected = Number(right.availability.credentialed) - Number(left.availability.credentialed)
  if (connected !== 0) return connected
  const name = left.name.localeCompare(right.name)
  return name === 0 ? left.id.localeCompare(right.id) : name
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>()
  for (const item of items) {
    const id = key(item)
    const list = result.get(id) ?? []
    list.push(item)
    result.set(id, list)
  }
  return result
}

function dedupeById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...new Map(items.map(item => [item.id, item])).values()]
}

function hashQuery(query: object): string {
  return createHash('sha256').update(JSON.stringify(query)).digest('hex').slice(0, 16)
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string, generationId: string, queryHash: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>
    if (
      parsed.generationId !== generationId ||
      parsed.queryHash !== queryHash ||
      typeof parsed.offset !== 'number' ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      throw new Error('Cursor does not match the active catalog generation and query')
    }
    return parsed.offset
  } catch (error) {
    throw new ProviderHubCursorError(`Invalid or expired provider catalog cursor: ${safeMessage(error)}`)
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
