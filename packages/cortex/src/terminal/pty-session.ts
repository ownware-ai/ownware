/**
 * PtySession — wraps a single `node-pty` instance for one workspace.
 *
 * Public surface intentionally narrow: spawn (in the constructor),
 * write bytes, resize, kill, observe output/exit. Listeners register
 * via `onData` / `onExit` and receive an idempotent unsubscribe.
 *
 * Scrollback is an in-memory ring buffer, capped at whichever of
 * {bytes, lines} fills first. New subscribers get the whole buffer as
 * one catch-up string. No persistence — scrollback survives renderer
 * reloads (PTY lives in the gateway process) but NOT a gateway
 * restart. Persistence is T08.
 *
 * This file knows nothing about HTTP/SSE. Handlers wire this up.
 */

import { spawn as spawnPty, type IPty } from 'node-pty'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Cold-start PTY width. The xterm panel calls `resize()` with the
// actual viewport size as soon as it connects, so this value only
// governs the brief window between spawn and first resize. 80 is the
// conventional default and is wide enough for the simple shell-runner
// protocol (`<cmd>\r` + sentinel printf) not to soft-wrap at the
// kernel PTY driver.
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const DEFAULT_SCROLLBACK_BYTES = 1024 * 1024 // 1 MiB
const DEFAULT_SCROLLBACK_LINES = 10_000

// Per-line cap on what we hand back to the agent. Long lines (think
// minified bundle output, base64 blobs, or a rogue `cat` of a binary)
// can otherwise blow the context budget on a single line. Truncated
// lines get a suffix marker so the agent knows bytes were dropped.
const MAX_LINE_CHARS_FOR_READ = 2000

export interface PtySessionOptions {
  /** Workspace path — used as `cwd` for the shell. */
  readonly cwd: string
  /** Shell executable. Defaults to `$SHELL` then `/bin/bash`. */
  readonly shell?: string
  /** Shell args. Default: `['-l']` (login shell). */
  readonly args?: readonly string[]
  readonly cols?: number
  readonly rows?: number
  /** Extra env vars merged on top of the process env. `TERM` is
   *  always `xterm-256color` unless overridden. */
  readonly env?: Record<string, string>
  /** Overrides for testing — default reads `process.env`. */
  readonly processEnv?: NodeJS.ProcessEnv
  /** Ring buffer byte cap. Default 1 MiB. */
  readonly scrollbackBytes?: number
  /** Ring buffer line cap. Default 10,000. */
  readonly scrollbackLines?: number
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PtyExit {
  readonly exitCode: number
  readonly signal: number | undefined
}

/**
 * Lifecycle state visible to the HTTP layer and UI clients.
 *
 *   running → the process is live, PID is valid, writes succeed.
 *   killing → we called `kill()` but the OS hasn't reaped the
 *             process yet (the `onExit` callback hasn't fired). The
 *             client renders a pulsing indicator; writes are no-ops.
 *   exited  → the process terminated on its own (or after `kill()`
 *             if `kill()` was NOT called — i.e. natural exit).
 *   killed  → the process terminated AFTER `kill()` was called.
 *             Distinguishes user-triggered termination from a program
 *             exiting naturally.
 *
 * The underlying `onExit` listeners fire for both `exited` and
 * `killed` — the difference is whether `kill()` was called first.
 */
export type PtyStatus = 'running' | 'killing' | 'exited' | 'killed'

export type DataListener = (data: string) => void
export type ExitListener = (info: PtyExit) => void
export type Unsubscribe = () => void

/**
 * Paginated read parameters. Line numbers and offsets are 0-based
 * from the agent's perspective; the `lineNumber` in each returned
 * `ReadLine` is 1-based (cat -n convention) and refers to the
 * original buffer position, which is preserved even when `pattern`
 * filters rows out.
 */
export interface ReadLinesOptions {
  readonly offset?: number
  readonly limit?: number
  /** If set, only lines matching the regex are returned, AND
   *  pagination applies to the MATCHES, not the raw buffer. */
  readonly pattern?: RegExp
}

export interface ReadLine {
  /** 1-based line number in the original buffer. */
  readonly lineNumber: number
  readonly text: string
  /** True when the original line was > MAX_LINE_CHARS_FOR_READ and
   *  was truncated for this response. */
  readonly truncated?: boolean
}

export interface ReadLinesResult {
  readonly lines: readonly ReadLine[]
  /** Total lines in the buffer (or total matches, when `pattern` set). */
  readonly totalLines: number
  readonly offset: number
  readonly hasMore: boolean
  /** Set when a pattern was applied; null otherwise. */
  readonly filter: {
    readonly pattern: string
    readonly ignoreCase: boolean
    readonly matchCount: number
  } | null
}

// ---------------------------------------------------------------------------
// PtySession
// ---------------------------------------------------------------------------

export class PtySession {
  private readonly pty: IPty
  private readonly dataListeners = new Set<DataListener>()
  private readonly exitListeners = new Set<ExitListener>()
  private readonly scrollbackChunks: string[] = []
  private scrollbackByteCount = 0
  private scrollbackLineCount = 0
  private readonly maxBytes: number
  private readonly maxLines: number
  private disposed = false
  private _exit: PtyExit | null = null
  private _status: PtyStatus = 'running'

