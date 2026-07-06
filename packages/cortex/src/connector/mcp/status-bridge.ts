/**
 * Bridge — Loom MCPManager → ConnectorStatusBus.
 *
 * Audit #4 / F4.b. Loom's `MCPManager` owns server lifecycle state;
 * cortex's `ConnectorStatusBus` owns the wire to the client. Before this
 * bridge, transport closures only surfaced on the next tool-call probe
 * — the client's connector card stayed `ready` until the agent tripped
 * over the dead server. With it, every transition the manager makes
 * (connect failure, transport close, reconnect outcome) maps onto the
 * bus so the SSE channel at `/api/v1/connectors/events` delivers a
 * live update.
 *
 * Mapping rules (kept deliberately small — see `connector/status.ts`
 * for the credential-derived status; this bridge only carries the
 * live-runtime overlay):
 *
 *   loom `'error'`        → wire `'error'`. Transport died or the
 *                          initial handshake failed. We don't know
 *                          whether the cause was auth or network —
 *                          keep the opaque `'error'` rather than
 *                          inventing an `'auth_error'` we can't prove.
 *                          That value is reserved for sources that
 *                          KNOW it's auth (Composio's reconciler
 *                          inspecting vendor status).
 *   loom `'connected'`    → wire `'ready'`. We just completed the
 *                          initialize handshake against this process's
 *                          credentials; by definition the connector is
 *                          live and serving.
 *   loom `'connecting'`   → wire `'stale'` when the previous status
 *                          was `'connected'` or `'error'` — i.e. a
 *                          reconnect attempt is in flight after the
 *                          connector was once ready or failed. No emit
 *                          on the initial `'connecting'` (previousStatus
 *                          === null) because the connector was never
 *                          observed as ready/error yet — the bus has
 *                          nothing to overlay onto.
 *                          F4.c-2 upgrade (2026-05-17).
 *   loom `'disconnected'` → no emit. Not produced by current code paths
 *                          (the manager has no caller that lands here);
 *                          included for completeness.
 *
 * Idempotency is delegated to `ConnectorStatusBus.emit` — it no-ops
 * when the computed status equals the cached previous, so repeated
 * `'connected'` events (reconnect-then-tool-list discovery) never spam
 * the client.
 */

import type { MCPManager, MCPServerStateChange } from '@ownware/loom'
import type { ConnectorStatusBus } from '../status-bus.js'

/**
 * Wire a manager to a bus. Returns nothing — the manager holds exactly
 * one state-change listener slot, so calling this also detaches any
 * prior listener. Pass `null` to the manager's
 * `setStateChangeListener` to unwire (the assembler does not, but
 * tests may need to).
 */
export function attachMCPManagerToStatusBus(
  manager: MCPManager,
  bus: ConnectorStatusBus,
): void {
  manager.setStateChangeListener((ev) => emitForStateChange(bus, ev))
}

/**
 * Exposed for tests that want to drive the mapping without going
 * through MCPManager (e.g. to assert one specific transition without
 * spawning a process).
 */
export function emitForStateChange(
  bus: ConnectorStatusBus,
  ev: MCPServerStateChange,
): void {
  if (ev.status === 'error') {
    bus.emit({
      connectorId: ev.serverName,
      source: 'mcp',
      status: 'error',
      reason: ev.error ?? `MCP server transport ${ev.reason ?? 'closed'}`,
    })
  } else if (ev.status === 'connected') {
    bus.emit({
      connectorId: ev.serverName,
      source: 'mcp',
      status: 'ready',
      reason: 'MCP server connected',
    })
  } else if (
    ev.status === 'connecting'
    && (ev.previousStatus === 'connected' || ev.previousStatus === 'error')
  ) {
    // Reconnect attempt in flight after the connector was either
    // ready or had failed. Both transitions are meaningful overlays
    // for the client: "we lost it and are retrying" vs "we failed once
    // and are still retrying." Initial `'connecting'`
    // (previousStatus === null) is the cold-boot handshake — there's
    // no prior status to overlay, so we stay silent.
    bus.emit({
      connectorId: ev.serverName,
      source: 'mcp',
      status: 'stale',
      reason: `MCP server reconnecting (${ev.reason ?? 'auto-reconnect'})`,
    })
  }
  // Other transitions deliberately not emitted — see the module
  // docstring for rationale.
}
