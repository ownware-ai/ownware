/**
 * Built-in Browser Tools
 *
 * Full browser automation via Playwright — navigate, click, type,
 * screenshot, accessibility snapshot, evaluate JS, manage tabs.
 *
 * Engine-level — any agent that needs to interact with web pages.
 *
 * Design:
 *   - playwright-core is optional. If not installed, tools return
 *     a clear error asking the user to install it.
 *   - Requires a CDP URL via config.browserCdpUrl (direct string) OR
 *     config.browserCdpUrlProvider (async function, lazy — spawns on
 *     first tool call; see createDeferredChromeLauncher)
 *   - Each operation is a separate Tool (not one monolithic tool)
 *   - Screenshots go in metadata.image (base64), text description in content
 *   - Snapshots return accessible tree text (model reads to understand page)
 *
 * @security
 *   - SSRF protection on navigation (blocks private IPs, non-HTTP)
 *   - Timeout enforcement on all operations
 *   - evaluate requires explicit permission
 *   - Tab management requires permission (prevents data exfiltration)
 */

import { defineTool } from '../types.js'
import type { Tool, ToolContext } from '../types.js'
import { headTailTruncate } from '../../messages/truncate.js'
import {
  connectBrowser,
  getPage,
  trackPageState,
  getPageState,
  navigatePage,
  clickElement,
  typeIntoElement,
  takeScreenshot,
  evaluateScript,
  listTabs,
  openTab,
  closeTab,
  hoverElement,
  selectOption,
  pressKey,
  dragElement,
  fillForm,
  waitForCondition,
  scrollIntoView,
  capturePageSnapshot,
  formatSnapshotBlock,
  consumePageActivity,
  formatActivityBlock,
  getPlaywrightError,
  type BrowserConnection,
} from './browser-session.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the browser connection from context config.
 *
 * Resolution precedence:
 *   1. `config.browserCdpUrl` (string) — use it verbatim. This is the
 *      "bring your own Chrome" path for standalone Loom.
 *   2. `config.browserCdpUrlProvider` (async function) — called on the
 *      FIRST browser tool invocation, not at session start. Gateways
 *      (Cortex) pass a memoized launcher here so Chrome spawns lazily.
 *      The provider is responsible for caching its result so repeat
 *      calls in the same session are cheap.
 *   3. Otherwise → throw with actionable guidance.
 */
async function getConnection(context: ToolContext): Promise<BrowserConnection> {
  const cfg = context.config as Record<string, unknown>
  let cdpUrl = cfg.browserCdpUrl as string | undefined

  if (!cdpUrl) {
    const provider = cfg.browserCdpUrlProvider as
      | (() => Promise<string>)
      | undefined
    if (typeof provider === 'function') {
      cdpUrl = await provider()
    }
  }

  if (!cdpUrl) {
    const pwError = getPlaywrightError()
    throw new Error(
      pwError ??
      'Browser tools are not configured. Options:\n' +
      '  • Cortex: set `"browser": { "autoLaunch": true }` (or leave the ' +
      'default `"auto"`) in the profile\'s agent.json — the gateway ' +
      'spawns Chrome on the first browser tool call.\n' +
      '  • Standalone Loom: pass `config.browserCdpUrl` (e.g. ' +
      '"http://127.0.0.1:9222") when creating the Session, OR pass ' +
      '`config.browserCdpUrlProvider` — an async function that returns ' +
      'the CDP URL on demand (use `createDeferredChromeLauncher()`).',
    )
  }

  return connectBrowser(cdpUrl)
}

/**
 * Whether this consumer permits navigation to loopback addresses
 * (localhost / 127.0.0.0-8 / ::1 / 0.0.0.0) — the "preview my local
 * dev server" case. Off unless the host sets `config.browserAllowLoopback`
 * (the desktop packaging does; cloud/standalone leaves it off so loopback
 * stays SSRF-blocked). LAN/private ranges are blocked regardless.
 */
function loopbackAllowed(context: ToolContext): boolean {
  return (context.config as Record<string, unknown>).browserAllowLoopback === true
}

/**
 * Get the target page from input + context.
 *
 * Target resolution:
 *   1. An explicit `input.targetId` on the tool call (the model selected a
 *      specific tab) always wins.
 *   2. Otherwise `config.browserDefaultTargetId`, when set — the consumer
 *      (e.g. a host that owns ONE specific page it wants driven, like an
 *      embedded view) tells us which CDP target to drive by default, so a
 *      bare `connectOverCDP` to a multi-target endpoint doesn't grab the
 *      wrong page. Loom stays generic: it's just "prefer this target".
 *   3. Otherwise `getPage`'s default (the first available page).
 */
