/**
 * Known-apps catalog reader.
 *
 * `known-apps.json` is the source of truth for friendly app metadata
 * (`name`, `category`, `via`, `mcpInstall` recipe). It lives at
 * `src/connector/detection/known-apps.json` and is copied into dist by
 * the build. Cortex reads it to resolve detected MCP servers and
 * auto-registered rows to their proper category and display name.
 *
 * Split out from `connector/detection/auto-register.ts` so it can be
 * consumed by the connector registry's read path
 * (`mcpServerToConnector`, `customRowToConnector`) without pulling in
 * the whole detection module.
 *
 * The lookup keys are the **logical app slug** (the part after `mcp:`
 * or `composio:` in the entry's `via` field). For example
 * `via: "mcp:figma"` → indexed under key `figma`. This aligns with the
 * `Connector.logicalKey` field, so downstream code can do a single
 * synchronous lookup once the catalog is loaded.
 *
 * Loading is async (file I/O) but cached on first hit. Callers that
 * need the data inside synchronous code paths should call
 * `prefetchKnownApps()` once at boot and then `lookupKnownAppByLogicalKey`
 * synchronously thereafter.
 */

import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const KnownAppCategorySchema = z.enum([
  'design',
  'communication',
  'productivity',
  'dev-tools',
  'browser',
  'security',
  'media',
  'data',
  'research',
  'finance',
  'ai',
  'cloud',
  'other',
])
export type KnownAppCategory = z.infer<typeof KnownAppCategorySchema>

const KnownAppMCPInstallSchema = z.object({
  runtime: z.enum(['npx', 'uvx']).optional(),
  package: z.string().optional(),
  transport: z.enum(['http', 'sse']).optional(),
  url: z.string().optional(),
  args: z.array(z.string()).optional(),
  authType: z.enum(['none', 'api-key', 'oauth2']),
})

const KnownAppEntrySchema = z.object({
  name: z.string().min(1),
  via: z.string().min(1),
  category: KnownAppCategorySchema,
  mcpInstall: KnownAppMCPInstallSchema.optional(),
})
export type KnownAppEntry = z.infer<typeof KnownAppEntrySchema>

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- exported via type for future strict-parse callers
const _KnownAppsFileSchema = z.record(z.string(), KnownAppEntrySchema)
void _KnownAppsFileSchema

/**
 * Two indices keyed differently:
 *   - `byPlatformId`: bundle ID → entry. Used by detection (Spotlight).
 *   - `byLogicalKey`: slug from `via` (after the source prefix) → entry.
 *     Used by the connector registry to resolve category at read time.
 *
 * Built together at first load; both are populated atomically.
 */
interface KnownAppsIndex {
  readonly byPlatformId: ReadonlyMap<string, KnownAppEntry>
  readonly byLogicalKey: ReadonlyMap<string, KnownAppEntry>
}

let _cache: KnownAppsIndex | null = null
let _loadPromise: Promise<KnownAppsIndex> | null = null

/**
 * Search path: the cortex-internal catalog copy, shipped alongside the
 * compiled module (the build copies `src/connector/detection/known-apps.json`
 * into dist).
 */
function resolveSearchPaths(): readonly string[] {
  const thisDir = dirname(fileURLToPath(import.meta.url))
  return [join(thisDir, 'detection', 'known-apps.json')]
}

async function readKnownAppsFile(): Promise<Record<string, unknown>> {
  for (const path of resolveSearchPaths()) {
    try {
      const raw = await readFile(path, 'utf-8')
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      continue
    }
  }
  return {}
}

function buildIndex(rawEntries: Record<string, unknown>): KnownAppsIndex {
  const byPlatformId = new Map<string, KnownAppEntry>()
  const byLogicalKey = new Map<string, KnownAppEntry>()
  for (const [platformId, raw] of Object.entries(rawEntries)) {
    const parsed = KnownAppEntrySchema.safeParse(raw)
    if (!parsed.success) continue
    const entry = parsed.data
    byPlatformId.set(platformId, entry)
    // Extract slug from `via`. Format: `<source>:<slug>`. Split on first `:`.
    const colon = entry.via.indexOf(':')
    if (colon > 0 && colon < entry.via.length - 1) {
      const slug = entry.via.slice(colon + 1)
      // Don't overwrite if two platformIds map to the same slug; first
      // entry wins (deterministic given file order). This shouldn't happen
      // in practice — known-apps.json keys should be globally unique.
      if (!byLogicalKey.has(slug)) {
        byLogicalKey.set(slug, entry)
      }
    }
  }
  return { byPlatformId, byLogicalKey }
}

/**
 * Load and cache the known-apps index. Idempotent; concurrent calls
 * share the same in-flight promise.
 */
export async function loadKnownApps(): Promise<KnownAppsIndex> {
  if (_cache) return _cache
  if (_loadPromise) return _loadPromise
  _loadPromise = (async () => {
    const raw = await readKnownAppsFile()
    const index = buildIndex(raw)
    _cache = index
    return index
  })()
  return _loadPromise
}

/**
 * Synchronous lookup by logical key (slug). Returns null if the catalog
 * hasn't been loaded yet OR if the slug is unknown. Callers that need a
 * guaranteed lookup should `await loadKnownApps()` first.
 */
