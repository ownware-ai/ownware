/**
 * Font proxy — integration test driving the REAL handler.
 *
 * Proves the local-first font path end-to-end without booting the full
 * gateway (which needs the native sqlite module): the handler factory takes
 * `(req, res)` directly, so we call it with mock req/res over a temp cache
 * dir. The fetch, on-disk cache, gstatic→/file rewrite, and `?u=` host-lock
 * are all the production code paths.
 *
 *   1. GET /api/v1/fonts/css fetches Google's @font-face CSS and serves it
 *      back with every gstatic URL rewritten to the local /file proxy.
 *   2. A rewritten /file URL streams the actual woff2 binary.
 *   3. The second css request is served from the on-disk cache (no refetch).
 *   4. The `?u=` host-lock refuses a non-allowlisted host (SSRF guard).
 *
 * Happy-path cases hit Google's CDN — they self-skip when offline (mirrors
 * the repo's `skipIf(!ANTHROPIC_API_KEY)` rule). The SSRF + validation cases
 * need no network.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFontsHandlers } from '../../../src/gateway/handlers/fonts.js'
import { encodeFontUrl } from '../../../src/gateway/font-proxy/rewrite.js'

const HOST = '127.0.0.1:3011'
const ORIGIN = `http://${HOST}`
const INTER_CSS =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap'

interface Captured {
  status: number
  headers: Record<string, string>
  body: Buffer
}

function mockReq(path: string): IncomingMessage {
  return { url: path, headers: { host: HOST } } as unknown as IncomingMessage
}

/** Minimal ServerResponse capturing writeHead(status, headers) + end(body). */
function mockRes(): { res: ServerResponse; done: Promise<Captured> } {
  let resolve!: (c: Captured) => void
  const done = new Promise<Captured>((r) => (resolve = r))
  let status = 0
  let headers: Record<string, string> = {}
  const res = {
    writeHead(s: number, h?: Record<string, string>) {
      status = s
      if (h) headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)]))
      return res
    },
    end(body?: string | Buffer) {
      const buf = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body)
      resolve({ status, headers, body: buf })
    },
  } as unknown as ServerResponse
  return { res, done }
}

let cacheRoot: string
let fonts: ReturnType<typeof createFontsHandlers>
let online = false

async function getCss(url: string): Promise<Captured> {
  const { res, done } = mockRes()
  await fonts.getCss(mockReq(url), res)
  return done
}
async function getFile(url: string): Promise<Captured> {
  const { res, done } = mockRes()
  await fonts.getFile(mockReq(url), res)
  return done
}

beforeAll(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), 'cortex-fonts-'))
  fonts = createFontsHandlers({ dataDir: cacheRoot })
  try {
    const probe = await fetch('https://fonts.googleapis.com/css2?family=Inter', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    })
    online = probe.ok || probe.status === 400 // any HTTP answer = reachable
  } catch {
    online = false
  }
})

afterAll(async () => {
  await rm(cacheRoot, { recursive: true, force: true })
})

describe('font proxy handler', () => {
  it('serves css with gstatic URLs rewritten to the local file proxy', async (ctx) => {
    if (!online) ctx.skip()
    const out = await getCss(`/api/v1/fonts/css?u=${encodeFontUrl(INTER_CSS)}`)
    expect(out.status).toBe(200)
    expect(out.headers['content-type']).toContain('text/css')
    expect(out.headers['access-control-allow-origin']).toBe('*')

    const css = out.body.toString('utf8')
    expect(css).toContain('@font-face')
    expect(css).not.toContain('fonts.gstatic.com')
    expect(css).toContain(`${ORIGIN}/api/v1/fonts/file?u=`)
  })

  it('streams a real woff2 binary through the file proxy', async (ctx) => {
    if (!online) ctx.skip()
    const css = (await getCss(`/api/v1/fonts/css?u=${encodeFontUrl(INTER_CSS)}`)).body.toString('utf8')
    const fileUrl = /\/api\/v1\/fonts\/file\?u=[A-Za-z0-9_-]+/.exec(css)?.[0]
    expect(fileUrl, 'css should contain at least one proxied file url').toBeTruthy()

    const out = await getFile(fileUrl!)
    expect(out.status).toBe(200)
    expect(out.headers['content-type']).toBe('font/woff2')
    expect(out.body.byteLength).toBeGreaterThan(1000)
    // woff2 files start with the ASCII signature "wOF2".
    expect(out.body.subarray(0, 4).toString('latin1')).toBe('wOF2')
  })

  it('serves the second css request from the on-disk cache', async (ctx) => {
    if (!online) ctx.skip()
    const a = await getCss(`/api/v1/fonts/css?u=${encodeFontUrl(INTER_CSS)}`)
    // A cache file must now exist for this url.
    const cached = await readdir(join(cacheRoot, 'fonts-cache'))
    expect(cached.some((f) => f.startsWith('css-'))).toBe(true)
    const b = await getCss(`/api/v1/fonts/css?u=${encodeFontUrl(INTER_CSS)}`)
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(b.body.toString('utf8')).toBe(a.body.toString('utf8'))
  })

  it('rejects a non-allowlisted host on /file (SSRF guard)', async () => {
    const out = await getFile(
      `/api/v1/fonts/file?u=${encodeFontUrl('https://169.254.169.254/latest/meta-data/')}`,
    )
    expect(out.status).toBe(400)
  })

  it('rejects a gstatic url asked through /css (host mismatch)', async () => {
    const out = await getCss(
      `/api/v1/fonts/css?u=${encodeFontUrl('https://fonts.gstatic.com/s/inter/v13/a.woff2')}`,
    )
    expect(out.status).toBe(400)
  })

  it('400s when ?u= is missing', async () => {
    const out = await getCss('/api/v1/fonts/css')
    expect(out.status).toBe(400)
  })
})
