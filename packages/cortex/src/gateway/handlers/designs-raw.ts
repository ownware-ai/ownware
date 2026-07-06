/**
 * Ownware Design — raw subresource streaming for prototype canvases.
 *
 * Slice B2.1. ONE GET endpoint that serves a file from a design's
 * workspace folder, by path, with the correct content-type and a
 * `Access-Control-Allow-Origin: *` header so a null-origin sandbox
 * iframe (`sandbox="allow-scripts"` without `allow-same-origin`)
 * can fetch the response.
 *
 *   GET /api/v1/designs/:designId/raw/*path
 *
 * Path safety: `resolve(workspace.path, path)` is checked against a
 * `workspace.path + '/'` prefix; any path that escapes the workspace
 * root via `..` or absolute prefixes returns 400 before the file
 * system is touched. Mirrors the `seedTemplate` pattern in `designs.ts`.
 *
 * Content type: a small switch on the file extension covers the
 * mime types a prototype HTML page actually loads — html / css / js
 * / json / svg / png / jpg / gif / webp / avif / woff / woff2 / map.
 * Unknown extensions fall back to `application/octet-stream`. We
 * deliberately do not add a `mime-types` npm dependency (R12).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, promises as fs } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { sendError } from '../router.js'
import type { GatewayState } from '../state.js'
import { hasIncludes, resolveIncludes } from '../files/resolve-includes.js'
import { classifyDesignFile, type DesignFileRole } from '../files/classify-design-file.js'
import { rewriteDesignFonts } from '../font-proxy/rewrite.js'
import { CX_OVERLAY_SCRIPT } from '../preview/overlay-script.js'

/** Extensions whose bytes the canvas can render inline (so the listing
 *  carries `content`). Everything else (png/woff/…) is metadata-only —
 *  the iframe loads those via the `/raw/<path>` URL. */
const TEXT_EXTS: ReadonlySet<string> = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.map', '.svg', '.md', '.txt',
])

function isTextPath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return TEXT_EXTS.has(path.slice(dot).toLowerCase())
}

