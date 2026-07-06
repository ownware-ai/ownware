/**
 * Connectors handlers.
 *
 *   GET   /api/v1/connectors[?profileId=...]
 *   GET   /api/v1/connectors/:id/providers   — pluggable connectors only
 *   PATCH /api/v1/connectors/:id/provider    — pluggable connectors only
 *
 * The pluggable-connector subroutes live in `./web-search.ts`; this file
 * wires them into a single factory so `server.ts` only has to call one
 * function and register three routes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJSON, sendError } from '../router.js'
import { ConnectorsQuerySchema } from '../../connector/schema.js'
import {
  ConnectorRegistry,
  type ConnectorRegistryOptions,
  type LastVerifiedAtLookup,
} from '../../connector/registry.js'
import { featuredComposioSlugSet } from '../../connector/composio/featured.js'
import type { ProfileRegistry } from '../../profile/registry.js'
import { WebSearchService, type WebSearchSettingsStore } from '../../connector/web-search/service.js'
import { buildWebSearchConnector } from '../../connector/web-search/connector.js'
import { createWebSearchHandlers } from './web-search.js'
import type { ConnectorStatusBus } from '../../connector/status-bus.js'
import type { ConnectorSourceProvider } from '../../connector/registry.js'
import type { SourcePreferences } from '../../connector/source-preferences.js'
import { MCPRegistrySourceProvider } from '../../connector/providers/mcp-registry-source-provider.js'
import type { PaginatedConnectorSource } from '../../connector/composio/source.js'

/**
 * Setting key the Phase 6-C toggle writes. String value `'true'` =
 * registry source on; anything else (including absent) = off.
 * Read by `MCPRegistrySourceProvider`'s `enabledChecker` gate so the
 * provider only lists global registry entries when the user has
 * opted in.
 */
const SETTING_MCP_REGISTRY_ENABLED = 'connectors.mcp_registry_enabled'

/**
 * Read the user's Settings → Advanced toggle for the MCP registry
 * source. Default off. Used by the `MCPRegistrySourceProvider`'s
 * `listGlobal` gate. Previously also feed the connectors() agent
 * tool's search-suggestion banners; that path retired 2026-05-12
 * alongside the search action.
 */
function isMCPRegistryEnabled(settings: WebSearchSettingsStore): boolean {
  return settings.getSetting(SETTING_MCP_REGISTRY_ENABLED)?.value === 'true'
}

export interface ConnectorHandlersDeps {
  readonly profileRegistry: ProfileRegistry
  readonly settings: WebSearchSettingsStore
  /**
   * Shared WebSearchService. When omitted a new one is created from
   * `settings`. The gateway passes its singleton so the same service
   * instance is used by the connector handlers, by `assembleAgent`
   * (via the run handler), and by the status bus.
   */
  readonly webSearchService?: WebSearchService
  /**
   * Status bus the web-search PATCH emits transitions to. Optional —
   * when omitted, PATCH still works, it just doesn't fan out SSE.
   */
  readonly statusBus?: ConnectorStatusBus
  /**
   * Additional source providers to register beyond the default
   * built-in + MCP sources. Phase 2a+ uses this to plug in the
   * Composio source (when COMPOSIO_API_KEY is set). Omitted/empty
   * means "no extra sources" — behaviour identical to M1/M1.5.
   */
  readonly additionalSources?: readonly ConnectorSourceProvider[]
  /**
   * Phase 2b.2b — persistence-backed preferences consulted by the
   * registry's alias de-dup pass. When omitted, the registry uses the
   * default resolver precedence only (no user overrides).
   */
  readonly sourcePreferences?: SourcePreferences
  /**
   * T04 — reader for API-registered custom MCP servers. When
   * provided, the registry adds a CustomMCPSourceProvider so custom
   * servers appear in `/connectors` + `/catalog` with
   * `source: 'custom_mcp'`. Omit to preserve pre-T04 behaviour.
   */
  readonly customMCPState?: ConnectorRegistryOptions['customMCPState']
  /**
   * F4.c-2 — callback that returns the most recent
   * `connector_connections.last_verified_at` (Unix ms) for an MCP
   * connector `(connectorId, source)` pair. Forwarded to the registry
   * so `mcpServerToConnector` / `mcpRowToConnector` can project
   * `lastVerifiedAt` onto the wire. Composio's projection happens
   * inside `composio/source.ts` (it already holds the row), so this
   * lookup is consulted only on the MCP path.
   */
  readonly lastVerifiedAtLookup?: LastVerifiedAtLookup
  /**
   * Override for the curated-Composio slug set the lobby filter
   * consults. Defaults to `featuredComposioSlugSet()` from the
   * curated `featured.ts` module — the production behavior.
   *
   * Tests inject a fixed set so the filter behavior can be verified
   * independently of whatever slugs the v1 baseline currently bakes
   * into the curated list (which is empty today).
   */
  readonly featuredComposioSlugProvider?: () => ReadonlySet<string>
  /**
   * Paginated Composio source for the `?source=composio` branch of
   * `GET /api/v1/connectors`. When wired, the handler routes that
   * query to a single Composio page (`{ items, nextCursor }` envelope)
   * instead of the unified flat list — backs the Add Tool modal's
   * infinite-scroll without forcing every caller to load the full
   * 1000-toolkit catalog. Omit to disable the paginated branch (the
   * handler returns a 400 when `source=composio` is requested with no
   * wired source — better than silently returning empty).
   */
  readonly composioSource?: PaginatedConnectorSource
}

