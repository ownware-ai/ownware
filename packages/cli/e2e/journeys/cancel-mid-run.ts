/**
 * The customer changes their mind mid-answer and hits esc, then ctrl-c.
 *
 * The law: esc cancels the RUN over the wire — it does not kill the CLI.
 * Ctrl-C at an idle prompt exits. Getting this wrong either strands a
 * run server-side or throws away the session the customer wanted to keep.
 */

import type { Journey } from '../harness/journey.ts'

export const cancelMidRun: Journey = {
  id: 'cancel-mid-run',
  title: 'changes their mind and interrupts a long answer',
  customer:
    'Someone who asked for something long, realised it was wrong, and wants the terminal back immediately.',
  badLooksLike:
    'Esc killing the whole CLI instead of the run; text continuing to stream after the cancel; no acknowledgement that anything was cancelled; the prompt never returning; ctrl-c leaving a gateway process behind.',
  requires: ['ollama-chat'],
  timeoutMs: 240_000,

  async run(ctx) {
    const pty = ctx.start(['--model', 'ollama:llama3.2', '--simple'], { cols: 100, rows: 30 })
    await pty.waitForText('❯', { timeoutMs: 90_000 })
    await pty.waitForQuiet(1_000, 20_000)

    const beforeAsk = pty.mark()
    await pty.type('Write a long detailed essay about the history of terminal emulators.')
    await pty.key('enter')
    // Wait for the answer to be VISIBLY under way. Cancelling during the
    // pre-token wait is a different scenario (covered separately) and
    // would make this journey test nothing about interrupting a stream.
    await pty.waitForText(/\w{40,}|\n.*\n.*\n/, {
      timeoutMs: 120_000,
      since: beforeAsk,
      why: 'the essay must be streaming before esc means anything',
    })
    const mid = ctx.frame('mid-run, before the interrupt', pty)
    ctx.note(`screen height at interrupt: ${mid.lines.length} lines`)

    await pty.key('esc')
    await pty.waitForQuiet(2_500, 30_000)
    const cancelled = ctx.frame('right after esc', pty)
    const cancelText = cancelled.lines.join('\n')

    ctx.check(
      'esc did not kill the CLI',
      !pty.hasExited,
      'esc cancels the run over the wire; killing the process loses the session',
    )
    ctx.check(
      'the cancel is acknowledged on screen',
      /cancel|interrupt|stopped/i.test(cancelText),
      'silence after esc leaves the customer unsure whether it worked',
    )

    // Nothing may keep streaming once the run is cancelled.
    const settled = cancelled.lines.length
    await pty.waitForQuiet(3_000, 20_000)
    const after = ctx.frame('three seconds after the cancel', pty)
    ctx.check(
      'output stopped growing after the cancel',
      after.lines.length - settled <= 2,
      `screen grew by ${after.lines.length - settled} lines after cancelling`,
    )

    // And the session is still usable.
    await pty.type('are you still there?')
    await pty.key('enter')
    await pty.waitForQuiet(3_000, 120_000)
    const reused = ctx.frame('the session after a cancel', pty)
    ctx.check(
      'the prompt accepts work again',
      reused.lines.join('\n').includes('still there?'),
      'a cancelled run must leave a working session behind',
    )

    // Ctrl-C at the idle prompt is the documented way out.
    await pty.key('ctrlC')
    const exit = await pty.waitExit(20_000)
    ctx.check(
      'ctrl-c at the idle prompt exits',
      pty.hasExited,
      `exit code ${exit.exitCode}`,
    )
  },
}
