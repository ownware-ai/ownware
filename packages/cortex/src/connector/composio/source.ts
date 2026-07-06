/**
 * Composio source plugin — live catalog passthrough.
 *
 * Composio is a remote catalog. We treat it like one — call
 * `client.listToolkits()` per request, no local mirror. The previous
 * implementation maintained a SQLite copy refreshed hourly, with
 * derived flags (`hasManagedAuthConfig`) that the UI routed decisions
 * through. The mirror staled faster than users created auth_configs;
 * "Setup needed" persisted after the dashboard already had a live
 * config. Live calls eliminate the staleness window.
 *
 * Graceful degradation:
 *   - When `COMPOSIO_API_KEY` is NOT set, `createComposioSource()`
 *     returns `null` after emitting one structured warning line. The
 *     gateway boots; `/connectors` returns built-ins + MCP.
 *   - When the key is set, the returned `ConnectorSourceProvider`
 *     answers `listGlobal()` / `listForProfile()` by walking Composio's
 *     paginated `/api/v3/toolkits`.
 *
 * Caching: a 60s in-memory TTL bounds traffic. Within that window every
 * `listGlobal()` call shares one paginated walk; concurrent callers
 * during a cache miss share a single in-flight promise so we never run
 * two walks at once. The cache is plain JS state on the source
 * instance — no SQL, no persistence. The client's TanStack staleTime
 * (15s) is the outer layer; this 60s is the gateway-side floor.
 *
 * Auth_config discovery: we do NOT pre-check whether each toolkit has
 * a connectable auth_config. That question is answered at click time
 * by the connect handler's call to `listAuthConfigs`. Pulling that
 * answer into the catalog row was the source of the staleness pain;
 * removing it is the architectural fix.
 */

import type {
  AuthMode,
  Connector,
  ConnectorCategory,
  ConnectorStatus,
} from '../schema.js'
import { makeCanonicalConnectorId } from '../schema.js'
import { deriveLogicalKey } from '../logical-key.js'
import type { ConnectorSourceProvider } from '../registry.js'
import type { ConnectorConnectionsStore } from '../connections/store.js'
import type { ConnectorStatusBus } from '../status-bus.js'
import type { LoadedProfile } from '../../profile/loader.js'
import type { ComposioToolkitSummary } from './client.js'
import type { ComposioCatalogCache } from './catalog-cache.js'

/**
 * Narrow read-only view of the profile registry. `ComposioSourceProvider`
 * only needs to ask "is this profile registered?" and "load it".
 */
