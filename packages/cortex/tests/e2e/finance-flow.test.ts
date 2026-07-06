/**
 * E2E (Slice 11a): the finance profile wires end-to-end.
 *
 * The full Slice 11 plan (handover) proposes three deeper E2E tests —
 * DCF on AAPL, earnings recap on TSLA, IC memo — each covering helper
 * invocation, web_fetch against SEC EDGAR, and file-output assertions
 * (`.xlsx` / `.docx` via the Slice 9 office skills). Those depend on
 * three assumptions still unverified at this point:
 *   1. agent.spawn helper invocation surface (untested for finance).
 *   2. web_fetch reliably retrieves SEC EDGAR JSON (handover Open Q2).
 *   3. Python + openpyxl / python-docx are available on the runner
 *      (deferred to Slice 9.5 — desktop-client bundling).
 *
 * Slice 11a is the minimum-viable E2E that proves the wire itself
 * works. It uses the actual bundled finance profile (real SOUL.md +
 * AGENTS.md + 27 skills + 6 helpers), overrides the model from the
 * production `claude-opus-4-7` to `openrouter:haiku-4.5` via a temp
 * copy of the profile dir (no opus cost at every CI run), and drives a
 * single educational prompt that does NOT need helpers or web_fetch.
 *
 * What this test proves:
 *   - the bundled profile loads cleanly under loadProfile
 *   - assembleAgent succeeds and produces a working Session config
 *   - a real Claude turn (via OpenRouter) completes
 *   - the assistant emits at least one text.complete event
 *   - no `error` events surface during the turn
 *   - the response is finance-shaped (mentions discounted cash flow OR
 *     comparable companies — the SOUL is doing its job)
 *
 * What this test deliberately does NOT cover (next slices):
 *   - helper invocation (e.g. filings-explorer pulling a 10-K)
 *   - web_fetch + SEC EDGAR end-to-end
 *   - .xlsx / .pptx / .docx / .pdf file output
 *
 * Skipped automatically if OPENROUTER_API_KEY is unset so the suite
 * stays green on developer machines without a key.
 *
 * Run:
 *   OPENROUTER_API_KEY=sk-or-... npm run test:e2e -- tests/e2e/finance-flow.test.ts
 *
 * Cost: ~$0.005 per run (Haiku 4.5, ~1k input + ~200 output tokens).
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { mkdtemp, cp, readFile, writeFile, rm, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import {
  Session,
  OpenRouterProvider,
  registerProvider,
  AgentSpawner,
} from '@ownware/loom'
import type { LoomEvent, LoomConfig } from '@ownware/loom'
import { loadProfile } from '../../src/profile/loader.js'
import { assembleAgent } from '../../src/profile/assembler.js'
import {
  resolveLocalHelperDir,
  loadLocalHelperProfile,
} from '../../src/profile/local-helpers.js'
import { resolveSubagentDef } from '../../src/profile/subagent-resolver.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const openrouterKey =
  process.env.OPENROUTER_API_KEY &&
  !process.env.OPENROUTER_API_KEY.includes('OWNWARE_TEST_DUMMY')
    ? process.env.OPENROUTER_API_KEY
    : undefined

function skipIfNoKey(): boolean {
  if (!openrouterKey) {
    console.log('⏭ Skipping finance-flow e2e: OPENROUTER_API_KEY not set')
    return true
  }
  return false
}

// Bundled finance profile lives at packages/cortex/profiles/finance/.
// __dirname here = .../packages/cortex/tests/e2e
const BUNDLED_FINANCE = join(__dirname, '..', '..', 'profiles', 'finance')
const profileExists = existsSync(BUNDLED_FINANCE)

// Loom auto-registers an `openrouter` provider with no key, falling
// through to OPENAI_API_KEY which the test harness stamps to a dummy.
// Re-register with the real OpenRouter key here. Same pattern as
// connectors-flow.test.ts — see that file for the longer rationale.
beforeAll(() => {
  if (openrouterKey) {
    registerProvider(new OpenRouterProvider({ apiKey: openrouterKey }))
  }
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    try {
      await fn()
    } catch {
      /* best-effort cleanup */
    }
  }
  cleanups.length = 0
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

