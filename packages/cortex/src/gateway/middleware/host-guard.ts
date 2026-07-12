/**
 * Host-header guard (S9/WI-6) — DNS-rebinding protection for
 * non-loopback binds.
 *
 * The attack: a victim's browser visits attacker.com, whose DNS answer
 * flips to the gateway's LAN address; the browser then issues requests
 * that reach the gateway with `Host: attacker.com`, sidestepping CORS
 * (same-"origin" after the rebind). Rejecting unexpected Host values
 * kills the class.
 *
 * Allowed:
 *   - IP-literal hosts (v4/v6) — a DNS *name* is what rebinds; an IP
 *     literal can't. This is what lets LAN clients hit
 *     `http://192.168.x.y:port` on a 0.0.0.0 bind.
 *   - localhost / *.localhost
 *   - anything in `allowedHosts` (the operator's real hostname(s)).
 *
 * Installed only for non-loopback binds — loopback keeps the existing
 * CORS + CSRF-origin posture unchanged.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { sendError } from '../router.js'

export interface HostGuardOptions {
  /** Extra hostnames to allow (e.g. `ownware.example.com`). Compared case-insensitively, without port. */
  readonly allowedHosts?: readonly string[]
}

/** Strip the port from a Host header value; unbracket IPv6 literals. */
export function hostHeaderName(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? value : value.slice(1, end)
  }
  const colon = value.lastIndexOf(':')
  // A bare IPv6 without brackets has multiple colons — leave it whole.
  if (colon !== -1 && value.indexOf(':') === colon) return value.slice(0, colon)
  return value
}

export function createHostGuard(options: HostGuardOptions = {}) {
  const allowed = new Set((options.allowedHosts ?? []).map((h) => h.toLowerCase()))
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    // HTTP/2 carries :authority; node maps it onto req.headers.host for
    // compat. A request with NEITHER is malformed enough to reject.
    const raw = req.headers.host ?? (req.headers[':authority'] as string | undefined)
    if (!raw) {
      sendError(res, 403, 'Missing Host header', 'forbidden_host')
      return false
    }
    const name = hostHeaderName(raw)
    if (
      isIP(name) !== 0 ||
      name === 'localhost' ||
      name.endsWith('.localhost') ||
      allowed.has(name)
    ) {
      return true
    }
    sendError(
      res,
      403,
      `Host "${name}" not allowed — pass allowedHosts to GatewayOptions to serve a DNS name`,
      'forbidden_host',
    )
    return false
  }
}
