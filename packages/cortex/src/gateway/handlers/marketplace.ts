/**
 * Marketplace HTTP handlers — the public surface that lets a UI client
 * preview, install, update, and uninstall community profiles.
 *
 * Production-grade contract:
 *
 *   - Every endpoint validates its body with Zod. Anything else is 400.
 *   - Tokens (PAT / OAuth) come from the `Authorization: <scheme> <token>`
 *     header — NEVER from the request body. Body lands in access logs;
 *     the auth header is redacted by the access-log middleware. Schemes
 *     accepted: `Bearer` (PAT or OAuth access token), `GitHub-Token`
 *     (legacy alias). The handler strips the scheme before forwarding.
 *   - Concurrent installs of the same URL share an in-flight Promise so
 *     a refresh-storm from a flaky network doesn't trigger N parallel
 *     clones.
 *   - Builtin profiles cannot be uninstalled or updated through this
 *     surface. The Phase-2 helpers already enforce this; the handler
 *     surfaces a clean 403 instead of letting the function quietly
 *     return zero affected dirs.
 *   - Index endpoint caches the public registry for 1 hour. Failure to
 *     reach the registry returns a stale-cache result if available, or
 *     a 503 with `Retry-After`.
 *
 * Errors map to HTTP status:
 *   InstallError code → status
 *   ──────────────────────────
 *   invalid_url            → 400
 *   invalid_manifest       → 400
 *   forbidden_custom_code  → 400
 *   path_escape            → 400
 *   oversized              → 413
 *   manifest_not_found     → 404
 *   auth_required          → 401
 *   name_collision         → 409
 *   network                → 502
 *   clone_failed           → 502
 *   profile_load_failed    → 422
 *   unsupported_helper     → 422
 *
 * The body for every error is `{ error: { code, message, detail } }` —
 * the client reads `code` to pick a UI affordance and renders `message` as
 * the headline.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { readJSON, sendError, sendJSON } from '../router.js'
import { sendClassifiedError } from '../../errors/send-classified.js'
import {
  buildPreflight,
  installProfileFromGithub,
  InstallError,
  isInstallError,
  type GithubAuth,
  type Preflight,
  type InstallResult,
} from '../../profile/install/index.js'
import {
  applyProfileUpdate,
  checkProfileUpdate,
  findProfilesForRepo,
  uninstallProfilesForRepo,
  type ApplyUpdateResult,
  type UpdateState,
} from '../../profile/update/index.js'
import type { ProfileRegistry } from '../../profile/registry.js'
import {
  OwnwareBundle,
  type OwnwareBundleEntry,
  type OwnwareBundleDetail,
} from '../../profile/ownware-bundle.js'

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const PreviewBodySchema = z.object({
  url: z.string().min(1).max(512),
  ref: z.string().min(1).max(255).optional(),
}).strict()

const InstallBodySchema = PreviewBodySchema

const ApplyUpdateBodySchema = z.object({
  strategy: z.enum(['overwrite', 'fork', 'keep']),
}).strict()

// ---------------------------------------------------------------------------
// In-flight install / update tracker (idempotency)
// ---------------------------------------------------------------------------

/**
 * Per-URL inflight Promise so a double-click in the UI doesn't trigger
 * two parallel clones into the same target dir. Keyed by `url|ref`.
 *
 * The map is process-local — fine for a desktop deployment, and easy
 * to swap for a Redis-backed lock when the gateway grows multi-process.
 */
class InflightMap<TResult> {
  private readonly map = new Map<string, Promise<TResult>>()

  run(key: string, fn: () => Promise<TResult>): Promise<TResult> {
    const existing = this.map.get(key)
    if (existing !== undefined) return existing
    const promise = fn().finally(() => {
      this.map.delete(key)
    })
    this.map.set(key, promise)
    return promise
  }
}

// ---------------------------------------------------------------------------
// Index cache
// ---------------------------------------------------------------------------

const INDEX_URL = 'https://raw.githubusercontent.com/ownware/profiles-index/main/index.json'
const INDEX_TTL_MS = 60 * 60 * 1000  // 1 hour
const INDEX_FETCH_TIMEOUT_MS = 10_000
const INDEX_MAX_BYTES = 1 * 1024 * 1024  // 1 MB