export interface ComposioProfileReader {
  has(profileId: string): boolean
  get(profileId: string): Promise<LoadedProfile>
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface ComposioSourceOptions {
  /**
   * Resolved API key (from env OR vault). `null`/empty disables the
   * source. The factory checks this before constructing — the source
   * itself trusts the passed `catalogCache` is valid when present.
   */
  readonly apiKey: string | null | undefined
  /**
   * Shared catalogue cache. The gateway constructs one
   * `ComposioCatalogCache` per Composio client and hands it to every
   * surface that needs to resolve a toolkit slug (source provider,
   * tool adapter). `null` when Composio is not configured.
   */
  readonly catalogCache: ComposioCatalogCache | null
  readonly connections: ConnectorConnectionsStore
  readonly statusBus: ConnectorStatusBus
  /**
   * Read-only profile lookup used by `listForProfile` to resolve
   * `profile.config.tools.composio.toolkits` into live toolkit
   * summaries. When omitted, `listForProfile` returns `[]`.
   */
  readonly profileReader?: ComposioProfileReader
  /**
   * Install-scoped identity governing "my" connections. Required.
   * Resolved via `InstallIdentity.resolve()` at gateway boot.
   */
  readonly entityId: string
  /** Test seam — override the warn logger. */
  readonly warn?: (msg: string) => void
}

const DEFAULT_WARN = (msg: string): void => { console.warn(msg) }

/**
 * Returns a `ConnectorSourceProvider` when Composio is configured,
 * `null` when it isn't. Emitting the warning here keeps the log line
 * identical regardless of caller (env vs vault vs test).
 */
export function createComposioSource(
  opts: ComposioSourceOptions,
): PaginatedConnectorSource | null {
  const key = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : ''
  if (key.length === 0 || opts.catalogCache === null) {
    ;(opts.warn ?? DEFAULT_WARN)(
      '[ownware] composio: disabled (COMPOSIO_API_KEY not set)',
    )
    return null
  }

  return new ComposioSourceProvider({
    catalogCache: opts.catalogCache,
    connections: opts.connections,
    statusBus: opts.statusBus,
    entityId: opts.entityId,
    profileReader: opts.profileReader ?? null,
  })
}

// ---------------------------------------------------------------------------
// Source provider
// ---------------------------------------------------------------------------

interface InternalOpts {
  readonly catalogCache: ComposioCatalogCache
  readonly connections: ConnectorConnectionsStore
  readonly statusBus: ConnectorStatusBus
  readonly entityId: string
  readonly profileReader: ComposioProfileReader | null
}

/**
 * Wire shape returned by `ComposioSourceProvider.listPage()`. Mirrors
 * Composio's own paginator: a small array of Connectors and an opaque
 * cursor the client replays back to fetch the next page. Null cursor =
 * end of list.
 */
export interface ConnectorPage {
  readonly items: readonly Connector[]
  readonly nextCursor: string | null
}

/**
 * Extension of the base `ConnectorSourceProvider` for sources that
 * support server-side pagination. Composio implements this (its catalog
 * is ~1000 toolkits, paginated by the upstream API). MCP / builtin do
 * NOT — their catalogs are small enough that the unified `listGlobal()`
 * remains the right shape. Keep this interface composio-specific until
 * a third paginated source proves a shared abstraction.
 */
export interface PaginatedConnectorSource extends ConnectorSourceProvider {
  listPage(params?: {
    readonly search?: string
    readonly cursor?: string
    readonly limit?: number
  }): Promise<ConnectorPage>
}

class ComposioSourceProvider implements PaginatedConnectorSource {
  readonly name = 'composio'

  constructor(private readonly opts: InternalOpts) {}

  async listGlobal(): Promise<Connector[]> {
    const toolkits = await this.opts.catalogCache.listToolkits()
    return toolkits.map((t) => this.toConnector(t))
  }

  /**
   * Paginated read — fetches ONE page from Composio. Backs the
   * gateway's `/api/v1/connectors?source=composio&search=&cursor=`
   * passthrough so the Add Tool modal can render the first page of
   * toolkits in sub-second time instead of waiting for the full
   * 1000-row walk that `listGlobal()` does.
   *
   * Search is forwarded to Composio's `?search=` query param; cursor
   * is the opaque token Composio returned on the previous page. Both
   * are optional — omitting them returns the first page with no filter.
   */
  async listPage(params: {
    readonly search?: string
    readonly cursor?: string
    readonly limit?: number
  } = {}): Promise<ConnectorPage> {
    const page = await this.opts.catalogCache.listPage(params)
    return {
      items: page.items.map((t) => this.toConnector(t)),
      nextCursor: page.nextCursor,
    }
  }

  /**
   * Profile-scoped list. Returns only the Composio toolkits the profile
   * has declared in `config.tools.composio.toolkits`. Declared slugs
   * absent from the live catalog are skipped silently — the assembler's
   * per-profile tool path emits a `connector_unknown` stub for the same
   * case so the agent still sees a helpful error at call time.
   */
  async listForProfile(profileId: string): Promise<Connector[]> {
    const reader = this.opts.profileReader
    if (reader === null) return []
    if (!reader.has(profileId)) return []

    let profile
    try {
      profile = await reader.get(profileId)
    } catch {
      return []
    }

    const declaredSlugs = profile.config.tools.composio.toolkits
    if (declaredSlugs.length === 0) return []

    const declaredSet = new Set(declaredSlugs)
    const toolkits = await this.opts.catalogCache.listToolkits()
    return toolkits
      .filter((t) => declaredSet.has(t.slug))
      .map((t) => this.toConnector(t))
  }

