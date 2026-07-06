/**
 * Tests for the generic connector-status SSE channel plus the two real
 * emitters wired through it:
 *   1. Web-search PATCH — emits a transition via
 *      `createWebSearchHandlers` when the resolved status changes.
 *   2. MCP credential save — emits via `createMCPHandlers` when the
 *      required-env readiness flips.
 *
 * The SSE handler itself is tested end-to-end: we subscribe via the
 * bus, push events, and verify the handler writes them as SSE frames.
 */

if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'test-dummy'
if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'test-dummy'
if (!process.env['GOOGLE_API_KEY']) process.env['GOOGLE_API_KEY'] = 'test-dummy'
process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createConnectorStatusBus,
  type ConnectorStatusEvent,
} from '../../../src/connector/status-bus.js'
import { createConnectorEventsHandler } from '../../../src/gateway/handlers/connector-events.js'
import { createWebSearchHandlers } from '../../../src/gateway/handlers/web-search.js'
import { createMCPHandlers } from '../../../src/gateway/handlers/mcp.js'
import { WebSearchService } from '../../../src/connector/web-search/service.js'
import { CredentialVault } from '../../../src/connector/credentials/vault.js'
import { credentialStore, __resetMasterKeyCacheForTests } from '../../../src/connector/mcp/credentials.js'
import { ProfileRegistry } from '../../../src/profile/registry.js'
import { GatewayState } from '../../../src/gateway/state.js'

// ---------------------------------------------------------------------------
// HTTP mocks (same pattern as web-search-handlers.test.ts)
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

