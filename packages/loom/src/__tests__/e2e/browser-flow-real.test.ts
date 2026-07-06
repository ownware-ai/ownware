/**
 * Browser flow — real Chrome, real navigation, local HTTP fixture.
 *
 * Verifies the behavior claims of B1 (inline snapshot in every action
 * result) and B2 (auto-settle before snapshot) against a live Chrome
 * instance. No mock browser, no mock Playwright — actual CDP, actual
 * page transitions.
 *
 * Why a local HTTP fixture instead of `https://example.com`:
 * - The browser tools' SSRF guard correctly blocks `127.0.0.1`, so
 *   we drive the *setup* navigation through raw Playwright. The
 *   under-test path is `browser_snapshot` and `browser_click`, which
 *   never check SSRF.
 * - A local server gives deterministic page content, no flakiness
 *   from public-internet variability, and works in offline / no-DNS
 *   environments.
 *
 * Skipped when `playwright-core` isn't installed or no Chromium
 * binary is on disk, so CI without browser deps still passes.
 *
 * Run:
 *   npx vitest run src/__tests__/e2e/browser-flow-real.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'

import {
  browserClick,
  browserSnapshot,
  browserType,
  browserNavigate,
} from '../../tools/builtins/browser.js'
import {
  connectBrowser,
  getPage,
  trackPageState,
} from '../../tools/builtins/browser-session.js'
import { createDefaultConfig } from '../../core/config.js'
import {
  launchChrome,
  findBrowserExecutable,
  type RunningChrome,
} from '../../browser-launcher/index.js'
import type { ToolContext, ToolResult } from '../../tools/types.js'
import type { LoomConfig } from '../../core/config.js'

// ---------------------------------------------------------------------------
// Skip gating
// ---------------------------------------------------------------------------

const HAS_BROWSER = findBrowserExecutable() !== null

async function hasPlaywright(): Promise<boolean> {
  try {
    await import('playwright-core')
    return true
  } catch {
    return false
  }
}

const PW_PRESENT = await hasPlaywright()
const CAN_RUN = HAS_BROWSER && PW_PRESENT

if (!CAN_RUN) {
  console.log(
    `⏭ Skipping browser e2e — hasBrowser=${HAS_BROWSER} hasPlaywright=${PW_PRESENT}`,
  )
}

// ---------------------------------------------------------------------------
// Local HTTP fixture
// ---------------------------------------------------------------------------

const START_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Start Page</title></head>
  <body>
    <h1>Start Page</h1>
    <p>This is the starting fixture for the browser e2e harness.</p>
    <a href="/next" id="go">Continue to the next page</a>
  </body>
</html>`

const NEXT_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Next Page</title></head>
  <body>
    <h1>Next Page</h1>
    <p>If you can read this, the previous click navigated and settled.</p>
    <button id="acknowledge">Acknowledge</button>
  </body>
</html>`

/**
 * Activity fixture — clicking the button:
 *   1. Emits a console.error
 *   2. Fires a SYNCHRONOUS XHR to /missing returning 404
 *
 * Sync XHR is used (despite being deprecated for production sites)
 * because it guarantees the network response event has fired before
 * `locator.click()` returns. With async fetch, the response races
 * the post-action snapshot — sometimes the failure lands in the
 * action's activity block, sometimes in the next action's. That's
 * realistic browser behavior but it makes the test flaky. The B3
 * *semantics* are unchanged: any failure that has fired by the time
 * the post-action snapshot is taken is surfaced inline.
 */
const ACTIVITY_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Activity Page</title></head>
  <body>
    <h1>Activity Page</h1>
    <button id="break">Break things</button>
    <script>
      document.getElementById('break').addEventListener('click', () => {
        console.error('Stripe.js failed to load');
        const xhr = new XMLHttpRequest();
        // false = synchronous — guarantees the response fires before
        // the click handler returns.
        xhr.open('GET', '/missing', false);
        try { xhr.send(); } catch (_) {}
      });
    </script>
  </body>
