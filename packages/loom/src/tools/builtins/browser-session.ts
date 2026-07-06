/**
 * Browser Session Management
 *
 * Manages Playwright browser connections via Chrome DevTools Protocol (CDP).
 * Handles connection pooling, page state tracking, and lifecycle management.
 *
 * Playwright-core is an optional peer dependency — if not installed,
 * browser tools gracefully report unavailability.
 *
 * Design:
 *   - Lazy import of playwright-core (fails gracefully if missing)
 *   - Connection pooling by CDP URL (one Playwright Browser per CDP endpoint)
 *   - Page state tracking (console messages, network requests, errors)
 *   - Ref-based element targeting via Playwright's aria snapshot
 *   - Graceful shutdown with force-disconnect for hung connections
 *
 * @security
 *   - SSRF protection: blocks navigation to private/internal IPs
 *   - Timeout enforcement on all operations
 *   - No credential leakage in error messages
 */

// ---------------------------------------------------------------------------
// Types (inlined to avoid hard dep on playwright-core at import time)
// ---------------------------------------------------------------------------

/**
 * Playwright types — inlined so the module can be imported
 * without playwright-core installed. The actual Playwright
 * types are only used at runtime via dynamic import.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type PlaywrightBrowser = any
type PlaywrightPage = any
type PlaywrightLocator = any
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface BrowserConnection {
  readonly cdpUrl: string
  browser: PlaywrightBrowser
  connectedAt: number
}

export interface PageConsoleMessage {
  readonly type: string
  readonly text: string
  readonly timestamp: number
}

export interface PageNetworkFailure {
  readonly url: string
  readonly method: string
  readonly status: number | null
  readonly errorText: string
  readonly resourceType: string
  readonly timestamp: number
}

export interface PageState {
  consoleMessages: PageConsoleMessage[]
  errors: string[]
  networkFailures: PageNetworkFailure[]
  /**
   * Monotonic counters that survive ring-buffer trimming. Each
   * increments every time the corresponding listener fires, even when
   * the oldest entry is shifted off the buffer. The delta between
   * total* and surfaced* is the count of "new since last surface".
   */
  totalConsoleSeen: number
  totalErrorsSeen: number
  totalNetworkFailuresSeen: number
  surfacedConsole: number
  surfacedErrors: number
  surfacedNetworkFailures: number
}

/**
 * Items that have accumulated since the last surface, ready to be
 * rendered into a tool result. Returned by `consumePageActivity`.
 */
export interface PageActivityDelta {
  readonly consoleMessages: readonly PageConsoleMessage[]
  readonly errors: readonly string[]
  readonly networkFailures: readonly PageNetworkFailure[]
  /**
   * Counts of items lost to ring-buffer trimming since the last
   * surface — surfaced as "(+N older dropped)" so the model knows
   * the list isn't exhaustive on a chatty page.
   */
  readonly consoleDropped: number
  readonly errorsDropped: number
  readonly networkFailuresDropped: number
}

export interface BrowserTab {
  readonly targetId: string
  readonly url: string
  readonly title: string
}

export interface ScreenshotResult {
  readonly data: string // base64
  readonly format: 'png' | 'jpeg'
}

export interface SnapshotResult {
  readonly content: string
  readonly elementCount: number
  readonly truncated: boolean
}

/**
 * A snapshot bundled with the page metadata an action result needs to
 * identify which tab it belongs to and to feed the browser-aware
 * compactor's supersession key.
 */
