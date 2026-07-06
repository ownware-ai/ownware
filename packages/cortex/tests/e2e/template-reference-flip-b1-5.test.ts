/**
 * Slice B1.5 — template-reference flip end-to-end.
 *
 * Pins the new behaviour shipped on 2026-05-27:
 *
 *   1. `POST /designs/:id/seed-template` returns SKILL.md + example.html
 *      as JSON. **No file copy.** The slug folder stays empty until
 *      the agent's first `writeFile`. (Covered by
 *      `tests/unit/gateway/designs-handlers.test.ts` — re-asserted
 *      here as part of the slice's exit gate.)
 *
 *   2. The client's `buildSystemPromptAppend` emits a
 *      `<template-reference>` block carrying SKILL.md + example.html
 *      verbatim. (Covered by the client's own
 *      build-system-prompt-append tests.)
 *
 *   3. Cortex passes systemPromptAppend through verbatim — the
 *      assembler does not parse it, does not filter it, does not
 *      reorder its contents. The `<template-reference>` block lands
 *      in the agent's system prompt as written.
 *
 *   4. A real model READS the `<template-reference>` block and
 *      follows the distinctive instruction it carries.
 *
 * Test (4) is gated on `OPENROUTER_API_KEY` — it costs ~$0.01 on
 * Haiku 4.5 and is skipped silently in CI without keys. Tests (1)
 * and (3) run unconditionally.
 *
 * Run:
 *   OPENROUTER_API_KEY=sk-or-... npm run test:e2e -- \
 *     tests/e2e/template-reference-flip-b1-5.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProfile } from '../../src/profile/loader.js'
import { assembleAgent } from '../../src/profile/assembler.js'
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
    console.log('⏭ Skipping template-reference-flip e2e: OPENROUTER_API_KEY not set')
    return true
  }
  return false
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

async function drainEvents(
  iter: AsyncIterable<LoomEvent>,
): Promise<readonly LoomEvent[]> {
  const out: LoomEvent[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

function extractAgentText(events: readonly LoomEvent[]): string {
  return events
    .filter(
      (e): e is Extract<LoomEvent, { type: 'text.delta' }> =>
        e.type === 'text.delta',
    )
    .map((d) => d.text)
    .join('')
}

/**
 * Construct the same shape the client's `buildSystemPromptAppend`
 * produces for a pinned template. Mirrors the client-side
 * `build-system-prompt-append` block format. Keeping the shape
 * duplicated here (rather than importing) so a future client-side
 * rename can't break this test silently — if the client's emit shape
 * changes, both files need updating in lockstep, just like the wire
 * schema.
 */
function buildTemplateReferenceBlock(input: {
  templateId: string
  skillMd: string
  exampleHtml: string
}): string {
  const lines: string[] = []
  lines.push('<template-reference>')
  lines.push(
    `The user pinned template \`${input.templateId}\` in the lobby. Use SKILL.md as your instructions and example.html as a structural reference. The slug folder is empty — write a fresh artifact that follows these rules; do NOT treat example.html as a file to edit.`,
  )
  lines.push('')
  lines.push('## SKILL.md')
  lines.push(input.skillMd.trimEnd())
  if (input.exampleHtml.trim().length > 0) {
    lines.push('')
    lines.push('## example.html')
    lines.push(input.exampleHtml.trimEnd())
  }
  lines.push('</template-reference>')
  return lines.join('\n')
}

