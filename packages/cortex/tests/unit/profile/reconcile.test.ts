/**
 * reconcile.ts — unit tests.
 *
 * Locks in the eight reliability scenarios from board_live-tool-
 * reconcile_2026-04-24.md:
 *   1. Idempotency — identical state ⇒ zero add/remove calls.
 *   2. Add-only — new tool in desired ⇒ one addTool.
 *   3. Remove-only — tool gone from desired ⇒ one removeTool.
 *   4. Mixed — add + remove + unchanged in one pass.
 *   5. Provider failure — one provider throws ⇒ others still apply,
 *      error recorded, session state unchanged.
 *   6. Empty declared list — every connector tool removed.
 *   7. Duplicate names across providers — first wins, error recorded.
 *   8. addTool throw → captured in errors, NOT re-thrown, managed
 *      snapshot reflects the failure so the next reconcile retries.
 *
 * No Loom dependency beyond the `Session` shape — we stub a minimal
 * session that records `addTool`/`removeTool` calls. That's the
 * contract: reconcile does not reach into session internals.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Session, Tool } from '@ownware/loom'
import type {
  ConnectorToolProvider,
  ConnectorToolProviderResult,
} from '../../../src/connector/providers/types.js'
import type { LoadedProfile } from '../../../src/profile/loader.js'
import {
  initialManagedTools,
  reconcileSessionTools,
  type ManagedTools,
} from '../../../src/profile/reconcile.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeTool(name: string, overrides: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    async execute() { return { content: 'ok', isError: false } },
    ...overrides,
  } as Tool
}

interface FakeSession {
  readonly installed: Tool[]
  readonly addTool: (t: Tool) => void
  readonly removeTool: (name: string) => void
  readonly addLog: Tool[]
  readonly removeLog: string[]
}

function makeSession(seed: readonly Tool[] = []): FakeSession {
  const installed: Tool[] = [...seed]
  const addLog: Tool[] = []
  const removeLog: string[] = []
  return {
    installed,
    addLog,
    removeLog,
    addTool(t: Tool) {
      if (installed.some((x) => x.name === t.name)) {
        throw new Error(`duplicate tool ${t.name}`)
      }
      installed.push(t)
      addLog.push(t)
    },
    removeTool(name: string) {
      const idx = installed.findIndex((t) => t.name === name)
      if (idx === -1) throw new Error(`tool not found ${name}`)
      installed.splice(idx, 1)
      removeLog.push(name)
    },
  }
}

function makeProvider(
  source: string,
  impl: () => Promise<ConnectorToolProviderResult> | ConnectorToolProviderResult,
): ConnectorToolProvider {
  return {
    source,
    async getToolsForProfile() { return impl() },
  }
}

function makeProfile(): LoadedProfile {
  return {
    name: 'example',
    config: { tools: { composio: { toolkits: [] } } },
  } as unknown as LoadedProfile
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('reconcileSessionTools — idempotency', () => {
  it('is a no-op when the desired set matches the prior snapshot', async () => {
    const gmail = makeTool('composio_gmail_search')
    const session = makeSession([gmail])
    const prior = initialManagedTools([gmail])
    const provider = makeProvider('composio', () => ({
      tools: [gmail],
      stubs: [],
    }))

    const result = await reconcileSessionTools(
      session as unknown as Session,
      prior,
      makeProfile(),
      { providers: [provider], log: () => {} },
    )

    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
    expect(session.addLog).toEqual([])
    expect(session.removeLog).toEqual([])
    expect(result.errors).toEqual([])
  })
})

describe('reconcileSessionTools — add-only', () => {
  it('installs a brand-new connector tool on the session', async () => {
    const gmail = makeTool('composio_gmail_search')
    const session = makeSession([])
    const prior: ManagedTools = new Map()
    const provider = makeProvider('composio', () => ({
      tools: [gmail],
      stubs: [],
    }))

    const result = await reconcileSessionTools(
      session as unknown as Session,
      prior,
      makeProfile(),
      { providers: [provider], log: () => {} },
    )

    expect(result.added).toEqual(['composio_gmail_search'])
    expect(result.removed).toEqual([])
    expect(session.installed.map((t) => t.name)).toEqual(['composio_gmail_search'])
    expect(result.managed.has('composio_gmail_search')).toBe(true)
  })
})

describe('reconcileSessionTools — remove-only', () => {
  it('removes a tool no longer present in the desired set', async () => {
    const gmail = makeTool('composio_gmail_search')
    const session = makeSession([gmail])
    const prior = initialManagedTools([gmail])
    // Provider now returns nothing — user detached the toolkit.
    const provider = makeProvider('composio', () => ({ tools: [], stubs: [] }))

    const result = await reconcileSessionTools(
      session as unknown as Session,
      prior,
      makeProfile(),
      { providers: [provider], log: () => {} },
    )

    expect(result.added).toEqual([])
    expect(result.removed).toEqual(['composio_gmail_search'])
    expect(session.installed).toEqual([])
    expect(result.managed.size).toBe(0)
  })
})

describe('reconcileSessionTools — mixed delta', () => {
  it('adds, removes, and leaves unchanged in one pass', async () => {
    const keep = makeTool('composio_gmail_search')
    const gone = makeTool('composio_notion_search')
    const fresh = makeTool('composio_slack_send')

    const session = makeSession([keep, gone])
    const prior = initialManagedTools([keep, gone])

    // Provider now returns keep + fresh (gone is removed).
    const provider = makeProvider('composio', () => ({
      tools: [keep, fresh],
      stubs: [],
    }))

    const result = await reconcileSessionTools(
      session as unknown as Session,
      prior,
      makeProfile(),
      { providers: [provider], log: () => {} },
    )

    expect(result.added).toEqual(['composio_slack_send'])
    expect(result.removed).toEqual(['composio_notion_search'])
    expect(session.addLog.map((t) => t.name)).toEqual(['composio_slack_send'])
    expect(session.removeLog).toEqual(['composio_notion_search'])
    expect(session.installed.map((t) => t.name).sort()).toEqual([
      'composio_gmail_search',
      'composio_slack_send',
    ])
  })
})

describe('reconcileSessionTools — one provider throws', () => {
  it('records the error and still applies the other providers', async () => {
    const session = makeSession([])
    const prior: ManagedTools = new Map()
    const brokenProvider = makeProvider('broken', () => {
      throw new Error('vendor 500')
    })
    const goodProvider = makeProvider('composio', () => ({
      tools: [makeTool('composio_gmail_search')],
      stubs: [],
    }))

    const result = await reconcileSessionTools(
      session as unknown as Session,
      prior,
      makeProfile(),
      { providers: [brokenProvider, goodProvider], log: () => {} },
    )

    expect(result.added).toEqual(['composio_gmail_search'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.provider).toBe('broken')
    expect(result.errors[0]?.message).toMatch(/vendor 500/)
    // Good provider's tool is installed regardless of sibling failure.
    expect(session.installed).toHaveLength(1)
  })
})

describe('reconcileSessionTools — empty declared list', () => {
  it('removes every connector tool when the profile declares none', async () => {
    const tools = [
      makeTool('composio_gmail_search'),
      makeTool('composio_notion_search'),
      makeTool('composio_slack_send'),
    ]
    const session = makeSession(tools)
    const prior = initialManagedTools(tools)
    const provider = makeProvider('composio', () => ({ tools: [], stubs: [] }))

    const result = await reconcileSessionTools(
      session as unknown as Session,
      prior,
      makeProfile(),
      { providers: [provider], log: () => {} },
    )

    expect(result.removed.sort()).toEqual([
      'composio_gmail_search',
      'composio_notion_search',
      'composio_slack_send',
    ])
    expect(session.installed).toEqual([])
    expect(result.managed.size).toBe(0)
  })
})

describe('reconcileSessionTools — cross-provider name collision', () => {
  it('first provider wins, second records an error but assembly continues', async () => {
    const gmail = makeTool('composio_gmail_search')
    const session = makeSession([])
    const prior: ManagedTools = new Map()

    const first = makeProvider('source-a', () => ({ tools: [gmail], stubs: [] }))
    const second = makeProvider('source-b', () => ({
      tools: [makeTool('composio_gmail_search', { description: 'different' })],
      stubs: [],
    }))

    const result = await reconcileSessionTools(
      session as unknown as Session,
      prior,
      makeProfile(),
      { providers: [first, second], log: () => {} },
    )

    expect(result.added).toEqual(['composio_gmail_search'])
    expect(session.addLog).toHaveLength(1)
    // First provider's instance wins.
    expect(session.addLog[0]?.description).toBe('composio_gmail_search description')
    // Collision surfaced as an error.
    const collisionErr = result.errors.find(
      (e) => e.provider === 'source-b' && /Duplicate/.test(e.message),
    )
    expect(collisionErr).toBeDefined()
  })
})

describe('reconcileSessionTools — addTool throw is captured, managed reflects it', () => {
  it('records a session.addTool failure and keeps the name eligible for retry', async () => {
    // Session whose addTool always throws simulates an internal Loom
    // failure mid-install. Reconcile must NOT propagate.
    const session: FakeSession = {
      installed: [],
      addLog: [],
      removeLog: [],
      addTool() { throw new Error('loom internal error') },
      removeTool() { /* not exercised */ },
    }
    const prior: ManagedTools = new Map()
    const provider = makeProvider('composio', () => ({
      tools: [makeTool('composio_gmail_search')],
      stubs: [],
    }))

    const result = await reconcileSessionTools(
      session as unknown as Session,
      prior,
      makeProfile(),
      { providers: [provider], log: () => {} },
    )

    expect(result.added).toEqual([])
    expect(result.errors.some((e) =>
      e.provider === 'session' && /addTool.*failed/.test(e.message),
    )).toBe(true)
    // Snapshot EXCLUDES the failed name so the next reconcile tries again.
    expect(result.managed.has('composio_gmail_search')).toBe(false)
  })
})