export interface PageSnapshotResult {
  readonly content: string
  readonly url: string
  readonly title: string
  readonly targetId: string
  readonly elementCount: number
  readonly truncated: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONSOLE_MESSAGES = 200
const MAX_ERRORS = 100
const MAX_NETWORK_FAILURES = 100
const MAX_ACTIVITY_ITEMS_SURFACED = 10
const CONNECTION_TIMEOUT_MS = 15_000
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000
const DEFAULT_ACTION_TIMEOUT_MS = 10_000
const MAX_SNAPSHOT_CHARS = 80_000

/**
 * How long an action waits for the page to reach `domcontentloaded`
 * after the Playwright primitive completes. Most clicks/keys/forms
 * either don't navigate (immediate) or trigger a nav that parses DOM
 * in well under a second. 2s is a generous ceiling; if a real nav
 * takes longer the snapshot just reads whatever's there and the model
 * can wait explicitly.
 */
const POST_ACTION_SETTLE_MS = 2_000

// ---------------------------------------------------------------------------
// SSRF protection (matches web-fetch.ts patterns)
// ---------------------------------------------------------------------------

export function isBlockedUrl(
  url: string,
  opts?: { allowLoopback?: boolean },
): boolean {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true

    // Loopback — the user's own machine (localhost / 127.0.0.0-8 / ::1 /
    // 0.0.0.0). Blocked by default as SSRF protection. A consumer can opt in
    // (`allowLoopback`) for the "preview my local dev server" case — used by
    // the desktop packaging, where the agent already reaches localhost via the
    // shell tool, so blocking the browser from a dev server is pure friction.
    // The cloud / standalone packaging leaves this off, so loopback stays
    // blocked there. The LAN / private ranges below are blocked ALWAYS,
    // regardless of this flag.
    const isLoopback =
      hostname === 'localhost' ||
      hostname.startsWith('127.') ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === '[::1]'
    if (isLoopback) return opts?.allowLoopback !== true

    if (
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname) ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    ) {
      return true
    }

    return false
  } catch {
    return true
  }
}

// ---------------------------------------------------------------------------
// Playwright lazy loader
// ---------------------------------------------------------------------------

let playwrightModule: typeof import('playwright-core') | null = null
let playwrightLoadAttempted = false
let playwrightLoadError: string | null = null

async function loadPlaywright(): Promise<typeof import('playwright-core') | null> {
  if (playwrightLoadAttempted) return playwrightModule
  playwrightLoadAttempted = true

  try {
    playwrightModule = await import('playwright-core')
    return playwrightModule
  } catch {
    playwrightLoadError =
      'playwright-core is not installed. Install it with: bun add playwright-core'
    return null
  }
}

export function getPlaywrightError(): string | null {
  return playwrightLoadError
}

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------

const connections = new Map<string, BrowserConnection>()
const pageStates = new WeakMap<PlaywrightPage, PageState>()
const pageTargetIds = new WeakMap<PlaywrightPage, string>()

/**
 * Connect to a browser via CDP endpoint.
 * Returns an existing connection if one is active for this CDP URL.
 */
export async function connectBrowser(cdpUrl: string): Promise<BrowserConnection> {
  const existing = connections.get(cdpUrl)
  if (existing) {
    try {
      // Verify connection is still alive
      if (existing.browser.isConnected()) {
        return existing
      }
    } catch {
      // Connection is dead, clean up and reconnect
      connections.delete(cdpUrl)
    }
  }

  const pw = await loadPlaywright()
  if (!pw) {
    throw new Error(playwrightLoadError ?? 'playwright-core is not available')
  }

  const browser = await pw.chromium.connectOverCDP(cdpUrl, {
    timeout: CONNECTION_TIMEOUT_MS,
  })

  const conn: BrowserConnection = {
    cdpUrl,
    browser,
    connectedAt: Date.now(),
  }

  connections.set(cdpUrl, conn)

  // Clean up on disconnect
  browser.on('disconnected', () => {
    connections.delete(cdpUrl)
  })

  return conn
}

/**
 * Get a specific page by target ID, or the first page if no target specified.
 */
export async function getPage(
  conn: BrowserConnection,
  targetId?: string,
): Promise<PlaywrightPage> {
  const contexts = conn.browser.contexts()
  if (contexts.length === 0) {
    throw new Error('No browser contexts available. The browser may not have any open tabs.')
  }

  const allPages: PlaywrightPage[] = []
  for (const ctx of contexts) {
    allPages.push(...ctx.pages())
  }

  if (allPages.length === 0) {
    throw new Error('No pages open in the browser.')
  }

  if (!targetId) {
    return allPages[0]
  }

  // Match by target ID (CDP target ID is exposed via page internals)
  // Fallback: match by URL fragment if target ID isn't directly accessible
  for (const page of allPages) {
    try {
      const cdpSession = await page.context().newCDPSession(page)
      const { targetInfo } = await cdpSession.send('Target.getTargetInfo')
      await cdpSession.detach()
      if (targetInfo.targetId === targetId) {
        return page
      }
    } catch {
      // Skip pages that don't support CDP sessions
    }
  }

  throw new Error(
    `No page found with target ID "${targetId}". ` +
    `Available pages: ${allPages.map(p => p.url()).join(', ')}`,
  )
}

