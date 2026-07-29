/**
 * Where the CLI's gateway comes from.
 *
 * The CLI is always a client of the gateway wire contract. Even when it
 * boots the gateway itself, it talks to
 * it over HTTP+SSE via `@ownware/client`, never in-process calls. Two
 * sources:
 *
 *   - `--base-url` (or OWNWARE_BASE_URL): attach to a gateway that is
 *     already running, local or remote. Token from `--token`,
 *     OWNWARE_GATEWAY_TOKEN, or `<dataDir>/gateway-token`.
 *   - otherwise: boot a loopback gateway in-process on an ephemeral port
 *     (`@ownware/cortex` is imported lazily so attach mode stays light).
 *     Plain HTTP is safe here — loopback bind only; the gateway itself
 *     refuses `tls:false` on non-loopback binds.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redirectConsoleToFile } from './gateway-log.js'

export interface GatewayHandle {
  readonly baseUrl: string
  readonly token: string | undefined
  /** Where CLI state (sessions) lives — same dir the gateway uses. */
  readonly dataDir: string
  /** True when this process booted the gateway and owns its lifecycle. */
  readonly owned: boolean
  /** Where the owned gateway's console output goes (BUGS #1). */
  readonly logFile?: string
  close(): Promise<void>
}

export interface EnsureGatewayOptions {
  readonly baseUrl?: string
  readonly token?: string
  readonly profilesDir?: string
  readonly dataDir?: string
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['OWNWARE_DATA_DIR'] ?? join(homedir(), '.ownware')
}

/**
 * Your profiles first: `./profiles` in the working directory wins, the
 * marketplace bundled inside `@ownware/cortex` is the fresh-dir fallback
 * (mirrors the gateway CLI's own `findProfilesDir`).
 */
export function resolveProfilesDir(cwd: string): string {
  const local = resolve(cwd, 'profiles')
  if (existsSync(local)) return local
  try {
    const cortexEntry = fileURLToPath(import.meta.resolve('@ownware/cortex'))
    const bundled = resolve(cortexEntry, '..', '..', 'profiles')
    if (existsSync(bundled)) return bundled
  } catch {
    // Unresolvable in this environment — fall through to the local path.
  }
  return local
}

function readTokenFile(dataDir: string): string | undefined {
  try {
    const raw = readFileSync(join(dataDir, 'gateway-token'), 'utf-8').trim()
    return raw === '' ? undefined : raw
  } catch {
    return undefined
  }
}

/**
 * Probe for an ALREADY-RUNNING local gateway (an `ownware serve` on the
 * standard port) so a second one isn't booted alongside it.
 *
 * Envelope: plain-HTTP loopback only (`serve` with TLS off /
 * `OWNWARE_GATEWAY_TLS=0`). A TLS gateway with its self-signed loopback
 * cert is NOT probed — verifying it needs the pinned fingerprint, and a
 * silent insecure fallback would be worse than booting our own.
 */
export async function probeLocalGateway(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  port?: number,
): Promise<{ baseUrl: string; token: string | undefined } | null> {
  const probePort = port ?? (Number(env['OWNWARE_GATEWAY_PORT'] ?? '') || 3011)
  const baseUrl = `http://127.0.0.1:${probePort}`
  try {
    const res = await fetch(`${baseUrl}/api/v1/health`, {
      signal: AbortSignal.timeout(400),
    })
    if (!res.ok) return null
    return { baseUrl, token: env['OWNWARE_GATEWAY_TOKEN'] ?? readTokenFile(dataDir) }
  } catch {
    return null
  }
}

