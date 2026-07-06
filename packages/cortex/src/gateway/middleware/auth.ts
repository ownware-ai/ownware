/**
 * Auth middleware — session token authentication.
 *
 * Generates a random session token on gateway startup.
 * All requests (except health) must include it as a Bearer token.
 * This is NOT user auth — it prevents unauthorized local processes
 * from accessing the gateway.
 *
 * Can be disabled for local development by passing `disabled: true` to
 * `createAuthMiddleware()`, or by setting the `OWNWARE_DISABLE_AUTH=1`
 * environment variable before the gateway boots. The middleware is
 * still installed in the chain; it just becomes a no-op. This preserves
 * the middleware hook for when real user auth (e.g. Auth0) plugs in
 * later without requiring a restructure.
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendError } from '../router.js'

/** Generate a cryptographically random 32-byte hex session token. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex')
}

/** Paths exempt from auth (health check must always be accessible). */
const AUTH_EXEMPT_PATHS = new Set(['/api/v1/health'])

export interface AuthMiddlewareOptions {
  /** When true, the middleware bypasses all checks. Use for local dev. */
  readonly disabled?: boolean
}

/**
 * Create an auth middleware function that validates Bearer tokens.
 * Returns true if the request is authorized, false if rejected (response already sent).
 */
export function createAuthMiddleware(
  token: string,
  options: AuthMiddlewareOptions = {},
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const disabled = options.disabled === true

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (disabled) return true

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    // Skip auth for exempt paths
    if (AUTH_EXEMPT_PATHS.has(url.pathname)) return true

    // Skip OPTIONS (CORS preflight)
    if (req.method === 'OPTIONS') return true

    const authHeader = req.headers.authorization
    if (!authHeader) {
      sendError(res, 401, 'Missing authorization token', 'unauthorized')
      return false
    }

    const parts = authHeader.split(' ')
    if (parts.length !== 2 || parts[0] !== 'Bearer' || parts[1] !== token) {
      sendError(res, 401, 'Invalid authorization token', 'unauthorized')
      return false
    }

    return true
  }
}
