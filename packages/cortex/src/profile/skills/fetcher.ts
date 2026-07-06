/**
 * Skill Fetcher
 *
 * Given a {@link ResolvedSkillUrl}, performs the network fetch (or gist API
 * call) and returns the markdown body. Enforces:
 *   - 5 second timeout
 *   - 64 KB size cap
 *   - content-type ∈ { text/markdown, text/plain }
 *   - manual redirect handling: each hop revalidated through the resolver
 *
 * Pure function in the side-effectful sense: uses global fetch only,
 * caller can swap via `options.fetcher` for tests.
 */

import { resolveSkillUrl, SkillUrlError, type ResolvedSkillUrl } from './url-resolver.js'

// ---------------------------------------------------------------------------
// Repo browse types
// ---------------------------------------------------------------------------

/** A single SKILL.md found while browsing a repo. */
export interface BrowsedSkill {
  /** Canonical slug derived from the parent folder name. */
  readonly slug: string
  /** Frontmatter `name`, or fallback to slug. */
  readonly name: string
  /** Frontmatter `description`, possibly empty. */
  readonly description: string
  /** Repo-relative path of the SKILL.md (e.g. `finance/x/SKILL.md`). */
  readonly path: string
  /** Raw URL to download the SKILL.md content. */
  readonly downloadUrl: string
  /** Parent folder relative to repo root (or to subpath). Acts as the UI category. */
  readonly category: string
  /** Full SKILL.md body (after frontmatter) so the UI can preview without re-fetching. */
  readonly body: string
}

/** Hard cap on how many SKILL.md files we'll fetch during one browse call. */
const MAX_BROWSE_RESULTS = 50

/**
 * Parallel-fetch concurrency for browse mode. Higher = faster, but we
 * shouldn't hammer GitHub raw. 10 keeps the worst case (50 skills)
 * under ~500ms on a typical connection.
 */
const BROWSE_CONCURRENCY = 10

// ---------------------------------------------------------------------------
// Limits + content types
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 5_000
export const DEFAULT_MAX_BYTES = 64 * 1024
export const MAX_REDIRECTS = 5

/**
 * GitHub git/trees recursive responses can be much larger than a single
 * skill file — they list every blob in the repo with paths + types.
 * Cap at 2 MB to cover real-world Claude skill repos comfortably while
 * still bounding worst-case memory if someone points us at a megarepo.
 */
export const MAX_TREE_BYTES = 2 * 1024 * 1024

const ACCEPTED_CONTENT_TYPES: ReadonlyArray<string> = [
  'text/markdown',
  'text/plain',
  // GitHub raw serves application/octet-stream for some files.
  'application/octet-stream',
]

