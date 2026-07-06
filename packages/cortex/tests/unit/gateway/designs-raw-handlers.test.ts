/**
 * Raw subresource handler — Slice B2.1.
 *
 * GET /api/v1/designs/:designId/raw/*path — streams a file from a
 * design's workspace folder with the correct content-type. Used by
 * the prototype canvas's URL-load iframe so multi-file prototypes
 * (script src, link href, image src) resolve real bytes from disk
 * instead of 404-ing inside a srcDoc iframe.
 *
 * Tests run against a real `http.Server` + `Router` so the splat
 * pattern, param guard, and `createReadStream().pipe(res)` path
 * are exercised end-to-end. Disk lives in a per-test tmpdir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, request as httpRequest } from 'node:http'
import type { Server } from 'node:http'
import { GatewayState } from '../../../src/gateway/state.js'
import { Router } from '../../../src/gateway/router.js'
import { createDesignsRawHandlers } from '../../../src/gateway/handlers/designs-raw.js'

interface RawResponse {
  readonly status: number
  readonly headers: Record<string, string | undefined>
  readonly body: Buffer
}

function fetchRaw(port: number, path: string, method = 'GET'): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | undefined>,
          body: Buffer.concat(chunks),
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('GET /api/v1/designs/:designId/raw/*path (slice B2.1)', () => {
  let state: GatewayState
  let tmpDir: string
  let workspaceDir: string
  let workspaceId: string
  let designId: string
  let server: Server
  let port: number

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-designs-raw-'))
    workspaceDir = join(tmpDir, 'ws')
    mkdirSync(workspaceDir, { recursive: true })

    state = new GatewayState(join(tmpDir, 'test.db'))
    const ws = state.createWorkspace(workspaceDir, 'raw-test')
    workspaceId = ws.id
    const design = state.createDesign(workspaceId, 'north-mark', 'prototype', {})
    designId = design.id

    // Seed a realistic multi-file prototype on disk.
    writeFileSync(
      join(workspaceDir, 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="./styles.css"><script src="./app.js"></script></head><body><h1>hi</h1></body></html>',
      'utf-8',
    )
    writeFileSync(join(workspaceDir, 'styles.css'), 'body{background:#0e0e0e}', 'utf-8')
    writeFileSync(join(workspaceDir, 'app.js'), 'console.log("boot")', 'utf-8')
    mkdirSync(join(workspaceDir, 'assets'), { recursive: true })
    writeFileSync(join(workspaceDir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf-8')

    const router = new Router()
    const handlers = createDesignsRawHandlers(state)
    router.get('/api/v1/designs/:designId/raw/*path', handlers.getRaw)

    server = createServer((req, res) => router.handle(req, res))
    await new Promise<void>((r) => server.listen(0, r))
    const addr = server.address() as { port: number }
    port = addr.port
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    state.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('serves an HTML file with text/html content-type', async () => {
    const r = await fetchRaw(port, `/api/v1/designs/${designId}/raw/index.html`)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(r.headers['access-control-allow-origin']).toBe('*')
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.body.toString('utf-8')).toContain('<h1>hi</h1>')
  })

  it('serves a CSS subresource as text/css', async () => {
    const r = await fetchRaw(port, `/api/v1/designs/${designId}/raw/styles.css`)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('text/css; charset=utf-8')
    expect(r.body.toString('utf-8')).toBe('body{background:#0e0e0e}')
  })

  it('serves a JS subresource as application/javascript', async () => {
    const r = await fetchRaw(port, `/api/v1/designs/${designId}/raw/app.js`)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('application/javascript; charset=utf-8')
    expect(r.body.toString('utf-8')).toBe('console.log("boot")')
  })

  it('serves a nested asset (assets/logo.svg) with the right mime', async () => {
    const r = await fetchRaw(port, `/api/v1/designs/${designId}/raw/assets/logo.svg`)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('image/svg+xml')
    expect(r.body.toString('utf-8')).toContain('<svg')
  })

  it('returns 404 when the design does not exist', async () => {
    const r = await fetchRaw(port, `/api/v1/designs/missing-id/raw/index.html`)
    expect(r.status).toBe(404)
    const parsed = JSON.parse(r.body.toString('utf-8')) as { message: string }
    expect(parsed.message).toContain('Design "missing-id" not found')
  })

  it('returns 404 when the path does not exist in the workspace', async () => {
    const r = await fetchRaw(port, `/api/v1/designs/${designId}/raw/missing.html`)
    expect(r.status).toBe(404)
    const parsed = JSON.parse(r.body.toString('utf-8')) as { message: string }
    expect(parsed.message).toContain('not found in design workspace')
  })

  it('returns 404 when the path resolves to a directory, not a file', async () => {
    const r = await fetchRaw(port, `/api/v1/designs/${designId}/raw/assets`)
    expect(r.status).toBe(404)
  })

  it('returns 404 when the workspace has been deleted out from under the design', async () => {
    // FK ON DELETE CASCADE normally takes the design row with the
    // workspace, but the handler still has to behave when the rows
    // are out of sync (corrupted DB, restored backup, etc.). In
    // practice the design row goes first, so a typical run-through
    // hits the "Design not found" branch — both messages are valid;
    // we accept either, as long as the status is 404 and the bytes
    // never leave disk.
    state.deleteWorkspace(workspaceId)
    const r = await fetchRaw(port, `/api/v1/designs/${designId}/raw/index.html`)
    expect(r.status).toBe(404)
  })

  it('rejects encoded traversal that decodes to .. via the router param guard', async () => {
    // The router normalises raw `..` segments, but encoded `%2e%2e`
    // can survive URL parsing depending on the client. Either way,
    // the handler's resolve-and-prefix check is the last line of
    // defense — and it must hold.
    const traversalTarget = join(tmpDir, 'secret.txt')
    writeFileSync(traversalTarget, 'do not leak', 'utf-8')
    const r = await fetchRaw(port, `/api/v1/designs/${designId}/raw/%2e%2e/secret.txt`)
    // Status should be either 400 (param guard caught `..`) or 404
    // (URL normalisation already collapsed it before pattern match).
    // Both are safe; never 200.
    expect(r.status).not.toBe(200)
    expect(r.body.toString('utf-8')).not.toContain('do not leak')
  })

  it('falls back to application/octet-stream for unknown extensions', async () => {
    writeFileSync(join(workspaceDir, 'data.bin'), Buffer.from([0xde, 0xad, 0xbe, 0xef]))
    const r = await fetchRaw(port, `/api/v1/designs/${designId}/raw/data.bin`)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('application/octet-stream')
    expect(r.body.length).toBe(4)
  })
})

describe('GET /api/v1/designs/:designId/files (S1 — disk listing)', () => {
  let state: GatewayState
  let tmpDir: string
  let workspaceDir: string
  let designId: string
  let server: Server
  let port: number

  interface FileListing {
    readonly path: string
    readonly size: number
    readonly lastModified: number
    readonly content?: string
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-designs-files-'))
    workspaceDir = join(tmpDir, 'ws')
    mkdirSync(workspaceDir, { recursive: true })

    state = new GatewayState(join(tmpDir, 'test.db'))
    const ws = state.createWorkspace(workspaceDir, 'files-test')
    const design = state.createDesign(ws.id, 'north-mark', 'prototype', {})
    designId = design.id

    writeFileSync(join(workspaceDir, 'index.html'), '<h1>hi</h1>\n<p>two</p>', 'utf-8')
    writeFileSync(join(workspaceDir, 'styles.css'), 'body{}', 'utf-8')
    mkdirSync(join(workspaceDir, 'assets'), { recursive: true })
    writeFileSync(join(workspaceDir, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const router = new Router()
    const handlers = createDesignsRawHandlers(state)
    router.get('/api/v1/designs/:designId/files', handlers.getFiles)
    server = createServer((req, res) => router.handle(req, res))
    await new Promise<void>((r) => server.listen(0, r))
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    state.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('lists files alpha-sorted, inline content for text, metadata-only for binary', async () => {
    const r = await fetchRaw(port, `/api/v1/designs/${designId}/files`)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8')
    const body = JSON.parse(r.body.toString('utf-8')) as { files: FileListing[] }
    expect(body.files.map((f) => f.path)).toEqual([
      'assets/logo.png',
      'index.html',
      'styles.css',
    ])
    const byPath = new Map(body.files.map((f) => [f.path, f]))
    expect(byPath.get('index.html')!.content).toBe('<h1>hi</h1>\n<p>two</p>')
    expect(byPath.get('styles.css')!.content).toBe('body{}')
    // Binary file: metadata only, no inline content (iframe loads via /raw).
    expect(byPath.get('assets/logo.png')!.content).toBeUndefined()
    expect(byPath.get('assets/logo.png')!.size).toBe(4)
  })

  it('returns an empty list when the design folder has no files', async () => {
    const emptyWsDir = join(tmpDir, 'empty-ws')
    mkdirSync(emptyWsDir, { recursive: true })
    const ws2 = state.createWorkspace(emptyWsDir, 'empty')
    const d2 = state.createDesign(ws2.id, 'empty-slug', 'prototype', {})
    const r = await fetchRaw(port, `/api/v1/designs/${d2.id}/files`)
    expect(r.status).toBe(200)
    const body = JSON.parse(r.body.toString('utf-8')) as { files: FileListing[] }
    expect(body.files).toEqual([])
  })

  it('returns 404 when the design does not exist', async () => {
    const r = await fetchRaw(port, `/api/v1/designs/missing-id/files`)
    expect(r.status).toBe(404)
  })

  it('skips node_modules / .git / .DS_Store noise', async () => {
    mkdirSync(join(workspaceDir, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(workspaceDir, 'node_modules', 'x', 'junk.js'), 'junk', 'utf-8')
    writeFileSync(join(workspaceDir, '.DS_Store'), 'os', 'utf-8')
    const r = await fetchRaw(port, `/api/v1/designs/${designId}/files`)
    const body = JSON.parse(r.body.toString('utf-8')) as { files: FileListing[] }
    const paths = body.files.map((f) => f.path)
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false)
    expect(paths).not.toContain('.DS_Store')
  })
})
