/**
 * POST /api/v1/connectors/:id/connect — dispatcher tests.
 *
 * These cover the 8 reliability scenarios in the 2b.1 brief by calling
 * the handler factory directly with a mocked registry / client /
 * completion manager. No HTTP; we feed an IncomingMessage-shaped req
 * and capture ServerResponse writes.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { ServerResponse } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { CortexDatabase } from '../../../../src/gateway/db/database.js'
import { ConnectorConnectionsStore } from '../../../../src/connector/connections/store.js'
import { ConnectionCompletionManager } from '../../../../src/connector/completion/manager.js'
import { ConnectorStatusBus } from '../../../../src/connector/status-bus.js'
import { ComposioClient, type ComposioConnectionLink, type ComposioAuthConfig } from '../../../../src/connector/composio/client.js'
import { ComposioCompletionListener } from '../../../../src/connector/composio/listener.js'
import { createConnectorConnectHandlers } from '../../../../src/gateway/handlers/connector-connect.js'
import type { ConnectorRegistry } from '../../../../src/connector/registry.js'
import type { Connector } from '../../../../src/connector/schema.js'

// ── Test infra ──────────────────────────────────────────────────────────

function makeReq(body: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  ;(stream as unknown as { headers: Record<string, string> }).headers = {}
  ;(stream as unknown as { method: string }).method = 'POST'
  ;(stream as unknown as { url: string }).url = '/api/v1/connectors/x/connect'
  return stream
}

function makeRes(): ServerResponse & {
  readonly body: { status?: number; payload?: unknown }
} {
  const chunks: string[] = []
  let status = 200
  const res = {
    statusCode: 200,
    setHeader: () => undefined,
    writeHead(s: number) { status = s; return res },
    write(chunk: string) { chunks.push(chunk); return true },
    end(chunk?: string) { if (chunk) chunks.push(chunk) },
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
  return res as ServerResponse & { readonly body: { status?: number; payload?: unknown } }
}

function stubRegistry(connectors: Connector[]): ConnectorRegistry {
  return {
    async get(id: string) { return connectors.find(c => c.id === id) ?? null },
    async list() { return connectors },
    async listForProfile() { return connectors },
    async refresh() { /* noop */ },
    addSource() { /* noop */ },
  } as unknown as ConnectorRegistry
}

function composioConnector(id = 'github'): Connector {
  return {
    id, name: id, description: '', source: 'composio', category: 'dev-tools',
    auth: { mode: 'oauth', provider: id, hasPreset: false },
    status: 'needs_setup', toolNames: null,
  }
}

function stubComposioClient(impl: Partial<ComposioClient>): ComposioClient {
  return impl as unknown as ComposioClient
}

// ── Fixture ─────────────────────────────────────────────────────────────

let tmpDir: string
let db: CortexDatabase
let connections: ConnectorConnectionsStore
let statusBus: ConnectorStatusBus
let completionManager: ConnectionCompletionManager

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-connect-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  connections = new ConnectorConnectionsStore(db.rawMainHandle)
  statusBus = new ConnectorStatusBus()
  completionManager = new ConnectionCompletionManager(connections, statusBus, {
    pollerConfig: { initialDelayMs: 60_000 },
  })
})

