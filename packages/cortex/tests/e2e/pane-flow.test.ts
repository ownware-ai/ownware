/**
 * E2E: agent calls `open_pane` to drop a markdown pane in the workspace.
 *
 * Drives the wave-3 wiring against a real LLM:
 *
 *   profile (panes.allowedKinds: ['markdown']) + paneRuntime
 *     → assembleAgent (tool injected with kind enum narrowed to ['markdown'])
 *     → Loom Session
 *     → submitMessage("Show me a markdown pane that says hello world.")
 *     → assert: agent emits tool.call.start with toolName === 'open_pane'
 *               and config.kind === 'markdown'
 *     → assert: tool.call.end carries a typed `OpenPaneToolResult` with
 *               status === 'opened'
 *     → assert: state.getWorkspacePanes(workspaceId) includes the new
 *               markdown pane (the tool persisted through the gateway)
 *
 * Skipped automatically if OPENROUTER_API_KEY is not set so the suite
 * stays green on developer machines without a key.
 *
 * Cost: roughly $0.001-0.005 per turn via Haiku 4.5 through OpenRouter.
 *
 * Run: OPENROUTER_API_KEY=sk-or-... bunx vitest run tests/e2e/pane-flow.test.ts
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Session, OpenRouterProvider, registerProvider } from '@ownware/loom'
import type { LoomEvent } from '@ownware/loom'
import { loadProfile } from '../../src/profile/loader.js'
import { assembleAgent } from '../../src/profile/assembler.js'
import { GatewayState } from '../../src/gateway/state.js'
import { OPEN_PANE_TOOL_NAME } from '../../src/tools/open-pane/index.js'
import type { OpenPaneToolResponse } from '../../src/tools/open-pane/index.js'
import { createTempProfile } from '../helpers/fixtures.js'

// ---------------------------------------------------------------------------
// Helpers — mirror connectors-flow.test.ts so this suite reads consistently
// ---------------------------------------------------------------------------

const openrouterKey =
  process.env.OPENROUTER_API_KEY &&
  !process.env.OPENROUTER_API_KEY.includes('OWNWARE_TEST_DUMMY')
    ? process.env.OPENROUTER_API_KEY
    : undefined

function skipIfNoKey(): boolean {
  if (!openrouterKey) {
    console.log('⏭ Skipping pane-flow e2e: OPENROUTER_API_KEY not set')
    return true
  }
  return false
}

beforeAll(() => {
  // Loom auto-registers `openrouter` with the dummy test-env key; re-
  // register with the real one so streamed requests authenticate.
  if (openrouterKey) {
    registerProvider(new OpenRouterProvider({ apiKey: openrouterKey }))
  }
})

async function drainEvents(
  gen: AsyncGenerator<LoomEvent, unknown>,
): Promise<LoomEvent[]> {
  const events: LoomEvent[] = []
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return events
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

function track(fn: () => Promise<void>): void {
  cleanups.push(fn)
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('e2e: open_pane against a real LLM', () => {
  it('agent persists a markdown pane when the user asks for one', async () => {
    if (skipIfNoKey()) return

    // 1. Temp gateway DB + workspace — the tool's execute() persists
    //    through this state, so we own the lifecycle here for cleanup.
    const stateDir = await mkdtemp(join(tmpdir(), 'cortex-pane-flow-e2e-'))
    const state = new GatewayState(join(stateDir, 'ownware.db'))
    const ws = state.createWorkspace(stateDir, 'pane-flow-e2e')
    const workspaceId = ws.id
    track(async () => {
      state.close()
      await rm(stateDir, { recursive: true, force: true })
    })

    // 2. Minimal profile — open_pane is the ONLY agent-visible tool
    //    (preset 'none', no MCP). `panes.allowedKinds: ['markdown']`
    //    narrows the tool's kind enum so a successful tool call MUST
    //    be a markdown pane — anything else hits kind_not_permitted
    //    at execute() time, which makes the assertion unambiguous.
    const profileTemp = await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'e2e-open-pane',
        model: 'openrouter:haiku-4.5',
        tools: { preset: 'none', mcp: {} },
        context: {
          cwd: false,
          datetime: false,
          git: false,
          os: false,
          project: false,
        },
        panes: {
          allowedKinds: ['markdown'],
          defaultAgentPlacement: 'split',
        },
      }),
      'SOUL.md':
        '# Pane opener\n\n' +
        'When the user asks to see content as a pane, call the `open_pane` tool ' +
        'with `config: { kind: "markdown", source: { origin: "inline", content: "..." } }`. ' +
        'The body of the markdown goes inside `source.content`.',
    })
    track(profileTemp.cleanup)

    // 3. Assemble — paneRuntime threads the gateway state + workspace
    //    id into the tool factory; the assembler injects open_pane
    //    with kind enum narrowed to ['markdown'].
    const profile = await loadProfile(profileTemp.dir)
    const assembled = await assembleAgent(profile, {
      paneRuntime: { state, workspaceId },
    })

    // Sanity: open_pane is present, narrowed correctly.
    const openPaneTool = assembled.tools.find(
      (t) => t.name === OPEN_PANE_TOOL_NAME,
    )
    expect(openPaneTool).toBeDefined()
    expect(openPaneTool!.inputSchema.properties.config?.properties?.kind?.enum)
      .toEqual(['markdown'])

    // 4. Drive a real Claude turn.
    const session = new Session({
      config: { ...assembled.config, maxTokens: 1024 },
      provider: assembled.provider,
      tools: assembled.tools,
    })
    track(async () => {
      try {
        session.abort()
      } catch {
        /* no-op */
      }
    })

    const events = await drainEvents(
      session.submitMessage(
        'Open a markdown pane titled "Hello" containing the text "hello world".',
      ),
    )

    // 5. Assertions — the wire we care about end-to-end.

    // (a) The agent invoked open_pane at least once.
    const openPaneStarts = events.filter(
      (e): e is Extract<LoomEvent, { type: 'tool.call.start' }> =>
        e.type === 'tool.call.start' && e.toolName === OPEN_PANE_TOOL_NAME,
    )
    expect(openPaneStarts.length).toBeGreaterThanOrEqual(1)

    // (b) The matching tool.call.end is non-error and parses to a
    //     typed OpenPaneToolResult with status === 'opened'.
    const firstCall = openPaneStarts[0]!
    const matchingEnd = events.find(
      (e): e is Extract<LoomEvent, { type: 'tool.call.end' }> =>
        e.type === 'tool.call.end' && e.toolCallId === firstCall.toolCallId,
    )
    expect(matchingEnd).toBeDefined()
    expect(matchingEnd!.isError).toBe(false)

    const parsed = JSON.parse(matchingEnd!.result) as OpenPaneToolResponse
    expect(parsed.status).toBe('opened')
    if (parsed.status !== 'opened') {
      throw new Error('unreachable: status asserted above')
    }
    expect(parsed.kind).toBe('markdown')
    expect(parsed.paneId).toMatch(/^pane_/)
    // Markdown panes live in the side zone (only chat panes are
    // tab-strip), and side-zone panes don't honour placement — the
    // echo is null. Mirrors open-pane-tool.test.ts.
    expect(parsed.placement).toBeNull()

    // (c) The pane round-tripped through the gateway state — readback
    //     by the same paneId yields the typed pane the agent created.
    const dbPane = state.getWorkspacePane(parsed.paneId)
    expect(dbPane).toBeDefined()
    expect(dbPane!.kind).toBe('markdown')
    // Content panes persist to the side zone; only chat panes are tabs.
    expect(dbPane!.zone).toBe('side')
    expect(dbPane!.metadata.openedBy).toBe('agent')

    // (d) The persisted config carries the inline markdown body the
    //     agent supplied. Loose match — the model picks its own copy
    //     for the body, but it should at least mention "hello world".
    const cfg = dbPane!.config
    if (cfg.kind !== 'markdown') {
      throw new Error('unreachable: kind asserted above')
    }
    if (cfg.source.origin !== 'inline') {
      throw new Error(
        `expected inline source, got origin=${cfg.source.origin}. The model is ` +
          'allowed to pick a different source variant, but the SOUL.md ' +
          'instructs inline + the prompt asks for a hardcoded body.',
      )
    }
    expect(cfg.source.content.toLowerCase()).toContain('hello world')
  }, 120_000)
})
