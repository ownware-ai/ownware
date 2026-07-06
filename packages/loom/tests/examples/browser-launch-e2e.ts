/**
 * End-to-end smoke for the browser launcher.
 *
 *   bunx tsx examples/browser-launch-e2e.ts "your search query"
 *
 * Launches a real Chrome via the Loom launcher, drives it with
 * playwright-core, runs a DuckDuckGo search (no cookie prompt, no
 * captcha gate), captures the top results, and saves a screenshot.
 *
 * Default: windowed. Pass --headless to run invisibly.
 *
 * This script exists to prove the launcher end-to-end against a real
 * browser — it is NOT part of the production path.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { launchChrome } from '../src/browser-launcher/index.js'

const DEFAULT_QUERY = 'cortex agent operating system'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const headless = args.includes('--headless')
  const query =
    args.filter(a => !a.startsWith('--')).join(' ').trim() || DEFAULT_QUERY

  log(`[e2e] launching Chrome (headless=${headless})`)
  const running = await launchChrome({
    headless,
    readyTimeoutMs: 30_000,
    log: msg => log(msg),
  })
  log(`[e2e] Chrome ready:`)
  log(`       pid=${running.pid}`)
  log(`       cdp=${running.cdpUrl}`)
  log(`       userDataDir=${running.userDataDir}`)
  log(`       executable=${running.executable.kind} (${running.executable.path})`)

  let exitCode = 0
  try {
    log(`[e2e] connecting playwright over CDP`)
    const browser = await chromium.connectOverCDP(running.cdpUrl, {
      timeout: 15_000,
    })

    // Chrome starts with one blank context + one blank page. Reuse both
    // to keep the demo resilient across Chromium versions.
    const contexts = browser.contexts()
    const context =
      contexts[0] ?? (await browser.newContext())
    const pages = context.pages()
    const page = pages[0] ?? (await context.newPage())

    const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
    log(`[e2e] navigating to ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })

    log(`[e2e] page loaded — title: ${JSON.stringify(await page.title())}`)
    log(`[e2e] final url:         ${page.url()}`)

    // DuckDuckGo's result anchors live under `[data-testid="result-title-a"]`.
    // Fall back to any h2-nested anchor if the test-id changes.
    await page
      .waitForSelector('[data-testid="result-title-a"], h2 a', { timeout: 15_000 })
      .catch(() => {
        log('[e2e] no results selector matched within 15s — continuing anyway')
      })

    const results = await page.$$eval(
      '[data-testid="result-title-a"], h2 a',
      (anchors: Element[]) =>
        anchors.slice(0, 5).map(a => {
          const el = a as HTMLAnchorElement
          return { title: (el.textContent ?? '').trim(), href: el.href }
        }),
    )

    if (results.length === 0) {
      log('[e2e] WARNING: no results parsed. Page may have blocked or changed layout.')
    } else {
      log(`[e2e] top ${results.length} results:`)
      for (const [i, r] of results.entries()) {
        log(`       ${i + 1}. ${r.title}`)
        log(`          ${r.href}`)
      }
    }

    // Ephemeral demo output goes under OS temp — not into the repo.
    // Production screenshot handling lives in the `browser_screenshot`
    // tool (returns base64 in metadata) and, later, Cortex persistence
    // under `~/.ownware/screenshots/<threadId>/`. This script only needs
    // a throwaway path so a human can eyeball that Chrome actually rendered.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-e2e-'))
    const screenshotPath = path.join(outDir, 'browser-launch-e2e.png')
    await page.screenshot({ path: screenshotPath, fullPage: false })
    log(`[e2e] screenshot saved to ${screenshotPath}`)

    // Disconnect Playwright WITHOUT calling browser.close(); that would
    // send `Browser.close` to the target which kills the Chrome process
    // out from under our launcher. We own the lifecycle — just drop
    // our client connection.
    await browser.close().catch(() => {
      // Playwright's disconnect/close on a CDP connection is best-effort;
      // the launcher's stop() is the authoritative kill path below.
    })
  } catch (err) {
    exitCode = 1
    log(`[e2e] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  } finally {
    log('[e2e] stopping Chrome')
    await running.stop(10_000)
    log('[e2e] done')
  }

  process.exit(exitCode)
}

function log(msg: string): void {
  process.stdout.write(`${msg}\n`)
}

main().catch(err => {
  process.stderr.write(
    `[e2e] UNCAUGHT: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  )
  process.exit(1)
})
