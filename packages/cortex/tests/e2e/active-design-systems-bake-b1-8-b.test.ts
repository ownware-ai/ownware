/**
 * Slice B1.8.B — `<active-design-systems>` bake migration end-to-end.
 *
 * Pins the new behaviour shipped on 2026-05-27:
 *
 *   1. The client's `buildSystemPromptAppend` emits an
 *      `<active-design-systems>` block carrying DESIGN.md +
 *      tokens.css verbatim for each pinned design system. (Covered by
 *      the client's own build-system-prompt-append tests.)
 *
 *   2. Cortex passes systemPromptAppend through verbatim — the
 *      assembler does not parse it, does not filter it, does not
 *      reorder its contents. The `<active-design-systems>` block
 *      lands in the agent's system prompt as written, with both
 *      DESIGN.md prose and tokens.css `--cx-*` declarations intact.
 *
 *   3. Cortex's shared assembler no longer emits a parallel
 *      `<active-design-systems>` block from `renderActiveContextFragment`
 *      (the A5b summary block was removed in this slice — the Design
 *      vertical owns the block client-side now). Even when
 *      `activeContext.designSystems[]` is populated, no block ships
 *      from the shared assembler.
 *
 *   4. A real model READS the `<active-design-systems>` block and
 *      follows a distinctive instruction baked into DESIGN.md.
 *
 * Test (4) is gated on `OPENROUTER_API_KEY` — it costs ~$0.01 on
 * Haiku 4.5 and is skipped silently in CI without keys. Tests (2)
 * and (3) run unconditionally.
 *
 * Run:
 *   OPENROUTER_API_KEY=sk-or-... npm run test:e2e -- \
 *     tests/e2e/active-design-systems-bake-b1-8-b.test.ts
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
    console.log('⏭ Skipping active-design-systems-bake e2e: OPENROUTER_API_KEY not set')
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
 * Mirror of the client's emit shape
 * (`renderActiveDesignSystems` in its build-system-prompt-append
 * module). Kept duplicated here (not imported) so a future
 * client-side rename surfaces as a test diff in both files at once —
 * same discipline as the B1.5 e2e mirror of `<template-reference>`.
 */
function buildActiveDesignSystemsBlock(
  systems: Array<{ id: string; name: string; designMd: string; tokensCss: string }>,
): string {
  const lines: string[] = []
  lines.push('<active-design-systems>')
  if (systems.length === 1) {
    lines.push(
      `The user pinned this design system in the 🎨 picker. Default to its DESIGN.md rules and use the tokens from tokens.css when picking colors / typography / spacing. The full content lives here every turn — you don't need to call \`apply_design_system\`.`,
    )
  } else {
    lines.push(
      `The user pinned ${systems.length} design systems in the 🎨 picker. Default to their DESIGN.md rules and use the tokens from each tokens.css when picking colors / typography / spacing. Systems are listed in pin order — the first one is the primary; cite the others only when their guidance applies to a specific surface. The full content lives here every turn — you don't need to call \`apply_design_system\`.`,
    )
  }
  for (const ds of systems) {
    lines.push('')
    lines.push(`## ${ds.name} (\`${ds.id}\`)`)
    lines.push('')
    lines.push('### DESIGN.md')
    lines.push(ds.designMd.trimEnd())
    lines.push('')
    lines.push('### tokens.css')
    lines.push(ds.tokensCss.trimEnd())
  }
  lines.push('</active-design-systems>')
  return lines.join('\n')
}

