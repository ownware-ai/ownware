/**
 * Preflight — read-only "what am I about to install?" preview.
 *
 * One HTTP fetch (`raw.githubusercontent.com/<owner>/<repo>/<ref>/cortex.profile.json`).
 * No clone, no disk writes, no profile loading, no MCP spawn. The result
 * is a UI-shaped payload the install dialog renders before the user
 * commits to the install endpoint.
 *
 * Why a separate fetch from `installProfileFromGithub`:
 *   - Cheap (no `git`, no temp dir, sub-second on a warm cache).
 *   - Doesn't write anything — preview is reversible by definition.
 *   - User reviews permissions BEFORE the security-gated install runs.
 *
 * Why manifest-only (we don't peek inside `agent.json`):
 *   - Each profile's `agent.json` can be 30+ fields and is the runtime
 *     contract; the preview surface shouldn't depend on it. Authors who
 *     want extra info in the marketplace card put it in
 *     `cortex.profile.json`.
 *   - Keeps the preview deterministic — same manifest in, same card out.
 *   - Lets the marketplace contract evolve independently of profile
 *     schema (decision 5 in `2026-05-06-decisions.md`).
 *
 * Network failure / repo deleted / repo went private map cleanly to
 * `InstallError`. Optional GitHub-API enrichment (stars, updatedAt) is
 * BEST-EFFORT — failure here never fails the preflight.
 */

import {
  parseGithubUrl,
  type GithubUrl,
} from './github-url.js'
import {
  parseManifest,
  type CapabilityTag,
  type ConnectorAuth,
  type MarketplaceManifest,
} from './manifest.js'
import { InstallError } from './errors.js'
import type { GithubAuth } from './types.js'

/**
 * Maximum acceptable byte length for a `cortex.profile.json` payload as
 * served over the network. Mirrors the manifest's hard cap so a malicious
 * server can't stream gigabytes.
 */
export const PREFLIGHT_FETCH_MAX_BYTES = 64 * 1024

/** Default timeout per network call. */
export const PREFLIGHT_FETCH_TIMEOUT_MS = 10_000

/**
 * The shape the client renders. Every field is either populated or
 * explicitly null/empty — the renderer never has to handle `undefined`.
 *
 * `stars` and `updatedAt` are nullable to express "GitHub API was
 * unreachable / rate-limited" without failing the whole preview.
 *
 * `bundle` is null when the manifest declares one profile, set when it
 * declares two or more — the client uses this to render "Includes N profiles".
 */
export interface Preflight {
  /** `<owner>/<repo>` — manifest-declared id. */
  readonly id: string
  /** Repo author from the URL (`<owner>`). Distinct from the manifest's
   *  `id` so the UI can show "by acme" even on a fork. */
  readonly author: string
  readonly summary: string
  readonly category: string
  /** Stars at preview time. `null` when the GitHub API failed or was
   *  rate-limited. */
  readonly stars: number | null
  /** Last commit timestamp on the resolved ref. `null` on API failure. */
  readonly updatedAt: string | null
  readonly models: readonly string[]
  readonly connectors: readonly PreflightConnector[]
  readonly capabilities: readonly CapabilityTag[]
  /** Set when the manifest declares more than one top-level profile. */
  readonly bundle: { readonly profileCount: number } | null
  /** Soft, advisory messages — e.g. "this profile uses preset:full".
   *  The client renders these as a yellow info row in the preview card. */
  readonly warnings: readonly string[]
  /** The raw manifest, as parsed. Carried so the install endpoint can
   *  re-use it without re-fetching. Clients shouldn't read this directly. */
  readonly manifest: MarketplaceManifest
  /** Resolved ref the manifest was fetched from (the user-supplied ref
   *  OR the repo's default branch when omitted). */
  readonly ref: string
  /** The cortex.profile.json byte size we observed. UI may surface. */
  readonly manifestBytes: number
}

export interface PreflightConnector {
  readonly id: string
  readonly label: string
  readonly auth: ConnectorAuth
  readonly required: boolean
  readonly hint?: string
}

/**
 * Caller-supplied fetcher. We inject this so tests can drive the
 * preflight against in-memory data without binding ports.
 *
 * The default implementation uses Node 18+ global `fetch`.
 *
 * Headers expected on the response:
 *   - 200 → body (string) is the raw manifest contents
 *   - 404 → `manifest_not_found`
 *   - 403/401 → `auth_required`
 *   - any 5xx / network → `network`
 *
 * The fetcher MUST enforce the size cap; otherwise a malicious server
 * could pipe unbounded data into our string buffer.
 */