  private toConnector(item: ComposioToolkitSummary): Connector {
    const active = this.opts.connections.findActive(
      item.slug,
      'composio',
      this.opts.entityId,
    )
    const auth = toolkitAuth(item)
    // No-auth toolkits (e.g. Composio Code Interpreter, hosted Python
    // sandbox) have nothing to authenticate. They are always usable
    // the moment a profile declares them — there is no OAuth round
    // trip, no API key, no connected-account record on Composio's
    // side. Reporting `needs_setup` here would surface them in the
    // chat preflight banner with a "Connect" button that does
    // nothing meaningful (the dispatcher has no auth dialog to open).
    // Mirror TrustClaw's pattern: `noAuth` toolkits count as
    // connected by definition.
    const status: ConnectorStatus = auth.mode === 'none'
      ? 'ready'
      : active?.status === 'ready' ? 'ready' : 'needs_setup'
    const category = mapCategory(extractCategory(item))
    const iconUrl = extractIcon(item)
    const description = extractDescription(item)

    const lastVerifiedAt = active?.lastVerifiedAt != null
      ? new Date(active.lastVerifiedAt).toISOString()
      : undefined

    const connector: Connector = {
      id: item.slug,
      canonicalId: makeCanonicalConnectorId('composio', item.slug),
      logicalKey: deriveLogicalKey('composio', item.slug),
      name: item.name,
      description,
      source: 'composio',
      category,
      auth,
      status,
      toolNames: null,
      iconUrl,
      ...(lastVerifiedAt !== undefined ? { lastVerifiedAt } : {}),
    }
    return connector
  }
}

// ---------------------------------------------------------------------------
// Toolkit-summary → Connector mappers (moved from the deleted sync engine)
// ---------------------------------------------------------------------------

function extractCategory(item: ComposioToolkitSummary): string | null {
  const cats = item.meta?.categories
  if (Array.isArray(cats) && cats.length > 0) {
    const first = cats[0]
    if (first && typeof first.name === 'string') return first.name
  }
  return null
}

function extractIcon(item: ComposioToolkitSummary): string | null {
  const logo = item.meta?.logo
  return typeof logo === 'string' && logo.length > 0 ? logo : null
}

function extractDescription(item: ComposioToolkitSummary): string {
  const d = item.meta?.description
  return typeof d === 'string' && d.length > 0 ? d : ''
}

/**
 * Pick the highest-priority auth scheme the toolkit supports and
 * translate to the Connector's `AuthMode` shape. `no_auth=true`
 * overrides everything.
 */
function toolkitAuth(item: ComposioToolkitSummary): AuthMode {
  if (item.no_auth === true) return { mode: 'none' }
  const schemes = (item.auth_schemes ?? []).map((s) => s.toLowerCase())
  if (
    schemes.includes('oauth2') ||
    schemes.includes('s2s_oauth2') ||
    schemes.includes('dcr_oauth') ||
    schemes.includes('oauth1')
  ) {
    return { mode: 'oauth', provider: item.name, hasPreset: false }
  }
  if (
    schemes.includes('api_key') ||
    schemes.includes('bearer_token') ||
    schemes.includes('basic') ||
    schemes.includes('basic_with_jwt')
  ) {
    return {
      mode: 'api_key',
      envVars: [{
        name: `${item.slug.toUpperCase()}_API_KEY`,
        description: `${item.name} API key`,
        isRequired: true,
        isSecret: true,
      }],
    }
  }
  if (schemes.includes('no_auth')) return { mode: 'none' }
  // Unknown / empty schemes — default to OAuth-shaped. Safest fallback
  // when the catalogue evolves with a new auth type.
  return schemes.length === 0
    ? { mode: 'none' }
    : { mode: 'oauth', provider: item.name, hasPreset: false }
}

/**
 * Map a Composio category string into Ownware's `ConnectorCategory`
 * enum.
 *
 * Strategy: substring + prefix matching, not literal equality. The
 * Composio category space is open-ended (new categories appear with
 * each catalog refresh); strict equality would silently mis-bucket
 * every new category into "Other."
 */
function mapCategory(c: string | null): ConnectorCategory {
  if (c === null) return 'other'
  const lower = c.toLowerCase().trim()
  if (lower === '') return 'other'

  if (lower === 'artificial intelligence' || lower.startsWith('ai ')) return 'ai'

  if (
    lower.startsWith('developer tools') ||
    lower === 'devtools' ||
    lower === 'developer' ||
    lower === 'it operations' ||
    lower === 'devops' ||
    lower === 'internet of things' ||
    lower === 'app builder' ||
    lower === 'website builders' ||
    lower === 'model context protocol'
  ) {
    return 'dev-tools'
  }

  if (
    lower === 'productivity' ||
    lower === 'productivity & project management' ||
    lower === 'project management' ||
    lower === 'product management' ||
    lower === 'task management' ||
    lower === 'team collaboration' ||
    lower === 'crm' ||
    lower === 'sales & crm' ||
    lower === 'ai sales tools' ||
    lower === 'contact management' ||
    lower.startsWith('marketing') ||
    lower === 'drip emails' ||
    lower === 'ads & conversion' ||
    lower === 'documents' ||
    lower === 'spreadsheets' ||
    lower === 'notes' ||
    lower === 'forms & surveys' ||
    lower === 'signatures' ||
    lower === 'scheduling & booking' ||
    lower === 'event management' ||
    lower === 'time tracking software' ||
    lower === 'human resources' ||
    lower === 'hr talent & recruitment' ||
    lower === 'customer support' ||
    lower === 'proposal & invoice management' ||
    lower === 'url shortener' ||
    lower === 'bookmark managers' ||
    lower === 'fitness'
  ) {
    return 'productivity'
  }

  if (
    lower === 'communication' ||
    lower === 'email' ||
    lower === 'transactional email' ||
    lower === 'email newsletters' ||
    lower === 'phone & sms' ||
    lower === 'team chat' ||
    lower === 'video conferencing' ||
    lower === 'webinars' ||
    lower === 'notifications'
  ) {
    return 'communication'
  }

  if (
    lower === 'finance' ||
    lower === 'accounting' ||
    lower === 'taxes' ||
    lower === 'fundraising' ||
    lower === 'payment processing' ||
    lower === 'ecommerce' ||
    lower === 'e-commerce' ||
    lower === 'commerce' ||
    lower === 'reviews'
  ) {
    return 'finance'
  }

  if (
    lower === 'data' ||
    lower === 'analytics' ||
    lower === 'business intelligence' ||
    lower === 'databases' ||
    lower === 'server monitoring'
  ) {
    return 'data'
  }

  if (lower === 'cloud' || lower === 'file management & storage') return 'cloud'

  if (
    lower === 'security' ||
    lower === 'security & identity tools' ||
    lower === 'ai safety compliance detection'
  ) {
    return 'security'
  }

  if (lower === 'design' || lower === 'images & design') return 'design'

  if (
    lower === 'media' ||
    lower === 'video & audio' ||
    lower === 'transcription' ||
    lower === 'gaming'
  ) {
    return 'media'
  }

  if (
    lower === 'social' ||
    lower === 'social media accounts' ||
    lower === 'social media marketing'
  ) {
    return 'social'
  }

  if (
    lower === 'research' ||
    lower === 'news & lifestyle' ||
    lower === 'online courses' ||
    lower === 'education'
  ) {
    return 'research'
  }

  return 'other'
}
