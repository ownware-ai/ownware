/**
 * Font proxy — local-first Google Fonts.
 *
 * Design HTML references `https://fonts.googleapis.com/css2?…` and the
 * binaries it pulls from `https://fonts.gstatic.com/…`. Shipping that as-is
 * means every design phones Google (CSP-blocked in the desktop client, and a local-first
 * (#5) violation regardless). This proxy fetches each font ONCE, caches it on
 * the user's own disk, and serves it from `127.0.0.1`. After first use a
 * design's fonts are fully local and work offline.
 *
 *   GET /api/v1/fonts/css?u=<base64url(googleapis-url)>
 *     → fetch the @font-face CSS from Google, rewrite its embedded gstatic
 *       URLs to point back at /file, serve text/css.
 *   GET /api/v1/fonts/file?u=<base64url(gstatic-url)>
 *     → fetch + cache the font binary, serve it with the right mime.
 *
 * Security: `?u=` is host-locked (`parseAllowedFontUrl`) — css must decode to
 * fonts.googleapis.com, file to fonts.gstatic.com — so the param can't be
 * turned into an SSRF fetch of an arbitrary URL. Both responses carry
 * `Access-Control-Allow-Origin: *` so a null-origin sandbox iframe (srcDoc)
 * and `@font-face` (always CORS) can load them.
 *
 * Cache: the RAW Google CSS (port-independent) and the binaries live under
 * `<dataDir>/fonts-cache/`. The CSS is re-rewritten to the caller's origin
 * per request (microseconds) so a changed gateway port never serves a stale
 * absolute URL. We deliberately add no npm dep — node:crypto + node:fs only.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { sendError } from '../router.js'
import {
  FONT_CSS_HOST,
  FONT_FILE_HOST,
  decodeFontUrl,
  parseAllowedFontUrl,
  rewriteFontCss,
} from '../font-proxy/rewrite.js'

/**
 * Google serves a different `css2` payload per User-Agent (woff2 only for
 * modern browsers, ttf for old ones). We pin a current Chrome UA so the
 * cached CSS always references the compact woff2 binaries.
 */
const FONT_FETCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** Per-fetch ceiling — a font CSS/binary is small; this guards against a
 *  host that streams forever. */
const FETCH_TIMEOUT_MS = 10_000

const FILE_MIME_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.svg': 'image/svg+xml',
})