async function getTargetPage(
  conn: BrowserConnection,
  input: Record<string, unknown>,
  context: ToolContext,
) {
  const cfg = context.config as Record<string, unknown>
  let targetId = input.targetId as string | undefined

  // No explicit tab on the call → ask the host which tab is "active" right now
  // (the user or the agent may have switched tabs since the last call). This
  // keeps a multi-tab embedded browser coherent without any stale pinning.
  if (targetId == null) {
    const activeProvider = cfg.browserActiveTargetProvider as
      | (() => Promise<string | null>)
      | undefined
    if (typeof activeProvider === 'function') {
      try {
        targetId = (await activeProvider()) ?? undefined
      } catch {
        // Provider unreachable → fall through to the static default / first page.
      }
    }
  }
  // Static fallback (single-target hosts that don't track an "active" tab).
  if (targetId == null && typeof cfg.browserDefaultTargetId === 'string') {
    targetId = cfg.browserDefaultTargetId
  }

  const page = await getPage(conn, targetId)
  trackPageState(page)
  return page
}

/**
 * Wrap a browser operation with standard error handling.
 */
function browserError(e: unknown): { content: string; isError: true } {
  const msg = e instanceof Error ? e.message : String(e)

  // Translate common Playwright errors to user-friendly messages
  if (msg.includes('Target closed') || msg.includes('crashed')) {
    return { content: 'The browser tab was closed or crashed. Try opening a new tab.', isError: true }
  }
  if (msg.includes('Timeout')) {
    return { content: `Browser operation timed out: ${msg}`, isError: true }
  }
  if (msg.includes('not installed') || msg.includes('playwright-core')) {
    return { content: msg, isError: true }
  }

  return { content: `Browser error: ${msg}`, isError: true }
}

/**
 * Reusable schema fragment for the `attachSnapshot` parameter every
 * mutating action tool accepts.
 *
 * Default behavior is to attach the post-action snapshot so the model
 * doesn't have to follow up with a separate `browser_snapshot` call
 * (the B1 round-trip win). Setting it to `false` is for the rare case
 * where the model wants to chain rapid actions without re-reading.
 */
const ATTACH_SNAPSHOT_SCHEMA = {
  type: 'boolean',
  description:
    'After the action, include an updated page snapshot in the result. ' +
    'Default: true. Set false to chain actions without re-reading the page.',
} as const

/**
 * Capture the post-action snapshot and bundle it into the tool
 * result, with the typed metadata the browser-aware compactor (B4)
 * keys supersession on.
 *
 * `extraMetadata` is whatever per-tool fields the action wants to
 * surface (selector, ref, key, etc.); the snapshot fields are merged
 * on top with a stable `kind: 'browser-snapshot'` discriminator.
 *
 * If snapshot capture fails after the action succeeded, the action is
 * still reported as a success — but the failure is surfaced inline so
 * the model knows it's flying blind and can re-snapshot explicitly.
 */
async function withSnapshot(
  page: unknown,
  actionContent: string,
  attach: boolean,
  extraMetadata: Record<string, unknown>,
): Promise<{ content: string; isError: false; metadata: Record<string, unknown> }> {
  if (!attach) {
    return { content: actionContent, isError: false, metadata: extraMetadata }
  }

  try {
    const snap = await capturePageSnapshot(page)
    // B3 — surface console errors / page errors / network failures
    // that arrived since the last action so the model self-diagnoses
    // without a separate `browser_console` call.
    const activity = consumePageActivity(page)
    const activityBlock = formatActivityBlock(activity)
    const activityCounts = {
      newConsoleMessages: activity.consoleMessages.length,
      newPageErrors: activity.errors.length,
      newNetworkFailures: activity.networkFailures.length,
    }
    const sections = [actionContent]
    if (activityBlock) sections.push(activityBlock)
    sections.push(formatSnapshotBlock(snap))
    return {
      content: sections.join('\n\n'),
      isError: false,
      metadata: {
        ...extraMetadata,
        kind: 'browser-snapshot',
        targetId: snap.targetId,
        url: snap.url,
        title: snap.title,
        elementCount: snap.elementCount,
        truncated: snap.truncated,
        supersedable: true,
        ...activityCounts,
      },
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      content: `${actionContent}\n\n[Could not capture page state: ${msg}]`,
      isError: false,
      metadata: extraMetadata,
    }
  }
}

// ---------------------------------------------------------------------------
// browser_navigate
// ---------------------------------------------------------------------------

export const browserNavigate: Tool = defineTool({
  name: 'browser_navigate',
  description:
    'Navigate the browser to a URL.\n' +
    '- Opens the page and waits for DOM content to load.\n' +
    '- Returns the final URL, page title, and HTTP status.\n' +
    '- After navigating, use browser_snapshot to understand the page content.\n' +
    '- Private LAN/internal URLs (10.x, 192.168.x, *.local) are blocked. ' +
    'localhost is reachable on desktop (preview a local dev server) but ' +
    'blocked in the cloud packaging.\n' +
    '- Use targetId to navigate a specific tab (omit for the active tab).',
  category: 'browser',
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Navigated', primaryField: 'url' },
    openAction: { target: 'url', pathField: 'url' },
  },
  isReadOnly: false,
  requiresPermission: true,
  timeoutMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to navigate to. Must be http:// or https://.',
      },
      targetId: {
        type: 'string',
        description: 'Target tab ID. Omit to use the active tab.',
      },
      attachSnapshot: ATTACH_SNAPSHOT_SCHEMA,
    },
    required: ['url'],
  },
  async execute(input, context) {
    try {
      const conn = await getConnection(context)
      const page = await getTargetPage(conn, input, context)
      const result = await navigatePage(page, input.url as string, {
        allowLoopback: loopbackAllowed(context),
      })

      const action = `Navigated to: ${result.url}\nStatus: ${result.status ?? 'unknown'}`
      return withSnapshot(page, action, input.attachSnapshot !== false, {
        url: result.url,
        title: result.title,
        status: result.status,
      })
    } catch (e) {
      return browserError(e)
    }
  },
})