describe('reconcileSessionTools — stubs count as desired tools', () => {
  it('installs provider stubs too (Connect-me prompts, etc.)', async () => {
    const session = makeSession([])
    const prior: ManagedTools = new Map()
    const provider = makeProvider('composio', () => ({
      tools: [],
      stubs: [makeTool('composio_gmail_not_connected')],
    }))

    const result = await reconcileSessionTools(
      session as unknown as Session,
      prior,
      makeProfile(),
      { providers: [provider], log: () => {} },
    )

    expect(result.added).toEqual(['composio_gmail_not_connected'])
    expect(session.installed.map((t) => t.name)).toEqual([
      'composio_gmail_not_connected',
    ])
  })
})

describe('reconcileSessionTools — observability', () => {
  it('reports a non-negative durationMs', async () => {
    const session = makeSession([])
    const provider = makeProvider('composio', () => ({ tools: [], stubs: [] }))

    const result = await reconcileSessionTools(
      session as unknown as Session,
      new Map(),
      makeProfile(),
      { providers: [provider], log: () => {} },
    )
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('swallows logger exceptions (never propagates)', async () => {
    // Unusual environments may hand us a crashy logger. Reconcile
    // must treat logging as best-effort. This test exercises only the
    // error-path logger call to prove it's defensively invoked.
    const session = makeSession([])
    const provider = makeProvider('composio', () => {
      throw new Error('vendor down')
    })
    const log = vi.fn(() => { throw new Error('logger broken') })

    // The logger inside reconcile is invoked in the provider-error
    // path. We don't guarantee swallowing — reconcile documents
    // "never throws" for the CORE contract. The logger is a test
    // seam we provide; production uses console.warn which doesn't
    // throw. This test asserts the core contract: even with our
    // broken logger, the caller gets a result object, not an
    // exception.
    // (We swallow inside the test by catching the throw to keep
    // suite green regardless of whether reconcile guards logFn.)
    let result
    try {
      result = await reconcileSessionTools(
        session as unknown as Session,
        new Map(),
        makeProfile(),
        { providers: [provider], log },
      )
    } catch {
      // If reconcile does propagate a logger throw today, surface
      // this as a failing assertion so the next agent tightens the
      // contract.
      expect(true).toBe(false)
      return
    }
    expect(result.errors.length).toBeGreaterThan(0)
  })
})
