/**
 * Byte stream → the screen a human actually sees.
 *
 * The CLI's output is a stream of bytes with escape sequences in it. A
 * human never sees that stream — they see the GRID a terminal paints
 * from it, at their terminal's width, with wrapping, overwrites, cursor
 * moves and colour applied. Asserting on the raw stream therefore proves
 * very little about the experience: it cannot see a line that wrapped
 * badly at 60 columns, a glyph the parser ate, or an accent colour used
 * in two different shades.
 *
 * So we replay the captured bytes through a real terminal emulator
 * (@xterm/headless — the same VT engine as xterm.js) and read the grid
 * back out. That grid is what the judge pass reads.
 *
 * `hygiene()` is deliberately NOT a pass/fail oracle. It flags the
 * shapes that have historically meant "this looks broken to a human"
 * (BUGS #1's log bleed, the eaten-bytes tofu bug, raw `**` markdown).
 * A flag is a signal to look, not proof of a defect — and the absence of
 * flags is not proof the screen is good. That judgement stays with the
 * reader.
 */

// @xterm/headless ships CommonJS; ESM named-export detection misses it.
import { createRequire } from 'node:module'
import type { Terminal as TerminalType } from '@xterm/headless'

const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as {
  Terminal: new (opts: Record<string, unknown>) => TerminalType
}

export interface HygieneFlag {
  readonly kind: string
  readonly line: number
  readonly detail: string
}

export interface ScreenSnapshot {
  readonly label: string
  readonly cols: number
  readonly rows: number
  /** Scrollback + viewport, trailing blank lines trimmed. */
  readonly lines: readonly string[]
  /**
   * Which rows the TERMINAL says are continuations of the row above.
   * Authoritative — `line.length > cols` can never see a wrap, because
   * by the time the grid exists the wrap has already happened.
   */
  readonly wrapped: readonly boolean[]
  readonly cursor: { readonly x: number; readonly y: number }
  /** Distinct foreground colours per line — how consistent is the palette. */
  readonly palette: readonly string[]
  readonly hygiene: readonly HygieneFlag[]
}