// ---------------------------------------------------------------------------
// browser_click
// ---------------------------------------------------------------------------

export const browserClick: Tool = defineTool({
  name: 'browser_click',
  description:
    'Click an element on the page.\n' +
    '- Use "selector" for CSS selectors (e.g., "button.submit", "#login").\n' +
    '- Use "ref" for aria snapshot refs (e.g., "e12" from browser_snapshot output).\n' +
    '- Exactly one of selector or ref must be provided.\n' +
    '- Use doubleClick for double-click actions.\n' +
    '- Use browser_snapshot first to discover available elements and their refs.',
  category: 'browser',
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Clicked', primaryField: 'selector' },
  },
  isReadOnly: false,
  requiresPermission: true,
  timeoutMs: 10_000,
  inputSchema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector for the element to click.',
      },
      ref: {
        type: 'string',
        description: 'Aria snapshot ref from browser_snapshot output.',
      },
      doubleClick: {
        type: 'boolean',
        description: 'Double-click instead of single click. Default: false.',
      },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'Mouse button to use. Default: "left".',
      },
      targetId: {
        type: 'string',
        description: 'Target tab ID. Omit for active tab.',
      },
      attachSnapshot: ATTACH_SNAPSHOT_SCHEMA,
    },
    required: [],
  },
  async execute(input, context) {
    const { selector, ref } = input as { selector?: string; ref?: string }

    if (!selector && !ref) {
      return { content: 'Either "selector" or "ref" must be provided.', isError: true }
    }

    try {
      const conn = await getConnection(context)
      const page = await getTargetPage(conn, input, context)
      const result = await clickElement(page, {
        selector: selector,
        ref: ref,
        doubleClick: input.doubleClick as boolean | undefined,
        button: input.button as 'left' | 'right' | 'middle' | undefined,
        timeoutMs: 10_000,
      })

      return withSnapshot(page, result, input.attachSnapshot !== false, { selector, ref })
    } catch (e) {
      return browserError(e)
    }
  },
})

// ---------------------------------------------------------------------------
// browser_type
// ---------------------------------------------------------------------------

export const browserType: Tool = defineTool({
  name: 'browser_type',
  description:
    'Type text into an element on the page.\n' +
    '- Use "selector" for CSS selectors or "ref" for aria snapshot refs.\n' +
    '- Text replaces existing content by default (fill behavior).\n' +
    '- Set slowly=true to type character by character (for autocomplete fields).\n' +
    '- Set submit=true to press Enter after typing (for search boxes, forms).',
  category: 'browser',
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Typed', primaryField: 'text' },
  },
  isReadOnly: false,
  requiresPermission: true,
  timeoutMs: 10_000,
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to type.',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for the input element.',
      },
      ref: {
        type: 'string',
        description: 'Aria snapshot ref from browser_snapshot output.',
      },
      submit: {
        type: 'boolean',
        description: 'Press Enter after typing. Default: false.',
      },
      slowly: {
        type: 'boolean',
        description: 'Type character by character with delay. Use for autocomplete fields. Default: false.',
      },
      targetId: {
        type: 'string',
        description: 'Target tab ID. Omit for active tab.',
      },
      attachSnapshot: ATTACH_SNAPSHOT_SCHEMA,
    },
    required: ['text'],
  },
  async execute(input, context) {
    const { text, selector, ref } = input as { text: string; selector?: string; ref?: string }

    if (!selector && !ref) {
      return { content: 'Either "selector" or "ref" must be provided.', isError: true }
    }

    try {
      const conn = await getConnection(context)
      const page = await getTargetPage(conn, input, context)
      const result = await typeIntoElement(page, {
        selector,
        ref,
        text,
        submit: input.submit as boolean | undefined,
        slowly: input.slowly as boolean | undefined,
        timeoutMs: 10_000,
      })

      return withSnapshot(page, result, input.attachSnapshot !== false, {
        textLength: text.length,
        submit: input.submit,
      })
    } catch (e) {
      return browserError(e)
    }
  },
})

// ---------------------------------------------------------------------------
// browser_screenshot
// ---------------------------------------------------------------------------

