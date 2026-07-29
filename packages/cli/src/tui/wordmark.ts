/**
 * The launch splash uses a chunky pixel wordmark: `own` in carbon
 * (the ink), `ware` in bone (the ground), with
 * detail lines beneath in carbon with cobalt only where it signals.
 *
 * Rendered as plain ANSI lines (the shell commits them through the
 * same scrollback path as the transcript), centered to the terminal
 * width; when the terminal is too narrow the wordmark degrades to the
 * one-line text banner. It scrolls up naturally as the conversation
 * grows — the story takes over from the brand.
 */

import type { Style } from '../style.js'
import { shortenHome, type BannerInfo } from '../banner.js'

// 5-row pixel letters (1 = pixel). Two terminal cells per pixel.
const LETTERS: Record<string, readonly string[]> = {
  o: ['1111', '1001', '1001', '1001', '1111'],
  w: ['10001', '10001', '10101', '10101', '01110'],
  n: ['1001', '1101', '1011', '1001', '1001'],
  a: ['0110', '1001', '1111', '1001', '1001'],
  r: ['1110', '1001', '1110', '1010', '1001'],
  e: ['1111', '1000', '1110', '1000', '1111'],
}

function renderWord(word: string, pixel: string, blank: string): string[] {
  const rows = ['', '', '', '', '']
  for (const char of word) {
    const glyph = LETTERS[char]
    if (glyph === undefined) continue
    for (let row = 0; row < 5; row++) {
      const bits = glyph[row]!
      rows[row] +=
        bits
          .split('')
          .map((bit) => (bit === '1' ? pixel : blank))
          .join('') + blank
    }
  }
  return rows.map((row) => row.replace(/\s+$/, ''))
}

export function buildWordmarkSplash(
  info: BannerInfo,
  s: Style,
  columns: number = process.stdout.columns ?? 80,
): string[] {
  // Wide terminals get chunky 2-cell pixels, narrower ones 1-cell,
  // anything tighter the plain text mark.
  const tiers: Array<[string, string]> = [
    ['██', '  '],
    ['█', ' '],
  ]
  const lines: string[] = ['']
  let drawn = false
  for (const [pixel, blank] of tiers) {
    const own = renderWord('own', pixel, blank)
    const ware = renderWord('ware', pixel, blank)
    const gap = blank.repeat(2)
    const width = Math.max(...own.map((r, i) => r.length + gap.length + ware[i]!.length))
    if (columns >= width + 4) {
      const pad = ' '.repeat(Math.max(0, Math.floor((columns - width) / 2)))
      const ownWidth = Math.max(...own.map((r) => r.length))
      for (let row = 0; row < 5; row++) {
        lines.push(pad + s.dim(own[row]!.padEnd(ownWidth + gap.length)) + s.bold(ware[row]!))
      }
      drawn = true
      break
    }
  }
  if (!drawn) lines.push(s.dim('own') + s.bold('ware'))
  lines.push('')

  const detail: string[] = []
  detail.push(
    [
      info.profileId,
      ...(info.model !== null ? [info.model] : []),
      ...(info.version !== null ? [`v${info.version}`] : []),
    ].join(' · '),
  )
  detail.push(
    `${shortenHome(info.cwd)} · ${info.baseUrl.replace(/^https?:\/\//, '')}${info.owned ? ' (local)' : ''}`,
  )
  if (info.logFile !== undefined) detail.push(`logs ${shortenHome(info.logFile)}`)

  const detailWidth = Math.max(...detail.map((line) => line.length))
  const detailPad =
    columns >= detailWidth + 4 ? ' '.repeat(Math.max(0, Math.floor((columns - detailWidth) / 2))) : ''
  for (const line of detail) lines.push(detailPad + s.dim(line))
  lines.push('')
  return lines
}
