/**
 * Designs fs-events SSE handler — Slice B4.1.
 *
 * Tests run against a real `http.Server` + `Router` so the route
 * params, SSE headers, ready marker, per-event payload shape, and
 * cleanup-on-disconnect are exercised end-to-end. Filesystem is
 * faked at the chokidar layer (the service's watcherFactory) so the
 * suite has zero on-disk side effects and runs in milliseconds.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { writeFile as fsWriteFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { GatewayState } from '../../../src/gateway/state.js'
import { Router } from '../../../src/gateway/router.js'
import {
  DesignFsEventBus,
  createDesignFsService,
  type DesignFsService,
  type DesignFsWatcherHandle,
} from '../../../src/files/index.js'
import { createDesignFsEventsHandlers } from '../../../src/gateway/handlers/designs-fs-events.js'

type FakeFsEvent =
  | 'add'
  | 'change'
  | 'unlink'
  | 'addDir'
  | 'unlinkDir'
  | 'error'

interface FakeHandle extends DesignFsWatcherHandle {
  emit(event: FakeFsEvent, arg?: unknown): void
  closed: boolean
}

function makeFakeHandle(): FakeHandle {
  const handlers: Partial<Record<string, (arg?: unknown) => void>> = {}
  const fake = {
    closed: false,
    on(event: string, fn: (arg?: unknown) => void) {
      handlers[event] = fn
      return fake
    },
    async close() {
      fake.closed = true
    },
    emit(event: string, arg?: unknown) {
      handlers[event]?.(arg)
    },
  }
  return fake as unknown as FakeHandle
}

interface JsonResponse {
  readonly status: number
  readonly body: unknown
}

function fetchJson(port: number, path: string): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        let parsed: unknown = text
        try {
          parsed = JSON.parse(text)
        } catch {
          // leave as raw text
        }
        resolve({ status: res.statusCode ?? 0, body: parsed })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Open a streaming SSE GET, accumulate raw bytes, and return a
 * `close()` plus a `wait(predicate, timeoutMs)` helper that resolves
 * when the predicate matches the accumulated text — useful for
 * waiting on specific SSE frames without sleep-and-pray.
 */
function openSse(
  port: number,
  path: string,
): Promise<{
  close: () => void
  wait: (predicate: (text: string) => boolean, timeoutMs?: number) => Promise<string>
  current: () => string
  status: number
}> {
  return new Promise((resolve, reject) => {
    let chunks = ''
    let resolved = false
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
      const status = res.statusCode ?? 0
      res.on('data', (c: Buffer) => {
        chunks += c.toString('utf-8')
      })
      const handle = {
        status,
        close: () => req.destroy(),
        current: () => chunks,
        wait: (predicate: (text: string) => boolean, timeoutMs = 1000) =>
          new Promise<string>((resolveWait, rejectWait) => {
            const start = Date.now()
            const tick = (): void => {
              if (predicate(chunks)) {
                resolveWait(chunks)
                return
              }
              if (Date.now() - start > timeoutMs) {
                rejectWait(
                  new Error(
                    `wait timeout after ${timeoutMs}ms; last 200 chars: ${chunks.slice(-200)}`,
                  ),
                )
                return
              }
              setTimeout(tick, 10)
            }
            tick()
          }),
      }
      if (!resolved) {
        resolved = true
        resolve(handle)
      }
    })
    req.on('error', (err) => {
      if (!resolved) reject(err)
    })
    req.end()
  })
}