export const browserScreenshot: Tool = defineTool({
  name: 'browser_screenshot',
  description:
    'Capture a screenshot of the current page or a specific element.\n' +
    '- Returns a base64 image in metadata (not in the text content).\n' +
    '- Use fullPage=true for a full scrollable page screenshot.\n' +
    '- Use selector or ref to screenshot a specific element.\n' +
    '- Use after navigation or actions to verify results visually.',
  category: 'browser',
  uiDescriptor: {
    kind: 'image',
    summary: { verb: 'Captured', primaryField: 'selector' },
    preview: { contentField: 'imageData', format: 'image-thumb' },
  },
  isReadOnly: true,
  requiresPermission: false,
  timeoutMs: 15_000,
  inputSchema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector for an element to screenshot. Omit for full page.',
      },
      ref: {
        type: 'string',
        description: 'Aria snapshot ref from browser_snapshot output.',
      },
      fullPage: {
        type: 'boolean',
        description: 'Capture the full scrollable page. Default: false (viewport only).',
      },
      format: {
        type: 'string',
        enum: ['png', 'jpeg'],
        description: 'Image format. Default: "png".',
      },
      targetId: {
        type: 'string',
        description: 'Target tab ID. Omit for active tab.',
      },
    },
    required: [],
  },
  async execute(input, context) {
    try {
      const conn = await getConnection(context)
      const page = await getTargetPage(conn, input, context)
      const result = await takeScreenshot(page, {
        selector: input.selector as string | undefined,
        ref: input.ref as string | undefined,
        fullPage: input.fullPage as boolean | undefined,
        format: input.format as 'png' | 'jpeg' | undefined,
      })

      const pageTitle = await page.title()
      const pageUrl = page.url()

      return {
        content: `Screenshot captured of "${pageTitle}" (${pageUrl}).\nFormat: ${result.format}, size: ${Math.round(result.data.length * 0.75 / 1024)}KB`,
        isError: false,
        metadata: {
          image: result.data,
          format: result.format,
          url: pageUrl,
          title: pageTitle,
        },
      }
    } catch (e) {
      return browserError(e)
    }
  },
})

// ---------------------------------------------------------------------------
// browser_snapshot
// ---------------------------------------------------------------------------

export const browserSnapshot: Tool = defineTool({
  name: 'browser_snapshot',
  description:
    'Get an accessibility snapshot of the page content.\n' +
    '- Returns a text representation of the page\'s accessibility tree.\n' +
    '- Shows interactive elements (buttons, links, inputs) with ref IDs.\n' +
    '- Use ref IDs from the snapshot output in browser_click and browser_type.\n' +
    '- Lighter than screenshots — preferred for understanding page structure.\n' +
    '- Use after navigation to understand the page before interacting.',
  category: 'browser',
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Read page' },
    preview: { contentField: 'snapshot', format: 'plain', truncateAtLines: 10 },
  },
  isReadOnly: true,
  requiresPermission: false,
  timeoutMs: 10_000,
  inputSchema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector to snapshot a specific section. Omit for full page.',
      },
      ref: {
        type: 'string',
        description: 'Aria snapshot ref to snapshot a specific subtree.',
      },
      maxChars: {
        type: 'number',
        description: 'Maximum characters in the snapshot. Default: 80000.',
      },
      targetId: {
        type: 'string',
        description: 'Target tab ID. Omit for active tab.',
      },
    },
    required: [],
  },
  async execute(input, context) {
    try {
      const conn = await getConnection(context)
      const page = await getTargetPage(conn, input, context)
      const snap = await capturePageSnapshot(page, {
        selector: input.selector as string | undefined,
        ref: input.ref as string | undefined,
        maxChars: input.maxChars as number | undefined,
      })

      return {
        content: formatSnapshotBlock(snap),
        isError: false,
        metadata: {
          kind: 'browser-snapshot',
          targetId: snap.targetId,
          url: snap.url,
          title: snap.title,
          elementCount: snap.elementCount,
          truncated: snap.truncated,
          supersedable: true,
        },
      }
    } catch (e) {
      return browserError(e)
    }
  },
})

// ---------------------------------------------------------------------------
// browser_evaluate
// ---------------------------------------------------------------------------

export const browserEvaluate: Tool = defineTool({
  name: 'browser_evaluate',
  description:
    'Execute JavaScript code in the browser context.\n' +
    '- Use for DOM manipulation, data extraction, or page interaction.\n' +
    '- The expression is evaluated in the page\'s JavaScript context.\n' +
    '- Returns the stringified result (JSON for objects, raw for strings).\n' +
    '- Has a 10-second timeout by default.\n' +
    '- Prefer browser_click and browser_type for standard interactions.',
  category: 'browser',
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Evaluated', primaryField: 'expression' },
    preview: { contentField: 'result', format: 'code', truncateAtLines: 10 },
  },
  isReadOnly: false,
  requiresPermission: true,
  timeoutMs: 15_000,
  inputSchema: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'JavaScript expression to evaluate in the browser context.',
      },
      targetId: {
        type: 'string',
        description: 'Target tab ID. Omit for active tab.',
      },
    },
    required: ['expression'],
  },
  async execute(input, context) {
    try {
      const conn = await getConnection(context)
      const page = await getTargetPage(conn, input, context)
      const result = await evaluateScript(page, input.expression as string)

      // Truncate large results — head+tail keeps both the entry point and
      // any final return value or thrown error visible.
      const maxLen = 50_000
      const truncated = Buffer.byteLength(result, 'utf8') > maxLen
      const content = truncated ? headTailTruncate(result, maxLen) : result

      return {
        content,
        isError: false,
        metadata: { truncated, resultLength: result.length },
      }
    } catch (e) {
      return browserError(e)
    }
  },
})

