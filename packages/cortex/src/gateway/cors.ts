/**
 * CORS middleware + Origin-based CSRF guard.
 *
 * Supports an array of allowed origins with wildcard patterns.
 * Default: localhost-only (matches http://localhost:* and http://127.0.0.1:*).
 * Pass ['*'] for backward-compatible allow-all behavior.
 *
 * In addition to setting the standard CORS response headers, this module
 * blocks mutating requests (POST/PUT/PATCH/DELETE) whose Origin header is
 * present but does not match the allowlist. This prevents cross-origin
 * form submissions and `navigator.sendBeacon` calls that bypass CORS
 * preflight (the browser sends the request regardless — CORS only gates
 * whether the *response* is readable). Without this check, an attacker
 * page could fire-and-forget a POST to e.g. /threads/:id/abort.
 *
 * Requests with NO Origin header are allowed through — they come from
 * same-origin navigation, non-browser clients (curl, Postman), or
 * Electron's main process.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendError } from './router.js'

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
const ALLOWED_HEADERS = 'Content-Type, Authorization'
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Default allowed origins — localhost only (safe for Electron + dev). */
export const DEFAULT_CORS_ORIGINS = [
  'http://localhost:*',
  'http://127.0.0.1:*',
]

/**
 * Check if an origin matches an allowed pattern.
 * Supports wildcards (*) in patterns.
 */
function matchOrigin(origin: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === origin

  // Convert glob pattern to regex: escape special regex chars, then convert \* to .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regexStr = escaped.replace(/\*/g, '.*')
  return new RegExp(`^${regexStr}$`).test(origin)
}

function isOriginAllowed(origin: string, patterns: readonly string[]): boolean {
  return patterns.some(p => matchOrigin(origin, p))
}

/**
 * Handle CORS headers + CSRF origin check. Returns true if the request
 * was fully handled (OPTIONS preflight or rejected CSRF) — caller should
 * return early.
 *
 * @param allowedOrigins Array of allowed origin patterns. Supports wildcards.
 *   Use ['*'] for allow-all (backward compat). Default: localhost-only.
 */
export function handleCORS(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: string | readonly string[] = DEFAULT_CORS_ORIGINS,
): boolean {
  const origin = req.headers.origin ?? ''
  const method = req.method ?? 'GET'

  // Backward compat: accept a single string (legacy callers)
  const patterns = typeof allowedOrigins === 'string'
    ? (allowedOrigins === '*' ? ['*'] : [allowedOrigins])
    : allowedOrigins

  const allowed = origin.length === 0 || isOriginAllowed(origin, patterns)

  // ── CSRF guard ──────────────────────────────────────────────────────
  // Block mutating requests from disallowed origins. This catches
  // cross-origin form POSTs and sendBeacon calls that skip preflight.
  if (!allowed && MUTATING_METHODS.has(method)) {
    sendError(res, 403, 'Cross-origin request blocked', 'forbidden_origin', 'auth')
    return true
  }

  // ── Standard CORS headers ───────────────────────────────────────────
  if (patterns.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*')
  } else {
    res.setHeader('Access-Control-Allow-Origin', allowed ? origin : '')
  }

  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS)
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS)
  res.setHeader('Access-Control-Max-Age', '86400')

  if (method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return true
  }

  return false
}
