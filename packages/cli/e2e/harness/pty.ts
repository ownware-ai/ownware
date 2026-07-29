/**
 * Drive the REAL `ownware-cli` binary in a real pseudo-terminal.
 *
 * Everything the CLI does that matters to a customer is gated on
 * `process.stdout.isTTY` — the OpenTUI shell, raw-mode keys, colour,
 * the wordmark. Piping stdio (what a normal child_process test does)
 * silently takes a DIFFERENT code path, so it can never prove the thing
 * the customer sees. A pty is the only honest driver.
 *
 * Keys go in as the exact bytes a keyboard sends. Output goes through
 * `Screen`, so `waitForText` waits on the PAINTED grid, not the byte
 * stream — the same thing a human waits for.
 */

import { spawn, type IPty } from 'node-pty'
import { Screen, type ScreenSnapshot } from './screen.ts'

export const KEYS = {
  enter: '\r',
  esc: '\x1b',
  ctrlC: '\x03',
  ctrlD: '\x04',
  ctrlO: '\x0f',
  tab: '\t',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
} as const

export interface PtyOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly cols?: number
  readonly rows?: number
}

export interface ExitResult {
  readonly exitCode: number
  readonly signal: number | undefined
}

export class PtyRun {
  private readonly pty: IPty
  private readonly screen: Screen
  private readonly pending: Array<() => void> = []
  private exit: ExitResult | undefined
  private lastOutputAt = Date.now()
  private readonly exited: Promise<ExitResult>

  private constructor(opts: PtyOptions) {
    const cols = opts.cols ?? 100
    const rows = opts.rows ?? 30
    this.screen = new Screen(cols, rows)
    this.pty = spawn(opts.command, [...opts.args], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env: { ...opts.env },
    })
    this.pty.onData((data) => {
      this.lastOutputAt = Date.now()
      void this.screen.write(data).then(() => {
        for (const wake of this.pending.splice(0)) wake()
      })
    })
    this.exited = new Promise<ExitResult>((resolve) => {
      this.pty.onExit(({ exitCode, signal }) => {
        this.exit = { exitCode, signal }
        resolve(this.exit)
        for (const wake of this.pending.splice(0)) wake()
      })
    })
  }

  static start(opts: PtyOptions): PtyRun {
    return new PtyRun(opts)
  }

  get cols(): number {
    return this.screen.cols
  }

  /** Wait until the emulator has parsed something new (or the process ends). */
  private nextTick(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      this.pending.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /**
   * The current bottom of the transcript.
   *
   * Everything a journey asserts about a REPLY must be measured from a
   * mark taken before submitting, because the CLI echoes the prompt: a
   * naive `waitForText('pong')` matches the customer's own question
   * ("reply with the word pong") and passes instantly against a screen
   * where the agent never answered at all.
   */
  mark(): number {
    return this.screen.snapshot('mark').lines.length
  }

  /** Only what appeared after `mark` — the agent's side of the exchange. */
  textSince(mark: number): string {
    return this.screen.snapshot('probe').lines.slice(mark).join('\n')
  }

  /**
   * Wait for text to appear ON SCREEN. Throws with the current screen
   * attached — a timeout here is itself a finding ("the customer waited
   * N seconds and this is all they saw"), so the screen must be in the
   * error.
   *
   * Pass `since` (from `mark()`) to ignore everything already on screen.
   */
  async waitForText(
    needle: string | RegExp,
    opts: { readonly timeoutMs?: number; readonly why?: string; readonly since?: number } = {},
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 30_000
    const deadline = Date.now() + timeoutMs
    const from = opts.since ?? 0
    const matches = (text: string): boolean =>
      typeof needle === 'string' ? text.includes(needle) : needle.test(text)
    const region = (snap: ScreenSnapshot): string => snap.lines.slice(from).join('\n')

    for (;;) {
      const snap = this.screen.snapshot('probe')
      if (matches(region(snap))) return
      if (this.exit !== undefined) {
        // The process is gone. Let the emulator finish parsing whatever
        // arrived with the last breath before deciding it never came.
        await this.screen.drain()
        if (matches(region(this.screen.snapshot('probe')))) return
        throw new PtyTimeout(
          `process exited (code ${this.exit.exitCode}) before ${describe(needle)} appeared` +
            (opts.why === undefined ? '' : ` — ${opts.why}`),
          snap,
        )
      }
      if (Date.now() >= deadline) {
        throw new PtyTimeout(
          `waited ${timeoutMs}ms for ${describe(needle)}` + (opts.why === undefined ? '' : ` — ${opts.why}`),
          snap,
        )
      }
      await this.nextTick(Math.min(250, Math.max(0, deadline - Date.now())))
    }
  }

  /** Wait for the UI to stop changing — "it settled". */
  async waitForQuiet(quietMs = 800, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const idle = Date.now() - this.lastOutputAt
      if (idle >= quietMs) return
      if (this.exit !== undefined) return
      if (Date.now() >= deadline) return
      await this.nextTick(quietMs - idle)
    }
  }

  /** Type text as a human would — one chunk, then let the UI react. */
  async type(text: string, settleMs = 120): Promise<void> {
    this.pty.write(text)
    await this.nextTick(settleMs)
  }

  async key(name: keyof typeof KEYS, settleMs = 200): Promise<void> {
    await this.type(KEYS[name], settleMs)
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows)
    this.screen.resize(cols, rows)
  }

  snapshot(label: string): ScreenSnapshot {
    return this.screen.snapshot(label)
  }

  /** Wait until every captured byte is on the grid. */
  drain(): Promise<void> {
    return this.screen.drain()
  }

  rawBytes(): string {
    return this.screen.rawBytes()
  }

  get hasExited(): boolean {
    return this.exit !== undefined
  }

  /** Wait for the process to end. Kills it if it overstays. */
  async waitExit(timeoutMs = 20_000): Promise<ExitResult> {
    if (this.exit !== undefined) return this.exit
    const result = await Promise.race([
      this.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    ])
    if (result === 'timeout') {
      this.kill('SIGKILL')
      return { exitCode: -1, signal: undefined }
    }
    return result
  }

  kill(signal: string = 'SIGTERM'): void {
    if (this.exit === undefined) {
      try {
        this.pty.kill(signal)
      } catch {
        // Already gone between the check and the call — nothing to do.
      }
    }
  }
}

export class PtyTimeout extends Error {
  readonly screen: ScreenSnapshot

  constructor(message: string, screen: ScreenSnapshot) {
    super(message)
    this.name = 'PtyTimeout'
    this.screen = screen
  }
}

function describe(needle: string | RegExp): string {
  return typeof needle === 'string' ? JSON.stringify(needle) : String(needle)
}
