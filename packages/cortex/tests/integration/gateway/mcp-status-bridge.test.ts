/**
 * Integration test — F4.b / audit #4.
 *
 * Verifies that when a live MCP server's stdio process dies, the
 * ConnectorStatusBus receives a `connector.status_changed` event with
 * `source: 'mcp'` and `status: 'error'` — closing the gap where the
 * gateway snapshot stayed `ready` until the next tool call probed the
 * dead server.
 *
 * Strategy:
 *   1. Spawn the loom echo MCP server as a real subprocess.
 *   2. Wire it into a real `MCPManager` connected to a real
 *      `ConnectorStatusBus` via `attachMCPManagerToStatusBus`.
 *   3. Subscribe to the bus.
 *   4. Confirm the initial `ready` event arrives after `addServer`.
 *   5. Kill the underlying child process. Assert an `error` event
 *      arrives within a reasonable window.
 *
 * Why this lives in `tests/integration/gateway/`: it exercises the
 * cortex → loom seam end-to-end (real process spawn + manager + bus)
 * without booting the full HTTP gateway, which would slow the test
 * to multiple seconds for no extra coverage of the bridge contract.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MCPManager, type MCPStdioServerConfig } from '@ownware/loom'
import {
  createConnectorStatusBus,
  type ConnectorStatusEvent,
} from '../../../src/connector/status-bus.js'
import { attachMCPManagerToStatusBus } from '../../../src/connector/mcp/status-bridge.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_SERVER = resolve(
  __dirname,
  '../../../../loom/src/__tests__/e2e/mcp-echo-server.ts',
)

function echoConfig(name = 'echo-bridge'): MCPStdioServerConfig {
  return {
    name,
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', ECHO_SERVER],
  }
}

/** Promise that resolves on the first event matching the predicate, or
 *  rejects after `timeoutMs`. Keeps the test deterministic without
 *  polling. */
function waitForEvent(
  bus: ReturnType<typeof createConnectorStatusBus>,
  predicate: (ev: ConnectorStatusEvent) => boolean,
  timeoutMs: number,
): Promise<ConnectorStatusEvent> {
  return new Promise((resolveFn, rejectFn) => {
    const timer = setTimeout(() => {
      unsubscribe()
      rejectFn(new Error(`waitForEvent: timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const unsubscribe = bus.subscribe((ev) => {
      if (!predicate(ev)) return
      clearTimeout(timer)
      unsubscribe()
      resolveFn(ev)
    })
  })
}

describe('MCP status bridge — live server', () => {
  let manager: MCPManager | null = null

  afterEach(async () => {
    if (manager) {
      // Stop auto-reconnects via shutdown so leftover children don't
      // leak across tests on a CI box. Best-effort: errors here are
      // non-fatal for cleanup.
      try {
        await manager.shutdown()
      } catch {
        /* noop */
      }
      manager = null
    }
  })

  it('emits a "ready" event when an MCP server completes its handshake', async () => {
    manager = new MCPManager(/* autoReconnect */ false)
    const bus = createConnectorStatusBus()
    attachMCPManagerToStatusBus(manager, bus)

    const readyPromise = waitForEvent(
      bus,
      (ev) =>
        ev.connectorId === 'echo-bridge'
        && ev.source === 'mcp'
        && ev.status === 'ready',
      15_000,
    )

    await manager.addServer(echoConfig())

    const ev = await readyPromise
    expect(ev.previousStatus).toBeNull()
    expect(ev.reason).toBe('MCP server connected')
  }, 20_000)

  it(
    'emits an "error" event when the MCP server process is killed',
    async () => {
      manager = new MCPManager(/* autoReconnect */ false)
      const bus = createConnectorStatusBus()
      attachMCPManagerToStatusBus(manager, bus)

      // Connect first — we need the cached "ready" state so the
      // subsequent error transition is observable.
      const readyP = waitForEvent(
        bus,
        (ev) => ev.connectorId === 'echo-bridge' && ev.status === 'ready',
        15_000,
      )
      await manager.addServer(echoConfig())
      await readyP

      // Reach into the live transport and force a process exit. The
      // stdio transport stashes its child on `.process` — see
      // `packages/loom/src/mcp/transports.ts`. The public surface
      // intentionally hides it from consumers; the test reaches in
      // because the only way to deterministically reproduce a transport
      // death is to kill the underlying process.
      const client = manager.getClient('echo-bridge')
      expect(client).toBeDefined()
      const transport = (client as unknown as { transport: unknown })
        .transport as Record<string, any> | null
      expect(transport).toBeTruthy()
      const child = transport!['process']
      expect(child).toBeTruthy()
      expect(typeof child.kill).toBe('function')

      const errorP = waitForEvent(
        bus,
        (ev) => ev.connectorId === 'echo-bridge' && ev.status === 'error',
        10_000,
      )

      child.kill('SIGKILL')

      const errorEv = await errorP
      expect(errorEv.source).toBe('mcp')
      expect(errorEv.previousStatus).toBe('ready')
      // Reason carries the manager's lifted error message + the close
      // reason — make sure it's a non-empty, recognisably-MCP string.
      expect(errorEv.reason).toBeTruthy()
      expect(typeof errorEv.reason).toBe('string')
    },
    25_000,
  )
})
