/**
 * Unit tests for browser-launcher/launcher.ts
 *
 * Covers the pieces that don't require spawning Chrome:
 *   - schema validation
 *   - port allocation + availability probe
 *   - Chromium flag construction
 *   - CDP reachability probe (against a minimal HTTP stub)
 *   - launchChrome's early-failure paths (missing executable, early exit)
 *
 * A live-Chrome end-to-end test lives under __tests__/integration/.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createServer } from 'node:net'
import {
  buildLaunchArgs,
  isChromeReachable,
  findFreePort,
  assertPortFree,
  launchChrome,
  LaunchChromeOptionsSchema,
  createDeferredChromeLauncher,
} from '../../../browser-launcher/launcher.js'
import type { RunningChrome } from '../../../browser-launcher/launcher.js'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('LaunchChromeOptionsSchema', () => {
  it('accepts a fully populated payload', () => {
    const parsed = LaunchChromeOptionsSchema.parse({
      port: 9333,
      userDataDir: '/tmp/foo',
      executablePath: '/bin/true',
      headless: true,
      noSandbox: false,
      extraArgs: ['--mute-audio'],
      readyTimeoutMs: 5_000,
    })
    expect(parsed.port).toBe(9333)
    expect(parsed.headless).toBe(true)
  })

  it('accepts an empty object (everything optional)', () => {
    expect(() => LaunchChromeOptionsSchema.parse({})).not.toThrow()
  })

  it('rejects a port outside the valid range', () => {
    expect(() => LaunchChromeOptionsSchema.parse({ port: 0 })).toThrow()
    expect(() => LaunchChromeOptionsSchema.parse({ port: 70_000 })).toThrow()
  })

  it('rejects a negative readyTimeoutMs', () => {
    expect(() => LaunchChromeOptionsSchema.parse({ readyTimeoutMs: -1 })).toThrow()
  })

  it('rejects unknown fields (.strict)', () => {
    expect(() =>
      LaunchChromeOptionsSchema.parse({ unknownField: true }),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// buildLaunchArgs
// ---------------------------------------------------------------------------

describe('buildLaunchArgs', () => {
  const base = {
    port: 9222,
    userDataDir: '/tmp/test-profile',
    headless: false,
    noSandbox: false,
    extraArgs: [] as readonly string[],
    platform: 'darwin' as NodeJS.Platform,
  }

  it('includes the core CDP + profile flags', () => {
    const args = buildLaunchArgs(base)
    expect(args).toContain('--remote-debugging-port=9222')
    expect(args).toContain('--user-data-dir=/tmp/test-profile')
    expect(args).toContain('--no-first-run')
    expect(args).toContain('--no-default-browser-check')
    expect(args).toContain('--disable-sync')
  })

  it('adds headless flags when headless is true', () => {
    const args = buildLaunchArgs({ ...base, headless: true })
    expect(args).toContain('--headless=new')
    expect(args).toContain('--disable-gpu')
  })

  it('omits headless flags when headless is false', () => {
    const args = buildLaunchArgs(base)
    expect(args).not.toContain('--headless=new')
  })

  it('adds sandbox-disable flags when noSandbox is true', () => {
    const args = buildLaunchArgs({ ...base, noSandbox: true })
    expect(args).toContain('--no-sandbox')
    expect(args).toContain('--disable-setuid-sandbox')
  })

  it('adds /dev/shm workaround on linux only', () => {
    const linuxArgs = buildLaunchArgs({ ...base, platform: 'linux' })
    expect(linuxArgs).toContain('--disable-dev-shm-usage')
    const macArgs = buildLaunchArgs({ ...base, platform: 'darwin' })
    expect(macArgs).not.toContain('--disable-dev-shm-usage')
  })

  it('appends extraArgs verbatim in order', () => {
    const args = buildLaunchArgs({
      ...base,
      extraArgs: ['--mute-audio', '--lang=en-US'],
    })
    expect(args.slice(-2)).toEqual(['--mute-audio', '--lang=en-US'])
  })
})

// ---------------------------------------------------------------------------
// findFreePort / assertPortFree
// ---------------------------------------------------------------------------

describe('findFreePort', () => {
  it('returns a port in the valid ephemeral range', async () => {
    const port = await findFreePort()
    expect(port).toBeGreaterThan(1024)
    expect(port).toBeLessThan(65_536)
  })

  it('returns different ports across calls (probabilistic)', async () => {
    const ports = new Set<number>()
    for (let i = 0; i < 5; i += 1) {
      ports.add(await findFreePort())
    }
    // We cannot guarantee uniqueness, but getting ≥2 distinct values is
    // overwhelmingly likely in any healthy environment.
    expect(ports.size).toBeGreaterThanOrEqual(2)
  })
})

describe('assertPortFree', () => {
  it('resolves when the port is not in use', async () => {
    const port = await findFreePort()
    await expect(assertPortFree(port)).resolves.toBeUndefined()
  })

  it('rejects with a clear message when the port is bound', async () => {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    if (!addr || typeof addr !== 'object') {
      server.close()
      throw new Error('unexpected server address shape')
    }
    const port = addr.port
    try {
      await expect(assertPortFree(port)).rejects.toThrow(/already in use/)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

// ---------------------------------------------------------------------------
// isChromeReachable
// ---------------------------------------------------------------------------

describe('isChromeReachable', () => {
  it('returns false for an unreachable endpoint', async () => {
    const port = await findFreePort()
    const result = await isChromeReachable(`http://127.0.0.1:${port}`, 400)
    expect(result).toBe(false)
  })

  it('returns true when /json/version responds with a JSON object', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ Browser: 'Stub/1.0', webSocketDebuggerUrl: 'ws://x' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('no port assigned'))
      })
    })
    try {
      const ok = await isChromeReachable(`http://127.0.0.1:${port}`, 2_000)
      expect(ok).toBe(true)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('returns false on a non-JSON response', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('not json')
    })
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('no port assigned'))
      })
    })
    try {
      const ok = await isChromeReachable(`http://127.0.0.1:${port}`, 2_000)
      expect(ok).toBe(false)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

// ---------------------------------------------------------------------------
// launchChrome — error paths
// ---------------------------------------------------------------------------

function locateTrueBinary(): string | null {
  for (const candidate of ['/usr/bin/true', '/bin/true']) {
    if (fs.existsSync(candidate)) return candidate
  }
  try {
    const out = execFileSync('/usr/bin/which', ['true'], {
      encoding: 'utf8',
      timeout: 1_000,
    })
      .trim()
    return out || null
  } catch {
    return null
  }
}

describe('launchChrome — error paths', () => {
  it('throws when executablePath points to a missing file', async () => {
    await expect(
      launchChrome({
        executablePath: '/__loom__/definitely/not/a/real/binary',
        readyTimeoutMs: 500,
      }),
    ).rejects.toThrow(/executablePath not found/)
  })

  it('throws when the spawned executable exits immediately', async () => {
    // Use `true` as a stand-in for "a binary that doesn't serve CDP."
    // The path varies by OS (macOS: /usr/bin/true, many Linux: /bin/true),
    // so look it up dynamically. Skip on Windows where no equivalent
    // ships by default.
    if (process.platform === 'win32') return
    const trueBin = locateTrueBinary()
    if (!trueBin) return // No suitable stand-in on this runner.
    await expect(
      launchChrome({
        executablePath: trueBin,
        readyTimeoutMs: 800,
      }),
    ).rejects.toThrow(/Failed to connect to Chrome CDP/)
  })
})

// ---------------------------------------------------------------------------
// createDeferredChromeLauncher
// ---------------------------------------------------------------------------

describe('createDeferredChromeLauncher', () => {
  /**
   * A fake `RunningChrome` that tracks `stop()` invocations. Used instead
   * of spawning a real Chrome so the lazy/race/error semantics can be
   * tested deterministically in microseconds.
   */
  function makeFakeRunning(overrides: { throwOnStop?: boolean } = {}) {
    let stopCalls = 0
    const r: RunningChrome = {
      cdpUrl: 'http://127.0.0.1:65000',
      pid: 1234,
      port: 65000,
      executable: { kind: 'chrome', path: '/fake/chrome' },
      userDataDir: '/tmp/fake',
      userDataDirIsTemporary: true,
      startedAt: Date.now(),
      stop: async () => {
        stopCalls += 1
        if (overrides.throwOnStop) throw new Error('simulated kill fail')
      },
    }
    return { running: r, getStopCalls: () => stopCalls }
  }

  it('does NOT call launchFn until getCdpUrl() is invoked', async () => {
    let calls = 0
    const launcher = createDeferredChromeLauncher({
      launchFn: async () => {
        calls += 1
        return makeFakeRunning().running
      },
    })
    expect(calls).toBe(0)
    expect(launcher.isLaunched()).toBe(false)
    expect(launcher.getRunning()).toBeNull()
  })

  it('launches on first getCdpUrl(), returns the URL', async () => {
    const { running } = makeFakeRunning()
    let calls = 0
    const launcher = createDeferredChromeLauncher({
      launchFn: async () => {
        calls += 1
        return running
      },
    })
    await expect(launcher.getCdpUrl()).resolves.toBe('http://127.0.0.1:65000')
    expect(calls).toBe(1)
    expect(launcher.isLaunched()).toBe(true)
    expect(launcher.getRunning()).toBe(running)
  })

  it('memoizes the launch — concurrent callers share one spawn', async () => {
    let calls = 0
    const launcher = createDeferredChromeLauncher({
      launchFn: async () => {
        calls += 1
        await new Promise(r => setTimeout(r, 10))
        return makeFakeRunning().running
      },
    })
    const [a, b, c] = await Promise.all([
      launcher.getCdpUrl(),
      launcher.getCdpUrl(),
      launcher.getCdpUrl(),
    ])
    expect(calls).toBe(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('caches launch rejection — does NOT silently retry', async () => {
    let calls = 0
    const launcher = createDeferredChromeLauncher({
      launchFn: async () => {
        calls += 1
        throw new Error('nope')
      },
    })
    await expect(launcher.getCdpUrl()).rejects.toThrow('nope')
    await expect(launcher.getCdpUrl()).rejects.toThrow('nope')
    expect(calls).toBe(1)
  })

  it('fires onLaunched exactly once before resolving callers', async () => {
    const { running } = makeFakeRunning()
    let hookCalls = 0
    let hookRunning: RunningChrome | null = null
    const launcher = createDeferredChromeLauncher({
      launchFn: async () => running,
      onLaunched: r => {
        hookCalls += 1
        hookRunning = r
      },
    })
    await launcher.getCdpUrl()
    await launcher.getCdpUrl()
    expect(hookCalls).toBe(1)
    expect(hookRunning).toBe(running)
  })

  it('kills the just-launched Chrome if onLaunched throws', async () => {
    const { running, getStopCalls } = makeFakeRunning()
    const launcher = createDeferredChromeLauncher({
      launchFn: async () => running,
      onLaunched: () => {
        throw new Error('hook failure')
      },
    })
    // The caller sees the wrapped error.
    await expect(launcher.getCdpUrl()).rejects.toThrow(/onLaunched hook threw/)
    // ... and the launched Chrome did NOT leak.
    // stop() is fire-and-forget inside the hook handler; give it a tick.
    await new Promise(r => setImmediate(r))
    expect(getStopCalls()).toBe(1)
  })

  it('stop() is a no-op when getCdpUrl() was never called', async () => {
    let calls = 0
    const launcher = createDeferredChromeLauncher({
      launchFn: async () => {
        calls += 1
        return makeFakeRunning().running
      },
    })
    await launcher.stop()
    expect(calls).toBe(0)
    expect(launcher.isLaunched()).toBe(false)
  })

  it('stop() kills the launched Chrome and is idempotent', async () => {
    const { running, getStopCalls } = makeFakeRunning()
    const launcher = createDeferredChromeLauncher({
      launchFn: async () => running,
    })
    await launcher.getCdpUrl()
    await launcher.stop()
    await launcher.stop()
    expect(getStopCalls()).toBe(1)
  })

  it('getCdpUrl() after stop() rejects — no respawn', async () => {
    let calls = 0
    const launcher = createDeferredChromeLauncher({
      launchFn: async () => {
        calls += 1
        return makeFakeRunning().running
      },
    })
    await launcher.stop()
    await expect(launcher.getCdpUrl()).rejects.toThrow(/has been stopped/)
    expect(calls).toBe(0)
  })

  it('stop() during in-flight launch waits for launch to settle then kills', async () => {
    const { running, getStopCalls } = makeFakeRunning()
    let resolveLaunch!: (v: RunningChrome) => void
    const launcher = createDeferredChromeLauncher({
      launchFn: () =>
        new Promise<RunningChrome>(resolve => {
          resolveLaunch = resolve
        }),
    })
    const urlP = launcher.getCdpUrl()
    const stopP = launcher.stop()
    resolveLaunch(running)
    await urlP
    await stopP
    expect(getStopCalls()).toBe(1)
  })
})