  constructor(options: PtySessionOptions) {
    const processEnv = options.processEnv ?? process.env
    const shell =
      options.shell ??
      processEnv['SHELL'] ??
      '/bin/bash'
    const args = options.args ?? ['-l']
    const cols = options.cols ?? DEFAULT_COLS
    const rows = options.rows ?? DEFAULT_ROWS
    const env: Record<string, string> = {
      // Start with the parent env, coerced to the string-only shape
      // node-pty requires.
      ...Object.fromEntries(
        Object.entries(processEnv).filter(
          (kv): kv is [string, string] => typeof kv[1] === 'string',
        ),
      ),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...(options.env ?? {}),
    }

    this.maxBytes = options.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES
    this.maxLines = options.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES

    this.pty = spawnPty(shell, [...args], {
      name: 'xterm-256color',
      cwd: options.cwd,
      cols,
      rows,
      env,
    })

    this.pty.onData((data) => {
      this.appendScrollback(data)
      for (const listener of this.dataListeners) {
        try {
          listener(data)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[terminal] data listener threw:', err)
        }
      }
    })

    this.pty.onExit(({ exitCode, signal }) => {
      this._exit = { exitCode, signal: signal ?? undefined }
      // If kill() flipped us to `killing`, the child's terminationis
      // user-triggered → `killed`. Otherwise it exited on its own →
      // `exited`. The client renders these differently (gray vs red
      // state, with exitCode surfaced for both).
      this._status = this._status === 'killing' ? 'killed' : 'exited'
      for (const listener of this.exitListeners) {
        try {
          listener(this._exit)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[terminal] exit listener threw:', err)
        }
      }
    })
  }

  // ── Public API ─────────────────────────────────────────────────────

  get pid(): number {
    return this.pty.pid
  }

  get exited(): PtyExit | null {
    return this._exit
  }

  /** Lifecycle state. See `PtyStatus` for semantics of each value. */
  get status(): PtyStatus {
    return this._status
  }

  write(data: string): void {
    if (this.disposed || this._exit != null) return
    this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || this._exit != null) return
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    if (cols <= 0 || rows <= 0) return
    this.pty.resize(Math.floor(cols), Math.floor(rows))
  }

  kill(signal?: string): void {
    if (this.disposed) return
    this.disposed = true
    // Only transition to `killing` when the process is still alive.
    // If it already exited, the status is already `exited` — leave
    // it alone; a `kill()` after natural exit is a no-op cleanup
    // from the registry side and should NOT relabel the session.
    if (this._status === 'running') {
      this._status = 'killing'
    }
    try {
      this.pty.kill(signal)
    } catch {
      // Already exited — ignore.
    }
  }

  onData(listener: DataListener): Unsubscribe {
    this.dataListeners.add(listener)
    let gone = false
    return () => {
      if (gone) return
      gone = true
      this.dataListeners.delete(listener)
    }
  }

  onExit(listener: ExitListener): Unsubscribe {
    this.exitListeners.add(listener)
    let gone = false
    return () => {
      if (gone) return
      gone = true
      this.exitListeners.delete(listener)
    }
  }

  /** Concatenate the ring buffer into one string. */
  scrollback(): string {
    if (this.scrollbackChunks.length === 0) return ''
    return this.scrollbackChunks.join('')
  }

  /**
   * Paginated, optionally filtered line read. Agent-facing counterpart
   * to `scrollback()`. The ring buffer stays byte-based for O(1)
   * append; lines are computed on demand by joining + splitting. The
   * 1 MiB scrollback cap keeps that work in the low-ms range.
   *
   * Semantics:
   *   - When `pattern` is omitted, `offset/limit` paginate the raw
   *     buffer lines and `totalLines = buffer.length`.
   *   - When `pattern` is set, `offset/limit` paginate the MATCHES
   *     (not the raw buffer) and `totalLines = matches.length`. Each
   *     returned line still carries its original 1-based line number.
   *
   * Long lines are clipped at `MAX_LINE_CHARS_FOR_READ` and flagged
   * `truncated: true` so a runaway binary dump can't blow the agent's
   * context budget on one line.
   */
  readLines(opts: ReadLinesOptions = {}): ReadLinesResult {
    return computeReadLines(this.splitBufferLines(), opts)
  }

  // ── Internals ──────────────────────────────────────────────────────

