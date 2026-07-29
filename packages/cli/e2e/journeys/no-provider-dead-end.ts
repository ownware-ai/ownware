/**
 * The unhappy path that decides whether someone stays: they run the CLI
 * with no API key and no local model configured, ask something, and it
 * cannot answer.
 *
 * The board's contract is "the prompt is never a dead end" — the run
 * must fail honestly, explain the way forward, and hand the prompt back.
 * A hang, a stack trace, or a silent empty reply all lose the customer.
 */

import type { Journey } from '../harness/journey.ts'

export const noProviderDeadEnd: Journey = {
  id: 'no-provider-dead-end',
  title: 'asks a question with no provider configured',
  customer:
    'Someone trying Ownware for the first time on a machine with no API keys, who has not read any docs.',
  badLooksLike:
    'A raw stack trace or provider SDK error; a hang with no output; an empty reply that looks like success; an error that names a provider but never says what to DO next; the CLI exiting instead of returning to the prompt.',
  timeoutMs: 120_000,

  async run(ctx) {
    const pty = ctx.start(['--model', 'openai:gpt-5.5', '--simple'], { cols: 100, rows: 40 })
    await pty.waitForText('❯', { timeoutMs: 60_000, why: 'the prompt must appear even with no provider' })
    ctx.frame('prompt reached with no key', pty)

    await pty.type('what can you do?')
    await pty.key('enter')
    await pty.waitForQuiet(3_000, 60_000)
    const screen = ctx.frame('the honest failure', pty)
    const text = screen.lines.join('\n')

    ctx.check(
      'says something rather than nothing',
      text.trim().length > 0,
      'silence after a question is the worst possible answer',
    )
    ctx.check(
      'names the missing thing',
      /key|provider|configur|model/i.test(text),
      'the customer must be able to tell WHY it failed',
    )
    ctx.check(
      'offers a way forward',
      /ollama|OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|export |set /i.test(text),
      'an error with no next step is a dead end — the board contract',
    )
    ctx.check(
      'no raw stack trace',
      !/\n\s+at .+\(.+:\d+:\d+\)/.test(text) && !/node:internal/.test(text),
      'stack traces tell a customer the product is broken, not that they are missing a key',
    )

    // The prompt must come back — the run failing is not the session failing.
    await pty.type('still here?')
    await pty.key('enter')
    await pty.waitForQuiet(2_000, 30_000)
    const after = ctx.frame('prompt survived the failure', pty)
    ctx.check(
      'the session survives a failed run',
      !pty.hasExited,
      'the CLI must not exit because one run could not find a provider',
    )
    ctx.check(
      'the second prompt was accepted',
      after.lines.join('\n').includes('still here?'),
      'input after a failure must still be echoed and attempted',
    )

    await pty.type('/exit')
    await pty.key('enter')
    const exit = await pty.waitExit(15_000)
    ctx.check('/exit leaves cleanly', exit.exitCode === 0, `exit code ${exit.exitCode}`)
  },
}