interface IndexCache {
  body: unknown
  fetchedAt: number
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface MarketplaceHandlerDeps {
  /** Cortex data dir (`~/.ownware` by default). Profiles land at
   *  `<dataDir>/profiles/`. */
  readonly dataDir: string
  /**
   * Profile registry. After a successful install/update/uninstall the
   * handler asks it to re-discover the user dir so the new entries
   * surface to other endpoints (`/api/v1/profiles`) immediately.
   */
  readonly registry: ProfileRegistry
  /** Override `git` binary (test hook). */
  readonly gitBinary?: string
  /**
   * Override the index URL (test hook). Production uses the public
   * `ownware/profiles-index` repo.
   */
  readonly indexUrl?: string
  /**
   * Absolute path to the bundled Ownware marketplace dir. This is the
   * `packages/cortex/profiles/` folder shipped with the app — same dir
   * the registry uses for builtin discovery, but here we ONLY surface
   * profiles classified as `marketplace` in BUILTINS.json.
   *
   * Optional: when omitted the Ownware bundle endpoints return an
   * empty list (graceful for tests + dev environments without the
   * bundle wired). Production gateway always supplies this.
   */
  readonly ownwareBundleDir?: string
  /**
   * Bundle version (commit SHA from the build). Stamped into every
   * sidecar at install time so update detection works after a Cortex
   * release ships a new bundle. Defaults to 'dev' for local builds.
   */
  readonly ownwareBundleVersion?: string
}

export function createMarketplaceHandlers(deps: MarketplaceHandlerDeps): {
  preview: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  install: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  checkUpdate: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>
  applyUpdate: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>
  uninstall: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>
  index: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  ownwareList: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  ownwareDetail: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>
  ownwareInstall: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>
  ownwareUpdate: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>
  ownwareUninstall: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>
} {
  const inflightInstall = new InflightMap<InstallResult>()
  const inflightUpdate = new InflightMap<ApplyUpdateResult>()
  let indexCache: IndexCache | null = null

  const userProfilesDir = deps.dataDir
  const indexUrl = deps.indexUrl ?? INDEX_URL

  // Ownware bundle — null when not wired. Endpoints below return empty
  // / 404 in that case rather than crashing.
  const ownwareBundle = deps.ownwareBundleDir
    ? new OwnwareBundle({
        bundleDir: deps.ownwareBundleDir,
        userDir: join(userProfilesDir, 'profiles'),
        ...(deps.ownwareBundleVersion !== undefined ? { bundleVersion: deps.ownwareBundleVersion } : {}),
      })
    : null

  const refreshRegistry = async (): Promise<void> => {
    try { await deps.registry.discover(join(userProfilesDir, 'profiles'), 'user') } catch (e) {
      console.warn('[marketplace] registry.discover failed:', e)
    }
  }

  /**
   * Drop a list of profile names from the registry's in-memory map after
   * their dirs have been removed from disk. `discover()` only adds — it
   * doesn't reap stale entries — so without this the Profiles tab keeps
   * listing the just-uninstalled profile until the gateway restarts.
   *
   * `removeUser` swallows the rm internally (`force: true` makes it a
   * no-op if the dir is already gone), so calling it after the bundle's
   * own `rm` is safe.
   */
  const dropFromRegistry = async (names: readonly string[]): Promise<void> => {
    for (const name of names) {
      try {
        await deps.registry.removeUser(name)
      } catch (e) {
        // Not fatal — the dir is already gone from disk; the registry
        // either never had it or already removed it.
        console.warn(`[marketplace] dropFromRegistry skipped '${name}':`, e instanceof Error ? e.message : e)
      }
    }
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/marketplace/preview
  // -------------------------------------------------------------------------
  const preview = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJSON(req)
    const parsed = PreviewBodySchema.safeParse(body)
    if (!parsed.success) {
      sendError(res, 400, formatZodIssues(parsed.error))
      return
    }
    const auth = readAuthHeader(req)
    try {
      const preflight: Preflight = await buildPreflight({
        url: parsed.data.url,
        ...(parsed.data.ref !== undefined ? { ref: parsed.data.ref } : {}),
        ...(auth ? { auth } : {}),
      })
      sendJSON(res, 200, { data: preflight })
    } catch (err) {
      sendInstallErrorOrUnknown(res, err)
    }
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/marketplace/install
  // -------------------------------------------------------------------------
  const install = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJSON(req)
    const parsed = InstallBodySchema.safeParse(body)
    if (!parsed.success) {
      sendError(res, 400, formatZodIssues(parsed.error))
      return
    }
    const auth = readAuthHeader(req)
    const inflightKey = `${parsed.data.url}|${parsed.data.ref ?? ''}`
    try {
      const result = await inflightInstall.run(inflightKey, () =>
        installProfileFromGithub({
          url: parsed.data.url,
          dataDir: userProfilesDir,
          ...(parsed.data.ref !== undefined ? { ref: parsed.data.ref } : {}),
          ...(auth ? { auth } : {}),
          ...(deps.gitBinary !== undefined ? { gitBinary: deps.gitBinary } : {}),
        }),
      )
      // Refresh the registry view so the new profiles appear in
      // /api/v1/profiles immediately. Failure is logged but does not
      // fail the install — the profile is on disk; a registry rescan
      // can be triggered later by the client if needed.
      try { await deps.registry.discover(join(userProfilesDir, 'profiles'), 'user') } catch (e) {
        console.warn('[marketplace] registry.discover after install failed:', e)
      }
      sendJSON(res, 201, { data: result })
    } catch (err) {
      sendInstallErrorOrUnknown(res, err)
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/marketplace/repos/:repoId/update
  // -------------------------------------------------------------------------
  const checkUpdate = async (
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> => {
    const repoId = decodeRepoId(params['repoId'])
    if (repoId === null) {
      sendError(res, 400, 'invalid repoId')
      return
    }
    const group = await findProfilesForRepo(userProfilesDir, repoId)
    if (group.length === 0) {
      sendError(res, 404, `no installed profiles for repoId '${repoId}'`)
      return
    }
    // Run check against the first profile in the group — every profile
    // in a group shares the same sidecar repoUrl/ref/commit, so checking
    // any one is sufficient. We pick the first deterministically (sorted
    // by dir name) for stable output across calls.
    const sorted = [...group].sort((a, b) => (a.dir < b.dir ? -1 : 1))
    const first = sorted[0]!
    try {
      const status: UpdateState = await checkProfileUpdate({
        profileDir: first.dir,
        ...(deps.gitBinary !== undefined ? { gitBinary: deps.gitBinary } : {}),
      })
      sendJSON(res, 200, { data: { repoId, status, profileCount: group.length } })
    } catch (err) {
      // checkProfileUpdate doesn't throw under normal conditions — every
      // failure mode is captured in the discriminated `state`. A throw
      // here is genuinely unexpected.
      sendError(res, 500, err instanceof Error ? err.message : 'update check failed')
    }
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/marketplace/repos/:repoId/update
  // -------------------------------------------------------------------------
  const applyUpdate = async (
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> => {
    const repoId = decodeRepoId(params['repoId'])
    if (repoId === null) {
      sendError(res, 400, 'invalid repoId')
      return
    }
    const body = await readJSON(req)
    const parsed = ApplyUpdateBodySchema.safeParse(body)
    if (!parsed.success) {
      sendError(res, 400, formatZodIssues(parsed.error))
      return
    }
    const auth = readAuthHeader(req)
    const inflightKey = `${repoId}|${parsed.data.strategy}`
    try {
      const result = await inflightUpdate.run(inflightKey, () =>
        applyProfileUpdate({
          repoId,
          strategy: parsed.data.strategy,
          dataDir: userProfilesDir,
          ...(auth ? { auth } : {}),
          ...(deps.gitBinary !== undefined ? { gitBinary: deps.gitBinary } : {}),
        }),
      )
      try { await deps.registry.discover(join(userProfilesDir, 'profiles'), 'user') } catch (e) {
        console.warn('[marketplace] registry.discover after update failed:', e)
      }
      sendJSON(res, 200, { data: result })
    } catch (err) {
      sendInstallErrorOrUnknown(res, err)
    }
  }

  // -------------------------------------------------------------------------
  // DELETE /api/v1/marketplace/repos/:repoId
  // -------------------------------------------------------------------------
  const uninstall = async (
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> => {
    const repoId = decodeRepoId(params['repoId'])
    if (repoId === null) {
      sendError(res, 400, 'invalid repoId')
      return
    }
    try {
      const removed = await uninstallProfilesForRepo(userProfilesDir, repoId)
      if (removed.length === 0) {
        sendError(res, 404, `no installed profiles for repoId '${repoId}'`)
        return
      }
      // Each `removed` entry is an absolute dir path; the registry keys
      // by the dir's basename (the profile's on-disk name).
      const removedNames = removed.map((p) => p.split('/').pop() ?? '').filter((n) => n.length > 0)
      await dropFromRegistry(removedNames)
      sendJSON(res, 200, { data: { repoId, removed } })
    } catch (err) {
      sendInstallErrorOrUnknown(res, err)
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/marketplace/index
  // -------------------------------------------------------------------------
  const index = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const now = Date.now()
    if (indexCache !== null && now - indexCache.fetchedAt < INDEX_TTL_MS) {
      sendJSON(res, 200, { data: indexCache.body, cached: true })
      return
    }
    try {
      const fresh = await fetchIndex(indexUrl)
      indexCache = { body: fresh, fetchedAt: now }
      sendJSON(res, 200, { data: fresh, cached: false })
    } catch (err) {
      // Stale cache > nothing.
      if (indexCache !== null) {
        sendJSON(res, 200, { data: indexCache.body, cached: true, stale: true })
        return
      }
      const reason = err instanceof Error ? err.message : 'unknown error'
      res.setHeader('Retry-After', '60')
      sendError(res, 503, `index unavailable: ${reason}`)
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/marketplace/ownware
  //
  // List of Ownware-curated bundle profiles + their installed/update flags.
  // Cheap (reads from local disk only). No auth required — these are
  // not user-secret data. Returns `[]` when the bundle isn't wired.
  // -------------------------------------------------------------------------
  const ownwareList = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (ownwareBundle === null) {
      sendJSON(res, 200, { data: [] satisfies readonly OwnwareBundleEntry[] })
      return
    }
    try {
      const entries = await ownwareBundle.list()
      sendJSON(res, 200, { data: entries })
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : 'ownware list failed')
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/marketplace/ownware/:name
  //
  // Full detail payload for the marketplace detail page (LinkedIn-style
  // profile view). Returns SOUL preview, skills, helpers, capabilities,
  // model wiring, and security level. Cheap (single profile load + small
  // helpers/ walk).
  // -------------------------------------------------------------------------
  const ownwareDetail = async (
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> => {
    if (ownwareBundle === null) {
      sendError(res, 404, 'Ownware marketplace bundle is not configured')
      return
    }
    const name = params['name']
    if (!isSafeBundleName(name)) {
      sendError(res, 400, 'invalid profile name')
      return
    }
    try {
      const data: OwnwareBundleDetail = await ownwareBundle.detail(name!)
      sendJSON(res, 200, { data })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not a Ownware marketplace bundle entry') || msg.includes('Bundle directory missing')) {
        sendError(res, 404, msg)
      } else {
        sendError(res, 500, msg)
      }
    }
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/marketplace/ownware/:name/install
  // -------------------------------------------------------------------------
  const ownwareInstall = async (
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> => {
    if (ownwareBundle === null) {
      sendError(res, 404, 'Ownware marketplace bundle is not configured')
      return
    }
    const name = params['name']
    if (!isSafeBundleName(name)) {
      sendError(res, 400, 'invalid profile name')
      return
    }
    try {
      const result = await ownwareBundle.install(name!)
      await refreshRegistry()
      sendJSON(res, 201, {
        data: {
          name,
          path: result.path,
          sidecar: result.sidecar,
        },
      })
    } catch (err) {
      // Ownware install can fail with: unknown name, missing dir, load
      // failure, name collision. Map to 400 / 404 / 409 as appropriate.
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not a Ownware marketplace bundle entry')) {
        sendError(res, 404, msg)
      } else if (msg.includes('already installed')) {
        sendError(res, 409, msg)
      } else {
        sendError(res, 400, msg)
      }
    }
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/marketplace/ownware/:name/update
  // -------------------------------------------------------------------------
  const ownwareUpdate = async (
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> => {
    if (ownwareBundle === null) {
      sendError(res, 404, 'Ownware marketplace bundle is not configured')
      return
    }
    const name = params['name']
    if (!isSafeBundleName(name)) {
      sendError(res, 400, 'invalid profile name')
      return
    }
    try {
      const result = await ownwareBundle.update(name!)
      await refreshRegistry()
      sendJSON(res, 200, {
        data: { name, path: result.path, sidecar: result.sidecar },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not installed')) {
        sendError(res, 404, msg)
      } else {
        sendError(res, 400, msg)
      }
    }
  }

  // -------------------------------------------------------------------------
  // DELETE /api/v1/marketplace/ownware/:name
  // -------------------------------------------------------------------------
  const ownwareUninstall = async (
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> => {
    if (ownwareBundle === null) {
      sendError(res, 404, 'Ownware marketplace bundle is not configured')
      return
    }
    const name = params['name']
    if (!isSafeBundleName(name)) {
      sendError(res, 400, 'invalid profile name')
      return
    }
    try {
      const result = await ownwareBundle.uninstall(name!)
      if (!result.removed) {
        sendError(res, 404, `'${name}' is not installed`)
        return
      }
      // Drop the registry entry so /api/v1/profiles stops listing it.
      await dropFromRegistry([name!])
      sendJSON(res, 200, { data: { name, removed: true } })
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : 'uninstall failed')
    }
  }

  return {
    preview, install, checkUpdate, applyUpdate, uninstall, index,
    ownwareList, ownwareDetail, ownwareInstall, ownwareUpdate, ownwareUninstall,
  }
}

/** Validate a profile name path-param. Same rules as registry naming. */
function isSafeBundleName(raw: string | undefined): boolean {
  if (raw === undefined) return false
  if (raw.length === 0 || raw.length > 64) return false
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) return false
  if (raw.startsWith('.')) return false
  return /^[A-Za-z0-9._-]+$/.test(raw)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the auth header. Accepts:
 *   - `Authorization: Bearer <token>`
 *   - `Authorization: GitHub-Token <token>`  (alias)
 *   - `Authorization: token <token>`         (GitHub historical form)
 *
 * Returns `null` when no token present. The token is opaque from the
 * gateway's perspective; the install layer treats every token the same
 * way (Bearer in `http.extraHeader`).
 *
 * Exported for unit testing.
 */
export function readAuthHeader(req: Pick<IncomingMessage, 'headers'>): GithubAuth | null {
  const raw = req.headers['authorization']
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const space = trimmed.indexOf(' ')
  if (space < 0) return null
  const scheme = trimmed.slice(0, space).toLowerCase()
  const token = trimmed.slice(space + 1).trim()
  if (token.length === 0) return null
  if (scheme === 'bearer' || scheme === 'github-token' || scheme === 'token') {
    return { kind: 'pat', token }
  }
  return null
}

/**
 * Decode a repoId path parameter. We use `__` as the separator (avoids
 * URL-encoding slashes). Validates the shape so a malicious caller
 * can't inject path traversal via `:repoId`.
 */
function decodeRepoId(raw: string | undefined): string | null {
  if (raw === undefined) return null
  // Decode possible URL encoding even though we mandate `__`. Belt + braces.
  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { return null }
  // Accept either `<owner>/<repo>` (URL-encoded slash) OR `<owner>__<repo>`.
  const pair = decoded.includes('/') ? decoded.split('/') : decoded.split('__')
  if (pair.length !== 2) return null
  const [owner, repo] = pair
  if (owner === undefined || repo === undefined) return null
  if (!isValidNameSegment(owner) || !isValidNameSegment(repo)) return null
  return `${owner}/${repo}`
}

function isValidNameSegment(s: string): boolean {
  if (s.length === 0 || s.length > 39) return false
  if (s.startsWith('-') || s.endsWith('-')) return false
  if (s.startsWith('.') || s.endsWith('.')) return false
  if (s.includes('..')) return false
  return /^[A-Za-z0-9._-]+$/.test(s)
}

function formatZodIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')
}

/**
 * Map an `InstallError` (or generic Error) to the right HTTP status +
 * structured error body. The status table is documented at the top of
 * this file.
 */
function sendInstallErrorOrUnknown(res: ServerResponse, err: unknown): void {
  if (isInstallError(err)) {
    const status = installErrorStatus(err)
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({
      error: { code: err.code, message: err.message, detail: err.detail },
    }))
    return
  }
  // Unknown shape — route through the cause-graph classifier so wire
  // category is set (auth/network/sqlite/overload/etc.) even though we
  // don't have a typed InstallError. The client's <ErrorState> dispatches
  // on category for guidance text.
  sendClassifiedError(res, err)
}

function installErrorStatus(err: InstallError): number {
  switch (err.code) {
    case 'invalid_url':
    case 'invalid_manifest':
    case 'forbidden_custom_code':
    case 'path_escape':
      return 400
    case 'oversized':
      return 413
    case 'manifest_not_found':
      return 404
    case 'auth_required':
      return 401
    case 'name_collision':
      return 409
    case 'network':
    case 'clone_failed':
      return 502
    case 'profile_load_failed':
    case 'unsupported_helper':
      return 422
    default: {
      const exhaustive: never = err.code
      void exhaustive
      return 500
    }
  }
}

/**
 * Fetch the public marketplace index. Bounded body size + timeout so a
 * misbehaving raw.githubusercontent.com response can't OOM the gateway.
 */
async function fetchIndex(url: string): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), INDEX_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'cortex-marketplace-index/1',
      },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const reader = res.body?.getReader()
    if (!reader) throw new Error('empty response body')
    const decoder = new TextDecoder()
    let bytes = 0
    let body = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > INDEX_MAX_BYTES) {
        try { reader.cancel() } catch { /* */ }
        throw new Error('index payload exceeds 1 MB cap')
      }
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
    return JSON.parse(body)
  } finally {
    clearTimeout(timer)
  }
}

// Re-import join so the handler doesn't depend on the inflated public
// surface of the registry module.
import { join } from 'node:path'
