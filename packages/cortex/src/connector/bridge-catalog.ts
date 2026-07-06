/**
 * Bridge catalog reader.
 *
 * Local apps (Paper, Pencil, Figma desktop, …) host an MCP server on
 * `127.0.0.1:<port>` and announce themselves by writing a small JSON
 * manifest under `~/.ownware/bridges/<id>.json`. This module exposes a
 * read-only view of those manifests as `FeaturedMCPServer` records so
 * the rest of Cortex sees one shape regardless of source (static
 * featured catalog, dynamic bridges, user overlay).
 *
 * **Read-only by design.** This module never writes to the bridges
 * directory — the apps themselves own the manifests. Cortex just reads
 * what they declare.
 *
 * Added 2026-05-01 (Milestone B Phase 8 — connector architecture
 * unification). Replaces the legacy
 * `auto-register.ts → mcp_servers (registryId='detected')` write path
 * that's being removed in Phase 11.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { watch as watchFs, type FSWatcher } from 'node:fs'

import type { FeaturedMCPServer, FeaturedCategory } from './mcp/featured.js'
import { setBridgeCache } from './mcp/featured.js'
import { DEFAULT_DATA_DIR_NAME } from '../constants.js'

// ---------------------------------------------------------------------------
// Manifest shape on disk (defensive — accept what apps write today)
// ---------------------------------------------------------------------------

/**
 * Shape of a `~/.ownware/bridges/<id>.json` file.
 *
 * Required: `name`, `transport.url`. Other fields surface optional
 * metadata that improves the UX but isn't load-bearing — bridges with
 * just `name` + `transport.url` still appear in the catalog.
 */
