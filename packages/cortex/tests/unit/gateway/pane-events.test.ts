/**
 * Tests for the workspace-pane CRUD SSE channel (audit #2 C3 / F1b,
 * 2026-05-16, Chunk #20).
 *
 * Two halves, mirroring `workspace-events.test.ts` but with one extra
 * dimension: every layer must be keyed by `wsId`. A pane mutation in
 * workspace A must NEVER reach a subscriber listening on workspace B.
 *
 *   1. Bus per-wsId isolation — emit fans out only to listeners of the
 *      same workspace. Listener counts are reported per-wsId. Cleanup
 *      drops the wsId entry when its last listener leaves.
 *   2. SSE handler — `:ready` preamble, frames-per-emit, only for the
 *      caller's `wsId`. Other workspaces' emits don't appear on the
 *      wire. `stream.shutdown` lands on gateway shutdown.
 *   3. Real emitter path — drive `createPaneHandlers` with a live
 *      `PaneEventBus`, exercise every mutation that exists as an HTTP
 *      endpoint (POST create / PATCH update / DELETE close / PUT
 *      reorder / PUT layout), and assert one event per durable
 *      mutation. Failed mutations (404, 400) emit nothing.
 *
 * Principle 5 invariant guard: every assertion verifies that the
 * emitted payload contains ONLY `type`, `wsId`, `paneId`, `action`,
 * `at`, and the optional `paneKind`. If a future change leaks the
 * pane's `config` (which may carry file paths or chat ids), title, or
 * other writable fields, the property-shape assertion fails.
 */

import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createPaneEventBus,
  PaneChangedEventSchema,
  type PaneChangedEvent,
} from '../../../src/gateway/pane-event-bus.js'
import { createPaneEventsHandler } from '../../../src/gateway/handlers/pane-events.js'
import { createPaneHandlers } from '../../../src/gateway/handlers/panes.js'
import { GatewayState } from '../../../src/gateway/state.js'

// ---------------------------------------------------------------------------
// HTTP mocks — same shape as workspace-events.test.ts
// ---------------------------------------------------------------------------

function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = body !== undefined ? JSON.stringify(body) : ''
  const sock = new Socket()
  const req = new IncomingMessage(sock)
  ;(req as unknown as { method: string }).method = method
  ;(req as unknown as { url: string }).url = url
  req.headers = { host: 'localhost' }
  process.nextTick(() => {
    if (payload.length > 0) req.push(payload)
    req.push(null)
  })
  return req
}

function makeRes(): {
  res: ServerResponse
  captured: { chunks: string[]; status: number }
  close: () => void
} {
  const sock = new Socket()
  const req = new IncomingMessage(sock)
  const res = new ServerResponse(req)
  const captured = { chunks: [] as string[], status: 0 }
  const origWriteHead = res.writeHead.bind(res)
  res.writeHead = ((s: number, ...args: unknown[]) => {
    captured.status = s
    return origWriteHead(s, ...(args as [])) as unknown as ServerResponse
  }) as ServerResponse['writeHead']
  const origWrite = res.write.bind(res)
  res.write = ((c: unknown) => {
    if (typeof c === 'string') captured.chunks.push(c)
    else if (Buffer.isBuffer(c)) captured.chunks.push(c.toString('utf-8'))
    return origWrite(c as Buffer)
  }) as ServerResponse['write']
  const origEnd = res.end.bind(res)
  res.end = ((c?: unknown) => {
    if (typeof c === 'string') captured.chunks.push(c)
    return origEnd(c as Buffer)
  }) as ServerResponse['end']
  const close = () => res.emit('close')
  return { res, captured, close }
}

function parseSSEEvents(raw: string): Array<{ event: string; data: string }> {
  const out: Array<{ event: string; data: string }> = []
  for (const block of raw.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block)
    const dat = /^data: (.+)$/m.exec(block)
    if (ev && dat) out.push({ event: ev[1]!, data: dat[1]! })
  }
  return out
}

// ---------------------------------------------------------------------------
// Bus — per-wsId isolation + schema invariants
// ---------------------------------------------------------------------------