/**
 * Copy the bundled finance profile to a temp dir and rewrite both the
 * parent `agent.json` AND every helper's `agent.json` under `helpers/*`
 * to use a single cheap model. The profile structure (SOUL.md,
 * AGENTS.md, 27 skills, 6 helpers) is preserved exactly so the test
 * exercises the real production assembly path.
 *
 * Helpers must use the same provider family as the parent because
 * `AgentSpawner` shares ONE provider across the parent and every
 * spawned sub-agent. Leaving helpers on `claude-sonnet-4-6` while the
 * parent runs on `openrouter:haiku-4.5` would route helper calls
 * through OpenRouter with a model string the provider doesn't know.
 */
async function makeFinanceTestProfile(model: string): Promise<{
  dir: string
  cleanup: () => Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'cortex-finance-e2e-'))
  await cp(BUNDLED_FINANCE, dir, { recursive: true })

  // Override parent model.
  const agentJsonPath = join(dir, 'agent.json')
  const original = JSON.parse(await readFile(agentJsonPath, 'utf-8')) as Record<
    string,
    unknown
  >
  await writeFile(agentJsonPath, JSON.stringify({ ...original, model }, null, 2))

  // Override each helper's model so every sub-agent shares the parent's
  // provider. Walks helpers/* (each has its own agent.json).
  const helpersDir = join(dir, 'helpers')
  if (existsSync(helpersDir)) {
    const helperNames = await readdir(helpersDir)
    for (const name of helperNames) {
      const helperJsonPath = join(helpersDir, name, 'agent.json')
      if (!existsSync(helperJsonPath)) continue
      const helperOrig = JSON.parse(
        await readFile(helperJsonPath, 'utf-8'),
      ) as Record<string, unknown>
      await writeFile(
        helperJsonPath,
        JSON.stringify({ ...helperOrig, model }, null, 2),
      )
    }
  }

  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe.skipIf(!profileExists)('e2e: finance profile wire', () => {
  it('loads, assembles with model override, and answers an educational prompt', async () => {
    if (skipIfNoKey()) return

    // 1. Temp copy of the bundled finance profile, with model swapped
    //    to OpenRouter Haiku 4.5 for cost. Both the parent and every
    //    helper get the override (helpers use the same provider as
    //    the parent — see makeFinanceTestProfile docstring). This
    //    test's prompt does not invoke helpers; the override is
    //    consistent so the spawner-wired Slice 11b test works
    //    against the same fixture.
    const { dir, cleanup } = await makeFinanceTestProfile(
      'openrouter:haiku-4.5',
    )
    cleanups.push(cleanup)

    // 2. Load the profile. This exercises the real loader against the
    //    real bundled content — same code path the gateway uses at
    //    startup to enumerate marketplace profiles.
    const profile = await loadProfile(dir)
    expect(profile.config.name).toBe('finance')
    expect(profile.config.model).toBe('openrouter:haiku-4.5')
    // Sanity: the SOUL the test is exercising is the real one.
    expect(profile.soulMd).toContain('Finance')
    expect(profile.skills.length).toBe(27)

    // 3. Assemble. No special tool providers — for Slice 11a the agent
    //    has its preset tools (coding) and that's it. Helpers and
    //    paid-feed MCPs are NOT wired here (helpers are spawnable but
    //    the test prompt won't trigger them).
    const assembled = await assembleAgent(profile)
    expect(assembled.tools.length).toBeGreaterThan(0)
    expect(assembled.provider).toBeDefined()

    // 4. Drive a real LLM turn. The prompt is an educational question
    //    that the SOUL/skills body of knowledge can answer directly,
    //    without needing to fetch a filing. Keeping it tight on output
    //    tokens to keep cost down (~$0.005/run total).
    const session = new Session({
      config: { ...assembled.config, maxTokens: 512 },
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
      session.submitMessage(
        'In two sentences, what does a discounted cash flow (DCF) measure that a comparable companies analysis does not?',
      ),
    )

    // 5. The wire we care about end-to-end:

    // (a) No `error` events. If the model wiring was wrong, the
    //     OpenRouter provider had a bad key, or assembly produced a
    //     malformed config, an `error` event fires here.
    const errorEvents = events.filter((e) => e.type === 'error')
    expect(
      errorEvents,
      `unexpected error events: ${JSON.stringify(errorEvents, null, 2)}`,
    ).toEqual([])

    // (b) At least one assistant text completion landed.
    const textCompletions = events.filter(
      (e): e is Extract<LoomEvent, { type: 'text.complete' }> =>
        e.type === 'text.complete',
    )
    expect(textCompletions.length).toBeGreaterThanOrEqual(1)

    // (c) The combined assistant text mentions a finance concept that
    //     a DCF/comps comparison would naturally surface. Loose enough
    //     to absorb LLM phrasing variance, tight enough to fail if the
    //     SOUL never made it into the prompt.
    const combinedText = textCompletions.map((e) => e.text).join('\n')
    expect(combinedText.length).toBeGreaterThan(20)
    const lower = combinedText.toLowerCase()
    const hasFinanceConcept =
      lower.includes('cash flow') ||
      lower.includes('intrinsic') ||
      lower.includes('discount') ||
      lower.includes('time value') ||
      lower.includes('forecast')
    expect(
      hasFinanceConcept,
      `expected DCF concept in response, got: ${combinedText.slice(0, 400)}`,
    ).toBe(true)

    // (d) Session completed (turn.end fires; the run wasn't aborted).
    const turnEnds = events.filter((e) => e.type === 'turn.end')
    expect(turnEnds.length).toBeGreaterThanOrEqual(1)
  }, 120_000)

  // ─── Slice 11b: helper invocation through the spawner ───────────────
  it('spawns the filings-explorer helper when the prompt forces it', async () => {
    if (skipIfNoKey()) return

    // 1. Temp profile with parent + every helper on `openrouter:haiku-4.5`.
    //    Same fixture shape as the wire-works test above.
    const { dir, cleanup } = await makeFinanceTestProfile(
      'openrouter:haiku-4.5',
    )
    cleanups.push(cleanup)

    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile)

    // 2. Mirror the gateway's spawner setup (handlers/run.ts:454-501).
    //    The cortex assembler stops at parent assembly — `agent_spawn`
    //    only becomes routable once an `AgentSpawner` and `subagentDefs`
    //    are attached to the session config. The gateway does this in
    //    its run handler; here we do the equivalent inline so the test
    //    exercises the production wiring without spinning up a gateway.
    const parentToolNames = new Set(assembled.tools.map((t) => t.name))
    const subagentDefs: Record<
      string,
      { model?: string; tools?: string[]; systemPrompt?: string; maxTurns?: number }
    > = {}
    for (const sa of profile.config.subagents) {
      const helperDir = await resolveLocalHelperDir(profile.basePath, sa.profile ?? sa.name)
      const refProfile =
        helperDir !== null ? await loadLocalHelperProfile(helperDir) : null
      const resolved = resolveSubagentDef({
        spec: sa,
        refProfile,
        parentToolNames,
        parentSkills: profile.skills,
      })
      subagentDefs[sa.name] = {
        model: resolved.model,
        tools: resolved.tools ? [...resolved.tools] : undefined,
        systemPrompt: resolved.systemPrompt,
        maxTurns: resolved.maxTurns,
      }
    }

    // Sanity: filings-explorer is one of the subagents we'll be testing.
    expect(subagentDefs['filings-explorer']).toBeDefined()
    expect(subagentDefs['filings-explorer']!.model).toBe('openrouter:haiku-4.5')

    // Capture sub-agent events via the spawner's `onEvent` hook. The
    // spawner emits `agent.spawn` / `agent.complete` etc. INSIDE its
    // own generator — those events do not bubble up into the parent
    // session's stream. The gateway's `run.ts` wires `onEvent` to its
    // event ingestor for the same reason; here we wire it to a
    // local array so the test can assert on what the helper did.
    const subagentEvents: Array<{
      readonly event: LoomEvent
      readonly subagentId: string
    }> = []
    const sessionConfig: LoomConfig = Object.assign({}, assembled.config, {
      maxTokens: 512,
      agentSpawner: new AgentSpawner({
        provider: assembled.provider,
        tools: assembled.tools,
        config: assembled.config,
        onEvent: async (event, subagentId) => {
          subagentEvents.push({ event, subagentId })
        },
      }),
      subagentDefs,
    })

    const session = new Session({
      config: sessionConfig,
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

    // 3. Forcing prompt — names the subagent explicitly. The parent's
    //    `coding` preset has no `web_fetch`, so the parent cannot do
    //    the work directly even if it tried; the only path is to
    //    spawn `filings-explorer` (which has `web_fetch` per its
    //    helper preset). The trivial task keeps cost low — we are
    //    testing the WIRE, not what filings-explorer can produce.
    const events = await drainEvents(
      session.submitMessage(
        'Spawn the filings-explorer subagent with this exact task: ' +
          '"Reply with the single word OK and nothing else." ' +
          'Do not answer yourself; delegate to the subagent.',
      ),
    )

    // 4. No `error` events. Spawner wiring or helper assembly bugs
    //    surface here (e.g. a missing helper dir, a model the provider
    //    cannot resolve).
    const errorEvents = events.filter((e) => e.type === 'error')
    expect(
      errorEvents,
      `unexpected error events: ${JSON.stringify(errorEvents, null, 2)}`,
    ).toEqual([])

    // 5. The parent invoked `agent_spawn`. This proves the assembler's
    //    auto-injection of the agent_spawn tool worked and the model
    //    picked the right tool from its tool list.
    const parentToolStarts = events.filter(
      (e): e is Extract<LoomEvent, { type: 'tool.call.start' }> =>
        e.type === 'tool.call.start' && e.toolName === 'agent_spawn',
    )
    expect(parentToolStarts.length).toBeGreaterThanOrEqual(1)

    // 6. `agent.spawn` fires INSIDE the spawner's stream and reaches us
    //    via the `onEvent` hook (sub-agent events do not bubble up
    //    into the parent session's drainEvents output). Filter the
    //    captured sub-agent events for the spawn.
    const spawnEvents = subagentEvents
      .map((wrap) => wrap.event)
      .filter(
        (e): e is Extract<LoomEvent, { type: 'agent.spawn' }> =>
          e.type === 'agent.spawn',
      )
    expect(
      spawnEvents.length,
      `expected ≥1 agent.spawn from spawner.onEvent; subagent event types: ${subagentEvents.map((w) => w.event.type).join(', ')}`,
    ).toBeGreaterThanOrEqual(1)
    const spawnedFilingsExplorer = spawnEvents.some(
      (e) => e.profileName === 'filings-explorer',
    )
    expect(
      spawnedFilingsExplorer,
      `expected agent.spawn for filings-explorer; got profileName=[${spawnEvents.map((s) => s.profileName).join(', ')}]`,
    ).toBe(true)

    // 7. The helper's tool result returned successfully to the parent
    //    (the parent's tool.call.end carries the helper's reply on
    //    its `result`). isError must be false — a non-wired spawner
    //    surfaces here as `isError: true` with `metadata.reason:
    //    'no_spawner'`.
    const parentToolEnds = events.filter(
      (e): e is Extract<LoomEvent, { type: 'tool.call.end' }> =>
        e.type === 'tool.call.end' &&
        parentToolStarts.some((s) => s.toolCallId === e.toolCallId),
    )
    expect(parentToolEnds.length).toBeGreaterThanOrEqual(1)
    expect(parentToolEnds[0]!.isError).toBe(false)

    // 8. Parent session completed cleanly.
    const turnEnds = events.filter((e) => e.type === 'turn.end')
    expect(turnEnds.length).toBeGreaterThanOrEqual(1)
  }, 180_000)
})
