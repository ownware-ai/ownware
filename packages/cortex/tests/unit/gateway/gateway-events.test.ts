/**
 * Tests for the multiplexed gateway-events SSE handler
 * (production-perf audit Slice B, 2026-05-18).
 *
 * The per-bus handlers (`credential-events`, `connector-events`,
 * `workspace-events`) have their own tests that cover bus → wire
 * semantics in isolation. This file only proves the multiplexer adds
 * NO new behaviour — it simply fans three buses into one socket,
 * preserving each event's native discriminator as the SSE `event:`
 * field.
 *
 * Asserted invariants:
 *
 *   1. An emit on any of the three buses produces one SSE frame on
 *      the multiplexed channel, with the bus's native event name in
 *      the `event:` field and its full payload in `data:`.
 *   2. Cross-bus emit ordering is preserved (wall-clock order = wire
 *      order). This matters when two events cause causally-related
 *      cache invalidations on the client (e.g. a credential save
 *      followed by a connector status flip).
 *   3. `stream.shutdown` lands on gateway shutdown and the handler
 *      detaches from all three buses cleanly.
 *   4. Client close detaches all three bus subscriptions — no
 *      lingering listeners after the response socket closes.
 */

import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createConnectorStatusBus } from '../../../src/connector/status-bus.js'
import { createCredentialEventBus } from '../../../src/gateway/credential-event-bus.js'
import { createWorkspaceEventBus } from '../../../src/gateway/workspace-event-bus.js'
import { createGatewayEventsHandler } from '../../../src/gateway/handlers/gateway-events.js'
import type { GatewayState } from '../../../src/gateway/state.js'

// Fake `GatewayState` exposing only the surface this handler depends
// on (`subscribeToShutdown` + the matching trigger). Avoids spinning
// up the real SQLite-backed state — which would pull in better-sqlite3
// native bindings the test process doesn't have a compatible ABI for.
function makeFakeState(): {
  state: Pick<GatewayState, 'subscribeToShutdown'>
  triggerShutdown: () => Promise<void>
} {
  const listeners = new Set<() => void | Promise<void>>()
  return {
    state: {
      subscribeToShutdown(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    async triggerShutdown() {
      for (const listener of Array.from(listeners)) {
        await listener()
      }
    },
  }
}

function makeReq(): IncomingMessage {
  const sock = new Socket()
  const req = new IncomingMessage(sock)
  ;(req as unknown as { method: string }).method = 'GET'
  ;(req as unknown as { url: string }).url = '/api/v1/events'
  req.headers = { host: 'localhost' }
  process.nextTick(() => {
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

describe('GET /api/v1/events — multiplexed SSE handler', () => {
  it('fans three buses into one stream, preserving each event type', async () => {
    const connectorBus = createConnectorStatusBus()
    const credentialBus = createCredentialEventBus()
    const workspaceBus = createWorkspaceEventBus()
    const { state } = makeFakeState()

    const handler = createGatewayEventsHandler({
      connectorBus,
      credentialBus,
      workspaceBus,
      state: state as GatewayState,
    })

    const { res, captured, close } = makeRes()
    const reqP = handler.streamGatewayEvents(makeReq(), res)

    await new Promise((r) => setImmediate(r))
    expect(captured.status).toBe(200)

    connectorBus.emit({
      connectorId: 'gmail',
      source: 'composio',
      status: 'ready',
    })
    credentialBus.emit({
      credentialId: 'cred_abc',
      action: 'created',
    })
    workspaceBus.emit({
      workspaceId: 'ws_xyz',
      action: 'updated',
    })

    // Two ticks: subscribers enqueue synchronously, drain runs in the
    // microtask queue. setImmediate twice flushes both.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    close()
    await reqP

    const raw = captured.chunks.join('')
    const events = parseSSEEvents(raw)

    const eventNames = events.map((e) => e.event)
    expect(eventNames).toContain('connector.status_changed')
    expect(eventNames).toContain('credential.changed')
    expect(eventNames).toContain('workspace.changed')

    // Each event carries its full validated payload (not a wrapper).
    const credEvent = events.find((e) => e.event === 'credential.changed')!
    const parsed = JSON.parse(credEvent.data) as Record<string, unknown>
    expect(parsed.type).toBe('credential.changed')
    expect(parsed.credentialId).toBe('cred_abc')
    expect(parsed.action).toBe('created')
  })

  it('preserves cross-bus emit order on the wire', async () => {
    const connectorBus = createConnectorStatusBus()
    const credentialBus = createCredentialEventBus()
    const workspaceBus = createWorkspaceEventBus()
    const { state } = makeFakeState()

    const handler = createGatewayEventsHandler({
      connectorBus,
      credentialBus,
      workspaceBus,
      state: state as GatewayState,
    })

    const { res, captured, close } = makeRes()
    const reqP = handler.streamGatewayEvents(makeReq(), res)

    await new Promise((r) => setImmediate(r))

    workspaceBus.emit({ workspaceId: 'ws_1', action: 'created' })
    credentialBus.emit({ credentialId: 'cred_1', action: 'created' })
    connectorBus.emit({ connectorId: 'gmail', source: 'composio', status: 'ready' })
    workspaceBus.emit({ workspaceId: 'ws_2', action: 'updated' })

    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    close()
    await reqP

    const eventNames = parseSSEEvents(captured.chunks.join('')).map((e) => e.event)
    expect(eventNames).toEqual([
      'workspace.changed',
      'credential.changed',
      'connector.status_changed',
      'workspace.changed',
    ])
  })

  it('detaches from every bus when the client closes', async () => {
    const connectorBus = createConnectorStatusBus()
    const credentialBus = createCredentialEventBus()
    const workspaceBus = createWorkspaceEventBus()
    const { state } = makeFakeState()

    const handler = createGatewayEventsHandler({
      connectorBus,
      credentialBus,
      workspaceBus,
      state: state as GatewayState,
    })

    const { res, close } = makeRes()
    const reqP = handler.streamGatewayEvents(makeReq(), res)

    await new Promise((r) => setImmediate(r))

    expect(connectorBus.listenerCount).toBe(1)
    expect(credentialBus.listenerCount).toBe(1)
    expect(workspaceBus.listenerCount).toBe(1)

    close()
    await reqP

    expect(connectorBus.listenerCount).toBe(0)
    expect(credentialBus.listenerCount).toBe(0)
    expect(workspaceBus.listenerCount).toBe(0)
  })

  it('emits stream.shutdown then closes on gateway shutdown', async () => {
    const connectorBus = createConnectorStatusBus()
    const credentialBus = createCredentialEventBus()
    const workspaceBus = createWorkspaceEventBus()
    const { state, triggerShutdown } = makeFakeState()

    const handler = createGatewayEventsHandler({
      connectorBus,
      credentialBus,
      workspaceBus,
      state: state as GatewayState,
    })

    const { res, captured, close } = makeRes()
    const reqP = handler.streamGatewayEvents(makeReq(), res)

    await new Promise((r) => setImmediate(r))

    await triggerShutdown()
    // The shutdown branch writes the frame then `res.end()`s the
    // socket — but a real socket emits 'close' afterwards, and the
    // mock doesn't. Fire it manually so the handler's outer promise
    // resolves and the test doesn't hang.
    await new Promise((r) => setImmediate(r))
    close()
    await reqP

    const events = parseSSEEvents(captured.chunks.join(''))
    const shutdown = events.find((e) => e.event === 'stream.shutdown')
    expect(shutdown).toBeDefined()
    const parsed = JSON.parse(shutdown!.data) as Record<string, unknown>
    expect(parsed.reason).toBe('gateway_shutdown')
  })
})
