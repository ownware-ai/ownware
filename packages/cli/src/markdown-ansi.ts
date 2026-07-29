/**
 * Streaming markdown → ANSI for the transcript.
 *
 * The model's reply streams as text deltas; raw `**bold**` and `# Head`
 * in a terminal read as noise. This renders GitHub-flavored basics to
 * ANSI as the text arrives:
 *
 *   # Heading          bold
 *   **bold**           bold        *italic* / _italic_   italic
 *   `code`             accent      [text](url)           text (url dim)
 *   - bullet           • bullet    > quote               │ quote (dim bar)
 *   ``` fences         markers dim, contents verbatim (no md inside)
 *   | table | rows |   pipes dimmed, cells verbatim
 *   ---                ─ rule (dim)
 *
 * Line-buffered: a line renders once its newline arrives (inline spans
 * never split across lines in practice), and `flush()` renders any
 * pending partial line — the renderer calls it whenever something else
 * must print at column 0. Every emit is one whole line in ONE write,
 * which also keeps the split-footer scrollback capture happy.
 *
 * Pure: style + emit injected, no terminal knowledge.
 */

import type { Style } from './style.js'

export class MarkdownStream {
  private buf = ''
  private inFence = false

  constructor(
    private readonly style: Style,
    private readonly emit: (chunk: string) => void,
    private readonly plain: boolean = false,
  ) {}

  feed(text: string): void {
    this.buf += text
    for (;;) {
      const newline = this.buf.indexOf('\n')
      if (newline === -1) break
      const line = this.buf.slice(0, newline)
      this.buf = this.buf.slice(newline + 1)
      this.emit(this.renderLine(line) + '\n')
    }
  }

  /** True when a partial line is buffered (the "text is open" state). */
  get pending(): boolean {
    return this.buf.length > 0
  }

  /** Render any pending partial line, closing it with a newline. */
  flush(): void {
    if (this.buf.length === 0) return
    const line = this.buf
    this.buf = ''
    this.emit(this.renderLine(line) + '\n')
  }

  private renderLine(line: string): string {
    if (this.plain) return line
    const s = this.style

    // Fences: toggle, dim the marker, and pass contents verbatim.
    if (/^\s*(```|~~~)/.test(line)) {
      this.inFence = !this.inFence
      return s.dim(line)
    }
    if (this.inFence) return line

    // Horizontal rule.
    if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      return s.dim('─'.repeat(Math.min(40, Math.max(3, line.trim().length))))
    }

    // Headings: strip the marker, render bold.
    const heading = /^(\s*)(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      return heading[1]! + s.bold(this.inline(heading[3]!))
    }

    // Blockquote.
    const quote = /^(\s*)>\s?(.*)$/.exec(line)
    if (quote !== null) {
      return quote[1]! + s.dim('│ ') + s.dim(this.inline(quote[2]!))
    }

    // Bullets.
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet !== null) {
      return bullet[1]! + s.dim('•') + ' ' + this.inline(bullet[2]!)
    }

    // Table rows: dim the pipes, render cells inline.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^[\s|:-]+$/.test(line)) return s.dim(line) // separator row
      return line
        .split('|')
        .map((cell) => this.inline(cell))
        .join(s.dim('|'))
    }

    return this.inline(line)
  }

  /** Inline spans: bold → italic → code → links (order matters). */
  private inline(text: string): string {
    const s = this.style
    let result = text
    result = result.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => s.bold(inner))
    result = result.replace(/(^|\W)\*([^*\s][^*]*)\*(?=\W|$)/g, (_m, pre: string, inner: string) =>
      `${pre}${s.italic(inner)}`,
    )
    result = result.replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, (_m, pre: string, inner: string) =>
      `${pre}${s.italic(inner)}`,
    )
    result = result.replace(/`([^`]+)`/g, (_m, inner: string) => s.cyan(inner))
    result = result.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m, label: string, url: string) => `${label} ${s.dim(`(${url})`)}`,
    )
    return result
  }
}
