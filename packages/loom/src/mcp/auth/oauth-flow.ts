/**
 * OAuth2 PKCE Flow Orchestrator
 *
 * Ties together: PKCE generation → callback server → browser open →
 * code exchange → token storage.
 *
 * This is the main entry point for performing an OAuth2 authentication
 * flow for MCP servers.
 */

import { randomBytes, createHash } from 'node:crypto'
import { findAvailablePort, buildRedirectUri, startCallbackServer, OAuthFlowError } from './oauth-callback.js'
import type { OAuthFlowConfig, OAuthTokens, PendingOAuthFlow } from './types.js'

// ---------------------------------------------------------------------------
// PKCE helpers (RFC 7636)
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random code verifier (43-128 chars).
 * Uses base64url encoding of 32 random bytes = 43 chars.
 */
function generateCodeVerifier(): string {
  return randomBytes(32)
    .toString('base64url')
    // Ensure only unreserved characters (RFC 7636 §4.1)
    .replace(/[^a-zA-Z0-9\-._~]/g, '')
}

/**
 * Compute S256 code challenge from a code verifier.
 * challenge = BASE64URL(SHA256(verifier))
 */
function generateCodeChallenge(verifier: string): string {
  return createHash('sha256')
    .update(verifier)
    .digest('base64url')
}

/**
 * Generate a random state token for CSRF protection.
 * 32 bytes → 43 chars base64url.
 */
function generateState(): string {
  return randomBytes(32).toString('base64url')
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/**
 * Parse a token endpoint response body. Handles both JSON (most
 * providers) AND application/x-www-form-urlencoded (GitHub default,
 * some other legacy providers). Used by both exchangeCodeForTokens
 * and refreshTokens to avoid the audit Hazard 11 inconsistency where
 * only one of the two paths had the URL-encoded fallback.
 */
function parseTokenResponseBody(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    const params = new URLSearchParams(body)
    return Object.fromEntries(params.entries())
  }
}

/**
 * Exchange an authorization code for tokens.
 *
 * POST to the token endpoint with:
 *   grant_type=authorization_code
 *   code={authorization_code}
 *   redirect_uri={callback_uri}
 *   code_verifier={pkce_verifier}
 *   client_id={client_id}
 */
async function exchangeCodeForTokens(
  config: OAuthFlowConfig,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: config.clientId,
  })

  if (config.clientSecret) {
    body.set('client_secret', config.clientSecret)
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  })

  // Some providers (GitHub) return 200 with error in body
  const responseBody = await response.text()
  const data = parseTokenResponseBody(responseBody)

  // Check for error in response body (even on 200)
  if (data.error) {
    throw new OAuthFlowError(
      String(data.error),
      String(data.error_description ?? `Token exchange failed: ${data.error}`),
    )
  }

  if (!response.ok) {
    throw new OAuthFlowError(
      'token_exchange_failed',
      `Token endpoint returned ${response.status}: ${responseBody.slice(0, 200)}`,
    )
  }

  const accessToken = data.access_token as string | undefined
  if (!accessToken) {
    throw new OAuthFlowError(
      'no_access_token',
      'Token endpoint did not return an access_token',
    )
  }

  const expiresIn = typeof data.expires_in === 'number'
    ? data.expires_in
    : typeof data.expires_in === 'string'
      ? parseInt(data.expires_in, 10)
      : 3600 // Default 1 hour if not specified

  return {
    accessToken,
    refreshToken: data.refresh_token as string | undefined,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: data.scope as string | undefined,
    tokenType: (data.token_type as string) ?? 'Bearer',
  }
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

/**
 * Refresh an access token using a refresh_token.
 */
export async function refreshTokens(
  config: Pick<OAuthFlowConfig, 'clientId' | 'clientSecret' | 'tokenUrl'>,
  refreshToken: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
  })

  if (config.clientSecret) {
    body.set('client_secret', config.clientSecret)
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  })

  // Audit Hazard 11 fix (2026-04-11): the previous code did
  // `await response.json()` which throws on GitHub-style URL-encoded
  // refresh responses. Use the shared parser so refresh and exchange
  // both handle both response shapes identically.
  const responseBody = await response.text()
  const data = parseTokenResponseBody(responseBody)

  // Normalize non-standard error codes (e.g., Slack: invalid_refresh_token)
  const error = data.error as string | undefined
  if (error) {
    const normalizedError = error === 'invalid_refresh_token' ? 'invalid_grant' : error
    throw new OAuthFlowError(
      normalizedError,
      String(data.error_description ?? `Token refresh failed: ${normalizedError}`),
    )
  }

  if (!response.ok) {
    throw new OAuthFlowError(
      'refresh_failed',
      `Token refresh returned ${response.status}`,
    )
  }

  const accessToken = data.access_token as string
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600

  return {
    accessToken,
    refreshToken: (data.refresh_token as string | undefined) ?? refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: data.scope as string | undefined,
    tokenType: (data.token_type as string) ?? 'Bearer',
  }
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

/**
 * Perform a full OAuth2 PKCE authentication flow.
 *
 * 1. Find an available port for the callback server
 * 2. Generate PKCE code_verifier and code_challenge
 * 3. Generate random state for CSRF protection
 * 4. Start the callback server
 * 5. Build and return the authorization URL
 * 6. Wait for the callback
 * 7. Exchange the code for tokens
 *
 * Returns { authUrl, pendingFlow, waitForTokens }:
 *   - authUrl: Open this in the user's browser
 *   - pendingFlow: Flow metadata for tracking
 *   - waitForTokens: Promise that resolves with tokens
 *   - shutdown: Call to abort the flow
 */
export async function startOAuthFlow(config: OAuthFlowConfig): Promise<{
  authUrl: string
  pendingFlow: PendingOAuthFlow
  waitForTokens: Promise<OAuthTokens>
  shutdown: () => void
}> {
  // 1. Port
  const port = config.callbackPort ?? await findAvailablePort()
  const redirectUri = buildRedirectUri(port)

  // 2. PKCE
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)

  // 3. State (CSRF)
  const state = generateState()

  // 4. Callback server
  const { promise: callbackPromise, shutdown } = startCallbackServer(port, state)

  // 5. Authorization URL
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })

  if (config.scopes.length > 0) {
    params.set('scope', config.scopes.join(' '))
  }

  const authUrl = `${config.authorizationUrl}?${params.toString()}`

  // 6. Pending flow metadata
  const pendingFlow: PendingOAuthFlow = {
    serverId: config.serverId,
    state,
    codeVerifier,
    callbackPort: port,
    config,
    startedAt: Date.now(),
  }

  // 7. Token exchange (happens after callback)
  const waitForTokens = callbackPromise.then(async (result) => {
    return exchangeCodeForTokens(config, result.code, redirectUri, codeVerifier)
  })

  return { authUrl, pendingFlow, waitForTokens, shutdown }
}
