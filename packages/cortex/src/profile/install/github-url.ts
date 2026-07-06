/**
 * GitHub URL parser + safety allowlist.
 *
 * The install primitive accepts GitHub URLs only. Anything else (ssh://,
 * file://, http://, raw IPs, gists) is rejected at parse time so the rest of
 * the pipeline never sees an attacker-controlled scheme. Keeping the
 * allowlist explicit and small is part of Phase 1's security gate #6.
 *
 * Returns a normalised `{ owner, repo, ref? }` shape. Callers that need the
 * canonical clone URL build it from these three fields, never by passing the
 * user's raw URL further down.
 */

import { InstallError } from './errors.js'

export interface GithubUrl {
  /** Repo owner (user or org). */
  readonly owner: string
  /** Repo name, with no `.git` suffix and no trailing slash. */
  readonly repo: string
  /** Optional explicit ref (branch / tag / sha). Comes from `?ref=` query
   *  param when present in the URL. The CLI / handler can also pass `ref`
   *  out-of-band; this field lets a single URL carry it too. */
  readonly ref?: string
}

/**
 * Parse and validate a GitHub URL. Throws `InstallError('invalid_url', ...)`
 * if the URL is not on the allowlisted shape.
 *
 * Allowlist (and ONLY the allowlist):
 *   - https://github.com/<owner>/<repo>
 *   - https://github.com/<owner>/<repo>.git
 *   - https://github.com/<owner>/<repo>/        (trailing slash tolerated)
 *   - https://github.com/<owner>/<repo>?ref=<ref>
 *   - https://github.com/<owner>/<repo>/tree/<ref>      (UI URL form)
 *
 * Rejects:
 *   - non-https schemes (ssh://, git://, file://, http://, javascript:, …)
 *   - any host other than github.com (case-insensitive)
 *   - userinfo in URL (https://user:pass@github.com/...)
 *   - path segments outside owner/repo (e.g. /enterprise/<host>/<owner>/<repo>)
 *   - owner or repo names that fail GitHub's naming rules
 *   - empty / whitespace-only input
 */
export function parseGithubUrl(input: string): GithubUrl {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    throw new InstallError('invalid_url', { url: input })
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new InstallError('invalid_url', { url: input })
  }

  // Scheme allowlist — https only. No http (downgrade), no ssh, no git, no
  // file. The whole point of being explicit here is to never let an
  // attacker-controlled scheme reach the git binary.
  if (url.protocol !== 'https:') {
    throw new InstallError('invalid_url', { url: input })
  }

  // Userinfo (https://user:pass@github.com/...) — refuse. Tokens belong in
  // the auth headers / CLI flag, never in the URL where they end up in
  // process listings, shell history, and access logs.
  if (url.username !== '' || url.password !== '') {
    throw new InstallError('invalid_url', { url: input })
  }

  // Host MUST be exactly github.com. Case-insensitive (URL parser
  // lowercases hostname already, but be defensive). No GHE for now —
  // future support can extend the allowlist with explicit operator opt-in.
  if (url.hostname.toLowerCase() !== 'github.com') {
    throw new InstallError('invalid_url', { url: input })
  }

  // No port — github.com is always 443.
  if (url.port !== '') {
    throw new InstallError('invalid_url', { url: input })
  }

  // Split path. Permitted shapes:
  //   /<owner>/<repo>
  //   /<owner>/<repo>/
  //   /<owner>/<repo>/tree/<ref>
  // We tolerate `.git` suffix on repo and a trailing slash. We do NOT
  // tolerate '..' segments or empty middle segments — URL.pathname
  // collapses those but we double-check.
  const segments = url.pathname.split('/').filter((s) => s !== '')
  if (segments.length < 2) {
    throw new InstallError('invalid_url', { url: input })
  }
  if (segments.some((s) => s === '..' || s === '.')) {
    throw new InstallError('invalid_url', { url: input })
  }

  const owner = segments[0]!
  let repo = segments[1]!.endsWith('.git') ? segments[1]!.slice(0, -4) : segments[1]!

  let refFromPath: string | undefined
  if (segments.length > 2) {
    if (segments.length === 4 && segments[2] === 'tree') {
      refFromPath = segments[3]
    } else {
      throw new InstallError('invalid_url', { url: input })
    }
  }

  if (!isValidGithubName(owner) || !isValidGithubName(repo)) {
    throw new InstallError('invalid_url', { url: input })
  }

  // ?ref=<ref> alternative
  const refFromQuery = url.searchParams.get('ref') ?? undefined
  if (refFromQuery !== undefined && !isValidRef(refFromQuery)) {
    throw new InstallError('invalid_url', { url: input })
  }
  if (refFromPath !== undefined && !isValidRef(refFromPath)) {
    throw new InstallError('invalid_url', { url: input })
  }

  // If both supplied and they disagree, prefer path form. (UI URL is what
  // the user copied from the browser address bar.)
  const ref = refFromPath ?? refFromQuery

  return ref !== undefined
    ? { owner, repo, ref }
    : { owner, repo }
}

