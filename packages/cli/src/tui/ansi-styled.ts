/**
 * Convert ONE transcript line (our own ANSI output) into an OpenTUI
 * `StyledText`, so the TUI commits scrollback through the native
 * renderable path instead of the captured-stdout ANSI parser.
 *
 * Why: the capture pipeline ate leading bytes of styled lines on real
 * terminals (`❯ hi` → `h`, `· cache…` → `ache…`, and it cut INTO the
 * ✻ codepoint producing tofu — a byte-vs-column bug outside our reach).
 * The footer never glitched because it renders through renderables; this
 * moves the transcript onto that same proven path.
 *
 * The parser covers exactly the SGR subset OUR styles emit
 * (`style.ts` / `theme.ts` / `markdown-ansi.ts`):
 *   38;2;r;g;b fg · 39 fg-reset · 1/22 bold · 2/22 dim · 3/23 italic ·
 *   9/29 strike · 31/32/36 classic fg · 0 full reset
 * Unknown codes are ignored (dropped), never rendered as text.
 */

import {
  StyledText,
  bold as boldChunk,
  dim as dimChunk,
  fg as fgChunk,
  italic as italicChunk,
  strikethrough as strikeChunk,
  stringToStyledText,
  type TextChunk,
} from '@opentui/core'

interface SgrState {
  fg: string | null
  bold: boolean
  dim: boolean
  italic: boolean
  strike: boolean
}

const CLASSIC_FG: Record<number, string> = {
  31: '#F85149', // red → danger
  32: '#3FB950', // green → success
  36: '#6784F0', // cyan slot → cobalt
}

function chunkFor(text: string, state: SgrState): TextChunk {
  let input: Parameters<typeof boldChunk>[0] = text
  if (state.fg !== null) input = fgChunk(state.fg)(input)
  if (state.bold) input = boldChunk(input)
  if (state.dim) input = dimChunk(input)
  if (state.italic) input = italicChunk(input)
  if (state.strike) input = strikeChunk(input)
  // A plain string chunk still needs to become a TextChunk.
  return typeof input === 'string' ? stringToStyledText(input).chunks[0]! : input
}

export function ansiLineToStyledText(line: string): StyledText {
  const chunks: TextChunk[] = []
  const state: SgrState = { fg: null, bold: false, dim: false, italic: false, strike: false }
  let i = 0
  let textStart = 0

  const pushText = (end: number) => {
    if (end > textStart) chunks.push(chunkFor(line.slice(textStart, end), state))
  }

  while (i < line.length) {
    if (line[i] === '\u001b' && line[i + 1] === '[') {
      const end = line.indexOf('m', i + 2)
      if (end === -1) break
      pushText(i)
      const params = line
        .slice(i + 2, end)
        .split(';')
        .map((p) => (p === '' ? 0 : Number(p)))
      for (let p = 0; p < params.length; p++) {
        const code = params[p]!
        if (code === 0) {
          state.fg = null
          state.bold = state.dim = state.italic = state.strike = false
        } else if (code === 1) state.bold = true
        else if (code === 2) state.dim = true
        else if (code === 22) {
          state.bold = false
          state.dim = false
        } else if (code === 3) state.italic = true
        else if (code === 23) state.italic = false
        else if (code === 9) state.strike = true
        else if (code === 29) state.strike = false
        else if (code === 39) state.fg = null
        else if (code === 38 && params[p + 1] === 2) {
          const r = params[p + 2] ?? 0
          const g = params[p + 3] ?? 0
          const b = params[p + 4] ?? 0
          state.fg = `#${hex(r)}${hex(g)}${hex(b)}`
          p += 4
        } else if (CLASSIC_FG[code] !== undefined) state.fg = CLASSIC_FG[code]!
        // Everything else: ignore.
      }
      i = end + 1
      textStart = i
    } else {
      i++
    }
  }
  pushText(line.length)
  return new StyledText(chunks)
}

function hex(n: number): string {
  return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0').toUpperCase()
}

/** The plain visible text of a line (for width decisions in callers). */
export function stripAnsi(line: string): string {
  return line.replace(/\u001b\[[0-9;]*m/g, '')
}
