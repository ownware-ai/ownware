/**
 * Chrome launcher — spawns a Chromium-family browser with CDP enabled.
 *
 * The launcher is deliberately minimal: find an executable, spawn it with
 * the right flags, poll `/json/version` until CDP answers, and expose a
 * `stop()` that does SIGTERM → wait → SIGKILL. Ownership of the returned
 * process rests with the caller — this library does NOT register any
 * global shutdown hook. Callers that need "kill on gateway stop" wire
 * that in their own shutdown path.
 *
 * Design choices:
 *   - HTTP-only readiness probe (hit `/json/version`). No WebSocket
 *     handshake — we rely on callers (Playwright) to negotiate CDP. This
 *     keeps the launcher free of a `ws` dependency.
 *   - Isolated `--user-data-dir`. Spawned Chrome never touches the user's
 *     real profile. Caller may override; default is a fresh temp dir.
 *   - Ephemeral port by default. Caller may pin a specific port.
 *   - Stderr is captured only during the ready window; once CDP is up, we
 *     detach the listener so a long-running Chrome doesn't fill memory
 *     with periodic warnings.
 *
 * Portions of the launch-args layout and the SIGTERM→SIGKILL fallback
 * pattern are derived from openclaw/extensions/browser
 * (https://github.com/openclaw, MIT, Copyright (c) 2025 Peter Steinberger).
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import fs from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import {
  findBrowserExecutable,
  type BrowserExecutable,
} from './executables.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const LaunchChromeOptionsSchema = z
  .object({
    /**
     * CDP port to bind on 127.0.0.1. If omitted an ephemeral free port is
     * allocated. Pinning is useful for DevTools attach workflows.
     */
    port: z.number().int().min(1).max(65_535).optional(),
    /**
     * Isolated user-data directory. Must not be shared with a real Chrome
     * profile — running two Chrome instances against the same profile
     * dir corrupts state. Defaults to a fresh temp dir that survives the
     * process; callers may reuse a stable dir to preserve login state.
     */
    userDataDir: z.string().min(1).optional(),
    /**
     * Explicit executable path. When set, skips auto-detection. Throws if
     * the path does not exist.
     */
    executablePath: z.string().min(1).optional(),
    /** Headless (new Chromium headless mode). Default: false. */
    headless: z.boolean().optional(),
    /**
     * Disable the Chromium sandbox. Only useful in rootless containers;
     * setting this on a dev machine is a security regression. Default: false.
     */
    noSandbox: z.boolean().optional(),
    /**
     * Additional raw Chromium flags. Appended as-is; caller is responsible
     * for well-formedness.
     */
    extraArgs: z.array(z.string()).readonly().optional(),
    /**
     * Total time to wait for CDP to become reachable after spawn, in
     * milliseconds. Default: 15 seconds. The poll interval is fixed at
     * 100 ms.
     */
    readyTimeoutMs: z.number().int().min(500).max(120_000).optional(),
    /**
     * Optional logger — defaults to no-op. Used for launch diagnostics
     * only; never receives payload data.
     */
    log: z
      .function()
      .args(z.string())
      .returns(z.void())
      .optional(),
  })
  .strict()

export type LaunchChromeOptions = z.input<typeof LaunchChromeOptionsSchema>

/**
 * Handle returned by `launchChrome`. All fields are readonly; lifecycle
 * is controlled entirely through `stop`.
 */
