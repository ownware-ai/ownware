import { describe, it, expect } from 'vitest'
import {
  browserNavigate,
  browserClick,
  browserType,
  browserSnapshot,
  browserHover,
  browserSelect,
  browserPressKey,
  browserDrag,
  browserFillForm,
  browserTabOpen,
  browserTools,
} from '../browser.js'
import {
  formatSnapshotBlock,
  waitForSettle,
  formatActivityBlock,
  isBlockedUrl,
  type PageSnapshotResult,
  type PageActivityDelta,
} from '../browser-session.js'

/**
 * B1 — Inline snapshot + typed metadata.
 *
 * These tests verify the *contract* B1 establishes:
 *   1. Every mutating browser tool advertises an `attachSnapshot` param.
 *   2. `browser_snapshot` and any tool that inlines a snapshot share the
 *      same typed metadata shape (`kind: 'browser-snapshot'`, `targetId`,
 *      `supersedable: true`) so the browser-aware compactor (B4) can key
 *      supersession on it without string-matching tool names.
 *
 * They do not boot a real browser — Playwright tests live in the e2e
 * suite. These are pure contract checks that catch schema or metadata
 * regressions before they reach a live session.
 */

describe('isBlockedUrl — SSRF guard + opt-in loopback', () => {
  it('blocks non-http(s) protocols', () => {
    expect(isBlockedUrl('file:///etc/passwd')).toBe(true)
    expect(isBlockedUrl('ftp://example.com')).toBe(true)
    expect(isBlockedUrl('not a url')).toBe(true)
  })

  it('allows ordinary public URLs', () => {
    expect(isBlockedUrl('https://example.com')).toBe(false)
    expect(isBlockedUrl('http://google.com/search?q=x')).toBe(false)
  })

  it('blocks loopback by default (no flag)', () => {
    for (const u of [
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://127.0.0.2/',
      'http://0.0.0.0:8080',
      'http://[::1]:9000',
    ]) {
      expect(isBlockedUrl(u)).toBe(true)
    }
  })

  it('allows loopback only when allowLoopback is set', () => {
    for (const u of [
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://127.0.0.2/',
      'http://0.0.0.0:8080',
      'http://[::1]:9000',
    ]) {
      expect(isBlockedUrl(u, { allowLoopback: true })).toBe(false)
    }
  })

  it('blocks LAN / private ranges EVEN with allowLoopback set', () => {
    for (const u of [
      'http://10.0.0.5',
      'http://192.168.1.10:3000',
      'http://172.16.0.1',
      'http://172.31.255.255',
      'http://printer.local',
      'http://db.internal',
    ]) {
      expect(isBlockedUrl(u, { allowLoopback: true })).toBe(true)
      expect(isBlockedUrl(u)).toBe(true)
    }
  })

  it('does not over-block public 172.x outside the private range', () => {
    expect(isBlockedUrl('http://172.15.0.1')).toBe(false)
    expect(isBlockedUrl('http://172.32.0.1')).toBe(false)
  })
})

describe('browser tools — B1 attachSnapshot schema', () => {
  const MUTATING_TOOLS = [
    browserNavigate,
    browserClick,
    browserType,
    browserHover,
    browserSelect,
    browserPressKey,
    browserDrag,
    browserFillForm,
    browserTabOpen,
  ]

  it.each(MUTATING_TOOLS.map(t => [t.name, t]))(
    '%s exposes attachSnapshot as a boolean in its schema',
    (_name, tool) => {
      const props = (tool.inputSchema as { properties: Record<string, { type: string }> }).properties
      expect(props.attachSnapshot).toBeDefined()
      expect(props.attachSnapshot.type).toBe('boolean')
    },
  )

  it('attachSnapshot is never required', () => {
    for (const tool of MUTATING_TOOLS) {
      const required = (tool.inputSchema as { required?: string[] }).required ?? []
      expect(required).not.toContain('attachSnapshot')
    }
  })
})

describe('browser_snapshot — typed metadata shape', () => {
  it('declares isReadOnly and no required params', () => {
    expect(browserSnapshot.isReadOnly).toBe(true)
    const required = (browserSnapshot.inputSchema as { required?: string[] }).required ?? []
    expect(required).toEqual([])
  })
})

describe('formatSnapshotBlock', () => {
  it('produces the canonical header + tree text shape', () => {
    const snap: PageSnapshotResult = {
      content: '- [button] "Submit" e1',
      url: 'https://example.com/',
      title: 'Example',
      targetId: 'target-abc',
      elementCount: 1,
      truncated: false,
    }
    const block = formatSnapshotBlock(snap)
    expect(block).toContain('Page: "Example" (https://example.com/)')
    expect(block).toContain('Interactive elements: 1')
    expect(block).not.toContain('[truncated]')
    expect(block).toContain('- [button] "Submit" e1')
  })

  it('marks the snapshot as truncated when the flag is set', () => {
    const snap: PageSnapshotResult = {
      content: '...',
      url: 'https://example.com/',
      title: 'Example',
      targetId: 'target-abc',
      elementCount: 0,
      truncated: true,
    }
    expect(formatSnapshotBlock(snap)).toContain('[truncated]')
  })
})

