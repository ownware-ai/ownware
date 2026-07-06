/**
 * MCP OAuth2 Types
 *
 * Types for OAuth2 PKCE authentication flow used by MCP servers
 * that require browser-based login (GitHub, Slack, Notion, etc.)
 */

// ---------------------------------------------------------------------------
// OAuth flow configuration
// ---------------------------------------------------------------------------

/** Configuration for an OAuth2 PKCE flow */
export interface OAuthFlowConfig {
  /** MCP server identifier (e.g., 'github', 'slack') */
  readonly serverId: string
  /** OAuth2 client ID (from registered OAuth app) */
  readonly clientId: string
  /** Scopes to request */
  readonly scopes: readonly string[]
  /** Authorization endpoint URL */
  readonly authorizationUrl: string
  /** Token exchange endpoint URL */
  readonly tokenUrl: string
  /** Optional client secret (for confidential clients) */
  readonly clientSecret?: string
  /** Port for localhost callback server (0 = auto-assign) */
  readonly callbackPort?: number
}

// ---------------------------------------------------------------------------
// OAuth tokens
// ---------------------------------------------------------------------------

/** Tokens returned from a successful OAuth2 flow */
export interface OAuthTokens {
  /** The access token for API requests */
  readonly accessToken: string
  /** Refresh token for obtaining new access tokens */
  readonly refreshToken?: string
  /** Absolute timestamp (ms since epoch) when access_token expires */
  readonly expiresAt: number
  /** Granted scopes (space-separated) */
  readonly scope?: string
  /** Token type (almost always 'Bearer') */
  readonly tokenType: string
}

// ---------------------------------------------------------------------------
// OAuth presets (pre-configured providers)
// ---------------------------------------------------------------------------

/** Pre-configured OAuth settings for a known service */
export interface OAuthPreset {
  /** Server identifier matching featured server ID */
  readonly serverId: string
  /** Display name */
  readonly name: string
  /** OAuth2 client ID (registered with the service) */
  readonly clientId: string
  /** Authorization endpoint */
  readonly authorizationUrl: string
  /** Token endpoint */
  readonly tokenUrl: string
  /** Default scopes */
  readonly scopes: readonly string[]
  /**
   * Single env var name to receive the raw access token. The default
   * mapping path. Adequate for providers whose MCP server reads a
   * bare token (GitHub, GitLab, Slack).
   */
  readonly tokenToEnv: string
  /**
   * 2026-04-11 Hazard 22 fix.
   *
   * Optional per-provider transform that converts the OAuth tokens
   * into the actual env var bag the MCP server expects. Used when the
   * server doesn't read a bare token. Notion is the canonical example:
   * its MCP server requires `OPENAPI_MCP_HEADERS` to be a JSON-encoded
   * headers object, not a raw token. Without a transform the OAuth
   * flow stored the bare access token in OPENAPI_MCP_HEADERS and the
   * server crashed on parse.
   *
   * If both `tokenTransform` and `tokenToEnv` are present, the
   * transform wins. If only `tokenToEnv` is set, the consumer
   * stores `{ [tokenToEnv]: tokens.accessToken }`.
   */
  readonly tokenTransform?: (tokens: OAuthTokens) => Record<string, string>
  /** Optional client secret */
  readonly clientSecret?: string
  /**
   * UI hint for the BYO Mode A wizard. When `true`, the wizard renders
   * a second input asking the user to paste a client secret alongside
   * the client ID. Used for vendors whose token-exchange endpoint
   * requires a confidential client (e.g. Slack — its
   * `oauth.v2.access` endpoint rejects PKCE-only token swaps).
   *
   * Pure metadata — the OAuth flow itself does not branch on this
   * field. The user's secret arrives in the OAuth-start request body
   * (alongside the clientId), is persisted to the local
   * CredentialVault keyed as `<serverId>__oauth_client_secret`, and is
   * read back by the gateway on each PKCE attempt.
   *
   * Default: `false` (clientId-only — the common BYO PKCE case).
   */
  readonly requiresSecret?: boolean
  /**
   * Vendor URL where the user creates their own OAuth app /
   * integration. Rendered as Step 1 of the BYO Mode A wizard's
   * developer-portal link ("Open <Provider>'s developer portal →").
   *
   * Required field — the BYO model assumes every preset entry has a
   * known registration page. Adding a preset without one means the
   * Mode A wizard can't instruct the user end-to-end.
   *
   * Examples:
   *   - GitHub:    https://github.com/settings/developers
   *   - Notion:    https://www.notion.so/my-integrations
   *   - Slack:     https://api.slack.com/apps
   *   - Google:    https://console.cloud.google.com/apis/credentials
   *   - Microsoft: https://entra.microsoft.com/...
   */
  readonly registerUrl: string
}

// ---------------------------------------------------------------------------
// Server auth type
// ---------------------------------------------------------------------------

/** How an MCP server authenticates */
export type MCPServerAuthType = 'none' | 'api-key' | 'oauth2'

// ---------------------------------------------------------------------------
// OAuth state (in-flight flow tracking)
// ---------------------------------------------------------------------------

/** Tracks a pending OAuth flow */
export interface PendingOAuthFlow {
  /** Server ID this flow is for */
  readonly serverId: string
  /** CSRF state token */
  readonly state: string
  /** PKCE code verifier (the secret) */
  readonly codeVerifier: string
  /** Localhost callback port */
  readonly callbackPort: number
  /** OAuth config used */
  readonly config: OAuthFlowConfig
  /** When this flow started (for timeout) */
  readonly startedAt: number
}

// ---------------------------------------------------------------------------
// Callback result
// ---------------------------------------------------------------------------

/** Result from the OAuth callback server */
export interface OAuthCallbackResult {
  /** Authorization code from the provider */
  readonly code: string
  /** State token (must match the one we sent) */
  readonly state: string
}

/** Error from the OAuth callback */
export interface OAuthCallbackError {
  /** OAuth error code */
  readonly error: string
  /** Human-readable description */
  readonly errorDescription?: string
}
