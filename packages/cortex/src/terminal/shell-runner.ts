/**
 * PtyShellRunner — implements Loom's `ShellRunner` contract against
 * the workspace's shared **agent** PTY (an interactive shell).
 *
 * ## Why this protocol (reliability — read before changing)
 *
 * The shell is interactive (it has a line editor, prompt redraws,
 * bracketed paste). Two failure modes bit us:
 *
 *   1. **Dropped first byte → 120s hang.** The old design wrote the
 *      command and the exit-code printer as TWO separate `write()`
 *      calls. The second arrived while the shell was still redrawing
 *      its prompt after the first, and the editor dropped its first
 *      byte (`printf` → `rintf`, "command not found"). The completion
 *      marker never printed, so the runner waited out the full
 *      timeout. Fix: **one `write()` per command** — a single logical
 *      line to an already-ready prompt. (Command echo always worked;
 *      only the vulnerable *second* write failed.)
 *
 *   2. **Fragile output slicing.** The old parser guessed which line
 *      was the command echo. Fix: per-command **random nonce** + two
 *      printed markers, sliced deterministically.
 *
 * One write, one logical line:
 *
 *     printf '\n%s:S\n' '<nonce>'; <command>; __cx_ec=$?; printf '\n%s:E:%d\n' '<nonce>' "$__cx_ec"\r
 *
 * The matched tokens (`<nonce>:S`, `<nonce>:E:<code>`) are emitted via
 * printf's `%s`/`%d` args, so they appear contiguously ONLY in the
 * printed output, never in the echoed source line — and the random
 * nonce means command output can't forge them.
 *
 * Parse path:
 *   1. Accumulate PTY output until `<nonce>:E:(-?\d+)` appears →
 *      capture `$?`.
 *   2. Strip ANSI CSI/OSC + control-byte noise; normalize newlines.
 *   3. Slice strictly between the `<nonce>:S` line and the
 *      `<nonce>:E:` line — no echo-guessing.
 *
 * Serialization: a single-slot promise chain per runner ensures the
 * PTY isn't mid-command when a second call arrives.
 *
 * Timeout / abort: write Ctrl+C (0x03), then a rescue marker with exit
 * code 124 (timeout) or 130 (aborted). Wait up to `recoveryGraceMs`.
 *
 * KNOWN LIMITATION (tracked for the OSC-633 follow-up): a *multi-line*
 * command still contains embedded newlines in the single write, so its
 * inner lines are read by the editor across prompt redraws and could,
 * in theory, drop a byte. Single-line commands (the overwhelming
 * majority, and every case that hung) are fully robust. The gold-
 * standard fix — invisible OSC-633 markers from shell `preexec`/
 * `precmd` hooks + a clean controlled prompt — is the next pass.
 */

import { randomBytes } from 'node:crypto'
import { oscCommandStart, oscCommandDone } from './shell-integration.js'

/**
 * Minimal surface of the underlying session the runner uses. Matches
 * `PtySession` (from `./pty-session.js`) but typed narrowly so tests
 * can substitute a fake without dragging in node-pty.
 */
export interface PtyLike {
  write(data: string): void
  onData(listener: (data: string) => void): () => void
  readonly exited: { exitCode: number; signal: number | undefined } | null
}

