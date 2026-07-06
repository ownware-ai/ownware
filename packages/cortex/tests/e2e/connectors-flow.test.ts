/**
 * E2E: agent's `connectors()` tool against a real LLM (post-rip).
 *
 * Drives Anthropic Haiku 4.5 via OpenRouter through the full assembler
 * → Loom Session → tool dispatch wire, asserting THREE post-2026-05-12
 * behaviours:
 *
 *   1. "Find me a calendar app I can connect"
 *        → agent MUST NOT call connectors(action: 'search'); that action
 *          retired. Agent should route the user to the chat ability
 *          rail's `+ Add` in plain text (the assembler injects that
 *          guidance into the system prompt when the connectors() tool
 *          is in the catalog).
 *
 *   2. "What services do I currently have connected?"
 *        → agent calls connectors(action: 'list_attached').
 *          Asserts type === 'connector_attached_list'.
 *
 *   3. "Is GitHub connected?"
 *        → agent calls connectors(action: 'status', query: 'github').
 *          Asserts type === 'connector_status' OR a not-found error
 *          (both are valid 'status' routing outcomes).
 *
 * Skipped automatically if OPENROUTER_API_KEY is not set so the suite
 * stays green on developer machines without a key. Per-turn cost is
 * ~$0.001-0.005 against Haiku 4.5.
 *
 * Run: OPENROUTER_API_KEY=sk-or-... npm run test:e2e -- tests/e2e/connectors-flow.test.ts
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { Session, OpenRouterProvider, registerProvider } from '@ownware/loom'
import type { LoomEvent } from '@ownware/loom'
import { loadProfile } from '../../src/profile/loader.js'
import { assembleAgent } from '../../src/profile/assembler.js'
import { ProfileRegistry } from '../../src/profile/registry.js'
import { ConnectorRegistry } from '../../src/connector/registry.js'
import { ConnectorsToolProvider } from '../../src/connector/providers/connectors-tool-provider.js'
import { ConnectorAgentToolResultSchema } from '../../src/connector/agent-tool-results.js'
import { createTempProfile } from '../helpers/fixtures.js'

// ---------------------------------------------------------------------------
// Helpers (mirror real-agent.test.ts so this suite reads consistently)
// ---------------------------------------------------------------------------

const openrouterKey =
  process.env.OPENROUTER_API_KEY &&
  !process.env.OPENROUTER_API_KEY.includes('OWNWARE_TEST_DUMMY')
    ? process.env.OPENROUTER_API_KEY
    : undefined

function skipIfNoKey(): boolean {
  if (!openrouterKey) {
    console.log('⏭ Skipping connectors-flow e2e: OPENROUTER_API_KEY not set')
    return true
  }
  return false
}

// Loom auto-registers an `openrouter` provider at module load with no
// apiKey, which falls through to `process.env.OPENAI_API_KEY`. The test
// setup (`tests/setup/env.ts`) stamps that to a dummy sentinel, so we
// MUST re-register the openrouter provider with the real OpenRouter
// key from env — otherwise streamed requests go out with the dummy key
// and 401.
beforeAll(() => {
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

function track<T extends { cleanup: () => Promise<void> }>(p: T): T {
  cleanups.push(p.cleanup)
  return p
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('e2e: connectors() agent tool against a real LLM', () => {
  it('agent routes the user to the chat ability rail when asked to add a new connector (search action retired)', async () => {
    if (skipIfNoKey()) return

    // 1. Minimal profile: no built-in tools, no MCP servers, no context
    //    fragments. The connectors tool will be the ONE tool the agent
    //    has, so a tool call (when it happens) is unambiguous.
    const { dir } = track(
      await createTempProfile({
        'agent.json': JSON.stringify({
          name: 'e2e-connectors',
          // Anthropic Haiku 4.5 via OpenRouter — same Claude family the
          // production system prompt was tuned against, billed through
          // the user's OpenRouter account so a single key covers the
          // test. ~$0.001-0.005 per turn.
          model: 'openrouter:haiku-4.5',
          tools: { preset: 'none', mcp: {} },
          context: {
            cwd: false,
            datetime: false,
            git: false,
            os: false,
            project: false,
          },
        }),
      }),
    )

    // 2. Build the registry + tool provider.
    const profile = await loadProfile(dir)
    const profileRegistry = new ProfileRegistry()
    const connectorRegistry = new ConnectorRegistry(profileRegistry)
    const provider = new ConnectorsToolProvider({
      registry: connectorRegistry,
    })

    // 3. Assemble. The provider contributes the `connectors` tool, and
    //    the assembler (post-2026-05-12) injects the rail-routing
    //    context block whenever that tool is present — telling the
    //    agent "tell the user to click + Add in the chat ability rail."
    const assembled = await assembleAgent(profile, {
      toolProviders: [provider],
    })

    // Sanity: the connectors tool is present in the assembled tool list.
    const connectorsToolPresent = assembled.tools.some(
      (t) => t.name === 'connectors',
    )
    expect(connectorsToolPresent).toBe(true)

    // 4. Drive a real Claude turn with a request that pre-rip would
    //    have triggered a search action call.
    const session = new Session({
      config: { ...assembled.config, maxTokens: 1024 },
      provider: assembled.provider,
      tools: assembled.tools,
    })
    cleanups.push(async () => {
      try {
        session.abort()
      } catch {
        /* no-op */
      }
    })

    const events = await drainEvents(
      session.submitMessage('Find me a calendar app I can connect.'),
    )

    // 5. Assertions — post-rip routing contract.

    // (a) The agent MUST NOT successfully produce a
    //     `connector_search_result` payload. That result shape can
    //     only come from the now-removed search action. Every
    //     connectors() call's end-event metadata (when present) must
    //     be either `connector_attached_list` or `connector_status`,
    //     or the call must be an error result.
    const connectorEnds = events.filter(
      (e): e is Extract<LoomEvent, { type: 'tool.call.end' }> =>
        e.type === 'tool.call.end' && e.toolName === 'connectors',
    )
    for (const end of connectorEnds) {
      const meta = end.metadata?.['connectorAgentResult']
      if (meta != null) {
        const parsed = ConnectorAgentToolResultSchema.parse(meta)
        expect(parsed.type).not.toBe('connector_search_result')
      }
    }

    // (b) The agent's text response should reference the chat ability
    //     rail and/or the `+ Add` affordance — the assembler's
    //     system-prompt addendum explicitly tells it to route the user
    //     there. We accept any phrasing that mentions one of those
    //     surface markers; LLM wording varies turn-to-turn, so we
    //     check for either marker rather than a fixed string.
    const textDeltas = events.filter(
      (e): e is Extract<LoomEvent, { type: 'text.delta' }> =>
        e.type === 'text.delta',
    )
    const agentText = textDeltas.map((d) => d.text).join('').toLowerCase()
    const mentionsRail =
      agentText.includes('+ add')
      || agentText.includes('+add')
      || agentText.includes('ability rail')
      || agentText.includes('rail above')
      || agentText.includes('rail at')
      // Defensive fallback: "add button" alongside any of "chat",
      // "profile", "above"  — covers paraphrases without admitting
      // generic "add" matches from unrelated sentences.
      || (agentText.includes('add button')
          && (agentText.includes('chat')
              || agentText.includes('profile')
              || agentText.includes('above')))
    expect(
      mentionsRail,
      `Agent text should route the user to the rail's +Add. Got:\n---\n${agentText}\n---`,
    ).toBe(true)
  }, 120_000)

  // ─── list_attached ───────────────────────────────────────────────
  it('agent calls list_attached when the user asks what is connected', async () => {
    if (skipIfNoKey()) return

    const { dir } = track(
      await createTempProfile({
        'agent.json': JSON.stringify({
          name: 'e2e-list-attached',
          model: 'openrouter:haiku-4.5',
          tools: { preset: 'none', mcp: {} },
          context: {
            cwd: false,
            datetime: false,
            git: false,
            os: false,
            project: false,
          },
        }),
      }),
    )

    const profile = await loadProfile(dir)
    const profileRegistry = new ProfileRegistry()
    const connectorRegistry = new ConnectorRegistry(profileRegistry)
    const provider = new ConnectorsToolProvider({
      registry: connectorRegistry,
    })
    const assembled = await assembleAgent(profile, {
      toolProviders: [provider],
    })

    const session = new Session({
      config: { ...assembled.config, maxTokens: 1024 },
      provider: assembled.provider,
      tools: assembled.tools,
    })
    cleanups.push(async () => {
      try {
        session.abort()
      } catch {
        /* no-op */
      }
    })

    const events = await drainEvents(
      session.submitMessage('What services do I currently have connected?'),
    )

    // The agent invokes connectors() and the result type identifies
    // the action: action='list_attached' → type='connector_attached_list'.
    // Empty `items` is the expected outcome here — the temp profile
    // has no MCPs attached. The point is that the agent picked the
    // right action and the result schema round-trips even when empty.
    const startEvent = events.find(
      (e): e is Extract<LoomEvent, { type: 'tool.call.start' }> =>
        e.type === 'tool.call.start' && e.toolName === 'connectors',
    )
    expect(startEvent).toBeDefined()

    const endEvent = events.find(
      (e): e is Extract<LoomEvent, { type: 'tool.call.end' }> =>
        e.type === 'tool.call.end' && e.toolCallId === startEvent!.toolCallId,
    )
    expect(endEvent).toBeDefined()
    expect(endEvent!.isError).toBe(false)

    const meta = endEvent!.metadata?.['connectorAgentResult']
    const parsed = ConnectorAgentToolResultSchema.parse(meta)
    expect(parsed.type).toBe('connector_attached_list')
    if (parsed.type !== 'connector_attached_list') {
      throw new Error('unreachable')
    }
    // The temp profile has no MCP entries, but Loom's built-in tools
    // (filesystem, shell, search, agent, memory, …) surface as
    // ready-status connectors via `BuiltinSourceProvider.listForProfile`,
    // so list_attached returns the builtin set on an "empty" profile.
    // What we actually want to verify here is that the agent picked
    // the RIGHT ACTION — `connector_attached_list` proves it (every
    // other action yields a different result type). The exact item
    // count is incidental.
    expect(Array.isArray(parsed.items)).toBe(true)
    // Every item in list_attached must be source!='composio' (no
    // composio key in this temp profile) — guards against accidental
    // catalog leakage into the attached list.
    for (const item of parsed.items) {
      expect(item.source).not.toBe('composio')
    }
  }, 120_000)

  // ─── status ──────────────────────────────────────────────────────
  it('agent calls status with a specific connector id when asked about one connection', async () => {
    if (skipIfNoKey()) return

    const { dir } = track(
      await createTempProfile({
        'agent.json': JSON.stringify({
          name: 'e2e-status',
          model: 'openrouter:haiku-4.5',
          tools: { preset: 'none', mcp: {} },
          context: {
            cwd: false,
            datetime: false,
            git: false,
            os: false,
            project: false,
          },
        }),
      }),
    )

    const profile = await loadProfile(dir)
    const profileRegistry = new ProfileRegistry()
    const connectorRegistry = new ConnectorRegistry(profileRegistry)
    const provider = new ConnectorsToolProvider({
      registry: connectorRegistry,
    })
    const assembled = await assembleAgent(profile, {
      toolProviders: [provider],
    })

    const session = new Session({
      config: { ...assembled.config, maxTokens: 1024 },
      provider: assembled.provider,
      tools: assembled.tools,
    })
    cleanups.push(async () => {
      try {
        session.abort()
      } catch {
        /* no-op */
      }
    })

    const events = await drainEvents(
      session.submitMessage('Is GitHub connected?'),
    )

    // The agent should call connectors(action: 'status', query: 'github')
    // → result.type === 'connector_status'. Without credentials on the
    // temp profile, the status itself is 'needs_setup' (or 'error') —
    // we don't pin the status value, only the action routing.
    const start = events.find(
      (e): e is Extract<LoomEvent, { type: 'tool.call.start' }> =>
        e.type === 'tool.call.start' && e.toolName === 'connectors',
    )
    expect(start).toBeDefined()

    const end = events.find(
      (e): e is Extract<LoomEvent, { type: 'tool.call.end' }> =>
        e.type === 'tool.call.end' && e.toolCallId === start!.toolCallId,
    )
    expect(end).toBeDefined()
    // `status` returns isError=true when the queried id is not found
    // in the catalog (the unified registry lookup miss). We accept
    // EITHER a typed status result OR a not-found error — both are
    // valid agent-routing outcomes proving the action was 'status'.
    if (end!.isError === false) {
      const meta = end!.metadata?.['connectorAgentResult']
      const parsed = ConnectorAgentToolResultSchema.parse(meta)
      expect(parsed.type).toBe('connector_status')
      if (parsed.type !== 'connector_status') throw new Error('unreachable')
      expect(parsed.name.toLowerCase()).toContain('github')
    } else {
      // Not-found path: the result string is a JSON-encoded
      // { error: '...' } shape. Assert it's about a missing
      // connector, not a different failure category.
      const errBody = JSON.parse(end!.result) as { error?: string }
      expect(errBody.error).toMatch(/no connector found/i)
    }
  }, 120_000)
})