function fileMimeFor(pathname: string): string {
  const dot = pathname.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return FILE_MIME_BY_EXT[pathname.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

function hashKey(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

export function createFontsHandlers(opts: { readonly dataDir: string }) {
  const cacheDir = join(opts.dataDir, 'fonts-cache')

  async function ensureCacheDir(): Promise<void> {
    await fs.mkdir(cacheDir, { recursive: true })
  }

  /** Fetch a URL with a timeout + browser UA. Returns the Response or throws. */
  async function fetchUpstream(url: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      return await fetch(url, {
        headers: { 'User-Agent': FONT_FETCH_UA, Accept: '*/*' },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  function originOf(req: IncomingMessage): string {
    // The browser-reachable gateway origin, scheme + authority (host:PORT).
    // HTTP/2 carries these as the `:scheme` / `:authority` pseudo-headers
    // (Node exposes them as `req.scheme` / `req.authority`) and DROPS the
    // `Host` header — so the old `http://${req.headers.host}` produced a
    // port-less `http://127.0.0.1` after the TLS switch and every proxied
    // font failed. Fall back to the Host header + TLS socket for HTTP/1.
    // NOTE: duplicated in designs-raw.ts — consolidate into the transport
    // migration's origin helper.
    const r = req as IncomingMessage & { scheme?: string; authority?: string }
    const scheme =
      r.scheme ??
      ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http')
    return `${scheme}://${r.authority ?? req.headers.host ?? '127.0.0.1'}`
  }

  /** Read the `?u=` param, decode it, and host-check it. Sends the error
   *  response and returns null when invalid. */
  function readAllowedUrl(
    req: IncomingMessage,
    res: ServerResponse,
    expectedHost: typeof FONT_CSS_HOST | typeof FONT_FILE_HOST,
  ): URL | null {
    const url = new URL(req.url ?? '/', originOf(req))
    const token = url.searchParams.get('u')
    if (!token) {
      sendError(res, 400, 'Missing ?u= font URL')
      return null
    }
    const decoded = decodeFontUrl(token)
    if (decoded === null) {
      sendError(res, 400, 'Malformed ?u= font URL')
      return null
    }
    const allowed = parseAllowedFontUrl(decoded, expectedHost)
    if (!allowed) {
      sendError(res, 400, `?u= must be an https ${expectedHost} URL`)
      return null
    }
    return allowed
  }

  // GET /api/v1/fonts/css?u=<base64url(fonts.googleapis.com url)>
  async function getCss(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = readAllowedUrl(req, res, FONT_CSS_HOST)
    if (!target) return

    const cssCachePath = join(cacheDir, `css-${hashKey(target.href)}.css`)
    let rawCss: string | null = null
    try {
      rawCss = await fs.readFile(cssCachePath, 'utf8')
    } catch {
      // cache miss — fetch below
    }

    if (rawCss === null) {
      let upstream: Response
      try {
        upstream = await fetchUpstream(target.href)
      } catch (err) {
        console.error('[font-proxy] css fetch failed:', err)
        sendError(res, 502, 'Failed to reach the font provider')
        return
      }
      if (!upstream.ok) {
        sendError(res, 502, `Font provider returned ${upstream.status}`)
        return
      }
      rawCss = await upstream.text()
      try {
        await ensureCacheDir()
        await fs.writeFile(cssCachePath, rawCss, 'utf8')
      } catch (err) {
        // Cache write failure is non-fatal — we still serve this response.
        console.error('[font-proxy] css cache write failed (non-fatal):', err)
      }
    }

    // Rewrite to the CALLER's origin every time (port-independent cache).
    const body = Buffer.from(rewriteFontCss(rawCss, originOf(req)), 'utf8')
    res.writeHead(200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Content-Length': String(body.byteLength),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
    })
    res.end(body)
  }

  // GET /api/v1/fonts/file?u=<base64url(fonts.gstatic.com url)>
  async function getFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = readAllowedUrl(req, res, FONT_FILE_HOST)
    if (!target) return

    const ext = (() => {
      const dot = target.pathname.lastIndexOf('.')
      return dot < 0 ? '' : target.pathname.slice(dot).toLowerCase()
    })()
    const fileCachePath = join(cacheDir, `file-${hashKey(target.href)}${ext}`)

    let bytes: Buffer | null = null
    try {
      bytes = await fs.readFile(fileCachePath)
    } catch {
      // cache miss — fetch below
    }

    if (bytes === null) {
      let upstream: Response
      try {
        upstream = await fetchUpstream(target.href)
      } catch (err) {
        console.error('[font-proxy] file fetch failed:', err)
        sendError(res, 502, 'Failed to reach the font provider')
        return
      }
      if (!upstream.ok) {
        sendError(res, 502, `Font provider returned ${upstream.status}`)
        return
      }
      bytes = Buffer.from(await upstream.arrayBuffer())
      try {
        await ensureCacheDir()
        await fs.writeFile(fileCachePath, bytes)
      } catch (err) {
        console.error('[font-proxy] file cache write failed (non-fatal):', err)
      }
    }

    res.writeHead(200, {
      'Content-Type': fileMimeFor(target.pathname),
      'Content-Length': String(bytes.byteLength),
      'Access-Control-Allow-Origin': '*',
      // Font binaries are content-addressed by URL → safe to cache hard.
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
    res.end(bytes)
  }

  return { getCss, getFile }
}
