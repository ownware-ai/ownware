/**
 * They submit, immediately think better of it, and hit esc — before a
 * single token has come back.
 *
 * This is the window between "the prompt was submitted" and "the stream
 * started", and it used to belong to readline rather than to the run:
 * the esc did not cancel, and the raw byte was echoed into the NEXT
 * prompt as a literal `^[`, so the customer's following message was
 * typed into a corrupted line (FINDINGS F6).
 *
 * The assertions here deliberately do not depend on WHERE the esc lands.
 * A fast local model may already be streaming by the time the byte
 * arrives, and that is fine — what must hold either way is that no
 * escape byte is ever echoed as text and the next prompt is clean.
 */

import type { Journey } from '../harness/journey.ts'

export const escBeforeFirstToken: Journey = {
  id: 'esc-before-first-token',
  title: 'hits esc the instant after submitting, before any answer',
  customer:
    'Someone who realised they sent the wrong prompt the moment they pressed enter, and reaches straight for esc.',
  badLooksLike:
    'A literal `^[` appearing in the transcript or in the next prompt line; the following message typed into a corrupted line; the escape silently doing nothing with no acknowledgement; input echoing twice.',
  requires: ['ollama-chat'],
  timeoutMs: 240_000,

  async run(ctx) {
    const pty = ctx.start(['--model', 'ollama:llama3.2', '--simple'], { cols: 100, rows: 30 })
    await pty.waitForText('❯', { timeoutMs: 90_000 })
    await pty.waitForQuiet(1_000, 20_000)

    await pty.type('Write an extremely long and detailed essay about the history of the terminal.')
    // A human reaching for esc is tens of milliseconds behind the enter,
    // so the two bytes are separate tty reads. (Written back-to-back
    // they land in ONE read, which readline consumes whole before any
    // listener can exist — that case cannot cancel, and claiming
    // otherwise would overstate the fix.) 120ms still lands long before
    // the first token: a local model takes seconds to load.
    await pty.key('enter', 120)
    await pty.key('esc')
    await pty.waitForQuiet(4_000, 120_000)

    const after = ctx.frame('right after an immediate esc', pty)
    const text = after.lines.join('\n')

    ctx.check(
      'no escape byte is echoed as text',
      !text.includes('^['),
      'the raw esc leaking into readline is what corrupted the next prompt line',
    )
    ctx.check(
      'the CLI is still alive',
      !pty.hasExited,
      'esc cancels a run; it must never take the session down',
    )
    ctx.check(
      'the esc actually cancelled the run',
      /cancel|interrupt|stopped/i.test(text),
      'an esc pressed before the first token must reach the run, not vanish',
    )

    // The real damage was to the NEXT message. Type a known string and
    // require it back exactly once, on one line.
    const beforeNext = pty.mark()
    await pty.type('hello world')
    await pty.waitForQuiet(800, 20_000)
    const typed = ctx.frame('typing the next message after the esc', pty)
    // Typing lands IN the existing prompt row, not below it.
    const region = typed.lines.slice(Math.max(0, beforeNext - 1)).join('\n')

    ctx.check(
      'the next message is echoed intact',
      region.includes('hello world'),
      `after the esc the input line showed: ${region.trim().slice(0, 120)}`,
    )
    ctx.check(
      'the next message is not preceded by escape debris',
      !/\^\[.*hello world/.test(region),
      'the F6 symptom was exactly `❯ ^[hello world`',
    )
    ctx.check(
      'the next message is not echoed twice',
      (region.match(/hello world/g) ?? []).length === 1,
      `echo count: ${(region.match(/hello world/g) ?? []).length}`,
    )

    // Clear the half-typed line before leaving, so this measures the
    // documented exit and not ctrl-c-with-a-partial-line (a separate
    // question, and not what this journey is about).
    await pty.key('ctrlC', 300)
    await pty.type('/exit')
    await pty.key('enter')
    const exit = await pty.waitExit(20_000)
    ctx.check('the session still exits cleanly', exit.exitCode === 0, `exit code ${exit.exitCode}`)
  },
}
