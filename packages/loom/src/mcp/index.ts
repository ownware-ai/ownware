/**
 * MCP Module
 *
 * Model Context Protocol integration — connect to MCP servers,
 * discover tools + resources, and adapt them to the Loom Tool interface.
 *
 * Supports: stdio, SSE, HTTP (StreamableHTTP), WebSocket transports.
 */

// Types
export type {
  MCPServerConfig,
  MCPStdioServerConfig,
  MCPSSEServerConfig,
  MCPHTTPServerConfig,
  MCPWebSocketServerConfig,
  MCPTransport,
  MCPServerStatus,
  MCPServer,
  MCPTool,
  MCPToolAnnotations,
  MCPResource,
  MCPResourceContent,
  MCPServerCapabilities,
  MCPTransportLayer,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcError,
} from './types.js'
export { MCPError } from './types.js'

// Client
export { MCPClient } from './client.js'

// Manager
export { MCPManager } from './manager.js'
export type {
  MCPServerStateChange,
  MCPServerStateChangeListener,
} from './manager.js'

// Adapter
export {
  adaptMCPTool,
  adaptAllMCPTools,
  createListResourcesTool,
  createReadResourceTool,
} from './adapter.js'

// Transports
export {
  StdioTransport,
  SSETransport,
  HTTPTransport,
  WebSocketTransport,
  createTransport,
} from './transports.js'

// Auth (generic OAuth2 PKCE primitives — provider presets live in consumers)
export {
  startOAuthFlow,
  refreshTokens,
  findAvailablePort,
  buildRedirectUri,
  startCallbackServer,
  OAuthFlowError,
  // Dynamic OAuth (MCP 2025-03-26): discovery + RFC 7591 registration.
  discoverOAuthEndpoints,
  parseResourceMetadataUrl,
  probeForWWWAuthenticate,
  OAuthDiscoveryError,
  registerOAuthClient,
  DynamicClientRegistrationError,
} from './auth/index.js'
export type {
  OAuthFlowConfig,
  OAuthTokens,
  OAuthPreset,
  MCPServerAuthType,
  PendingOAuthFlow,
  OAuthCallbackResult,
  OAuthCallbackError,
  DiscoveredOAuthEndpoints,
  OAuthDiscoveryOptions,
  DynamicClientRegistrationRequest,
  IssuedClientCredentials,
  DynamicClientRegistrationOptions,
} from './auth/index.js'
