/**
 * MCP (Model Context Protocol) Types
 *
 * Defines the types for MCP server configuration, tool discovery,
 * resource access, and server lifecycle management.
 *
 * Supports all transport types: stdio, SSE, HTTP (StreamableHTTP),
 * and WebSocket.
 */

// ---------------------------------------------------------------------------
// Transport types
// ---------------------------------------------------------------------------

export type MCPTransport = 'stdio' | 'sse' | 'http' | 'websocket'

// ---------------------------------------------------------------------------
// Server configuration — discriminated by transport
// ---------------------------------------------------------------------------

/** Base fields shared by all MCP server configs */
interface MCPServerConfigBase {
  /** Unique server name (used as prefix for tool names) */
  readonly name: string
  /** Transport protocol */
  readonly transport: MCPTransport
  /** Environment variables to pass to the server process */
  readonly env?: Readonly<Record<string, string>>
}

/** stdio transport — spawns a child process */
export interface MCPStdioServerConfig extends MCPServerConfigBase {
  readonly transport: 'stdio'
  /** Command to start the server process */
  readonly command: string
  /** Command arguments */
  readonly args?: readonly string[]
}

/** SSE transport — connects to an HTTP SSE endpoint */
export interface MCPSSEServerConfig extends MCPServerConfigBase {
  readonly transport: 'sse'
  /** Server URL (SSE endpoint) */
  readonly url: string
  /** HTTP headers for the connection */
  readonly headers?: Readonly<Record<string, string>>
}

/** HTTP transport — StreamableHTTP (request/response per call) */
export interface MCPHTTPServerConfig extends MCPServerConfigBase {
  readonly transport: 'http'
  /** Server URL */
  readonly url: string
  /** HTTP headers for requests */
  readonly headers?: Readonly<Record<string, string>>
}

/** WebSocket transport — bidirectional */
export interface MCPWebSocketServerConfig extends MCPServerConfigBase {
  readonly transport: 'websocket'
  /** WebSocket URL (ws:// or wss://) */
  readonly url: string
  /** HTTP headers for the upgrade request */
  readonly headers?: Readonly<Record<string, string>>
}

/** Union of all MCP server configs */
export type MCPServerConfig =
  | MCPStdioServerConfig
  | MCPSSEServerConfig
  | MCPHTTPServerConfig
  | MCPWebSocketServerConfig

// ---------------------------------------------------------------------------
// Server status
// ---------------------------------------------------------------------------

export type MCPServerStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

/** Runtime state of an MCP server */
export interface MCPServer {
  /** Server configuration */
  readonly config: MCPServerConfig
  /** Current connection status */
  readonly status: MCPServerStatus
  /** Discovered tools */
  readonly tools: readonly MCPTool[]
  /** Discovered resources */
  readonly resources: readonly MCPResource[]
  /** Error message if status is 'error' */
  readonly error?: string
  /** Server capabilities from initialization */
  readonly capabilities?: MCPServerCapabilities
}

// ---------------------------------------------------------------------------
// Tool annotations (from MCP spec)
// ---------------------------------------------------------------------------

/**
 * Hints about tool behavior provided by the MCP server.
 * These allow the engine to optimize execution (e.g., parallel reads)
 * and warn about destructive operations.
 */
export interface MCPToolAnnotations {
  /** Tool only reads data, doesn't mutate (safe for parallel execution) */
  readonly readOnlyHint?: boolean
  /** Tool performs destructive/irreversible actions */
  readonly destructiveHint?: boolean
  /** Tool interacts with external systems (network, APIs) */
  readonly openWorldHint?: boolean
  /** Human-readable title for the tool */
  readonly title?: string
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** A tool discovered from an MCP server */
export interface MCPTool {
  /** Tool name (as reported by the server) */
  readonly name: string
  /** Human-readable description */
  readonly description: string
  /** JSON Schema for the tool's input */
  readonly inputSchema: Record<string, unknown>
  /** Which server this tool belongs to */
  readonly serverName: string
  /** Server-provided annotations (hints about behavior) */
  readonly annotations?: MCPToolAnnotations
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/** A resource exposed by an MCP server */
export interface MCPResource {
  /** Resource URI */
  readonly uri: string
  /** Display name */
  readonly name: string
  /** Description of the resource */
  readonly description?: string
  /** MIME type */
  readonly mimeType?: string
  /** Which server this resource belongs to */
  readonly serverName?: string
}

/** Content returned from reading a resource */
export interface MCPResourceContent {
  /** Resource URI */
  readonly uri: string
  /** MIME type */
  readonly mimeType?: string
  /** Text content (for text resources) */
  readonly text?: string
  /** Base64-encoded binary content (for binary resources) */
  readonly blob?: string
}

// ---------------------------------------------------------------------------
// Protocol messages (JSON-RPC 2.0)
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 request */
export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly method: string
  readonly params?: Record<string, unknown>
}

/** JSON-RPC 2.0 response */
export interface JsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly result?: unknown
  readonly error?: JsonRpcError
}

/** JSON-RPC 2.0 notification (no id) */
export interface JsonRpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: Record<string, unknown>
}

/** JSON-RPC 2.0 error */
export interface JsonRpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

// ---------------------------------------------------------------------------
// Server capabilities
// ---------------------------------------------------------------------------

export interface MCPServerCapabilities {
  readonly tools?: boolean
  readonly resources?: boolean
  readonly prompts?: boolean
}

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

/**
 * Transport layer for MCP communication.
 * Each transport (stdio, SSE, HTTP, WebSocket) implements this interface.
 */
export interface MCPTransportLayer {
  /** Send a JSON-RPC message to the server */
  send(message: string): void
  /** Register handler for incoming messages */
  onMessage(handler: (message: string) => void): void
  /** Register handler for transport errors */
  onError(handler: (error: Error) => void): void
  /** Register handler for transport close */
  onClose(handler: () => void): void
  /** Close the transport */
  close(): Promise<void>
  /** Whether the transport is currently open */
  readonly isOpen: boolean
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MCPError extends Error {
  constructor(
    message: string,
    public readonly serverName: string,
    public readonly code?: number,
  ) {
    super(message)
    this.name = 'MCPError'
  }
}
