/**
 * resolve-includes — stitch reusable HTML parts into a page at serve time.
 *
 * CX1 · T3.S2 (engine B — shared parts). A multi-page design reuses
 * structure (a sidebar, a header) across pages by writing it ONCE as a
 * part file and including it from each page:
 *
 *     <!-- cx:include parts/sidebar.html -->
 *
 * When the gateway serves a page to the preview (`designs-raw.ts:getRaw`),
 * it replaces each directive with the part's HTML. So the user edits
 * `parts/sidebar.html` once and every page that includes it updates — the
 * whole point of "change once → everywhere" — with NO build step: the
 * iframe still receives one ordinary HTML document.
 *
 * This module is PURE: it takes the page HTML + a `loadPart(relPath)`
 * function and returns the stitched HTML. The caller owns filesystem +
 * path-safety (so this stays unit-testable without a gateway/DB — it does
 * not import zod or any gateway state). `loadPart` returns the part's text
 * or `null` if it's missing / unreadable / unsafe.
 *
 * Fail-VISIBLE (Principle 1 + 21): a missing or cyclic include renders a
 * clear inline error box in the page, never a blank page and never a
 * silently-dropped directive. The user (and the agent on the next turn)
 * sees exactly what's wrong and where.
 *
 * Nesting: a part may itself include parts, up to MAX_INCLUDE_DEPTH.
 * Cycles (A includes B includes A) are detected per resolution chain and
 * rendered as a visible error rather than looping.
 */

/** Matches `<!-- cx:include <path> -->` with flexible whitespace. The
 *  path is everything up to the closing `-->`, trimmed. The path must
 *  start with a non-whitespace, non-`>` char so an empty directive
 *  (`<!-- cx:include  -->`) simply doesn't match (stays literal) rather
 *  than capturing whitespace.
 *
 *  IMPORTANT: this is a SOURCE pattern, not a shared `/g` instance — a
 *  global regex carries mutable `lastIndex` state that leaks across calls
 *  (and across the `hasIncludes` test() path). Each function that scans
 *  builds a fresh `RegExp` from this source so there's no shared state. */
const INCLUDE_SOURCE = '<!--\\s*cx:include\\s+([^>\\s][^>]*?)\\s*-->'
function includeRe(): RegExp {
  return new RegExp(INCLUDE_SOURCE, 'g')
}

const MAX_INCLUDE_DEPTH = 8

/** Loader the caller supplies: resolve a part's relative path to its text,
 *  or null when it can't be served (missing / unreadable / escapes root). */
export type LoadPart = (relPath: string) => Promise<string | null>

/** A visible, self-contained error block injected in place of a bad
 *  include. Inline-styled so it shows even if the page's CSS hasn't loaded;
 *  the `data-cx-include-error` hook lets tooling/tests find it. */
function errorBlock(message: string): string {
  const safe = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return (
    `<div data-cx-include-error style="` +
    `margin:8px;padding:10px 12px;border:1px solid #F14060;border-radius:8px;` +
    `background:rgba(241,64,96,0.08);color:#F14060;` +
    `font:13px/1.5 ui-monospace,Menlo,monospace;">` +
    `⚠ Include error: ${safe}</div>`
  )
}

/** True when the HTML contains at least one `cx:include` directive — lets
 *  callers cheaply decide whether resolution (or URL-load) is needed. */
export function hasIncludes(html: string): boolean {
  return includeRe().test(html)
}

/**
 * Resolve every `cx:include` directive in `html`. Pure aside from the
 * injected `loadPart` (which the caller backs with the filesystem).
 *
 * @param html     the page HTML as written on disk
 * @param loadPart resolves a part's relative path → its text, or null
 * @returns the stitched HTML (bad includes become visible error blocks)
 */
export async function resolveIncludes(
  html: string,
  loadPart: LoadPart,
): Promise<string> {
  return resolveInner(html, loadPart, [], 0)
}

async function resolveInner(
  html: string,
  loadPart: LoadPart,
  chain: readonly string[],
  depth: number,
): Promise<string> {
  // Snapshot all directives before mutating the string (we await between
  // matches). A fresh regex per call → no shared lastIndex state.
  const re = includeRe()
  const matches: Array<{ full: string; path: string }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    matches.push({ full: m[0], path: (m[1] ?? '').trim() })
  }
  if (matches.length === 0) return html

  // Resolve each unique directive once; reuse for repeated occurrences.
  const resolved = new Map<string, string>()
  for (const { full, path } of matches) {
    if (resolved.has(full)) continue
    resolved.set(full, await resolveOne(path, loadPart, chain, depth))
  }

  // Replace every occurrence. Plain string replace (not regex) so the
  // part's own content — which may contain `$&`, backreference-like text,
  // or further directives already expanded — is inserted verbatim.
  let out = html
  for (const [full, replacement] of resolved) {
    out = out.split(full).join(replacement)
  }
  return out
}

async function resolveOne(
  path: string,
  loadPart: LoadPart,
  chain: readonly string[],
  depth: number,
): Promise<string> {
  if (path === '') {
    return errorBlock('empty include path')
  }
  if (depth >= MAX_INCLUDE_DEPTH) {
    return errorBlock(`include nesting too deep (> ${String(MAX_INCLUDE_DEPTH)}) at "${path}"`)
  }
  if (chain.includes(path)) {
    return errorBlock(`circular include: ${[...chain, path].join(' → ')}`)
  }

  let part: string | null
  try {
    part = await loadPart(path)
  } catch {
    part = null
  }
  if (part === null) {
    return errorBlock(`part not found: "${path}"`)
  }

  // A part may itself include parts — recurse with this path on the chain.
  return resolveInner(part, loadPart, [...chain, path], depth + 1)
}