// ---------------------------------------------------------------------------
// browser_tab_list
// ---------------------------------------------------------------------------

export const browserTabList: Tool = defineTool({
  name: 'browser_tab_list',
  description:
    'List all open tabs in the browser.\n' +
    '- Shows each tab\'s target ID, URL, and title.\n' +
    '- Use target IDs from this output in other browser tools.\n' +
    '- Useful for finding or switching between tabs.',
  category: 'browser',
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Listed tabs' },
  },
  isReadOnly: true,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(_input, context) {
    try {
      const conn = await getConnection(context)
      const tabs = await listTabs(conn)

      if (tabs.length === 0) {
        return { content: 'No tabs open.', isError: false, metadata: { tabCount: 0 } }
      }

      const formatted = tabs.map((tab, i) =>
        `${i + 1}. [${tab.targetId}] ${tab.title}\n   ${tab.url}`,
      ).join('\n\n')

      return {
        content: `Open tabs (${tabs.length}):\n\n${formatted}`,
        isError: false,
        metadata: { tabCount: tabs.length, tabs },
      }
    } catch (e) {
      return browserError(e)
    }
  },
})

// ---------------------------------------------------------------------------
// browser_tab_open
// ---------------------------------------------------------------------------

export const browserTabOpen: Tool = defineTool({
  name: 'browser_tab_open',
  description:
    'Open a new tab and navigate to a URL.\n' +
    '- Returns the new tab\'s target ID, URL, and title.\n' +
    '- Use the target ID in other browser tools to interact with this tab.\n' +
    '- Private LAN/internal URLs are blocked (SSRF protection); localhost is ' +
    'reachable on desktop but blocked in the cloud packaging.',
  category: 'browser',
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Opened tab', primaryField: 'url' },
    openAction: { target: 'url', pathField: 'url' },
  },
  isReadOnly: false,
  requiresPermission: true,
  timeoutMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to open in the new tab.',
      },
      attachSnapshot: ATTACH_SNAPSHOT_SCHEMA,
    },
    required: ['url'],
  },
  async execute(input, context) {
    try {
      const conn = await getConnection(context)
      const cfg = context.config as Record<string, unknown>

      // Preferred path on hosts that can't create CDP targets themselves
      // (an embedded Electron browser): ask the HOST to create a real tab via
      // its broker hook, then drive that new tab. This is how the agent opens
      // its own tabs in the desktop app.
      const createHook = cfg.browserCreateTabHook as
        | ((url: string) => Promise<{ targetId: string; url: string; title?: string }>)
        | undefined
      if (typeof createHook === 'function') {
        const created = await createHook(input.url as string)
        // The new target registers asynchronously over CDP — retry briefly.
        let page = null as Awaited<ReturnType<typeof getPage>> | null
        for (let i = 0; i < 6 && page == null; i++) {
          try {
            page = await getPage(conn, created.targetId)
          } catch {
            await new Promise((r) => setTimeout(r, 150))
          }
        }
        if (page == null) page = await getPage(conn, created.targetId)
        trackPageState(page)
        const action = `New tab opened:\n  ID: ${created.targetId}\n  URL: ${created.url}`
        return withSnapshot(page, action, input.attachSnapshot !== false, {
          openedTargetId: created.targetId,
          url: created.url,
          ...(created.title != null ? { title: created.title } : {}),
        })
      }

      try {
        const tab = await openTab(conn, input.url as string, {
          allowLoopback: loopbackAllowed(context),
        })
        const page = await getPage(conn, tab.targetId)

        const action =
          `New tab opened:\n  ID: ${tab.targetId}\n  URL: ${tab.url}`
        return withSnapshot(page, action, input.attachSnapshot !== false, {
          openedTargetId: tab.targetId,
          url: tab.url,
          title: tab.title,
        })
      } catch (tabErr) {
        // Some hosts can't create new browser targets over CDP — notably an
        // embedded Electron browser view (`Target.createTarget: Not
        // supported`). Fall back to navigating the agent's CURRENT page in
        // place so the browse still proceeds; the model is told tabs aren't
        // available here so it adapts. We navigate the PINNED target
        // (`getTargetPage` honors `browserDefaultTargetId`) so the fallback
        // can never touch the host app's own UI.
        const msg = tabErr instanceof Error ? tabErr.message : String(tabErr)
        if (!/Target\.createTarget|not supported/i.test(msg)) throw tabErr
        const page = await getTargetPage(conn, input, context)
        const result = await navigatePage(page, input.url as string, {
          allowLoopback: loopbackAllowed(context),
        })
        const action =
          `Opened in the current tab (this browser doesn't support separate tabs):\n` +
          `  URL: ${result.url}\n  Status: ${result.status ?? 'unknown'}`
        return withSnapshot(page, action, input.attachSnapshot !== false, {
          url: result.url,
          title: result.title,
          status: result.status,
          inPlace: true,
        })
      }
    } catch (e) {
      return browserError(e)
    }
  },
})

