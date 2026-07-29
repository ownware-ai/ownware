/**
 * The promise on the tin: `cd my-project && ownware`, no key, an answer.
 *
 * This is the fallback (plain-ANSI) renderer under Node. `tui-first-contact`
 * covers the same moment through the OpenTUI shell under Bun — both are
 * shipped paths and both are what somebody's first minute looks like.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Journey } from '../harness/journey.ts'

export const firstRunKeyless: Journey = {
  id: 'first-run-keyless',
  title: 'first run in a fresh project, no API key, keyless model',
  customer:
    'A self-hosting dev in an empty directory with ollama installed and no cloud key, expecting a reply within seconds.',
  badLooksLike:
    'A long silence with no sign of life before the first token; gateway log lines bleeding into the transcript; a banner that does not say which model is answering; raw markdown markers in the reply; no way to tell the run has finished.',
  requires: ['ollama-chat'],
  timeoutMs: 240_000,

  async run(ctx) {
    const pty = ctx.start(['--model', 'ollama:llama3.2', '--simple'], { cols: 100, rows: 40 })

    const bootStarted = Date.now()
    await pty.waitForText('❯', { timeoutMs: 90_000, why: 'the prompt is the first sign of life' })
    const bootMs = Date.now() - bootStarted
    ctx.note(`prompt appeared after ${(bootMs / 1000).toFixed(1)}s`)
    const banner = ctx.frame('banner and first prompt', pty)

    ctx.check(
      'prompt within 30s of launch',
      bootMs < 30_000,
      `took ${(bootMs / 1000).toFixed(1)}s — a first-run wait past ~30s reads as broken`,
    )
    const bannerText = banner.lines.join('\n')
    ctx.check('banner names the model answering', /ollama|llama/i.test(bannerText))
    ctx.check(
      'no gateway log noise in the transcript (BUGS #1)',
      !/\[(loom|boot-trace|session-runner)/.test(bannerText),
    )

    // Mark BEFORE submitting: the CLI echoes the prompt, so anything
    // asserted against the whole screen would match the question itself.
    const beforeAsk = pty.mark()
    await pty.type('Reply with exactly the word pong and nothing else.')
    await pty.key('enter')

    const askedAt = Date.now()
    await pty.waitForText(/pong/i, {
      timeoutMs: 180_000,
      since: beforeAsk,
      why: 'the keyless model must actually answer — not merely have the word echoed back',
    })
    ctx.note(`first answer after ${((Date.now() - askedAt) / 1000).toFixed(1)}s`)
    await pty.waitForQuiet(2_000, 60_000)
    const answered = ctx.frame('the reply', pty)
    const text = answered.lines.join('\n')
    const reply = answered.lines.slice(beforeAsk).join('\n')

    ctx.check('the model actually answered', /pong/i.test(reply), `reply region: ${reply.slice(0, 200)}`)
    ctx.check(
      'the question is echoed so the transcript reads as a conversation',
      text.includes('pong and nothing else'),
    )
    ctx.check(
      'no raw markdown markers survived into the transcript',
      !/\*\*\w/.test(text),
      'the CLI promises rendered markdown, never the markers',
    )
    ctx.check(
      'the prompt came back after the answer',
      answered.lines.some((l) => l.trim().startsWith('❯')),
      'without a returned prompt the customer cannot tell the turn ended',
    )

    await pty.type('/exit')
    await pty.key('enter')
    const exit = await pty.waitExit(20_000)
    ctx.check('clean exit', exit.exitCode === 0, `exit code ${exit.exitCode}`)

    // What did running the agent leave behind IN THE CUSTOMER'S PROJECT?
    // Anything written here lands in their repo and shows up in their
    // `git status` — so it must be both expected and git-ignored.
    const dropped = existsSync(ctx.workdir) ? readdirSync(ctx.workdir) : []
    ctx.note(`left in the project directory: ${JSON.stringify(dropped)}`)
    const localData = join(ctx.workdir, '.ownware')
    if (existsSync(localData)) {
      ctx.note(`.ownware/ contents: ${JSON.stringify(readdirSync(localData))}`)
    }
    // Project-local `.ownware/` is a DELIBERATE design choice (plans and
    // checkpoints are about the repo). So the bar is not "leaves
    // nothing" — it is "leaves nothing git can see", which is what stops
    // `git add -A` committing conversation transcripts (F11).
    const unexpected = dropped.filter((f) => f !== '.ownware')
    ctx.check(
      'a run drops nothing unexpected into the customer\'s project',
      unexpected.length === 0,
      `unexpected entries: ${unexpected.join(', ')}`,
    )
    const ignoreFile = join(localData, '.gitignore')
    ctx.check(
      'anything left in the project is invisible to git',
      !existsSync(localData) ||
        (existsSync(ignoreFile) &&
          readFileSync(ignoreFile, 'utf-8')
            .split('\n')
            .some((l) => l.trim() === '*')),
      '.ownware/ holds conversation transcripts; without a self-ignoring .gitignore, `git add -A` commits them',
    )
  },
}
