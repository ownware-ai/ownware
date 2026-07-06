/**
 * MCP Manager
 *
 * Manages multiple MCP server connections. Handles parallel startup,
 * tool + resource aggregation, auto-reconnection with exponential backoff,
 * and provides ready-to-use Loom Tool[] via getAdaptedTools().
 *
 * This is the main entry point for consumers. Typical usage:
 *
 *   const manager = new MCPManager()
 *   await manager.addServers(mcpConfigs)
 *   const tools = manager.getAdaptedTools()  // Tool[] ready for Loom session
 *   // ... use tools in session ...
 *   await manager.shutdown()
 */

import type { MCPServerConfig, MCPTool, MCPResource, MCPServer, MCPServerStatus } from './types.js'
import { MCPError } from './types.js'
import { MCPClient } from './client.js'
import { adaptAllMCPTools, createListResourcesTool, createReadResourceTool } from './adapter.js'
import type { Tool } from '../tools/types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RECONNECT_ATTEMPTS = 5
const BASE_RECONNECT_DELAY_MS = 1000

// ---------------------------------------------------------------------------
// Internal server state
// ---------------------------------------------------------------------------

interface ServerState {
  config: MCPServerConfig
  client: MCPClient
  status: MCPServerStatus
  tools: MCPTool[]
  resources: MCPResource[]
  error?: string
  reconnectAttempts: number
  reconnectTimer?: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// State-change listener (subscribed to by cortex)
// ---------------------------------------------------------------------------

/**
 * Event fired whenever a managed server's `status` transitions.
 *
 * Loom owns the state; this is the seam cortex (or any other consumer)
 * uses to mirror the transition into its own wire layer (e.g. the
 * `ConnectorStatusBus` SSE channel). Loom never emits to a network
 * transport directly.
 */
export interface MCPServerStateChange {
  /** The server's `config.name` — same id the manager keys on. */
  readonly serverName: string
  /** Status after the transition. */
  readonly status: MCPServerStatus
  /** Status before the transition (`null` on the very first observation). */
  readonly previousStatus: MCPServerStatus | null
  /**
   * Machine-readable reason. Today: `'connect_failed'`,
   * `'transport_closed'`, `'reconnect_failed'`. Free-form so future
   * transitions can extend without breaking subscribers.
   */
  readonly reason?: string
  /** Free-form message lifted from `state.error` when available. */
  readonly error?: string
}

export type MCPServerStateChangeListener = (event: MCPServerStateChange) => void

// ---------------------------------------------------------------------------
// MCPManager
// ---------------------------------------------------------------------------

export class MCPManager {
  private readonly servers = new Map<string, ServerState>()
  private readonly autoReconnect: boolean
  private stateChangeListener: MCPServerStateChangeListener | null = null

  /**
   * @param autoReconnect - Whether to auto-reconnect crashed servers. Default: true.
   */
  constructor(autoReconnect = true) {
    this.autoReconnect = autoReconnect
  }

  /**
   * Register a listener fired whenever any managed server's `status`
   * transitions (e.g. `connecting` → `connected`, `connected` → `error`).
   *
   * Replaces any previous listener — there is exactly one slot. Cortex
   * wires this at construction time and routes events into its
   * `ConnectorStatusBus`. Pass `null` to remove the listener.
   *
   * The listener is invoked synchronously after the internal state is
   * mutated, so listeners see the post-transition `getServer()` value.
   * Listener exceptions are caught and swallowed — a misbehaving consumer
   * must not break MCP lifecycle bookkeeping.
   */
  setStateChangeListener(listener: MCPServerStateChangeListener | null): void {
    this.stateChangeListener = listener
  }