</html>`

/**
 * Ref-action fixture — exercises Playwright's aria-ref selector
 * engine. After a snapshot is taken, refs like `e3` should resolve
 * to real interactive elements via `aria-ref=e3`.
 */
const REF_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Ref Fixture</title></head>
  <body>
    <h1>Ref Fixture</h1>
    <form id="login" onsubmit="event.preventDefault(); document.getElementById('result').textContent = 'submitted: ' + document.getElementById('email').value;">
      <label for="email">Email</label>
      <input id="email" type="email" placeholder="your@email.com" />

      <label for="password">Password</label>
      <input id="password" type="password" />

      <button type="submit" id="signin">Sign in</button>
      <button type="button" id="cancel">Cancel</button>
    </form>
    <div id="result"></div>
  </body>
</html>`

function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url === '/next') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(NEXT_HTML)
        return
      }
      if (url === '/activity') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(ACTIVITY_HTML)
        return
      }
      if (url === '/missing') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      if (url === '/ref') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(REF_FIXTURE_HTML)
        return
      }
      // Root and everything else → start page.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(START_HTML)
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` })
    })
  })
}

// ---------------------------------------------------------------------------
// Tool context
// ---------------------------------------------------------------------------

function makeToolContext(cdpUrl: string): ToolContext {
  const config = {
    ...createDefaultConfig('mock:test'),
    browserCdpUrl: cdpUrl,
  } as unknown as LoomConfig
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    sessionId: 'browser-e2e',
    agentId: null,
    workspacePath: process.cwd(),
    additionalWorkspaceRoots: [],
    config,
    requestPermission: async () => true,
    requestCredential: async () => null,
    resolveCredential: () => null,
    listEnvCredentials: () => [],
    listAllCredentialValues: () => [],
  }
}

// ---------------------------------------------------------------------------
// Mechanics — direct tool execution against real Chrome + local fixture
// ---------------------------------------------------------------------------

describe.skipIf(!CAN_RUN)('browser tools — real Chrome (B1+B2 mechanics)', () => {
  let chrome: RunningChrome
  let ctx: ToolContext
  let fixture: { server: Server; baseUrl: string }

  beforeAll(async () => {
    chrome = await launchChrome({ headless: true })
    ctx = makeToolContext(chrome.cdpUrl)
    fixture = await startFixtureServer()
  }, 30_000)

  afterAll(async () => {
    // Tear Chrome down first so its CDP / keep-alive sockets release.
    // Otherwise `server.close()` waits forever for those connections.
    if (chrome) await chrome.stop()
    await new Promise<void>((resolve) => {
      if (fixture?.server) {
        // Forcibly drop any lingering sockets so close() returns promptly.
        fixture.server.closeAllConnections?.()
        fixture.server.close(() => resolve())
      } else {
        resolve()
      }
    })
  }, 30_000)

  async function gotoFixture(path: '/' | '/activity' | '/ref'): Promise<void> {
    // Setup nav goes through raw Playwright to bypass the SSRF guard
    // on `127.0.0.1`. The tools under test (`browser_click`,
    // `browser_snapshot`) never check SSRF themselves.
    const conn = await connectBrowser(chrome.cdpUrl)
    const page = await getPage(conn)
    trackPageState(page)
    await page.goto(`${fixture.baseUrl}${path}`, { waitUntil: 'domcontentloaded' })
  }

  async function gotoStart(): Promise<void> {
    await gotoFixture('/')
  }

  it('B1: browser_snapshot exposes typed metadata (kind, targetId, supersedable)', async () => {
    await gotoStart()
    const result = (await browserSnapshot.execute({}, ctx)) as ToolResult

    expect(result.isError).toBe(false)

    const md = (result.metadata ?? {}) as Record<string, unknown>
    expect(md.kind).toBe('browser-snapshot')
    expect(typeof md.targetId).toBe('string')
    expect(md.targetId).not.toBe('')
    expect(md.supersedable).toBe(true)
    expect(String(md.url ?? '')).toContain('127.0.0.1')
    expect(md.title).toBe('Start Page')

    expect(result.content).toContain('Page: "Start Page"')
    expect(result.content).toContain('Interactive elements:')
    expect(result.content.toLowerCase()).toContain('continue to the next page')
  }, 30_000)

  it('B1+B2: browser_click result inlines the post-navigation snapshot of the NEW page', async () => {
    await gotoStart()

    const result = (await browserClick.execute(
      { selector: '#go' },
      ctx,
    )) as ToolResult

    expect(result.isError).toBe(false)

    const md = (result.metadata ?? {}) as Record<string, unknown>
    expect(md.kind).toBe('browser-snapshot')
    expect(md.supersedable).toBe(true)
    // B2 — the snapshot was taken AFTER the click's navigation
    // settled. If `waitForSettle` weren't there, the URL would still
    // be `/` or in flight, not `/next`.
    expect(String(md.url ?? '')).toContain('/next')
    expect(md.title).toBe('Next Page')

    // B1 — the new page state is inlined in `content`.
    expect(result.content).toContain('Clicked element')
    expect(result.content).toContain('Page: "Next Page"')
    expect(result.content.toLowerCase()).toContain('acknowledge')
  }, 30_000)

  it('attachSnapshot: false suppresses the inline snapshot block', async () => {
    await gotoStart()

    const result = (await browserClick.execute(
      { selector: '#go', attachSnapshot: false },
      ctx,
    )) as ToolResult

    expect(result.isError).toBe(false)
    expect(result.content).toContain('Clicked element')
    // No snapshot block → no Page: header, no Interactive elements line.
    expect(result.content).not.toContain('Page: "')
    expect(result.content).not.toContain('Interactive elements:')

    const md = (result.metadata ?? {}) as Record<string, unknown>
    expect(md.kind).toBeUndefined()
    expect(md.supersedable).toBeUndefined()
  }, 30_000)

  it('targetId is stable across snapshots of the same tab (caching works)', async () => {
    await gotoStart()
    const first = (await browserSnapshot.execute({}, ctx)) as ToolResult
    const second = (await browserSnapshot.execute({}, ctx)) as ToolResult

    const firstMd = (first.metadata ?? {}) as Record<string, unknown>
    const secondMd = (second.metadata ?? {}) as Record<string, unknown>

    expect(firstMd.targetId).toBeTruthy()
    expect(secondMd.targetId).toBe(firstMd.targetId)
  }, 30_000)

  it('browser_navigate BLOCKS localhost by default (no allowLoopback)', async () => {
    const result = (await browserNavigate.execute(
      { url: `${fixture.baseUrl}/` },
      ctx,
    )) as ToolResult

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Blocked')
  }, 30_000)

  it('browser_navigate REACHES localhost when allowLoopback is set (dev-server preview)', async () => {
    const loopbackCtx: ToolContext = {
      ...ctx,
      config: { ...ctx.config, browserAllowLoopback: true } as typeof ctx.config,
    }

    const result = (await browserNavigate.execute(
      { url: `${fixture.baseUrl}/` },
      loopbackCtx,
    )) as ToolResult

    expect(result.isError).toBe(false)
    expect(result.content).toContain('Start Page')
    const md = (result.metadata ?? {}) as Record<string, unknown>
    expect(String(md.url ?? '')).toContain('127.0.0.1')
  }, 30_000)

  /**
   * Pull `e<n>` refs out of the snapshot text and map each to the
   * `role "name"` it identifies, so tests can assert "the model was
   * given a ref for the Sign in button" without hard-coding `e3`
   * (refs are not stable across snapshots).
   *
   * Playwright `mode: 'ai'` emits refs as `[ref=e<n>]` on the same
   * line as the role + accessible name.
   */
  function refMap(snapshotContent: string): Record<string, string> {
    const lines = snapshotContent.split('\n')
    const map: Record<string, string> = {}
    for (const line of lines) {
      const refMatch = line.match(/\[ref=(e\d+)\]/)
      if (!refMatch) continue
      const ref = refMatch[1]!
      const roleAndName = line.match(/-\s*(\w+)\s+"([^"]+)"/)
      if (roleAndName) {
        map[ref] = `${roleAndName[1]} "${roleAndName[2]}"`
      } else {
        // Refs on bare-role nodes ("- button [ref=e3]") still record
        // the role even without a name.
        const justRole = line.match(/-\s*(\w+)\b/)
        map[ref] = justRole ? justRole[1]! : line.trim()
      }
    }
    return map
  }

  it('ref-locator: a ref from browser_snapshot resolves to a real element and click works', async () => {
    await gotoFixture('/ref')
    const snap = (await browserSnapshot.execute({}, ctx)) as ToolResult
    expect(snap.isError).toBe(false)

    const refs = refMap(String(snap.content))
    // Locate the "Sign in" button ref by scanning the map for the
    // role+name we know is on the page.
    const signInRef = Object.keys(refs).find(r =>
      refs[r]!.toLowerCase().includes('sign in'),
    )
    expect(signInRef, `Expected a ref for the Sign in button. Snapshot was:\n${snap.content}`).toBeDefined()

    // The decisive assertion: click by ref. If `resolveLocator`
    // still used the broken `[aria-ref="..."]` CSS form, this
    // would time out at 10s. With the fix it resolves via the
    // `aria-ref=...` engine selector and clicks immediately.
    const click = (await browserClick.execute({ ref: signInRef! }, ctx)) as ToolResult
    expect(click.isError, `Click by ref failed: ${click.content}`).toBe(false)
    expect(click.content).toContain('Clicked element')
  }, 30_000)

  it('ref-locator: typing into a ref-targeted textbox works (B1 + ref + B2 settle compose)', async () => {
    await gotoFixture('/ref')
    const snap = (await browserSnapshot.execute({}, ctx)) as ToolResult
    const refs = refMap(String(snap.content))
    const emailRef = Object.keys(refs).find(r =>
      refs[r]!.toLowerCase().includes('email'),
    )
    expect(emailRef, `Expected an Email textbox ref. Snapshot was:\n${snap.content}`).toBeDefined()

    const type = (await browserType.execute(
      { ref: emailRef!, text: 'user@example.com' },
      ctx,
    )) as ToolResult
    expect(type.isError, `Type by ref failed: ${type.content}`).toBe(false)
    expect(type.content).toContain('Typed "user@example.com"')

    // The post-action snapshot in the result should reflect the
    // typed value. The browser fixture re-renders nothing, but the
    // input is in the snapshot tree.
    expect(type.content).toContain('Page: "Ref Fixture"')
  }, 30_000)

  it('ref-locator: a stale ref (from an older snapshot) cleanly errors instead of clicking the wrong thing', async () => {
    await gotoFixture('/ref')
    // Take a snapshot, then navigate away.
    const snap1 = (await browserSnapshot.execute({}, ctx)) as ToolResult
    const refs1 = refMap(String(snap1.content))
    const someRef = Object.keys(refs1)[0]
    expect(someRef).toBeDefined()

    await gotoFixture('/')

    // Using the ref from the previous page should now fail with a
    // bounded timeout (default 10s) rather than silently succeeding
    // on the wrong element. We give it 12s to drain the timeout.
    const click = (await browserClick.execute({ ref: someRef! }, ctx)) as ToolResult
    expect(click.isError).toBe(true)
    // The error surface should be the user-friendly translation, not
    // a raw Playwright stack.
    expect(String(click.content).toLowerCase()).toMatch(/timed out|target closed|not found|crashed/)
  }, 30_000)

  it('B3: a click that triggers console.error + a 404 fetch surfaces both in the action result', async () => {
    await gotoFixture('/activity')

    const result = (await browserClick.execute(
      { selector: '#break' },
      ctx,
    )) as ToolResult

    expect(result.isError).toBe(false)

    expect(result.content).toContain('Console (since last action)')
    expect(result.content).toContain('[error] Stripe.js failed to load')

    expect(result.content).toContain('Network failures (since last action)')
    expect(result.content).toMatch(/404 GET .*\/missing/)

    const md = (result.metadata ?? {}) as Record<string, unknown>
    expect(md.newConsoleMessages).toBeGreaterThanOrEqual(1)
    expect(md.newNetworkFailures).toBeGreaterThanOrEqual(1)

    // Activity counters reset on the next action — verify by clicking
    // a non-existent element (which fails fast) and checking no
    // activity is re-surfaced.
    //
    // Easier verification: take a fresh snapshot — it should have
    // zero new activity metadata.
    const followUp = (await browserSnapshot.execute({}, ctx)) as ToolResult
    expect(followUp.content).not.toContain('Stripe.js failed to load')
  }, 30_000)
})
