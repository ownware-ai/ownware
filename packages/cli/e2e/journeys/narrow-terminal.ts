/**
 * A split pane, a laptop, a tmux window: 60 columns.
 *
 * Terminal width is the single most common reason a good-looking TUI
 * falls apart in someone else's setup, and it is invisible in any test
 * that reads the byte stream instead of the painted grid.
 */

import type { Journey } from '../harness/journey.ts'

export const narrowTerminal: Journey = {
  id: 'narrow-terminal',
  title: 'runs in a 60-column split pane',
  customer: 'A dev with the CLI in a narrow tmux split next to their editor.',
  badLooksLike:
    'The banner or status line wrapping into a second ragged row; a bordered box wider than the pane; the reply text broken mid-word; the prompt pushed off screen; anything that assumed 80+ columns.',
  requires: ['ollama-chat'],
  timeoutMs: 240_000,

  async run(ctx) {
    const pty = ctx.start(['--model', 'ollama:llama3.2', '--simple'], { cols: 60, rows: 24 })
    await pty.waitForText('❯', { timeoutMs: 90_000 })
    await pty.waitForQuiet(1_500, 30_000)
    const opening = ctx.frame('banner at 60 columns', pty)

    ctx.check(
      'nothing is painted past the pane edge',
      opening.lines.every((l) => l.length <= 60),
      'lines longer than the terminal wrap into ragged half-rows',
    )
    ctx.note('Judge: does the banner still read as a banner at this width, or as debris?')

    await pty.type('In one sentence, what is a pseudo-terminal?')
    await pty.key('enter')
    await pty.waitForQuiet(4_000, 180_000)
    const answered = ctx.frame('a wrapped reply at 60 columns', pty)

    ctx.check(
      'reply respects the width',
      answered.lines.every((l) => l.length <= 60),
    )
    ctx.check(
      'the prompt is still reachable',
      answered.lines.some((l) => l.includes('❯')),
    )

    // The customer drags the pane wider mid-session — a resize must not
    // corrupt what is already on screen.
    pty.resize(100, 30)
    await pty.waitForQuiet(1_500, 20_000)
    const resized = ctx.frame('after widening the pane to 100', pty)
    ctx.check(
      'resize does not corrupt the screen',
      !resized.lines.join('\n').includes('�'),
    )
    ctx.note('Judge: after the resize, is the layout coherent or does it need a redraw the customer cannot trigger?')

    await pty.type('/exit')
    await pty.key('enter')
    const exit = await pty.waitExit(20_000)
    ctx.check('clean exit', exit.exitCode === 0, `exit code ${exit.exitCode}`)
  },
}
