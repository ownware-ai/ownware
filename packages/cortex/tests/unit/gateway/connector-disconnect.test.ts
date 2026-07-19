/**
 * DELETE /api/v1/connectors/:id/connect — Composio revoke.
 *
 * Covers:
 *   - Composio happy path: vendor DELETE fires, local row flips to
 *     `expired`, status bus emits `needs_setup`.
 *   - No active connection: returns 204 (nothing to do).
 *   - Vendor failure: 502 and the local row stays `ready` so the
 *     user doesn't see a false "disconnected" state.
 *   - Builtin + MCP branches: explicit 400 pointing at the correct
 *     endpoint.
 *   - Unknown connector id: 404.
 */

if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'test-dummy'
if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'test-dummy'
if (!process.env['GOOGLE_API_KEY']) process.env['GOOGLE_API_KEY'] = 'test-dummy'
process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { ConnectorConnectionsStore } from '../../../src/connector/connections/store.js'
import { createConnectorStatusBus } from '../../../src/connector/status-bus.js'
import { ConnectorRegistry } from '../../../src/connector/registry.js'
import { ProfileRegistry } from '../../../src/profile/registry.js'
import {
  createConnectorDisconnectHandlers,
  type ConnectorDisconnectHandlersDeps,
} from '../../../src/gateway/handlers/connector-disconnect.js'
import type { ConnectorSourceProvider } from '../../../src/connector/registry.js'
import type { Connector } from '../../../src/connector/schema.js'
import { makeCanonicalConnectorId } from '../../../src/connector/schema.js'

let tmpDir: string
let db: CortexDatabase
let connections: ConnectorConnectionsStore
let cancelCompletion: ReturnType<typeof vi.fn>
let removeSession: ReturnType<typeof vi.fn>

