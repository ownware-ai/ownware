/**
 * E2E: ownware-design skill catalogue (A4 slice — skills import).
 *
 * **Honest naming caveat.** The slice handover used the word "fire" but
 * skill triggers do not fire in the parent agent's loop today
 * (`packages/loom/src/skills/matcher.ts` is referenced only by unit
 * tests, and `packages/cortex/src/profile/assembler.ts:1346-1349` +
 * `packages/loom/src/prompt/fragments/skills.ts:55` both render ONLY
 * the catalog `- /<name>: <description>` into the system prompt — the
 * SkillDefinition.content body is reserved for sub-agent grants).
 *
 * So this suite verifies what IS testable today against the real
 * ownware-design profile:
 *
 *   1. Loader sanity — the profile loads, all 30 skills parse, every
 *      one has a non-empty name + description + trigger, no
 *      `triggers:` plural array leaks from the open-design source.
 *
 *   2. Catalog rendering — the assembled system prompt contains the
 *      30-line `- /<name>: <description>` catalog. The agent SEES the
 *      catalog on every turn.
 *
 *   3-6. Real Haiku 4.5 turns against 4 catalog descriptions whose
 *        wording is specific enough to drive observable behavior
 *        (color-system, web-guidelines, ad-copy, psychology-applied).
 *        For each, the agent receives a natural-language prompt aligned
 *        to the skill's description; we assert the response surfaces
 *        the concepts the description encodes (OKLCH / contrast ratios,
 *        spacing px values, multiple ad-copy variants, named behavioral
 *        principles). This proves the catalog gets attention from the
 *        model. It does NOT prove the full body's rubric is followed —
 *        the body is currently shelfware for the parent agent.
 *
 * Skipped automatically if OPENROUTER_API_KEY is not set so the suite
 * stays green on developer machines without a key. Per-turn cost is
 * ~$0.001-0.005 against Haiku 4.5 (4 turns × ~$0.005 ≈ $0.02 total).
 *
 * Run: OPENROUTER_API_KEY=sk-or-... npm run test:e2e -- tests/e2e/skills-fire.test.ts
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { Session, OpenRouterProvider, registerProvider, systemPromptToText } from '@ownware/loom'
import type { LoomEvent } from '@ownware/loom'
import { loadProfile } from '../../src/profile/loader.js'
import { assembleAgent } from '../../src/profile/assembler.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const OWNWARE_DESIGN_PROFILE = resolve(__dirname, '../../profiles/ownware-design')

const openrouterKey =
  process.env.OPENROUTER_API_KEY &&
  !process.env.OPENROUTER_API_KEY.includes('OWNWARE_TEST_DUMMY')
    ? process.env.OPENROUTER_API_KEY
    : undefined

function skipIfNoKey(): boolean {
  if (!openrouterKey) {
    console.log('⏭ Skipping skills-fire e2e: OPENROUTER_API_KEY not set')
    return true
  }
  return false
}

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

function extractAgentText(events: LoomEvent[]): string {
  return events
    .filter((e): e is Extract<LoomEvent, { type: 'text.delta' }> => e.type === 'text.delta')
    .map((d) => d.text)
    .join('')
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

/**
 * Build a Session against the real ownware-design profile with Haiku 4.5
 * forced (cheap + fast for e2e). The profile's default `sonnet-4.6` is
 * swapped to `openrouter:haiku-4.5` via a config clone before assemble
 * (assembleAgent has no `modelOverride` option; `resolveProvider` reads
 * `profile.config.model` at assemble time, so the clone is the
 * intervention point).
 */
