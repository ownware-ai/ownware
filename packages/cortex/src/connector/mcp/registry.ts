/**
 * MCP Registry Client
 *
 * Fetches the official MCP server registry at registry.modelcontextprotocol.io.
 * Caches results for 1 hour with two layers:
 *   1. In-process memory (lost on restart).
 *   2. Disk: `~/.ownware/mcp-registry-cache.json` (survives restarts).
 *
 * On a cold start the disk cache loads first; only when both layers
 * are stale OR empty do we hit the network. Network failures (429,
 * 5xx, timeouts) fall back to whatever cache we have — better stale
 * data than an empty list — and the in-flight fetch is deduped via
 * singleflight so concurrent callers share one network round-trip.
 *
 * No API key needed — fully public, but the upstream rate-limits
 * aggressive paginated fetches.
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MCPRegistryEntry, MCPEnvVar, MCPCategory } from '../types.js'
import { DEFAULT_DATA_DIR_NAME } from '../../constants.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers'
const PAGE_SIZE = 96
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
/**
 * Runaway backstop for the paginated walk. The public registry passed
 * 12k servers in mid-2026 and keeps growing — without a ceiling a cold
 * fetch is unbounded in time. 200 pages ≈ 19k servers; hitting the cap
 * returns a partial catalog (cached with the short retry TTL below).
 */
const MAX_PAGES = 200
/** One in-walk retry per failed page, after this pause. */
const PAGE_RETRY_DELAY_MS = 2_000
/** A partial catalog re-fetches this soon instead of waiting a full TTL. */
const PARTIAL_RETRY_MS = 5 * 60 * 1000

/**
 * Disk cache location. Lives next to the credentials/bridges
 * directories the rest of cortex uses. Override via the
 * `OWNWARE_REGISTRY_CACHE_PATH` env var for tests / multi-tenant
 * setups where the default `~/.ownware` isn't appropriate.
 */
function diskCachePath(): string {
  const override = process.env['OWNWARE_REGISTRY_CACHE_PATH']
  if (override != null && override.length > 0) return override
  return join(homedir(), DEFAULT_DATA_DIR_NAME, 'mcp-registry-cache.json')
}

