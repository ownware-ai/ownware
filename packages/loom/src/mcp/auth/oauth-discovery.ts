/**
 * OAuth metadata discovery (MCP 2025-03-26 spec).
 *
 * For MCP servers that implement dynamic OAuth, the client doesn't know
 * the authorization/token/registration endpoints in advance. The server
 * advertises an OAuth resource server metadata URL via a 401
 * `WWW-Authenticate` header (RFC 9728); the client follows the chain to
 * an OAuth authorization server metadata document (RFC 8414) which lists
 * the endpoints needed for PKCE + dynamic client registration.
 *
 * Discovery flow (3 hops):
 *
 *   1. Probe the MCP server endpoint (any HTTP method that triggers auth
 *      enforcement). Server responds 401 with a header like:
 *        WWW-Authenticate: Bearer resource_metadata="https://api.figma.com/.well-known/oauth-protected-resource"
 *   2. Fetch the resource metadata URL → get OAuth server URLs
 *      (`authorization_servers: ["https://figma.com"]`).
 *   3. Fetch each AS's `<as>/.well-known/oauth-authorization-server` →
 *      get `authorization_endpoint`, `token_endpoint`, and the
 *      `registration_endpoint` for dynamic client registration.
 *
 * The resulting `DiscoveredOAuthEndpoints` is the input to the dynamic
 * client registration step (`dynamic-client-registration.ts`) and then
 * to the standard PKCE flow (`oauth-flow.ts`).
 *
 * Pure module: no globals, no caching, no orchestration. Caller passes
 * a `fetch` implementation (defaults to global `fetch`) so tests can
 * inject a mock without monkey-patching.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredOAuthEndpoints {
  /** Authorization server metadata URL the resource pointed at. */
  readonly authorizationServerUrl: string
  /** Where the user is redirected to authorize (RFC 6749). */
  readonly authorizationEndpoint: string
  /** Where authorization codes are exchanged for tokens (RFC 6749). */
  readonly tokenEndpoint: string
  /** Optional dynamic client registration endpoint (RFC 7591). */
  readonly registrationEndpoint: string | null
  /** Optional supported scopes from the AS metadata. */
  readonly scopesSupported: readonly string[] | null
  /** Optional `code_challenge_methods_supported` (we require S256). */
  readonly codeChallengeMethodsSupported: readonly string[] | null
}

export interface OAuthDiscoveryOptions {
  /** Override `fetch`. Defaults to global `fetch`. */
  readonly fetch?: typeof fetch
  /** Per-hop timeout (ms). Defaults to 5000. */
  readonly timeoutMs?: number
}

export class OAuthDiscoveryError extends Error {
  constructor(
    message: string,
    readonly hop:
      | 'probe'
      | 'parse-www-authenticate'
      | 'resource-metadata'
      | 'authorization-server-metadata',
    readonly cause_?: unknown,
  ) {
    super(message)
    this.name = 'OAuthDiscoveryError'
  }
}

// ---------------------------------------------------------------------------
// WWW-Authenticate parsing
// ---------------------------------------------------------------------------

/**
 * Parse the `WWW-Authenticate` header for the resource-metadata URL.
 *
 * Expected format (RFC 9728 §5.1):
 *   `Bearer realm="...", resource_metadata="https://example.com/.well-known/oauth-protected-resource"`
 *
 * We only need `resource_metadata`. Tolerant of:
 *  - Extra parameters before/after.
 *  - Quoted or unquoted values (RFC 7235 BNF allows both — most servers
 *    quote URLs because they contain `:` and `/`).
 *  - Different schemes ("Bearer", "DPoP", etc.) — we only need the URL.
 *
 * Returns `null` when the header is absent or doesn't carry the
 * `resource_metadata` parameter — the caller should treat that as
 * "this server doesn't speak the dynamic-OAuth spec."
 */
export function parseResourceMetadataUrl(
  wwwAuthenticate: string | null,
): string | null {
  if (wwwAuthenticate === null || wwwAuthenticate.length === 0) return null

  // The header may carry multiple challenges separated by commas, each
  // with multiple parameters. We just look for `resource_metadata=` —
  // a substring search is unambiguous because the value is always a
  // URL (which can't contain `=` unencoded outside the param value).
  const match = wwwAuthenticate.match(/resource_metadata\s*=\s*"?([^",\s]+)"?/i)
  if (!match) return null
  const url = match[1]
  if (!url || url.length === 0) return null
  // Defensive: ensure it's an http(s) URL.
  if (!/^https?:\/\//i.test(url)) return null
  return url
}

// ---------------------------------------------------------------------------
// Resource metadata schema (RFC 9728)
// ---------------------------------------------------------------------------

const ResourceMetadataSchema = z.object({
  // RFC 9728 §3: list of authorization server issuer URLs.
  authorization_servers: z.array(z.string().url()).min(1),
  // Other RFC 9728 fields (resource, scopes_supported, etc.) — we only
  // need authorization_servers for now. Pass-through extra fields.
}).passthrough()

// ---------------------------------------------------------------------------
// Authorization server metadata schema (RFC 8414)
// ---------------------------------------------------------------------------

const AuthorizationServerMetadataSchema = z.object({
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  registration_endpoint: z.string().url().optional(),
  scopes_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
}).passthrough()

// ---------------------------------------------------------------------------
// Hop 1: probe the MCP server, capture WWW-Authenticate
// ---------------------------------------------------------------------------

