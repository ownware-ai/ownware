/**
 * The same first minute, but the real one: Bun + a TTY, so the OpenTUI
 * split-footer shell runs — wordmark, bordered prompt, live group,
 * status line. This is the path an installed customer actually gets.
 *
 * It is also the path with the most rendering history: the eaten-bytes
 * bug, tofu glyphs, the cramped stack. The grid reconstruction is what
 * makes those visible without a human screenshot.
 */

import type { Journey } from '../harness/journey.ts'

export const tuiFirstContact: Journey = {
  id: 'tui-first-contact',
  title: 'first contact through the real TUI shell (bun + tty)',
  customer:
    'The installed-customer path — a dev running `ownware` in their terminal with no flags, seeing the shell as designed.',
  badLooksLike:
    'Eaten characters in the echoed line; tofu boxes where glyphs should be; the footer overlapping the transcript; a status line that never leaves "busy"; the wordmark clipped at the terminal width; anything that repaints over what the customer already read.',
  requires: ['ollama-chat'],
  timeoutMs: 240_000,

  async run(ctx) {
    const pty = ctx.start(['--model', 'ollama:llama3.2'], { cols: 100, rows: 30, runtime: 'bun' })

    await pty.waitForText('❯', { timeoutMs: 90_000, why: 'the composed footer must reach the input' })
    await pty.waitForQuiet(1_500, 30_000)
    const opening = ctx.frame('wordmark and composed footer', pty)
    const openingText = opening.lines.join('\n')

    ctx.check(
      'the splash names the product',
      /own\s*ware|ownware/i.test(openingText.replace(/\s+/g, ' ')),
      'the pixel wordmark should be readable as a word in the grid',
    )
    ctx.check('a prompt is visible', openingText.includes('❯'))
    ctx.check(
      'no replacement characters (the tofu bug)',
      !openingText.includes('�'),
      'a replacement char means bytes were eaten before the terminal saw them',
    )
    ctx.check(
      'the wordmark fits the terminal width',
      opening.lines.every((l) => l.length <= pty.cols),
      'anything wider than the terminal wraps and destroys the splash',
    )

    await pty.type('Reply with exactly the word pong and nothing else.')
    await pty.waitForQuiet(600, 10_000)
    const typed = ctx.frame('what the typed line looks like', pty)
    ctx.check(
      'the typed text is intact in the input',
      typed.lines.join('\n').includes('pong and nothing else'),
      'the eaten-bytes bug showed up exactly here — as a truncated echo',
    )

    await pty.key('enter')
    await pty.waitForText(/pong/i, { timeoutMs: 180_000, why: 'the shell must stream the reply into scrollback' })
    await pty.waitForQuiet(2_500, 60_000)
    const replied = ctx.frame('after the reply', pty)
    const repliedText = replied.lines.join('\n')

    ctx.check('the reply reached scrollback', /pong/i.test(repliedText))
    ctx.check(
      'the status line settled out of busy',
      !/working…|working\.\.\./i.test(repliedText),
      'a status stuck on busy after the turn ends makes the CLI look hung',
    )
    ctx.check(
      'no gateway log noise on screen',
      !/\[(loom|boot-trace|session-runner)/.test(repliedText),
    )
    ctx.note('Judge: does the spacing read as blocks, or is the echo/reply stack cramped?')

    await pty.type('/exit')
    await pty.key('enter')
    const exit = await pty.waitExit(20_000)
    ctx.check('clean exit from the TUI', exit.exitCode === 0, `exit code ${exit.exitCode}`)
    const final = ctx.frame('the terminal we leave behind', pty)
    ctx.check(
      'the terminal is left usable',
      final.lines.length > 0,
      'a shell that exits into a blanked or half-repainted terminal is a bug',
    )
  },
}