const MIME_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
})

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  const ext = path.slice(dot).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** Inject the preview selection overlay just before `</body>` (or append when
 *  there's no close tag). The overlay attaches the click-to-select / pin /
 *  live-token-preview bridge that postMessages the renderer. Mirrors the
 *  client's srcDoc-builder injection so the URL-load and srcDoc preview paths
 *  behave identically. */
function injectOverlay(html: string): string {
  const tag = `<script>${CX_OVERLAY_SCRIPT}</script>`
  const close = /<\/body\s*>/i.exec(html)
  if (close) return html.slice(0, close.index) + tag + html.slice(close.index)
  return html + tag
}

export function createDesignsRawHandlers(state: GatewayState) {
  // GET /api/v1/designs/:designId/raw/*path
  async function getRaw(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const designId = params['designId']!
    const rawPath = params['path']!

    const design = state.getDesign(designId)
    if (!design) {
      sendError(res, 404, `Design "${designId}" not found`)
      return
    }

    const workspace = state.getWorkspace(design.workspaceId)
    if (!workspace) {
      // Cascading workspace delete normally takes the design row with
      // it, so this branch is reachable only from a corrupted DB.
      // Mirror `designs.ts:seedTemplate`'s shape — 404 with a clear
      // message — instead of inventing a 500.
      sendError(res, 404, `Workspace "${design.workspaceId}" not found`)
      return
    }

    // Defense in depth — the router URL-normalises `..` before the
    // pattern sees the path, and the param guard rejects raw `..` /
    // null bytes / encoded slashes. Even with both, we resolve against
    // the workspace root and refuse any result that doesn't start
    // with the root + `/`. An absolute path (e.g. `/etc/passwd`)
    // resolves to itself and fails the prefix check.
    const workspaceRoot = resolve(workspace.path)
    const absolute = resolve(workspaceRoot, rawPath)
    if (
      absolute !== workspaceRoot &&
      !absolute.startsWith(workspaceRoot + '/')
    ) {
      sendError(res, 400, 'Path escapes the design workspace')
      return
    }

    let stat
    try {
      stat = await fs.stat(absolute)
    } catch {
      sendError(res, 404, `File "${rawPath}" not found in design workspace`)
      return
    }
    if (!stat.isFile()) {
      sendError(res, 404, `Path "${rawPath}" is not a file`)
      return
    }

    const isHtml = /\.html?$/i.test(rawPath)
    const corsCache = {
      // Null-origin sandbox iframes (`sandbox="allow-scripts"` only)
      // need `*` to fetch subresources; routes that use credentials
      // would need an explicit origin, but raw design files do not.
      'Access-Control-Allow-Origin': '*',
      // Short cache window — the file watcher reflects the agent's
      // writeFile within ~250ms; `no-store` keeps the canvas honest.
      'Cache-Control': 'no-store',
    } as const

    // CX1 T3.S2 — shared parts. An HTML page may include reusable parts
    // via `<!-- cx:include parts/sidebar.html -->`. We read the page, and
    // if it has includes, stitch them in before serving so the user edits
    // a part ONCE and every page that includes it updates. Non-HTML and
    // include-free HTML take the cheap stream path unchanged.
    if (isHtml) {
      let pageText: string
      try {
        pageText = await fs.readFile(absolute, 'utf8')
      } catch {
        sendError(res, 404, `File "${rawPath}" not found in design workspace`)
        return
      }
      let body = hasIncludes(pageText)
        ? await resolveIncludes(pageText, makePartLoader(workspaceRoot))
        : pageText
      // Opt-in font proxying for the URL-load preview render. Only the
      // preview iframe src passes `?fonts=proxy`; the file-watcher's
      // `readRaw` (no param) gets the pristine document, so the editable
      // file map is never mutated. Applied AFTER include resolution so
      // font links inside included parts are caught too.
      // Browser-reachable gateway origin (scheme + host:PORT). HTTP/2 drops
      // the `Host` header in favour of the `:scheme` / `:authority` pseudo-
      // headers (exposed as req.scheme / req.authority); the old
      // `http://${req.headers.host}` went port-less + wrong-scheme after the
      // TLS switch and broke every proxied font. NOTE: same logic as
      // fonts.ts `originOf` — consolidate into the transport migration's
      // origin helper.
      const r = req as typeof req & { scheme?: string; authority?: string }
      const origin = `${
        r.scheme ??
        ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http')
      }://${r.authority ?? req.headers.host ?? '127.0.0.1'}`
      const reqUrl = new URL(req.url ?? '/', origin)
      if (reqUrl.searchParams.get('fonts') === 'proxy') {
        body = rewriteDesignFonts(body, origin)
      }
      // Opt-in selection overlay for the INTERACTIVE preview iframe. Only the
      // canvas preview passes `?overlay=1` (the thumbnail capturer and
      // open-in-browser deliberately do NOT), so captures/exports stay clean.
      // Injecting the SAME overlay the srcDoc path uses is what gives
      // multi-file (URL-load) designs the click-to-select / pin / live-token
      // bridge that single-file srcDoc designs already had. The overlay is
      // origin-agnostic (posts to parent with `'*'`, filters by source), so it
      // works across the loopback-origin iframe → renderer boundary.
      if (reqUrl.searchParams.get('overlay') === '1') {
        body = injectOverlay(body)
      }
      const buf = Buffer.from(body, 'utf8')
      res.writeHead(200, {
        'Content-Type': contentTypeFor(rawPath),
        'Content-Length': String(buf.byteLength),
        ...corsCache,
      })
      res.end(buf)
      return
    }

    res.writeHead(200, {
      'Content-Type': contentTypeFor(rawPath),
      'Content-Length': String(stat.size),
      ...corsCache,
    })
    const stream = createReadStream(absolute)
    stream.on('error', () => {
      // Headers already sent — best we can do is drop the connection
      // so the client treats it as a transport error rather than a
      // truncated success.
      res.destroy()
    })
    stream.pipe(res)
  }

  // Build a part loader bound to a design's workspace root. Resolves a
  // part's relative path with the SAME root-prefix safety as getRaw — a
  // part path that escapes the workspace (`..`, absolute) returns null
  // (rendered as a visible include error), never reads outside the folder.
  function makePartLoader(workspaceRoot: string) {
    return async (relPath: string): Promise<string | null> => {
      const abs = resolve(workspaceRoot, relPath)
      if (abs !== workspaceRoot && !abs.startsWith(workspaceRoot + '/')) {
        return null
      }
      try {
        const stat = await fs.stat(abs)
        if (!stat.isFile()) return null
        return await fs.readFile(abs, 'utf8')
      } catch {
        return null
      }
    }
  }

  // GET /api/v1/designs/:designId/files
  //
  // Authoritative disk listing of the design's workspace folder. The
  // canvas seeds its file map from THIS (disk), not from replayed chat
  // tool-calls — so a `writeFile` the model emitted but never executed
  // (permission denied, run errored, model auth failed) can no longer
  // show as a phantom "saved" file. Text files carry inline `content`;
  // binary / oversized files carry metadata only (the iframe loads them
  // via the `/raw/<path>` URL). Bounded walk — a pathological tree can't
  // hang the gateway.
  async function getFiles(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const designId = params['designId']!
    const design = state.getDesign(designId)
    if (!design) {
      sendError(res, 404, `Design "${designId}" not found`)
      return
    }
    const workspace = state.getWorkspace(design.workspaceId)
    if (!workspace) {
      sendError(res, 404, `Workspace "${design.workspaceId}" not found`)
      return
    }

    const root = resolve(workspace.path)
    const MAX_FILES = 500
    const MAX_DEPTH = 12
    const MAX_INLINE_BYTES = 1_000_000

    interface DesignFileEntry {
      readonly path: string
      readonly size: number
      readonly lastModified: number
      readonly role: DesignFileRole
      content?: string
    }
    const files: DesignFileEntry[] = []

    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) return
        if (
          entry.name === '.git' ||
          entry.name === 'node_modules' ||
          entry.name === '.DS_Store' ||
          // Generated thumbnail captures — internal artifacts, not design
          // files. Excluding them keeps the canvas file map honest AND stops
          // a capture (which writes here) from showing up as a "file change"
          // that would re-trigger the capture pass.
          entry.name === '.thumbs' ||
          entry.name === '.thumb.png'
        ) {
          continue
        }
        const abs = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(abs, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        let stat
        try {
          stat = await fs.stat(abs)
        } catch {
          continue
        }
        const rel = relative(root, abs)
        let content: string | undefined
        if (isTextPath(rel) && stat.size <= MAX_INLINE_BYTES) {
          try {
            content = await fs.readFile(abs, 'utf8')
          } catch {
            // Leave content undefined — the client falls back to /raw.
          }
        }
        const file: DesignFileEntry = {
          path: rel,
          size: stat.size,
          lastModified: stat.mtimeMs,
          // Role is the file's own type + structure, never its folder —
          // see classify-design-file.ts. Computed here and sent on the
          // wire so the client never re-derives it from a path.
          role: classifyDesignFile(rel, content),
          ...(content !== undefined ? { content } : {}),
        }
        files.push(file)
      }
    }
    await walk(root, 0)

    files.sort((a, b) => a.path.localeCompare(b.path))
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ files }))
  }

  // PUT /api/v1/designs/:designId/thumbnail[?page=<path>]
  //
  // Writes a server-side capture the canvas/lobby tiles render back via the
  // `/raw/...` URL. Raw `image/png` body — Electron's offscreen `capturePage()`
  // produces PNG bytes, and a dedicated binary endpoint avoids base64-bloating
  // them through the JSON write path.
  //
  // Per-page (`?page=pricing.html`) → writes `<root>/.thumbs/pricing.html.png`
  // so every page tile shows its OWN snapshot. The page path is resolved under
  // the workspace and prefix-checked (same guard as `getRaw`), so a `..` /
  // absolute page can't escape the folder. Omitting `page` writes the legacy
  // `<root>/.thumb.png` (kept for any caller that hasn't moved to per-page).
  async function putThumbnail(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const designId = params['designId']!
    const design = state.getDesign(designId)
    if (!design) {
      sendError(res, 404, `Design "${designId}" not found`)
      return
    }
    const workspace = state.getWorkspace(design.workspaceId)
    if (!workspace) {
      sendError(res, 404, `Workspace "${design.workspaceId}" not found`)
      return
    }

    const MAX_THUMB_BYTES = 10_000_000 // a viewport PNG is well under this.
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    try {
      await new Promise<void>((resolveBody, rejectBody) => {
        req.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > MAX_THUMB_BYTES) {
            aborted = true
            rejectBody(new Error('Thumbnail exceeds size limit'))
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => resolveBody())
        req.on('error', rejectBody)
      })
    } catch {
      if (!res.headersSent) {
        sendError(res, aborted ? 413 : 400, 'Failed to read thumbnail body')
      }
      return
    }

    const bytes = Buffer.concat(chunks)
    // PNG magic number — reject anything that isn't actually a PNG so a
    // bad caller can't drop arbitrary bytes into the workspace.
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIG)) {
      sendError(res, 400, 'Body is not a PNG')
      return
    }

    // Per-page (`?page=`) → `.thumbs/<page>.png`; else legacy `.thumb.png`.
    const workspaceRoot = resolve(workspace.path)
    const page = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? '127.0.0.1'}`,
    ).searchParams.get('page')
    let target: string
    if (page != null && page.length > 0) {
      target = resolve(workspaceRoot, join('.thumbs', `${page}.png`))
      // Same root-prefix guard as getRaw — a `..` / absolute page can't
      // write outside the design workspace.
      if (!target.startsWith(workspaceRoot + '/')) {
        sendError(res, 400, 'Thumbnail page escapes the design workspace')
        return
      }
    } else {
      target = join(workspaceRoot, '.thumb.png')
    }
    try {
      await fs.mkdir(dirname(target), { recursive: true })
      await fs.writeFile(target, bytes)
    } catch (err) {
      sendError(
        res,
        500,
        `Failed to write thumbnail: ${err instanceof Error ? err.message : String(err)}`,
      )
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ designId, page: page ?? null, bytes: bytes.length }))
  }

  return { getRaw, getFiles, putThumbnail }
}