// ---------------------------------------------------------------------------
// browser_tab_close
// ---------------------------------------------------------------------------

export const browserTabClose: Tool = defineTool({
  name: 'browser_tab_close',
  description:
    'Close a browser tab by its target ID.\n' +
    '- Use browser_tab_list to find available target IDs.\n' +
    '- Cannot close the last remaining tab.',
  category: 'browser',
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Closed tab', primaryField: 'targetId' },
  },
  isReadOnly: false,
  requiresPermission: true,
  inputSchema: {
    type: 'object',
    properties: {
      targetId: {
        type: 'string',
        description: 'The target ID of the tab to close.',
      },
    },
    required: ['targetId'],
  },
  async execute(input, context) {
    try {
      const conn = await getConnection(context)
      await closeTab(conn, input.targetId as string)

      return {
        content: `Tab ${input.targetId} closed.`,
        isError: false,
        metadata: { targetId: input.targetId },
      }
    } catch (e) {
      return browserError(e)
    }
  },
})

// ---------------------------------------------------------------------------
// browser_console
// ---------------------------------------------------------------------------

export const browserConsole: Tool = defineTool({
  name: 'browser_console',
  description:
    'Get console messages and errors from the current page.\n' +
    '- Shows recent console.log, console.error, and uncaught errors.\n' +
    '- Useful for debugging page issues or verifying script execution.\n' +
    '- Tracks up to 200 console messages and 100 errors per page.',
  category: 'browser',
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Read console' },
    preview: { contentField: 'messages', format: 'plain', truncateAtLines: 10 },
  },
  isReadOnly: true,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      targetId: {
        type: 'string',
        description: 'Target tab ID. Omit for active tab.',
      },
      clear: {
        type: 'boolean',
        description: 'Clear the console buffer after reading. Default: false.',
      },
    },
    required: [],
  },
  async execute(input, context) {
    try {
      const conn = await getConnection(context)
      const page = await getTargetPage(conn, input, context)
      const state = getPageState(page)

      if (!state) {
        return {
          content: 'No console data tracked for this page. Navigate to a page first.',
          isError: false,
          metadata: { messageCount: 0, errorCount: 0 },
        }
      }

      const parts: string[] = []

      if (state.consoleMessages.length > 0) {
        parts.push(`Console messages (${state.consoleMessages.length}):`)
        for (const msg of state.consoleMessages.slice(-50)) {
          parts.push(`  [${msg.type}] ${msg.text}`)
        }
      } else {
        parts.push('No console messages.')
      }

      if (state.errors.length > 0) {
        parts.push('')
        parts.push(`Page errors (${state.errors.length}):`)
        for (const err of state.errors.slice(-20)) {
          parts.push(`  ERROR: ${err}`)
        }
      }

      if (input.clear) {
        state.consoleMessages.length = 0
        state.errors.length = 0
      }

      return {
        content: parts.join('\n'),
        isError: false,
        metadata: {
          messageCount: state.consoleMessages.length,
          errorCount: state.errors.length,
        },
      }
    } catch (e) {
      return browserError(e)
    }
  },
})

// ---------------------------------------------------------------------------
// browser_hover
// ---------------------------------------------------------------------------

export const browserHover: Tool = defineTool({
  name: 'browser_hover',
  description:
    'Hover over an element on the page.\n' +
    '- Use to reveal tooltips, dropdown menus, or hidden elements.\n' +
    '- Some UIs require hover before an element becomes clickable.\n' +
    '- Use selector or ref to target the element.',
  category: 'browser',
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Hovered', primaryField: 'selector' },
  },
  isReadOnly: false,
  requiresPermission: true,
  timeoutMs: 10_000,
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector for the element.' },
      ref: { type: 'string', description: 'Aria snapshot ref.' },
      targetId: { type: 'string', description: 'Target tab ID.' },
      attachSnapshot: ATTACH_SNAPSHOT_SCHEMA,
    },
    required: [],
  },
  async execute(input, context) {
    const { selector, ref } = input as { selector?: string; ref?: string }
    if (!selector && !ref) return { content: 'Either "selector" or "ref" must be provided.', isError: true }
    try {
      const conn = await getConnection(context)
      const page = await getTargetPage(conn, input, context)
      const result = await hoverElement(page, { selector, ref })
      return withSnapshot(page, result, input.attachSnapshot !== false, { selector, ref })
    } catch (e) { return browserError(e) }
  },
})

// ---------------------------------------------------------------------------
// browser_select
// ---------------------------------------------------------------------------