afterEach(() => {
  completionManager.cancelAll()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── Scenarios ───────────────────────────────────────────────────────────

describe('POST /connectors/:id/connect — Composio', () => {
  it('scenario 1: managed auth → returns authorizationUrl and persists pending with auth_config_id', async () => {
    const authConfig = {
      id: 'ac_1', is_composio_managed: true, toolkit: { slug: 'github', logo: '' }, status: 'ENABLED',
    } as unknown as ComposioAuthConfig
    const link: ComposioConnectionLink = {
      link_token: 'lt', redirect_url: 'https://auth.example/url',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      connected_account_id: 'ca_new',
    }
    const client = stubComposioClient({
      listAuthConfigs: vi.fn(async () => ({ items: [authConfig] })),
      createConnectionLink: vi.fn(async () => link),
      getConnectedAccount: vi.fn(async () => ({
        id: 'ca_new', toolkit: { slug: 'github' },
        auth_config: { id: 'ac_1', is_composio_managed: true }, status: 'INITIATED',
      })),
    })
    completionManager.registerListener(new ComposioCompletionListener({ client }))

    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry([composioConnector('github')]),
      connections, completionManager,
      composio: { client, defaultUserId: 'u_default' },
    })

    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'github' })
    expect(res.body.status).toBe(200)
    const p = res.body.payload as Record<string, unknown>
    expect(p).toMatchObject({
      connectionId: 'ca_new',
      status: 'pending',
      authorizationUrl: 'https://auth.example/url',
      authConfigId: 'ac_1',
      reused: false,
    })
    const row = connections.findByConnectionId('ca_new')
    expect(row?.authConfigId).toBe('ac_1')
    expect(row?.status).toBe('pending')
    expect(row?.metadata).toMatchObject({ authorizationUrl: 'https://auth.example/url' })
    completionManager.cancel('ca_new')
  })

  it('scenario 1b: BYO auth (is_composio_managed=false) is accepted just like managed', async () => {
    // Regression guard for BUGS.md #1 (connector-rail-2026-05-11):
    // Pre-2026-05-21 the handler filtered with `is_composio_managed=true`,
    // returning 400 composio_no_managed_auth for any toolkit where the
    // user had only a BYO config. Symptom: user creates a custom OAuth
    // app entry in Composio (own client_id + secret), comes back to
    // the client, clicks Connect, sees "Setup needed" forever.
    const byoAuthConfig = {
      id: 'ac_byo', is_composio_managed: false, toolkit: { slug: 'jira', logo: '' }, status: 'ENABLED',
    } as unknown as ComposioAuthConfig
    const link: ComposioConnectionLink = {
      link_token: 'lt', redirect_url: 'https://auth.example/byo',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      connected_account_id: 'ca_byo',
    }
    const client = stubComposioClient({
      listAuthConfigs: vi.fn(async () => ({ items: [byoAuthConfig] })),
      createConnectionLink: vi.fn(async () => link),
      getConnectedAccount: vi.fn(async () => ({
        id: 'ca_byo', toolkit: { slug: 'jira' },
        auth_config: { id: 'ac_byo', is_composio_managed: false }, status: 'INITIATED',
      })),
    })
    completionManager.registerListener(new ComposioCompletionListener({ client }))

    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry([composioConnector('jira')]),
      connections, completionManager,
      composio: { client, defaultUserId: 'u_default' },
    })

    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'jira' })
    expect(res.body.status).toBe(200)
    const p = res.body.payload as Record<string, unknown>
    expect(p).toMatchObject({
      connectionId: 'ca_byo',
      status: 'pending',
      authConfigId: 'ac_byo',
    })
    completionManager.cancel('ca_byo')
  })

  it('scenario 1c: managed is preferred when both managed and BYO exist for the same toolkit', async () => {
    // When both kinds of auth_config exist, we pick the managed one —
    // it's the path most users follow and avoids surprising a user
    // whose BYO config is half-set-up.
    const managedAuthConfig = {
      id: 'ac_managed', is_composio_managed: true, toolkit: { slug: 'gmail', logo: '' }, status: 'ENABLED',
    } as unknown as ComposioAuthConfig
    const byoAuthConfig = {
      id: 'ac_byo', is_composio_managed: false, toolkit: { slug: 'gmail', logo: '' }, status: 'ENABLED',
    } as unknown as ComposioAuthConfig
    const link: ComposioConnectionLink = {
      link_token: 'lt', redirect_url: 'https://auth.example/managed',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      connected_account_id: 'ca_managed',
    }
    const client = stubComposioClient({
      // List order intentionally has BYO first — the handler must
      // still pick managed via the prefer-managed predicate, not
      // first-in-list.
      listAuthConfigs: vi.fn(async () => ({ items: [byoAuthConfig, managedAuthConfig] })),
      createConnectionLink: vi.fn(async () => link),
      getConnectedAccount: vi.fn(async () => ({
        id: 'ca_managed', toolkit: { slug: 'gmail' },
        auth_config: { id: 'ac_managed', is_composio_managed: true }, status: 'INITIATED',
      })),
    })
    completionManager.registerListener(new ComposioCompletionListener({ client }))

    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry([composioConnector('gmail')]),
      connections, completionManager,
      composio: { client, defaultUserId: 'u_default' },
    })

    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'gmail' })
    expect(res.body.status).toBe(200)
    const p = res.body.payload as Record<string, unknown>
    expect(p.authConfigId).toBe('ac_managed')
    completionManager.cancel('ca_managed')
  })

  it('scenario 2: no managed auth → 400 composio_no_managed_auth, no row persisted', async () => {
    const client = stubComposioClient({
      listAuthConfigs: vi.fn(async () => ({ items: [] })),
    })
    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry([composioConnector('obscure-app')]),
      connections, completionManager,
      composio: { client, defaultUserId: 'u' },
    })
    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'obscure-app' })
    expect(res.body.status).toBe(400)
    const p = res.body.payload as Record<string, unknown>
    expect(p.error).toBe('composio_no_managed_auth')
    expect(connections.findActive('obscure-app', 'composio', 'u')).toBeNull()
  })

  it('scenario 3: re-click while pending → existing row reused (idempotent)', async () => {
    const existing = connections.upsertPending({
      connectionId: 'ca_old', connectorId: 'github', source: 'composio',
      entityId: 'u',
      authConfigId: 'ac_old',
      metadata: { authorizationUrl: 'https://prior/url' },
    })
    const client = stubComposioClient({
      listAuthConfigs: vi.fn(), createConnectionLink: vi.fn(),
    })
    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry([composioConnector('github')]),
      connections, completionManager,
      composio: { client, defaultUserId: 'u' },
    })
    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'github' })
    expect(res.body.status).toBe(200)
    const p = res.body.payload as Record<string, unknown>
    expect(p).toMatchObject({
      connectionId: existing.connectionId,
      authConfigId: 'ac_old',
      authorizationUrl: 'https://prior/url',
      reused: true,
    })
    expect(client.listAuthConfigs).not.toHaveBeenCalled()
    expect(client.createConnectionLink).not.toHaveBeenCalled()
  })

  it('scenario 5: Composio returns ACTIVE → row marked ready, SSE event fires', async () => {
    const events: unknown[] = []
    statusBus.subscribe(e => events.push(e))

    const client = stubComposioClient({
      listAuthConfigs: vi.fn(async () => ({
        items: [{ id: 'ac_a', is_composio_managed: true, toolkit: { slug: 'slack', logo: '' } } as unknown as ComposioAuthConfig],
      })),
      createConnectionLink: vi.fn(async () => ({
        link_token: 'lt', redirect_url: 'https://r', expires_at: new Date(Date.now() + 120_000).toISOString(),
        connected_account_id: 'ca_active',
      })),
      getConnectedAccount: vi.fn(async () => ({
        id: 'ca_active', toolkit: { slug: 'slack' },
        auth_config: { id: 'ac_a', is_composio_managed: true }, status: 'ACTIVE',
      })),
    })

    // Use fast poller so `register` fires quickly.
    const manager = new ConnectionCompletionManager(connections, statusBus, {
      pollerConfig: { initialDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 1, maxDurationMs: 5000 },
    })
    manager.registerListener(new ComposioCompletionListener({ client }))

    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry([composioConnector('slack')]),
      connections, completionManager: manager,
      composio: { client, defaultUserId: 'u' },
    })
    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'slack' })
    expect(res.body.status).toBe(200)

    // Wait for poller to tick.
    await new Promise(r => setTimeout(r, 50))
    const row = connections.findByConnectionId('ca_active')
    expect(row?.status).toBe('ready')
    expect(events.length).toBeGreaterThan(0)
    manager.cancelAll()
  })

  it('scenario 6: Composio returns EXPIRED → row marked failed with reconnect prompt', async () => {
    const client = stubComposioClient({
      listAuthConfigs: vi.fn(async () => ({
        items: [{ id: 'ac_e', is_composio_managed: true, toolkit: { slug: 'notion', logo: '' } } as unknown as ComposioAuthConfig],
      })),
      createConnectionLink: vi.fn(async () => ({
        link_token: 'lt', redirect_url: 'https://r', expires_at: new Date(Date.now() + 60_000).toISOString(),
        connected_account_id: 'ca_exp',
      })),
      getConnectedAccount: vi.fn(async () => ({
        id: 'ca_exp', toolkit: { slug: 'notion' },
        auth_config: { id: 'ac_e', is_composio_managed: true }, status: 'EXPIRED',
      })),
    })
    const manager = new ConnectionCompletionManager(connections, statusBus, {
      pollerConfig: { initialDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 1, maxDurationMs: 5000 },
    })
    manager.registerListener(new ComposioCompletionListener({ client }))

    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry([composioConnector('notion')]),
      connections, completionManager: manager,
      composio: { client, defaultUserId: 'u' },
    })
    await handlers.connect(makeReq({}), makeRes(), { id: 'notion' })
    await new Promise(r => setTimeout(r, 50))
    const row = connections.findByConnectionId('ca_exp')
    expect(row?.status).toBe('failed')
    expect(row?.errorReason).toMatch(/reconnect/i)
    manager.cancelAll()
  })

  it('scenario 7 (boot-without-key): when composio dep absent, composio id → 501 not_configured', async () => {
    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry([composioConnector('github')]),
      connections, completionManager,
      // composio: undefined
    })
    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'github' })
    expect(res.body.status).toBe(501)
    const p = res.body.payload as Record<string, unknown>
    expect(p.error).toBe('composio_not_configured')
  })

  it('scenario 8: Composio schema drift → ConnectorVendorError surfaces as 502', async () => {
    // Stub raw fetch at the client level by making listAuthConfigs reject.
    const client = stubComposioClient({
      listAuthConfigs: vi.fn(async () => { throw new (await import('../../../../src/connector/errors.js')).ConnectorVendorError('schema drift', { source: 'composio' }) }),
    })
    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry([composioConnector('github')]),
      connections, completionManager,
      composio: { client, defaultUserId: 'u' },
    })
    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'github' })
    expect(res.body.status).toBe(502)
    const p = res.body.payload as Record<string, unknown>
    expect(String(p.message)).toMatch(/schema drift/)
  })

  it('builtin connector → 400 builtin_no_connect', async () => {
    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry([{
        id: 'read_file', name: 'read_file', description: '', source: 'builtin',
        category: 'filesystem', auth: { mode: 'none' }, status: 'ready', toolNames: ['read_file'],
      }]),
      connections, completionManager,
    })
    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'read_file' })
    expect(res.body.status).toBe(400)
    const p = res.body.payload as Record<string, unknown>
    expect(p.error).toBe('builtin_no_connect')
  })

  // ── T02: MCP thin-dispatcher branches ───────────────────────────────────
  //
  // Pre-T02 behaviour was a single 400 with code `mcp_use_legacy_connect`.
  // After T02 the dispatcher returns a discriminated 200 pointing at the
  // existing /mcp/oauth/* and /mcp/credentials/* endpoints (which stay
  // intact). The four cases below cover every `auth.mode` value an MCP
  // connector can declare. The legacy 400 must NEVER fire — that is
  // explicitly asserted in the dedicated regression test further down.

  it('mcp connector with auth.mode=none → 200 { kind: "mcp_none", status: "ready" }', async () => {
    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry([{
        id: 'io.github.user/foo',
        canonicalId: 'mcp:io.github.user/foo',
        logicalKey: 'io.github.user/foo',
        name: 'foo', description: '', source: 'mcp',
        category: 'mcp', auth: { mode: 'none' }, status: 'ready', toolNames: null,
      }]),
      connections, completionManager,
    })
    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'io.github.user/foo' })
    expect(res.body.status).toBe(200)
    expect(res.body.payload).toEqual({ kind: 'mcp_none', status: 'ready' })
  })

  it('mcp connector with auth.mode=oauth → 200 { kind: "mcp_oauth", startEndpoint }', async () => {
    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry([{
        id: 'notion-server',
        canonicalId: 'mcp:notion-server',
        logicalKey: 'notion-server',
        name: 'Notion', description: '', source: 'mcp',
        category: 'productivity',
        auth: { mode: 'oauth', provider: 'Notion', hasPreset: true },
        status: 'needs_setup', toolNames: null,
      }]),
      connections, completionManager,
    })
    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'notion-server' })
    expect(res.body.status).toBe(200)
    expect(res.body.payload).toEqual({
      kind: 'mcp_oauth',
      startEndpoint: '/api/v1/mcp/oauth/start/notion-server',
    })
  })

  it('mcp connector with auth.mode=api_key → 200 { kind: "mcp_api_key", required, saveEndpoint }', async () => {
    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry([{
        id: 'github',
        canonicalId: 'mcp:github',
        logicalKey: 'github',
        name: 'GitHub', description: '', source: 'mcp',
        category: 'dev-tools',
        auth: {
          mode: 'api_key',
          envVars: [
            { name: 'GITHUB_TOKEN', description: 'Personal access token', isRequired: true, isSecret: true },
            { name: 'GITHUB_HOST', description: 'Enterprise host (optional)', isRequired: false, isSecret: false },
          ],
        },
        status: 'needs_setup', toolNames: null,
      }]),
      connections, completionManager,
    })
    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'github' })
    expect(res.body.status).toBe(200)
    expect(res.body.payload).toEqual({
      kind: 'mcp_api_key',
      required: [
        { name: 'GITHUB_TOKEN', description: 'Personal access token', isRequired: true },
        { name: 'GITHUB_HOST', description: 'Enterprise host (optional)', isRequired: false },
      ],
      saveEndpoint: '/api/v1/mcp/credentials/github',
    })
  })

  it('user-registered MCP connector goes through the same dispatcher (Phase 16: source unified to mcp)', async () => {
    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry([{
        id: 'my-local-server',
        canonicalId: 'mcp:my-local-server',
        logicalKey: 'my-local-server',
        name: 'Local', description: '', source: 'mcp',
        category: 'custom',
        auth: { mode: 'none' }, status: 'ready', toolNames: null,
      }]),
      connections, completionManager,
    })
    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'my-local-server' })
    expect(res.body.status).toBe(200)
    expect(res.body.payload).toEqual({ kind: 'mcp_none', status: 'ready' })
  })

  it('regression: no MCP path ever returns mcp_use_legacy_connect', async () => {
    // Cover all three auth modes — the legacy 400 must be gone for each.
    const cases = [
      { auth: { mode: 'none' as const } },
      { auth: { mode: 'oauth' as const, provider: 'Foo', hasPreset: false } },
      {
        auth: {
          mode: 'api_key' as const,
          envVars: [
            { name: 'FOO', description: '', isRequired: true, isSecret: true },
          ],
        },
      },
    ]
    for (const { auth } of cases) {
      const handlers = createConnectorConnectHandlers({
        registry: stubRegistry([{
          id: 'srv', canonicalId: 'mcp:srv', logicalKey: 'srv', name: 'srv', description: '',
          source: 'mcp', category: 'mcp', auth, status: 'needs_setup', toolNames: null,
        }]),
        connections, completionManager,
      })
      const res = makeRes()
      await handlers.connect(makeReq({}), res, { id: 'srv' })
      expect(res.body.status).toBe(200)
      const payload = res.body.payload as Record<string, unknown>
      expect(payload.error).toBeUndefined()
    }
  })

  it('every dispatcher response parses against the public Zod schema', async () => {
    const { ConnectConnectorResponseSchema } = await import('../../../../src/connector/schema.js')
    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry([
        { id: 'a', canonicalId: 'mcp:a', logicalKey: 'a', name: 'a', description: '', source: 'mcp',
          category: 'mcp', auth: { mode: 'none' }, status: 'ready', toolNames: null },
        { id: 'b', canonicalId: 'mcp:b', logicalKey: 'b', name: 'b', description: '', source: 'mcp',
          category: 'mcp',
          auth: { mode: 'oauth', provider: 'b', hasPreset: false },
          status: 'needs_setup', toolNames: null },
        { id: 'c', canonicalId: 'mcp:c', logicalKey: 'c', name: 'c', description: '', source: 'mcp',
          category: 'mcp',
          auth: { mode: 'api_key', envVars: [{ name: 'X', description: '', isRequired: true, isSecret: true }] },
          status: 'needs_setup', toolNames: null },
      ]),
      connections, completionManager,
    })
    for (const id of ['a', 'b', 'c']) {
      const res = makeRes()
      await handlers.connect(makeReq({}), res, { id })
      expect(res.body.status).toBe(200)
      // Round-trip — handler-internal validator must pass shape into the
      // public schema; if not, this fails loudly.
      const parsed = ConnectConnectorResponseSchema.safeParse(res.body.payload)
      expect(parsed.success).toBe(true)
    }
  })

  it('unknown connector id → 404', async () => {
    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry([]),
      connections, completionManager,
    })
    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'nonexistent' })
    expect(res.body.status).toBe(404)
  })
})