describe('B1.8.B — <active-design-systems> bake end-to-end', () => {
  // -------------------------------------------------------------------
  // (2) Cortex passes <active-design-systems> through verbatim
  // -------------------------------------------------------------------

  it('embeds <active-design-systems> into the assembled system prompt verbatim', async () => {
    const profile = await loadProfile(OWNWARE_DESIGN_PROFILE)
    const block = buildActiveDesignSystemsBlock([
      {
        id: 'modern-minimal',
        name: 'Modern Minimal',
        designMd: '# Modern Minimal\n\n- 1 accent color\n- generous whitespace\n',
        tokensCss: ':root {\n  --cx-violet: #7C5CFC;\n  --space-4: 16px;\n}\n',
      },
    ])

    const assembled = await assembleAgent(profile, {
      systemPromptAppend: block,
    })
    const promptText = systemPromptToText(assembled.systemPrompt)

    expect(promptText).toContain(block)
    expect(promptText).toContain('<active-design-systems>')
    expect(promptText).toContain('</active-design-systems>')
    expect(promptText).toContain('## Modern Minimal (`modern-minimal`)')
    expect(promptText).toContain('### DESIGN.md')
    expect(promptText).toContain('1 accent color')
    expect(promptText).toContain('### tokens.css')
    expect(promptText).toContain('--cx-violet: #7C5CFC')
  })

  it('handles multiple pinned design systems with the plural preamble', async () => {
    const profile = await loadProfile(OWNWARE_DESIGN_PROFILE)
    const block = buildActiveDesignSystemsBlock([
      { id: 'a', name: 'A', designMd: 'A rules', tokensCss: ':root { --a: 1px; }' },
      { id: 'b', name: 'B', designMd: 'B rules', tokensCss: ':root { --b: 2px; }' },
    ])
    const assembled = await assembleAgent(profile, {
      systemPromptAppend: block,
    })
    const promptText = systemPromptToText(assembled.systemPrompt)
    expect(promptText).toMatch(/pinned 2 design systems/i)
    expect(promptText).toContain('## A (`a`)')
    expect(promptText).toContain('## B (`b`)')
  })

  // -------------------------------------------------------------------
  // (3) Cortex's shared assembler does NOT emit a parallel block
  // -------------------------------------------------------------------

  it('does NOT emit a parallel <active-design-systems> from the shared assembler when activeContext.designSystems is populated', async () => {
    const profile = await loadProfile(OWNWARE_DESIGN_PROFILE)
    // activeContext.designSystems is the LEGACY typed-metadata path
    // (kept on the wire for non-Design clients). Pre-B1.8.B this would
    // have rendered a summary block. Post-B1.8.B the client side owns
    // the block — the shared assembler stays silent here.
    const assembled = await assembleAgent(profile, {
      activeContext: {
        designSystems: [
          {
            id: 'editorial-monocle',
            name: 'Editorial Monocle',
            category: 'editorial',
            surface: 'web',
            swatches: ['#0E0E0E', '#FAF7EE'],
            summary: 'serif magazine',
          },
        ],
      },
    })
    const promptText = systemPromptToText(assembled.systemPrompt)
    // The block itself must not appear — that's what this slice removed.
    expect(promptText).not.toContain('<active-design-systems>')
    // We do NOT assert the tool name `apply_design_system` is absent
    // from the prompt at large — the profile's skills catalogue (e.g.
    // `/theme-generator`) can legitimately reference it as one of the
    // tools the agent can call. The slice only removes the cortex-side
    // SUMMARY BLOCK that used to instruct the agent to call that tool;
    // the tool itself stays. (The client's bake block doesn't reference it.)
  })

  // -------------------------------------------------------------------
  // (4) Real-LLM smoke — the agent reads the block and follows it
  // -------------------------------------------------------------------

  it('agent follows a distinctive instruction baked into DESIGN.md', async () => {
    if (skipIfNoKey()) return

    const profile = await loadProfile(OWNWARE_DESIGN_PROFILE)
    // Force Haiku 4.5 — same intervention point as the B1.5 e2e.
    const overridden = {
      ...profile,
      config: {
        ...profile.config,
        model: 'openrouter:haiku-4.5' as typeof profile.config.model,
      },
    }

    // Distinctive instruction unlikely to surface in a Haiku response
    // by accident. Passes only if the agent reads DESIGN.md from the
    // baked block.
    const DISTINCTIVE_RULE =
      'CRITICAL DESIGN RULE: every visual response MUST mention the magenta-glass-on-bone palette by name. ' +
      'If asked about colors or styling, state this rule before answering.'

    const block = buildActiveDesignSystemsBlock([
      {
        id: 'magenta-glass-test',
        name: 'Magenta Glass Test',
        designMd: `# Magenta Glass on Bone\n\n${DISTINCTIVE_RULE}\n`,
        tokensCss: ':root {\n  --magenta-glass: #E91E63CC;\n  --bone: #F5F1E8;\n}\n',
      },
    ])

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
        'I already pinned a design system in the picker. Confirm which palette it carries in one short sentence — read the system you can see in your context. Skip discovery; just name the palette.',
      ),
    )
    const text = extractAgentText(events)

    // The agent should mention the distinctive palette name (proves it
    // READ the DESIGN.md content baked into <active-design-systems>).
    const mentionsPalette =
      /magenta[-\s]glass/i.test(text) ||
      /magenta\s*glass\s*on\s*bone/i.test(text)
    expect(
      mentionsPalette,
      `agent text did not reference the magenta-glass-on-bone palette:\n${text}`,
    ).toBe(true)
  })
})