export const browserSelect: Tool = defineTool({
  name: 'browser_select',
  description:
    'Select an option from a dropdown (<select>) element.\n' +
    '- Use "value" for the option value attribute.\n' +
    '- Use "label" for the visible text.\n' +
    '- Use "index" for position (0-based).\n' +
    '- Exactly one of value, label, or index must be provided.',
  category: 'browser',
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Selected', primaryField: 'value' },
  },
  isReadOnly: false,
  requiresPermission: true,
  timeoutMs: 10_000,
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector for the <select> element.' },
      ref: { type: 'string', description: 'Aria snapshot ref.' },
      value: { type: 'string', description: 'Option value attribute to select.' },
      label: { type: 'string', description: 'Option visible text to select.' },
      index: { type: 'number', description: 'Option index (0-based).' },
      targetId: { type: 'string', description: 'Target tab ID.' },
      attachSnapshot: ATTACH_SNAPSHOT_SCHEMA,
    },
    required: [],
  },
  async execute(input, context) {
    const { selector, ref, value, label, index } = input as {
      selector?: string; ref?: string; value?: string; label?: string; index?: number
    }
    if (!selector && !ref) return { content: 'Either "selector" or "ref" must be provided.', isError: true }
    if (value === undefined && label === undefined && index === undefined) {
      return { content: 'One of "value", "label", or "index" must be provided.', isError: true }
    }
    try {
      const conn = await getConnection(context)
      const page = await getTargetPage(conn, input, context)
      const result = await selectOption(page, { selector, ref, value, label, index })
      return withSnapshot(page, result, input.attachSnapshot !== false, {
        selector, ref, value, label, index,
      })
    } catch (e) { return browserError(e) }
  },
})

// ---------------------------------------------------------------------------
// browser_press_key
// ---------------------------------------------------------------------------

export const browserPressKey: Tool = defineTool({
  name: 'browser_press_key',
  description:
    'Press a keyboard key.\n' +
    '- Use for non-text keys: Enter, Tab, Escape, ArrowDown, ArrowUp, Backspace, Delete, etc.\n' +
    '- Use key combinations: "Control+a", "Shift+Tab", "Meta+c".\n' +
    '- Optionally target a specific element with selector/ref.\n' +
    '- For typing text, use browser_type instead.',
  category: 'browser',
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Pressed', primaryField: 'key' },
  },
  isReadOnly: false,
  requiresPermission: true,
  timeoutMs: 5_000,
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Key to press (e.g., "Enter", "Tab", "ArrowDown", "Control+a").' },
      selector: { type: 'string', description: 'CSS selector to focus before pressing. Optional.' },
      ref: { type: 'string', description: 'Aria snapshot ref to focus before pressing. Optional.' },
      targetId: { type: 'string', description: 'Target tab ID.' },
      attachSnapshot: ATTACH_SNAPSHOT_SCHEMA,
    },
    required: ['key'],
  },
  async execute(input, context) {
    try {
      const conn = await getConnection(context)
      const page = await getTargetPage(conn, input, context)
      const result = await pressKey(page, input.key as string, {
        selector: input.selector as string | undefined,
        ref: input.ref as string | undefined,
      })
      return withSnapshot(page, result, input.attachSnapshot !== false, { key: input.key })
    } catch (e) { return browserError(e) }
  },
})

// ---------------------------------------------------------------------------
// browser_drag
// ---------------------------------------------------------------------------

export const browserDrag: Tool = defineTool({
  name: 'browser_drag',
  description:
    'Drag an element and drop it on another element.\n' +
    '- Specify source and target using CSS selectors or aria refs.\n' +
    '- Use for drag-and-drop UI interactions (reordering, file upload zones, etc.).',
  category: 'browser',
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Dragged', primaryField: 'sourceSelector' },
  },
  isReadOnly: false,
  requiresPermission: true,
  timeoutMs: 10_000,
  inputSchema: {
    type: 'object',
    properties: {
      sourceSelector: { type: 'string', description: 'CSS selector for the element to drag.' },
      sourceRef: { type: 'string', description: 'Aria ref for the element to drag.' },
      targetSelector: { type: 'string', description: 'CSS selector for the drop target.' },
      targetRef: { type: 'string', description: 'Aria ref for the drop target.' },
      targetId: { type: 'string', description: 'Target tab ID.' },
      attachSnapshot: ATTACH_SNAPSHOT_SCHEMA,
    },
    required: [],
  },
  async execute(input, context) {
    const { sourceSelector, sourceRef, targetSelector, targetRef } = input as {
      sourceSelector?: string; sourceRef?: string; targetSelector?: string; targetRef?: string
    }
    if (!sourceSelector && !sourceRef) return { content: 'Source element must be specified (sourceSelector or sourceRef).', isError: true }
    if (!targetSelector && !targetRef) return { content: 'Target element must be specified (targetSelector or targetRef).', isError: true }
    try {
      const conn = await getConnection(context)
      const page = await getTargetPage(conn, input, context)
      const result = await dragElement(page, { sourceSelector, sourceRef, targetSelector, targetRef })
      return withSnapshot(page, result, input.attachSnapshot !== false, {
        sourceSelector, sourceRef, targetSelector, targetRef,
      })
    } catch (e) { return browserError(e) }
  },
})

// ---------------------------------------------------------------------------
// browser_fill_form
// ---------------------------------------------------------------------------

