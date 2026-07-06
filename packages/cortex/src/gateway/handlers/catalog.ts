/**
 * Catalog handlers — tools and models listing.
 *
 * Model catalog is sourced from `gateway/catalog/models/` (three per-provider
 * files). Add new models there, not here.
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJSON, sendError } from '../router.js'
import type { ModelInfo } from '../types.js'
import { ALL_MODELS } from '../catalog/models/index.js'
import { enrichCatalog } from '../catalog/models/enrich.js'
import {
  CatalogQuerySchema,
  type Connector,
  type ConnectorSource,
} from '../../connector/schema.js'
import type { ConnectorRegistry } from '../../connector/registry.js'
import { featuredComposioSlugSet } from '../../connector/composio/featured.js'
import { getFeaturedServers } from '../../connector/mcp/featured.js'

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
//
// T21 (2026-04-22): the legacy `toolCatalogHandler` (GET /tools/catalog)
// was removed. The client now reads built-in tool metadata via
// GET /catalog?source=builtin and flattens the grouped Connector.actions
// array — each action carries its `isReadOnly` + `requiresPermission`
// flags directly.

// ---------------------------------------------------------------------------
// GET /api/v1/catalog (T01)
// ---------------------------------------------------------------------------
//
// Unified discovery endpoint for the client's "Add Tool" modal. Reuses the
// existing `ConnectorRegistry` (so built-in + MCP + Composio + custom
// MCP all flow through one aggregation path), then layers `?source`,
// `?featured`, and `?q` filters on top. Adds an ETag so a 1000-entry
// Composio catalog response can 304 on the second hit.
//
// **Why a separate endpoint from `/api/v1/connectors`?** They serve
// adjacent but distinct UX needs:
//   - `/connectors[?profileId=...]` powers the Tools lobby + per-profile
//     status reads. Defaults Composio to featured-only because the
//     lobby is dense.
//   - `/catalog` powers the discovery modal. Defaults to NOT featured-
//     only (`featured` defaults to `false`) because the user explicitly
//     invited the modal to surface the long tail. Same registry,
//     different opinionated defaults.
//
// Per T01 acceptance: query params are Zod-validated; bad params → 400.
// ETag computed as a stable hash of the response payload (sorted-keys
// JSON) so an unchanged catalog returns the same hash even when the
// underlying registry runs a fresh aggregation.

export interface CatalogHandlerDeps {
  readonly registry: ConnectorRegistry
}

const FEATURED_MCP_IDS_CACHE: { value: ReadonlySet<string> | null } = {
  value: null,
}

/**
 * Lazy-init set of MCP server ids in the curated featured catalog.
 * Static at runtime (it's compile-time data), but keeping it lazy
 * avoids an import-time cost when the catalog handler isn't reached.
 */
function featuredMCPIdSet(): ReadonlySet<string> {
  if (FEATURED_MCP_IDS_CACHE.value) return FEATURED_MCP_IDS_CACHE.value
  const set = new Set(getFeaturedServers().map((s) => s.id))
  FEATURED_MCP_IDS_CACHE.value = set
  return set
}

/**
 * Decide whether a connector is "featured" for the catalog filter.
 * Featured-ness is source-specific:
 *   - `builtin` — every built-in is featured (it ships with the kernel).
 *   - `mcp` — id appears in the curated `getFeaturedServers()` list.
 *   - `composio` — slug appears in `featuredComposioSlugSet()`.
 *   - `custom_mcp` — never featured (user-installed by definition).
 */
function isFeatured(c: Connector): boolean {
  switch (c.source) {
    case 'builtin':
      return true
    case 'mcp':
      // Featured iff the id appears in the curated list. User-registered
      // entries (now also `source: 'mcp'` post-Phase 16) won't match,
      // which is the correct behaviour — they're user-owned, not curated.
      return featuredMCPIdSet().has(c.id)
    case 'composio':
      return featuredComposioSlugSet().has(c.id)
  }
}

/**
 * Substring match on `name` + `id` + `canonicalId`, case-insensitive.
 * Cheap; the catalog is at most a few thousand rows. If perf ever
 * matters, this is the place to add a trigram index — but the
 * keystroke-debounce on the client side (T16) means we get at most
 * one call per 250ms in practice.
 */