export async function ensureGateway(opts: EnsureGatewayOptions): Promise<GatewayHandle> {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const dataDir = opts.dataDir ?? defaultDataDir(env)

  const attachUrl = opts.baseUrl ?? env['OWNWARE_BASE_URL']
  if (attachUrl !== undefined && attachUrl !== '') {
    const token = opts.token ?? env['OWNWARE_GATEWAY_TOKEN'] ?? readTokenFile(dataDir)
    return {
      baseUrl: attachUrl.replace(/\/+$/, ''),
      token,
      dataDir,
      owned: false,
      close: async () => {},
    }
  }

  // A gateway already serving locally? Attach — never boot a twin.
  const running = await probeLocalGateway(dataDir, env)
  if (running !== null) {
    return {
      baseUrl: running.baseUrl,
      token: running.token,
      dataDir,
      owned: false,
      close: async () => {},
    }
  }

  // Under Bun the gateway cannot run in-process (cortex needs
  // better-sqlite3, a Node-only native addon) — spawn it under node.
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
    return spawnNodeGateway(opts, dataDir, cwd)
  }

  // The transcript is the product: everything the in-process gateway
  // logs goes to a file, from before the cortex import (module init
  // logs too) until the CLI shuts the gateway down.
  const logFile = join(dataDir, 'cli', 'gateway.log')
  const restoreConsole = redirectConsoleToFile(logFile)
  try {
    const { OwnwareGateway } = await import('@ownware/cortex')
    const gateway = new OwnwareGateway({
      port: 0,
      profilesDir: opts.profilesDir ?? resolveProfilesDir(cwd),
      dataDir,
      tls: false,
    })
    await gateway.start()
    return {
      baseUrl: `http://127.0.0.1:${gateway.port}`,
      token: gateway.token,
      dataDir,
      owned: true,
      logFile,
      close: async () => {
        try {
          await gateway.stop()
        } finally {
          restoreConsole()
        }
      },
    }
  } catch (err) {
    restoreConsole()
    throw err
  }
}

/**
 * Spawn the gateway as a `node` child (see `gateway-child.ts` for why).
 * The child prints one JSON handshake line, then serves until SIGTERM.
 */
async function spawnNodeGateway(
  opts: EnsureGatewayOptions,
  dataDir: string,
  cwd: string,
): Promise<GatewayHandle> {
  const { spawn } = await import('node:child_process')
  const logFile = join(dataDir, 'cli', 'gateway.log')
  const childEntry = fileURLToPath(new URL('./gateway-child.js', import.meta.url))

  const child = spawn('node', [childEntry], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OWNWARE_CHILD_PROFILES_DIR: opts.profilesDir ?? resolveProfilesDir(cwd),
      OWNWARE_CHILD_DATA_DIR: dataDir,
      OWNWARE_CHILD_LOG_FILE: logFile,
    },
  })

  const handshake = await new Promise<{ port: number; token: string }>(
    (resolveHandshake, rejectHandshake) => {
      let stdoutBuf = ''
      let stderrBuf = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        rejectHandshake(new Error('gateway did not start within 30s'))
      }, 30_000)
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf-8')
        const newline = stdoutBuf.indexOf('\n')
        if (newline === -1) return
        clearTimeout(timer)
        try {
          resolveHandshake(JSON.parse(stdoutBuf.slice(0, newline)) as { port: number; token: string })
        } catch {
          rejectHandshake(new Error(`bad gateway handshake: ${stdoutBuf.slice(0, newline)}`))
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf-8')
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        rejectHandshake(
          new Error(`gateway exited before it was ready (code ${code}): ${stderrBuf.trim()}`),
        )
      })
    },
  )

  return {
    baseUrl: `http://127.0.0.1:${handshake.port}`,
    token: handshake.token,
    dataDir,
    owned: true,
    logFile,
    close: () =>
      new Promise<void>((resolveClose) => {
        if (child.exitCode !== null) {
          resolveClose()
          return
        }
        const force = setTimeout(() => {
          child.kill('SIGKILL')
          resolveClose()
        }, 5_000)
        child.once('exit', () => {
          clearTimeout(force)
          resolveClose()
        })
        child.kill('SIGTERM')
      }),
  }
}