/**
 * Build the canonical clone URL from a parsed GithubUrl. Always
 * `https://github.com/<owner>/<repo>.git` — never re-emits the user's raw
 * input, never includes the ref (refs are passed via `git clone --branch`).
 */
export function toCloneUrl(parsed: GithubUrl): string {
  return `https://github.com/${parsed.owner}/${parsed.repo}.git`
}

/**
 * Identifier we use as the on-disk namespace prefix for the installed
 * profile dir. See decision 2 in `2026-05-06-decisions.md`. Returns the
 * `<owner>__<repo>` form. Filesystem-safe on macOS, Linux, and Windows;
 * GitHub names can never produce a collision with the separator since
 * neither owners nor repos may contain `__`-internal sequences in a way
 * that round-trips ambiguously (the separator is fixed and the namer
 * always splits on the first `__`).
 */
export function namespacedDirPrefix(parsed: GithubUrl): string {
  return `${parsed.owner}__${parsed.repo}`
}

/**
 * Display name shown in UI and stored as the registry key. `<owner>/<repo>`.
 */
export function displayName(parsed: GithubUrl): string {
  return `${parsed.owner}/${parsed.repo}`
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * GitHub name rules:
 *   - 1..39 chars
 *   - alphanumerics, hyphen, underscore, dot
 *   - cannot start or end with hyphen / dot
 *   - cannot contain consecutive dots (would let `..` slip in transformed)
 *
 * The regex below is conservative — it errs on the side of rejecting weird
 * names. Real GitHub names that this rejects are exceedingly rare; we'd
 * rather a user copy-paste a slightly different URL than let a malformed
 * name through.
 */
function isValidGithubName(name: string): boolean {
  if (name.length === 0 || name.length > 39) return false
  if (name.startsWith('-') || name.endsWith('-')) return false
  if (name.startsWith('.') || name.endsWith('.')) return false
  if (name.includes('..')) return false
  return /^[A-Za-z0-9._-]+$/.test(name)
}

/**
 * Git ref naming rules — partial allowlist sufficient for our use:
 *   - 1..255 chars
 *   - alphanumerics, hyphen, underscore, dot, slash
 *   - no leading/trailing slash, no leading/trailing dot
 *   - no `..`, no `@{`, no whitespace, no control chars
 *   - no leading hyphen (would be parsed as a git CLI flag)
 *
 * git's full reference-name rules are baroque (see git-check-ref-format).
 * We don't need to reproduce them exhaustively; the conservative subset
 * here catches every name we'd want to accept and rejects every form that
 * could be weaponised at the CLI boundary.
 */
function isValidRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > 255) return false
  if (ref.startsWith('-')) return false
  if (ref.startsWith('/') || ref.endsWith('/')) return false
  if (ref.startsWith('.') || ref.endsWith('.')) return false
  if (ref.includes('..') || ref.includes('@{')) return false
  if (/\s/.test(ref)) return false
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(ref)) return false
  return /^[A-Za-z0-9._/-]+$/.test(ref)
}