function makeDisconnectHandlers(
  deps: Omit<ConnectorDisconnectHandlersDeps, 'completionManager' | 'connectionSessions'>,
) {
  return createConnectorDisconnectHandlers({
    ...deps,
    completionManager: { cancel: cancelCompletion },
    connectionSessions: { remove: removeSession },
  })
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-disconnect-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  connections = new ConnectorConnectionsStore(db.rawMainHandle)
  cancelCompletion = vi.fn()
  removeSession = vi.fn().mockResolvedValue(undefined)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function mockReq(): IncomingMessage {
  return { url: '/api/v1/connectors/gmail/connect', headers: { host: 'localhost' } } as unknown as IncomingMessage
}

function mockRes(): { res: ServerResponse; captured: { status: number; body: unknown } } {
  const captured = { status: 0, body: null as unknown }
  const res = {
    writeHead(status: number) {
      captured.status = status
      return this
    },
    end(payload?: string) {
      captured.body = payload ? JSON.parse(payload) : null
    },
  } as unknown as ServerResponse
  return { res, captured }
}

function composioProviderWith(connectors: readonly Connector[]): ConnectorSourceProvider {
  return {
    name: 'composio',
    listGlobal: async () => [...connectors],
    listForProfile: async () => [...connectors],
  }
}

function fakeConnector(id: string, source: 'composio' | 'builtin' | 'mcp'): Connector {
  return {
    id,
    canonicalId: makeCanonicalConnectorId(source, id),
    logicalKey: id,
    name: id,
    description: '',
    source,
    category: 'other',
    auth: source === 'builtin' ? { mode: 'none' } : { mode: 'oauth', provider: id, hasPreset: false },
    status: 'ready',
    toolNames: null,
    iconUrl: null,
  }
}

describe('DELETE /api/v1/connectors/:id/connect', () => {
  it('composio happy path: vendor DELETE fires, row → expired, status event emitted', async () => {
    const registry = new ConnectorRegistry(new ProfileRegistry())
    registry.addSource(composioProviderWith([fakeConnector('gmail', 'composio')]))
    // Seed an active ready connection.
    connections.upsertPending({
      connectionId: 'conn-1',
      connectorId: 'gmail',
      source: 'composio',
      entityId: 'cortex-default-user',
    })
    connections.markReady({ connectionId: 'conn-1' })

    const vendorDelete = vi.fn().mockResolvedValue(undefined)
    const statusBus = createConnectorStatusBus()
    const events: unknown[] = []
    statusBus.subscribe((e) => { events.push(e) })

    const handlers = makeDisconnectHandlers({
      registry,
      connections,
      statusBus,
      entityId: 'cortex-default-user',
      composio: {
        client: { deleteConnectedAccount: vendorDelete } as never,
      },
    })

    const { res, captured } = mockRes()
    await handlers.disconnect(mockReq(), res, { id: 'gmail' })

    expect(captured.status).toBe(204)
    expect(vendorDelete).toHaveBeenCalledWith('conn-1')
    expect(cancelCompletion).toHaveBeenCalledWith('conn-1')

    const after = connections.findByConnectionId('conn-1')
    expect(after?.status).toBe('expired')
    expect(after?.errorReason).toBe('Revoked by user')
    expect(after?.terminalCause).toBe('revoked')

    expect(events).toHaveLength(1)
    const ev = events[0] as { connectorId: string; status: string }
    expect(ev.connectorId).toBe('gmail')
    expect(ev.status).toBe('needs_setup')
  })

  it('composio with no active connection: 204 (idempotent, nothing to do)', async () => {
    const registry = new ConnectorRegistry(new ProfileRegistry())
    registry.addSource(composioProviderWith([fakeConnector('slack', 'composio')]))

    const vendorDelete = vi.fn()
    const handlers = makeDisconnectHandlers({
      registry,
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
      composio: { client: { deleteConnectedAccount: vendorDelete } as never },
    })

    const { res, captured } = mockRes()
    await handlers.disconnect(mockReq(), res, { id: 'slack' })
    expect(captured.status).toBe(204)
    expect(vendorDelete).not.toHaveBeenCalled()
  })

  it('vendor failure: partial success — local row flips to expired, response carries vendorError', async () => {
    // Previous behaviour was "502 and keep local ready so user sees
    // honest state." That stranded users whose Composio DELETE
    // always fails (a real symptom observed on 2026-04-22). New
    // contract: local always revokes (user's click is honoured);
    // response reports partial + vendorError so the client can
    // tell the user to verify at the Composio dashboard.
    const registry = new ConnectorRegistry(new ProfileRegistry())
    registry.addSource(composioProviderWith([fakeConnector('notion', 'composio')]))
    connections.upsertPending({
      connectionId: 'conn-2',
      connectorId: 'notion',
      source: 'composio',
      entityId: 'cortex-default-user',
    })
    connections.markReady({ connectionId: 'conn-2' })

    const vendorDelete = vi.fn().mockRejectedValue(new Error('boom'))
    const handlers = makeDisconnectHandlers({
      registry,
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
      composio: { client: { deleteConnectedAccount: vendorDelete } as never },
    })

    const { res, captured } = mockRes()
    await handlers.disconnect(mockReq(), res, { id: 'notion' })
    expect(captured.status).toBe(200)
    expect(captured.body).toMatchObject({
      partial: true,
      vendorError: 'Composio could not confirm revocation.',
    })
    expect(JSON.stringify(captured.body)).not.toContain('boom')

    const after = connections.findByConnectionId('conn-2')
    expect(after?.status).toBe('expired')
    expect(after?.errorReason).toBe('Revoked by user (provider revocation unconfirmed)')
    expect(after?.terminalCause).toBe('revocation_unconfirmed')
  })

  it('pending session cleanup must be verified before local metadata is cleared', async () => {
    const registry = new ConnectorRegistry(new ProfileRegistry())
    registry.addSource(composioProviderWith([fakeConnector('linear', 'composio')]))
    const sessionHandle = 'connection-session.123e4567-e89b-42d3-a456-426614174000'
    connections.upsertPending({
      connectionId: 'conn-pending',
      connectorId: 'linear',
      source: 'composio',
      entityId: 'cortex-default-user',
      metadata: { sessionHandle },
    })
    removeSession.mockRejectedValueOnce(new Error('disk unavailable'))
    const vendorDelete = vi.fn()
    const handlers = makeDisconnectHandlers({
      registry,
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
      composio: { client: { deleteConnectedAccount: vendorDelete } as never },
    })

    const { res, captured } = mockRes()
    await handlers.disconnect(mockReq(), res, { id: 'linear' })

    expect(captured.status).toBe(500)
    expect(cancelCompletion).toHaveBeenCalledWith('conn-pending')
    expect(removeSession).toHaveBeenCalledWith(sessionHandle)
    expect(vendorDelete).not.toHaveBeenCalled()
    expect(connections.findByConnectionId('conn-pending')).toMatchObject({
      status: 'pending',
      metadata: { sessionHandle },
    })
  })

  it('builtin: 400 with honest "can\'t disconnect builtins" message', async () => {
    const registry = new ConnectorRegistry(new ProfileRegistry())
    // Built-in list from the default BuiltinSourceProvider. Pick any id we know exists.
    // The registry's first provider is BuiltinSourceProvider — use its first connector.
    const list = await registry.list()
    const builtin = list.find((c) => c.source === 'builtin')
    expect(builtin).toBeDefined()

    const handlers = makeDisconnectHandlers({
      registry,
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
    })
    const { res, captured } = mockRes()
    await handlers.disconnect(mockReq(), res, { id: builtin!.id })
    expect(captured.status).toBe(400)
  })

  it('unknown connector id: 404', async () => {
    const registry = new ConnectorRegistry(new ProfileRegistry())
    const handlers = makeDisconnectHandlers({
      registry,
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
    })
    const { res, captured } = mockRes()
    await handlers.disconnect(mockReq(), res, { id: 'does-not-exist' })
    expect(captured.status).toBe(404)
  })
})