  /**
   * Mutate `state.status` and notify the listener iff the value actually
   * changed. Centralized so every callsite (initial connect, reconnect,
   * transport close) is guaranteed to fire the same event shape.
   */
  private setStatus(
    state: ServerState,
    next: MCPServerStatus,
    reason?: string,
  ): void {
    const prev = state.status
    if (prev === next) return
    state.status = next
    const ev: MCPServerStateChange = {
      serverName: state.config.name,
      status: next,
      previousStatus: prev,
      ...(reason !== undefined ? { reason } : {}),
      ...(state.error !== undefined ? { error: state.error } : {}),
    }
    try {
      this.stateChangeListener?.(ev)
    } catch {
      // Listener errors must not corrupt manager state.
    }
  }

  /**
   * Add and connect to an MCP server.
   */
  async addServer(config: MCPServerConfig): Promise<void> {
    if (this.servers.has(config.name)) {
      throw new MCPError(`Server already exists: ${config.name}`, config.name)
    }

    const client = new MCPClient(config)
    const state: ServerState = {
      config,
      client,
      status: 'connecting',
      tools: [],
      resources: [],
      reconnectAttempts: 0,
    }

    this.servers.set(config.name, state)

    // Wire the unexpected-close hook BEFORE connect() — the transport's
    // onClose can fire before the handshake completes (e.g. a stdio
    // server that crashes mid-init). The client itself suppresses the
    // event when the close happened before `connected`, so the listener
    // only sees post-handshake transport deaths.
    client.setUnexpectedCloseListener((reason) =>
      this.handleUnexpectedClose(config.name, reason),
    )

    try {
      await client.connect()

      // Discover tools
      state.tools = await client.listTools()

      // Discover resources (if supported)
      const caps = client.getCapabilities()
      if (caps?.resources) {
        try {
          state.resources = await client.listResources()
        } catch {
          // Server advertised resources but failed to list — non-fatal
          state.resources = []
        }
      }

      state.reconnectAttempts = 0
      this.setStatus(state, 'connected')
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err)
      this.setStatus(state, 'error', 'connect_failed')
      if (this.autoReconnect) {
        this.scheduleReconnect(config.name)
      }
    }
  }

  /**
   * Invoked by `MCPClient` when its transport closes outside an
   * orderly `disconnect()`. Mirrors the transport death into the
   * manager's state map and fires the state-change listener — closing
   * the audit-4 gap where transport crashes never reached cortex's
   * connector status bus.
   *
   * `autoReconnect` is honored: if enabled, the existing exponential-
   * backoff reconnect path kicks in, and a successful reconnect later
   * emits its own `error → connected` transition through `setStatus`.
   */
  private handleUnexpectedClose(name: string, reason: string): void {
    const state = this.servers.get(name)
    if (state === undefined) return
    // Already torn down by `removeServer` — nothing to mirror.
    if (state.reconnectTimer === undefined && state.status === 'error') {
      // Status already error and no reconnect pending: belt-and-braces
      // re-emit suppression via setStatus's prev===next check.
    }
    state.error = `Transport closed unexpectedly (${reason})`
    this.setStatus(state, 'error', reason)
    if (this.autoReconnect) {
      this.scheduleReconnect(name)
    }
  }

  /**
   * Add multiple servers in parallel.
   */
  async addServers(configs: readonly MCPServerConfig[]): Promise<void> {
    await Promise.allSettled(configs.map(c => this.addServer(c)))
  }

  /**
   * Remove and disconnect a server.
   */
  async removeServer(name: string): Promise<void> {
    const state = this.servers.get(name)
    if (!state) return

    if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    await state.client.disconnect()
    this.servers.delete(name)
  }

  /**
   * Get raw MCP tools from all connected servers.
   */
  getTools(): MCPTool[] {
    const tools: MCPTool[] = []
    for (const state of this.servers.values()) {
      if (state.status === 'connected') {
        tools.push(...state.tools)
      }
    }
    return tools
  }

  /**
   * Get resources from all connected servers.
   */
  getResources(): MCPResource[] {
    const resources: MCPResource[] = []
    for (const state of this.servers.values()) {
      if (state.status === 'connected') {
        resources.push(...state.resources)
      }
    }
    return resources
  }