export interface RunningChrome {
  readonly cdpUrl: string
  readonly pid: number
  readonly port: number
  readonly executable: BrowserExecutable
  readonly userDataDir: string
  readonly userDataDirIsTemporary: boolean
  readonly startedAt: number
  /**
   * Terminate the child process. Idempotent — safe to call multiple times.
   *
   * Sequence:
   *   1. SIGTERM.
   *   2. Wait up to `timeoutMs` (default 5s) for the process to exit or
   *      for CDP to go away.
   *   3. SIGKILL if still alive.
   *
   * Returns when the process has exited (or the best-effort SIGKILL has
   * been issued). Never throws; any error during kill is swallowed —
   * by the time `stop` is called, the caller has committed to tearing
   * down the process.
   */
  readonly stop: (timeoutMs?: number) => Promise<void>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_READY_TIMEOUT_MS = 15_000
const READY_POLL_INTERVAL_MS = 100
const REACHABILITY_FETCH_TIMEOUT_MS = 1500
const DEFAULT_STOP_TIMEOUT_MS = 5_000
const STOP_POLL_INTERVAL_MS = 100
const STDERR_HINT_MAX_CHARS = 4_000
const MAX_STDERR_BUFFER_BYTES = 256 * 1024

// ---------------------------------------------------------------------------
// Port helpers
// ---------------------------------------------------------------------------

/**
 * Bind to port 0 on 127.0.0.1 to let the OS pick a free ephemeral port,
 * then close the server and return the port. There is a small race window
 * between release and the subsequent spawn; if that window loses, the
 * spawn's CDP readiness check times out and the caller sees a clear
 * "Chrome failed to come up" error with stderr attached.
 */
export async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        const { port } = addr
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('Failed to allocate a free port')))
      }
    })
  })
}

/**
 * Verify a port is currently free on 127.0.0.1. Throws if the port is
 * already bound by another process. Best-effort: there is a race between
 * this check and the subsequent spawn, but the concrete failure mode
 * (Chrome fails to bind → CDP never answers → timeout with stderr) is
 * surfaced loudly to the caller, not silently swallowed.
 */
