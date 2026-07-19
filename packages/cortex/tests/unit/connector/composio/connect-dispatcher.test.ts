/**
 * POST /api/v1/connectors/:id/connect — dispatcher tests.
 *
 * These cover the 8 reliability scenarios in the 2b.1 brief by calling
 * the handler factory directly with a mocked registry / client /
 * completion manager. No HTTP; we feed an IncomingMessage-shaped req
 * and capture ServerResponse writes.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { ServerResponse } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { CortexDatabase } from '../../../../src/gateway/db/database.js'
import { ConnectorConnectionsStore } from '../../../../src/connector/connections/store.js'
import { CredentialVault } from '../../../../src/connector/credentials/vault.js'
import { ConnectionSessionVault } from '../../../../src/connector/connections/session-vault.js'
import {
  ConnectionCompletionManager,
  type ConnectionCompletionManagerOptions,
} from '../../../../src/connector/completion/manager.js'
import { ConnectorStatusBus } from '../../../../src/connector/status-bus.js'
import { ComposioClient, type ComposioConnectionLink, type ComposioAuthConfig } from '../../../../src/connector/composio/client.js'
import { ComposioCompletionListener } from '../../../../src/connector/composio/listener.js'
import {
  createConnectorConnectHandlers,
  type ConnectorConnectHandlersDeps,
} from '../../../../src/gateway/handlers/connector-connect.js'
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
let connectionSessions: ConnectionSessionVault

function makeConnectHandlers(
  deps: Omit<ConnectorConnectHandlersDeps, 'connectionSessions'>,
) {
  return createConnectorConnectHandlers({ ...deps, connectionSessions })
}

function makeCompletionManager(
  pollerConfig: NonNullable<ConnectionCompletionManagerOptions['pollerConfig']> = {},
) {
  return new ConnectionCompletionManager(connections, statusBus, {
    pollerConfig,
    beforeTerminal: async ({ metadata }) => {
      const handle = metadata?.['sessionHandle']
      if (typeof handle === 'string') await connectionSessions.remove(handle)
    },
  })
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-connect-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  connections = new ConnectorConnectionsStore(db.rawMainHandle)
  statusBus = new ConnectorStatusBus()
  connectionSessions = new ConnectionSessionVault(
    new CredentialVault(join(tmpDir, 'connection-sessions')),
  )
  completionManager = makeCompletionManager({ initialDelayMs: 60_000 })
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
      link_token: 'pcc17-link-secret-never-persist',
      redirect_url: 'https://auth.example/url?pcc17-session-secret=1',
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

    const handlers = makeConnectHandlers({
      registry: stubRegistry([composioConnector('github')]),
      connections, completionManager,
      composio: { client, defaultUserId: 'pcc17-install-id-never-metadata' },
    })

    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'github' })
    expect(res.body.status).toBe(200)
    const p = res.body.payload as Record<string, unknown>
    expect(p).toMatchObject({
      connectionId: 'ca_new',
      status: 'pending',
      authorizationUrl: 'https://auth.example/url?pcc17-session-secret=1',
      authConfigId: 'ac_1',
      reused: false,
    })
    const row = connections.findByConnectionId('ca_new')
    expect(row?.authConfigId).toBe('ac_1')
    expect(row?.status).toBe('pending')
    const raw = db.rawMainHandle.prepare(
      'SELECT metadata_json FROM connector_connections WHERE connection_id = ?',
    ).get('ca_new') as { metadata_json: string | null }
    expect(raw.metadata_json).not.toContain('pcc17-link-secret-never-persist')
    expect(raw.metadata_json).not.toContain('pcc17-install-id-never-metadata')
    expect(raw.metadata_json).not.toContain('pcc17-session-secret')
    expect(raw.metadata_json).not.toContain('linkToken')
    expect(raw.metadata_json).not.toContain('userId')
    const sessionHandle = row?.metadata?.sessionHandle
    expect(sessionHandle).toMatch(/^connection-session\./)
    await expect(connectionSessions.read(sessionHandle!, {
      connectionId: 'ca_new',
      connectorId: 'github',
      source: 'composio',
      entityId: 'pcc17-install-id-never-metadata',
    })).resolves.toMatchObject({
      authorizationUrl: link.redirect_url,
      linkToken: link.link_token,
    })
    const encrypted = readFileSync(
      join(tmpDir, 'connection-sessions', `${sessionHandle}.json`),
      'utf8',
    )
    expect(encrypted).toMatch(/^v2:/)
    for (const canary of [
      'pcc17-link-secret-never-persist',
      'pcc17-install-id-never-metadata',
      'pcc17-session-secret',
    ]) {
      expect(encrypted).not.toContain(canary)
    }
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

    const handlers = makeConnectHandlers({
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

    const handlers = makeConnectHandlers({
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
    const handlers = makeConnectHandlers({
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
    const expiresAt = Date.now() + 60_000
    const sessionHandle = await connectionSessions.create({
      connectionId: 'ca_old',
      connectorId: 'github',
      source: 'composio',
      entityId: 'u',
      authorizationUrl: 'https://prior/url',
      linkToken: 'opaque-test-link-token',
      expiresAt,
    })
    const existing = connections.upsertPending({
      connectionId: 'ca_old', connectorId: 'github', source: 'composio',
      entityId: 'u',
      expiresAt,
      authConfigId: 'ac_old',
      metadata: { sessionHandle },
    })
    const client = stubComposioClient({
      listAuthConfigs: vi.fn(), createConnectionLink: vi.fn(),
    })
    const handlers = makeConnectHandlers({
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

  it('concurrent starts preserve one referenced encrypted session without orphaning the loser', async () => {
    const authConfig = {
      id: 'ac_race', is_composio_managed: true,
      toolkit: { slug: 'github', logo: '' }, status: 'ENABLED',
    } as unknown as ComposioAuthConfig
    let releaseBoth!: () => void
    const bothEntered = new Promise<void>((resolve) => { releaseBoth = resolve })
    let listCalls = 0
    let linkCalls = 0
    const client = stubComposioClient({
      listAuthConfigs: vi.fn(async () => {
        listCalls += 1
        if (listCalls === 2) releaseBoth()
        await bothEntered
        return { items: [authConfig] }
      }),
      createConnectionLink: vi.fn(async () => {
        linkCalls += 1
        return {
          link_token: `synthetic-race-token-${linkCalls}`,
          redirect_url: `https://auth.example/race/${linkCalls}`,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          connected_account_id: `ca_race_${linkCalls}`,
        }
      }),
      getConnectedAccount: vi.fn(async (connectionId: string) => ({
        id: connectionId,
        toolkit: { slug: 'github' },
        auth_config: { id: 'ac_race', is_composio_managed: true },
        status: 'INITIATED',
      })),
    })
    completionManager.registerListener(new ComposioCompletionListener({ client }))
    const handlers = makeConnectHandlers({
      registry: stubRegistry([composioConnector('github')]),
      connections,
      completionManager,
      composio: { client, defaultUserId: 'synthetic-user' },
    })
    const first = makeRes()
    const second = makeRes()

    await Promise.all([
      handlers.connect(makeReq({}), first, { id: 'github' }),
      handlers.connect(makeReq({}), second, { id: 'github' }),
    ])

    expect(first.body.status).toBe(200)
    expect(second.body.status).toBe(200)
    expect(linkCalls).toBe(2)
    expect(connections.findPending()).toHaveLength(1)
    expect(readdirSync(join(tmpDir, 'connection-sessions'))).toHaveLength(1)
    completionManager.cancelAll()
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
    const manager = makeCompletionManager({
      initialDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 1, maxDurationMs: 5000,
    })
    manager.registerListener(new ComposioCompletionListener({ client }))

    const handlers = makeConnectHandlers({
      registry: stubRegistry([composioConnector('slack')]),
      connections, completionManager: manager,
      composio: { client, defaultUserId: 'u' },
    })
    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'slack' })
    expect(res.body.status).toBe(200)
    const sessionHandle = connections.findByConnectionId('ca_active')?.metadata?.sessionHandle

    // Wait for poller to tick.
    await new Promise(r => setTimeout(r, 50))
    const row = connections.findByConnectionId('ca_active')
    expect(row?.status).toBe('ready')
    expect(row?.metadata).toBeNull()
    expect(existsSync(
      join(tmpDir, 'connection-sessions', `${sessionHandle}.json`),
    )).toBe(false)
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
    const manager = makeCompletionManager({
      initialDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 1, maxDurationMs: 5000,
    })
    manager.registerListener(new ComposioCompletionListener({ client }))

    const handlers = makeConnectHandlers({
      registry: stubRegistry([composioConnector('notion')]),
      connections, completionManager: manager,
      composio: { client, defaultUserId: 'u' },
    })
    await handlers.connect(makeReq({}), makeRes(), { id: 'notion' })
    const sessionHandle = connections.findByConnectionId('ca_exp')?.metadata?.sessionHandle
    await new Promise(r => setTimeout(r, 50))
    const row = connections.findByConnectionId('ca_exp')
    expect(row?.status).toBe('failed')
    expect(row?.metadata).toBeNull()
    expect(existsSync(
      join(tmpDir, 'connection-sessions', `${sessionHandle}.json`),
    )).toBe(false)
    expect(row?.errorReason).toMatch(/reconnect/i)
    manager.cancelAll()
  })

  it('scenario 7 (boot-without-key): when composio dep absent, composio id → 501 not_configured', async () => {
    const handlers = makeConnectHandlers({
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

  it('scenario 8: Composio schema drift → safe 502 without raw vendor detail', async () => {
    // Stub raw fetch at the client level by making listAuthConfigs reject.
    const client = stubComposioClient({
      listAuthConfigs: vi.fn(async () => { throw new (await import('../../../../src/connector/errors.js')).ConnectorVendorError('schema drift', { source: 'composio' }) }),
    })
    const handlers = makeConnectHandlers({
      registry: stubRegistry([composioConnector('github')]),
      connections, completionManager,
      composio: { client, defaultUserId: 'u' },
    })
    const res = makeRes()
    await handlers.connect(makeReq({}), res, { id: 'github' })
    expect(res.body.status).toBe(502)
    const p = res.body.payload as Record<string, unknown>
    expect(String(p.message)).toMatch(/couldn’t return an auth config/i)
    expect(String(p.message)).not.toContain('schema drift')
  })

  it('builtin connector → 400 builtin_no_connect', async () => {
    const handlers = makeConnectHandlers({
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
    const handlers = makeConnectHandlers({
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
    const handlers = makeConnectHandlers({
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
    const handlers = makeConnectHandlers({
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
    const handlers = makeConnectHandlers({
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
      const handlers = makeConnectHandlers({
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
    const handlers = makeConnectHandlers({
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
    const handlers = makeConnectHandlers({
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
    const manager = makeCompletionManager({
      initialDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 1, maxDurationMs: 20,
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