  /**
   * Get all tools adapted to the Loom Tool interface, ready for a session.
   *
   * This is the primary method consumers should use. Returns:
   * - All MCP tools (prefixed with mcp__serverName__toolName)
   * - Resource tools (list_resources + read_resource) for servers that support them
   *
   * Tool annotations are respected:
   * - readOnlyHint → isReadOnly (allows parallel execution)
   * - destructiveHint → requiresPermission
   */
  getAdaptedTools(): Tool[] {
    const tools: Tool[] = []

    for (const state of this.servers.values()) {
      if (state.status !== 'connected') continue

      // Adapt MCP tools to Loom Tool interface
      const adapted = adaptAllMCPTools(state.tools, state.client)
      tools.push(...adapted)

      // Add resource tools if the server has resources
      const caps = state.client.getCapabilities()
      if (caps?.resources) {
        tools.push(createListResourcesTool(state.config.name, state.client))
        tools.push(createReadResourceTool(state.config.name, state.client))
      }
    }

    return tools
  }

  /**
   * Get a specific server's status.
   */
  getServer(name: string): MCPServer | undefined {
    const state = this.servers.get(name)
    if (!state) return undefined

    return {
      config: state.config,
      status: state.status,
      tools: state.tools,
      resources: state.resources,
      error: state.error,
      capabilities: state.client.getCapabilities() ?? undefined,
    }
  }

  /**
   * List all servers with their status.
   */
  listServers(): MCPServer[] {
    return Array.from(this.servers.values()).map(state => ({
      config: state.config,
      status: state.status,
      tools: state.tools,
      resources: state.resources,
      error: state.error,
      capabilities: state.client.getCapabilities() ?? undefined,
    }))
  }

  /**
   * Get the client for a specific server (for direct tool calls).
   */
  getClient(name: string): MCPClient | undefined {
    return this.servers.get(name)?.client
  }

  /**
   * Disconnect all servers and clean up.
   */
  async shutdown(): Promise<void> {
    const names = [...this.servers.keys()]
    await Promise.allSettled(names.map(name => this.removeServer(name)))
  }

  /** Number of managed servers */
  get size(): number {
    return this.servers.size
  }

  /** Number of connected servers */
  get connectedCount(): number {
    let count = 0
    for (const state of this.servers.values()) {
      if (state.status === 'connected') count++
    }
    return count
  }

  // -----------------------------------------------------------------------
  // Auto-reconnect
  // -----------------------------------------------------------------------

  private scheduleReconnect(name: string): void {
    const state = this.servers.get(name)
    if (!state) return
    if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return

    state.reconnectAttempts++
    const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2, state.reconnectAttempts - 1)

    state.reconnectTimer = setTimeout(async () => {
      // Audit Hazard 16 fix (2026-04-11): if removeServer ran between
      // the schedule and this firing (race window between clearTimeout
      // and the macrotask tick), the captured `state` is now stale —
      // the server is gone from the map. Bail out instead of mutating
      // a defunct state object and accidentally rescheduling another
      // reconnect for a removed server.
      if (this.servers.get(name) !== state) return

      state.error = undefined
      state.reconnectTimer = undefined
      this.setStatus(state, 'connecting')

      try {
        await state.client.disconnect()
        const newClient = new MCPClient(state.config)
        state.client = newClient
        // Re-wire the unexpected-close listener — the previous client's
        // listener died with it. Without this, a second crash on the
        // same server would not reach the state bus.
        newClient.setUnexpectedCloseListener((reason) =>
          this.handleUnexpectedClose(name, reason),
        )
        await newClient.connect()
        state.tools = await newClient.listTools()

        // Re-discover resources
        const caps = newClient.getCapabilities()
        if (caps?.resources) {
          try {
            state.resources = await newClient.listResources()
          } catch {
            state.resources = []
          }
        }

        state.reconnectAttempts = 0
        this.setStatus(state, 'connected')
      } catch (err) {
        state.error = err instanceof Error ? err.message : String(err)
        this.setStatus(state, 'error', 'reconnect_failed')
        if (this.autoReconnect) {
          this.scheduleReconnect(name)
        }
      }
    }, delay)
  }
}