/** On-disk shape. Versioned so future format changes can migrate cleanly. */
interface DiskCache {
  readonly version: 1
  readonly timestamp: number
  readonly entries: readonly MCPRegistryEntry[]
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cachedEntries: MCPRegistryEntry[] | null = null
let cacheTimestamp = 0
/** False when the cached catalog is a partial walk (page failure / cap). */
let cacheComplete = true
let diskLoadAttempted = false

/**
 * Singleflight: when one fetch is in flight, every subsequent
 * caller awaits the same promise instead of firing its own request.
 * Without this, the dev hot-reload would launch 6 parallel
 * registry fetches the moment the gateway restarted (one per
 * source provider call site) and instantly hit the upstream's 429
 * rate limit. Cleared in `finally` so a failed fetch doesn't
 * lock out future retries.
 */
let inFlightFetch: Promise<MCPRegistryEntry[]> | null = null

// ---------------------------------------------------------------------------
// Disk cache I/O
// ---------------------------------------------------------------------------

async function readDiskCache(): Promise<DiskCache | null> {
  try {
    const raw = await fs.readFile(diskCachePath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      (parsed as DiskCache).version === 1 &&
      Array.isArray((parsed as DiskCache).entries) &&
      typeof (parsed as DiskCache).timestamp === 'number'
    ) {
      return parsed as DiskCache
    }
    return null
  } catch {
    // Missing file, permission error, corrupt JSON — start fresh.
    return null
  }
}

async function writeDiskCache(
  entries: readonly MCPRegistryEntry[],
  timestamp = Date.now(),
): Promise<void> {
  try {
    const path = diskCachePath()
    await fs.mkdir(dirname(path), { recursive: true })
    const payload: DiskCache = { version: 1, timestamp, entries }
    await fs.writeFile(path, JSON.stringify(payload), 'utf8')
  } catch (err) {
    // Cache writes are best-effort. A read-only home dir or full
    // disk shouldn't break catalog search; warn once and move on.
    console.warn(
      `[connector] MCP registry disk-cache write failed (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

/**
 * Lazy one-time disk load. Runs at most once per process: if the
 * file exists and parses, hydrate the in-memory cache from it.
 * Subsequent calls are a no-op (the in-memory cache takes over).
 */
async function ensureDiskCacheLoaded(): Promise<void> {
  if (diskLoadAttempted) return
  diskLoadAttempted = true
  if (cachedEntries !== null) return
  const disk = await readDiskCache()
  if (disk !== null) {
    cachedEntries = [...disk.entries]
    cacheTimestamp = disk.timestamp
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all MCP servers from the official registry.
 *
 * Cache layers (consulted in order):
 *   1. In-memory (fresh) → return immediately
 *   2. Disk (lazy first-call hydrate) → populates in-memory if fresh
 *   3. Network → on success, update both layers
 *   4. **Stale fallback**: on network failure, return whichever
 *      layer has data, even if past TTL. Better stale than empty.
 *
 * `search` is a server-side filter passthrough; results are not
 * cached because the cache is keyed on "the full catalog only."
 */
export async function fetchMCPRegistry(options?: {
  search?: string
  forceRefresh?: boolean
}): Promise<MCPRegistryEntry[]> {
  // Search queries don't share the unfiltered cache. They go
  // straight to the network without singleflight (concurrent
  // searches are rare in practice).
  if (options?.search != null && options.search.length > 0) {
    return (await fetchFromNetwork(options.search)).entries
  }

  await ensureDiskCacheLoaded()

  const now = Date.now()
  const isFresh =
    cachedEntries !== null && now - cacheTimestamp < CACHE_TTL_MS

  if (!options?.forceRefresh && isFresh) {
    return cachedEntries!
  }

  // Singleflight — coalesce concurrent fetches.
  if (inFlightFetch !== null) {
    return inFlightFetch
  }

  inFlightFetch = (async () => {
    try {
      const { entries: fresh, complete } = await fetchFromNetwork(undefined)
      cachedEntries = fresh
      cacheComplete = complete
      // A partial catalog back-dates its timestamp so the next call
      // after PARTIAL_RETRY_MS re-fetches, instead of serving a
      // truncated list for a full TTL hour.
      cacheTimestamp = complete
        ? Date.now()
        : Date.now() - CACHE_TTL_MS + PARTIAL_RETRY_MS
      // Best-effort disk write; awaited so a same-process restart
      // immediately after a fetch sees the new data. The adjusted
      // timestamp rides along, so restarts honor the early retry too.
      await writeDiskCache(fresh, cacheTimestamp)
      return fresh
    } catch (err) {
      // Network failure (429, timeout, DNS, …). If we have cached
      // entries (fresh or stale), serve them. The user gets the
      // last-known catalog instead of an empty list, which is
      // dramatically better UX during transient registry outages.
      // Cold start with no cache: re-throw so the caller can
      // handle the empty path explicitly (the source provider
      // returns []).
      const msg = err instanceof Error ? err.message : String(err)
      if (cachedEntries !== null) {
        console.warn(
          `[connector] MCP registry refresh failed; serving stale cache (${cachedEntries.length} entries): ${msg}`,
        )
        return cachedEntries
      }
      throw err
    } finally {
      inFlightFetch = null
    }
  })()

  return inFlightFetch
}

/**
 * Bounded, resilient paginated fetch.
 *
 * The registry outgrew all-or-nothing walking: 12k+ servers means a
 * cold walk takes minutes, and under the old behaviour ONE failed page
 * threw away every page already fetched. Now:
 *   - each page gets one retry (after a short pause) before giving up;
 *   - a mid-walk failure RETURNS what was gathered (`complete: false`)
 *     instead of throwing — partial catalog beats empty catalog;
 *   - `MAX_PAGES` caps runaway walks as the registry keeps growing.
 * Throws only when the FIRST page fails (nothing gathered — caller
 * falls back to stale cache or surfaces the error).
 */
async function fetchFromNetwork(
  search: string | undefined,
): Promise<{ entries: MCPRegistryEntry[]; complete: boolean }> {
  const entries: MCPRegistryEntry[] = []
  let cursor: string | undefined
  let pages = 0

  const fetchPage = async (): Promise<RegistryResponse> => {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      version: 'latest',
    })
    if (cursor) params.set('cursor', cursor)
    if (search) params.set('search', search)
    const response = await fetch(`${REGISTRY_URL}?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      throw new Error(`MCP registry returned ${response.status}: ${response.statusText}`)
    }
    return await response.json() as RegistryResponse
  }

  do {
    let data: RegistryResponse
    try {
      data = await fetchPage()
    } catch (firstErr) {
      // One retry per page — a single blip shouldn't cost the walk.
      await new Promise((r) => setTimeout(r, PAGE_RETRY_DELAY_MS))
      try {
        data = await fetchPage()
      } catch (retryErr) {
        if (entries.length === 0) throw retryErr
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr)
        console.warn(
          `[connector] MCP registry walk stopped at page ${pages + 1} (${msg}); ` +
            `keeping the ${entries.length} entries fetched so far`,
        )
        return { entries, complete: false }
      }
      void firstErr
    }

    for (const wrapper of data.servers ?? []) {
      // API returns { server: {...}, _meta: {...} } per entry
      const server = wrapper.server ?? wrapper
      const entry = mapRegistryEntry(server as RawRegistryServer)
      if (entry) entries.push(entry)
    }

    cursor = data.metadata?.nextCursor ?? undefined
    pages++
    if (cursor && pages >= MAX_PAGES) {
      console.warn(
        `[connector] MCP registry walk hit the ${MAX_PAGES}-page cap with more ` +
          `pages remaining; returning the ${entries.length} entries fetched (partial)`,
      )
      return { entries, complete: false }
    }
  } while (cursor)