export const browserFillForm: Tool = defineTool({
  name: 'browser_fill_form',
  description:
    'Fill multiple form fields at once.\n' +
    '- Provide an array of fields, each with a selector/ref, value, and optional type.\n' +
    '- Supported types: "text" (default), "checkbox", "select".\n' +
    '- More efficient than calling browser_type for each field individually.\n' +
    '- For checkboxes, use value "true" or "false".',
  category: 'browser',
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Filled form' },
  },
  isReadOnly: false,
  requiresPermission: true,
  timeoutMs: 15_000,
  inputSchema: {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        description: 'Array of form fields to fill.',
        items: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector for the field.' },
            ref: { type: 'string', description: 'Aria snapshot ref for the field.' },
            value: { type: 'string', description: 'Value to set.' },
            type: { type: 'string', enum: ['text', 'checkbox', 'select'], description: 'Field type. Default: "text".' },
          },
          required: ['value'],
        },
      },
      targetId: { type: 'string', description: 'Target tab ID.' },
      attachSnapshot: ATTACH_SNAPSHOT_SCHEMA,
    },
    required: ['fields'],
  },
  async execute(input, context) {
    const { fields } = input as { fields: Array<{ selector?: string; ref?: string; value: string; type?: 'text' | 'checkbox' | 'select' }> }
    if (!fields || fields.length === 0) return { content: 'No fields provided.', isError: true }
    for (const f of fields) {
      if (!f.selector && !f.ref) return { content: 'Each field must have a "selector" or "ref".', isError: true }
    }
    try {
      const conn = await getConnection(context)
      const page = await getTargetPage(conn, input, context)
      const result = await fillForm(page, fields)
      return withSnapshot(page, result, input.attachSnapshot !== false, {
        fieldCount: fields.length,
      })
    } catch (e) { return browserError(e) }
  },
})

// ---------------------------------------------------------------------------
// browser_wait
// ---------------------------------------------------------------------------

export const browserWait: Tool = defineTool({
  name: 'browser_wait',
  description:
    'Wait for a condition on the page.\n' +
    '- Wait for an element to appear: selector="button.submit"\n' +
    '- Wait for text to appear: text="Success"\n' +
    '- Wait for URL change: url="**/dashboard"\n' +
    '- Wait for page load: loadState="networkidle"\n' +
    '- Wait for a fixed time: timeMs=2000\n' +
    '- Only one condition at a time. Specify the most specific one.',
  category: 'browser',
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Waited' },
  },
  isReadOnly: true,
  requiresPermission: false,
  timeoutMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'Wait for this element to become visible.' },
      text: { type: 'string', description: 'Wait for this text to appear on the page.' },
      url: { type: 'string', description: 'Wait for the page URL to match this pattern.' },
      loadState: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'Wait for this page load state.' },
      timeMs: { type: 'number', description: 'Wait for a fixed number of milliseconds (max 30s).' },
      targetId: { type: 'string', description: 'Target tab ID.' },
    },
    required: [],
  },
  async execute(input, context) {
    try {
      const conn = await getConnection(context)
      const page = await getTargetPage(conn, input, context)
      const result = await waitForCondition(page, {
        selector: input.selector as string | undefined,
        text: input.text as string | undefined,
        url: input.url as string | undefined,
        loadState: input.loadState as 'load' | 'domcontentloaded' | 'networkidle' | undefined,
        timeMs: input.timeMs as number | undefined,
      })
      return { content: result, isError: false }
    } catch (e) { return browserError(e) }
  },
})

// ---------------------------------------------------------------------------
// browser_scroll
// ---------------------------------------------------------------------------

export const browserScroll: Tool = defineTool({
  name: 'browser_scroll',
  description:
    'Scroll an element into view.\n' +
    '- Use when an element exists but is off-screen.\n' +
    '- Scrolls the minimum amount needed to make the element visible.',
  category: 'browser',
  uiDescriptor: {
    kind: 'external-action',
    summary: { verb: 'Scrolled', primaryField: 'selector' },
  },
  isReadOnly: true,
  requiresPermission: false,
  timeoutMs: 5_000,
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector for the element to scroll to.' },
      ref: { type: 'string', description: 'Aria snapshot ref for the element.' },
      targetId: { type: 'string', description: 'Target tab ID.' },
    },
    required: [],
  },
  async execute(input, context) {
    const { selector, ref } = input as { selector?: string; ref?: string }
    if (!selector && !ref) return { content: 'Either "selector" or "ref" must be provided.', isError: true }
    try {
      const conn = await getConnection(context)
      const page = await getTargetPage(conn, input, context)
      const result = await scrollIntoView(page, { selector, ref })
      return { content: result, isError: false }
    } catch (e) { return browserError(e) }
  },
})

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const browserTools: Tool[] = [
  browserNavigate,
  browserClick,
  browserType,
  browserScreenshot,
  browserSnapshot,
  browserEvaluate,
  browserTabList,
  browserTabOpen,
  browserTabClose,
  browserConsole,
  browserHover,
  browserSelect,
  browserPressKey,
  browserDrag,
  browserFillForm,
  browserWait,
  browserScroll,
]
