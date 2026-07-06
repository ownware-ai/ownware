/**
 * PATCH /api/v1/connectors/alias/:logicalKey/source — handler tests.
 *
 * The handler validates the logical key, the body, confirms the
 * requested source actually has a candidate, persists the preference,
 * and returns the newly-resolved connector.
 */

if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'test-dummy'
if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'test-dummy'
if (!process.env['GOOGLE_API_KEY']) process.env['GOOGLE_API_KEY'] = 'test-dummy'
process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'

import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  ConnectorRegistry,
  type ConnectorSourceProvider,
} from '../../../src/connector/registry.js'
import { ProfileRegistry } from '../../../src/profile/registry.js'
import {
  SourcePreferences,
  type SourcePreferencesStore,
} from '../../../src/connector/source-preferences.js'
import { createConnectorAliasHandlers } from '../../../src/gateway/handlers/connector-alias.js'
import type { Connector, ConnectorSource } from '../../../src/connector/schema.js'
import { makeCanonicalConnectorId } from '../../../src/connector/schema.js'

function mk(source: ConnectorSource, id: string, status: Connector['status'] = 'ready'): Connector {
  return {
    id,
    canonicalId: makeCanonicalConnectorId(source, id),
    name: id,
    description: `${id}`,
    source,
    category: 'other',
    auth: { mode: 'none' },
    status,
    toolNames: null,
  }
}

class StubSource implements ConnectorSourceProvider {
  constructor(readonly name: string, private readonly connectors: readonly Connector[]) {}
  async listGlobal(): Promise<Connector[]> { return [...this.connectors] }
  async listForProfile(): Promise<Connector[]> { return [...this.connectors] }
}

class MemStore implements SourcePreferencesStore {
  readonly data = new Map<string, string>()
  getSetting(k: string) { const v = this.data.get(k); return v === undefined ? undefined : { value: v } }
  setSetting(k: string, v: string) { this.data.set(k, v); return { value: v } }
  deleteSetting(k: string): boolean { return this.data.delete(k) }
}

function makeReq(body: unknown, method = 'PATCH'): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  ;(stream as unknown as { headers: Record<string, string> }).headers = {}
  ;(stream as unknown as { method: string }).method = method
  ;(stream as unknown as { url: string }).url = '/api/v1/connectors/alias/notion/source'
  return stream
}

function makeRes(): ServerResponse & { readonly body: { status?: number; payload?: unknown } } {
  const chunks: string[] = []
  let status = 200
  const res = {
    statusCode: 200,
    setHeader: () => undefined,
    writeHead(s: number) { status = s; return res },
    write(c: string) { chunks.push(c); return true },
    end(c?: string) { if (c) chunks.push(c) },
    headersSent: false,
  } as unknown as ServerResponse & { readonly body: { status?: number; payload?: unknown } }
  Object.defineProperty(res, 'body', {
    get() {
      const text = chunks.join('')
      let payload: unknown = text
      try { payload = JSON.parse(text) } catch { /* noop */ }
      return { status, payload }
    },
  })
  return res
}

function buildRegistry(stubs: readonly ConnectorSourceProvider[], prefs: SourcePreferences): ConnectorRegistry {
  const pr = new ProfileRegistry()
  const reg = new ConnectorRegistry(pr, { sourcePreferences: prefs })
  ;(reg as unknown as { providers: ConnectorSourceProvider[] }).providers = [...stubs]
  return reg
}

