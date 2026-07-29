/**
 * Where does a secret END UP?
 *
 * Guardrail #2 says no secret is ever logged, leaked or stored in
 * plaintext — "not in events, logs, tool results, or the DB". Checkpoints
 * are a store too: a tool-using run writes `.ownware/checkpoints/*.json`
 * containing the full conversation (FINDINGS F11). Whether that store
 * sits behind the same redaction choke points was unverified, and a
 * sample of real checkpoints could not settle it — they contained no
 * secret-shaped values, so their lack of redaction markers proved
 * nothing either way.
 *
 * So we plant one. A CONTROLLED, FAKE canary (never a real credential)
 * goes into a file, the agent is asked to read it, and we then look for
 * that exact string in every place it could have come to rest: the
 * terminal the customer sees, and every checkpoint on disk.
 *
 * This is the difference between "the code has a sanitizer" and "the
 * secret did not survive": the claim is checked at the resting place,
 * not at the mechanism that is supposed to prevent it.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Journey } from '../harness/journey.ts'

/** Shaped like a real key so sanitizers can recognise it; entirely fake. */
const CANARY = 'sk-ownwarecanary00T3STonly0123456789abcdefXYZ'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

export const checkpointSecretCanary: Journey = {
  id: 'checkpoint-secret-canary',
  title: 'a secret passes through a tool result — where does it come to rest?',
  customer:
    'A self-hoster whose repo contains real credentials in config files, who was promised the engine never stores a secret in plaintext.',
  badLooksLike:
    'The secret echoed into the terminal; the secret written verbatim into a checkpoint, a log, or any file on disk; the run appearing to succeed while quietly persisting the credential where `git add -A` would pick it up.',
  requires: ['openrouter'],
  timeoutMs: 420_000,

  async run(ctx) {
    // Deliberately NOT a `.env`/secret-shaped filename. The credential
    // vault's zone correctly DENIES reading those (verified — the first
    // attempt at this journey used `config.env` and was blocked), but a
    // denied read means no secret ever entered a tool result, which
    // would make every check below vacuous. A secret pasted into an
    // ordinary notes file is both realistic and the only way to test
    // the REDACTION path rather than the ACCESS-CONTROL path.
    writeFileSync(
      join(ctx.workdir, 'notes.txt'),
      `deploy notes\nline two\nthe staging key is ${CANARY} — rotate it after launch\nline four\n`,
    )

    const pty = ctx.start(['--model', 'openrouter:anthropic/claude-haiku-4.5', '--simple'], {
      cols: 100,
      rows: 40,
    })
    await pty.waitForText('❯', { timeoutMs: 90_000 })
    await pty.waitForQuiet(1_000, 20_000)

    const beforeAsk = pty.mark()
    await pty.type('Read the file notes.txt in this directory and tell me how many lines it has.')
    await pty.key('enter')
    await pty.waitForQuiet(8_000, 300_000)

    const screen = ctx.frame('after a tool result carrying a secret', pty)
    const transcript = screen.lines.slice(beforeAsk).join('\n')

    // Did the tool actually run? Without that, everything below is
    // vacuous — a secret cannot leak from a tool result that never was.
    // A DENIED or failed read means no secret ever entered a tool
    // result, and every check below would pass for the wrong reason.
    const toolRan = /[●◐✓]/.test(transcript)
    const toolFailed = /✗|Access denied/.test(transcript)
    ctx.check(
      'the tool actually SUCCEEDED, so a secret really passed through a result',
      toolRan && !toolFailed,
      `without a successful read this journey proves nothing about redaction — transcript: ${transcript.slice(0, 240)}`,
    )

    ctx.check(
      'the secret never reaches the terminal',
      !transcript.includes(CANARY),
      'the customer must never see a credential echoed into their scrollback',
    )

    await pty.type('/exit')
    await pty.key('enter')
    await pty.waitExit(30_000)

    // Now the resting places. Everything the run wrote, anywhere.
    const projectFiles = walk(ctx.workdir).filter((f) => !f.endsWith('notes.txt'))
    const dataFiles = existsSync(ctx.dataDir) ? walk(ctx.dataDir) : []
    const checkpoints = [...projectFiles, ...dataFiles].filter((f) => f.includes('checkpoint'))
    ctx.note(`checkpoint files written: ${checkpoints.length}`)
    ctx.note(`other files in the project: ${JSON.stringify(projectFiles.map((f) => f.replace(ctx.workdir, '.')))}`)

    ctx.check(
      'a checkpoint was actually written (else the checkpoint checks are vacuous)',
      checkpoints.length > 0,
      'no checkpoint file was produced, so this run cannot say whether checkpoints redact',
    )

    const leaking: string[] = []
    for (const file of [...projectFiles, ...dataFiles]) {
      let body: string
      try {
        body = readFileSync(file, 'utf-8')
      } catch {
        continue
      }
      if (body.includes(CANARY)) leaking.push(file.replace(ctx.workdir, '.').replace(ctx.dataDir, '<dataDir>'))
    }
    ctx.note(`files containing the canary: ${JSON.stringify(leaking)}`)

    // "Absent" has TWO explanations: redaction removed it, or the tool
    // result was never stored at all. Only the first is a working
    // guardrail. Distinguish them by looking for the harmless text that
    // sat right beside the secret in the same file.
    const NEIGHBOUR = 'rotate it after launch'
    const storedResults = checkpoints.filter((f) => {
      try {
        return readFileSync(f, 'utf-8').includes(NEIGHBOUR)
      } catch {
        return false
      }
    })
    const redactionMarked = checkpoints.filter((f) => {
      try {
        return /REDACTED|redacted|withheld/.test(readFileSync(f, 'utf-8'))
      } catch {
        return false
      }
    })
    ctx.note(
      `checkpoints containing the neighbouring text: ${storedResults.length}/${checkpoints.length}; ` +
        `checkpoints showing a redaction marker: ${redactionMarked.length}`,
    )
    ctx.check(
      'the tool result IS stored — so the missing secret was removed, not merely never written',
      storedResults.length > 0,
      'no checkpoint contains the file content at all, so this run cannot claim redaction works — only that nothing was stored',
    )

    ctx.check(
      'no checkpoint stores the secret in plaintext (guardrail #2)',
      !leaking.some((f) => f.includes('checkpoint')),
      `the credential was written verbatim into: ${leaking.filter((f) => f.includes('checkpoint')).join(', ')}`,
    )
    ctx.check(
      'no file written by the run stores the secret in plaintext',
      leaking.length === 0,
      `the credential came to rest in: ${leaking.join(', ')}`,
    )
  },
}
