/**
 * The cheapest first contact there is: someone types `--help` before
 * they trust the thing enough to run it. What they read here decides
 * whether they run it at all.
 */

import type { Journey } from '../harness/journey.ts'

export const helpFirstContact: Journey = {
  id: 'help-first-contact',
  title: 'reads --help before running anything',
  customer:
    'A developer who just installed the CLI and wants to know what it does and what it will touch before it runs.',
  badLooksLike:
    'Options listed with no sense of what to do FIRST; no mention that a gateway gets started or where data goes; internal package names leaking; the keyless path invisible so someone without an API key assumes it will not work.',
  timeoutMs: 30_000,

  async run(ctx) {
    const pty = ctx.start(['--help'], { cols: 100, rows: 40 })
    await pty.waitExit(15_000)
    const screen = ctx.frame('help output', pty)
    const text = screen.lines.join('\n')

    ctx.check('help mentions the brand', /ownware/i.test(text))
    ctx.check(
      'no internal package names leak (guardrail #5)',
      !/\b(loom|cortex)\b/i.test(text),
      'public surfaces are Ownware-only',
    )
    ctx.check(
      'tells the customer how to get started with no API key',
      /ollama|keyless/i.test(text),
      'the keyless path is the whole first-run promise; if help omits it, a keyless user assumes they need to pay first',
    )
    ctx.check(
      'says where data lives',
      /data-dir|\.ownware/.test(text),
      'a self-hoster wants to know what gets written to their machine',
    )
    ctx.note('Judge: read this as someone who has never seen Ownware. Do you know what to type next?')
  },
}