export async function assertPortFree(port: number): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use on 127.0.0.1`))
      } else {
        reject(err)
      }
    })
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve())
    })
  })
}

// ---------------------------------------------------------------------------
// CDP reachability
// ---------------------------------------------------------------------------

/**
 * Probe `GET /json/version` against a CDP endpoint and return true iff
 * the response is a JSON object. Used to decide when Chrome is ready to
 * accept client connections.
 */
export async function isChromeReachable(
  cdpUrl: string,
  timeoutMs = REACHABILITY_FETCH_TIMEOUT_MS,
): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const url = cdpUrl.replace(/\/+$/, '') + '/json/version'
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return false
    const body = (await res.json()) as unknown
    return Boolean(body && typeof body === 'object')
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Launch args
// ---------------------------------------------------------------------------

export interface BuildLaunchArgsParams {
  readonly port: number
  readonly userDataDir: string
  readonly headless: boolean
  readonly noSandbox: boolean
  readonly extraArgs: readonly string[]
  readonly platform: NodeJS.Platform
}

/**
 * Build the Chromium flag list for a launcher-managed instance. The flags
 * suppress first-run dialogs, background network activity, crash-restore
 * bubbles, and translation/sync — these make sense for an automated,
 * isolated profile but would be wrong on a user's real Chrome.
 */
export function buildLaunchArgs(params: BuildLaunchArgsParams): string[] {
  const { port, userDataDir, headless, noSandbox, extraArgs, platform } = params
  const args: string[] = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--password-store=basic',
  ]

  if (headless) {
    args.push('--headless=new')
    args.push('--disable-gpu')
  }
  if (noSandbox) {
    args.push('--no-sandbox')
    args.push('--disable-setuid-sandbox')
  }
  if (platform === 'linux') {
    // /dev/shm is typically tiny in containers; Chrome will crash without this.
    args.push('--disable-dev-shm-usage')
  }
  if (extraArgs.length > 0) {
    args.push(...extraArgs)
  }
  return args
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/**
 * Launch a Chromium-family browser with CDP enabled, wait for it to
 * become reachable, and return a handle. Throws if no executable can be
 * found, if the requested port is busy, or if CDP never comes up within
 * `readyTimeoutMs`.
 */
export async function launchChrome(
  options: LaunchChromeOptions = {},
): Promise<RunningChrome> {
  const opts = LaunchChromeOptionsSchema.parse(options)
  const log = opts.log ?? ((_msg: string): void => {})

  // 1. Resolve an executable. Throws with a clear message if not found.
  const executable = findBrowserExecutable({
    executablePath: opts.executablePath,
  })
  if (!executable) {
    throw new Error(
      'No supported browser found. Install Google Chrome, Brave, Edge, or Chromium, ' +
        'or pass `executablePath` to launchChrome().',
    )
  }

  // 2. Resolve a port. Pinned → verify free; ephemeral → allocate one.
  let port: number
  if (opts.port !== undefined) {
    await assertPortFree(opts.port)
    port = opts.port
  } else {
    port = await findFreePort()
  }

  // 3. Resolve user-data dir. Default is a fresh temp dir owned by us.
  let userDataDir: string
  let userDataDirIsTemporary: boolean
  if (opts.userDataDir) {
    userDataDir = opts.userDataDir
    userDataDirIsTemporary = false
    fs.mkdirSync(userDataDir, { recursive: true })
  } else {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-chrome-'))
    userDataDirIsTemporary = true
  }

  const headless = opts.headless ?? false
  const noSandbox = opts.noSandbox ?? false
  const extraArgs = opts.extraArgs ?? []
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const cdpUrl = `http://127.0.0.1:${port}`

  const args = buildLaunchArgs({
    port,
    userDataDir,
    headless,
    noSandbox,
    extraArgs,
    platform: process.platform,
  })

  log(`[browser-launcher] spawning ${executable.kind} at ${executable.path}`)

  // 4. Spawn. Inherit env but reset HOME so Chrome doesn't pick up stray
  //    settings from a shell override. Stdout is ignored (buffers would
  //    fill in constrained environments); stderr is piped for diagnostics.
  const proc = spawn(executable.path, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      HOME: os.homedir(),
    },
  }) as ChildProcessByStdio<null, null, Readable>
  const startedAt = Date.now()

  // Collect a bounded amount of stderr while we wait for CDP. If Chrome
  // refuses to start we surface this in the error message. Cap the buffer
  // to avoid unbounded memory growth from a misbehaving child.
  let stderrBuffer = ''
  let stderrTruncated = false
  const onStderr = (chunk: Buffer): void => {
    if (stderrTruncated) return
    if (stderrBuffer.length + chunk.length > MAX_STDERR_BUFFER_BYTES) {
      stderrBuffer += chunk.toString('utf8', 0, MAX_STDERR_BUFFER_BYTES - stderrBuffer.length)
      stderrTruncated = true
    } else {
      stderrBuffer += chunk.toString('utf8')
    }
  }
  proc.stderr.on('data', onStderr)

  // Track early exits so we can fail fast if the child dies before CDP
  // comes up (wrong flags, missing dependencies, etc.).
  let earlyExitCode: number | null = null
  let earlyExitSignal: NodeJS.Signals | null = null
  proc.once('exit', (code, signal) => {
    earlyExitCode = code
    earlyExitSignal = signal
  })

  // Also trap unhandled ECHILD / unspawnable cases.
  proc.once('error', err => {
    log(`[browser-launcher] spawn error: ${String(err)}`)
  })

  // 5. Poll CDP until reachable or we exhaust the window.
  const readyDeadline = startedAt + readyTimeoutMs
  let ready = false
  while (Date.now() < readyDeadline) {
    if (earlyExitCode !== null || earlyExitSignal !== null) break
    if (await isChromeReachable(cdpUrl)) {
      ready = true
      break
    }
    await sleep(READY_POLL_INTERVAL_MS)
  }

  // Double-check after the loop — the last poll may have raced with startup.
  if (!ready && earlyExitCode === null && earlyExitSignal === null) {
    ready = await isChromeReachable(cdpUrl)
  }

  if (!ready) {
    // Kill the half-started process before raising. We issue SIGKILL
    // directly (not SIGTERM) because by definition Chrome is not
    // responsive — there is no clean shutdown to wait for.
    try {
      proc.kill('SIGKILL')
    } catch {
      // Already dead or unsignalable — nothing else to do.
    }
    if (userDataDirIsTemporary) {
      safelyRemoveDir(userDataDir)
    }
    const hints: string[] = []
    if (earlyExitCode !== null) hints.push(`child exited with code ${earlyExitCode}`)
    if (earlyExitSignal !== null) hints.push(`child received ${earlyExitSignal}`)
    if (process.platform === 'linux' && !noSandbox) {
      hints.push(
        'If running in a container or as root, pass `noSandbox: true` to launchChrome.',
      )
    }
    const stderrHint = formatStderrHint(stderrBuffer, stderrTruncated)
    const hintBlock = hints.length > 0 ? `\n  - ${hints.join('\n  - ')}` : ''
    throw new Error(
      `Failed to connect to Chrome CDP on ${cdpUrl} within ${readyTimeoutMs}ms.` +
        hintBlock +
        stderrHint,
    )
  }

  // 6. Detach the stderr listener and drop the buffer — at this point
  //    Chrome is serving CDP, and we don't want ongoing warnings to
  //    accumulate in memory.
  proc.stderr.off('data', onStderr)
  stderrBuffer = ''

  log(
    `[browser-launcher] ${executable.kind} ready at ${cdpUrl} (pid ${proc.pid ?? -1})`,
  )

  // 7. Build the lifecycle handle. `stop` is idempotent: it records the
  //    first invocation and resolves the same promise on subsequent calls.
  let stopPromise: Promise<void> | null = null
  const running: RunningChrome = {
    cdpUrl,
    pid: proc.pid ?? -1,
    port,
    executable,
    userDataDir,
    userDataDirIsTemporary,
    startedAt,
    stop: (timeoutMs?: number): Promise<void> => {
      if (!stopPromise) {
        stopPromise = stopChromeProcess(proc, cdpUrl, timeoutMs).finally(() => {
          if (userDataDirIsTemporary) {
            safelyRemoveDir(userDataDir)
          }
        })
      }
      return stopPromise
    },
  }

  return running
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

