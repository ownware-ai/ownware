/**
 * Tests for the workspace CRUD SSE channel (audit #2 C2 / F1a,
 * 2026-05-16).
 *
 * Two halves, same pattern as `credential-events.test.ts`:
 *
 *   1. SSE handler — bus → wire frame. Subscribe, emit, verify the
 *      handler writes a `workspace.changed` event per emit, and that
 *      `stream.shutdown` lands on gateway shutdown. `:ready` preamble
 *      verified separately.
 *   2. Real emitter path — drive `createWorkspaceHandlers` with a
 *      live `WorkspaceEventBus`, exercise create / update / archive /
 *      delete, and assert one event per durable mutation. Failed
 *      mutations (404, 400) emit nothing.
 *
 * Principle 5 invariant guard: every assertion verifies that the
 * emitted payload contains ONLY `type`, `workspaceId`, `action`, `at`.
 * If a future change to the bus leaks the workspace's `name` / `path`
 * / `description` into the frame, the property-shape assertion fails.
 */

import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createWorkspaceEventBus,
  WorkspaceChangedEventSchema,
  type WorkspaceChangedEvent,
} from '../../../src/gateway/workspace-event-bus.js'
import { createWorkspaceEventsHandler } from '../../../src/gateway/handlers/workspace-events.js'
import { createWorkspaceHandlers } from '../../../src/gateway/handlers/workspaces.js'
import { GatewayState } from '../../../src/gateway/state.js'

// ---------------------------------------------------------------------------
// HTTP mocks — same shape as credential-events.test.ts
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
// SSE handler — bus → wire frame
// ---------------------------------------------------------------------------

