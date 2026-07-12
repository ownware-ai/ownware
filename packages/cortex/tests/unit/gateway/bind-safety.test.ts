/**
 * Bind-safety invariant (S9/WI-1) + token persistence (WI-2) + host
 * guard (WI-6).
 *
 * THE invariant: non-loopback bind ⇒ auth + TLS forced, or refuse to
 * boot. Before this existed, `OWNWARE_HOST=0.0.0.0` with the default
 * auth-off posture served all ~230 routes to the LAN unauthenticated —
 * the exact misconfiguration these tests make impossible to reintroduce.
 *
 * The 0.0.0.0 cases that BOOT are exercised via loopback requests (a
 * wildcard bind includes 127.0.0.1) so CI needs no real network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'os'
import { join } from 'path'
import { OwnwareGateway, isLoopbackHost } from '../../../src/gateway/server.js'
import { loadOrCreateGatewayToken, gatewayTokenPath } from '../../../src/gateway/token-store.js'
import { createHostGuard, hostHeaderName } from '../../../src/gateway/middleware/host-guard.js'

let dir: string
let profilesDir: string
let dataDir: string
let gateway: OwnwareGateway | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ownware-bind-safety-'))
  profilesDir = join(dir, 'profiles')
  dataDir = join(dir, 'data')
  const profileDir = join(profilesDir, 'test-agent')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'agent.json'), JSON.stringify({ name: 'test-agent' }))
})

afterEach(async () => {
  if (gateway) {
    await gateway.stop()
    gateway = null
  }
  await rm(dir, { recursive: true, force: true })
})

/** GET via node:http with full header control (fetch forbids Host). */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        res.resume()
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0 }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('isLoopbackHost', () => {
  it('classifies loopback vs network hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('::')).toBe(false)
    expect(isLoopbackHost('192.168.1.5')).toBe(false)
    expect(isLoopbackHost('example.com')).toBe(false)
  })
})

describe('the invariant: non-loopback bind', () => {
  it('REFUSES to boot with disableAuth: true', () => {
    expect(
      () => new OwnwareGateway({ port: 0, profilesDir, dataDir, host: '0.0.0.0', disableAuth: true, tls: true }),
    ).toThrow(/auth disabled/)
  })

  it('REFUSES to boot with tls: false', () => {
    expect(
      () => new OwnwareGateway({ port: 0, profilesDir, dataDir, host: '0.0.0.0', tls: false }),
    ).toThrow(/without TLS/)
  })

  it('forces auth ON even with the default (auth-off) posture — the token file appears', async () => {
    gateway = new OwnwareGateway({ port: 0, profilesDir, dataDir, host: '0.0.0.0', tls: true })
    await gateway.start()

    // The persisted token file is the observable of "auth is on" (an
    // auth-off boot never writes it — asserted below). The 401/200
    // behavior itself is pinned in the token-persistence suite and the
    // host-guard end-to-end leg.
    const persisted = (await readFile(gatewayTokenPath(dataDir), 'utf8')).trim()
    expect(persisted).toBe(gateway.token)
  })
})

describe('loopback bind (the local-first default, unchanged)', () => {
  it('boots with auth off and answers without a token', async () => {
    gateway = new OwnwareGateway({ port: 0, profilesDir, dataDir, tls: false })
    await gateway.start()
    const res = await rawGet(gateway.port, '/api/v1/models')
    expect(res.status).toBe(200)
  })

  it('loopback + explicit disableAuth/tls-off is still allowed (nothing regressed)', async () => {
    gateway = new OwnwareGateway({ port: 0, profilesDir, dataDir, host: '127.0.0.1', disableAuth: true, tls: false })
    await gateway.start()
    const res = await rawGet(gateway.port, '/api/v1/health')
    expect(res.status).toBe(200)
  })
})