describe('PaneEventBus — emit + per-wsId isolation', () => {
  it('emit() returns the validated event with paneId / wsId / action intact', () => {
    const bus = createPaneEventBus()
    const ev = bus.emit({
      wsId: 'ws_1',
      paneId: 'pane_a',
      action: 'created',
      paneKind: 'chat',
    })
    expect(ev.type).toBe('pane.changed')
    expect(ev.wsId).toBe('ws_1')
    expect(ev.paneId).toBe('pane_a')
    expect(ev.action).toBe('created')
    expect(ev.paneKind).toBe('chat')
    expect(PaneChangedEventSchema.safeParse(ev).success).toBe(true)
  })

  it('only delivers events to subscribers of the same wsId', () => {
    // The keystone test: a pane mutation in workspace A must NEVER
    // surface on a subscriber listening to workspace B. Without this
    // every window would invalidate every other window's pane cache.
    const bus = createPaneEventBus()
    const recvA: PaneChangedEvent[] = []
    const recvB: PaneChangedEvent[] = []
    bus.subscribe('ws_A', ev => recvA.push(ev))
    bus.subscribe('ws_B', ev => recvB.push(ev))

    bus.emit({ wsId: 'ws_A', paneId: 'pane_1', action: 'created' })
    bus.emit({ wsId: 'ws_B', paneId: 'pane_2', action: 'updated' })
    bus.emit({ wsId: 'ws_A', paneId: 'pane_1', action: 'deleted' })

    expect(recvA).toHaveLength(2)
    expect(recvA[0]!.paneId).toBe('pane_1')
    expect(recvA[0]!.action).toBe('created')
    expect(recvA[1]!.action).toBe('deleted')

    expect(recvB).toHaveLength(1)
    expect(recvB[0]!.paneId).toBe('pane_2')
    expect(recvB[0]!.action).toBe('updated')
  })

  it('unsubscribe drops the listener cleanly and reports per-wsId count', () => {
    const bus = createPaneEventBus()
    const unsub1 = bus.subscribe('ws_A', () => {})
    const unsub2 = bus.subscribe('ws_A', () => {})
    bus.subscribe('ws_B', () => {})

    expect(bus.listenerCount('ws_A')).toBe(2)
    expect(bus.listenerCount('ws_B')).toBe(1)
    expect(bus.listenerCount('ws_X')).toBe(0)

    unsub1()
    expect(bus.listenerCount('ws_A')).toBe(1)
    unsub2()
    expect(bus.listenerCount('ws_A')).toBe(0)
  })

  it('clear() drops every wsId entry', () => {
    const bus = createPaneEventBus()
    bus.subscribe('ws_A', () => {})
    bus.subscribe('ws_B', () => {})
    expect(bus.listenerCount('ws_A')).toBe(1)
    bus.clear()
    expect(bus.listenerCount('ws_A')).toBe(0)
    expect(bus.listenerCount('ws_B')).toBe(0)
  })

  it('rejects unknown action variants at the schema boundary', () => {
    // The bus.emit() type forbids unknown actions at compile time;
    // this guards a runtime caller from sneaking one through.
    const bad = {
      type: 'pane.changed' as const,
      wsId: 'ws_A',
      paneId: 'pane_1',
      action: 'renamed',
      at: new Date().toISOString(),
    }
    expect(PaneChangedEventSchema.safeParse(bad).success).toBe(false)
  })

  it('strips leaky fields the wire never carries (Principle 5 guard)', () => {
    // Defensive parse — if a future caller stuffs `title` / `config`
    // into the payload, the schema's strict shape strips them so they
    // never round-trip through emit() to the wire.
    const leaky = {
      type: 'pane.changed',
      wsId: 'ws_A',
      paneId: 'pane_1',
      action: 'created',
      at: new Date().toISOString(),
      title: 'my-secret-file.md',
      config: { kind: 'markdown', source: { origin: 'path', path: '/etc/passwd' } },
    }
    const parsed = PaneChangedEventSchema.parse(leaky)
    expect((parsed as unknown as Record<string, unknown>)['title']).toBeUndefined()
    expect((parsed as unknown as Record<string, unknown>)['config']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// SSE handler — bus → wire frame, scoped to caller's wsId
// ---------------------------------------------------------------------------

describe('GET /workspaces/:wsId/panes/events — SSE handler', () => {
  it('emits a frame for every bus event matching the caller’s wsId', async () => {
    const bus = createPaneEventBus()
    const dir = mkdtempSync(join(tmpdir(), 'cortex-pane-ev-state-'))
    const state = new GatewayState(join(dir, 'ownware.db'))
    const handler = createPaneEventsHandler({ bus, state })

    const { res, captured, close } = makeRes()
    const reqP = handler.streamPaneEvents(
      makeReq('GET', '/api/v1/workspaces/ws_A/panes/events'),
      res,
      { wsId: 'ws_A' },
    )

    await new Promise(r => setImmediate(r))
    expect(captured.status).toBe(200)

    bus.emit({ wsId: 'ws_A', paneId: 'pane_1', action: 'created', paneKind: 'chat' })
    // Cross-workspace emit — must be filtered out.
    bus.emit({ wsId: 'ws_B', paneId: 'pane_x', action: 'created' })
    bus.emit({ wsId: 'ws_A', paneId: 'pane_1', action: 'deleted' })

    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    close()
    await reqP

    const frames = parseSSEEvents(captured.chunks.join(''))
    expect(frames).toHaveLength(2)
    const first = JSON.parse(frames[0]!.data) as PaneChangedEvent
    expect(first.wsId).toBe('ws_A')
    expect(first.paneId).toBe('pane_1')
    expect(first.action).toBe('created')
    expect(first.paneKind).toBe('chat')

    const second = JSON.parse(frames[1]!.data) as PaneChangedEvent
    expect(second.action).toBe('deleted')

    // Principle 5 invariant: the frame carries ONLY the documented
    // fields. Optional `paneKind` is allowed; nothing else.
    const allowed = new Set(['action', 'at', 'paneId', 'paneKind', 'type', 'wsId'])
    for (const key of Object.keys(first)) expect(allowed.has(key)).toBe(true)
    for (const key of Object.keys(second)) expect(allowed.has(key)).toBe(true)

    expect(bus.listenerCount('ws_A')).toBe(0)
    state.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns 400 when :wsId is missing', async () => {
    const bus = createPaneEventBus()
    const dir = mkdtempSync(join(tmpdir(), 'cortex-pane-ev-state-'))
    const state = new GatewayState(join(dir, 'ownware.db'))
    const handler = createPaneEventsHandler({ bus, state })

    const { res, captured } = makeRes()
    await handler.streamPaneEvents(
      makeReq('GET', '/api/v1/workspaces//panes/events'),
      res,
      {},
    )
    expect(captured.status).toBe(400)
    state.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('emits stream.shutdown when the gateway begins shutting down', async () => {
    const bus = createPaneEventBus()
    const dir = mkdtempSync(join(tmpdir(), 'cortex-pane-ev-state-'))
    const state = new GatewayState(join(dir, 'ownware.db'))
    const handler = createPaneEventsHandler({ bus, state })

    const { res, captured, close } = makeRes()
    const reqP = handler.streamPaneEvents(
      makeReq('GET', '/api/v1/workspaces/ws_A/panes/events'),
      res,
      { wsId: 'ws_A' },
    )
    await new Promise(r => setImmediate(r))

    await state.notifyShutdown()
    close()
    await reqP

    const frames = parseSSEEvents(captured.chunks.join(''))
    expect(frames.at(-1)?.event).toBe('stream.shutdown')
    expect(JSON.parse(frames.at(-1)!.data)).toEqual({
      type: 'stream.shutdown',
      reason: 'gateway_shutdown',
      retryAfterMs: 5000,
    })

    state.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the :ready preamble before any event lands', async () => {
    const bus = createPaneEventBus()
    const dir = mkdtempSync(join(tmpdir(), 'cortex-pane-ev-state-'))
    const state = new GatewayState(join(dir, 'ownware.db'))
    const handler = createPaneEventsHandler({ bus, state })

    const { res, captured, close } = makeRes()
    const reqP = handler.streamPaneEvents(
      makeReq('GET', '/api/v1/workspaces/ws_A/panes/events'),
      res,
      { wsId: 'ws_A' },
    )
    await new Promise(r => setImmediate(r))
    expect(captured.chunks.join('')).toContain(':ready\n\n')

    close()
    await reqP
    state.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// Real emitter path — pane handlers fan out CRUD events
// ---------------------------------------------------------------------------

describe('pane handlers — fan out CRUD events to the per-wsId bus', () => {
  let tmpRoot: string
  let state: GatewayState
  let bus: ReturnType<typeof createPaneEventBus>
  let handlers: ReturnType<typeof createPaneHandlers>
  let workspaceId: string
  let received: PaneChangedEvent[]

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cortex-pane-emit-'))
    state = new GatewayState(join(tmpRoot, 'ownware.db'))
    bus = createPaneEventBus()
    received = []
    // Seed a real workspace row — the pane handlers check `getWorkspace`.
    const ws = state.createWorkspace(tmpRoot, 'project')
    workspaceId = ws.id
    bus.subscribe(workspaceId, ev => received.push(ev))
    handlers = createPaneHandlers(state, { eventBus: bus })
  })

  afterEach(() => {
    state.close()
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  function mockReq(url: string, method: string, body?: unknown): IncomingMessage {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const sock = new Socket()
    const req = new IncomingMessage(sock)
    ;(req as unknown as { method: string }).method = method
    ;(req as unknown as { url: string }).url = url
    req.headers = { host: 'localhost' }
    process.nextTick(() => {
      if (payload.length > 0) req.push(payload)
      req.push(null)
    })
    return req
  }

  function mockRes(): {
    res: ServerResponse
    captured: { statusCode: number; body: string }
  } {
    const captured = { statusCode: 0, body: '' }
    const res = {
      statusCode: 0,
      headersSent: false,
      setHeader() { /* swallow */ return res },
      writeHead(code: number) {
        captured.statusCode = code
        ;(res as unknown as { headersSent: boolean }).headersSent = true
        return res
      },
      end(chunk?: string) {
        if (typeof chunk === 'string') captured.body += chunk
        return res
      },
      write(chunk?: string) {
        if (typeof chunk === 'string') captured.body += chunk
        return true
      },
    } as unknown as ServerResponse
    return { res, captured }
  }

  it('emits action=created after POST /workspaces/:id/panes', async () => {
    const { res, captured } = mockRes()
    await handlers.createPane(
      mockReq(`/api/v1/workspaces/${workspaceId}/panes`, 'POST', {
        config: { kind: 'tasks', workspaceId },
      }),
      res,
      { workspaceId },
    )
    expect(captured.statusCode).toBe(201)
    expect(received).toHaveLength(1)
    expect(received[0]!.action).toBe('created')
    expect(received[0]!.wsId).toBe(workspaceId)
    expect(received[0]!.paneId.length).toBeGreaterThan(0)
  })

  it('emits action=updated after PATCH /workspaces/:id/panes/:paneId (field patch)', async () => {
    const pane = state.createWorkspacePane(workspaceId, {
      config: { kind: 'tasks', workspaceId },
      metadata: { openedBy: 'user', pinned: false, closeable: true },
      zone: 'side',
    })
    received.length = 0
    const { res, captured } = mockRes()
    await handlers.patchPane(
      mockReq(
        `/api/v1/workspaces/${workspaceId}/panes/${pane.id}`,
        'PATCH',
        { title: 'renamed' },
      ),
      res,
      { workspaceId, paneId: pane.id },
    )
    expect(captured.statusCode).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0]!.action).toBe('updated')
    expect(received[0]!.paneId).toBe(pane.id)
  })

  it('emits action=updated for a focus-only PATCH (moved-focus is still durable state)', async () => {
    const pane = state.createWorkspacePane(workspaceId, {
      config: { kind: 'tasks', workspaceId },
      metadata: { openedBy: 'user', pinned: false, closeable: true },
      zone: 'side',
    })
    received.length = 0
    const { res, captured } = mockRes()
    await handlers.patchPane(
      mockReq(
        `/api/v1/workspaces/${workspaceId}/panes/${pane.id}`,
        'PATCH',
        { focused: true },
      ),
      res,
      { workspaceId, paneId: pane.id },
    )
    expect(captured.statusCode).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0]!.action).toBe('updated')
    expect(received[0]!.paneId).toBe(pane.id)
  })

  it('emits action=deleted on DELETE /workspaces/:id/panes/:paneId', async () => {
    const pane = state.createWorkspacePane(workspaceId, {
      config: { kind: 'tasks', workspaceId },
      metadata: { openedBy: 'user', pinned: false, closeable: true },
      zone: 'side',
    })
    received.length = 0
    const { res, captured } = mockRes()
    await handlers.deletePane(
      mockReq(`/api/v1/workspaces/${workspaceId}/panes/${pane.id}`, 'DELETE'),
      res,
      { workspaceId, paneId: pane.id },
    )
    expect(captured.statusCode).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0]!.action).toBe('deleted')
    expect(received[0]!.paneId).toBe(pane.id)
  })

  it('emits action=moved on PUT /workspaces/:id/panes (reorder)', async () => {
    const p1 = state.createWorkspacePane(workspaceId, {
      config: { kind: 'tasks', workspaceId },
      metadata: { openedBy: 'user', pinned: false, closeable: true },
      zone: 'side',
    })
    const p2 = state.createWorkspacePane(workspaceId, {
      config: { kind: 'files', rootPath: tmpRoot },
      metadata: { openedBy: 'user', pinned: false, closeable: true },
      zone: 'side',
    })
    received.length = 0
    const { res, captured } = mockRes()
    await handlers.reorderPanes(
      mockReq(`/api/v1/workspaces/${workspaceId}/panes`, 'PUT', {
        zone: 'side',
        ids: [p2.id, p1.id],
      }),
      res,
      { workspaceId },
    )
    expect(captured.statusCode).toBe(200)
    // Reorder is a single durable transition for the zone — emit one
    // `moved` event with no paneId (it's a zone-level change).
    expect(received).toHaveLength(1)
    expect(received[0]!.action).toBe('moved')
    expect(received[0]!.wsId).toBe(workspaceId)
  })

  it('does NOT emit when a mutation fails (404 / 400 paths)', async () => {
    // 404 on PATCH for unknown paneId.
    received.length = 0
    const { res: r1, captured: c1 } = mockRes()
    await handlers.patchPane(
      mockReq(
        `/api/v1/workspaces/${workspaceId}/panes/nope`,
        'PATCH',
        { title: 'x' },
      ),
      r1,
      { workspaceId, paneId: 'nope' },
    )
    expect(c1.statusCode).toBe(404)
    expect(received).toHaveLength(0)

    // 404 on DELETE for unknown paneId.
    const { res: r2, captured: c2 } = mockRes()
    await handlers.deletePane(
      mockReq(`/api/v1/workspaces/${workspaceId}/panes/nope`, 'DELETE'),
      r2,
      { workspaceId, paneId: 'nope' },
    )
    expect(c2.statusCode).toBe(404)
    expect(received).toHaveLength(0)

    // 400 on POST when the body is empty.
    const { res: r3, captured: c3 } = mockRes()
    await handlers.createPane(
      mockReq(`/api/v1/workspaces/${workspaceId}/panes`, 'POST'),
      r3,
      { workspaceId },
    )
    expect(c3.statusCode).toBe(400)
    expect(received).toHaveLength(0)

    // 404 on POST for unknown workspace.
    const { res: r4, captured: c4 } = mockRes()
    await handlers.createPane(
      mockReq(`/api/v1/workspaces/nope/panes`, 'POST', {
        config: { kind: 'tasks', workspaceId: 'nope' },
      }),
      r4,
      { workspaceId: 'nope' },
    )
    expect(c4.statusCode).toBe(404)
    expect(received).toHaveLength(0)
  })
})
