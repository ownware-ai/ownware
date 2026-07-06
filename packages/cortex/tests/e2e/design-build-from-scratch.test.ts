/**
 * e2e — a real model BUILDS through the constrained tools, gate intact.
 *
 * The companion to design-selection-edit (which proves the EDIT path). This
 * proves the BUILD path: from an empty design folder, a real model produces
 * a page via `write_page` / `write_component` and defines its system via
 * `set_tokens` — never the denied `writeFile`/`editFile`/`shell`. The
 * anti-hardcode gate is live the whole time (write_page/write_component
 * reject raw colours below :root), so a clean build is itself proof the
 * agent stayed inside the token discipline.
 *
 * Gated on OPENROUTER_API_KEY. Uses Sonnet 4.6 (the shipped tier — Haiku is
 * too weak to drive the constrained tools). ~$0.10 for a one-section build.
 *
 * Run:
 *   OPENROUTER_API_KEY=sk-or-... npm run test:e2e -- \
 *     tests/e2e/design-build-from-scratch.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProfile } from '../../src/profile/loader.js'
import { assembleAgent } from '../../src/profile/assembler.js'
import { Session, type LoomEvent } from '@ownware/loom'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROFILE = join(HERE, '..', '..', 'profiles', 'ownware-design')

const OR_KEY =
  process.env['OPENROUTER_API_KEY'] &&
  !process.env['OPENROUTER_API_KEY'].includes('OWNWARE_TEST_DUMMY')
    ? process.env['OPENROUTER_API_KEY']
    : null

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

async function drain(iter: AsyncIterable<LoomEvent>): Promise<LoomEvent[]> {
  const out: LoomEvent[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

function toolCalls(events: readonly LoomEvent[]): string[] {
  return events
    .filter(
      (e): e is Extract<LoomEvent, { type: 'tool.call.start' }> =>
        e.type === 'tool.call.start',
    )
    .map((e) => e.toolName)
}

describe('build-from-scratch through the constrained tools (real model)', () => {
  it('builds a page via write_page/write_component + set_tokens, never raw writers', async () => {
    if (OR_KEY === null) {
      console.log('⏭ Skipping design-build e2e: OPENROUTER_API_KEY not set')
      return
    }

    const dir = await mkdtemp(join(tmpdir(), 'cx-build-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))

    const profile = await loadProfile(PROFILE)
    const overridden = {
      ...profile,
      config: {
        ...profile.config,
        model: 'openrouter:anthropic/claude-sonnet-4.6' as typeof profile.config.model,
      },
    }
    const assembled = await assembleAgent(overridden, {})

    const session = new Session({
      config: {
        ...assembled.config,
        workspacePath: dir,
        maxTokens: 4096,
        // The agent calls set_tokens once per turn, so a real build needs
        // room: ~2 explore + ~6-8 tokens + ~1-2 write_page turns.
        maxTurns: 18,
      },
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

    const events = await drain(
      session.submitMessage(
        'Build a single landing-page hero on index: a headline, one line of ' +
          'subtext, and a primary call-to-action button. Cobalt accent, clean ' +
          'and minimal. Keep it to the hero only — one screen, ship it.',
      ),
    )
    const tools = toolCalls(events)
    const seq = tools.join(' → ') || '(no tool calls)'

    // Never the denied raw-write paths — the gate cannot be sidestepped.
    expect(tools, `tools: ${seq}`).not.toContain('writeFile')
    expect(tools).not.toContain('editFile')
    expect(tools).not.toContain('shell_execute')
    // Built through the structured tools.
    expect(
      tools.some((t) => t === 'write_page' || t === 'write_component'),
      `expected write_page/write_component; got: ${seq}`,
    ).toBe(true)

    // A page actually landed on disk.
    const files = await readdir(dir)
    expect(
      files.some((f) => f.endsWith('.html')),
      `expected an .html page on disk; got: ${files.join(', ')}`,
    ).toBe(true)

    // If it created styles.css (via set_tokens), it carries a :root token
    // block — the system lives in tokens, by construction.
    if (files.includes('styles.css')) {
      const css = await readFile(join(dir, 'styles.css'), 'utf-8')
      expect(css).toMatch(/:root\s*\{/)
      expect(css).toMatch(/--[a-z0-9-]+\s*:/i)
    }
  }, 120_000)
})
