/**
 * MCP OAuth2 Authentication Module — Loom
 *
 * Generic OAuth2 PKCE primitives. This module knows nothing about
 * specific providers (GitHub, Notion, etc.) — consumers pass the
 * authorization URL, token URL, and client_id via OAuthFlowConfig.
 *
 * Provider-specific presets and validators live in the consumer
 * (e.g. @ownware/cortex's connector/mcp/).
 */

// Types
export type {
  OAuthFlowConfig,
  OAuthTokens,
  OAuthPreset,
  MCPServerAuthType,
  PendingOAuthFlow,
  OAuthCallbackResult,
  OAuthCallbackError,
} from './types.js'

// Flow orchestrator
export { startOAuthFlow, refreshTokens } from './oauth-flow.js'

// Callback server
export {
  findAvailablePort,
  buildRedirectUri,
  startCallbackServer,
  OAuthFlowError,
} from './oauth-callback.js'

// Dynamic OAuth (MCP 2025-03-26 spec): auto-discovery + dynamic client
// registration. Used when no `OAuthPreset` exists for the MCP server,
// e.g. Figma's native MCP. The flow is:
//   1. discoverOAuthEndpoints() — extract endpoints from the server's
//      WWW-Authenticate header → resource metadata → AS metadata.
//   2. registerOAuthClient() — POST to the discovered registration
//      endpoint to get a client_id (no pre-registration required).
//   3. startOAuthFlow() — run the standard PKCE flow with the issued
//      client_id.
export {
  discoverOAuthEndpoints,
  parseResourceMetadataUrl,
  probeForWWWAuthenticate,
  OAuthDiscoveryError,
} from './oauth-discovery.js'
export type {
  DiscoveredOAuthEndpoints,
  OAuthDiscoveryOptions,
} from './oauth-discovery.js'

export {
  registerOAuthClient,
  DynamicClientRegistrationError,
} from './dynamic-client-registration.js'
export type {
  DynamicClientRegistrationRequest,
  IssuedClientCredentials,
  DynamicClientRegistrationOptions,
} from './dynamic-client-registration.js'