  /**
   * Split the ring buffer into logical lines (no trailing empty entry
   * when the buffer ends without a newline). Computed on demand — see
   * `readLines` for why.
   *
   * PTY output uses `\r\n` line endings (the kernel ptty driver
   * translates a program's `\n` into `\r\n` on write), so we split on
   * `\n` and then strip the trailing `\r` per line. Stripping once at
   * the end is `O(N)` in lines; splitting via a regex would also be
   * `O(N)` but harder to read.
   */
  private splitBufferLines(): string[] {
    if (this.scrollbackChunks.length === 0) return []
    const joined = this.scrollbackChunks.join('')
    if (joined.length === 0) return []
    const lines = joined.split('\n')
    // Drop the empty trailing entry when the buffer doesn't end with
    // a newline, so a 1-line file and the same file without a final
    // newline read identically.
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop()
    }
    // Normalize `\r\n` terminators: after splitting on `\n`, each line
    // may still carry a trailing `\r`. Strip it.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (line.length > 0 && line.charCodeAt(line.length - 1) === 13 /* \r */) {
        lines[i] = line.slice(0, -1)
      }
    }
    return lines
  }

  private appendScrollback(chunk: string): void {
    if (chunk.length === 0) return
    const byteLength = Buffer.byteLength(chunk, 'utf8')
    const lineCount = countNewlines(chunk)

    this.scrollbackChunks.push(chunk)
    this.scrollbackByteCount += byteLength
    this.scrollbackLineCount += lineCount

    while (
      (this.scrollbackByteCount > this.maxBytes ||
        this.scrollbackLineCount > this.maxLines) &&
      this.scrollbackChunks.length > 1
    ) {
      const head = this.scrollbackChunks.shift()!
      this.scrollbackByteCount -= Buffer.byteLength(head, 'utf8')
      this.scrollbackLineCount -= countNewlines(head)
    }

    // Edge case: a single chunk already exceeds the cap. Trim its
    // head in-place to stay under the byte budget while keeping one
    // chunk in the buffer (so the ring is never empty when there's
    // live data to show).
    if (
      this.scrollbackByteCount > this.maxBytes &&
      this.scrollbackChunks.length === 1
    ) {
      const only = this.scrollbackChunks[0]!
      const overflow = Buffer.byteLength(only, 'utf8') - this.maxBytes
      // Rough trim — for UTF-8 this may slice a multi-byte code point.
      // Acceptable for a scrollback buffer where the head is always
      // about to scroll off anyway.
      const trimmed = only.slice(overflow)
      this.scrollbackChunks[0] = trimmed
      this.scrollbackByteCount = Buffer.byteLength(trimmed, 'utf8')
      this.scrollbackLineCount = countNewlines(trimmed)
    }
  }
}

function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10 /* \n */) n++
  }
  return n
}

function clipLine(lineNumber: number, text: string): ReadLine {
  if (text.length <= MAX_LINE_CHARS_FOR_READ) {
    return { lineNumber, text }
  }
  const dropped = text.length - MAX_LINE_CHARS_FOR_READ
  return {
    lineNumber,
    text: `${text.slice(0, MAX_LINE_CHARS_FOR_READ)}… (+${dropped} more chars)`,
    truncated: true,
  }
}

/**
 * Pure pagination/filtering helper shared by `PtySession.readLines`
 * and tests that exercise the truncation / filter semantics without
 * needing a live PTY (macOS canonical-mode input caps at 1024 bytes
 * per line, which makes it impossible to round-trip a 2000+ char line
 * through a real PTY just to exercise the clip path).
 *
 * Exported ONLY for tests — production code paths should call
 * `PtySession.readLines` which provides the scrollback input.
 */
export function computeReadLines(
  lines: readonly string[],
  opts: ReadLinesOptions = {},
): ReadLinesResult {
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const rawLimit = opts.limit
  const limit =
    rawLimit === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(rawLimit))

  if (opts.pattern === undefined) {
    const bufferLineCount = lines.length
    const sliced = lines.slice(offset, offset + limit)
    const out: ReadLine[] = sliced.map((text, idx) =>
      clipLine(offset + idx + 1, text),
    )
    return {
      lines: out,
      totalLines: bufferLineCount,
      offset,
      hasMore: offset + out.length < bufferLineCount,
      filter: null,
    }
  }

  const pattern = opts.pattern
  const matches: ReadLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!
    if (pattern.test(text)) {
      matches.push(clipLine(i + 1, text))
    }
    // Reset lastIndex for global regexes (defensive — callers should
    // pass non-global patterns).
    pattern.lastIndex = 0
  }
  const paginated = matches.slice(offset, offset + limit)
  return {
    lines: paginated,
    totalLines: matches.length,
    offset,
    hasMore: offset + paginated.length < matches.length,
    filter: {
      pattern: pattern.source,
      ignoreCase: pattern.flags.includes('i'),
      matchCount: matches.length,
    },
  }
}
