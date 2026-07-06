/**
 * MCP Client
 *
 * Connects to MCP servers via any transport (stdio, SSE, HTTP, WebSocket).
 * Handles JSON-RPC 2.0 protocol, discovers tools + resources, and invokes
 * them. Transport-agnostic — delegates raw I/O to MCPTransportLayer.
 */

import type {
  MCPServerConfig,
  MCPTool,
  MCPResource,
  MCPResourceContent,
  MCPServerCapabilities,
  MCPTransportLayer,
  MCPToolAnnotations,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types.js'
import { MCPError } from './types.js'
import { createTransport } from './transports.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Generous on purpose: stdio servers launched via package runners
// (npx/uvx/bunx) DOWNLOAD the package on first use — on a cold cache or
// slow network that alone can exceed 30s, and failing initialize there
// reads as "MCP is broken" to a first-run user. A dead server still
// fails, just later; connect() is async and blocks nothing else.
const INIT_TIMEOUT_MS = 120_000
const CALL_TIMEOUT_MS = 120_000

// ---------------------------------------------------------------------------
// MCPClient
// ---------------------------------------------------------------------------

/**
 * Callback fired when the transport closes unexpectedly (process crash,
 * stream EOF, network drop). NOT fired by the intentional `disconnect()`
 * path — that's the caller's own teardown and doesn't need a signal.
 *
 * The reason string is best-effort context ("transport_closed") that the
 * caller (typically MCPManager) can pass on to higher layers.
 */
export type UnexpectedCloseListener = (reason: string) => void

export class MCPClient {
  private transport: (MCPTransportLayer & { start(): Promise<void> }) | null = null
  private requestId = 0
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private capabilities: MCPServerCapabilities | null = null
  private connected = false
  /** True while a caller-initiated disconnect is in flight. Suppresses the
   *  unexpected-close listener so an orderly shutdown doesn't masquerade as
   *  a transport crash. */
  private disconnecting = false
  private unexpectedCloseListener: UnexpectedCloseListener | null = null

  constructor(private readonly config: MCPServerConfig) {}

  /**
   * Register a listener fired when the transport closes outside of a
   * caller-initiated `disconnect()`. Used by MCPManager to mirror
   * transport death into the server-state map (and onward to consumers
   * via its own state-change listener). Replaces any previous listener.
   */
  setUnexpectedCloseListener(listener: UnexpectedCloseListener | null): void {
    this.unexpectedCloseListener = listener
  }

  /** Whether the client is currently connected */
  get isConnected(): boolean {
    return this.connected
  }

  /** The server name */
  get serverName(): string {
    return this.config.name
  }

  /** Server capabilities from initialization */
  getCapabilities(): MCPServerCapabilities | null {
    return this.capabilities
  }

  /**
   * Connect to the MCP server.
   * Creates the transport, starts it, and performs the initialization handshake.
   */
  async connect(): Promise<void> {
    if (this.connected) return

    this.transport = createTransport(this.config)

    // Set up message/error/close handlers
    this.transport.onMessage((msg) => this.handleMessage(msg))
    this.transport.onError((err) => {
      this.rejectAllPending(new MCPError(`Transport error: ${err.message}`, this.config.name))
    })
    this.transport.onClose(() => {
      const wasConnected = this.connected
      const wasIntentional = this.disconnecting
      this.handleDisconnect()
      // Mirror transport death to the registered listener so MCPManager
      // can flip its server-state to `error`. Skipped on caller-initiated
      // disconnects (the manager doesn't need a "you just asked me to
      // close" event) and on closes that fire before the initial
      // handshake completed (those surface as a connect() throw instead).
      if (!wasIntentional && wasConnected) {
        try {
          this.unexpectedCloseListener?.('transport_closed')
        } catch {
          // Listener errors must not propagate into transport teardown.
        }
      }
    })

    // Start transport (spawns process, opens connection, etc.)
    await this.transport.start()

    // Perform initialization handshake
    try {
      const result = await this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'loom', version: '0.1.0' },
      }, INIT_TIMEOUT_MS) as Record<string, unknown>

      this.capabilities = {
        tools: !!(result.capabilities as Record<string, unknown>)?.tools,
        resources: !!(result.capabilities as Record<string, unknown>)?.resources,
        prompts: !!(result.capabilities as Record<string, unknown>)?.prompts,
      }

      // Send initialized notification (no response expected)
      this.sendNotification('notifications/initialized', {})
      this.connected = true
    } catch (err) {
      await this.disconnect()
      throw new MCPError(
        `Initialization failed: ${err instanceof Error ? err.message : String(err)}`,
        this.config.name,
      )
    }
  }

  /**
   * Discover tools from the connected server.
   * Parses tool annotations (readOnlyHint, destructiveHint, etc.) if present.
   */
  async listTools(): Promise<MCPTool[]> {
    this.assertConnected()

    const result = await this.sendRequest('tools/list', {}) as { tools?: unknown[] }
    if (!result.tools || !Array.isArray(result.tools)) return []

    return result.tools.map((t: unknown): MCPTool => {
      const tool = t as Record<string, unknown>
      const annotations = tool.annotations as Record<string, unknown> | undefined

      return {
        name: String(tool.name ?? ''),
        description: String(tool.description ?? ''),
        inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        serverName: this.config.name,
        annotations: annotations ? parseAnnotations(annotations) : undefined,
      }
    })
  }

  /**
   * Discover resources from the connected server.
   */
  async listResources(): Promise<MCPResource[]> {
    this.assertConnected()

    const result = await this.sendRequest('resources/list', {}) as { resources?: unknown[] }
    if (!result.resources || !Array.isArray(result.resources)) return []

    return result.resources.map((r: unknown): MCPResource => {
      const res = r as Record<string, unknown>
      return {
        uri: String(res.uri ?? ''),
        name: String(res.name ?? ''),
        description: res.description ? String(res.description) : undefined,
        mimeType: res.mimeType ? String(res.mimeType) : undefined,
        serverName: this.config.name,
      }
    })
  }

  /**
   * Read a resource by URI.
   */
  async readResource(uri: string): Promise<MCPResourceContent[]> {
    this.assertConnected()

    const result = await this.sendRequest('resources/read', { uri }) as {
      contents?: unknown[]
    }

    if (!result.contents || !Array.isArray(result.contents)) return []

    return result.contents.map((c: unknown): MCPResourceContent => {
      const content = c as Record<string, unknown>
      return {
        uri: String(content.uri ?? uri),
        mimeType: content.mimeType ? String(content.mimeType) : undefined,
        text: content.text != null ? String(content.text) : undefined,
        blob: content.blob != null ? String(content.blob) : undefined,
      }
    })
  }

  /**
   * Call a tool on the server.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    this.assertConnected()

    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    }) as { content?: unknown[]; isError?: boolean }

    if (result.isError) {
      const text = extractTextContent(result.content)
      throw new MCPError(`Tool error: ${text}`, this.config.name)
    }

    return extractTextContent(result.content)
  }

  /**
   * Disconnect from the server. Closes the transport and cleans up.
   *
   * Marks `disconnecting` so the transport's `onClose` callback (which
   * fires inside `transport.close()` for stdio + WebSocket) does NOT
   * dispatch the unexpected-close listener — this is an orderly
   * shutdown, not a crash.
   */
  async disconnect(): Promise<void> {
    this.disconnecting = true
    this.rejectAllPending(new MCPError('Client disconnected', this.config.name))
    this.connected = false

    try {
      if (this.transport) {
        await this.transport.close()
        this.transport = null
      }
    } finally {
      this.disconnecting = false
    }
  }

  // -----------------------------------------------------------------------
  // JSON-RPC transport
  // -----------------------------------------------------------------------

  private sendRequest(method: string, params: Record<string, unknown>, timeout = CALL_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.transport?.isOpen) {
        reject(new MCPError('Transport not open', this.config.name))
        return
      }

      const id = ++this.requestId

      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new MCPError(`Request timed out: ${method}`, this.config.name))
      }, timeout)

      this.pending.set(id, { resolve, reject, timer })

      const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
      try {
        this.transport.send(JSON.stringify(request))
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.transport?.isOpen) return
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params })
    try {
      this.transport.send(msg)
    } catch {
      // Notifications are fire-and-forget
    }
  }

  private handleMessage(rawMessage: string): void {
    let msg: JsonRpcResponse
    try {
      msg = JSON.parse(rawMessage)
    } catch {
      return // Ignore non-JSON messages
    }

    if (msg == null || typeof msg !== 'object') return // Ignore null/primitive JSON values
    if (msg.id === undefined || msg.id === null) return // Notification, ignore

    const pending = this.pending.get(msg.id)
    if (!pending) return

    this.pending.delete(msg.id)
    clearTimeout(pending.timer)

    if (msg.error) {
      pending.reject(new MCPError(
        `RPC error: ${msg.error.message}`,
        this.config.name,
        msg.error.code,
      ))
    } else {
      pending.resolve(msg.result)
    }
  }

  private handleDisconnect(): void {
    this.connected = false
    this.rejectAllPending(new MCPError('Server disconnected', this.config.name))
  }

  private rejectAllPending(error: Error): void {
    // Audit Hazard 12 fix (2026-04-11): the previous loop mutated the
    // map (`this.pending.delete`) while iterating with `for…of`.
    // Snapshot first, clear the live map, THEN reject — that way a
    // racing `sendRequest` that lands a new entry mid-rejection won't
    // be silently dropped or double-resolved.
    const snapshot = [...this.pending.values()]
    this.pending.clear()
    for (const p of snapshot) {
      clearTimeout(p.timer)
      p.reject(error)
    }
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new MCPError('Not connected', this.config.name)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract text from MCP content blocks */
function extractTextContent(content?: unknown[]): string {
  if (!content || !Array.isArray(content)) return ''
  return content
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .filter(c => c.type === 'text')
    .map(c => String(c.text ?? ''))
    .join('\n')
}

/** Parse MCP tool annotations from raw object */
function parseAnnotations(raw: Record<string, unknown>): MCPToolAnnotations {
  return {
    readOnlyHint: typeof raw.readOnlyHint === 'boolean' ? raw.readOnlyHint : undefined,
    destructiveHint: typeof raw.destructiveHint === 'boolean' ? raw.destructiveHint : undefined,
    openWorldHint: typeof raw.openWorldHint === 'boolean' ? raw.openWorldHint : undefined,
    title: typeof raw.title === 'string' ? raw.title : undefined,
  }
}