async function stopChromeProcess(
  proc: ChildProcessByStdio<null, null, Readable>,
  cdpUrl: string,
  timeoutMs: number = DEFAULT_STOP_TIMEOUT_MS,
): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return

  try {
    proc.kill('SIGTERM')
  } catch {
    // Either already gone, or we lack permission — fall through to the
    // wait loop, which will escalate to SIGKILL on timeout.
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    // CDP going silent is a reliable "Chrome is shutting down" signal
    // even before the child fully exits. Short probe timeout so we
    // don't waste the whole stop window on a single fetch.
    if (!(await isChromeReachable(cdpUrl, 400))) return
    await sleep(STOP_POLL_INTERVAL_MS)
  }

  try {
    proc.kill('SIGKILL')
  } catch {
    // Nothing more we can do — the process will be reaped by the OS.
  }

  // Brief settle window so the caller's `await stop()` reflects actual
  // process exit, not just "we sent the signal." Capped so a zombie
  // child cannot hang shutdown forever.
  const settleDeadline = Date.now() + 500
  while (Date.now() < settleDeadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    await sleep(25)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function safelyRemoveDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 })
  } catch {
    // Temp-dir cleanup is best-effort: a locked file in the profile is
    // annoying but not worth failing a shutdown path over.
  }
}

// ---------------------------------------------------------------------------
// Deferred launcher
// ---------------------------------------------------------------------------

/**
 * A memoized, on-demand Chrome supervisor. Designed for consumers that
 * want Chrome to spawn only when a browser tool is actually called —
 * not eagerly at session start.
 *
 * Construction is cheap: it does NOT launch Chrome. The first `getCdpUrl()`
 * call triggers `launchChrome()` and caches the returned handle. All
 * subsequent callers (including concurrent ones) share that single launch
 * attempt. If the attempt fails, the rejection is cached too — we fail
 * loudly on every subsequent browser tool rather than silently retrying
 * and risking dozens of orphan Chrome processes.
 *
 * Lifetime: the caller owns `stop()` and MUST call it on session teardown.
 * Calling `stop()` before any `getCdpUrl()` is a no-op (nothing was ever
 * launched).
 */
