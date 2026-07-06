/**
 * e2e — a canvas selection drives a surgical edit, with NO hunting.
 *
 * Proves the Slice 7A/7B payoff with a REAL model: given the constrained
 * `ownware-design` profile + an `<active-selection>` that carries the FILE
 * the element lives on and the TOKEN its CSS references, the agent changes
 * the colour via `set_tokens` — it does NOT `glob` the folder to hunt for
 * the file, and it cannot fall back to the denied `writeFile`/`editFile`.
 *
 * This is the end-to-end version of the assembler unit tests: those prove
 * the prompt block renders; this proves a real model ACTS on it.
 *
 * Gated on OPENROUTER_API_KEY (~$0.01 on Haiku 4.5). Skipped silently
 * without a key.
 *
 * Run:
 *   OPENROUTER_API_KEY=sk-or-... npm run test:e2e -- \
 *     tests/e2e/design-selection-edit.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
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

describe('selection-context drives a surgical edit (real model)', () => {
  it('changes the colour via the constrained tools using the selection, without globbing to hunt', async () => {
    if (OR_KEY === null) {
      console.log('⏭ Skipping design-selection-edit e2e: OPENROUTER_API_KEY not set')
      return
    }

    // A real design folder: a styles.css with an --accent token + a page
    // whose CTA references it. This is the artifact the selection points at.
    const dir = await mkdtemp(join(tmpdir(), 'cx-sel-edit-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(
      join(dir, 'styles.css'),
      ':root {\n  --accent: #635bff;\n  --bg: #ffffff;\n  --fg: #111111;\n}\n' +
        '.cta { background: var(--accent); color: var(--bg); padding: 12px 20px; }\n',
      'utf-8',
    )
    await writeFile(
      join(dir, 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head>' +
        '<body><button class="cta" data-cx-id="hero-cta">Buy now</button></body></html>',
      'utf-8',
    )

    const profile = await loadProfile(PROFILE)
    // Sonnet 4.6 — the profile's shipped tier. Haiku 4.5 is too weak to
    // reliably tool-call on a full design system prompt (it answers in
    // prose), so it doesn't represent the real product; Sonnet does.
    const overridden = {
      ...profile,
      config: {
        ...profile.config,
        model: 'openrouter:anthropic/claude-sonnet-4.6' as typeof profile.config.model,
      },
    }

    // The selection the user "clicked": the CTA, on index.html, using --accent.
    const assembled = await assembleAgent(overridden, {
      activeContext: {
        selection: {
          tag: 'button',
          selector: '[data-cx-id="hero-cta"]',
          outerHTML: '<button class="cta" data-cx-id="hero-cta">Buy now</button>',
          file: 'index.html',
          appliedTokens: [{ name: '--accent', value: '#635bff' }],
        },
      },
    })

    const session = new Session({
      config: {
        ...assembled.config,
        workspacePath: dir, // set_tokens/write_page resolve here
        maxTokens: 1024,
        maxTurns: 4,
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

    const events = await drain(session.submitMessage('Make this button teal.'))
    const tools = toolCalls(events)
    const seq = tools.join(' → ') || '(no tool calls)'

    // Acted via the constrained engine — the denied raw writers never appear.
    expect(tools, `tool sequence: ${seq}`).not.toContain('writeFile')
    expect(tools).not.toContain('editFile')
    // Did NOT hunt: the file + token were handed over, so no folder glob.
    expect(tools, `expected no glob (file was provided); got: ${seq}`).not.toContain('glob')
    // Made the change through the structured tools — set_tokens is the ideal
    // for a shared-token colour; accept write_page/write_component too since
    // either is a legitimate constrained edit.
    const usedConstrainedWriter = tools.some((t) =>
      t === 'set_tokens' || t === 'write_page' || t === 'write_component',
    )
    expect(
      usedConstrainedWriter,
      `expected a constrained write tool (set_tokens/write_page/write_component); got: ${seq}`,
    ).toBe(true)

    // If it set the token, the value actually changed on disk away from violet.
    if (tools.includes('set_tokens')) {
      const css = await readFile(join(dir, 'styles.css'), 'utf-8')
      const m = css.match(/--accent:\s*([^;]+);/)
      expect(m, 'styles.css should still define --accent').not.toBeNull()
      expect(m![1]!.trim().toLowerCase()).not.toBe('#635bff')
    }
  }, 90_000)
})