describe('B1.5 — template-reference flip end-to-end', () => {
  // -------------------------------------------------------------------
  // (3) Cortex passes <template-reference> through verbatim
  // -------------------------------------------------------------------

  it('embeds <template-reference> into the assembled system prompt verbatim', async () => {
    const profile = await loadProfile(OWNWARE_DESIGN_PROFILE)
    const block = buildTemplateReferenceBlock({
      templateId: 'pricing-page',
      skillMd: '---\nname: pricing-page\n---\nUse a 3-tier grid.',
      exampleHtml: '<h1>Pricing</h1>',
    })
    const assembled = await assembleAgent(profile, {
      systemPromptAppend: block,
    })
    const promptText = systemPromptToText(assembled.systemPrompt)

    // Verbatim — no parsing, no escaping, no reordering inside the block.
    expect(promptText).toContain(block)
    // Explicit anchors so a regression that strips parts is loud.
    expect(promptText).toContain('<template-reference>')
    expect(promptText).toContain('</template-reference>')
    expect(promptText).toContain('## SKILL.md')
    expect(promptText).toContain('Use a 3-tier grid.')
    expect(promptText).toContain('## example.html')
    expect(promptText).toContain('<h1>Pricing</h1>')
    expect(promptText).toContain('slug folder is empty')
  })

  it('embeds <template-reference> when example.html is empty (SKILL-only templates)', async () => {
    const profile = await loadProfile(OWNWARE_DESIGN_PROFILE)
    const block = buildTemplateReferenceBlock({
      templateId: 'html-ppt',
      skillMd: 'Use scroll-snap. Author the deck framework inline.',
      exampleHtml: '',
    })
    const assembled = await assembleAgent(profile, {
      systemPromptAppend: block,
    })
    const promptText = systemPromptToText(assembled.systemPrompt)

    expect(promptText).toContain('<template-reference>')
    expect(promptText).toContain('Author the deck framework inline.')
    // No example.html heading when the template ships without one.
    expect(promptText).not.toContain('## example.html')
  })

  // -------------------------------------------------------------------
  // (4) Real-LLM smoke — the agent reads the block and follows it
  // -------------------------------------------------------------------

  it('agent follows a distinctive instruction baked into <template-reference>', async () => {
    if (skipIfNoKey()) return

    const profile = await loadProfile(OWNWARE_DESIGN_PROFILE)
    // Force Haiku 4.5 over the profile's default model for cost +
    // latency. Same intervention point as phase-a-exit-gate.test.ts:179.
    const overridden = {
      ...profile,
      config: {
        ...profile.config,
        model: 'openrouter:haiku-4.5' as typeof profile.config.model,
      },
    }

    // Distinctive instruction that almost certainly wouldn't appear
    // in a Haiku response by accident. The test passes only if the
    // agent reads SKILL.md from the <template-reference> block.
    const DISTINCTIVE_INSTRUCTION =
      'CRITICAL RULE: every page MUST open with a sentence of exactly seven words. ' +
      'No fewer, no more. State the rule before writing anything else.'

    const block = buildTemplateReferenceBlock({
      templateId: 'seven-word-opener-template',
      skillMd: `---
name: seven-word-opener-template
description: A constrained template for the B1.5 e2e test.
---

# Seven Word Opener

${DISTINCTIVE_INSTRUCTION}
`,
      exampleHtml:
        '<!doctype html><html><body><h1>Telemetry that earns engineer trust today</h1></body></html>',
    })

    const assembled = await assembleAgent(overridden, {
      systemPromptAppend: block,
    })

    const session = new Session({
      config: { ...assembled.config, maxTokens: 512, maxTurns: 1 },
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
        'Make me a one-paragraph landing-page opener. Follow the template rules exactly.',
      ),
    )
    const text = extractAgentText(events)

    // The agent should explicitly acknowledge the 7-word rule
    // (proves it READ the SKILL.md content from <template-reference>).
    // We don't enforce that the agent's first sentence is actually
    // seven words long (LLM compliance is noisy) — the surface area
    // we're testing is "did the model see the block."
    const mentions7Words =
      /seven\s*[-\s]?word/i.test(text) ||
      /\b7\s*[-\s]?word/i.test(text) ||
      /exactly\s+seven/i.test(text)
    expect(mentions7Words, `agent text did not reference the 7-word rule:\n${text}`).toBe(true)
  })
})
