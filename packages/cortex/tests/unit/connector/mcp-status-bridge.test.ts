/**
 * Unit tests for `connector/mcp/status-bridge.ts`.
 *
 * Audit #4 / F4.b — verifies Loom's MCPManager state transitions map
 * onto the ConnectorStatusBus with the expected `source: 'mcp'`
 * payload and the right wire status mapping.
 *
 * Tests use the direct mapping helper (`emitForStateChange`) and the
 * higher-level wiring (`attachMCPManagerToStatusBus`) against a fake
 * manager — no MCP process is spawned here. The bridge logic is small
 * enough to be exhaustively covered without an integration runtime.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  ConnectorStatusBus,
  createConnectorStatusBus,
  type ConnectorStatusEvent,
} from '../../../src/connector/status-bus.js'
import {
  attachMCPManagerToStatusBus,
  emitForStateChange,
} from '../../../src/connector/mcp/status-bridge.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collect(bus: ConnectorStatusBus): ConnectorStatusEvent[] {
  const seen: ConnectorStatusEvent[] = []
  bus.subscribe((e) => seen.push(e))
  return seen
}

/**
 * Minimal MCPManager-shaped fake — `setStateChangeListener` is the
 * only surface the bridge touches.
 */
function fakeManager() {
  let listener: ((ev: any) => void) | null = null
  return {
    setStateChangeListener(fn: ((ev: any) => void) | null) {
      listener = fn
    },
    fire(ev: any) {
      listener?.(ev)
    },
  }
}

// ---------------------------------------------------------------------------
// Direct mapping
// ---------------------------------------------------------------------------

describe('emitForStateChange', () => {
  let bus: ConnectorStatusBus

  beforeEach(() => {
    bus = createConnectorStatusBus()
  })

  it('maps loom "error" → wire "error" with source "mcp"', () => {
    const seen = collect(bus)

    emitForStateChange(bus, {
      serverName: 'gmail',
      status: 'error',
      previousStatus: 'connected',
      reason: 'transport_closed',
      error: 'Transport closed unexpectedly (transport_closed)',
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      type: 'connector.status_changed',
      connectorId: 'gmail',
      source: 'mcp',
      status: 'error',
    })
    expect(seen[0]!.reason).toContain('Transport closed unexpectedly')
  })

  it('maps loom "connected" → wire "ready" with source "mcp"', () => {
    const seen = collect(bus)

    emitForStateChange(bus, {
      serverName: 'gmail',
      status: 'connected',
      previousStatus: 'connecting',
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      connectorId: 'gmail',
      source: 'mcp',
      status: 'ready',
      reason: 'MCP server connected',
    })
  })

  it('F4.c-2: maps loom "connecting" with previousStatus "connected" → wire "stale"', () => {
    // Reconnect in flight after the connector was once ready. Surfacing
    // this as `stale` lets the client render "Reconnecting…" instead of
    // continuing to claim "Connected" while the transport is bouncing.
    const seen = collect(bus)
    emitForStateChange(bus, {
      serverName: 'gmail',
      status: 'connecting',
      previousStatus: 'connected',
      reason: 'reconnect_failed',
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      connectorId: 'gmail',
      source: 'mcp',
      status: 'stale',
    })
    expect(seen[0]!.reason).toContain('reconnecting')
  })

  it('F4.c-2: maps loom "connecting" with previousStatus "error" → wire "stale"', () => {
    // Reconnect attempt after the prior connect failed. Same `stale`
    // overlay applies — user-facing copy is "Reconnecting…", the
    // reconciler is still trying.
    const seen = collect(bus)
    emitForStateChange(bus, {
      serverName: 'gmail',
      status: 'connecting',
      previousStatus: 'error',
      reason: 'reconnect_attempt',
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      connectorId: 'gmail',
      source: 'mcp',
      status: 'stale',
    })
  })

  it('F4.c-2: does NOT emit for initial loom "connecting" (previousStatus === null)', () => {
    // Cold-boot handshake — the bus has no prior status for this
    // connector, so there's nothing to overlay. Stays silent until the
    // handshake terminates (connected → ready, or error → error).
    const seen = collect(bus)
    emitForStateChange(bus, {
      serverName: 'gmail',
      status: 'connecting',
      previousStatus: null,
    })
    expect(seen).toHaveLength(0)
  })

  it('does NOT emit for loom "disconnected" (unused phase)', () => {
    const seen = collect(bus)
    emitForStateChange(bus, {
      serverName: 'gmail',
      status: 'disconnected',
      previousStatus: 'connected',
    })
    expect(seen).toHaveLength(0)
  })

  it('F4.c-2: loom transport-close stays mapped to wire "error" (not auth_error)', () => {
    // The bridge can't tell whether a transport closure was an auth
    // problem or a network blip. Promoting opaque failures to
    // `auth_error` would invite an unhelpful "Reauthorize" CTA for
    // every network bounce. Keep the opaque `error` mapping; the
    // Composio reconciler (which CAN inspect vendor status) is the
    // only path that emits `auth_error`.
    const seen = collect(bus)
    emitForStateChange(bus, {
      serverName: 'gmail',
      status: 'error',
      previousStatus: 'connected',
      reason: 'transport_closed',
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.status).toBe('error')
  })

  it('falls back to a generic reason when the manager event has no error message', () => {
    const seen = collect(bus)
    emitForStateChange(bus, {
      serverName: 'weather',
      status: 'error',
      previousStatus: 'connected',
      reason: 'transport_closed',
    })
    expect(seen[0]!.reason).toBe('MCP server transport transport_closed')
  })

  it('relies on bus idempotency to drop duplicate transitions', () => {
    const seen = collect(bus)
    const ev = {
      serverName: 'gmail',
      status: 'error' as const,
      previousStatus: 'connected' as const,
      error: 'transport died',
    }
    emitForStateChange(bus, ev)
    emitForStateChange(bus, ev)
    // Bus emit is a no-op the second time (status unchanged in cache).
    expect(seen).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Manager attachment
// ---------------------------------------------------------------------------

describe('attachMCPManagerToStatusBus', () => {
  it('wires the manager so transport-close fires a "connector.status_changed" with status=error', () => {
    const bus = createConnectorStatusBus()
    const mgr = fakeManager()
    attachMCPManagerToStatusBus(mgr as any, bus)

    const seen = collect(bus)

    // Simulate the manager's `addServer` → 'connected' path first so
    // the bus cache has a non-null previousStatus when we kill the
    // server.
    mgr.fire({
      serverName: 'notion',
      status: 'connected',
      previousStatus: 'connecting',
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.status).toBe('ready')

    // Now fire the transport-close transition.
    mgr.fire({
      serverName: 'notion',
      status: 'error',
      previousStatus: 'connected',
      reason: 'transport_closed',
      error: 'Transport closed unexpectedly (transport_closed)',
    })

    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({
      connectorId: 'notion',
      source: 'mcp',
      status: 'error',
      previousStatus: 'ready',
    })
  })
})
