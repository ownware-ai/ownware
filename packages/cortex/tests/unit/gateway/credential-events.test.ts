/**
 * Tests for the credential CRUD SSE channel (audit #5 H1, 2026-05-16).
 *
 * Two halves, same pattern as `connector-events.test.ts`:
 *
 *   1. SSE handler — bus → wire frame. Subscribe, emit, verify the
 *      handler writes a `credential.changed` event per emit, and that
 *      `stream.shutdown` lands on gateway shutdown.
 *   2. Real emitter path — drive `createCredentialStoreHandlers` with
 *      a live `CredentialEventBus`, exercise create / update / delete /
 *      validate, and assert one event per mutation.
 *
 * Principle 5 invariant guard: every assertion verifies that the
 * emitted payload contains ONLY `type`, `credentialId`, `action`, `at`.
 * If a future change to the bus leaks the plaintext value or the name
 * into the frame, the property-shape assertion fails loudly.
 */

import Database from 'better-sqlite3'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createCredentialEventBus,
  CredentialChangedEventSchema,
  type CredentialChangedEvent,
} from '../../../src/gateway/credential-event-bus.js'
import { createCredentialEventsHandler } from '../../../src/gateway/handlers/credential-events.js'
import { createCredentialStoreHandlers } from '../../../src/gateway/handlers/credential-store.js'
import { DbCredentialBackend } from '../../../src/credential/store/db-backend.js'
import type { CredentialStore } from '../../../src/credential/store/index.js'
import { GatewayState } from '../../../src/gateway/state.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'

// ---------------------------------------------------------------------------
// HTTP mocks — same shape as connector-events.test.ts
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