/**
 * Initialize page state tracking (console messages, errors).
 * Call once after getting a page reference.
 */
export function trackPageState(page: PlaywrightPage): PageState {
  const existing = pageStates.get(page)
  if (existing) return existing

  const state: PageState = {
    consoleMessages: [],
    errors: [],
    networkFailures: [],
    totalConsoleSeen: 0,
    totalErrorsSeen: 0,
    totalNetworkFailuresSeen: 0,
    surfacedConsole: 0,
    surfacedErrors: 0,
    surfacedNetworkFailures: 0,
  }

  page.on('console', (msg: { type: () => string; text: () => string }) => {
    if (state.consoleMessages.length >= MAX_CONSOLE_MESSAGES) {
      state.consoleMessages.shift()
    }
    state.consoleMessages.push({
      type: msg.type(),
      text: msg.text(),
      timestamp: Date.now(),
    })
    state.totalConsoleSeen += 1
  })

  page.on('pageerror', (error: Error) => {
    if (state.errors.length >= MAX_ERRORS) {
      state.errors.shift()
    }
    state.errors.push(error.message)
    state.totalErrorsSeen += 1
  })

  /**
   * Network-failure capture for B3.
   *
   * Two sources:
   *   1. `requestfailed` — DNS errors, timeouts, aborts, cert failures.
   *   2. `response` with status ≥ 400 *for `xhr`/`fetch`/`document`* —
   *      surface only the resource types the model actually cares
   *      about; image/css/font 404s are noise.
   */
  page.on('requestfailed', (request: {
    url: () => string
    method: () => string
    resourceType: () => string
    failure: () => { errorText: string } | null
  }) => {
    if (state.networkFailures.length >= MAX_NETWORK_FAILURES) {
      state.networkFailures.shift()
    }
    state.networkFailures.push({
      url: request.url(),
      method: request.method(),
      status: null,
      errorText: request.failure()?.errorText ?? 'request failed',
      resourceType: request.resourceType(),
      timestamp: Date.now(),
    })
    state.totalNetworkFailuresSeen += 1
  })

  page.on('response', (response: {
    url: () => string
    status: () => number
    statusText: () => string
    request: () => { method: () => string; resourceType: () => string }
  }) => {
    const status = response.status()
    if (status < 400) return
    const request = response.request()
    const rtype = request.resourceType()
    if (rtype !== 'xhr' && rtype !== 'fetch' && rtype !== 'document') return
    if (state.networkFailures.length >= MAX_NETWORK_FAILURES) {
      state.networkFailures.shift()
    }
    state.networkFailures.push({
      url: response.url(),
      method: request.method(),
      status,
      errorText: response.statusText() || `HTTP ${status}`,
      resourceType: rtype,
      timestamp: Date.now(),
    })
    state.totalNetworkFailuresSeen += 1
  })

  pageStates.set(page, state)
  return state
}

/**
 * Get tracked state for a page.
 */
export function getPageState(page: PlaywrightPage): PageState | null {
  return pageStates.get(page) ?? null
}

/**
 * Resolve the CDP target ID for a page, cached.
 *
 * The target ID is the stable identifier the browser-aware compactor
 * keys snapshot supersession on — two snapshots of the same target ID
 * are interchangeable, with the older one safely dropped. Resolving it
 * costs a CDP round trip on first lookup; subsequent calls hit the
 * WeakMap and are free.
 *
 * Falls back to `page.url()` if CDP target info is unavailable so
 * callers always get a non-empty identifier.
 */
export async function getTargetId(page: PlaywrightPage): Promise<string> {
  const cached = pageTargetIds.get(page)
  if (cached) return cached

  try {
    const cdpSession = await page.context().newCDPSession(page)
    try {
      const { targetInfo } = await cdpSession.send('Target.getTargetInfo')
      pageTargetIds.set(page, targetInfo.targetId)
      return targetInfo.targetId
    } finally {
      await cdpSession.detach().catch(() => {
        // Best-effort detach — a closed page throws here and the
        // session is reaped anyway.
      })
    }
  } catch {
    const fallback = page.url() || 'unknown'
    pageTargetIds.set(page, fallback)
    return fallback
  }
}

