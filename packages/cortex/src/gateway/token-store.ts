/**
 * Gateway token persistence (S9/WI-2) — `<dataDir>/gateway-token`, 0600.
 *
 * When auth is enabled the token must outlive the process: channel
 * runners, `ownware` CLI calls, and remote clients all discover it from
 * this file instead of copy-pasting a value that changes every boot.
 * (The pidfile deliberately does NOT carry the token — the pidfile is
 * world-readable metadata; this file is the secret, alone, 0600.)
 *
 * Never log the value. Never put it in the pidfile or any response.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { generateSessionToken } from './middleware/auth.js'

export const GATEWAY_TOKEN_FILENAME = 'gateway-token'

/** 32 bytes hex — what `generateSessionToken` mints. */
const TOKEN_SHAPE = /^[0-9a-f]{64}$/

export function gatewayTokenPath(dataDir: string): string {
  return join(dataDir, GATEWAY_TOKEN_FILENAME)
}

/**
 * Read the persisted token, or mint + persist a fresh one. A file with
 * the wrong shape (truncated write, hand edit) is replaced — a broken
 * secret is worse than a rotated one; clients re-read the file anyway.
 */
export function loadOrCreateGatewayToken(dataDir: string): string {
  const path = gatewayTokenPath(dataDir)
  if (existsSync(path)) {
    try {
      const existing = readFileSync(path, 'utf8').trim()
      if (TOKEN_SHAPE.test(existing)) {
        // Re-assert perms — a copy/restore can loosen them silently.
        chmodSync(path, 0o600)
        return existing
      }
    } catch {
      // unreadable → fall through to rotate
    }
  }
  const token = generateSessionToken()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${token}\n`, { mode: 0o600 })
  return token
}