// ---------------------------------------------------------------------------
// Suite skipped (Chunk #41, 2026-05-17): the post-2026-05-06 connector
// rebuild dropped Composio from Tier 1 and emptied `CONNECTOR_ALIASES`
// (`src/connector/aliases.ts:54` — `export const CONNECTOR_ALIASES = {}`).
// With no aliases registered, `isAliasLogicalKey('notion')` returns false
// and every request to `setAliasSource` short-circuits to 404 before
// touching the registry — the handler's branches the original tests
// covered are now structurally unreachable.
//
// The handler stays live (it's still wired into the gateway router) so
// when a future slice re-populates the aliases table (e.g. Notion paired
// with a non-Composio second source) we unskip this suite and restore
// real coverage. Synthesising a fake aliases table to keep these tests
// green would be test-only theater — the production code path it
// exercises wouldn't exist until the table re-populates.
// ---------------------------------------------------------------------------
describe.skip('PATCH /connectors/alias/:logicalKey/source', () => {
  let store: MemStore
  let prefs: SourcePreferences

  beforeEach(() => {
    store = new MemStore()
    prefs = new SourcePreferences(store)
  })

  it('persists a valid preference and returns the resolved connector', async () => {
    const reg = buildRegistry([
      new StubSource('mcp', [mk('mcp', 'notion', 'ready')]),
      new StubSource('composio', [mk('composio', 'notion', 'ready')]),
    ], prefs)
    const { setAliasSource } = createConnectorAliasHandlers({ registry: reg, preferences: prefs })
    const req = makeReq({ source: 'composio' })
    const res = makeRes()
    await setAliasSource(req, res, { logicalKey: 'notion' })

    expect(res.body.status).toBe(200)
    const payload = res.body.payload as {
      logicalKey: string
      source: string
      connector: { source: string; canonicalId: string }
    }
    expect(payload.logicalKey).toBe('notion')
    expect(payload.source).toBe('composio')
    expect(payload.connector.canonicalId).toBe('composio:notion')
    expect(store.data.get('connector.alias.notion.source')).toBe('composio')
  })

  it('returns 404 for unknown logical key', async () => {
    const reg = buildRegistry([], prefs)
    const { setAliasSource } = createConnectorAliasHandlers({ registry: reg, preferences: prefs })
    const req = makeReq({ source: 'mcp' })
    const res = makeRes()
    await setAliasSource(req, res, { logicalKey: 'nope' })
    expect(res.body.status).toBe(404)
  })

  it('returns 400 when the requested source has no candidate', async () => {
    const reg = buildRegistry([
      new StubSource('mcp', [mk('mcp', 'notion', 'ready')]),
    ], prefs)
    const { setAliasSource } = createConnectorAliasHandlers({ registry: reg, preferences: prefs })
    const req = makeReq({ source: 'composio' })
    const res = makeRes()
    await setAliasSource(req, res, { logicalKey: 'notion' })
    expect(res.body.status).toBe(400)
    const msg = (res.body.payload as { message?: string }).message ?? ''
    expect(msg).toMatch(/not available/i)
  })

  it('returns 400 when no candidate exists at all for the logical key', async () => {
    const reg = buildRegistry([], prefs)
    const { setAliasSource } = createConnectorAliasHandlers({ registry: reg, preferences: prefs })
    const req = makeReq({ source: 'mcp' })
    const res = makeRes()
    await setAliasSource(req, res, { logicalKey: 'notion' })
    expect(res.body.status).toBe(400)
  })

  it('returns 400 when body is missing', async () => {
    const reg = buildRegistry([
      new StubSource('mcp', [mk('mcp', 'notion', 'ready')]),
      new StubSource('composio', [mk('composio', 'notion', 'ready')]),
    ], prefs)
    const { setAliasSource } = createConnectorAliasHandlers({ registry: reg, preferences: prefs })
    const req = makeReq(null)
    const res = makeRes()
    await setAliasSource(req, res, { logicalKey: 'notion' })
    expect(res.body.status).toBe(400)
  })

  it('returns 400 when body is malformed', async () => {
    const reg = buildRegistry([
      new StubSource('mcp', [mk('mcp', 'notion', 'ready')]),
    ], prefs)
    const { setAliasSource } = createConnectorAliasHandlers({ registry: reg, preferences: prefs })
    const req = makeReq({ wrong: 'field' })
    const res = makeRes()
    await setAliasSource(req, res, { logicalKey: 'notion' })
    expect(res.body.status).toBe(400)
  })

  it('next registry.list() read reflects the new preference', async () => {
    const reg = buildRegistry([
      new StubSource('mcp', [mk('mcp', 'notion', 'ready')]),
      new StubSource('composio', [mk('composio', 'notion', 'ready')]),
    ], prefs)
    const beforeList = await reg.list()
    expect(beforeList.find(c => c.canonicalId.endsWith(':notion'))?.source).toBe('mcp')

    const { setAliasSource } = createConnectorAliasHandlers({ registry: reg, preferences: prefs })
    const req = makeReq({ source: 'composio' })
    const res = makeRes()
    await setAliasSource(req, res, { logicalKey: 'notion' })
    expect(res.body.status).toBe(200)

    const afterList = await reg.list()
    expect(afterList.find(c => c.canonicalId.endsWith(':notion'))?.source).toBe('composio')
  })

  it('returns 400 for an empty logicalKey param', async () => {
    const reg = buildRegistry([], prefs)
    const { setAliasSource } = createConnectorAliasHandlers({ registry: reg, preferences: prefs })
    const req = makeReq({ source: 'mcp' })
    const res = makeRes()
    await setAliasSource(req, res, { logicalKey: '' })
    expect(res.body.status).toBe(400)
  })

  it('rejects extra body fields (strict schema)', async () => {
    const reg = buildRegistry([
      new StubSource('mcp', [mk('mcp', 'notion', 'ready')]),
      new StubSource('composio', [mk('composio', 'notion', 'ready')]),
    ], prefs)
    const { setAliasSource } = createConnectorAliasHandlers({ registry: reg, preferences: prefs })
    const req = makeReq({ source: 'mcp', extra: 'nope' })
    const res = makeRes()
    await setAliasSource(req, res, { logicalKey: 'notion' })
    expect(res.body.status).toBe(400)
  })
})