/**
 * Capture an accessibility snapshot of the page together with the
 * page metadata an action result needs.
 *
 * Used by `browser_snapshot` and by every mutating action tool that
 * inlines the post-action page state in its result (B1).
 */
export async function capturePageSnapshot(
  page: PlaywrightPage,
  opts?: { selector?: string; ref?: string; maxChars?: number },
): Promise<PageSnapshotResult> {
  const snap = await takeSnapshot(page, opts)
  const [url, title, targetId] = await Promise.all([
    Promise.resolve(page.url()),
    page.title().catch(() => ''),
    getTargetId(page),
  ])
  return {
    content: snap.content,
    url,
    title,
    targetId,
    elementCount: snap.elementCount,
    truncated: snap.truncated,
  }
}

/**
 * Format a `PageSnapshotResult` as the text block that goes into a
 * tool result's `content`. Shared between `browser_snapshot` and the
 * action tools so the format is identical no matter which tool
 * produced it — the model learns one shape.
 */
export function formatSnapshotBlock(snap: PageSnapshotResult): string {
  return (
    `Page: "${snap.title}" (${snap.url})\n` +
    `Interactive elements: ${snap.elementCount}` +
    `${snap.truncated ? ' [truncated]' : ''}\n\n` +
    snap.content
  )
}

/**
 * Wait for the page to reach a stable load state after an action.
 *
 * If the action didn't trigger a navigation, the page is already in
 * `domcontentloaded` and this returns immediately. If a navigation is
 * in flight, this waits up to `timeoutMs` for the new DOM. The
 * timeout is intentionally short — the goal is to let a fast nav
 * settle before the post-action snapshot is taken (B1), not to
 * substitute for `browser_wait` when the model actually needs
 * `networkidle`.
 *
 * Errors are swallowed: the *action* already succeeded; the post-
 * action snapshot reads whatever DOM is present even if this races a
 * still-loading page.
 */
export async function waitForSettle(
  page: PlaywrightPage,
  timeoutMs: number = POST_ACTION_SETTLE_MS,
  state: 'load' | 'domcontentloaded' | 'networkidle' = 'domcontentloaded',
): Promise<void> {
  try {
    await page.waitForLoadState(state, { timeout: timeoutMs })
  } catch {
    // Timeout or page closed — best-effort.
  }
}

/**
 * Compute the activity delta since the last surface and advance the
 * marks so the next call returns only newer items. Returns empty
 * arrays when nothing new is pending; `consoleDropped`/`errorsDropped`/
 * `networkFailuresDropped` count items that arrived since the last
 * surface but were trimmed from the ring buffer before we could
 * render them.
 *
 * Safe to call on a page with no tracked state — returns an empty
 * delta in that case.
 */
export function consumePageActivity(page: PlaywrightPage): PageActivityDelta {
  const state = pageStates.get(page)
  if (!state) {
    return {
      consoleMessages: [],
      errors: [],
      networkFailures: [],
      consoleDropped: 0,
      errorsDropped: 0,
      networkFailuresDropped: 0,
    }
  }

  const newConsoleCount = state.totalConsoleSeen - state.surfacedConsole
  const newErrorsCount = state.totalErrorsSeen - state.surfacedErrors
  const newNetCount =
    state.totalNetworkFailuresSeen - state.surfacedNetworkFailures

  const consoleSlice =
    newConsoleCount > 0
      ? state.consoleMessages.slice(-Math.min(newConsoleCount, state.consoleMessages.length))
      : []
  const errorsSlice =
    newErrorsCount > 0
      ? state.errors.slice(-Math.min(newErrorsCount, state.errors.length))
      : []
  const netSlice =
    newNetCount > 0
      ? state.networkFailures.slice(-Math.min(newNetCount, state.networkFailures.length))
      : []

  const delta: PageActivityDelta = {
    consoleMessages: consoleSlice,
    errors: errorsSlice,
    networkFailures: netSlice,
    consoleDropped: Math.max(0, newConsoleCount - consoleSlice.length),
    errorsDropped: Math.max(0, newErrorsCount - errorsSlice.length),
    networkFailuresDropped: Math.max(0, newNetCount - netSlice.length),
  }

  state.surfacedConsole = state.totalConsoleSeen
  state.surfacedErrors = state.totalErrorsSeen
  state.surfacedNetworkFailures = state.totalNetworkFailuresSeen

  return delta
}

