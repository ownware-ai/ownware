/**
 * Ownware Design — deterministic file-role classification.
 *
 * A design workspace holds three kinds of artifact plus passive assets.
 * The client needs to know which is which to decide what it can PREVIEW
 * (pages), what to list as a REUSABLE PIECE (components), what loads only
 * as a SUBRESOURCE and must never open (the stylesheet), and what is an
 * inert asset. Historically the UI inferred this client-side by
 * string-matching paths (`endsWith('.html')`, `=== 'styles.css'`,
 * `startsWith('parts/')`) — folder-convention hardcoding scattered across
 * every surface, and the source of the "styles.css shown as a page" /
 * "component listed as a page" bugs.
 *
 * Instead the role is computed ONCE, here, and travels on the wire as a
 * typed field on each design file. The client reads `file.role` and never
 * looks at a path again.
 *
 * Determinism — role is a property of the artifact, never of its folder:
 *
 *   - `stylesheet` / `asset` — the file's TYPE. A `.css` file IS a
 *     stylesheet wherever it sits; everything non-HTML/non-CSS (js, svg,
 *     png, woff, json sidecars, …) is a passive asset the page may load.
 *     100% by type, no inference.
 *
 *   - `page` vs `component` — the file's STRUCTURE. A page is a COMPLETE
 *     HTML document (the browser can load it standalone); a component is a
 *     FRAGMENT (only meaningful when `cx:include`-d into a page). For
 *     `product-design` output this is not a heuristic: the write gate
 *     guarantees `write_page` emits a complete document and
 *     `write_component` emits a fragment, so the structural check can
 *     never disagree with the producing tool's intent. The determinism is
 *     sourced from the gate-enforced WRITE, not from sniffing-and-hoping
 *     on READ.
 *
 *   - `unknown` — an HTML file whose bytes we couldn't read (binary /
 *     oversized) or that is empty. Honest-unknown (Principle 21) beats a
 *     confident mislabel: the client renders it as an inert "unrecognised"
 *     entry, never as a page. Files produced outside the constrained
 *     tools (raw `writeFile`, hand-drops) still classify by structure;
 *     only the genuinely unreadable land here.
 */

export type DesignFileRole = 'page' | 'component' | 'stylesheet' | 'asset' | 'unknown'

const HTML_EXTS: ReadonlySet<string> = new Set(['.html', '.htm'])

/** Lowercased extension including the leading dot (`.css`), or `''` when
 *  the basename has no extension. Dotfiles (`.gitignore`) count as no
 *  extension, not as an extension of their whole name. */
function extensionOf(path: string): string {
  const slash = path.lastIndexOf('/')
  const name = slash >= 0 ? path.slice(slash + 1) : path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/**
 * True when an HTML source is a COMPLETE document — it begins, after any
 * BOM / leading whitespace / leading HTML comments, with `<!doctype` or
 * `<html`. A fragment begins with any other element (`<header>`, `<div>`,
 * …). Leading comments are skipped because a page may open with a license
 * banner and a fragment may open with a note — neither changes what the
 * file fundamentally is.
 */
export function htmlIsCompleteDocument(content: string): boolean {
  let s = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  for (;;) {
    const before = s
    s = s.replace(/^\s+/, '')
    if (s.startsWith('<!--')) {
      const end = s.indexOf('-->')
      s = end >= 0 ? s.slice(end + 3) : ''
    }
    if (s === before) break
  }
  const head = s.slice(0, 64).toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html')
}

/**
 * Classify a design workspace file by role. `content` is the file's text,
 * or `undefined` for binary / oversized files that were not inlined by the
 * listing walk.
 *
 * Pure and synchronous — directly unit-testable, and cheap enough to run
 * for every file on every listing.
 */
export function classifyDesignFile(path: string, content?: string): DesignFileRole {
  const ext = extensionOf(path)

  // Stylesheet — by type, not by name. The design's token home is
  // `styles.css` today, but ANY `.css` file is a stylesheet.
  if (ext === '.css') return 'stylesheet'

  // HTML — page vs component by document-vs-fragment structure.
  if (HTML_EXTS.has(ext)) {
    if (content === undefined || content.trim() === '') return 'unknown'
    return htmlIsCompleteDocument(content) ? 'page' : 'component'
  }

  // Everything else is a passive static asset the page may load.
  return 'asset'
}