describe('GET /api/v1/designs/:designId/fs-events (slice B4.1)', () => {
  let state: GatewayState
  let tmpDir: string
  let workspaceId: string
  let designId: string
  let server: Server
  let port: number
  let bus: DesignFsEventBus
  let service: DesignFsService
  const handles: FakeHandle[] = []

  beforeEach(async () => {
    handles.length = 0
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-design-fs-events-'))
    state = new GatewayState(join(tmpDir, 'test.db'))
    const ws = state.createWorkspace(join(tmpDir, 'ws'), 'fs-events-test')
    workspaceId = ws.id
    const design = state.createDesign(workspaceId, 'north-mark', 'prototype', {})
    designId = design.id

    bus = new DesignFsEventBus()
    service = createDesignFsService({
      bus,
      designs: {
        getDesignPath: (id) => {
          const d = state.getDesign(id)
          if (d == null) return null
          const w = state.getWorkspace(d.workspaceId)
          return w?.path ?? null
        },
      },
      debounceMs: 20,
      watcherFactory: () => {
        const h = makeFakeHandle()
        handles.push(h)
        return h
      },
    })

    const handlers = createDesignFsEventsHandlers({ service, bus })
    const router = new Router()
    router.get('/api/v1/designs/:designId/fs-events', handlers.streamEvents)

    server = createServer((req, res) => {
      void router.handle(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (addr == null || typeof addr === 'string') throw new Error('no port')
    port = addr.port
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await service.shutdown()
    state.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 404 design_unknown when the design id does not resolve', async () => {
    const resp = await fetchJson(port, '/api/v1/designs/does-not-exist/fs-events')
    expect(resp.status).toBe(404)
    expect(resp.body).toEqual({
      error: 'design_unknown',
      message: expect.stringContaining('does-not-exist'),
    })
  })

  it('opens an SSE stream, writes the :ready marker, and delivers per-path frames', async () => {
    const sse = await openSse(port, `/api/v1/designs/${designId}/fs-events`)
    try {
      expect(sse.status).toBe(200)
      await sse.wait((t) => t.includes(':ready'))
      // hasDesign() short-circuits the 404 path without spawning;
      // the subscribe below is the only watcher created.
      expect(handles).toHaveLength(1)
      const realHandle = handles[0]
      const ws = state.getWorkspace(workspaceId)!
      realHandle.emit('change', join(ws.path, 'index.html'))
      const text = await sse.wait((t) => t.includes('design-fs.changed'))
      const dataLine = text
        .split('\n')
        .find((l) => l.startsWith('data: '))!
      const payload = JSON.parse(dataLine.slice('data: '.length))
      expect(payload).toEqual({
        type: 'design-fs.changed',
        designId,
        path: 'index.html',
        kind: 'change',
        at: expect.any(String),
      })
    } finally {
      sse.close()
    }
  })

  it('does not deliver frames for other designs on the same stream', async () => {
    // Create a second design in the same workspace pointing at a
    // sibling folder.
    const otherDesign = state.createDesign(
      workspaceId,
      'other-design',
      'prototype',
      {},
    )

    const sse = await openSse(port, `/api/v1/designs/${designId}/fs-events`)
    try {
      await sse.wait((t) => t.includes(':ready'))
      const targetHandle = handles[0]

      // Emit ONTO the bus directly as if some other watcher saw a
      // change in another design — the SSE handler must filter it out.
      bus.emit({
        type: 'design-fs.changed',
        designId: otherDesign.id,
        path: 'noise.html',
        kind: 'change',
        at: new Date().toISOString(),
      })
      // And emit a real one for our design via the watcher.
      targetHandle.emit('change', join(tmpDir, 'ws', 'real.html'))
      const text = await sse.wait((t) => t.includes('real.html'))
      expect(text).not.toContain('noise.html')
    } finally {
      sse.close()
    }
  })

  it('drops the watcher when the SSE client disconnects', async () => {
    const sse = await openSse(port, `/api/v1/designs/${designId}/fs-events`)
    await sse.wait((t) => t.includes(':ready'))
    expect(handles).toHaveLength(1)
    const liveHandle = handles[0]
    expect(liveHandle.closed).toBe(false)

    sse.close()

    // Give the server's `req.on('close')` handler a beat.
    await new Promise((r) => setTimeout(r, 50))
    expect(liveHandle.closed).toBe(true)
  })

  it('end-to-end smoke: real chokidar → real fs write → SSE frame within ~300ms', async () => {
    // Stand up a fresh service + handler that uses the REAL chokidar
    // factory (no override), so this spec exercises the actual fs
    // pipeline the desktop app runs. The shared `service` from the
    // suite's beforeEach uses a fake handle and is unsuitable here.
    const { createDesignFsService } = await import('../../../src/files/index.js')
    const realBus = new DesignFsEventBus()
    const realService = createDesignFsService({
      bus: realBus,
      debounceMs: 100,
      designs: {
        getDesignPath: (id) => {
          const d = state.getDesign(id)
          if (d == null) return null
          const w = state.getWorkspace(d.workspaceId)
          return w?.path ?? null
        },
      },
    })
    const realHandlers = createDesignFsEventsHandlers({
      service: realService,
      bus: realBus,
    })
    const realRouter = new Router()
    realRouter.get('/api/v1/designs/:designId/fs-events', realHandlers.streamEvents)
    const realServer = createServer((req, res) => {
      void realRouter.handle(req, res)
    })
    await new Promise<void>((resolve) =>
      realServer.listen(0, '127.0.0.1', resolve),
    )
    const addr = realServer.address()
    if (addr == null || typeof addr === 'string') throw new Error('no port')
    const realPort = addr.port

    // The workspace folder created by the suite's beforeEach exists on
    // disk because state.createWorkspace points at `${tmpDir}/ws` and
    // the suite mkdirs `tmpDir` but NOT the ws subfolder for this
    // service path. Make sure it exists for chokidar.
    const ws = state.getWorkspace(workspaceId)!
    mkdirSync(ws.path, { recursive: true })

    const sse = await openSse(
      realPort,
      `/api/v1/designs/${designId}/fs-events`,
    )
    try {
      await sse.wait((t) => t.includes(':ready'))
      // Real chokidar finishes its initial scan asynchronously; the
      // 100ms grace prevents an `add` event from the test write
      // arriving before the watcher fully attaches.
      await new Promise((r) => setTimeout(r, 200))
      await fsWriteFile(join(ws.path, 'smoke.html'), '<h1>smoke</h1>', 'utf-8')
      const text = await sse.wait(
        (t) => t.includes('smoke.html') && t.includes('design-fs.changed'),
        2000,
      )
      const dataLine = text
        .split('\n')
        .find((l) => l.startsWith('data: ') && l.includes('smoke.html'))!
      const payload = JSON.parse(dataLine.slice('data: '.length))
      expect(payload.designId).toBe(designId)
      expect(payload.path).toBe('smoke.html')
      expect(['add', 'change']).toContain(payload.kind)
    } finally {
      sse.close()
      await new Promise<void>((resolve) => realServer.close(() => resolve()))
      await realService.shutdown()
    }
  })

  it('multiple concurrent SSE clients share one underlying watcher; teardown only after the last leaves', async () => {
    const a = await openSse(port, `/api/v1/designs/${designId}/fs-events`)
    await a.wait((t) => t.includes(':ready'))
    expect(handles).toHaveLength(1)
    const live = handles[0]

    const b = await openSse(port, `/api/v1/designs/${designId}/fs-events`)
    await b.wait((t) => t.includes(':ready'))
    // Refcount semantics — no new factory call, the live handle is shared.
    expect(handles).toHaveLength(1)
    expect(live.closed).toBe(false)

    a.close()
    await new Promise((r) => setTimeout(r, 30))
    // B still subscribed — watcher remains.
    expect(live.closed).toBe(false)

    b.close()
    await new Promise((r) => setTimeout(r, 30))
    expect(live.closed).toBe(true)
  })
})