/** Sequences a customer must never see rendered as literal text. */
const LITERAL_ESCAPE = /\[[0-9;]*m|\[\?[0-9]+[hl]/
/** The transcript promises rendered markdown, never the markers. */
const RAW_MARKDOWN = /(\*\*[^*\s][^*]*\*\*)|(^\s*#{1,6}\s)|(^\s*```)/
/** Values that leak an internal representation into the customer's face. */
const VALUE_LEAK = /\b(undefined|null|NaN|\[object Object\])\b/
/**
 * Rows the render spec defines as exactly one line: the banner bar, the
 * prompt echo, tool rows, decisions, settle summaries, subagent lines.
 * Prose may wrap freely; these may not.
 */
const STRUCTURAL_ROW = /^\s*[▌❯●◐◇✓✔✖✻⎿↺⎋]/
/** A control byte that survived into the painted grid is a rendering bug. */
// eslint-disable-next-line no-control-regex
const CONTROL_BYTE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/

export class Screen {
  private readonly term: TerminalType
  private raw = ''
  private chain: Promise<void> = Promise.resolve()

  readonly cols: number
  readonly rows: number

  constructor(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 })
  }

  /** Feed captured bytes. Returns once the emulator has parsed them. */
  write(chunk: string): Promise<void> {
    this.raw += chunk
    const parsed = new Promise<void>((resolve) => {
      this.term.write(chunk, resolve)
    })
    // Chain every write so `drain()` can prove the grid has caught up.
    // Without this, a process that exits immediately after its last line
    // races the emulator and the final output is invisible to a probe.
    this.chain = this.chain.then(() => parsed)
    return parsed
  }

  /** Resolves once every byte fed so far is on the grid. */
  drain(): Promise<void> {
    return this.chain
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows)
  }

  /** Everything the process emitted, escape sequences included. */
  rawBytes(): string {
    return this.raw
  }

  private grid(): { lines: string[]; wrapped: boolean[] } {
    const buf = this.term.buffer.active
    const lines: string[] = []
    const wrapped: boolean[] = []
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y)
      lines.push(line === undefined ? '' : line.translateToString(true))
      wrapped.push(line?.isWrapped === true)
    }
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
      lines.pop()
      wrapped.pop()
    }
    return { lines, wrapped }
  }

  /** Distinct foreground colours in use, as stable identifiers. */
  private colours(): string[] {
    const buf = this.term.buffer.active
    const seen = new Set<string>()
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y)
      if (line === undefined) continue
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x)
        if (cell === undefined || cell.getChars() === '') continue
        if (cell.isFgDefault()) continue
        if (cell.isFgRGB()) {
          const c = cell.getFgColor()
          seen.add(`#${((c >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`)
        } else if (cell.isFgPalette()) {
          seen.add(`ansi-${cell.getFgColor()}`)
        }
      }
    }
    return [...seen].sort()
  }

  private hygiene(lines: readonly string[], wrapped: readonly boolean[]): HygieneFlag[] {
    const flags: HygieneFlag[] = []
    const flag = (kind: string, line: number, detail: string): void => {
      flags.push({ kind, line, detail })
    }
    lines.forEach((text, i) => {
      if (text.includes('�')) flag('glyph-corruption', i, `replacement char in: ${text.trim()}`)
      if (LITERAL_ESCAPE.test(text)) flag('literal-escape', i, `escape rendered as text: ${text.trim()}`)
      if (RAW_MARKDOWN.test(text)) flag('raw-markdown', i, `unrendered markdown: ${text.trim()}`)
      if (VALUE_LEAK.test(text)) flag('value-leak', i, `internal value shown: ${text.trim()}`)
      if (/\[(loom|ownware|boot-trace|session-runner)[\]/]/.test(text)) {
        flag('log-bleed', i, `gateway log in the transcript: ${text.trim()}`)
      }
      if (CONTROL_BYTE.test(text)) {
        flag('control-char', i, `raw control byte in: ${JSON.stringify(text)}`)
      }
      // Prose is SUPPOSED to wrap. A structural row — banner bar, tool
      // row, settle line, prompt — is designed as exactly one line, so a
      // wrap there is a layout defect the customer sees as debris.
      if (wrapped[i] === true) {
        const parent = lines[i - 1] ?? ''
        if (STRUCTURAL_ROW.test(parent)) {
          flag('structural-wrap', i, `one-line row wrapped at ${this.cols} cols: ${parent.trim()}`)
        }
      }
    })
    return flags
  }

  snapshot(label: string): ScreenSnapshot {
    const { lines, wrapped } = this.grid()
    const buf = this.term.buffer.active
    return {
      label,
      cols: this.cols,
      rows: this.rows,
      lines,
      wrapped,
      cursor: { x: buf.cursorX, y: buf.cursorY },
      palette: this.colours(),
      hygiene: this.hygiene(lines, wrapped),
    }
  }

  /** The artifact form: a ruled box so wrapping is visible at a glance. */
  static render(snap: ScreenSnapshot): string {
    const rule = '─'.repeat(snap.cols)
    // The gutter marks rows the terminal wrapped, so a layout that
    // "looks fine" as text is exposed as two ragged rows here.
    const body = snap.lines
      .map((l, i) => `${snap.wrapped[i] === true ? '↩' : ' '}│${l.padEnd(snap.cols, ' ')}│`)
      .join('\n')
    const flags =
      snap.hygiene.length === 0
        ? 'none'
        : snap.hygiene.map((f) => `  line ${f.line}: [${f.kind}] ${f.detail}`).join('\n')
    return [
      `── ${snap.label} · ${snap.cols}×${snap.rows} ${'─'.repeat(Math.max(0, snap.cols - snap.label.length - 10))}`,
      ` ┌${rule}┐`,
      body,
      ` └${rule}┘`,
      `cursor: ${snap.cursor.x},${snap.cursor.y}`,
      `palette: ${snap.palette.join(' ') || 'default only'}`,
      `hygiene flags:\n${flags}`,
      '',
    ].join('\n')
  }
}