export function lookupKnownAppByLogicalKey(logicalKey: string): KnownAppEntry | null {
  if (!_cache) return null
  return _cache.byLogicalKey.get(logicalKey) ?? null
}

/**
 * Synchronous lookup by platform id (e.g. macOS bundle id). Returns null
 * when not loaded or unknown.
 */
export function lookupKnownAppByPlatformId(
  platformId: string,
): KnownAppEntry | null {
  if (!_cache) return null
  return _cache.byPlatformId.get(platformId) ?? null
}

/**
 * Test-only: reset the cache so a subsequent `loadKnownApps()` re-reads
 * the file. The cortex production code never resets.
 */
export function __resetKnownAppsCacheForTests(): void {
  _cache = null
  _loadPromise = null
}

/**
 * Map a `KnownAppCategory` (the strings used in `known-apps.json`) onto
 * the `ConnectorCategory` enum used by the connector schema. The enums
 * are aligned today (every value matches), but having an explicit
 * mapper means an enum drift fails at compile time rather than silently.
 */
import type { ConnectorCategory } from './schema.js'
export function knownAppCategoryToConnectorCategory(
  c: KnownAppCategory,
): ConnectorCategory {
  switch (c) {
    case 'design':
    case 'communication':
    case 'productivity':
    case 'dev-tools':
    case 'browser':
    case 'security':
    case 'media':
    case 'data':
    case 'research':
    case 'finance':
    case 'ai':
    case 'cloud':
    case 'other':
      return c
  }
}

// ---------------------------------------------------------------------------
// Strict catalog validator (CI-enforced)
// ---------------------------------------------------------------------------

import { FEATURED_SERVERS } from './mcp/featured.js'
import { FEATURED_COMPOSIO_TOOLKITS } from './composio/featured.js'

/**
 * One reason a known-apps row failed validation. Aggregated by
 * `validateKnownAppsCatalog()` so callers can report every problem in
 * a single failure rather than fix-and-retry one at a time.
 */
export interface KnownAppValidationFailure {
  /** The platform id key (e.g. `com.figma.Desktop`). */
  readonly platformId: string
  /** Human-readable reason — safe to print directly in CI output. */
  readonly reason: string
}

/**
 * Strictly validate the entire known-apps catalog. The standard
 * `loadKnownApps()` reader silently skips malformed rows; this
 * function reports every failure so the CI test fails loudly.
 *
 * Two layers of validation:
 *   1. Structural — every row must satisfy `KnownAppEntrySchema`.
 *   2. Cross-reference — every `via` (e.g. `mcp:figma`) must resolve
 *      to a real entry in either `FEATURED_SERVERS` (mcp:) or
 *      `FEATURED_COMPOSIO_TOOLKITS` (composio:).
 *
 * The cross-reference check is what stops the catalog drifting:
 * without it, a known-apps row pointing at a culled connector would
 * silently surface in the UI as a "Connect →" card that has nothing
 * to connect to.
 *
 * Returns an empty array when the catalog is valid; non-empty array
 * (length === number of failed rows) otherwise.
 */
export async function validateKnownAppsCatalog(): Promise<readonly KnownAppValidationFailure[]> {
  const raw = await readKnownAppsFile()
  const failures: KnownAppValidationFailure[] = []

  const featuredMcpIds = new Set(FEATURED_SERVERS.map(s => s.id))
  const featuredComposioSlugs = new Set(FEATURED_COMPOSIO_TOOLKITS.map(t => t.slug))

  for (const [platformId, rowRaw] of Object.entries(raw)) {
    // Layer 1: structural validation.
    const parsed = KnownAppEntrySchema.safeParse(rowRaw)
    if (!parsed.success) {
      failures.push({
        platformId,
        reason: `structural validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      })
      continue
    }

    // Layer 2: cross-reference `via` → real catalog entry.
    const entry = parsed.data
    const colon = entry.via.indexOf(':')
    if (colon <= 0 || colon >= entry.via.length - 1) {
      failures.push({
        platformId,
        reason: `via '${entry.via}' is not in '<source>:<id>' format`,
      })
      continue
    }
    const source = entry.via.slice(0, colon)
    const slug = entry.via.slice(colon + 1)

    if (source === 'mcp') {
      if (!featuredMcpIds.has(slug)) {
        failures.push({
          platformId,
          reason: `via '${entry.via}' points at MCP id '${slug}' which is not in FEATURED_SERVERS. Either add the entry to mcp/featured.ts or remove this row.`,
        })
      }
    } else if (source === 'composio') {
      if (!featuredComposioSlugs.has(slug)) {
        failures.push({
          platformId,
          reason: `via '${entry.via}' points at Composio slug '${slug}' which is not in FEATURED_COMPOSIO_TOOLKITS. Composio is dropped from Tier 1 — drop this row, or move it behind the future Advanced → BYO-Composio surface.`,
        })
      }
    } else {
      failures.push({
        platformId,
        reason: `via '${entry.via}' has unknown source '${source}'. Allowed sources: 'mcp', 'composio'.`,
      })
    }
  }

  return failures
}