export interface RunInput {
  readonly command: string
  readonly cwd: string
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

export interface RunResult {
  readonly output: string
  readonly exitCode: number | null
  readonly terminated?: 'timeout' | 'aborted' | undefined
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Per-command completion nonce. Random so a command that happens to print
 * something marker-shaped can't false-trigger. Hex only — safe to embed in a
 * RegExp without escaping.
 */
function makeNonce(): string {
  return `cx${randomBytes(8).toString('hex')}`
}

/** The start-of-output marker text printed for `nonce`. */
function startMarker(nonce: string): string {
  return `${nonce}:S`
}

/** Matches the end-of-output marker line, capturing the exit code. */
function endRegex(nonce: string): RegExp {
  return new RegExp(`${nonce}:E:(-?\\d+)`)
}

const CSI_REGEX = /\x1b\[[0-?]*[ -/]*[@-~]/g
const OSC_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// Terminal control bytes that show up in interactive shell echo — zsh
// emits BS (\x08) / BEL (\x07) around highlighted text when syntax
// highlighting or autosuggest is active. These fragment contiguous
// strings and break `indexOf()` searches.
const CONTROL_NOISE_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1A]/g

/** Strip ANSI CSI + OSC sequences AND zero-width control noise. */
export function stripAnsi(s: string): string {
  return s
    .replace(CSI_REGEX, '')
    .replace(OSC_REGEX, '')
    .replace(CONTROL_NOISE_REGEX, '')
}

/** Normalize CRLF → LF for clean text returned to the model. */
function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * Extract the command's output from the raw captured stream.
 *
 * Input is the ANSI-stripped, newline-normalized capture, which contains
 * the echoed command line, the command's stdout/stderr, and our two
 * markers. We slice STRICTLY between the start marker line (`<nonce>:S`)
 * and the end marker line (`<nonce>:E:<code>`) — no echo-guessing. The
 * echoed command line is before the start marker, so it's excluded; the
 * markers never appear in the echo (they're built from printf args).
 */
function extractOutput(stream: string, nonce: string): string {
  const lines = stream.split('\n')
  const start = startMarker(nonce)
  const end = endRegex(nonce)
  let startIdx = -1
  let endIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (startIdx < 0) {
      if (line.includes(start)) startIdx = i
      continue
    }
    if (end.test(line)) {
      endIdx = i
      break
    }
  }
  const from = startIdx >= 0 ? startIdx + 1 : 0
  if (endIdx < 0) {
    // End marker never landed (rescue that didn't print) — best-effort:
    // everything after the start marker (or the whole stream).
    return lines.slice(from).join('\n').trimEnd()
  }
  return lines.slice(from, endIdx).join('\n').trimEnd()
}

/**
 * The SINGLE write for one command — one logical line, one Enter. A start
 * marker, the command, exit-code capture, then the end marker. One `write()`
 * to a ready prompt is the whole point: no vulnerable second write (see the
 * file header for the hang it caused). Trailing whitespace/`;` is stripped so
 * the `;`-chained suffix stays syntactically valid.
 */
function commandWrite(command: string, nonce: string): string {
  const cmd = command.replace(/[\s;]+$/, '')
  return (
    `printf '\\n%s:S\\n' '${nonce}'; ` +
    `${cmd}; __cx_ec=$?; ` +
    `printf '\\n%s:E:%d\\n' '${nonce}' "$__cx_ec"\r`
  )
}

/** Rescue marker after Ctrl+C on timeout/abort — prints the end marker with a
 *  synthetic exit code so the parse path resolves instead of hanging. */
function rescueWrite(nonce: string, code: number): string {
  return `printf '\\n%s:E:%d\\n' '${nonce}' ${code}\r`
}

/**
 * Extract output in OSC-633 mode: slice the RAW stream between the command-start
 * (`C`) and command-done (`D`) markers, THEN strip ANSI. (Must slice before
 * stripping — `stripAnsi` deletes the OSC markers themselves.) The echoed
 * command line precedes `C`, so it's naturally excluded; markers are invisible,
 * so nothing leaks.
 */
function extractOscOutput(raw: string, nonce: string): string {
  const startM = oscCommandStart(nonce).exec(raw)
  const from = startM != null ? startM.index + startM[0].length : 0
  const rest = raw.slice(from)
  const doneM = oscCommandDone(nonce).exec(rest)
  const slice = doneM != null ? rest.slice(0, doneM.index) : rest
  // Drop the line break that follows the (invisible) C marker, plus trailing
  // whitespace. Leading spaces are preserved — only newline noise is trimmed.
  return normalizeLineEndings(stripAnsi(slice)).replace(/^\n+/, '').replace(/\s+$/, '')
}

// ---------------------------------------------------------------------------
// Mutex — one in-flight command per runner.
// ---------------------------------------------------------------------------

class CommandQueue {
  private tail: Promise<void> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail
    let release!: () => void
    this.tail = new Promise<void>((res) => {
      release = res
    })
    return prev.then(fn).finally(release)
  }
}

// ---------------------------------------------------------------------------
// PtyShellRunner
// ---------------------------------------------------------------------------

export interface PtyShellRunnerOptions {
  /** Returns the live PTY for a workspace or null if unavailable. */
  readonly resolveSession: () => PtyLike | null
  /** Timeout grace window (ms) for reading output after Ctrl+C on
   *  timeout/abort. Default: 2000ms. */
  readonly recoveryGraceMs?: number
  /**
   * Returns the OSC-633 integration for the resolved session, or null when the
   * shell isn't integrated (→ Stage-1 marker fallback). The nonce must match the
   * one baked into the shell's integration rc. Resolved per run so a respawned
   * shell (new nonce) is picked up.
   */
  readonly resolveIntegration?: () => { readonly nonce: string } | null
}

export class PtyShellRunner {
  private readonly queue = new CommandQueue()
  private readonly opts: PtyShellRunnerOptions

  constructor(opts: PtyShellRunnerOptions) {
    this.opts = opts
  }

  run(input: RunInput): Promise<RunResult> {
    return this.queue.run(() => this.runImpl(input))
  }