interface BridgeManifest {
  readonly name?: string
  readonly description?: string
  readonly category?: string
  readonly icon?: string
  readonly bundleId?: string
  readonly transport?: {
    readonly type?: string
    readonly url?: string
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BridgeCatalogOptions {
  /** Override `~/.ownware/bridges`. Used by tests. */
  readonly bridgesDir?: string
}

/**
 * Scan the bridges directory and return every well-formed manifest as
 * a `FeaturedMCPServer` with `transport.kind === 'http_bridge'`.
 *
 * - Missing directory → empty array (apps haven't registered any bridges yet).
 * - Malformed JSON → skipped with a `console.warn` log line; never throws.
 * - Manifest missing `name` or `transport.url` → skipped with a warning.
 *
 * Idempotent: callers can poll this freely. The result is always a fresh
 * snapshot of disk state.
 */
export async function readBridgeCatalog(
  opts: BridgeCatalogOptions = {},
): Promise<FeaturedMCPServer[]> {
  const dir = opts.bridgesDir ?? defaultBridgesDir()

  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  const out: FeaturedMCPServer[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const path = join(dir, file)
    let raw: string
    try {
      raw = await readFile(path, 'utf-8')
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.warn(`[bridge-catalog] skipping malformed JSON: ${path}`)
      continue
    }
    const entry = manifestToFeatured(parsed, file)
    if (entry !== null) out.push(entry)
  }
  return out
}

/**
 * Watch the bridges directory and invoke `onChange` whenever a manifest
 * is added, removed, or modified. Returns a teardown function.
 *
 * Quiet guarantees:
 * - Throws nothing on directory absence — sets up no watcher in that case.
 *   The caller can call `readBridgeCatalog` periodically as a fallback.
 * - Coalesces fs events with a small debounce so a save-with-multiple-
 *   writes doesn't fire `onChange` ten times.
 */
export function watchBridgeCatalog(
  onChange: () => void,
  opts: BridgeCatalogOptions = {},
): () => void {
  const dir = opts.bridgesDir ?? defaultBridgesDir()
  let watcher: FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null

  // Set up watcher only if the dir exists. On failure (ENOENT, EACCES)
  // we silently no-op — the catalog is still readable, just not push-fresh.
  void stat(dir).then(
    () => {
      try {
        watcher = watchFs(dir, { persistent: false }, () => {
          if (timer !== null) clearTimeout(timer)
          timer = setTimeout(() => {
            timer = null
            onChange()
          }, 50)
        })
      } catch {
        // EPERM / ENOTDIR — no-op
      }
    },
    () => {
      // Directory absent — no watcher to set up.
    },
  )

  return () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (watcher !== null) {
      watcher.close()
      watcher = null
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultBridgesDir(): string {
  return join(homedir(), DEFAULT_DATA_DIR_NAME, 'bridges')
}

const BRIDGE_FEATURED_CATEGORIES: ReadonlySet<FeaturedCategory> = new Set([
  'dev-tools',
  'data',
  'communication',
  'browser',
  'productivity',
  'ai',
  'finance',
  'research',
  'social',
  'design',
  'media',
  'security',
])

function manifestToFeatured(
  parsed: unknown,
  fileName: string,
): FeaturedMCPServer | null {
  if (parsed === null || typeof parsed !== 'object') return null
  const m = parsed as BridgeManifest
  const name = typeof m.name === 'string' ? m.name : null
  const url = typeof m.transport?.url === 'string' ? m.transport.url : null
  if (name == null || url == null) {
    console.warn(`[bridge-catalog] skipping ${fileName}: missing name or transport.url`)
    return null
  }
  const bridgeId = basename(fileName, '.json')
  const category: FeaturedCategory =
    typeof m.category === 'string' && (BRIDGE_FEATURED_CATEGORIES as Set<string>).has(m.category)
      ? (m.category as FeaturedCategory)
      : 'productivity'

  return {
    id: bridgeId,
    title: name,
    description: typeof m.description === 'string' && m.description.length > 0
      ? m.description
      : `${name} (local bridge — runs while the app is open).`,
    category,
    transport: { kind: 'http_bridge', bridgeId },
    requiredEnv: [],
    repository: '',
    icon: typeof m.icon === 'string' ? m.icon : '',
    authType: 'none',
  }
}

/**
 * Convenience: re-read disk + push the result into the in-memory cache
 * exposed via `featured.ts:setBridgeCache`. Idempotent. Errors are
 * swallowed (the catalog stays at its previous state on transient
 * read failures).
 *
 * Gateway boot calls this once + sets up `watchBridgeCatalog` with this
 * function as the change handler. Tests can call it directly to seed
 * the cache from a fixture directory.
 */
export async function refreshBridgeCache(opts: BridgeCatalogOptions = {}): Promise<void> {
  try {
    const entries = await readBridgeCatalog(opts)
    setBridgeCache(entries)
  } catch (err) {
    console.warn('[bridge-catalog] refresh failed:', err instanceof Error ? err.message : err)
  }
}

// ---------------------------------------------------------------------------
// Reachability ping (Phase 10)
// ---------------------------------------------------------------------------

interface PingCacheEntry {
  readonly reachable: boolean
  readonly at: number
}

const PING_TTL_MS = 60_000
const PING_TIMEOUT_MS = 500
const _pingCache = new Map<string, PingCacheEntry>()

/**
 * Visible-for-tests: clear the in-memory ping cache so each test
 * exercises a fresh probe.
 */
export function _resetBridgePingCacheForTests(): void {
  _pingCache.clear()
}

/**
 * Best-effort reachability check for a bridge id. Resolves the bridge's
 * URL from disk, fires a HEAD with a short timeout, and caches the
 * outcome for 60 s. Returns `false` for absent bridges, missing URLs,
 * timeouts, ECONNREFUSED, or any non-2xx-non-405 response. (`405 Method
 * Not Allowed` is treated as reachable — many MCP servers reject HEAD
 * but the socket clearly accepted the connection.)
 *
 * Used by the registry mapper to populate `bridgeReachable` when
 * computing status for a `http_bridge` connector. Never throws.
 */
export async function pingBridge(
  bridgeId: string,
  opts: BridgeCatalogOptions = {},
): Promise<boolean> {
  const cached = _pingCache.get(bridgeId)
  if (cached && Date.now() - cached.at < PING_TTL_MS) {
    return cached.reachable
  }
  const url = await resolveBridgeUrl(bridgeId, opts)
  if (url == null) {
    _pingCache.set(bridgeId, { reachable: false, at: Date.now() })
    return false
  }
  const reachable = await probeUrl(url)
  _pingCache.set(bridgeId, { reachable, at: Date.now() })
  return reachable
}

async function probeUrl(url: string): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS)
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal })
    // 2xx or 405 (Method Not Allowed) — the socket is alive.
    return (res.status >= 200 && res.status < 300) || res.status === 405
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve a bridge id to its current 127.0.0.1 URL. Used by the spawn /
 * connect path to translate a `http_bridge` transport into a concrete
 * `http_remote` shape at call time. Returns `null` if the bridge file
 * is absent or malformed (the local app isn't running).
 */
export async function resolveBridgeUrl(
  bridgeId: string,
  opts: BridgeCatalogOptions = {},
): Promise<string | null> {
  const dir = opts.bridgesDir ?? defaultBridgesDir()
  const path = join(dir, `${bridgeId}.json`)
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as BridgeManifest
    const url = parsed.transport?.url
    return typeof url === 'string' ? url : null
  } catch {
    return null
  }
}
