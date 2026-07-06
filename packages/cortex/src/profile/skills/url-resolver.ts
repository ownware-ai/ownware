/**
 * Skill URL Resolver
 *
 * Normalises any user-pasted skill URL into a canonical form the fetcher
 * can GET. Performs syntactic validation (scheme, host, form) only —
 * the fetcher is responsible for runtime checks (DNS, redirects, size,
 * content-type) since those need network access.
 *
 * Supported input forms:
 *   - GitHub blob:    https://github.com/<owner>/<repo>/blob/<branch>/<path>.md
 *   - GitHub raw:     https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>.md
 *   - Gist page:      https://gist.github.com/<user>/<id>[#file-x-md]
 *   - Gist raw:       https://gist.githubusercontent.com/<user>/<id>/raw/<rev>/<path>.md
 *   - Plain raw .md:  https://<any-public-host>/<path>.md
 *
 * Rejected forms:
 *   - non-HTTPS schemes
 *   - localhost / private IPv4 ranges (defence-in-depth against SSRF;
 *     the fetcher re-checks resolved IPs at request time)
 *   - hosts that don't match a supported pattern AND don't end in .md
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SkillUrlErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_SCHEME'
  | 'PRIVATE_HOST'
  | 'UNSUPPORTED_HOST'

export class SkillUrlError extends Error {
  readonly code: SkillUrlErrorCode
  constructor(code: SkillUrlErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'SkillUrlError'
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Where we believe this skill came from. Used for display + fetcher dispatch.
 *
 *   single-file modes:
 *     'github'    — raw or blob URL, fetcher does a single GET
 *     'gist-raw'  — gist raw URL
 *     'gist-page' — gist page URL → fetcher hits the GitHub gists API
 *     'raw'       — generic public HTTPS URL ending in .md
 *
 *   list (browse) modes:
 *     'github-repo' — paste github.com/<owner>/<repo>; fetcher walks tree
 *                     and returns every SKILL.md found
 *     'github-tree' — paste github.com/<owner>/<repo>/tree/<ref>/<subpath>;
 *                     same as github-repo but constrained to <subpath>
 */
export type SkillUrlOrigin =
  | 'github'
  | 'gist-page'
  | 'gist-raw'
  | 'raw'
  | 'github-repo'
  | 'github-tree'

export interface ResolvedSkillUrl {
  /**
   * URL the fetcher will GET. For single-file modes this is the raw blob.
   * For gist-page this is the GitHub gists API URL. For github-repo /
   * github-tree this is the git/trees API URL (recursive=1).
   */
  readonly canonical: string
  readonly origin: SkillUrlOrigin
  /** User-facing host label, e.g. "github.com/foo/bar". */
  readonly displayHint: string
  /** Gist ID — only set when origin is 'gist-page'. */
  readonly gistId?: string
  /**
   * Filename hint parsed from a `#file-...` anchor. Only set when origin is
   * 'gist-page' and the URL had an anchor. The fetcher uses this as a
   * best-match against the gist's actual file list.
   */
  readonly gistFileHint?: string
  /** Owner — set when origin is github-repo or github-tree. */
  readonly owner?: string
  /** Repo — set when origin is github-repo or github-tree. */
  readonly repo?: string
  /** Branch / tag / SHA — set when origin is github-repo or github-tree. Defaults to 'HEAD'. */
  readonly ref?: string
  /** Subpath inside the repo — set when origin is github-tree. */
  readonly subpath?: string
}

// ---------------------------------------------------------------------------
// Pattern detectors
// ---------------------------------------------------------------------------

const GITHUB_HOST = 'github.com'
const GITHUB_RAW_HOST = 'raw.githubusercontent.com'
const GIST_PAGE_HOST = 'gist.github.com'
const GIST_RAW_HOST = 'gist.githubusercontent.com'

/**
 * GitHub blob path: /<owner>/<repo>/blob/<ref>/<path>
 * The capture groups are owner, repo, ref, path.
 */
const GITHUB_BLOB_PATH = /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/

/**
 * GitHub tree path: /<owner>/<repo>/tree/<ref>(/<subpath>)?
 * The capture groups are owner, repo, ref, optional subpath.
 */
const GITHUB_TREE_PATH = /^\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+?))?\/?$/

/**
 * GitHub repo root path: /<owner>/<repo>(/)?
 * The capture groups are owner and repo. Reserved second segments
 * (issues, pulls, etc.) are filtered out.
 */
const GITHUB_REPO_PATH = /^\/([^/]+)\/([^/]+)\/?$/

/** Path segments that look like a repo but are GitHub UI surfaces. */
const GITHUB_RESERVED_OWNERS: ReadonlySet<string> = new Set([
  'orgs',
  'settings',
  'marketplace',
  'pulls',
  'issues',
  'notifications',
  'explore',
  'topics',
  'trending',
  'sponsors',
])

/**
 * Gist page path: /<user>/<id>
 * The capture group is the gist id (hex).
 */
const GIST_PAGE_PATH = /^\/[^/]+\/([a-f0-9]+)\/?$/i