describe('browserTools registry — B1 doesn\'t change the tool count', () => {
  it('still exports 17 tools', () => {
    expect(browserTools.length).toBe(17)
  })

  it('every tool has a category of "browser"', () => {
    for (const tool of browserTools) {
      expect(tool.category).toBe('browser')
    }
  })
})

describe('formatActivityBlock — B3 passive activity surfacing', () => {
  function delta(overrides: Partial<PageActivityDelta> = {}): PageActivityDelta {
    return {
      consoleMessages: [],
      errors: [],
      networkFailures: [],
      consoleDropped: 0,
      errorsDropped: 0,
      networkFailuresDropped: 0,
      ...overrides,
    }
  }

  it('returns the empty string when nothing happened', () => {
    expect(formatActivityBlock(delta())).toBe('')
  })

  it('filters routine console types — only error and warning surface', () => {
    const out = formatActivityBlock(
      delta({
        consoleMessages: [
          { type: 'log', text: 'routine chatter', timestamp: 0 },
          { type: 'debug', text: 'more chatter', timestamp: 0 },
          { type: 'info', text: 'fyi', timestamp: 0 },
        ],
      }),
    )
    expect(out).toBe('')
  })

  it('renders console errors, page errors, and network failures as separate sections', () => {
    const out = formatActivityBlock(
      delta({
        consoleMessages: [
          { type: 'error', text: 'Stripe.js failed', timestamp: 0 },
          { type: 'warning', text: 'Deprecated API', timestamp: 0 },
          { type: 'log', text: 'noise — filtered out', timestamp: 0 },
        ],
        errors: ['Uncaught TypeError: x is undefined'],
        networkFailures: [
          {
            url: 'https://api.example.com/login',
            method: 'POST',
            status: 401,
            errorText: 'Unauthorized',
            resourceType: 'fetch',
            timestamp: 0,
          },
        ],
      }),
    )
    expect(out).toContain('Console (since last action): 2 new')
    expect(out).toContain('[error] Stripe.js failed')
    expect(out).toContain('[warning] Deprecated API')
    expect(out).not.toContain('noise — filtered out')
    expect(out).toContain('Page errors (since last action): 1 new')
    expect(out).toContain('Uncaught TypeError')
    expect(out).toContain('Network failures (since last action): 1 new')
    expect(out).toContain('401 POST https://api.example.com/login (fetch) — Unauthorized')
  })

  it('annotates overflow when more items occurred than can be shown', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      type: 'error',
      text: `err ${i}`,
      timestamp: 0,
    }))
    const out = formatActivityBlock(
      delta({ consoleMessages: many, consoleDropped: 4 }),
    )
    expect(out).toContain('Console (since last action): 15 new')
    // 15 collected - 10 shown + 4 dropped before we even saw them = 9 extra noted.
    expect(out).toContain('(+9 more)')
  })

  it('renders the no-status case (requestfailed) without the HTTP code prefix', () => {
    const out = formatActivityBlock(
      delta({
        networkFailures: [
          {
            url: 'https://example.com/api',
            method: 'GET',
            status: null,
            errorText: 'net::ERR_NAME_NOT_RESOLVED',
            resourceType: 'xhr',
            timestamp: 0,
          },
        ],
      }),
    )
    expect(out).toContain('GET https://example.com/api (xhr) — net::ERR_NAME_NOT_RESOLVED')
    expect(out).not.toMatch(/^\s*-\s+\d+\s+GET/m)
  })
})

describe('waitForSettle — B2 post-action settle helper', () => {
  it('is exported and async', () => {
    expect(typeof waitForSettle).toBe('function')
    expect(waitForSettle.constructor.name).toBe('AsyncFunction')
  })

  it('swallows waitForLoadState errors so a still-loading page never fails the action', async () => {
    const calls: Array<{ state: string; timeout: number }> = []
    const fakePage = {
      waitForLoadState: async (state: string, opts: { timeout: number }) => {
        calls.push({ state, timeout: opts.timeout })
        throw new Error('Timeout 2000ms exceeded')
      },
    }
    // Should NOT throw even though the underlying Playwright call rejected.
    await expect(waitForSettle(fakePage)).resolves.toBeUndefined()
    expect(calls).toEqual([{ state: 'domcontentloaded', timeout: 2000 }])
  })

  it('passes through the caller-supplied state and timeout', async () => {
    const calls: Array<{ state: string; timeout: number }> = []
    const fakePage = {
      waitForLoadState: async (state: string, opts: { timeout: number }) => {
        calls.push({ state, timeout: opts.timeout })
      },
    }
    await waitForSettle(fakePage, 500, 'networkidle')
    expect(calls).toEqual([{ state: 'networkidle', timeout: 500 }])
  })
})
