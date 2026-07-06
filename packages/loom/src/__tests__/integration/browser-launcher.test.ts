/**
 * Integration tests for browser-launcher.
 *
 * These tests spawn a real Chromium-family browser and connect to its
 * CDP endpoint. They are skipped automatically when no executable can
 * be found on the test runner (CI boxes without Chrome installed).
 *
 * All launches use an isolated temp user-data-dir, so these tests never
 * touch the developer's real Chrome profile.
 */

import { describe, it, expect } from 'vitest'
import os from 'node:os'
import {
  findBrowserExecutable,
  launchChrome,
  isChromeReachable,
} from '../../browser-launcher/index.js'

const executable = findBrowserExecutable()
const haveChrome = executable !== null

// Headless is mandatory in CI / no-DISPLAY environments; on Linux
// without a display server a windowed launch hangs forever.
const shouldRunHeadless =
  process.platform !== 'darwin' && !process.env.DISPLAY
    ? true
    : process.env.LOOM_BROWSER_LAUNCHER_HEADFUL === '1'
      ? false
      : true

describe.skipIf(!haveChrome)('launchChrome (live)', () => {
  it('launches, becomes CDP-reachable, and stops cleanly', async () => {
    const running = await launchChrome({
      headless: shouldRunHeadless,
      // Linux runners in containers typically need --no-sandbox.
      noSandbox: process.platform === 'linux',
      readyTimeoutMs: 30_000,
    })

    try {
      expect(running.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(running.pid).toBeGreaterThan(0)
      expect(running.userDataDirIsTemporary).toBe(true)
      expect(running.userDataDir.startsWith(os.tmpdir())).toBe(true)

      // CDP really answers.
      const reachable = await isChromeReachable(running.cdpUrl, 5_000)
      expect(reachable).toBe(true)
    } finally {
      await running.stop(10_000)
    }

    // After stop, CDP should no longer respond.
    const afterStop = await isChromeReachable(running.cdpUrl, 500)
    expect(afterStop).toBe(false)
  }, 60_000)

  it('stop() is idempotent', async () => {
    const running = await launchChrome({
      headless: shouldRunHeadless,
      noSandbox: process.platform === 'linux',
      readyTimeoutMs: 30_000,
    })
    await running.stop(10_000)
    // Second call must not throw, must resolve, and must not hang.
    await expect(running.stop(10_000)).resolves.toBeUndefined()
  }, 60_000)

  it('parallel launches get distinct ports', async () => {
    const [a, b] = await Promise.all([
      launchChrome({
        headless: shouldRunHeadless,
        noSandbox: process.platform === 'linux',
        readyTimeoutMs: 30_000,
      }),
      launchChrome({
        headless: shouldRunHeadless,
        noSandbox: process.platform === 'linux',
        readyTimeoutMs: 30_000,
      }),
    ])
    try {
      expect(a.port).not.toBe(b.port)
      expect(a.userDataDir).not.toBe(b.userDataDir)
    } finally {
      await Promise.allSettled([a.stop(10_000), b.stop(10_000)])
    }
  }, 90_000)
})
