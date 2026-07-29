/**
 * NO_COLOR=1 — the accessibility and CI setting.
 *
 * The rule the package states: colour collapses to identity. The risk is
 * that meaning was carried ONLY by colour, so with it gone the customer
 * can no longer tell a denied tool from an allowed one, or an error from
 * a note. That is not something a byte-stream test can see; it needs the
 * grid with the palette read off it.
 */

import type { Journey } from '../harness/journey.ts'

export const noColorTerminal: Journey = {
  id: 'no-color-terminal',
  title: 'runs with NO_COLOR set',
  customer:
    'Someone using a monochrome terminal, a screen reader, or a CI log — plus anyone who sets NO_COLOR by policy.',
  badLooksLike:
    'Escape sequences printed literally; markdown markers left behind because the styler was the thing removing them; status and error lines that become indistinguishable once colour is gone.',
  requires: ['ollama-chat'],
  timeoutMs: 240_000,

  async run(ctx) {
    const pty = ctx.start(['--model', 'ollama:llama3.2', '--simple'], {
      cols: 100,
      rows: 30,
      env: { NO_COLOR: '1' },
    })
    await pty.waitForText('❯', { timeoutMs: 90_000 })
    await pty.waitForQuiet(1_500, 30_000)

    await pty.type('Answer in one short sentence: what is NO_COLOR?')
    await pty.key('enter')
    await pty.waitForQuiet(4_000, 180_000)
    const screen = ctx.frame('the transcript with no colour', pty)
    const text = screen.lines.join('\n')

    ctx.check(
      'no colour is actually emitted',
      screen.palette.length === 0,
      `palette in use: ${screen.palette.join(' ')} — NO_COLOR must collapse styling to identity`,
    )
    ctx.check(
      'no escape sequence is printed as text',
      !/\[[0-9;]+m/.test(text),
      'stripping colour by deleting the terminal codes badly leaves them visible',
    )
    ctx.check(
      'markdown is still rendered, not dumped raw',
      !/\*\*\w/.test(text),
      'if the styler was also the markdown renderer, NO_COLOR would expose the markers',
    )
    ctx.note(
      'Judge: with colour gone, can you still tell the prompt, the reply and any status line apart by shape alone?',
    )

    await pty.type('/exit')
    await pty.key('enter')
    const exit = await pty.waitExit(20_000)
    ctx.check('clean exit', exit.exitCode === 0, `exit code ${exit.exitCode}`)
  },
}
