/**
 * gatewaySelfBaseUrl / fetchGatewayJson — the running gateway's own address,
 * for in-process profile tools that call BACK into its HTTP API. The builder's
 * list_capabilities / propose_agent / suggest_agents and the gatherer's
 * scan_connectors all read the live connector catalog
 * (GET /api/v1/connectors) this way.
 *
 * Why this exists: those tools used to hardcode `http://127.0.0.1:3011`, which
 * was wrong on two axes —
 *   1. the gateway serves HTTPS/TLS by default (server.ts `tls` defaults true),
 *      so a plain `http://` fetch against the TLS socket throws every time; and
 *   2. the port drifts (3011 → 3012 → …) when an orphaned gateway squats the
 *      default, so even the right scheme on 3011 can miss the live listener.
 * The gateway now publishes its real scheme+host+port into `OWNWARE_GATEWAY` at
 * listen() time (server.ts); this module reads it and speaks the right
 * transport. One canonical home so the four tools never re-diverge.
 *
 * Shared across profiles (builder + gatherer) — lives under `profiles/_shared/`
 * (no agent.json, so the registry never loads it as a profile) and is reached
 * by a relative import that always co-ships with the tool files.
 */

import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'

/**
 * The gateway's own reachable base URL (no trailing slash), e.g.
 * `https://127.0.0.1:3011`. Throws a clear error when unset — that only
 * happens if a tool runs outside a live gateway, which is a real failure
 * worth surfacing, not silently papering over with a wrong default.
 */
export function gatewaySelfBaseUrl(): string {
  const raw = process.env.OWNWARE_GATEWAY
  if (raw == null || raw.trim().length === 0) {
    throw new Error(
      'OWNWARE_GATEWAY is not set — the gateway publishes its own address at ' +
        'startup, so an unset value means this tool is not running inside a ' +
        'live gateway process.',
    )
  }
  return raw.trim().replace(/\/+$/, '')
}

/**
 * GET `path` from the gateway and parse the JSON body. Speaks https or http to
 * match the published scheme. For the https loopback case it skips certificate
 * verification — safe ONLY because the host is always our own 127.0.0.1
 * listener behind the per-install self-signed cert (`<dataDir>/tls`), the same
 * posture the gateway-supervisor's liveness probe uses. NEVER point this at a
 * non-loopback host.
 */
export async function fetchGatewayJson<T>(path: string, timeoutMs = 25000): Promise<T> {
  const url = new URL(path.replace(/^\/+/, ''), gatewaySelfBaseUrl() + '/')
  const isHttps = url.protocol === 'https:'
  const requestFn = isHttps ? httpsRequest : httpRequest
  return await new Promise<T>((resolve, reject) => {
    const req = requestFn(
      url,
      isHttps ? { rejectUnauthorized: false } : {},
      (res) => {
        const status = res.statusCode ?? 0
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          if (status < 200 || status >= 300) {
            reject(new Error(`gateway responded HTTP ${status}`))
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T)
          } catch {
            reject(new Error('gateway returned a malformed JSON body'))
          }
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)))
    req.end()
  })
}
