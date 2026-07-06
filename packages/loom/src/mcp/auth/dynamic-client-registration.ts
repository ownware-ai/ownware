/**
 * OAuth dynamic client registration (RFC 7591).
 *
 * For OAuth servers that support dynamic client registration, the client
 * does not need a pre-registered client ID. It POSTs to the
 * `registration_endpoint` (discovered via
 * `oauth-discovery.ts:discoverOAuthEndpoints`) with the redirect URIs
 * and requested scopes, and the server responds with a `client_id`
 * (and optionally a `client_secret` for confidential clients).
 *
 * After this step, the standard PKCE flow in `oauth-flow.ts` runs with
 * the issued client_id.
 *
 * Pure module: caller passes a `fetch` impl, no globals.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DynamicClientRegistrationRequest {
  /**
   * URLs the authorization server may redirect the user-agent to after
   * authorization. We always register the localhost callback so the
   * native flow works.
   */
  readonly redirectUris: readonly string[]
  /** Requested scopes — passed as a space-separated string per RFC 7591. */
  readonly scopes: readonly string[]
  /**
   * Human-readable client name shown on the authorization page.
   * Improves the consent UX so users know which app is asking.
   */
  readonly clientName?: string
  /**
   * Optional public URL for the client (per RFC 7591). Most clients
   * don't have one in the local-Electron context — leave undefined.
   */
  readonly clientUri?: string
  /**
   * Whether the client treats the client secret as confidential. For
   * public clients (no secret, like a desktop Electron app using PKCE)
   * pass `false`. Most dynamic registrations issued without a secret
   * default to "public"; setting this explicitly avoids ambiguity.
   */
  readonly tokenEndpointAuthMethod?: 'none' | 'client_secret_basic' | 'client_secret_post'
}

export interface IssuedClientCredentials {
  readonly clientId: string
  /** Present only when the AS issues a confidential client. */
  readonly clientSecret: string | null
  /** Optional: when the client_id expires (Unix seconds, 0 = never). */
  readonly clientIdIssuedAt: number | null
  /** Optional: when the client_secret expires (Unix seconds, 0 = never). */
  readonly clientSecretExpiresAt: number | null
  /** Echo of the registered redirect URIs from the AS response. */
  readonly redirectUris: readonly string[]
}

export interface DynamicClientRegistrationOptions {
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

export class DynamicClientRegistrationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly cause_?: unknown,
  ) {
    super(message)
    this.name = 'DynamicClientRegistrationError'
  }
}

// ---------------------------------------------------------------------------
// Response schema (RFC 7591 §3.2.1)
// ---------------------------------------------------------------------------

const RegistrationResponseSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1).optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
  redirect_uris: z.array(z.string().url()).min(1).optional(),
}).passthrough()

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Register a new OAuth client at the given registration endpoint.
 *
 * Throws `DynamicClientRegistrationError` on:
 * - Network failure
 * - Non-2xx HTTP status
 * - Response body that doesn't match RFC 7591 (missing `client_id`, etc.)
 */
export async function registerOAuthClient(
  registrationEndpoint: string,
  request: DynamicClientRegistrationRequest,
  opts: DynamicClientRegistrationOptions = {},
): Promise<IssuedClientCredentials> {
  if (request.redirectUris.length === 0) {
    throw new DynamicClientRegistrationError(
      'redirectUris must be non-empty',
    )
  }
  const fetchImpl = opts.fetch ?? fetch

  const body: Record<string, unknown> = {
    redirect_uris: [...request.redirectUris],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    // RFC 7591: scopes are a single space-separated string.
    scope: request.scopes.join(' '),
  }
  if (request.clientName !== undefined && request.clientName.length > 0) {
    body.client_name = request.clientName
  }
  if (request.clientUri !== undefined && request.clientUri.length > 0) {
    body.client_uri = request.clientUri
  }
  if (request.tokenEndpointAuthMethod !== undefined) {
    body.token_endpoint_auth_method = request.tokenEndpointAuthMethod
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000)
  let res: Response
  try {
    res = await fetchImpl(registrationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    throw new DynamicClientRegistrationError(
      `Failed to POST to registration endpoint at ${registrationEndpoint}: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      err,
    )
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    let errBody: string
    try {
      errBody = await res.text()
    } catch {
      errBody = '<unreadable>'
    }
    throw new DynamicClientRegistrationError(
      `Registration endpoint returned ${res.status}: ${errBody.slice(0, 500)}`,
      res.status,
    )
  }

  let payload: unknown
  try {
    payload = await res.json()
  } catch (err) {
    throw new DynamicClientRegistrationError(
      `Registration endpoint returned non-JSON response: ${err instanceof Error ? err.message : String(err)}`,
      res.status,
      err,
    )
  }

  const parsed = RegistrationResponseSchema.safeParse(payload)
  if (!parsed.success) {
    throw new DynamicClientRegistrationError(
      `Registration response did not match RFC 7591: ${parsed.error.message}`,
      res.status,
      parsed.error,
    )
  }

  return {
    clientId: parsed.data.client_id,
    clientSecret: parsed.data.client_secret ?? null,
    clientIdIssuedAt: parsed.data.client_id_issued_at ?? null,
    clientSecretExpiresAt: parsed.data.client_secret_expires_at ?? null,
    redirectUris: parsed.data.redirect_uris ?? request.redirectUris,
  }
}
