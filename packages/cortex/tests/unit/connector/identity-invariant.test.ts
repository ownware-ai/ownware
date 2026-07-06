/**
 * Identity invariant — connect-write must equal source-read must equal
 * tool-adapter-read.
 *
 * The pre-v19 bug: three independent code paths (connect handler, source
 * provider, tool-adapter) each chose their own default for the
 * `entity_id` column. Rows were written under one identity and read
 * under another. The Tools modal looked correct because IT used the
 * same default the row had been written with; the agent's tool list
 * was wrong because the assembler used a DIFFERENT default.
 *
 * This test exercises the full loop end to end and would fail if any
 * future change reintroduces the drift. It does NOT mock the store —
 * it uses a real SQLite DB via CortexDatabase so the schema-layer
 * NOT NULL constraint (migration 019) is also exercised.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { ConnectorConnectionsStore } from '../../../src/connector/connections/store.js'
import { createConnectorStatusBus } from '../../../src/connector/status-bus.js'
import { createComposioSource } from '../../../src/connector/composio/source.js'
import {
  ComposioToolProvider,
  buildToolName,
} from '../../../src/connector/composio/tool-adapter.js'
import type {
  ComposioClient,
  ComposioCreateConnectionLinkResponse,
  ComposioToolkitSummary,
} from '../../../src/connector/composio/client.js'
import type { ComposioCatalogCache } from '../../../src/connector/composio/catalog-cache.js'
import type { LoadedProfile } from '../../../src/profile/loader.js'
import { createConnectorConnectHandlers } from '../../../src/gateway/handlers/connector-connect.js'
import { ConnectionCompletionManager } from '../../../src/connector/completion/manager.js'
import { InstallIdentity } from '../../../src/identity/install-identity.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectorRegistry } from '../../../src/connector/registry.js'
import type { Connector } from '../../../src/connector/schema.js'

let tmpDir: string
let db: CortexDatabase
let connections: ConnectorConnectionsStore
let catalogCache: ComposioCatalogCache

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-identity-invariant-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  connections = new ConnectorConnectionsStore(db.rawMainHandle)
  // Stub catalogue cache containing one toolkit. The historical
  // ComposioCatalogStore here held a `gmail` row with hasManagedAuthConfig=true;
  // post-rip that field has no on-the-wire equivalent and discovery is
  // click-time, so we only need the toolkit summary to exist.
  const gmail = {
    slug: 'gmail',
    name: 'Gmail',
    auth_schemes: ['oauth2'],
    is_local_toolkit: false,
    deprecated: false,
    no_auth: false,
    meta: {
      categories: [{ id: 'communication', name: 'communication' }],
      description: 'Gmail',
    },
  } as unknown as ComposioToolkitSummary
  catalogCache = {
    listToolkits: async () => [gmail],
    getBySlug: async (slug: string) => (slug === 'gmail' ? gmail : null),
    invalidate: () => {},
  } as unknown as ComposioCatalogCache
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// Minimal Express-shaped mocks. Only `writeHead` + `end` are exercised
// by the connect handler's success path; we don't care about the body.
function makeReq(body: unknown): IncomingMessage {
  return {
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    on(event: string, cb: (chunk?: Buffer | null) => void) {
      if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb()
      return this
    },
  } as unknown as IncomingMessage
}
function makeRes(): ServerResponse & { captured: { status: number; payload: unknown } } {
  const captured = { status: 200, payload: undefined as unknown }
  const chunks: string[] = []
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead(s: number) { captured.status = s; return this },
    write(c: string) { chunks.push(c); return true },
    end(c?: string) {
      if (c) chunks.push(c)
      const joined = chunks.join('')
      try { captured.payload = JSON.parse(joined) } catch { captured.payload = joined }
    },
  } as unknown as ServerResponse & { captured: { status: number; payload: unknown } }
  res.captured = captured
  return res
}

function fakeConnector(id: string): Connector {
  return {
    id, canonicalId: `composio:${id}`, name: id, description: '', source: 'composio',
    category: 'communication', auth: { mode: 'oauth' }, status: 'needs_setup',
    toolNames: null, iconUrl: null,
  } as Connector
}

function stubRegistry(connector: Connector): ConnectorRegistry {
  return {
    get: async (id: string) => id === connector.id ? connector : null,
    list: async () => [connector],
    listForProfile: async () => [connector],
    addSource: () => {},
  } as unknown as ConnectorRegistry
}

function profileWithGmail(): LoadedProfile {
  return {
    name: 'p',
    config: { tools: { composio: { toolkits: ['gmail'] } } },
  } as unknown as LoadedProfile
}

describe('install-identity invariant: connect → list → assemble', () => {
  it('every code path keys on the same entity_id; agent sees the connection the modal wrote', async () => {
    // 1. Resolve install identity ONCE — this is what the gateway does
    //    at boot and threads through every consumer.
    const identity = InstallIdentity.resolve({ OWNWARE_COMPOSIO_USER_ID: 'team-acme' })
    expect(identity.id).toBe('team-acme')

    // 2. Drive the connect handler — writes the row.
    const composioClient = {
      listAuthConfigs: vi.fn().mockResolvedValue({
        items: [{ id: 'ac_1', is_composio_managed: true, status: 'ENABLED' }],
      }),
      createConnectionLink: vi.fn().mockResolvedValue({
        connected_account_id: 'ca_1',
        redirect_url: 'https://oauth/redirect',
        link_token: 'lnk_1',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      } satisfies ComposioCreateConnectionLinkResponse),
    } as unknown as ComposioClient

    const completionManager = new ConnectionCompletionManager(
      connections, createConnectorStatusBus(),
    )
    // Register a no-op listener so dispatch doesn't throw.
    completionManager.registerListener({
      source: 'composio',
      poll: async () => ({ done: false }),
    } as unknown as Parameters<typeof completionManager.registerListener>[0])

    const handlers = createConnectorConnectHandlers({
      registry: stubRegistry(fakeConnector('gmail')),
      connections,
      completionManager,
      composio: { client: composioClient, defaultUserId: identity.id },
    })

    const res = makeRes()
    await handlers.connect(
      makeReq({}),
      res,
      { id: 'gmail' },
    )

    // The handler 200s on success.
    expect(res.captured.status).toBe(200)

    // The Composio API call carried our identity as userId.
    expect(composioClient.createConnectionLink).toHaveBeenCalledWith(
      expect.objectContaining({ userId: identity.id }),
    )

    // 3. Mark the row ready (Composio's poller would do this in prod).
    connections.markReady({ connectionId: 'ca_1' })

    // 4. Modal-side read: the connector source's `findActive` lookup.
    const source = createComposioSource({
      apiKey: 'k', catalogCache, connections,
      statusBus: createConnectorStatusBus(),
      entityId: identity.id,
    })!
    const fromList = await source.listGlobal()
    const gmailFromList = fromList.find(c => c.id === 'gmail')
    expect(gmailFromList).toBeDefined()
    expect(gmailFromList!.status).toBe('ready')

    // 5. Agent-side read: the tool adapter's same lookup.
    const adapter = new ComposioToolProvider({
      client: composioClient,
      catalogCache,
      connections,
      entityId: identity.id,
      log: () => {},
    })
    const result = await adapter.getToolsForProfile(profileWithGmail(), {
      existingTools: [] as const,
    })

    // The tool list contains EITHER the real tools OR the "ready but
    // empty" stub (manifest not warmed yet) — but never the
    // not_connected stub. The bug we're guarding against is
    // specifically `composio_gmail_not_connected` showing up here.
    const stubName = buildToolName('gmail', 'not_connected')
    const sawNotConnectedStub = result.stubs.some((s) => s.name === stubName)
    expect(sawNotConnectedStub).toBe(false)
  })

  it('fails loudly when an attempt is made to read with the wrong entity', async () => {
    // Defense-in-depth: even if someone bypasses InstallIdentity, the
    // store query MUST be entity-scoped. A different identity reads
    // nothing — never silently falls back to "any row."
    connections.upsertPending({
      connectionId: 'ca_x', connectorId: 'gmail', source: 'composio',
      entityId: 'identity-A', authConfigId: 'ac_x',
    })
    connections.markReady({ connectionId: 'ca_x' })

    expect(connections.findActive('gmail', 'composio', 'identity-A')?.status).toBe('ready')
    expect(connections.findActive('gmail', 'composio', 'identity-B')).toBeNull()
  })
})