/**
 * Render the activity delta as a compact text block. Returns the
 * empty string when nothing of interest happened — callers
 * concatenate the block unconditionally; an empty block contributes
 * zero characters and zero noise.
 *
 * Console-message rendering filters to `error` and `warning` types
 * by default — `log`/`debug`/`info` chatter is too noisy to feed
 * back to the model on every action.
 */
export function formatActivityBlock(delta: PageActivityDelta): string {
  const noteworthyConsole = delta.consoleMessages.filter(
    m => m.type === 'error' || m.type === 'warning',
  )
  if (
    noteworthyConsole.length === 0 &&
    delta.errors.length === 0 &&
    delta.networkFailures.length === 0
  ) {
    return ''
  }

  const lines: string[] = []

  if (noteworthyConsole.length > 0) {
    const shown = noteworthyConsole.slice(0, MAX_ACTIVITY_ITEMS_SURFACED)
    const overflow = noteworthyConsole.length - shown.length + delta.consoleDropped
    lines.push(
      `⚠ Console (since last action): ${noteworthyConsole.length} new` +
        (overflow > 0 ? ` (+${overflow} more)` : ''),
    )
    for (const m of shown) lines.push(`  - [${m.type}] ${m.text}`)
  }

  if (delta.errors.length > 0) {
    const shown = delta.errors.slice(0, MAX_ACTIVITY_ITEMS_SURFACED)
    const overflow = delta.errors.length - shown.length + delta.errorsDropped
    lines.push(
      `⚠ Page errors (since last action): ${delta.errors.length} new` +
        (overflow > 0 ? ` (+${overflow} more)` : ''),
    )
    for (const e of shown) lines.push(`  - ${e}`)
  }

  if (delta.networkFailures.length > 0) {
    const shown = delta.networkFailures.slice(0, MAX_ACTIVITY_ITEMS_SURFACED)
    const overflow =
      delta.networkFailures.length - shown.length + delta.networkFailuresDropped
    lines.push(
      `⚠ Network failures (since last action): ${delta.networkFailures.length} new` +
        (overflow > 0 ? ` (+${overflow} more)` : ''),
    )
    for (const n of shown) {
      const code = n.status ? `${n.status} ` : ''
      lines.push(
        `  - ${code}${n.method} ${n.url} (${n.resourceType}) — ${n.errorText}`,
      )
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Page operations
// ---------------------------------------------------------------------------

/**
 * Navigate a page to a URL with SSRF protection.
 */
export async function navigatePage(
  page: PlaywrightPage,
  url: string,
  opts?: { timeoutMs?: number; allowLoopback?: boolean },
): Promise<{ url: string; title: string; status: number | null }> {
  if (isBlockedUrl(url, { allowLoopback: opts?.allowLoopback })) {
    throw new Error(
      `Blocked: "${url}" points to a private/internal network or uses a non-HTTP protocol.`,
    )
  }

  const response = await page.goto(url, {
    timeout: opts?.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  })

  return {
    url: page.url(),
    title: await page.title(),
    status: response?.status() ?? null,
  }
}

/**
 * Click an element by selector or ref.
 */
export async function clickElement(
  page: PlaywrightPage,
  opts: {
    selector?: string
    ref?: string
    doubleClick?: boolean
    button?: 'left' | 'right' | 'middle'
    timeoutMs?: number
  },
): Promise<string> {
  const locator = resolveLocator(page, opts.selector, opts.ref)
  const timeout = opts.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS

  if (opts.doubleClick) {
    await locator.dblclick({ timeout })
  } else {
    await locator.click({ timeout, button: opts.button ?? 'left' })
  }

  await waitForSettle(page)

  return `Clicked element${opts.selector ? ` "${opts.selector}"` : ''}${opts.ref ? ` ref="${opts.ref}"` : ''}`
}

/**
 * Type text into an element.
 */
export async function typeIntoElement(
  page: PlaywrightPage,
  opts: {
    selector?: string
    ref?: string
    text: string
    submit?: boolean
    slowly?: boolean
    timeoutMs?: number
  },
): Promise<string> {
  const locator = resolveLocator(page, opts.selector, opts.ref)
  const timeout = opts.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS

  if (opts.slowly) {
    await locator.click({ timeout })
    await locator.pressSequentially(opts.text, { delay: 75 })
  } else {
    await locator.fill(opts.text, { timeout })
  }

  if (opts.submit) {
    await locator.press('Enter', { timeout })
  }

  await waitForSettle(page)

  return `Typed "${opts.text.length > 50 ? opts.text.slice(0, 50) + '...' : opts.text}" into element`
}

/**
 * Take a screenshot of the page or a specific element.
 */
export async function takeScreenshot(
  page: PlaywrightPage,
  opts?: {
    selector?: string
    ref?: string
    fullPage?: boolean
    format?: 'png' | 'jpeg'
  },
): Promise<ScreenshotResult> {
  const format = opts?.format ?? 'png'

  let buffer: Buffer

  if (opts?.selector || opts?.ref) {
    const locator = resolveLocator(page, opts.selector, opts.ref)
    buffer = await locator.screenshot({ type: format })
  } else {
    buffer = await page.screenshot({
      type: format,
      fullPage: opts?.fullPage ?? false,
    })
  }

  return {
    data: buffer.toString('base64'),
    format,
  }
}

/**
 * Take an accessibility snapshot of the page.
 * Returns a text representation of the page's accessibility tree.
 *
 * `mode: 'ai'` is required for Playwright to emit `[ref=e<n>]`
 * markers next to each interactive element. Without this option the
 * snapshot still renders the a11y tree but contains no refs — and
 * the model has nothing stable to pass to `browser_click` /
 * `browser_type` (`ref: 'e3'` would resolve via `aria-ref=e3` which
 * resolves against the most recent AI-mode snapshot on the same
 * frame). The default `'default'` mode is for human readers, not
 * agents.
 */
export async function takeSnapshot(
  page: PlaywrightPage,
  opts?: {
    selector?: string
    ref?: string
    maxChars?: number
  },
): Promise<SnapshotResult> {
  const maxChars = opts?.maxChars ?? MAX_SNAPSHOT_CHARS

  let snapshot: string

  if (opts?.selector || opts?.ref) {
    const locator = resolveLocator(page, opts.selector, opts.ref)
    snapshot = await locator.ariaSnapshot({ mode: 'ai' })
  } else {
    snapshot = await page.locator('body').ariaSnapshot({ mode: 'ai' })
  }

  const truncated = snapshot.length > maxChars
  if (truncated) {
    snapshot = snapshot.slice(0, maxChars) + '\n\n[Snapshot truncated]'
  }

  // Count interactive elements (rough heuristic based on role keywords)
  const elementCount = (snapshot.match(/- (button|link|textbox|checkbox|radio|combobox|slider|tab|menuitem|switch)/gi) || []).length

  return { content: snapshot, elementCount, truncated }
}

/**
 * Evaluate JavaScript in the browser context.
 */
export async function evaluateScript(
  page: PlaywrightPage,
  expression: string,
  timeoutMs: number = DEFAULT_ACTION_TIMEOUT_MS,
): Promise<string> {
  const result = await Promise.race([
    page.evaluate(expression),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Evaluate timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ])

  if (result === undefined || result === null) {
    return 'undefined'
  }

  try {
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

/**
 * List all open tabs.
 */
export async function listTabs(conn: BrowserConnection): Promise<BrowserTab[]> {
  const tabs: BrowserTab[] = []
  const contexts = conn.browser.contexts()

  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      let targetId = 'unknown'
      try {
        const cdpSession = await ctx.newCDPSession(page)
        const { targetInfo } = await cdpSession.send('Target.getTargetInfo')
        targetId = targetInfo.targetId
        await cdpSession.detach()
      } catch {
        // Use page URL as fallback identifier
        targetId = page.url()
      }

      tabs.push({
        targetId,
        url: page.url(),
        title: await page.title(),
      })
    }
  }

  return tabs
}

/**
 * Open a new tab.
 */
export async function openTab(
  conn: BrowserConnection,
  url: string,
  opts?: { allowLoopback?: boolean },
): Promise<BrowserTab> {
  if (isBlockedUrl(url, { allowLoopback: opts?.allowLoopback })) {
    throw new Error(
      `Blocked: "${url}" points to a private/internal network or uses a non-HTTP protocol.`,
    )
  }

  const contexts = conn.browser.contexts()
  const context = contexts[0]
  if (!context) {
    throw new Error('No browser context available to open a new tab.')
  }

  const page = await context.newPage()
  await page.goto(url, {
    timeout: DEFAULT_NAVIGATION_TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  })

  trackPageState(page)

  let targetId = page.url()
  try {
    const cdpSession = await context.newCDPSession(page)
    const { targetInfo } = await cdpSession.send('Target.getTargetInfo')
    targetId = targetInfo.targetId
    await cdpSession.detach()
  } catch {
    // Use URL as fallback
  }

  return {
    targetId,
    url: page.url(),
    title: await page.title(),
  }
}

/**
 * Close a tab by target ID.
 */
export async function closeTab(
  conn: BrowserConnection,
  targetId: string,
): Promise<void> {
  const page = await getPage(conn, targetId)
  await page.close()
}

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

/**
 * Disconnect from a browser.
 */
export async function disconnectBrowser(cdpUrl: string): Promise<void> {
  const conn = connections.get(cdpUrl)
  if (!conn) return

  try {
    await conn.browser.close()
  } catch {
    // Best-effort cleanup
  }
  connections.delete(cdpUrl)
}

/**
 * Disconnect all browsers. Called on process shutdown.
 */
export async function disconnectAll(): Promise<void> {
  const urls = [...connections.keys()]
  await Promise.allSettled(urls.map(url => disconnectBrowser(url)))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Additional page operations
// ---------------------------------------------------------------------------

/**
 * Hover over an element.
 */
export async function hoverElement(
  page: PlaywrightPage,
  opts: {
    selector?: string
    ref?: string
    timeoutMs?: number
  },
): Promise<string> {
  const locator = resolveLocator(page, opts.selector, opts.ref)
  await locator.hover({ timeout: opts.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS })
  return `Hovered element${opts.selector ? ` "${opts.selector}"` : ''}${opts.ref ? ` ref="${opts.ref}"` : ''}`
}

/**
 * Select an option from a <select> element.
 */
export async function selectOption(
  page: PlaywrightPage,
  opts: {
    selector?: string
    ref?: string
    value?: string
    label?: string
    index?: number
    timeoutMs?: number
  },
): Promise<string> {
  const locator = resolveLocator(page, opts.selector, opts.ref)
  const timeout = opts.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS

  let selectOpts: { value?: string; label?: string; index?: number }
  if (opts.value !== undefined) selectOpts = { value: opts.value }
  else if (opts.label !== undefined) selectOpts = { label: opts.label }
  else if (opts.index !== undefined) selectOpts = { index: opts.index }
  else throw new Error('One of value, label, or index must be provided for select.')

  await locator.selectOption(selectOpts, { timeout })
  await waitForSettle(page)
  const description = opts.value ?? opts.label ?? `index ${opts.index}`
  return `Selected "${description}" in dropdown`
}

/**
 * Press a keyboard key (for non-text keys like Enter, Tab, ArrowDown, etc.).
 */
export async function pressKey(
  page: PlaywrightPage,
  key: string,
  opts?: {
    selector?: string
    ref?: string
    timeoutMs?: number
  },
): Promise<string> {
  if (opts?.selector || opts?.ref) {
    const locator = resolveLocator(page, opts.selector, opts.ref)
    await locator.press(key, { timeout: opts.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS })
  } else {
    await page.keyboard.press(key)
  }
  await waitForSettle(page)
  return `Pressed key "${key}"`
}

/**
 * Drag an element to another element.
 */
export async function dragElement(
  page: PlaywrightPage,
  opts: {
    sourceSelector?: string
    sourceRef?: string
    targetSelector?: string
    targetRef?: string
    timeoutMs?: number
  },
): Promise<string> {
  const source = resolveLocator(page, opts.sourceSelector, opts.sourceRef)
  const target = resolveLocator(page, opts.targetSelector, opts.targetRef)
  await source.dragTo(target, { timeout: opts.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS })
  await waitForSettle(page)
  return 'Drag completed'
}

/**
 * Fill multiple form fields at once.
 */
export async function fillForm(
  page: PlaywrightPage,
  fields: Array<{
    selector?: string
    ref?: string
    value: string
    type?: 'text' | 'checkbox' | 'select'
  }>,
  timeoutMs: number = DEFAULT_ACTION_TIMEOUT_MS,
): Promise<string> {
  const results: string[] = []

  for (const field of fields) {
    const locator = resolveLocator(page, field.selector, field.ref)

    switch (field.type) {
      case 'checkbox':
        await locator.setChecked(field.value === 'true' || field.value === '1', { timeout: timeoutMs })
        results.push(`Checkbox ${field.selector ?? field.ref}: ${field.value}`)
        break
      case 'select':
        await locator.selectOption({ value: field.value }, { timeout: timeoutMs })
        results.push(`Select ${field.selector ?? field.ref}: ${field.value}`)
        break
      default:
        await locator.fill(field.value, { timeout: timeoutMs })
        results.push(`Field ${field.selector ?? field.ref}: filled`)
        break
    }
  }

  await waitForSettle(page)
  return `Form filled (${results.length} fields):\n${results.join('\n')}`
}

/**
 * Wait for a condition on the page.
 */
export async function waitForCondition(
  page: PlaywrightPage,
  opts: {
    selector?: string
    text?: string
    url?: string
    loadState?: 'load' | 'domcontentloaded' | 'networkidle'
    timeMs?: number
    timeoutMs?: number
  },
): Promise<string> {
  const timeout = opts.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS

  if (opts.selector) {
    await page.locator(opts.selector).waitFor({ state: 'visible', timeout })
    return `Element "${opts.selector}" is now visible`
  }

  if (opts.text) {
    await page.locator(`text=${opts.text}`).waitFor({ state: 'visible', timeout })
    return `Text "${opts.text}" is now visible`
  }

  if (opts.url) {
    await page.waitForURL(opts.url, { timeout })
    return `URL matched: ${opts.url}`
  }

  if (opts.loadState) {
    await page.waitForLoadState(opts.loadState, { timeout })
    return `Page reached "${opts.loadState}" state`
  }

  if (opts.timeMs) {
    const waitMs = Math.min(opts.timeMs, 30_000)
    await new Promise(resolve => setTimeout(resolve, waitMs))
    return `Waited ${waitMs}ms`
  }

  return 'No wait condition specified'
}

/**
 * Scroll an element into view.
 */
export async function scrollIntoView(
  page: PlaywrightPage,
  opts: {
    selector?: string
    ref?: string
    timeoutMs?: number
  },
): Promise<string> {
  const locator = resolveLocator(page, opts.selector, opts.ref)
  await locator.scrollIntoViewIfNeeded({ timeout: opts.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS })
  return `Scrolled element into view`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a locator from a selector string or aria ref.
 * Refs use Playwright's aria-snapshot ref format (e.g., "e12").
 *
 * `aria-ref=...` is a Playwright **selector engine**, not a CSS
 * attribute selector. The engine resolves refs against the most
 * recent `ariaSnapshot()` taken on the same frame — Playwright's
 * own internal code uses exactly this form (see playwright-core's
 * `page.js`: `` `aria-ref=${frameRef} >> internal:control=enter-frame` ``).
 * Earlier versions of this function used `[aria-ref="..."]` (CSS
 * attribute matcher), which silently never resolved to anything on
 * any real page — the attribute isn't a persistent DOM attribute.
 */
function resolveLocator(
  page: PlaywrightPage,
  selector?: string,
  ref?: string,
): PlaywrightLocator {
  if (ref) {
    return page.locator(`aria-ref=${ref}`)
  }

  if (selector) {
    return page.locator(selector)
  }

  throw new Error('Either selector or ref must be provided to locate an element.')
}