describe('GET /connectors/events — SSE handler', () => {
  it('emits a frame for every bus event until the client closes', async () => {
    const bus = createConnectorStatusBus()
    const dir = mkdtempSync(join(tmpdir(), 'cortex-ce-state-'))
    const state = new GatewayState(join(dir, 'ownware.db'))
    const handler = createConnectorEventsHandler({ statusBus: bus, state })

    const { res, captured, close } = makeRes()
    const reqP = handler.streamConnectorEvents(makeReq('GET', '/api/v1/connectors/events'), res)

    // Wait a tick so the handler subscribes + writes the ready comment.
    await new Promise(r => setImmediate(r))
    expect(captured.status).toBe(200)

    bus.emit({ connectorId: 'x', source: 'mcp', status: 'ready' })
    bus.emit({ connectorId: 'x', source: 'mcp', status: 'needs_setup' })

    // Let the async drain catch up.
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    // Clean up — simulate client disconnect so the handler resolves.
    close()
    await reqP

    const frames = parseSSEEvents(captured.chunks.join(''))
    expect(frames).toHaveLength(2)
    expect(frames[0]!.event).toBe('connector.status_changed')
    const first = JSON.parse(frames[0]!.data) as ConnectorStatusEvent
    expect(first.status).toBe('ready')
    expect(first.previousStatus).toBeNull()
    const second = JSON.parse(frames[1]!.data) as ConnectorStatusEvent
    expect(second.status).toBe('needs_setup')
    expect(second.previousStatus).toBe('ready')

    // Subscriber was cleaned up on close.
    expect(bus.listenerCount).toBe(0)
    state.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('suppresses no-op transitions (same status twice)', async () => {
    const bus = createConnectorStatusBus()
    const dir = mkdtempSync(join(tmpdir(), 'cortex-ce-state-'))
    const state = new GatewayState(join(dir, 'ownware.db'))
    const handler = createConnectorEventsHandler({ statusBus: bus, state })
    const { res, captured, close } = makeRes()
    const reqP = handler.streamConnectorEvents(makeReq('GET', '/api/v1/connectors/events'), res)
    await new Promise(r => setImmediate(r))
    bus.emit({ connectorId: 'x', source: 'mcp', status: 'ready' })
    bus.emit({ connectorId: 'x', source: 'mcp', status: 'ready' })
    await new Promise(r => setImmediate(r))
    close()
    await reqP
    const frames = parseSSEEvents(captured.chunks.join(''))
    expect(frames).toHaveLength(1)
    state.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('emits stream.shutdown when the gateway begins shutting down', async () => {
    const bus = createConnectorStatusBus()
    const dir = mkdtempSync(join(tmpdir(), 'cortex-ce-state-'))
    const state = new GatewayState(join(dir, 'ownware.db'))
    const handler = createConnectorEventsHandler({ statusBus: bus, state })
    const { res, captured, close } = makeRes()

    const reqP = handler.streamConnectorEvents(makeReq('GET', '/api/v1/connectors/events'), res)
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
})

// ---------------------------------------------------------------------------
// Web-search PATCH — real emitter path
// ---------------------------------------------------------------------------

describe('PATCH /connectors/web_search/provider — status bus emit', () => {
  let tmpDir: string
  const store = new Map<string, string>()
  const settings = {
    getSetting: (k: string) => {
      const v = store.get(k)
      return v === undefined ? undefined : { value: v }
    },
    setSetting: (k: string, v: string) => { store.set(k, v); return { value: v } },
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-ce-ws-'))
    store.clear()
    delete process.env['BRAVE_SEARCH_API_KEY']
    delete process.env['TAVILY_API_KEY']
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('emits a transition event through the bus when the provider switches', async () => {
    const vault = new CredentialVault(tmpDir)
    const service = new WebSearchService({ settings, vault })
    const bus = createConnectorStatusBus()
    const events: ConnectorStatusEvent[] = []
    bus.subscribe(e => { events.push(e) })
    const handlers = createWebSearchHandlers({ service, statusBus: bus })

    // Switch to brave with a key — status stays 'ready' but the
    // provider changed from duckduckgo to brave. Same final status
    // means no event (idempotency: we don't spam "ready → ready").
    const { res: res1, captured: cap1 } = makeSimpleRes()
    await handlers.setProvider(
      makeReq('PATCH', '/api/v1/connectors/web_search/provider', {
        providerId: 'brave',
        apiKey: 'test-key',
      }),
      res1,
      { id: 'web_search' },
    )
    expect(cap1.status).toBe(200)
    expect(events).toHaveLength(0) // status was 'ready' before and after

    // Now switch to a brave-ish scenario where we're actually forcing
    // a needs_setup → ready transition. Start by deleting the key:
    await vault.delete('builtin:web_search:brave')
    // User choice is now "brave" but no key — resolve falls through to
    // duckduckgo ('ready'). Switching back to duckduckgo explicitly
    // is a no-op. But if we set brave with no key, we get a 400 — so
    // the real transition test is: unset the user choice, then force
    // a new one that differs in resolved status. Simulate needs_setup
    // by temporarily replacing resolve on the service:
    let forceNeedsSetup = true
    const originalResolve = service.resolve.bind(service)
    service.resolve = async () => {
      if (forceNeedsSetup) {
        return {
          providerId: 'brave',
          provider: {
            id: 'brave',
            name: 'Brave Search',
            description: 'd',
            homepage: 'https://brave.com',
            auth: { mode: 'api_key', envVar: 'BRAVE_SEARCH_API_KEY' },
            isDefault: false,
          },
          source: 'user',
          status: 'needs_setup',
          reason: 'no key',
        }
      }
      return originalResolve()
    }

    // Switch to duckduckgo — the prior (mocked) resolve reports
    // needs_setup, so the transition is needs_setup → ready.
    forceNeedsSetup = true
    const { res: res2, captured: cap2 } = makeSimpleRes()
    // After reading priorResolved, the handler calls setUserChoice and
    // then resolve() again — flip the flag so the post-switch resolve
    // returns the real ready status for duckduckgo.
    let callCount = 0
    service.resolve = async () => {
      callCount++
      if (callCount === 1) {
        return {
          providerId: 'brave',
          provider: {
            id: 'brave',
            name: 'Brave Search',
            description: 'd',
            homepage: 'https://brave.com',
            auth: { mode: 'api_key', envVar: 'BRAVE_SEARCH_API_KEY' },
            isDefault: false,
          },
          source: 'user',
          status: 'needs_setup',
          reason: 'no key',
        }
      }
      return originalResolve()
    }

    await handlers.setProvider(
      makeReq('PATCH', '/api/v1/connectors/web_search/provider', {
        providerId: 'duckduckgo',
      }),
      res2,
      { id: 'web_search' },
    )
    expect(cap2.status).toBe(200)
    expect(events).toHaveLength(1)
    expect(events[0]!.connectorId).toBe('web_search')
    expect(events[0]!.source).toBe('builtin')
    expect(events[0]!.status).toBe('ready')
    expect(events[0]!.previousStatus).toBe('needs_setup')
  })
})

// ---------------------------------------------------------------------------
// MCP credential save — real emitter path
// ---------------------------------------------------------------------------

describe('MCP credential save/delete — status bus emit', () => {
  let tmpHome: string
  let prevHome: string | undefined

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cortex-ce-mcp-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = tmpHome
    __resetMasterKeyCacheForTests()
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    __resetMasterKeyCacheForTests()
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('emits a transition when saving credentials for a server with required env', async () => {
    // Use a featured server id that actually has a required env var.
    // Looking up through `computeMCPStatus`: featured servers declared
    // in the Cortex repo carry `requiredEnv` with real var names. We
    // pick "brave-search" if present, else fall back to any featured
    // entry with a required-env var.
    const { getFeaturedServers } = await import('../../../src/connector/mcp/featured.js')
    const candidate = getFeaturedServers().find(f => f.requiredEnv.some(v => v.isRequired))
    if (!candidate) {
      // Skip — nothing to exercise the needs_setup → ready transition.
      return
    }
    const serverId = candidate.id
    const varName = candidate.requiredEnv.find(v => v.isRequired)!.name

    const bus = createConnectorStatusBus()
    const events: ConnectorStatusEvent[] = []
    bus.subscribe(e => { events.push(e) })

    const registry = new ProfileRegistry()
    const handlers = createMCPHandlers(registry, undefined, { statusBus: bus })

    // Ensure a clean slate — no creds on disk, no env.
    await credentialStore.delete(serverId).catch(() => {})
    const prevEnv = process.env[varName]
    delete process.env[varName]

    try {
      const { res: res1, captured: cap1 } = makeSimpleRes()
      await handlers.saveCredentials(
        makeReq('POST', `/api/v1/mcp/credentials/${serverId}`, {
          env: { [varName]: 'test-value' },
        }),
        res1,
        { serverId },
      )
      expect(cap1.status).toBe(200)
      expect(events.length).toBeGreaterThanOrEqual(1)
      const saveEvent = events[events.length - 1]!
      expect(saveEvent.source).toBe('mcp')
      expect(saveEvent.connectorId).toBe(serverId)
      expect(saveEvent.status).toBe('ready')
      expect(saveEvent.previousStatus).toBe('needs_setup')

      // Delete flips it back.
      const { res: res2 } = makeSimpleRes()
      await handlers.deleteCredentials(
        makeReq('DELETE', `/api/v1/mcp/credentials/${serverId}`),
        res2,
        { serverId },
      )
      const delEvent = events[events.length - 1]!
      expect(delEvent.status).toBe('needs_setup')
      expect(delEvent.previousStatus).toBe('ready')
    } finally {
      if (prevEnv !== undefined) process.env[varName] = prevEnv
      await credentialStore.delete(serverId).catch(() => {})
    }
  })
})

// ---------------------------------------------------------------------------
// Tiny local helper — matches the pattern used above but captures only
// status + raw string (no SSE streaming).
// ---------------------------------------------------------------------------
function makeSimpleRes(): { res: ServerResponse; captured: { status: number; raw: string } } {
  const sock = new Socket()
  const req = new IncomingMessage(sock)
  const res = new ServerResponse(req)
  const captured = { status: 0, raw: '' }
  const origWriteHead = res.writeHead.bind(res)
  res.writeHead = ((s: number, ...args: unknown[]) => {
    captured.status = s
    return origWriteHead(s, ...(args as [])) as unknown as ServerResponse
  }) as ServerResponse['writeHead']
  const origWrite = res.write.bind(res)
  res.write = ((c: unknown) => {
    if (typeof c === 'string') captured.raw += c
    else if (Buffer.isBuffer(c)) captured.raw += c.toString('utf-8')
    return origWrite(c as Buffer)
  }) as ServerResponse['write']
  const origEnd = res.end.bind(res)
  res.end = ((c?: unknown) => {
    if (typeof c === 'string') captured.raw += c
    return origEnd(c as Buffer)
  }) as ServerResponse['end']
  return { res, captured }
}
