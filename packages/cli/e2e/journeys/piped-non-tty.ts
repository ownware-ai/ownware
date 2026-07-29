/**
 * `ownware exec … | cat` and `> file` — the CI/scripting face.
 *
 * The contract (S4): text streams plain deltas, json emits one object,
 * stream-json emits NDJSON 1:1 with the wire. Exit 0 on completion.
 * Piped output must carry no TUI decoration and no colour, because the
 * consumer is a program, not an eye.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Journey } from '../harness/journey.ts'

export const pipedNonTty: Journey = {
  id: 'piped-non-tty',
  title: 'pipes headless exec into another program',
  customer:
    'A developer wiring the agent into a script or CI job, who needs parseable output and a truthful exit code.',
  badLooksLike:
    'Colour codes or spinner frames in piped output; a banner mixed into the data; JSON that does not parse; exit 0 on a failed run; the process hanging because it waited for a terminal that was not there.',
  requires: ['ollama-chat'],
  timeoutMs: 240_000,

  async run(ctx) {
    const pty = ctx.startShell(
      // Globals BEFORE the subcommand — the conventional shape (F5).
      `$OWNWARE --data-dir "$OWNWARE_DATA_DIR" exec -p "Reply with exactly the word pong and nothing else." --model ollama:llama3.2 -o text > out.txt 2> err.txt; echo "EXIT:$?"`,
      { cols: 100, rows: 30 },
    )
    await pty.waitForText(/EXIT:\d+/, { timeoutMs: 200_000, why: 'headless exec must terminate on its own' })
    const shell = ctx.frame('the shell around the pipe', pty)
    const exitLine = shell.lines.join('\n').match(/EXIT:(\d+)/)
    const out = readFileSync(join(ctx.workdir, 'out.txt'), 'utf-8')
    const err = readFileSync(join(ctx.workdir, 'err.txt'), 'utf-8')

    ctx.check(
      'global flags before the subcommand are accepted (F5)',
      !/Unknown option/.test(err),
      'the conventional `--data-dir X exec …` ordering must not be rejected',
    )
    ctx.check('exec exits 0 on a completed run', exitLine?.[1] === '0', `exit code ${exitLine?.[1] ?? 'unknown'}`)

    ctx.note(`stdout bytes: ${out.length}; stderr bytes: ${err.length}`)
    // stderr IS the evidence when exec fails — carry it, do not summarise it.
    if (err.trim() !== '') ctx.note(`stderr said: ${err.trim().slice(0, 500)}`)

    ctx.check('the answer is on stdout', /pong/i.test(out), JSON.stringify(out.slice(0, 200)))
    ctx.check(
      'no escape sequences in piped stdout',
      !/\x1b\[/.test(out),
      'a program reading this output should never have to strip terminal codes',
    )
    ctx.check(
      'no banner or wordmark in piped stdout',
      !/ownware v|▌/.test(out),
      'decoration belongs on a terminal, not in a data stream',
    )
    ctx.check(
      'stderr carries no stack trace',
      !/\n\s+at .+:\d+:\d+/.test(err),
      err.slice(0, 300),
    )

    // The machine-readable lane must actually parse.
    const jsonPty = ctx.startShell(
      `$OWNWARE exec --data-dir "$OWNWARE_DATA_DIR" -p "Reply with exactly the word pong." --model ollama:llama3.2 -o json > json.txt 2>/dev/null; echo "EXIT:$?"`,
      { cols: 100, rows: 30 },
    )
    await jsonPty.waitForText(/EXIT:\d+/, { timeoutMs: 200_000 })
    const raw = readFileSync(join(ctx.workdir, 'json.txt'), 'utf-8').trim()
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      parsed = null
    }
    ctx.check('-o json emits exactly one parseable object', parsed !== null, raw.slice(0, 300))
    if (parsed !== null) {
      ctx.check(
        'the object carries the identifiers a script needs',
        typeof parsed['threadId'] === 'string' && typeof parsed['status'] === 'string',
        `keys: ${Object.keys(parsed).join(', ')}`,
      )
    }
    ctx.frame('json lane', jsonPty)
  },
}
