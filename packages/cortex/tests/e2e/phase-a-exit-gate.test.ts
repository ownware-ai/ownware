/**
 * Phase A exit gate — verifies the composer chip → system prompt
 * value loop end-to-end with a real model.
 *
 * Slice A5c. Targets the SPECIFIC promise A5a + A5b made:
 *
 *   "When the user pins a skill chip + a design-system chip in the
 *    composer, those become part of the agent's system prompt on the
 *    very next /run. The agent reads them and follows the picked
 *    skill's rubric."
 *
 * Programmatic verification covers everything except the client-side
 * visual rendering of the six tool-quote primitives (A1). Those are
 * covered by a manual visual runbook.
 *
 * Skipped automatically if OPENROUTER_API_KEY is not set so the suite
 * stays usable in CI / on machines without keys. Single Haiku 4.5
 * turn — costs ~$0.01.
 *
 * Run:
 *   OPENROUTER_API_KEY=sk-or-... npm run test:e2e -- tests/e2e/phase-a-exit-gate.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProfile } from '../../src/profile/loader.js'
import {
  assembleAgent,
  type ActiveContextInput,
} from '../../src/profile/assembler.js'
import { Session, systemPromptToText, type LoomEvent } from '@ownware/loom'

const HERE = dirname(fileURLToPath(import.meta.url))
const OWNWARE_DESIGN_PROFILE = join(
  HERE,
  '..',
  '..',
  'profiles',
  'ownware-design',
)

const OR_KEY =
  process.env['OPENROUTER_API_KEY'] &&
  !process.env['OPENROUTER_API_KEY'].includes('OWNWARE_TEST_DUMMY')
    ? process.env['OPENROUTER_API_KEY']
    : null

function skipIfNoKey(): boolean {
  if (OR_KEY === null) {
    console.log('⏭ Skipping phase-a-exit-gate e2e: OPENROUTER_API_KEY not set')
    return true
  }
  return false
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

/** Drain all events from an AsyncIterable into an array. */
async function drainEvents(
  iter: AsyncIterable<LoomEvent>,
): Promise<readonly LoomEvent[]> {
  const out: LoomEvent[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

/** Concatenate every text fragment from `text.delta` events.
 *  Mirrors the helper in tests/e2e/skills-fire.test.ts:91. */
function extractAgentText(events: readonly LoomEvent[]): string {
  return events
    .filter((e): e is Extract<LoomEvent, { type: 'text.delta' }> => e.type === 'text.delta')
    .map((d) => d.text)
    .join('')
}

describe('Phase A exit gate — composer chips → system prompt → agent', () => {
  // ---------------------------------------------------------------------
  // 1. Assembly-only verification (no LLM needed) — proves the chip data
  //    reaches the system prompt in the right shape.
  // ---------------------------------------------------------------------

  it('embeds the picked skill BODY into <active-skills> block', async () => {
    const profile = await loadProfile(OWNWARE_DESIGN_PROFILE)
    const activeContext: ActiveContextInput = {
      skills: [{ id: 'critique', name: 'critique' }],
    }
    const assembled = await assembleAgent(profile, { activeContext })
    const promptText = systemPromptToText(assembled.systemPrompt)

    expect(promptText).toContain('<active-skills>')
    expect(promptText).toContain('<skill name="critique">')
    // The critique skill's body should be inlined. Pull a substring
    // from the actual skill file so the assertion stays honest about
    // what got inlined.
    const critique = profile.skills.find((s) => s.name === 'critique')
    expect(critique).toBeDefined()
    // Pick a phrase that's clearly from the critique skill's body
    // (its overview mentions 5-dimensional critique).
    const body = critique!.content
    const firstHeading = body.split('\n').find((l) => l.startsWith('# ')) ?? ''
    expect(firstHeading.length).toBeGreaterThan(0)
    expect(promptText).toContain(firstHeading)
  })

  it('accepts design-system chips WITHOUT emitting <active-design-systems> (block moved client-side in slice B1.8.B)', async () => {
    // <active-design-systems> was REMOVED from the cortex assembler in
    // slice B1.8.B (2026-05-27) — the Design vertical now bakes
    // DESIGN.md + tokens.css into the prompt client-side via
    // `build-system-prompt-append.ts` and ships it through the generic
    // `systemPromptAppend` passthrough. The typed designSystems input
    // stays on the wire but renders nothing here (see
    // assembler.ts:renderActiveContextFragment and the matching specs
    // in tests/unit/assembler/active-context.test.ts).
    const profile = await loadProfile(OWNWARE_DESIGN_PROFILE)
    const activeContext: ActiveContextInput = {
      designSystems: [
        {
          id: 'editorial-monocle',
          name: 'Editorial Monocle',
          category: 'editorial',
          surface: 'web',
          swatches: ['#0E0E0E', '#FAF7EE', '#A12C2C'],
          summary: 'serif magazine, restrained palette',
        },
      ],
    }
    const assembled = await assembleAgent(profile, { activeContext })
    const promptText = systemPromptToText(assembled.systemPrompt)

    expect(promptText).not.toContain('<active-design-systems>')
    expect(promptText).not.toContain('id: editorial-monocle')
  })

  it('embeds the iframe-bridge selection chip into <active-selection> block', async () => {
    const profile = await loadProfile(OWNWARE_DESIGN_PROFILE)
    const activeContext: ActiveContextInput = {
      selection: {
        tag: 'button',
        selector: '#cta-primary',
        outerHTML: '<button id="cta-primary">Buy now</button>',
        url: 'http://127.0.0.1:3011/api/v1/designs/d_test/raw/01-cover.html',
      },
    }
    const assembled = await assembleAgent(profile, { activeContext })
    const promptText = systemPromptToText(assembled.systemPrompt)

    expect(promptText).toContain('<active-selection>')
    expect(promptText).toContain('tag: button')
    expect(promptText).toContain('selector: #cta-primary')
    expect(promptText).toContain('<button id="cta-primary">Buy now</button>')
    expect(promptText).toContain('url: http://127.0.0.1:3011')
  })

  it('omits ALL active-context blocks when no chips are picked (legacy path unchanged)', async () => {
    const profile = await loadProfile(OWNWARE_DESIGN_PROFILE)
    const assembled = await assembleAgent(profile) // no activeContext
    const promptText = systemPromptToText(assembled.systemPrompt)

    expect(promptText).not.toContain('<active-skills>')
    expect(promptText).not.toContain('<active-design-systems>')
    // ownware-design's SOUL.md legitimately mentions the bare
    // `<active-selection>` tag in prose (it teaches the agent what the
    // block means), so match the emitted block's opening line instead
    // of the bare tag name.
    expect(promptText).not.toContain(
      '<active-selection>\nThe user clicked an element in the canvas',
    )
  })

  // ---------------------------------------------------------------------
  // 2. Real-LLM smoke (~$0.01) — proves the agent actually READS the
  //    picked skill's body and follows it.
  // ---------------------------------------------------------------------

  it('agent follows the picked critique skill when chip is active', async () => {
    if (skipIfNoKey()) return

    const profile = await loadProfile(OWNWARE_DESIGN_PROFILE)
    // Force Haiku 4.5 over the profile's default (sonnet) for cost +
    // latency. The clone is the documented intervention point per
    // skills-fire.test.ts:120.
    const overridden = {
      ...profile,
      config: {
        ...profile.config,
        model: 'openrouter:haiku-4.5' as typeof profile.config.model,
      },
    }
    const activeContext: ActiveContextInput = {
      skills: [{ id: 'critique', name: 'critique' }],
    }
    const assembled = await assembleAgent(overridden, { activeContext })

    const session = new Session({
      config: { ...assembled.config, maxTokens: 1024 },
      provider: assembled.provider,
      tools: assembled.tools,
    })
    cleanups.push(() => {
      try {
        session.abort()
      } catch {
        /* no-op */
      }
    })

    const events = await drainEvents(
      session.submitMessage(
        'I just shipped a SaaS pricing page. Tell me how to critique it — ' +
          'what specifically I should look at, in what order.',
      ),
    )
    const text = extractAgentText(events).toLowerCase()

    // The critique skill's body emphasises dimensional scoring — the
    // agent should reach for at least ONE of: "dimension", numeric
    // scoring (e.g. "5/5", "scale"), or the names of the five
    // dimensions the skill's rubric calls out. We don't assert exact
    // wording (LLMs drift turn-to-turn).
    const mentionsDimensions = text.includes('dimension')
    const mentionsScale = /\b\d\s*\/\s*\d\b/.test(text) || text.includes('scale')
    const mentionsRubric = text.includes('rubric') || text.includes('checklist')
    const mentionsCritiqueStructure =
      text.includes('hierarchy') &&
      (text.includes('typography') || text.includes('color')) &&
      text.includes('contrast')

    expect(
      mentionsDimensions || mentionsScale || mentionsRubric || mentionsCritiqueStructure,
      `Expected agent to follow the critique skill's rubric structure (dimensions / scale / rubric / hierarchy+typography+contrast). Got:\n---\n${text.slice(0, 1200)}\n---`,
    ).toBe(true)
  }, 120_000)
})
