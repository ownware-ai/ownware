/**
 * Write-file handler — Slice B3.1.
 *
 * POST /api/v1/designs/:designId/files/*path streams a UTF-8 body
 * into the design's workspace folder. Used by the sketch editor's
 * Save button. Tests run against a real `http.Server` + `Router`
 * so the splat pattern, param guard, body reader, and disk write
 * are exercised end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, request as httpRequest } from 'node:http'
import type { Server } from 'node:http'
import { GatewayState } from '../../../src/gateway/state.js'
import { Router } from '../../../src/gateway/router.js'
import { createDesignsFilesHandlers } from '../../../src/gateway/handlers/designs-files.js'

interface PostResult {
  readonly status: number
  readonly body: Buffer
}

function postRaw(port: number, path: string, content: string): Promise<PostResult> {
  // The client's `api.post()` always JSON-encodes the body, so the
  // handler accepts `{ content }`. The test mirrors that wire shape.
  const envelope = JSON.stringify({ content })
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(envelope)),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
          })
        })
      },
    )
    req.on('error', reject)
    req.write(envelope)
    req.end()
  })
}

describe('POST /api/v1/designs/:designId/files/*path (slice B3.1)', () => {
  let state: GatewayState
  let tmpDir: string
  let workspaceDir: string
  let workspaceId: string
  let designId: string
  let server: Server
  let port: number

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-designs-files-'))
    workspaceDir = join(tmpDir, 'ws')
    mkdirSync(workspaceDir, { recursive: true })

    state = new GatewayState(join(tmpDir, 'test.db'))
    const ws = state.createWorkspace(workspaceDir, 'sketch-test')
    workspaceId = ws.id
    const design = state.createDesign(workspaceId, 'north-mark', 'sketch', {})
    designId = design.id

    const router = new Router()
    const handlers = createDesignsFilesHandlers(state)
    router.post('/api/v1/designs/:designId/files/*path', handlers.writeFile)

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

  it('writes a sketch JSON file at the workspace root + returns 201', async () => {
    const json = JSON.stringify({ version: 1, items: [{ kind: 'pen', points: [], color: '#000', size: 2 }] })
    const r = await postRaw(port, `/api/v1/designs/${designId}/files/sketch-2026-05-26T17-12.sketch.json`, json)
    expect(r.status).toBe(201)
    const envelope = JSON.parse(r.body.toString('utf-8')) as {
      designId: string
      path: string
      bytes: number
    }
    expect(envelope.designId).toBe(designId)
    expect(envelope.path).toBe('sketch-2026-05-26T17-12.sketch.json')
    expect(envelope.bytes).toBe(Buffer.byteLength(json, 'utf-8'))
    expect(readFileSync(join(workspaceDir, 'sketch-2026-05-26T17-12.sketch.json'), 'utf-8')).toBe(json)
  })

  it('creates missing parent directories implicitly', async () => {
    const r = await postRaw(port, `/api/v1/designs/${designId}/files/pins/04-disc-n.image-pins.json`, '{"pins":[]}')
    expect(r.status).toBe(201)
    expect(existsSync(join(workspaceDir, 'pins'))).toBe(true)
    expect(readFileSync(join(workspaceDir, 'pins', '04-disc-n.image-pins.json'), 'utf-8')).toBe('{"pins":[]}')
  })

  it('overwrites an existing file (Save replaces, not 409)', async () => {
    const first = '{"v":1}'
    const second = '{"v":2}'
    const r1 = await postRaw(port, `/api/v1/designs/${designId}/files/state.json`, first)
    expect(r1.status).toBe(201)
    const r2 = await postRaw(port, `/api/v1/designs/${designId}/files/state.json`, second)
    expect(r2.status).toBe(201)
    expect(readFileSync(join(workspaceDir, 'state.json'), 'utf-8')).toBe(second)
  })

  it('returns 404 when the design does not exist', async () => {
    const r = await postRaw(port, `/api/v1/designs/missing-id/files/x.json`, '{}')
    expect(r.status).toBe(404)
  })

  it('refuses raw .. traversal in the splat (router param guard catches it)', async () => {
    // The router URL-normalises raw `..`, so by the time the splat
    // captures anything the traversal segment is already gone — but
    // the param guard ALSO catches it on the way through. Either
    // shield is enough; the test asserts neither shield writes
    // outside the workspace.
    const outsideTarget = join(tmpDir, 'secret.txt')
    const r = await postRaw(port, `/api/v1/designs/${designId}/files/%2e%2e/secret.txt`, 'leaked')
    expect(r.status).not.toBe(201)
    expect(existsSync(outsideTarget)).toBe(false)
  })

  it('refuses an absolute path captured by the splat', async () => {
    // A double-slash in the URL preserves the leading slash into
    // the splat capture (`/etc/passwd`). `resolve()` against the
    // workspace root treats that as absolute and returns it
    // unchanged — the prefix check then rejects it. Nothing is
    // written inside or outside the workspace.
    const r = await postRaw(port, `/api/v1/designs/${designId}/files//etc/passwd`, 'leaked')
    expect(r.status).toBe(400)
    const parsed = JSON.parse(r.body.toString('utf-8')) as { message: string }
    expect(parsed.message).toContain('escapes')
    expect(existsSync(join(workspaceDir, 'etc'))).toBe(false)
  })

  it('returns 404 when the workspace has been deleted out from under the design', async () => {
    state.deleteWorkspace(workspaceId)
    const r = await postRaw(port, `/api/v1/designs/${designId}/files/state.json`, '{}')
    expect(r.status).toBe(404)
  })

  it('writes a UTF-8 body with multibyte characters correctly', async () => {
    const json = JSON.stringify({ note: 'café · 北京 · 🎨' })
    const r = await postRaw(port, `/api/v1/designs/${designId}/files/note.json`, json)
    expect(r.status).toBe(201)
    expect(readFileSync(join(workspaceDir, 'note.json'), 'utf-8')).toBe(json)
    const envelope = JSON.parse(r.body.toString('utf-8')) as { bytes: number }
    // Byte length, not character length.
    expect(envelope.bytes).toBe(Buffer.byteLength(json, 'utf-8'))
  })
})
