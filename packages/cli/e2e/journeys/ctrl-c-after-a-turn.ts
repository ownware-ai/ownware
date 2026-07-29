/**
 * Ctrl-C is the instinctive way out of a terminal program, and `--help`
 * advertises it. It must end the session — after a turn, after a
 * cancelled turn, and from a cold prompt alike.
 *
 * A hang here is worse than it sounds: the customer's terminal is stuck
 * on a program that will not die, and their next move is to kill the
 * window.
 */

import type { Journey } from '../harness/journey.ts'

function makeCtrlC(id: string, title: string, mode: 'cold' | 'after-turn' | 'after-cancel'): Journey {
  return {
    id,
    title,
    customer: 'Anyone who finishes with the CLI and reaches for ctrl-c, the way every terminal program has trained them to.',
    badLooksLike:
      'The process ignoring ctrl-c and having to be killed; a non-zero exit code after a perfectly normal session, which any wrapping script reads as failure.',
    requires: ['ollama-chat'],
    timeoutMs: 240_000,

    async run(ctx) {
      const pty = ctx.start(['--model', 'ollama:llama3.2', '--simple'], { cols: 90, rows: 24 })
      await pty.waitForText('❯', { timeoutMs: 90_000 })
      await pty.waitForQuiet(1_000, 20_000)

      if (mode !== 'cold') {
        const cancelling = mode === 'after-cancel'
        await pty.type(cancelling ? 'Write a very long essay about terminals.' : 'Say pong.')
        await pty.key('enter', 120)
        if (cancelling) {
          await pty.key('esc')
          await pty.waitForQuiet(3_000, 60_000)
        } else {
          await pty.waitForQuiet(3_000, 120_000)
        }
      }

      await pty.key('ctrlC')
      const exit = await pty.waitExit(12_000)
      ctx.frame('what ctrl-c left on screen', pty)
      ctx.check(
        'ctrl-c ends the process',
        exit.exitCode !== -1,
        'the CLI had to be killed — a terminal program that ignores ctrl-c is stuck for good',
      )
      ctx.check(
        'ctrl-c exits 0 on a normal session',
        exit.exitCode === 0,
        `exit code ${exit.exitCode}; a wrapping script reads non-zero as failure`,
      )
    },
  }
}

export const ctrlCCold = makeCtrlC('ctrl-c-cold', 'presses ctrl-c at a fresh prompt', 'cold')
export const ctrlCAfterTurn = makeCtrlC('ctrl-c-after-turn', 'presses ctrl-c after a completed answer', 'after-turn')
export const ctrlCAfterCancel = makeCtrlC('ctrl-c-after-cancel', 'presses ctrl-c after cancelling a run', 'after-cancel')