const PRIVATE_LITERAL_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '::',
])

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function resolveSkillUrl(input: string): ResolvedSkillUrl {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    throw new SkillUrlError('INVALID_URL', 'URL is empty.')
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new SkillUrlError('INVALID_URL', 'URL is malformed.')
  }

  if (parsed.protocol !== 'https:') {
    throw new SkillUrlError('UNSUPPORTED_SCHEME', 'URL must use HTTPS.')
  }

  if (parsed.hostname.length === 0) {
    throw new SkillUrlError('INVALID_URL', 'URL has no hostname.')
  }

  // URL.hostname keeps brackets around IPv6 literals; strip for matching.
  const rawHost = parsed.hostname.toLowerCase()
  const host =
    rawHost.startsWith('[') && rawHost.endsWith(']')
      ? rawHost.slice(1, -1)
      : rawHost
  if (isPrivateHost(host)) {
    throw new SkillUrlError('PRIVATE_HOST', 'URL must point to a public host.')
  }

  // github.com — could be blob (single file), tree (list mode w/ subpath),
  // or repo root (list mode w/ no subpath)
  if (host === GITHUB_HOST) {
    const blob = parsed.pathname.match(GITHUB_BLOB_PATH)
    if (blob) {
      const [, owner, repo, ref, path] = blob
      if (!path!.toLowerCase().endsWith('.md')) {
        throw new SkillUrlError(
          'UNSUPPORTED_HOST',
          'GitHub URL must point to a `.md` file.',
        )
      }
      const canonical = `https://${GITHUB_RAW_HOST}/${owner}/${repo}/${ref}/${path}`
      return {
        canonical,
        origin: 'github',
        displayHint: `${GITHUB_HOST}/${owner}/${repo}`,
      }
    }

    const tree = parsed.pathname.match(GITHUB_TREE_PATH)
    if (tree) {
      const [, owner, repo, ref, subpath] = tree
      const canonical = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`
      return {
        canonical,
        origin: 'github-tree',
        displayHint: `${GITHUB_HOST}/${owner}/${repo}${subpath ? `/${subpath}` : ''}`,
        owner: owner!,
        repo: repo!,
        ref: ref!,
        ...(subpath ? { subpath } : {}),
      }
    }

    const repoOnly = parsed.pathname.match(GITHUB_REPO_PATH)
    if (repoOnly) {
      const [, owner, repo] = repoOnly
      if (GITHUB_RESERVED_OWNERS.has(owner!.toLowerCase())) {
        throw new SkillUrlError(
          'UNSUPPORTED_HOST',
          'github.com URL must point to a user/org repo, not a UI surface.',
        )
      }
      const canonical = `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`
      return {
        canonical,
        origin: 'github-repo',
        displayHint: `${GITHUB_HOST}/${owner}/${repo}`,
        owner: owner!,
        repo: repo!,
        ref: 'HEAD',
      }
    }

    throw new SkillUrlError(
      'UNSUPPORTED_HOST',
      'github.com URL must be a repo, a tree path, or a blob to a `.md` file.',
    )
  }

  // Already-raw GitHub URLs
  if (host === GITHUB_RAW_HOST) {
    if (!parsed.pathname.toLowerCase().endsWith('.md')) {
      throw new SkillUrlError(
        'UNSUPPORTED_HOST',
        'GitHub raw URL must point to a `.md` file.',
      )
    }
    const segments = parsed.pathname.split('/').filter(Boolean)
    const ownerRepo =
      segments.length >= 2 ? `${segments[0]}/${segments[1]}` : GITHUB_HOST
    return {
      canonical: parsed.href,
      origin: 'github',
      displayHint: `${GITHUB_HOST}/${ownerRepo}`,
    }
  }

  // Gist raw URL — pass through
  if (host === GIST_RAW_HOST) {
    if (!parsed.pathname.toLowerCase().endsWith('.md')) {
      throw new SkillUrlError(
        'UNSUPPORTED_HOST',
        'Gist raw URL must point to a `.md` file.',
      )
    }
    return {
      canonical: parsed.href,
      origin: 'gist-raw',
      displayHint: GIST_PAGE_HOST,
    }
  }

  // Gist page URL — convert to API call
  if (host === GIST_PAGE_HOST) {
    const m = parsed.pathname.match(GIST_PAGE_PATH)
    if (!m) {
      throw new SkillUrlError(
        'UNSUPPORTED_HOST',
        'Gist URL must look like https://gist.github.com/<user>/<id>.',
      )
    }
    const gistId = m[1]!
    const fileAnchor = parsed.hash.startsWith('#file-')
      ? parsed.hash.slice('#file-'.length)
      : ''
    return {
      canonical: `https://api.github.com/gists/${gistId}`,
      origin: 'gist-page',
      displayHint: GIST_PAGE_HOST,
      gistId,
      ...(fileAnchor ? { gistFileHint: fileAnchor } : {}),
    }
  }

  // Generic fallback: any HTTPS URL ending in .md is treated as raw
  if (parsed.pathname.toLowerCase().endsWith('.md')) {
    return {
      canonical: parsed.href,
      origin: 'raw',
      displayHint: parsed.hostname,
    }
  }

  throw new SkillUrlError(
    'UNSUPPORTED_HOST',
    'URL must point to a `.md` file on a supported host (GitHub, gist) or be a direct raw `.md` URL.',
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPrivateHost(host: string): boolean {
  if (PRIVATE_LITERAL_HOSTS.has(host)) return true
  if (isPrivateIPv4(host)) return true
  if (isPrivateIPv6(host)) return true
  // Hostnames ending in .localhost (RFC 6761) — never resolvable to public.
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  return false
}

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  // RFC 1918 + special ranges
  if (a === 10) return true                    // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true  // 172.16.0.0/12
  if (a === 192 && b === 168) return true      // 192.168.0.0/16
  if (a === 169 && b === 254) return true      // 169.254.0.0/16 link-local
  if (a === 127) return true                   // 127.0.0.0/8 loopback
  if (a === 0) return true                     // 0.0.0.0/8
  if (a >= 224) return true                    // multicast + reserved
  return false
}

function isPrivateIPv6(host: string): boolean {
  // URL hostnames bracket IPv6 literals; URL.hostname strips the brackets.
  const lower = host.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  // fc00::/7 — unique local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  // fe80::/10 — link-local
  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true
  return false
}