function matchesQuery(c: Connector, q: string): boolean {
  const needle = q.toLowerCase()
  return (
    c.name.toLowerCase().includes(needle) ||
    c.id.toLowerCase().includes(needle) ||
    c.canonicalId.toLowerCase().includes(needle)
  )
}

/**
 * Recursively sort object keys so structurally-equal payloads hash to
 * the same value regardless of key insertion order.
 *
 * NOTE: a replacer-array form of `JSON.stringify(payload, keys)` is NOT
 * equivalent — the array is an allowlist applied at every depth, which
 * serialized each nested connector as `{}` and made the ETag depend on
 * the item count alone (two different catalogs with the same length
 * collided, and content changes never invalidated caches).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/**
 * Compute a stable ETag for the response. Uses sorted-keys JSON so two
 * structurally-equal payloads with different key insertion orders
 * still hash to the same value. Quoted per RFC 7232 §2.3.
 */
function computeETag(payload: unknown): string {
  const hash = createHash('sha1')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex')
    .slice(0, 16)
  return `"${hash}"`
}

export function createCatalogHandler(deps: CatalogHandlerDeps) {
  return async function catalogHandler(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    )
    // Parse + Zod-validate query params. `featured` is a tri-state
    // string → boolean; `source` is the enum; `q` is free text.
    const rawSource = url.searchParams.get('source')
    const rawFeatured = url.searchParams.get('featured')
    const rawQ = url.searchParams.get('q')

    let featured: boolean | undefined
    if (rawFeatured === null || rawFeatured.length === 0) {
      featured = undefined
    } else if (rawFeatured.toLowerCase() === 'true') {
      featured = true
    } else if (rawFeatured.toLowerCase() === 'false') {
      featured = false
    } else {
      sendError(
        res,
        400,
        'Invalid query params: featured must be "true" or "false".',
      )
      return
    }

    const raw = {
      source: rawSource && rawSource.length > 0 ? rawSource : undefined,
      featured,
      q: rawQ && rawQ.length > 0 ? rawQ : undefined,
    }
    const parsed = CatalogQuerySchema.safeParse(raw)
    if (!parsed.success) {
      sendError(res, 400, `Invalid query params: ${parsed.error.message}`)
      return
    }

    let list: readonly Connector[]
    try {
      list = await deps.registry.list()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      sendError(res, 500, `Failed to list catalog: ${message}`)
      return
    }

    const wantSource: ConnectorSource | undefined = parsed.data.source
    // Default `featured` to `false` for the catalog (show everything).
    // Opposite of `/connectors`, where the lobby defaults featured=true.
    const wantFeatured = parsed.data.featured ?? false
    const wantQ = parsed.data.q

    const filtered = list.filter((c) => {
      if (wantSource && c.source !== wantSource) return false
      if (wantFeatured && !isFeatured(c)) return false
      if (wantQ && !matchesQuery(c, wantQ)) return false
      return true
    })

    const payload = { items: filtered }
    const etag = computeETag(payload)

    // Conditional GET: honor `If-None-Match` so the client's React Query
    // cache + browser cache can both 304 the response when the catalog
    // hasn't shifted underneath them.
    const ifNoneMatch = req.headers['if-none-match']
    if (typeof ifNoneMatch === 'string' && ifNoneMatch === etag) {
      res.writeHead(304, { ETag: etag })
      res.end()
      return
    }

    res.setHeader('ETag', etag)
    sendJSON(res, 200, payload)
  }
}

// GET /api/v1/models — annotate every curated model with
// `hasCredentials` derived from the unified credentials store. UI greys
// out models whose provider has no saved key.

interface ModelCatalogHandlerDeps {
  /** Returns the set of provider IDs that currently have a saved key. */
  readonly listConfiguredProviders: () => Promise<readonly string[]>
}

export function createModelCatalogHandler(deps: ModelCatalogHandlerDeps) {
  return async function modelCatalogHandler(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const configured = new Set(await deps.listConfiguredProviders())
    // Overlay live context/output/pricing facts from the model snapshots
    // (models.dev + OpenRouter) before annotating credential state. The
    // snapshot is the source of truth for objective numbers; the catalog's
    // hand-typed values are only a fallback for un-synced models.
    const models: ModelInfo[] = enrichCatalog(ALL_MODELS).map((m) => ({
      ...m,
      hasCredentials: configured.has(m.provider),
    }))
    sendJSON(res, 200, models)
  }
}