/**
 * Probe an MCP server endpoint to retrieve its `WWW-Authenticate`
 * header. We don't actually care about the response body — the header
 * is what matters.
 *
 * MCP servers conventionally accept POST for the JSON-RPC channel, so
 * we use POST with an empty body. A 401 carrying the metadata header is
 * the success path. 200 (no auth required) means this server doesn't
 * speak dynamic OAuth, and the caller should fall back.
 */
export async function probeForWWWAuthenticate(
  mcpEndpointUrl: string,
  opts: OAuthDiscoveryOptions = {},
): Promise<string | null> {
  const fetchImpl = opts.fetch ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000)
  try {
    const res = await fetchImpl(mcpEndpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    })
    return res.headers.get('www-authenticate')
  } catch (err) {
    throw new OAuthDiscoveryError(
      `Failed to probe MCP endpoint at ${mcpEndpointUrl}: ${err instanceof Error ? err.message : String(err)}`,
      'probe',
      err,
    )
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Hop 2: fetch resource metadata
// ---------------------------------------------------------------------------

async function fetchResourceMetadata(
  url: string,
  opts: OAuthDiscoveryOptions,
): Promise<{ authorizationServerUrl: string }> {
  const fetchImpl = opts.fetch ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000)
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new OAuthDiscoveryError(
        `Resource metadata fetch returned ${res.status} for ${url}`,
        'resource-metadata',
      )
    }
    const body = await res.json() as unknown
    const parsed = ResourceMetadataSchema.safeParse(body)
    if (!parsed.success) {
      throw new OAuthDiscoveryError(
        `Resource metadata at ${url} did not match RFC 9728 shape: ${parsed.error.message}`,
        'resource-metadata',
        parsed.error,
      )
    }
    // Pick the first AS — RFC 9728 allows multiple but most resources
    // list one. A future enhancement could try each in order.
    return { authorizationServerUrl: parsed.data.authorization_servers[0]! }
  } catch (err) {
    if (err instanceof OAuthDiscoveryError) throw err
    throw new OAuthDiscoveryError(
      `Failed to fetch resource metadata at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      'resource-metadata',
      err,
    )
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Hop 3: fetch authorization server metadata
// ---------------------------------------------------------------------------

/**
 * Build the well-known URL for a given authorization server issuer.
 * RFC 8414 §3: `<issuer>/.well-known/oauth-authorization-server`.
 * Strips a trailing slash on the issuer to avoid double-slash URLs.
 */
function buildAuthorizationServerMetadataUrl(issuer: string): string {
  const trimmed = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer
  return `${trimmed}/.well-known/oauth-authorization-server`
}

async function fetchAuthorizationServerMetadata(
  authorizationServerUrl: string,
  opts: OAuthDiscoveryOptions,
): Promise<DiscoveredOAuthEndpoints> {
  const fetchImpl = opts.fetch ?? fetch
  const metadataUrl = buildAuthorizationServerMetadataUrl(authorizationServerUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000)
  try {
    const res = await fetchImpl(metadataUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new OAuthDiscoveryError(
        `Authorization server metadata fetch returned ${res.status} for ${metadataUrl}`,
        'authorization-server-metadata',
      )
    }
    const body = await res.json() as unknown
    const parsed = AuthorizationServerMetadataSchema.safeParse(body)
    if (!parsed.success) {
      throw new OAuthDiscoveryError(
        `Authorization server metadata at ${metadataUrl} did not match RFC 8414 shape: ${parsed.error.message}`,
        'authorization-server-metadata',
        parsed.error,
      )
    }
    return {
      authorizationServerUrl,
      authorizationEndpoint: parsed.data.authorization_endpoint,
      tokenEndpoint: parsed.data.token_endpoint,
      registrationEndpoint: parsed.data.registration_endpoint ?? null,
      scopesSupported: parsed.data.scopes_supported ?? null,
      codeChallengeMethodsSupported:
        parsed.data.code_challenge_methods_supported ?? null,
    }
  } catch (err) {
    if (err instanceof OAuthDiscoveryError) throw err
    throw new OAuthDiscoveryError(
      `Failed to fetch authorization server metadata at ${metadataUrl}: ${err instanceof Error ? err.message : String(err)}`,
      'authorization-server-metadata',
      err,
    )
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Public entry: discover endpoints starting from MCP server URL
// ---------------------------------------------------------------------------

/**
 * Run the full 3-hop discovery from an MCP server endpoint URL.
 *
 * Returns:
 *   - `null` when the server doesn't advertise OAuth (no 401, or no
 *     `resource_metadata` parameter on the WWW-Authenticate header).
 *     The caller should treat this as "this server isn't an OAuth one"
 *     and fall back to its existing path (preset OAuth, api_key, none).
 *   - `DiscoveredOAuthEndpoints` on success.
 *
 * Throws `OAuthDiscoveryError` only on protocol-level failures (server
 * said it speaks the spec but the metadata is malformed or unreachable).
 */
export async function discoverOAuthEndpoints(
  mcpEndpointUrl: string,
  opts: OAuthDiscoveryOptions = {},
): Promise<DiscoveredOAuthEndpoints | null> {
  const wwwAuthenticate = await probeForWWWAuthenticate(mcpEndpointUrl, opts)
  const resourceMetadataUrl = parseResourceMetadataUrl(wwwAuthenticate)
  if (resourceMetadataUrl === null) return null

  const { authorizationServerUrl } = await fetchResourceMetadata(
    resourceMetadataUrl,
    opts,
  )
  return await fetchAuthorizationServerMetadata(authorizationServerUrl, opts)
}

// Exposed for unit tests.
export const __testOnly = {
  buildAuthorizationServerMetadataUrl,
}