  return { entries, complete: true }
}

/**
 * Get a single registry entry by ID (e.g. `ai.waystation/gmail`).
 *
 * Never triggers a full catalog walk: an id lookup is served from any
 * cached catalog first (fresh OR stale — identity doesn't rot), and on
 * a miss falls to ONE targeted server-side `?search=` fetch matched
 * exactly client-side. Before this, resolving a single id on a cold
 * cache paid the entire multi-minute 12k-server walk.
 */
export async function getRegistryEntry(id: string): Promise<MCPRegistryEntry | null> {
  await ensureDiskCacheLoaded()

  if (cachedEntries !== null) {
    const hit = cachedEntries.find(e => e.id === id)
    if (hit) return hit
    // A fresh, COMPLETE catalog that lacks the id is an authoritative
    // miss. Stale or partial catalogs fall through to the targeted
    // search — the id may exist beyond what we hold.
    const isFresh = Date.now() - cacheTimestamp < CACHE_TTL_MS
    if (isFresh && cacheComplete) return null
  }

  try {
    // Search by the name's last segment — the registry matches
    // substrings of the full `vendor/name`, so this narrows to a
    // handful of candidates; exact-match locally.
    const needle = id.split('/').pop() ?? id
    const { entries } = await fetchFromNetwork(needle)
    return entries.find(e => e.id === id) ?? null
  } catch {
    return null
  }
}

/**
 * Clear the in-process registry cache (does NOT touch disk — call
 * `clearDiskCache()` for that). Used by tests + the gateway's
 * cache-flush endpoint.
 */
export function clearRegistryCache(): void {
  cachedEntries = null
  cacheTimestamp = 0
  cacheComplete = true
  diskLoadAttempted = false
  inFlightFetch = null
}

/**
 * Clear the on-disk cache file. Used by tests and explicit user
 * cache-flush actions. Best-effort: missing file is a no-op.
 */
export async function clearDiskRegistryCache(): Promise<void> {
  try {
    await fs.unlink(diskCachePath())
  } catch {
    // File doesn't exist — nothing to do.
  }
}

// ---------------------------------------------------------------------------
// Registry response types (raw from API)
// ---------------------------------------------------------------------------

interface RegistryResponse {
  servers?: Array<{ server?: RawRegistryServer } & RawRegistryServer>
  metadata?: { nextCursor?: string; count?: number }
}