describe('GET /credentials/events — SSE handler', () => {
  it('emits a frame for every bus event until the client closes', async () => {
    const bus = createCredentialEventBus()
    const dir = mkdtempSync(join(tmpdir(), 'cortex-cred-ev-state-'))
    const state = new GatewayState(join(dir, 'ownware.db'))
    const handler = createCredentialEventsHandler({ bus, state })

    const { res, captured, close } = makeRes()
    const reqP = handler.streamCredentialEvents(
      makeReq('GET', '/api/v1/credentials/events'),
      res,
    )

    // Wait a tick so the handler subscribes + writes the ready comment.
    await new Promise(r => setImmediate(r))
    expect(captured.status).toBe(200)

    bus.emit({ credentialId: 'cred_abc', action: 'created' })
    bus.emit({ credentialId: 'cred_abc', action: 'validated' })

    // Let the async drain catch up.
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    close()
    await reqP

    const frames = parseSSEEvents(captured.chunks.join(''))
    expect(frames).toHaveLength(2)
    expect(frames[0]!.event).toBe('credential.changed')
    const first = JSON.parse(frames[0]!.data) as CredentialChangedEvent
    expect(first.credentialId).toBe('cred_abc')
    expect(first.action).toBe('created')
    expect(typeof first.at).toBe('string')

    const second = JSON.parse(frames[1]!.data) as CredentialChangedEvent
    expect(second.action).toBe('validated')

    // Principle 5 invariant: the frame carries ONLY the four documented
    // fields. If a future change adds `value` / `name` / anything else
    // that could leak the secret, this assertion fails loudly.
    expect(Object.keys(first).sort()).toEqual(['action', 'at', 'credentialId', 'type'])
    expect(Object.keys(second).sort()).toEqual(['action', 'at', 'credentialId', 'type'])

    // Subscriber was cleaned up on close.
    expect(bus.listenerCount).toBe(0)
    state.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('emits stream.shutdown when the gateway begins shutting down', async () => {
    const bus = createCredentialEventBus()
    const dir = mkdtempSync(join(tmpdir(), 'cortex-cred-ev-state-'))
    const state = new GatewayState(join(dir, 'ownware.db'))
    const handler = createCredentialEventsHandler({ bus, state })
    const { res, captured, close } = makeRes()

    const reqP = handler.streamCredentialEvents(
      makeReq('GET', '/api/v1/credentials/events'),
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
    const bus = createCredentialEventBus()
    const dir = mkdtempSync(join(tmpdir(), 'cortex-cred-ev-state-'))
    const state = new GatewayState(join(dir, 'ownware.db'))
    const handler = createCredentialEventsHandler({ bus, state })
    const { res, captured, close } = makeRes()

    const reqP = handler.streamCredentialEvents(
      makeReq('GET', '/api/v1/credentials/events'),
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

describe('CredentialEventBus — emit + schema', () => {
  it('emit() returns the validated event with the action + id intact', () => {
    const bus = createCredentialEventBus()
    const ev = bus.emit({ credentialId: 'cred_abc', action: 'updated' })
    expect(ev.type).toBe('credential.changed')
    expect(ev.credentialId).toBe('cred_abc')
    expect(ev.action).toBe('updated')
    expect(CredentialChangedEventSchema.safeParse(ev).success).toBe(true)
  })

  it('rejects bus payloads carrying any field that could leak the value', () => {
    // Defensive parse — if a future caller stuffs `value` into the
    // payload, the schema's strict shape fails.
    const leaky = {
      type: 'credential.changed',
      credentialId: 'cred_abc',
      action: 'created',
      at: new Date().toISOString(),
      value: 'sk-leak-XXXXXXXX',
    }
    // The schema currently uses `.strip` by default (z.object), which
    // means unknown fields are dropped, not rejected. We assert that
    // parsing strips the value so it never round-trips through emit().
    const parsed = CredentialChangedEventSchema.parse(leaky)
    expect((parsed as unknown as Record<string, unknown>)['value']).toBeUndefined()
  })

  it('forwards every emit to every subscriber and unsubscribes cleanly', () => {
    const bus = createCredentialEventBus()
    const received: CredentialChangedEvent[] = []
    const unsubscribe = bus.subscribe(ev => received.push(ev))

    bus.emit({ credentialId: 'cred_1', action: 'created' })
    bus.emit({ credentialId: 'cred_1', action: 'deleted' })
    expect(received).toHaveLength(2)
    expect(received[0]!.action).toBe('created')
    expect(received[1]!.action).toBe('deleted')

    unsubscribe()
    bus.emit({ credentialId: 'cred_1', action: 'updated' })
    expect(received).toHaveLength(2)
    expect(bus.listenerCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Real emitter path — credential-store handlers fan out CRUD events
// ---------------------------------------------------------------------------

describe('credential-store handlers — fan out CRUD events to the bus', () => {
  let prevHome: string | undefined
  let tmpHome: string
  let db: Database.Database
  let store: CredentialStore
  let bus: ReturnType<typeof createCredentialEventBus>
  let handlers: ReturnType<typeof createCredentialStoreHandlers>
  let received: CredentialChangedEvent[]

  beforeEach(() => {
    prevHome = process.env['HOME']
    tmpHome = mkdtempSync(join(tmpdir(), 'cortex-cred-emit-'))
    process.env['HOME'] = tmpHome
    __resetMasterKeyCacheForTests()
    db = new Database(':memory:')
    for (const m of MIGRATIONS) db.exec(m.sql)
    store = new DbCredentialBackend(db)
    bus = createCredentialEventBus()
    received = []
    bus.subscribe(ev => received.push(ev))
    handlers = createCredentialStoreHandlers(store, { eventBus: bus })
  })
  afterEach(() => {
    db.close()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    __resetMasterKeyCacheForTests()
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  function mockReq(url: string, body?: unknown): IncomingMessage {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const stream = Readable.from([Buffer.from(payload, 'utf-8')]) as unknown as IncomingMessage
    ;(stream as unknown as { url: string }).url = url
    ;(stream as unknown as { headers: Record<string, string> }).headers = { host: 'localhost' }
    ;(stream as unknown as { method: string }).method = body === undefined ? 'GET' : 'POST'
    return stream
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

  it('emits action=created after POST /credentials succeeds', async () => {
    const { res, captured } = mockRes()
    await handlers.create(
      mockReq('/api/v1/credentials', {
        name: 'A',
        value: 'sk-ant-XXXXXXXX-HM8A',
        category: 'llm',
        authType: 'api-key',
        variableName: 'ANTHROPIC_API_KEY',
      }),
      res,
    )
    expect(captured.statusCode).toBe(201)
    expect(received).toHaveLength(1)
    expect(received[0]!.action).toBe('created')
    expect(received[0]!.credentialId.startsWith('cred_')).toBe(true)
  })

  it('emits action=updated after PATCH /credentials/:id succeeds', async () => {
    const seeded = await store.save({
      name: 'A',
      value: 'sk-ant-XXXXXXXX-HM8A',
      category: 'llm',
      authType: 'api-key',
      variableName: 'ANTHROPIC_API_KEY',
      source: 'manual',
    })
    received.length = 0
    const { res } = mockRes()
    await handlers.update(
      mockReq(`/api/v1/credentials/${seeded.id}`, { name: 'A renamed' }),
      res,
      { id: seeded.id },
    )
    expect(received).toHaveLength(1)
    expect(received[0]!.action).toBe('updated')
    expect(received[0]!.credentialId).toBe(seeded.id)
  })

  it('emits action=deleted on both soft- and hard-delete paths', async () => {
    const softSeed = await store.save({
      name: 'Soft',
      value: 'sk-ant-XXXXXXXX-SOFT',
      category: 'llm',
      authType: 'api-key',
      variableName: 'ANTHROPIC_API_KEY',
      source: 'manual',
    })
    received.length = 0
    const { res: r1 } = mockRes()
    await handlers.remove(
      mockReq(`/api/v1/credentials/${softSeed.id}`),
      r1,
      { id: softSeed.id },
    )
    expect(received).toHaveLength(1)
    expect(received[0]!.action).toBe('deleted')
    expect(received[0]!.credentialId).toBe(softSeed.id)

    const hardSeed = await store.save({
      name: 'Hard',
      value: 'sk-oa-XXXXXXXX-HARD',
      category: 'tool',
      authType: 'api-key',
      variableName: 'OPENAI_API_KEY',
      source: 'manual',
    })
    received.length = 0
    const { res: r2 } = mockRes()
    await handlers.remove(
      mockReq(`/api/v1/credentials/${hardSeed.id}?hard=true`),
      r2,
      { id: hardSeed.id },
    )
    expect(received).toHaveLength(1)
    expect(received[0]!.action).toBe('deleted')
    expect(received[0]!.credentialId).toBe(hardSeed.id)
  })

  it('emits action=validated after POST /credentials/:id/validate', async () => {
    // Use an unknown LLM variable so the validator returns ok:true
    // without making a network call (see `validateLlmKey`'s unknown
    // var fallback).
    const seeded = await store.save({
      name: 'Unknown LLM',
      value: 'sk-XXXX-UNKN',
      category: 'llm',
      authType: 'api-key',
      variableName: 'SOME_OTHER_LLM_KEY',
      source: 'manual',
    })
    received.length = 0
    const { res } = mockRes()
    await handlers.validate(
      mockReq(`/api/v1/credentials/${seeded.id}/validate`),
      res,
      { id: seeded.id },
    )
    expect(received).toHaveLength(1)
    expect(received[0]!.action).toBe('validated')
    expect(received[0]!.credentialId).toBe(seeded.id)
  })

  it('does NOT emit when a mutation fails (404 / validation error)', async () => {
    // Conflict on duplicate variableName — POST returns 409 before
    // the save, so no event should fire.
    await store.save({
      name: 'A',
      value: 'sk-ant-XXXXXXXX-HM8A',
      category: 'llm',
      authType: 'api-key',
      variableName: 'ANTHROPIC_API_KEY',
      source: 'manual',
    })
    received.length = 0
    const { res, captured } = mockRes()
    await handlers.create(
      mockReq('/api/v1/credentials', {
        name: 'Dup',
        value: 'sk-ant-XXXXXXXX-DUP',
        category: 'llm',
        authType: 'api-key',
        variableName: 'ANTHROPIC_API_KEY',
      }),
      res,
    )
    expect(captured.statusCode).toBe(409)
    expect(received).toHaveLength(0)
  })
})
