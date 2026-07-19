import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CortexDatabase } from '../../../../src/gateway/db/database.js'
import { ConnectorConnectionsStore } from '../../../../src/connector/connections/store.js'
import { ConnectionCompletionManager } from '../../../../src/connector/completion/manager.js'
import { createConnectorStatusBus } from '../../../../src/connector/status-bus.js'
import type { ConnectionCompletionListener } from '../../../../src/connector/completion/types.js'

let tmpDir: string
let db: CortexDatabase
let store: ConnectorConnectionsStore

beforeEach(() => {
  vi.useFakeTimers()
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-mgr-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  store = new ConnectorConnectionsStore(db.rawMainHandle)
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeListener(source: string, handler: ConnectionCompletionListener['checkStatus']): ConnectionCompletionListener {
  return { source, checkStatus: handler }
}

describe('ConnectionCompletionManager', () => {
  it('routes dispatch to the correct listener by source', async () => {
    const bus = createConnectorStatusBus()
    const mgr = new ConnectionCompletionManager(store, bus, {
      pollerConfig: { initialDelayMs: 10, maxDurationMs: 60_000 },
    })
    let composioCalls = 0
    let customCalls = 0
    mgr.registerListener(makeListener('composio', async () => {
      composioCalls++
      return { status: 'ready' }
    }))
    mgr.registerListener(makeListener('mcp', async () => {
      customCalls++
      return { status: 'ready' }
    }))

    store.upsertPending({ connectionId: 'a', connectorId: 'notion', source: 'composio', entityId: 'cortex-default-user' })
    store.upsertPending({ connectionId: 'b', connectorId: 'webhook', source: 'mcp', entityId: 'cortex-default-user' })
    mgr.dispatch('a')
    mgr.dispatch('b')
    await vi.advanceTimersByTimeAsync(20)

    expect(composioCalls).toBe(1)
    expect(customCalls).toBe(1)
  })

  it('dispatch with unknown source throws', () => {
    const bus = createConnectorStatusBus()
    const mgr = new ConnectionCompletionManager(store, bus)
    store.upsertPending({ connectionId: 'a', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    expect(() => mgr.dispatch('a')).toThrow(/no listener registered/)
  })

  it('hasListener reflects registration', () => {
    const bus = createConnectorStatusBus()
    const mgr = new ConnectionCompletionManager(store, bus)
    expect(mgr.hasListener('composio')).toBe(false)
    mgr.registerListener(makeListener('composio', async () => ({ status: 'pending' })))
    expect(mgr.hasListener('composio')).toBe(true)
  })

  it('cancelAll aborts all polls', async () => {
    const bus = createConnectorStatusBus()
    const mgr = new ConnectionCompletionManager(store, bus, {
      pollerConfig: { initialDelayMs: 10_000 },
    })
    mgr.registerListener(makeListener('composio', async () => ({ status: 'pending' })))
    store.upsertPending({ connectionId: 'a', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    store.upsertPending({ connectionId: 'b', connectorId: 'y', source: 'composio', entityId: 'cortex-default-user' })
    mgr.dispatch('a')
    mgr.dispatch('b')
    expect(mgr.poller.activeCount).toBe(2)
    mgr.cancelAll()
    expect(mgr.poller.activeCount).toBe(0)
  })

  it('passes terminal cleanup into the poller', async () => {
    const bus = createConnectorStatusBus()
    const cleaned: string[] = []
    const mgr = new ConnectionCompletionManager(store, bus, {
      pollerConfig: { initialDelayMs: 10, maxDurationMs: 60_000 },
      beforeTerminal: async ({ connectionId }) => { cleaned.push(connectionId) },
    })
    mgr.registerListener(makeListener('composio', async () => ({ status: 'ready' })))
    store.upsertPending({
      connectionId: 'cleanup', connectorId: 'x', source: 'composio',
      entityId: 'cortex-default-user',
    })
    mgr.dispatch('cleanup')
    await vi.advanceTimersByTimeAsync(20)
    expect(cleaned).toEqual(['cleanup'])
  })
})