describe('GET /workspaces/events — SSE handler', () => {
  it('emits a frame for every bus event until the client closes', async () => {
    const bus = createWorkspaceEventBus()
    const dir = mkdtempSync(join(tmpdir(), 'cortex-ws-ev-state-'))
    const state = new GatewayState(join(dir, 'ownware.db'))
    const handler = createWorkspaceEventsHandler({ bus, state })

    const { res, captured, close } = makeRes()
    const reqP = handler.streamWorkspaceEvents(
      makeReq('GET', '/api/v1/workspaces/events'),
      res,
    )

    // Wait a tick so the handler subscribes + writes the ready comment.
    await new Promise(r => setImmediate(r))
    expect(captured.status).toBe(200)

    bus.emit({ workspaceId: 'ws_abc', action: 'created' })
    bus.emit({ workspaceId: 'ws_abc', action: 'archived' })

    // Let the async drain catch up.
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    close()
    await reqP

    const frames = parseSSEEvents(captured.chunks.join(''))
    expect(frames).toHaveLength(2)
    expect(frames[0]!.event).toBe('workspace.changed')
    const first = JSON.parse(frames[0]!.data) as WorkspaceChangedEvent
    expect(first.workspaceId).toBe('ws_abc')
    expect(first.action).toBe('created')
    expect(typeof first.at).toBe('string')

    const second = JSON.parse(frames[1]!.data) as WorkspaceChangedEvent
    expect(second.action).toBe('archived')

    // Principle 5 invariant: the frame carries ONLY the four documented
    // fields. If a future change adds `name` / `path` / anything else
    // that leaks user data, this assertion fails loudly.
    expect(Object.keys(first).sort()).toEqual(['action', 'at', 'type', 'workspaceId'])
    expect(Object.keys(second).sort()).toEqual(['action', 'at', 'type', 'workspaceId'])

    // Subscriber was cleaned up on close.
    expect(bus.listenerCount).toBe(0)
    state.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('emits stream.shutdown when the gateway begins shutting down', async () => {
    const bus = createWorkspaceEventBus()
    const dir = mkdtempSync(join(tmpdir(), 'cortex-ws-ev-state-'))
    const state = new GatewayState(join(dir, 'ownware.db'))
    const handler = createWorkspaceEventsHandler({ bus, state })
    const { res, captured, close } = makeRes()

    const reqP = handler.streamWorkspaceEvents(
      makeReq('GET', '/api/v1/workspaces/events'),
      res,
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
    // The client's transport waits for the first chunk to know the socket
    // is open. Without the preamble a long-idle connection would look
    // dead during the time between connect and first emit.
    const bus = createWorkspaceEventBus()
    const dir = mkdtempSync(join(tmpdir(), 'cortex-ws-ev-state-'))
    const state = new GatewayState(join(dir, 'ownware.db'))
    const handler = createWorkspaceEventsHandler({ bus, state })
    const { res, captured, close } = makeRes()

    const reqP = handler.streamWorkspaceEvents(
      makeReq('GET', '/api/v1/workspaces/events'),
      res,
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
// Bus schema — invariants
// ---------------------------------------------------------------------------

describe('WorkspaceEventBus — emit + schema', () => {
  it('emit() returns the validated event with the action + id intact', () => {
    const bus = createWorkspaceEventBus()
    const ev = bus.emit({ workspaceId: 'ws_abc', action: 'updated' })
    expect(ev.type).toBe('workspace.changed')
    expect(ev.workspaceId).toBe('ws_abc')
    expect(ev.action).toBe('updated')
    expect(WorkspaceChangedEventSchema.safeParse(ev).success).toBe(true)
  })

  it('strips bus payloads carrying any field that could leak workspace data', () => {
    // Defensive parse — if a future caller stuffs `name` / `path` into
    // the payload, the schema's strict shape strips them so they
    // never round-trip through emit() to the wire.
    const leaky = {
      type: 'workspace.changed',
      workspaceId: 'ws_abc',
      action: 'created',
      at: new Date().toISOString(),
      name: 'my-private-project',
      path: '/Users/secret/project',
    }
    const parsed = WorkspaceChangedEventSchema.parse(leaky)
    expect((parsed as unknown as Record<string, unknown>)['name']).toBeUndefined()
    expect((parsed as unknown as Record<string, unknown>)['path']).toBeUndefined()
  })

  it('forwards every emit to every subscriber and unsubscribes cleanly', () => {
    const bus = createWorkspaceEventBus()
    const received: WorkspaceChangedEvent[] = []
    const unsubscribe = bus.subscribe(ev => received.push(ev))

    bus.emit({ workspaceId: 'ws_1', action: 'created' })
    bus.emit({ workspaceId: 'ws_1', action: 'deleted' })
    expect(received).toHaveLength(2)
    expect(received[0]!.action).toBe('created')
    expect(received[1]!.action).toBe('deleted')

    unsubscribe()
    bus.emit({ workspaceId: 'ws_1', action: 'updated' })
    expect(received).toHaveLength(2)
    expect(bus.listenerCount).toBe(0)
  })

  it('rejects unknown action variants at emit time (forward-compat fails loud)', () => {
    // Direct schema parse — the bus.emit() type forbids unknown
    // actions at compile time. This guards against a future runtime
    // caller (e.g. a JSON-derived input) from sneaking an unknown
    // action through.
    const bad = {
      type: 'workspace.changed' as const,
      workspaceId: 'ws_abc',
      action: 'renamed',
      at: new Date().toISOString(),
    }
    expect(WorkspaceChangedEventSchema.safeParse(bad).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Real emitter path — workspace handlers fan out CRUD events
// ---------------------------------------------------------------------------

describe('workspace handlers — fan out CRUD events to the bus', () => {
  let tmpRoot: string
  let workspacePath: string
  let state: GatewayState
  let bus: ReturnType<typeof createWorkspaceEventBus>
  let handlers: ReturnType<typeof createWorkspaceHandlers>
  let received: WorkspaceChangedEvent[]

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cortex-ws-emit-'))
    // The create handler resolves the body path and verifies it exists
    // + is a directory. Pre-create a real one inside the temp root.
    workspacePath = join(tmpRoot, 'project')
    mkdirSync(workspacePath, { recursive: true })
    state = new GatewayState(join(tmpRoot, 'ownware.db'))
    bus = createWorkspaceEventBus()
    received = []
    bus.subscribe(ev => received.push(ev))
    handlers = createWorkspaceHandlers(state, { eventBus: bus })
  })

  afterEach(() => {
    state.close()
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  function mockReq(url: string, body?: unknown): IncomingMessage {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const sock = new Socket()
    const req = new IncomingMessage(sock)
    ;(req as unknown as { method: string }).method = body === undefined ? 'GET' : 'POST'
    ;(req as unknown as { url: string }).url = url
    req.headers = { host: 'localhost' }
    process.nextTick(() => {
      if (payload.length > 0) req.push(payload)
      req.push(null)
    })
    return req
  }

  function mockRes(): { res: ServerResponse; captured: { statusCode: number; body: string } } {
    const captured = { statusCode: 0, body: '' }
    const res = {
      statusCode: 0,
      headersSent: false,
      writeHead(code: number) {
        captured.statusCode = code
        ;(res as unknown as { headersSent: boolean }).headersSent = true
        return res
      },
      end(chunk?: string) {
        if (typeof chunk === 'string') captured.body = chunk
        return res
      },
    } as unknown as ServerResponse
    return { res, captured }
  }

  it('emits action=created after POST /workspaces creates a fresh row', async () => {
    const { res, captured } = mockRes()
    await handlers.create(
      mockReq('/api/v1/workspaces', { path: workspacePath, name: 'project' }),
      res,
    )
    expect(captured.statusCode).toBe(201)
    expect(received).toHaveLength(1)
    expect(received[0]!.action).toBe('created')
    expect(typeof received[0]!.workspaceId).toBe('string')
    expect(received[0]!.workspaceId.length).toBeGreaterThan(0)
  })

  it('emits action=updated after PUT /workspaces/:id', async () => {
    const seeded = state.createWorkspace(workspacePath, 'project')
    received.length = 0
    const { res, captured } = mockRes()
    await handlers.update(
      mockReq(`/api/v1/workspaces/${seeded.id}`, { name: 'project renamed' }),
      res,
      { workspaceId: seeded.id },
    )
    expect(captured.statusCode).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0]!.action).toBe('updated')
    expect(received[0]!.workspaceId).toBe(seeded.id)
  })

  it('emits action=archived when PUT flips status to archived', async () => {
    // Archived is split out from updated so subscribers may want to
    // drop the row from active-only views without a refetch (chunk
    // F1a). The handler decides this by inspecting the post-write row.
    const seeded = state.createWorkspace(workspacePath, 'project')
    received.length = 0
    const { res } = mockRes()
    await handlers.update(
      mockReq(`/api/v1/workspaces/${seeded.id}`, { status: 'archived' }),
      res,
      { workspaceId: seeded.id },
    )
    expect(received).toHaveLength(1)
    expect(received[0]!.action).toBe('archived')
    expect(received[0]!.workspaceId).toBe(seeded.id)
  })

  it('emits action=updated when POST /workspaces reactivates an archived row', async () => {
    // Reactivation path: POST with the same path while the row is
    // archived flips it back to active. That's a state transition;
    // emit `updated` so subscribers re-fetch the active list.
    const seeded = state.createWorkspace(workspacePath, 'project')
    state.updateWorkspace(seeded.id, { status: 'archived' })
    received.length = 0
    const { res, captured } = mockRes()
    await handlers.create(
      mockReq('/api/v1/workspaces', { path: workspacePath, name: 'project' }),
      res,
    )
    expect(captured.statusCode).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0]!.action).toBe('updated')
    expect(received[0]!.workspaceId).toBe(seeded.id)
  })

  it('does NOT emit when POST /workspaces hits an existing active row (no state change)', async () => {
    // touchWorkspace bumps lastOpenedAt but the list query doesn't
    // sort on that. Emitting here would thrash the cache on every
    // window-focus refetch.
    state.createWorkspace(workspacePath, 'project')
    received.length = 0
    const { res, captured } = mockRes()
    await handlers.create(
      mockReq('/api/v1/workspaces', { path: workspacePath }),
      res,
    )
    expect(captured.statusCode).toBe(200)
    expect(received).toHaveLength(0)
  })

  it('emits action=deleted on DELETE /workspaces/:id', async () => {
    const seeded = state.createWorkspace(workspacePath, 'project')
    received.length = 0
    const { res, captured } = mockRes()
    await handlers.remove(
      mockReq(`/api/v1/workspaces/${seeded.id}`),
      res,
      { workspaceId: seeded.id },
    )
    expect(captured.statusCode).toBe(204)
    expect(received).toHaveLength(1)
    expect(received[0]!.action).toBe('deleted')
    expect(received[0]!.workspaceId).toBe(seeded.id)
  })

  it('does NOT emit when a mutation fails (404 / 400 paths)', async () => {
    // 404 on update for unknown id.
    received.length = 0
    const { res: r1, captured: c1 } = mockRes()
    await handlers.update(
      mockReq('/api/v1/workspaces/nope', { name: 'x' }),
      r1,
      { workspaceId: 'nope' },
    )
    expect(c1.statusCode).toBe(404)
    expect(received).toHaveLength(0)

    // 404 on delete for unknown id.
    const { res: r2, captured: c2 } = mockRes()
    await handlers.remove(
      mockReq('/api/v1/workspaces/nope'),
      r2,
      { workspaceId: 'nope' },
    )
    expect(c2.statusCode).toBe(404)
    expect(received).toHaveLength(0)

    // 400 on create when path is missing.
    const { res: r3, captured: c3 } = mockRes()
    await handlers.create(
      mockReq('/api/v1/workspaces', {}),
      r3,
    )
    expect(c3.statusCode).toBe(400)
    expect(received).toHaveLength(0)

    // 400 on create when path does not exist on disk.
    const { res: r4, captured: c4 } = mockRes()
    await handlers.create(
      mockReq('/api/v1/workspaces', { path: join(tmpRoot, 'does-not-exist') }),
      r4,
    )
    expect(c4.statusCode).toBe(400)
    expect(received).toHaveLength(0)
  })
})