export type PreflightFetcher = (req: PreflightFetchRequest) => Promise<PreflightFetchResponse>

export interface PreflightFetchRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly maxBytes: number
  readonly timeoutMs: number
}

export type PreflightFetchResponse =
  | { readonly kind: 'ok'; readonly body: string; readonly bytes: number }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'auth-required' }
  | { readonly kind: 'oversized'; readonly bytes: number }
  | { readonly kind: 'network'; readonly reason: string }

export interface BuildPreflightOptions {
  /** GitHub URL — same allowlist as the install primitive. */
  readonly url: string
  /** Optional ref override. */
  readonly ref?: string
  /** Optional auth (private repos). The token is forwarded to the
   *  fetcher in the `Authorization` header — never logged. */
  readonly auth?: GithubAuth
  /** Inject a custom fetcher (tests). Default uses global fetch. */
  readonly fetcher?: PreflightFetcher
  /** Override fetch timeout. */
  readonly timeoutMs?: number
}

/**
 * Build a Preflight for the given GitHub URL. Throws an `InstallError`
 * on URL/manifest/network errors — the caller (gateway handler) maps
 * the code to an HTTP status.
 */
export async function buildPreflight(opts: BuildPreflightOptions): Promise<Preflight> {
  const parsed = parseGithubUrl(opts.url)
  const ref = opts.ref ?? parsed.ref ?? 'HEAD'
  const fetcher = opts.fetcher ?? defaultFetcher
  const timeoutMs = opts.timeoutMs ?? PREFLIGHT_FETCH_TIMEOUT_MS

  // Fetch the manifest at the resolved ref. raw.githubusercontent.com
  // returns the raw file contents and treats 'HEAD' as the default branch.
  const manifestUrl = buildRawUrl(parsed, ref)
  const manifestRes = await fetcher({
    url: manifestUrl,
    headers: buildHeaders(opts.auth),
    maxBytes: PREFLIGHT_FETCH_MAX_BYTES,
    timeoutMs,
  })

  switch (manifestRes.kind) {
    case 'not-found':
      throw new InstallError('manifest_not_found', { path: 'cortex.profile.json' })
    case 'auth-required':
      throw new InstallError('auth_required', {
        hint: 'Provide a GitHub token if the repository is private.',
      })
    case 'oversized':
      throw new InstallError('invalid_manifest', {
        issues: [`manifest exceeds ${PREFLIGHT_FETCH_MAX_BYTES} bytes (got ${manifestRes.bytes})`],
      })
    case 'network':
      throw new InstallError('network', { reason: manifestRes.reason })
  }

  // Parse — re-uses the same Zod path as install. Same input → same errors.
  const manifest = parseManifest(manifestRes.body)

  // Best-effort enrichment (stars, updatedAt). Failures are silently
  // swallowed; preview is the source of truth so we'd rather show null
  // than block the user behind an outage on api.github.com.
  const enrichment = await fetchEnrichment({
    fetcher,
    url: parsed,
    ref,
    auth: opts.auth,
    timeoutMs,
  })

  return {
    id: manifest.id,
    author: parsed.owner,
    summary: manifest.summary,
    category: manifest.category,
    stars: enrichment.stars,
    updatedAt: enrichment.updatedAt,
    models: manifest.models,
    connectors: manifest.connectors.map((c) => {
      const out: PreflightConnector = {
        id: c.id,
        label: c.label,
        auth: c.auth,
        required: c.required,
      }
      return c.hint !== undefined ? { ...out, hint: c.hint } : out
    }),
    capabilities: manifest.capabilities,
    bundle: manifest.profiles.length > 1
      ? { profileCount: manifest.profiles.length }
      : null,
    warnings: buildWarnings(manifest),
    manifest,
    ref,
    manifestBytes: manifestRes.bytes,
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildRawUrl(parsed: GithubUrl, ref: string): string {
  // raw.githubusercontent.com accepts branch / tag / sha for the third
  // segment. `HEAD` aliases to the default branch.
  const safeRef = encodeURIComponent(ref)
  return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${safeRef}/cortex.profile.json`
}

function buildHeaders(auth: GithubAuth | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'cortex-marketplace-preflight/1',
  }
  if (auth !== undefined) {
    headers['Authorization'] = `Bearer ${auth.token}`
  }
  return headers
}

interface Enrichment {
  readonly stars: number | null
  readonly updatedAt: string | null
}

async function fetchEnrichment(args: {
  fetcher: PreflightFetcher
  url: GithubUrl
  ref: string
  auth?: GithubAuth
  timeoutMs: number
}): Promise<Enrichment> {
  // GitHub REST: /repos/<owner>/<repo> gives stars; /repos/<owner>/<repo>/commits/<ref>
  // gives the commit timestamp. We attempt both; either failing returns null.
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'cortex-marketplace-preflight/1',
    ...(args.auth !== undefined ? { Authorization: `Bearer ${args.auth.token}` } : {}),
  }

  const repoUrl = `https://api.github.com/repos/${args.url.owner}/${args.url.repo}`
  const commitUrl = `https://api.github.com/repos/${args.url.owner}/${args.url.repo}/commits/${encodeURIComponent(args.ref)}`

  const [repoRes, commitRes] = await Promise.all([
    args.fetcher({ url: repoUrl, headers, maxBytes: 256 * 1024, timeoutMs: args.timeoutMs }),
    args.fetcher({ url: commitUrl, headers, maxBytes: 256 * 1024, timeoutMs: args.timeoutMs }),
  ])

  let stars: number | null = null
  if (repoRes.kind === 'ok') {
    try {
      const parsed = JSON.parse(repoRes.body) as Record<string, unknown>
      if (typeof parsed['stargazers_count'] === 'number') {
        stars = parsed['stargazers_count']
      }
    } catch { /* swallow — preview-grade enrichment */ }
  }

  let updatedAt: string | null = null
  if (commitRes.kind === 'ok') {
    try {
      const parsed = JSON.parse(commitRes.body) as Record<string, unknown>
      const commitObj = parsed['commit'] as Record<string, unknown> | undefined
      const author = commitObj?.['author'] as Record<string, unknown> | undefined
      if (author && typeof author['date'] === 'string') {
        updatedAt = author['date']
      }
    } catch { /* swallow */ }
  }

  return { stars, updatedAt }
}

/**
 * Compose advisory warnings the renderer surfaces above the install
 * button. Pure function over the manifest — does not consult the
 * network. Adding new heuristics is additive.
 */
function buildWarnings(manifest: MarketplaceManifest): string[] {
  const out: string[] = []
  if (manifest.connectors.some((c) => c.auth === 'paid-key')) {
    out.push('Some connectors require a paid API key.')
  }
  if (manifest.profiles.length > 5) {
    out.push(`This repository installs ${manifest.profiles.length} top-level profiles.`)
  }
  if (manifest.capabilities.includes('shell')) {
    out.push('This profile can run shell commands. You will be asked to confirm each one.')
  }
  return out
}

/**
 * Default fetcher — uses Node 18+ global `fetch`. Honors the size cap by
 * reading the body in chunks and aborting when the cap is exceeded.
 *
 * Rate-limit / 5xx → network error (caller retries via UI). 404 → not
 * found. 401/403 → auth required.
 */
const defaultFetcher: PreflightFetcher = async (req) => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs)
  try {
    const res = await fetch(req.url, {
      method: 'GET',
      headers: req.headers,
      signal: ctrl.signal,
      redirect: 'follow',
    })

    if (res.status === 404) return { kind: 'not-found' }
    if (res.status === 401 || res.status === 403) return { kind: 'auth-required' }
    if (res.status >= 500 || res.status >= 400) {
      return { kind: 'network', reason: `HTTP ${res.status}` }
    }

    // Read body with a hard size cap to defeat malicious servers that
    // pretend they're sending 64 KB but stream forever.
    const reader = res.body?.getReader()
    if (!reader) {
      return { kind: 'network', reason: 'response had no body' }
    }
    const decoder = new TextDecoder()
    let bytes = 0
    let body = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > req.maxBytes) {
        try { reader.cancel() } catch { /* */ }
        return { kind: 'oversized', bytes }
      }
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
    return { kind: 'ok', body, bytes }
  } catch (err) {
    return { kind: 'network', reason: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

// Re-exports for caller convenience — the default fetcher is exported
// for tests that want to assert it exists; they should still inject
// a custom fetcher rather than hit the real network.
export { defaultFetcher as _defaultFetcher }