export interface DeferredChromeLauncher {
  /**
   * Returns the CDP URL of a running Chrome. Spawns Chrome on first call;
   * returns the cached URL on subsequent calls. Rejects the same way on
   * every call if the first spawn failed.
   */
  getCdpUrl(): Promise<string>
  /**
   * Terminate the managed Chrome if one was started. Idempotent; safe to
   * call without a prior `getCdpUrl()`.
   */
  stop(timeoutMs?: number): Promise<void>
  /** True once Chrome has been spawned (regardless of success/failure). */
  isLaunched(): boolean
  /**
   * The `RunningChrome` handle once launch succeeded, else `null`. Useful
   * for gateways that want to expose the handle to other subsystems
   * (e.g. for metrics, or to fail a session summary on kill).
   */
  getRunning(): RunningChrome | null
}

export interface CreateDeferredChromeLauncherOptions {
  /** Options forwarded to `launchChrome` when the first caller arrives. */
  readonly launchOptions?: LaunchChromeOptions
  /**
   * Custom launcher. Defaults to the top-level `launchChrome`. Tests inject
   * a stub to assert lifecycle without spawning a real Chrome.
   */
  readonly launchFn?: (opts: LaunchChromeOptions) => Promise<RunningChrome>
  /**
   * Fired once when a successful launch happens. Use this to register the
   * `RunningChrome` with your own shutdown map BEFORE any caller sees the
   * URL — guarantees the handle is tracked even if the caller's Promise
   * chain aborts between receiving the URL and attempting a kill.
   */
  readonly onLaunched?: (running: RunningChrome) => void
}

export function createDeferredChromeLauncher(
  opts: CreateDeferredChromeLauncherOptions = {},
): DeferredChromeLauncher {
  const launchFn = opts.launchFn ?? launchChrome
  const launchOptions = opts.launchOptions ?? {}
  const onLaunched = opts.onLaunched

  let launchPromise: Promise<RunningChrome> | null = null
  let running: RunningChrome | null = null
  let launched = false
  let stopCalled = false
  let stopPromise: Promise<void> | null = null

  const ensure = (): Promise<RunningChrome> => {
    if (stopCalled) {
      return Promise.reject(
        new Error('Browser launcher has been stopped; create a new launcher to spawn again.'),
      )
    }
    if (launchPromise) return launchPromise
    launchPromise = (async () => {
      launched = true
      const r = await launchFn(launchOptions)
      running = r
      // Announce BEFORE the caller awaiting us resumes, so the gateway
      // has the handle in its kill map even if our caller immediately
      // drops the Promise.
      if (onLaunched) {
        try { onLaunched(r) } catch {
          // A broken onLaunched hook must not leak the launched Chrome.
          // Tear it down and surface a clear error to the caller.
          void r.stop().catch(() => {})
          throw new Error('Browser launcher onLaunched hook threw — managed Chrome was stopped to avoid leak.')
        }
      }
      return r
    })()
    // Cache the rejection too: we do NOT retry silently, because a second
    // attempt would need a fresh port + userDataDir and could silently
    // double-spawn if the first attempt is actually succeeding slowly.
    return launchPromise
  }

  return {
    getCdpUrl: async () => {
      const r = await ensure()
      return r.cdpUrl
    },
    stop: async (timeoutMs?: number): Promise<void> => {
      if (stopPromise) return stopPromise
      stopCalled = true
      if (!launched) {
        stopPromise = Promise.resolve()
        return stopPromise
      }
      stopPromise = (async () => {
        // Wait for the in-flight launch to settle before trying to kill.
        // If it's still running we want to kill the real process; if it
        // rejected there's nothing to kill.
        try {
          await launchPromise
        } catch {
          return
        }
        if (running) {
          await running.stop(timeoutMs)
        }
      })()
      return stopPromise
    },
    isLaunched: () => launched,
    getRunning: () => running,
  }
}

function formatStderrHint(buffer: string, truncated: boolean): string {
  const trimmed = buffer.trim()
  if (!trimmed) return ''
  const slice = trimmed.slice(0, STDERR_HINT_MAX_CHARS)
  const tail = truncated || trimmed.length > STDERR_HINT_MAX_CHARS ? '\n[stderr truncated]' : ''
  return `\nChrome stderr:\n${slice}${tail}`
}
