/**
 * Font-proxy URL rewriting — the pure string transforms that point a
 * design's Google-Fonts references at the LOCAL gateway proxy instead of
 * Google's CDN.
 *
 * Why this exists: design HTML (our templates AND agent-written pages)
 * `<link>`s `https://fonts.googleapis.com/css2?…`, which then pulls font
 * binaries from `https://fonts.gstatic.com/…`. In a desktop-client preview that's
 * blocked by CSP and — more importantly — violates local-first (#5): every
 * design would phone Google. The proxy fetches each font once, caches it on
 * the USER's own disk, and serves it from `127.0.0.1`. These functions
 * rewrite the references so the browser asks the proxy, never Google.
 *
 * Isomorphic by design: this module is imported BOTH by the cortex gateway
 * (Node) — for the URL-load render path — AND by the client's srcDoc builders
 * (browser, via the `@cortex/gateway/*` alias). So it uses only `btoa`/
 * `atob` + regex, never `Buffer`, and has zero Node imports.
 *
 * Security: the proxy is host-locked. `css` requests must decode to a
 * `fonts.googleapis.com` URL; `file` requests to `fonts.gstatic.com`. The
 * encode/decode + allowlist helpers here are the single source of truth for
 * that contract — the handler validates against the SAME constants.
 */

/** Host that serves the `@font-face` CSS (the `css2?family=…` API). */
export const FONT_CSS_HOST = 'fonts.googleapis.com'
/** Host that serves the actual font binaries the CSS references. */
export const FONT_FILE_HOST = 'fonts.gstatic.com'

/** Proxy route bases. Kept here so rewrite + handler + tests agree. */
export const FONT_CSS_PATH = '/api/v1/fonts/css'
export const FONT_FILE_PATH = '/api/v1/fonts/file'

/**
 * URL-safe base64 of an absolute URL, for the `?u=` proxy param. ASCII-only
 * input (font URLs always are) keeps `btoa` safe without a TextEncoder dance.
 */
export function encodeFontUrl(url: string): string {
  return btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Inverse of {@link encodeFontUrl}. Returns null on malformed input. */
export function decodeFontUrl(token: string): string | null {
  try {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/')
    return atob(b64)
  } catch {
    return null
  }
}

/**
 * Validate a decoded proxy URL against the expected host. Returns the parsed
 * URL when the protocol is https and the host matches exactly; null otherwise.
 * This is the SSRF gate — a `?u=` pointing anywhere but the allowed font host
 * is refused before any `fetch` happens.
 */
export function parseAllowedFontUrl(
  decoded: string,
  expectedHost: typeof FONT_CSS_HOST | typeof FONT_FILE_HOST,
): URL | null {
  let parsed: URL
  try {
    parsed = new URL(decoded)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.hostname !== expectedHost) return null
  return parsed
}

/**
 * Rewrite every `https://fonts.gstatic.com/…` reference inside a Google
 * `@font-face` stylesheet to point at the local file proxy. Used by the css
 * handler on the response it fetched from Google before serving it on.
 */
export function rewriteFontCss(css: string, origin: string): string {
  const base = stripTrailingSlash(origin)
  return css.replace(/https:\/\/fonts\.gstatic\.com\/[^"')\s]+/g, (match) => {
    return `${base}${FONT_FILE_PATH}?u=${encodeFontUrl(match)}`
  })
}

/**
 * Rewrite a design HTML document's Google-Fonts references to the local proxy.
 *
 * Two transforms:
 *   1. Strip `<link rel="preconnect|dns-prefetch">` hints that point at
 *      Google's font hosts — they only warm a connection we no longer make,
 *      and left in place they'd CSP-error in the console (the exact noise
 *      we're removing).
 *   2. Repoint every `https://fonts.googleapis.com/<path>?<query>` reference
 *      (stylesheet `<link href>`, `@import`, anywhere) at the css proxy,
 *      preserving the original URL inside `?u=` so the proxy can fetch the
 *      same fonts on the user's behalf.
 *
 * `origin` is the gateway base the browser can reach (`http://127.0.0.1:<port>`).
 * Pure + idempotent on already-rewritten input (a proxied URL contains no
 * `fonts.googleapis.com`, so the second pass is a no-op).
 */
export function rewriteDesignFonts(html: string, origin: string): string {
  if (!html.includes(FONT_CSS_HOST) && !html.includes(FONT_FILE_HOST)) {
    return html
  }
  const base = stripTrailingSlash(origin)

  // 1. Drop preconnect / dns-prefetch links to Google's font hosts.
  const PRECONNECT_RE =
    /<link\b(?=[^>]*\brel\s*=\s*["']?(?:preconnect|dns-prefetch))[^>]*\bhref\s*=\s*["'][^"']*fonts\.(?:googleapis|gstatic)\.com[^"']*["'][^>]*>\s*/gi
  let out = html.replace(PRECONNECT_RE, '')

  // 2. Repoint stylesheet references to the css proxy.
  out = out.replace(
    /https:\/\/fonts\.googleapis\.com\/[^"')\s]+/g,
    (match) => `${base}${FONT_CSS_PATH}?u=${encodeFontUrl(match)}`,
  )
  return out
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '')
}