export function createConnectorHandlers(deps: ConnectorHandlersDeps) {
  const { profileRegistry, settings, statusBus } = deps
  const featuredSlugProvider =
    deps.featuredComposioSlugProvider ?? featuredComposioSlugSet

  const webSearchService = deps.webSearchService ?? new WebSearchService({ settings })
  const webSearchHandlers = createWebSearchHandlers({
    service: webSearchService,
    ...(statusBus ? { statusBus } : {}),
  })

  const registry = new ConnectorRegistry(profileRegistry, {
    webSearchBuilder: () => buildWebSearchConnector(webSearchService),
    ...(deps.sourcePreferences ? { sourcePreferences: deps.sourcePreferences } : {}),
    ...(deps.customMCPState ? { customMCPState: deps.customMCPState } : {}),
    ...(deps.lastVerifiedAtLookup ? { lastVerifiedAtLookup: deps.lastVerifiedAtLookup } : {}),
  })
  for (const extra of deps.additionalSources ?? []) {
    registry.addSource(extra)
  }

  // Phase 6-C.2 (2026-05-07): MCP registry source as an opt-in
  // catalog source. The provider is ALWAYS added to the registry,
  // but its `enabledChecker` reads the user setting on every
  // listGlobal() call and short-circuits to `[]` when the toggle
  // is off. That means a Settings → Advanced flip takes effect on
  // the very next search — no daemon restart, no session
  // reassembly. Default state (setting absent / 'false') is OFF
  // so the curated Tier 1 catalog is the v1 baseline experience.
  registry.addSource(
    new MCPRegistrySourceProvider({
      enabledChecker: () => isMCPRegistryEnabled(settings),
    }),
  )

  async function listConnectors(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const rawProfileId = url.searchParams.get('profileId')
    // `composioFeatured` is a tri-state string → boolean. Accept `true`
    // and `false` (case-insensitive). Any other literal is a 400 so
    // silent typos never slip through to "show all 1000 entries".
    const rawFeatured = url.searchParams.get('composioFeatured')
    let composioFeatured: boolean | undefined
    if (rawFeatured === null || rawFeatured.length === 0) {
      composioFeatured = undefined
    } else if (rawFeatured.toLowerCase() === 'true') {
      composioFeatured = true
    } else if (rawFeatured.toLowerCase() === 'false') {
      composioFeatured = false
    } else {
      sendError(
        res,
        400,
        `Invalid query params: composioFeatured must be "true" or "false"`,
      )
      return
    }
    const rawSource = url.searchParams.get('source')
    const rawSearch = url.searchParams.get('search')
    const rawLimit = url.searchParams.get('limit')
    const rawCursor = url.searchParams.get('cursor')
    let limit: number | undefined
    if (rawLimit !== null && rawLimit.length > 0) {
      const parsedLimit = Number(rawLimit)
      if (!Number.isFinite(parsedLimit) || !Number.isInteger(parsedLimit) || parsedLimit <= 0) {
        sendError(res, 400, `Invalid query params: limit must be a positive integer`)
        return
      }
      limit = parsedLimit
    }
    const raw = {
      profileId: rawProfileId && rawProfileId.length > 0 ? rawProfileId : undefined,
      composioFeatured,
      ...(rawSource !== null && rawSource.length > 0 ? { source: rawSource } : {}),
      ...(rawSearch !== null && rawSearch.length > 0 ? { search: rawSearch } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(rawCursor !== null && rawCursor.length > 0 ? { cursor: rawCursor } : {}),
    }
    const parsed = ConnectorsQuerySchema.safeParse(raw)
    if (!parsed.success) {
      sendError(res, 400, `Invalid query params: ${parsed.error.message}`)
      return
    }

    // Paginated branch: `?source=composio[&search=&limit=&cursor=]`.
    // Returns one page from Composio with an opaque cursor for the
    // next page. Skips MCP / builtin / web-search entirely — those
    // catalogs are small and stay on the unified path below.
    if (parsed.data.source === 'composio') {
      if (parsed.data.profileId !== undefined) {
        sendError(
          res,
          400,
          `source=composio is incompatible with profileId — paginated browse is for the unscoped lobby view only`,
        )
        return
      }
      if (deps.composioSource === undefined) {
        sendError(
          res,
          400,
          `source=composio not wired on this gateway`,
        )
        return
      }
      try {
        const page = await deps.composioSource.listPage({
          ...(parsed.data.search !== undefined ? { search: parsed.data.search } : {}),
          ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
          ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
        })
        sendJSON(res, 200, { items: page.items, nextCursor: page.nextCursor })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        sendError(res, 500, `Failed to list Composio page: ${message}`)
      }
      return
    }

    const { profileId } = parsed.data
    // Featured-only filter applies ONLY to the un-scoped lobby view.
    // When `profileId` is present the caller is asking "what has this
    // profile declared?" — the profile's `tools.composio.toolkits` is
    // already the authoritative filter (see P01). Layering the
    // curated ~15 featured shortlist on top would silently drop any
    // toolkit the user added that the featured list doesn't
    // blessed — e.g. a user types `slack` in the Add Tool modal,
    // backend persists it, the next refetch returns zero Composio
    // rows because `slack` isn't in `featuredComposioSlugSet()`. That
    // was observed as the "Add → appears → disappears" regression.
    //
    // Rule:
    //   - profileId set   → return exactly what the profile declared.
    //   - profileId unset → apply `featuredOnly` (default true) to
    //     keep the lobby's discovery view usable before the full
    //     catalogue syncs.
    // The curated-only Composio filter applies when ALL THREE hold:
    //   (a) the request is for the unscoped lobby view (no profileId)
    //   (b) the caller hasn't explicitly opted out via composioFeatured=false
    //   (c) the curated featured set has at least one entry
    //
    // The third gate is the production fix added 2026-05-10: an empty
    // featured set was silently dropping every Composio toolkit from the
    // lobby (observed: 1026/1026 hidden on the owner's machine after a
    // successful sync). The intent of the filter is "limit to curated"
    // — meaningless when there's nothing to limit to. When the featured
    // list grows back, this gate auto-re-engages.
    try {
      const list = profileId
        ? await registry.listForProfile(profileId)
        : await registry.list()
      const slugs = featuredSlugProvider()
      const featuredOnly =
        profileId === undefined &&
        (parsed.data.composioFeatured ?? true) &&
        slugs.size > 0
      const filtered = featuredOnly
        ? list.filter(c => c.source !== 'composio' || slugs.has(c.id))
        : list
      sendJSON(res, 200, filtered)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      sendError(res, 500, `Failed to list connectors: ${message}`)
    }
  }

  return {
    listConnectors,
    listProviders: webSearchHandlers.listProviders,
    setProvider: webSearchHandlers.setProvider,
    /** Exposed for tests and future consumers. */
    webSearchService,
    /** Exposed so the 2b.1 connect-dispatcher reuses the same registry
     * (builtin + MCP + any additional sources). */
    registry,
  }
}

/**
 * Back-compat single-handler factory — kept so existing tests that imported
 * `createConnectorsHandler` keep compiling. Delegates to the new factory
 * with a no-op settings store (no persisted choice, pure env+default
 * resolution).
 */
export function createConnectorsHandler(profileRegistry: ProfileRegistry) {
  const noopStore: WebSearchSettingsStore = {
    getSetting: () => undefined,
    setSetting: () => undefined,
  }
  return createConnectorHandlers({ profileRegistry, settings: noopStore }).listConnectors
}