interface RawRegistryServer {
  name?: string
  title?: string
  description?: string
  version?: string
  icons?: Array<{ url?: string; src?: string }>
  repository?: { url?: string }
  websiteUrl?: string
  packages?: Array<{
    registryType?: string
    identifier?: string
    transport?: string
    runtimeHint?: string
    environmentVariables?: Array<{
      name?: string
      description?: string
      isRequired?: boolean
      isSecret?: boolean
    }>
    packageArguments?: Array<{
      name?: string
      isRequired?: boolean
    }>
  }>
  remotes?: Array<{
    type?: string
    url?: string
  }>
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function mapRegistryEntry(raw: RawRegistryServer): MCPRegistryEntry | null {
  if (!raw.name) return null

  const pkg = raw.packages?.[0]
  const remote = raw.remotes?.[0]

  // Determine transport
  let transport: 'stdio' | 'sse' | 'http' = 'stdio'
  if (pkg?.transport === 'streamable-http' || remote?.type === 'streamable-http') {
    transport = 'http'
  } else if (pkg?.transport === 'sse' || remote?.type === 'sse') {
    transport = 'sse'
  }

  // Parse env vars
  const envVars = (pkg?.environmentVariables ?? []).map((v): MCPEnvVar => ({
    name: v.name ?? '',
    description: v.description ?? '',
    isRequired: v.isRequired ?? false,
    isSecret: v.isSecret ?? false,
  })).filter(v => v.name)

  // Parse package arguments
  const packageArgs = (pkg?.packageArguments ?? [])
    .map(a => a.name ?? '')
    .filter(Boolean)

  return {
    id: raw.name,
    title: raw.title ?? extractDisplayName(raw.name),
    description: raw.description ?? '',
    icon: raw.icons?.[0]?.src ?? raw.icons?.[0]?.url ?? extractGitHubAvatar(raw.repository?.url) ?? null,
    category: inferCategory(raw.name, raw.description ?? ''),
    transport,
    package: pkg?.identifier ?? null,
    runtime: pkg?.runtimeHint ?? null,
    requiredEnv: envVars.filter(v => v.isRequired),
    optionalEnv: envVars.filter(v => !v.isRequired),
    remoteUrl: remote?.url ?? null,
    repository: raw.repository?.url ?? null,
    websiteUrl: raw.websiteUrl ?? null,
    packageArgs,
    version: raw.version ?? '0.0.0',
  }
}

/**
 * Extract a display name from a registry ID.
 * "io.github.user/weather-server" → "Weather Server"
 */
function extractDisplayName(id: string): string {
  const last = id.split('/').pop() ?? id
  return last
    .replace(/[-_]/g, ' ')
    .replace(/\bserver\b/gi, '')
    .replace(/\bmcp\b/gi, '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .trim() || id
}

/**
 * Infer category from server ID and description.
 */
function inferCategory(id: string, desc: string): MCPCategory {
  const text = `${id} ${desc}`.toLowerCase()

  if (/github|gitlab|git\b|bitbucket|code|lint|format/.test(text)) return 'dev-tools'
  if (/slack|discord|email|gmail|teams|telegram|sms/.test(text)) return 'communication'
  if (/postgres|mysql|mongo|redis|sqlite|database|supabase|firebase/.test(text)) return 'data'
  if (/browser|chrome|puppeteer|playwright|selenium|scrape|crawl/.test(text)) return 'browser'
  if (/notion|linear|jira|asana|trello|calendar|gdrive|google\s?drive/.test(text)) return 'productivity'
  if (/openai|anthropic|llm|embedding|vector|ai\b/.test(text)) return 'ai'
  if (/aws|gcp|azure|docker|kubernetes|terraform|cloud/.test(text)) return 'cloud'
  if (/stripe|payment|invoice|accounting|finance/.test(text)) return 'finance'
  return 'other'
}

/**
 * Extract GitHub owner avatar URL from a repository URL.
 * "https://github.com/anthropics/mcp-server" → "https://avatars.githubusercontent.com/anthropics"
 */
function extractGitHubAvatar(repoUrl?: string): string | null {
  if (!repoUrl) return null
  const match = repoUrl.match(/github\.com\/([^/]+)/)
  if (!match) return null
  return `https://avatars.githubusercontent.com/${match[1]}`
}