describe('token persistence (<dataDir>/gateway-token)', () => {
  it('never prints the full token or a token prefix during auth-enabled boot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      gateway = new OwnwareGateway({ port: 0, profilesDir, dataDir, disableAuth: false, tls: false })
      await gateway.start()
      const output = warn.mock.calls.flat().join('\n')

      expect(output).toContain(gatewayTokenPath(dataDir))
      expect(output).not.toContain(gateway.token)
      expect(output).not.toContain(gateway.token.slice(0, 8))
    } finally {
      warn.mockRestore()
    }
  })

  it('auth-enabled boot writes the token file with 0600 and gateway.token matches', async () => {
    gateway = new OwnwareGateway({ port: 0, profilesDir, dataDir, disableAuth: false, tls: false })
    await gateway.start()

    const tokenFile = gatewayTokenPath(dataDir)
    const persisted = (await readFile(tokenFile, 'utf8')).trim()
    expect(persisted).toBe(gateway.token)
    expect(persisted).toMatch(/^[0-9a-f]{64}$/)
    const mode = (await stat(tokenFile)).mode & 0o777
    expect(mode).toBe(0o600)

    // Auth is real: no token → 401, with token → 200.
    expect((await rawGet(gateway.port, '/api/v1/models')).status).toBe(401)
    expect(
      (await rawGet(gateway.port, '/api/v1/models', { authorization: `Bearer ${persisted}` })).status,
    ).toBe(200)
  })

  it('the token survives a restart (same dataDir → same token)', async () => {
    const first = loadOrCreateGatewayToken(dataDir)
    gateway = new OwnwareGateway({ port: 0, profilesDir, dataDir, disableAuth: false, tls: false })
    await gateway.start()
    expect(gateway.token).toBe(first)
  })

  it('a corrupt token file rotates instead of serving a broken secret', async () => {
    await mkdir(dataDir, { recursive: true })
    await writeFile(gatewayTokenPath(dataDir), 'not-a-token\n')
    const token = loadOrCreateGatewayToken(dataDir)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('an auth-off loopback boot does NOT write the token file', async () => {
    gateway = new OwnwareGateway({ port: 0, profilesDir, dataDir, tls: false })
    await gateway.start()
    await expect(readFile(gatewayTokenPath(dataDir), 'utf8')).rejects.toThrow()
  })
})

describe('host-header guard (DNS-rebinding)', () => {
  it('hostHeaderName strips ports and unbrackets IPv6', () => {
    expect(hostHeaderName('example.com:3011')).toBe('example.com')
    expect(hostHeaderName('192.168.1.5:8080')).toBe('192.168.1.5')
    expect(hostHeaderName('[::1]:3011')).toBe('::1')
    expect(hostHeaderName('LOCALHOST')).toBe('localhost')
  })

  it('allows IP literals, localhost, and allowlisted names; rejects everything else', () => {
    const guard = createHostGuard({ allowedHosts: ['ownware.example.com'] })
    const ok = (host: string) => {
      let sent = 0
      const res = { writeHead: () => res, end: () => void sent++, headersSent: false, setHeader: () => {} }
      return guard(
        { headers: { host } } as never,
        res as never,
      )
    }
    expect(ok('192.168.1.5:3011')).toBe(true)
    expect(ok('[::1]:3011')).toBe(true)
    expect(ok('localhost:3011')).toBe(true)
    expect(ok('app.localhost')).toBe(true)
    expect(ok('ownware.example.com')).toBe(true)
    expect(ok('attacker.com')).toBe(false)
    expect(ok('ownware.example.com.evil.io')).toBe(false)
  })

  it('a non-loopback gateway 403s an unexpected Host and serves an IP-literal Host', async () => {
    gateway = new OwnwareGateway({ port: 0, profilesDir, dataDir, host: '0.0.0.0', tls: true })
    await gateway.start()
    const token = gateway.token

    const tlsGet = (host: string): Promise<{ status: number; body: Record<string, unknown> }> =>
      new Promise((resolvePromise, reject) => {
        const req = httpsRequest(
          {
            host: '127.0.0.1',
            port: gateway!.port,
            path: '/api/v1/health',
            method: 'GET',
            // Self-signed loopback cert — the pin-trust story is the
            // fingerprint, not a CA chain. This test only cares about
            // the Host verdict.
            rejectUnauthorized: false,
            headers: { host, authorization: `Bearer ${token}` },
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8')
              resolvePromise({
                status: res.statusCode ?? 0,
                body: raw.length > 0 ? JSON.parse(raw) as Record<string, unknown> : {},
              })
            })
          },
        )
        req.on('error', reject)
        req.end()
      })

    const denied = await tlsGet('attacker.com')
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({
      error: 'forbidden_host',
      message: 'Host "attacker.com" not allowed — pass allowedHosts to GatewayOptions to serve a DNS name',
      category: 'auth',
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect((await tlsGet('192.168.1.5:3011')).status).toBe(200)
    expect((await tlsGet('localhost')).status).toBe(200)
  })
})
