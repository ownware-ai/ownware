/**
 * Subagent envelope coverage — production-grade test.
 *
 * Pins the contract that closes the long-standing "spawned helpers
 * miss universal hygiene fragments" gap:
 *
 *   1. `buildSubagentSystemPrompt(profile, tools)` includes the same
 *      universal Loom fragments the main agent receives (system rules,
 *      thinking-frequency, safety-principle, output style, compaction,
 *      tool-usage). When the universal set evolves, the assertion list
 *      below should evolve with it — that is the whole point.
 *   2. The helper's identity (SOUL.md content) is also present.
 *   3. No domain-specific coding content leaks in via the universal
 *      fragments — the engine baseline must stay neutral. Coding
 *      examples (rm -rf, git push, OWASP, file_path:line_number) live
 *      in the `coder/SOUL.md` and other profile SOULs, never in the
 *      universal block.
 *   4. Tool-usage rules adapt to which tools the helper actually has
 *      (filesystem-only helpers don't get shell-only rules).
 *
 * If a future change reintroduces the gap (subagent path bypassing the
 * universal fragments), this test goes red.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { buildSubagentSystemPrompt } from '../../../src/profile/assembler.js'
import { loadProfile } from '../../../src/profile/loader.js'
import { createMinimalProfile } from '../../helpers/fixtures.js'
import type { Tool } from '@ownware/loom'
import { filesystemTools, shellTools } from '@ownware/loom'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

function track<T extends { cleanup: () => Promise<void> }>(p: T): T {
  cleanups.push(p.cleanup)
  return p
}

describe('buildSubagentSystemPrompt — universal envelope coverage', () => {
  it('includes the six universal Loom fragments same as a top-level profile', async () => {
    const { dir } = track(await createMinimalProfile({
      systemPrompt: 'You are the Test Helper.',
    }))
    const profile = await loadProfile(dir)
    const tools: Tool[] = [...filesystemTools, ...shellTools]

    const prompt = buildSubagentSystemPrompt(profile, tools)

    // System rules fragment — every agent must read <system-reminder>
    // tags and honor parallel-tool-call discipline. Today helpers
    // miss this; this test enforces they no longer do.
    expect(prompt).toContain('# System')
    expect(prompt).toContain('parallel')

    // Thinking-frequency fragment — calibrate reasoning depth.
    expect(prompt.toLowerCase()).toContain('calibrate')

    // Safety-principle fragment — universal reversibility / blast radius.
    expect(prompt.toLowerCase()).toContain('reversibility')
    expect(prompt.toLowerCase()).toContain('blast radius')

    // Output style fragment — concise, no-colon-before-tool.
    expect(prompt).toContain('# Tone and style')

    // Compaction-awareness fragment — write down important info.
    expect(prompt.toLowerCase()).toContain('important information')

    // Tool-usage fragment — at least the universal "general rules" line.
    expect(prompt).toContain('# Using your tools')
  })

  it('includes the helper\'s identity (SOUL.md) — placed AFTER the universal block', async () => {
    // The fixture's default SOUL.md is "# Test Agent\nYou are a test agent."
    // — that's the identity content we expect to land in the assembled
    // prompt. This test asserts ordering: identity must appear AFTER
    // the universal fragments so the universal prefix can be shared
    // across helpers and benefit from prefix caching at the wire level.
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)

    const prompt = buildSubagentSystemPrompt(profile, [...filesystemTools])

    const SOUL_MARKER = 'You are a test agent.'
    expect(prompt).toContain(SOUL_MARKER)

    const identityIdx = prompt.indexOf(SOUL_MARKER)
    const safetyIdx = prompt.toLowerCase().indexOf('blast radius')
    expect(safetyIdx).toBeGreaterThan(-1)
    expect(identityIdx).toBeGreaterThan(safetyIdx)
  })

  it('keeps the universal block domain-neutral — no coding-flavored leaks', async () => {
    const { dir } = track(await createMinimalProfile({
      systemPrompt: 'Generic helper, no domain.',
    }))
    const profile = await loadProfile(dir)
    const tools: Tool[] = [...filesystemTools]

    const prompt = buildSubagentSystemPrompt(profile, tools)

    // Universal fragments must NOT contain coding examples — those
    // moved to coder/SOUL.md in the prior chunk. If any sneak back in,
    // a non-coding helper inherits coding bias from the engine.
    const lower = prompt.toLowerCase()
    expect(lower).not.toContain('rm -rf')
    expect(lower).not.toContain('git push')
    expect(lower).not.toContain('git reset')
    expect(lower).not.toContain('owasp')
    expect(lower).not.toContain('file_path:line_number')
    expect(lower).not.toContain('owner/repo#')
  })

  it('tool-usage rules adapt to the helper\'s actual tool subset', async () => {
    const { dir } = track(await createMinimalProfile({
      systemPrompt: 'Read-only scout.',
    }))
    const profile = await loadProfile(dir)

    // Read-only helper: filesystem tools only, no shell.
    const readonlyPrompt = buildSubagentSystemPrompt(
      profile,
      filesystemTools.filter(t => t.isReadOnly === true),
    )
    // The "prefer dedicated tools over shell" sub-block is gated on
    // hasShell — should NOT appear when no shell tool is loaded.
    expect(readonlyPrompt).not.toContain('Reserve shell execution')

    // Mixed helper: filesystem + shell. Shell-related rules SHOULD appear.
    const mixedPrompt = buildSubagentSystemPrompt(
      profile,
      [...filesystemTools, ...shellTools],
    )
    expect(mixedPrompt).toContain('Reserve shell execution')
  })

  it('falls back to inline systemPrompt when no SOUL.md is present', async () => {
    const INLINE_MARKER = 'INLINE-ONLY HELPER PROMPT.'
    const { dir } = track(await createMinimalProfile({
      systemPrompt: INLINE_MARKER,
    }))
    const profile = await loadProfile(dir)
    // Force soulMd absent to exercise the fallback branch.
    const profileSansSoul = { ...profile, soulMd: '' as const }

    const prompt = buildSubagentSystemPrompt(profileSansSoul, [...filesystemTools])

    // SOUL was empty, so `config.systemPrompt` is the identity source.
    expect(prompt).toContain(INLINE_MARKER)
  })
})
