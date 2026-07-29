/**
 * The thing the product is actually for: the agent works on their repo
 * and they watch it happen.
 *
 * Everything the render spec is about — the live group, the gerund with
 * the real path, the settle line, result previews — only exists once a
 * model calls tools. llama3.2 does not, which is why this journey needs
 * a tool-capable local model and why the visuals went so long unobserved.
 *
 * The judge brief here is the heart of the whole exercise: can a
 * developer follow WHAT the agent did to their code, from the transcript
 * alone?
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Journey } from '../harness/journey.ts'

/**
 * The same journey, run against two very different models on purpose.
 *
 * A keyless local model is what most first-run customers have; a strong
 * cloud model is the truth run. Running ONE journey against both is what
 * separates "Ownware renders tool activity badly" from "this model does
 * not really call tools" — a distinction no single run can make.
 */
function makeToolStory(
  id: string,
  model: string,
  requires: Journey['requires'],
  title: string,
): Journey {
  return {
  id,
  title,
  customer:
    'A developer who asked the agent to do real work and needs to follow what it touched, without trusting it blindly.',
  badLooksLike:
    'Tool rows that say only a tool name with no file or command; a spinner that never resolves into what happened; the file it edited never named; a settle summary that hides a failure; arguments shown that should have been withheld; no way to expand and see more.',
  requires,
  timeoutMs: 420_000,

  async run(ctx) {
    // A tiny real project, so the agent has something true to look at.
    writeFileSync(
      join(ctx.workdir, 'greeting.txt'),
      'hello from the ownware journey harness\nline two\nline three\n',
    )
    writeFileSync(join(ctx.workdir, 'README.md'), '# Journey fixture\n\nA scratch project.\n')

    const pty = ctx.start(['--model', model, '--simple'], { cols: 100, rows: 40 })
    await pty.waitForText('❯', { timeoutMs: 90_000 })
    await pty.waitForQuiet(1_000, 20_000)

    // Everything below is judged on the region AFTER the echoed prompt.
    // The prompt itself contains "greeting.txt" and the word "read", so
    // whole-screen assertions would pass on a screen where the agent
    // never did anything at all.
    const beforeAsk = pty.mark()
    await pty.type('Read the file greeting.txt in this directory and tell me its first line.')
    await pty.key('enter')

    // A tool-using turn is slow. Wait for the agent to actually produce
    // something, then for it to settle — a turn that produces NOTHING is
    // the finding, so the wait must be able to fail.
    let produced = true
    try {
      await pty.waitForText(/\S/, {
        timeoutMs: 300_000,
        since: beforeAsk,
        why: 'the agent must produce something after the prompt is echoed',
      })
    } catch {
      produced = false
    }
    await pty.waitForQuiet(8_000, 360_000)
    const worked = ctx.frame('the agent working on the repo', pty)
    const story = worked.lines.slice(beforeAsk).join('\n')

    ctx.check(
      'the agent answered at all',
      produced && story.trim() !== '',
      'the turn produced no output whatsoever — everything below is unjudgeable',
    )
    // The TOOL ROW must name the target — not merely the reply prose.
    // Checking the whole region passes on `● readFile` + a sentence that
    // happens to mention the file, which is exactly the experience this
    // journey exists to catch.
    const toolRows = worked.lines.slice(beforeAsk).filter((l) => /^\s*[●◐✓✗]/.test(l))
    ctx.note(`tool rows: ${JSON.stringify(toolRows.map((r) => r.trim()))}`)
    ctx.check(
      'the tool row itself names the file the agent touched',
      toolRows.some((row) => /greeting\.txt/.test(row)),
      `a tool row that names no target tells the customer nothing about what happened to their code — rows were: ${toolRows.map((r) => r.trim()).join(' | ')}`,
    )
    ctx.check(
      'there is a visible sign a tool ran',
      /[●◐✓⎿]/.test(story),
      'if tool activity is invisible the customer cannot audit the agent',
    )
    ctx.check(
      'the agent reported the real content of the file',
      /hello from the ownware journey harness/i.test(story),
      'naming the file proves nothing if it never read it',
    )
    ctx.check(
      'no unsanitized argument dump',
      !/"file_path"\s*:/.test(story) && !/"command"\s*:/.test(story),
      'the CLI renders sanitized wire truth — raw JSON args on screen would be a leak',
    )
    ctx.check(
      'nothing is still shown as in-progress after the turn settled',
      !/◐/.test(worked.lines.slice(-4).join('\n')),
      'a spinner glyph left on the last lines means the UI never resolved the action',
    )
    ctx.note(
      'Judge: from this transcript alone, could you say exactly which files were read, what was changed, and whether it succeeded?',
    )

    await pty.type('/exit')
    await pty.key('enter')
    const exit = await pty.waitExit(30_000)
    ctx.check('clean exit', exit.exitCode === 0, `exit code ${exit.exitCode}`)

    // A TOOL-USING run is where the engine writes checkpoints. Whatever
    // it leaves lands in the customer's repo and their `git status`.
    const dropped = readdirSync(ctx.workdir).filter((f) => f !== 'greeting.txt' && f !== 'README.md')
    ctx.note(`left in the project directory: ${JSON.stringify(dropped)}`)
    const localData = join(ctx.workdir, '.ownware')
    if (existsSync(localData)) {
      ctx.note(`.ownware/ contains: ${JSON.stringify(readdirSync(localData))}`)
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
}

export const toolStory = makeToolStory(
  'tool-story',
  'ollama:qwen2.5-coder:7b',
  ['ollama-tools'],
  'watches the agent read and change files in their repo (keyless)',
)

/** The truth run: a model whose tool-calling is not in question. */
export const toolStoryTruth = makeToolStory(
  'tool-story-truth',
  'openrouter:anthropic/claude-haiku-4.5',
  ['openrouter'],
  'watches the agent work, driven by a strong cloud model',
)