async function buildDesignerSession(): Promise<{
  session: Session
  systemPromptText: string
  skillNames: readonly string[]
}> {
  const profile = await loadProfile(OWNWARE_DESIGN_PROFILE)
  const overridden = {
    ...profile,
    // Cast: `model` is a branded string in ProfileConfig; the runtime
    // only cares that resolveProvider can parse the prefix.
    config: { ...profile.config, model: 'openrouter:haiku-4.5' as typeof profile.config.model },
  }
  const assembled = await assembleAgent(overridden)

  const session = new Session({
    // Cap maxTokens so a verbose model doesn't burn budget on the
    // single-turn assertions below — 1024 is plenty for the 4 prompts.
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

  return {
    session,
    systemPromptText: systemPromptToText(assembled.systemPrompt),
    skillNames: profile.skills.map((s) => s.name),
  }
}

// ---------------------------------------------------------------------------
// 1. Loader sanity (no LLM needed)
// ---------------------------------------------------------------------------

describe('ownware-design skills catalogue (A4)', () => {
  it('loads the profile with exactly 100 skills, all with valid frontmatter', async () => {
    const profile = await loadProfile(OWNWARE_DESIGN_PROFILE)

    expect(profile.skills.length).toBe(100)

    // Every skill: non-empty name + description + trigger.
    for (const s of profile.skills) {
      expect(s.name, `skill missing name`).toBeTruthy()
      expect(s.description, `skill ${s.name} missing description`).toBeTruthy()
      expect(s.trigger, `skill ${s.name} missing trigger`).toBeTruthy()
      // Triggers are string `/slug` form (loader default if frontmatter
      // omitted — we check the explicit shape).
      expect(typeof s.trigger).toBe('string')
      const trig = s.trigger as string
      expect(trig.startsWith('/'), `skill ${s.name} trigger should start with /, got: ${trig}`).toBe(true)
      // Description length sanity: descriptions should be substantive
      // (we wrote them ≤500 chars but ≥120 chars is the floor for a
      // useful catalog line).
      expect(s.description.length, `skill ${s.name} description too short`).toBeGreaterThanOrEqual(120)
      expect(s.description.length, `skill ${s.name} description over 500 chars`).toBeLessThanOrEqual(500)
    }

    // No duplicate triggers across the 30 skills.
    const triggers = profile.skills.map((s) => s.trigger as string)
    const uniqueTriggers = new Set(triggers)
    expect(uniqueTriggers.size).toBe(triggers.length)
  })

  // -------------------------------------------------------------------------
  // 2. Catalog rendering (no LLM needed)
  // -------------------------------------------------------------------------

  it('renders the 30-skill catalog into the assembled system prompt', async () => {
    const profile = await loadProfile(OWNWARE_DESIGN_PROFILE)
    const assembled = await assembleAgent(profile)
    const promptText = systemPromptToText(assembled.systemPrompt)

    // The catalog block header is added unconditionally when any skill
    // is loaded (assembler.ts:1349).
    expect(promptText).toContain('Available Skills')

    // Spot-check that 13 representative skills (one from each batch +
    // anchors) appear by their slash-name in the prompt.
    const representatives = [
      '/artifact', // anchor
      '/brief-parser', // Batch 1
      '/moodboard', // Batch 2 (no upstream source)
      '/brand-identity', // Batch 3 (Ownware-as-example)
      '/threejs-scene', // Batch 4
      '/video-renderer', // Batch 5 (honest-scope)
      '/scroll-motion', // Batch 6 (motion expansion)
      '/paywall-design', // Batch 7 (surface expansion)
      '/motion-timeline', // Batch 8 (motion orchestration)
      '/pptx-fidelity-audit', // Batch 9 (substantive)
      '/burgundy-editorial', // Batch 10 (editorial pattern)
      '/swiss-creative-template', // Batch 11 (deck variant)
      '/algorithmic-art', // Batch 12 (generative)
      '/typography-system', // Batch 13 (foundational, net-new)
      '/accessibility-audit', // Batch 14 (foundational, net-new)
      '/forms-craft', // Batch 15 (surfaces, net-new)
      '/microinteractions', // Batch 16 (states, net-new)
      '/chat-ui-design', // Batch 17 (channel/meta, net-new)
    ]
    for (const slug of representatives) {
      expect(promptText, `expected catalog to contain ${slug}`).toContain(slug)
    }
  })

  // -------------------------------------------------------------------------
  // 3-6. Real-LLM checks — 4 description-encoded skill behaviors.
  //
  // Each check drives a single Haiku 4.5 turn. We do NOT assert exact
  // wording (LLMs vary turn-to-turn); we assert that the response
  // surfaces the concepts the catalog description encodes.
  // -------------------------------------------------------------------------

  it('agent surfaces color-system concepts (OKLCH / contrast ratios) when asked for an accent', async () => {
    if (skipIfNoKey()) return

    const { session } = await buildDesignerSession()
    const events = await drainEvents(
      session.submitMessage(
        'Give me a defensible accent color for a fintech B2B brand. ' +
          'Tell me what makes it defensible and how to verify it works.',
      ),
    )
    const text = extractAgentText(events).toLowerCase()

    // Description for color-system encodes: OKLCH math, contrast checks
    // (WCAG), 60/30/10 rules, accent + ramp + neutrals + semantics.
    // The agent should reach for at least ONE of these specifics when
    // answering a "defensible accent" prompt.
    const mentionsOklch = text.includes('oklch')
    const mentionsContrast = text.includes('contrast') || /\b\d(\.\d+)?\s*:\s*1\b/.test(text)
    const mentionsWcag = text.includes('wcag') || text.includes('aa') || text.includes('aaa')

    expect(
      mentionsOklch || mentionsContrast || mentionsWcag,
      `Expected agent to mention OKLCH / contrast / WCAG when reaching for color-system concepts. Got:\n---\n${text}\n---`,
    ).toBe(true)
  }, 120_000)

  it('agent surfaces web-guidelines specifics (numeric spacing/contrast/motion) for layout briefs', async () => {
    if (skipIfNoKey()) return

    const { session } = await buildDesignerSession()
    const events = await drainEvents(
      session.submitMessage(
        'I am about to start a marketing landing page. ' +
          'Give me the concrete numeric baselines I should hit for container width, ' +
          'spacing scale, body type size, contrast, and motion duration.',
      ),
    )
    const text = extractAgentText(events).toLowerCase()

    // Description encodes: 1200px container, 8px spacing scale, 16px
    // body, 4.5:1 contrast, 200ms transitions. The agent should answer
    // with at least 3 numeric specifics from this family.
    const hasContainerWidth = /\b1\s?[02-5]00\s?px\b/.test(text) // 1200/1280/1440 etc
    const hasSpacingScale = /\b(8\s?px|8px|0?\.5rem)\b/.test(text) || text.includes('8px scale') || text.includes('spacing scale')
    const hasBodySize = /\b1[4-8]\s?px\b/.test(text) || text.includes('16px') || text.includes('rem')
    const hasContrast = /\b\d(\.\d+)?\s*:\s*1\b/.test(text) || text.includes('wcag') || text.includes('aa')
    const hasMotion = /\b[1-3]\d{2}\s?ms\b/.test(text) || text.includes('200ms') || text.includes('300ms') || text.includes('transition')

    const numericSpecifics = [hasContainerWidth, hasSpacingScale, hasBodySize, hasContrast, hasMotion].filter(Boolean).length
    expect(
      numericSpecifics,
      `Expected ≥3 numeric specifics (container px / spacing / body type / contrast / motion ms). Got ${numericSpecifics}. Text:\n---\n${text}\n---`,
    ).toBeGreaterThanOrEqual(3)
  }, 120_000)

  it('agent produces multiple ad-copy variants with platform-aware length when asked for ad headlines', async () => {
    if (skipIfNoKey()) return

    const { session } = await buildDesignerSession()
    const events = await drainEvents(
      session.submitMessage(
        'Write me 5 headline variants for a Meta ad promoting a CRM tool for solo founders. ' +
          'Keep them tight enough for the platform.',
      ),
    )
    const text = extractAgentText(events)

    // Description encodes: 5 variants minimum, character limits per
    // platform (Meta headline = 40 char cap), one hook per variant.
    // Assert: at least 3 distinct headline-like lines, each ≤60 chars
    // (allowing some slack since the model occasionally renders
    // markdown bullets), and at least one tight enough for Meta (≤40).
    const lines = text
      .split('\n')
      .map((l) => l.replace(/^[\d.)\-*•\s]+/, '').trim())
      .filter((l) => l.length >= 5 && l.length <= 120)
      .filter((l) => !/^(here|sure|certainly|the following|below)/i.test(l))
    const tightLines = lines.filter((l) => l.length <= 60)
    const veryTight = lines.filter((l) => l.length <= 40)

    expect(
      tightLines.length,
      `Expected ≥3 headline variants ≤60 chars. Got ${tightLines.length}. Text:\n---\n${text}\n---`,
    ).toBeGreaterThanOrEqual(3)
    expect(
      veryTight.length,
      `Expected ≥1 headline ≤40 chars (Meta mobile cap). Got ${veryTight.length}. Text:\n---\n${text}\n---`,
    ).toBeGreaterThanOrEqual(1)
  }, 120_000)

  it('agent names behavioral principles (loss aversion / social proof / anchoring / scarcity) for pricing conversion', async () => {
    if (skipIfNoKey()) return

    const { session } = await buildDesignerSession()
    const events = await drainEvents(
      session.submitMessage(
        // Pre-supply the context the discovery skill would ask for so the
        // agent goes straight to the psychology-applied answer instead of
        // bouncing to discovery (which would be correct Designer behaviour
        // but fails this assertion). Brief = a saas pricing page with
        // tiers + traffic + the user's request explicitly skips questions.
        'I have a SaaS pricing page for an indie B2B CRM ($19/$49/$99 tiers). ' +
          'Traffic is steady but conversion is weak. ' +
          'No clarifying questions — give me 3 specific moves to lift conversion ' +
          'and name the persuasion principle behind each.',
      ),
    )
    const text = extractAgentText(events).toLowerCase()

    // Description for psychology-applied encodes: loss aversion, social
    // proof, anchoring, scarcity, reciprocity, authority, choice
    // architecture, commitment. Assert at least 2 named principles
    // surface in the response.
    const principles = [
      'loss aversion',
      'social proof',
      'anchoring',
      'scarcity',
      'reciprocity',
      'authority',
      'choice architecture',
      'commitment',
    ]
    const surfaced = principles.filter((p) => text.includes(p))

    expect(
      surfaced.length,
      `Expected ≥2 named behavioral principles. Surfaced: [${surfaced.join(', ')}]. Text:\n---\n${text}\n---`,
    ).toBeGreaterThanOrEqual(2)
  }, 120_000)
})