// ── Scenario 4 (network drop mid-poll → backoff → failed) ──────────────
// This is poller-level behaviour: when the listener throws a
// ConnectorVendorError the poller marks `failed`. A "persistent network
// drop" with our listener's transient-mapping returns `pending` forever
// and eventually hits the poller's `maxDurationMs` → `expired`. We
// verify that maps-to-expired path here.
describe('scenario 4: persistent network drop → listener keeps returning pending → poller expires row', () => {
  it('expires after maxDurationMs', async () => {
    const client = stubComposioClient({
      getConnectedAccount: vi.fn(async () => {
        const { ConnectorNetworkError } = await import('../../../../src/connector/errors.js')
        throw new ConnectorNetworkError('down', { source: 'composio' })
      }),
    })
    const manager = new ConnectionCompletionManager(connections, statusBus, {
      pollerConfig: { initialDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 1, maxDurationMs: 20 },
    })
    manager.registerListener(new ComposioCompletionListener({ client }))

    connections.upsertPending({
      connectionId: 'net_1', connectorId: 'x', source: 'composio',
      entityId: 'cortex-default-user',
      expiresAt: Date.now() + 1000, authConfigId: 'ac_x',
    })
    manager.dispatch('net_1')
    await new Promise(r => setTimeout(r, 80))
    const row = connections.findByConnectionId('net_1')
    expect(row?.status).toBe('expired')
    manager.cancelAll()
  })
})
