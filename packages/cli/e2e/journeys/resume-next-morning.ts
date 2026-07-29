/**
 * They close the laptop and come back tomorrow: `ownware -c`.
 *
 * Resume is the feature that makes the CLI feel like a place rather than
 * a command. The failure that matters is not "it errored" — it is "it
 * silently started a NEW thread", because the customer only finds out
 * when the agent has forgotten everything.
 */

import type { Journey } from '../harness/journey.ts'

/**
 * Parameterised by model for the same reason the tool journey is: a
 * resumed agent that fails to recall could be a hydration bug OR a weak
 * model, and one run can never tell those apart.
 */
function makeResume(id: string, model: string, requires: Journey['requires'], title: string): Journey {
  return {
  id,
  title,
  customer:
    'A dev returning to the same project directory expecting the agent to remember yesterday.',
  badLooksLike:
    'A silent new thread with no history; the replay dumping raw event JSON instead of a readable transcript; no visible marker of where yesterday ended and today begins; the agent contradicting what it said before because it never saw it.',
  requires,
  timeoutMs: 300_000,

  async run(ctx) {
    const first = ctx.start(['--model', model, '--simple'], { cols: 100, rows: 30 })
    await first.waitForText('❯', { timeoutMs: 90_000 })
    await first.type('Remember this word: albatross. Reply with just: noted.')
    await first.key('enter')
    await first.waitForQuiet(4_000, 180_000)
    ctx.frame('yesterday: the thing to remember', first)
    await first.type('/exit')
    await first.key('enter')
    const firstExit = await first.waitExit(20_000)
    ctx.check('the first session closed cleanly', firstExit.exitCode === 0)

    // Same directory, next morning.
    const second = ctx.start(['--model', model, '--simple', '--resume'], {
      cols: 100,
      rows: 30,
    })
    await second.waitForText('❯', { timeoutMs: 90_000, why: 'resume must still reach a prompt' })
    await second.waitForQuiet(2_000, 30_000)
    const resumed = ctx.frame('this morning: what resume shows', second)
    const text = resumed.lines.join('\n')

    ctx.check(
      'resume says it resumed, and which thread',
      /resumed|↺/i.test(text),
      'without a marker the customer cannot tell resume from a fresh start',
    )
    ctx.check(
      'yesterday is visible in the replay',
      /albatross/i.test(text),
      'a resume that shows no history is indistinguishable from a new thread',
    )
    ctx.check(
      'the replay is a transcript, not raw events',
      !/"type"\s*:\s*"/.test(text),
      'hydrating by dumping event JSON is a leak of the wire into the customer face',
    )
    ctx.note('Judge: is it obvious where yesterday ends and today begins?')

    await second.type('What word did I ask you to remember?')
    await second.key('enter')
    await second.waitForQuiet(4_000, 180_000)
    const recalled = ctx.frame('does the agent actually have the context', second)
    ctx.check(
      'the resumed thread carries real context to the model',
      /albatross/i.test(recalled.lines.slice(Math.max(0, resumed.lines.length - 1)).join('\n')),
      'replaying history on screen but not sending it to the model would be a convincing fake',
    )

    await second.type('/exit')
    await second.key('enter')
    const exit = await second.waitExit(20_000)
    ctx.check('clean exit', exit.exitCode === 0, `exit code ${exit.exitCode}`)
  },
  }
}

export const resumeNextMorning = makeResume(
  'resume-next-morning',
  'ollama:llama3.2',
  ['ollama-chat'],
  'comes back the next day and resumes the session (keyless)',
)

/** The truth run: if THIS forgets, hydration is genuinely broken. */
export const resumeNextMorningTruth = makeResume(
  'resume-next-morning-truth',
  'openrouter:anthropic/claude-haiku-4.5',
  ['openrouter'],
  'comes back the next day, driven by a strong cloud model',
)