// GitHub API for gists requires this header to opt into JSON v3.
const GIST_API_HEADERS: Record<string, string> = {
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'cortex-skill-fetcher',
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SkillFetchErrorCode =
  | 'FETCH_FAILED'
  | 'WRONG_CONTENT_TYPE'
  | 'TOO_LARGE'
  | 'TREE_TOO_LARGE'
  | 'PRIVATE_HOST'
  | 'INVALID_URL'
  | 'GIST_FILE_NOT_FOUND'
  | 'TOO_MANY_REDIRECTS'

export class SkillFetchError extends Error {
  readonly code: SkillFetchErrorCode
  constructor(code: SkillFetchErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'SkillFetchError'
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FetchedSkill {
  readonly content: string
  readonly source: ResolvedSkillUrl
}

export interface FetchSkillOptions {
  readonly timeoutMs?: number
  readonly maxBytes?: number
  /** Inject a fetch implementation for tests. */
  readonly fetcher?: typeof fetch
}

export async function fetchSkill(
  resolved: ResolvedSkillUrl,
  options: FetchSkillOptions = {},
): Promise<FetchedSkill> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const fetcher = options.fetcher ?? fetch

  if (resolved.origin === 'gist-page') {
    const content = await fetchFromGistApi(resolved, fetcher, timeoutMs, maxBytes)
    return { content, source: resolved }
  }

  if (resolved.origin === 'github-repo' || resolved.origin === 'github-tree') {
    throw new SkillFetchError(
      'FETCH_FAILED',
      'Use listSkillsInRepo() for repo / tree URLs, not fetchSkill().',
    )
  }

  const content = await fetchWithRedirects(resolved.canonical, fetcher, timeoutMs, maxBytes)
  return { content, source: resolved }
}

// ---------------------------------------------------------------------------
// listSkillsInRepo — browse mode for github-repo / github-tree
// ---------------------------------------------------------------------------

interface GitTreeResponse {
  tree?: Array<{
    path?: string
    type?: string
    url?: string
  }>
  truncated?: boolean
}

const SKILL_PATH_RE = /(?:^|\/)SKILL\.md$/i

export async function listSkillsInRepo(
  resolved: ResolvedSkillUrl,
  options: FetchSkillOptions = {},
): Promise<BrowsedSkill[]> {
  if (resolved.origin !== 'github-repo' && resolved.origin !== 'github-tree') {
    throw new SkillFetchError(
      'FETCH_FAILED',
      `listSkillsInRepo called with origin '${resolved.origin}'.`,
    )
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const fetcher = options.fetcher ?? fetch

  const owner = resolved.owner!
  const repo = resolved.repo!
  const ref = resolved.ref ?? 'HEAD'
  const subpath = resolved.subpath?.replace(/\/+$/, '') ?? ''

  // Step 1: fetch the recursive tree.
  const treeResponse = await doFetch(
    resolved.canonical,
    { headers: GIST_API_HEADERS },
    fetcher,
    timeoutMs,
  )
  if (!treeResponse.ok) {
    throw new SkillFetchError(
      'FETCH_FAILED',
      `GitHub tree API returned ${treeResponse.status} ${treeResponse.statusText}.`,
    )
  }
  // Tree responses are repo metadata (paths + types, not content) so they
  // get a much larger ceiling than individual skill files. The
  // distinct error code lets the UI show the right hint when a repo
  // genuinely is too big to enumerate.
  let treeJson: string
  try {
    treeJson = await readBodyWithCap(treeResponse, MAX_TREE_BYTES)
  } catch (err) {
    if (err instanceof SkillFetchError && err.code === 'TOO_LARGE') {
      throw new SkillFetchError(
        'TREE_TOO_LARGE',
        `Repo file list exceeds ${MAX_TREE_BYTES} bytes — too big to browse. Paste a single SKILL.md URL instead.`,
      )
    }
    throw err
  }
  let treeParsed: GitTreeResponse
  try {
    treeParsed = JSON.parse(treeJson) as GitTreeResponse
  } catch {
    throw new SkillFetchError('FETCH_FAILED', 'GitHub tree API returned invalid JSON.')
  }

  // Step 2: filter to SKILL.md blobs, optionally constrained to subpath.
  const matches: Array<{ path: string }> = []
  for (const entry of treeParsed.tree ?? []) {
    if (entry.type !== 'blob' || typeof entry.path !== 'string') continue
    if (!SKILL_PATH_RE.test(entry.path)) continue
    if (subpath && !entry.path.startsWith(subpath + '/')) continue
    matches.push({ path: entry.path })
    if (matches.length >= MAX_BROWSE_RESULTS) break
  }

  // Step 3: for each match, fetch the SKILL.md and parse name + description.
  // Run with bounded concurrency so 50 skills don't take 50 × RTT.
  const fetchOne = async (m: { path: string }): Promise<BrowsedSkill | null> => {
    const downloadUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${m.path}`
    let content: string
    try {
      content = await fetchWithRedirects(downloadUrl, fetcher, timeoutMs, maxBytes)
    } catch {
      // Skip files that fail to fetch — better to show partial list than abort.
      return null
    }
    const meta = extractMetaFromFrontmatter(content)
    const slug = deriveBrowsedSlug(m.path)
    if (slug.length === 0) return null // SKILL.md at repo root — not installable as a skill folder.
    const category = deriveCategory(m.path, subpath)
    const body = extractBody(content)
    return {
      slug,
      name: meta.name ?? slug,
      description: meta.description ?? '',
      path: m.path,
      downloadUrl,
      category,
      body,
    }
  }

  // Preserve the input order so the UI's grouping/category sort is stable.
  const results: BrowsedSkill[] = []
  for (let i = 0; i < matches.length; i += BROWSE_CONCURRENCY) {
    const batch = matches.slice(i, i + BROWSE_CONCURRENCY)
    const batchResults = await Promise.all(batch.map(fetchOne))
    for (const r of batchResults) {
      if (r != null) results.push(r)
    }
  }
  return results
}

/** Best-effort frontmatter extraction. Browse only; full validation runs at install. */
function extractMetaFromFrontmatter(content: string): {
  name: string | null
  description: string | null
} {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return { name: null, description: null }
  const block = m[1] ?? ''
  // Quick line-based scan; this is browse metadata, not validation.
  const get = (key: string): string | null => {
    const r = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm')
    const found = block.match(r)
    if (!found) return null
    return found[1]!.trim().replace(/^['"]|['"]$/g, '')
  }
  return { name: get('name'), description: get('description') }
}

/** Extract the body (everything after the closing `---`). */
function extractBody(content: string): string {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)
  if (!m) return content.trim()
  return (m[1] ?? '').trim()
}

/**
 * Slug = the immediate parent folder name of SKILL.md, regardless of
 * subpath. So `finance/SKILL.md` → `finance`, and
 * `finance/business-investment-advisor/SKILL.md` → `business-investment-advisor`.
 *
 * Edge case: SKILL.md at the repo root (no parent) → empty slug, which
 * the caller treats as a skip. Skills must live in a folder.
 */
function deriveBrowsedSlug(path: string): string {
  const dir = path.slice(0, path.toLowerCase().lastIndexOf('/skill.md'))
  const last = dir.split('/').filter(Boolean).pop() ?? ''
  return last
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
}

/**
 * Category = path segments between the subpath (or repo root) and the
 * slug folder, used to group skills in the UI. So with subpath
 * `finance`:
 *   `finance/SKILL.md`                           → category = '' (top level under finance)
 *   `finance/business-advisor/SKILL.md`          → category = '' (slug is the immediate child)
 *   `finance/sub-cat/business-advisor/SKILL.md`  → category = 'sub-cat'
 * And without a subpath:
 *   `finance/business-advisor/SKILL.md`          → category = 'finance'
 */
function deriveCategory(path: string, subpath: string): string {
  const dir = path.slice(0, path.toLowerCase().lastIndexOf('/skill.md'))
  const stripped = subpath
    ? dir === subpath
      ? ''
      : dir.slice(subpath.length + 1)
    : dir
  const segments = stripped.split('/').filter(Boolean)
  // Drop the last segment (= slug). What's left is the category path.
  return segments.slice(0, -1).join('/')
}

// ---------------------------------------------------------------------------
// Direct (raw) fetch with manual redirect validation
// ---------------------------------------------------------------------------

async function fetchWithRedirects(
  initialUrl: string,
  fetcher: typeof fetch,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  let url = initialUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await doFetch(url, { redirect: 'manual' }, fetcher, timeoutMs)

    if (isRedirect(response.status)) {
      const location = response.headers.get('location')
      if (!location) {
        throw new SkillFetchError('FETCH_FAILED', `Redirect without Location header (status ${response.status}).`)
      }
      const next = new URL(location, url).href
      // Re-validate every hop against the resolver's host rules.
      try {
        resolveSkillUrl(next)
      } catch (err) {
        if (err instanceof SkillUrlError) {
          throw new SkillFetchError(
            err.code === 'PRIVATE_HOST' ? 'PRIVATE_HOST' : 'INVALID_URL',
            `Redirect destination rejected: ${err.message}`,
          )
        }
        throw err
      }
      url = next
      continue
    }

    if (!response.ok) {
      throw new SkillFetchError(
        'FETCH_FAILED',
        `Upstream returned ${response.status} ${response.statusText}.`,
      )
    }

    assertAcceptableContentType(response)
    return await readBodyWithCap(response, maxBytes)
  }
  throw new SkillFetchError(
    'TOO_MANY_REDIRECTS',
    `Exceeded ${MAX_REDIRECTS} redirects.`,
  )
}

// ---------------------------------------------------------------------------
// Gist API path: fetch JSON, pick file, return content
// ---------------------------------------------------------------------------

interface GistApiResponse {
  files?: Record<
    string,
    { filename?: string; content?: string; size?: number; type?: string } | undefined
  >
}

async function fetchFromGistApi(
  resolved: ResolvedSkillUrl,
  fetcher: typeof fetch,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  const response = await doFetch(
    resolved.canonical,
    { headers: GIST_API_HEADERS },
    fetcher,
    timeoutMs,
  )
  if (!response.ok) {
    throw new SkillFetchError(
      'FETCH_FAILED',
      `Gist API returned ${response.status} ${response.statusText}.`,
    )
  }

  // The gist JSON itself can be large; cap it at 4× maxBytes to leave room
  // for filenames + metadata while still bounding memory.
  const json = await readBodyWithCap(response, maxBytes * 4)
  let parsed: GistApiResponse
  try {
    parsed = JSON.parse(json) as GistApiResponse
  } catch {
    throw new SkillFetchError('FETCH_FAILED', 'Gist API returned invalid JSON.')
  }

  const file = pickGistFile(parsed.files ?? {}, resolved.gistFileHint)
  if (!file) {
    throw new SkillFetchError(
      'GIST_FILE_NOT_FOUND',
      'No `.md` file found in this gist.',
    )
  }
  if ((file.size ?? 0) > maxBytes) {
    throw new SkillFetchError('TOO_LARGE', `Gist file exceeds ${maxBytes} bytes.`)
  }
  if (typeof file.content !== 'string') {
    throw new SkillFetchError('FETCH_FAILED', 'Gist file has no content.')
  }
  // Final post-content size check (covers UTF-8 size estimation gaps).
  if (Buffer.byteLength(file.content, 'utf-8') > maxBytes) {
    throw new SkillFetchError('TOO_LARGE', `Gist file exceeds ${maxBytes} bytes.`)
  }
  return file.content
}

function pickGistFile(
  files: Record<string, { filename?: string; content?: string; size?: number; type?: string } | undefined>,
  hint: string | undefined,
): { content?: string; size?: number } | null {
  const entries = Object.entries(files).filter(([, v]) => v != null) as Array<
    [string, { filename?: string; content?: string; size?: number; type?: string }]
  >

  // Prefer a file whose anchor-form matches the user's #file-... hint.
  if (hint) {
    const wantAnchor = hint.toLowerCase()
    for (const [key, value] of entries) {
      const anchor = filenameToAnchor(value.filename ?? key)
      if (anchor === wantAnchor) return value
    }
  }

  // Else: prefer .md files
  const md = entries.find(([, v]) => (v.filename ?? '').toLowerCase().endsWith('.md'))
  if (md) return md[1]

  return null
}

/** Mirror GitHub's gist anchor format: lowercase, dots/special → '-'. */
function filenameToAnchor(filename: string): string {
  return filename.toLowerCase().replace(/\./g, '-').replace(/[^a-z0-9_-]/g, '-')
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

async function doFetch(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetcher(url, { ...init, signal: controller.signal })
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new SkillFetchError('FETCH_FAILED', `Request timed out after ${timeoutMs}ms.`)
    }
    throw new SkillFetchError(
      'FETCH_FAILED',
      err instanceof Error ? err.message : 'Network error.',
    )
  } finally {
    clearTimeout(timer)
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400 && status !== 304
}

function assertAcceptableContentType(response: Response): void {
  const raw = response.headers.get('content-type')
  if (!raw) return // Some CDNs omit it; fall through and trust the size cap.
  // strip parameters (e.g. "text/markdown; charset=utf-8")
  const ct = raw.split(';')[0]!.trim().toLowerCase()
  if (!ACCEPTED_CONTENT_TYPES.includes(ct)) {
    throw new SkillFetchError(
      'WRONG_CONTENT_TYPE',
      `Expected text/markdown or text/plain, got "${ct}".`,
    )
  }
}

async function readBodyWithCap(response: Response, maxBytes: number): Promise<string> {
  // Honour Content-Length when present and over the cap.
  const lenHeader = response.headers.get('content-length')
  if (lenHeader) {
    const len = Number(lenHeader)
    if (Number.isFinite(len) && len > maxBytes) {
      throw new SkillFetchError('TOO_LARGE', `File is ${len} bytes; limit is ${maxBytes}.`)
    }
  }

  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf-8') > maxBytes) {
      throw new SkillFetchError('TOO_LARGE', `File exceeds ${maxBytes} bytes.`)
    }
    return text
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          // ignore
        }
        throw new SkillFetchError('TOO_LARGE', `File exceeds ${maxBytes} bytes.`)
      }
      chunks.push(value)
    }
  }
  return Buffer.concat(chunks).toString('utf-8')
}