  private async runImpl(input: RunInput): Promise<RunResult> {
    const session = this.opts.resolveSession()
    if (session == null || session.exited != null) {
      return {
        output: '',
        exitCode: null,
        terminated: 'aborted',
      }
    }

    const recoveryGraceMs = this.opts.recoveryGraceMs ?? 2_000

    // OSC-633 mode when the shell is integrated (invisible markers from shell
    // hooks → clean echo, exit code from the `D` marker). Otherwise Stage-1
    // mode (single combined write with printf markers). The `D` / end marker
    // regex is what `onData` waits on; everything else keys off `osc`.
    const integration = this.opts.resolveIntegration?.() ?? null
    const osc = integration != null
    const legacyNonce = makeNonce()

    let captured = ''
    let exitCode: number | null = null
    let terminated: 'timeout' | 'aborted' | undefined

    // Return the exit code once the command's completion marker is present, else
    // null. OSC mode requires the `D` to come AFTER our command's `C` — the
    // shell emits a stray startup `D` (precmd before the first prompt) that must
    // NOT resolve us early. Stage-1 mode just matches the end marker.
    const findExitCode = (): number | null => {
      if (osc) {
        const cM = oscCommandStart(integration.nonce).exec(captured)
        if (cM == null) return null
        const after = captured.slice(cM.index + cM[0].length)
        const dM = oscCommandDone(integration.nonce).exec(after)
        return dM != null ? parseInt(dM[1]!, 10) : null
      }
      const m = endRegex(legacyNonce).exec(captured)
      return m != null ? parseInt(m[1]!, 10) : null
    }

    await new Promise<void>((resolve) => {
      let settled = false
      const unsubscribe = session.onData((data) => {
        captured += data
        if (settled) return
        const code = findExitCode()
        if (code != null) {
          exitCode = code
          settled = true
          cleanup()
          resolve()
        }
      })

      const onTimeout = (): void => {
        if (settled) return
        terminated = 'timeout'
        sendInterruptAndWait(124).then(() => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        })
      }

      const onAbort = (): void => {
        if (settled) return
        terminated = 'aborted'
        sendInterruptAndWait(130).then(() => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        })
      }

      const sendInterruptAndWait = async (rescueCode: number): Promise<void> => {
        // Ctrl+C first. In OSC mode the shell's own `precmd` fires after the
        // interrupt and emits the real `D` marker — no injection needed. In
        // Stage-1 mode we inject our end marker so the prompt is known ready.
        try {
          session.write('\x03')
        } catch {
          return
        }
        if (!osc) {
          try {
            session.write(rescueWrite(legacyNonce, rescueCode))
          } catch {
            return
          }
        }
        // Wait for the done marker, bounded by grace.
        await new Promise<void>((resolveInner) => {
          const start = Date.now()
          const poll = setInterval(() => {
            const code = findExitCode()
            if (code != null) {
              exitCode = code
              clearInterval(poll)
              resolveInner()
              return
            }
            if (Date.now() - start > recoveryGraceMs) {
              clearInterval(poll)
              resolveInner()
            }
          }, 20)
        })
      }

      const timeoutHandle = setTimeout(onTimeout, Math.max(1, input.timeoutMs))
      const abortHandler = (): void => onAbort()
      if (input.signal.aborted) {
        queueMicrotask(abortHandler)
      } else {
        input.signal.addEventListener('abort', abortHandler, { once: true })
      }

      const cleanup = (): void => {
        clearTimeout(timeoutHandle)
        input.signal.removeEventListener('abort', abortHandler)
        unsubscribe()
      }

      // Kick off the command — ONE write either way. OSC mode writes just the
      // command (markers come from the shell's hooks, so the echo stays clean);
      // Stage-1 mode writes the command + printf markers on one logical line.
      // One write to a ready prompt; never a second into a redrawing one.
      try {
        session.write(osc ? `${input.command}\r` : commandWrite(input.command, legacyNonce))
      } catch (err) {
        settled = true
        captured += `\n[Error writing to terminal: ${err instanceof Error ? err.message : String(err)}]`
        cleanup()
        resolve()
      }
    })

    // OSC mode slices the RAW stream between the C/D markers (stripAnsi would
    // delete them), then strips. Stage-1 mode strips first, then slices on the
    // plain-text markers.
    const body = osc
      ? extractOscOutput(captured, integration.nonce)
      : extractOutput(normalizeLineEndings(stripAnsi(captured)), legacyNonce)

    const result: RunResult = terminated === undefined
      ? { output: body, exitCode }
      : { output: body, exitCode, terminated }
    return result
  }
}
