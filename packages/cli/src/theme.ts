/**
 * The Ownware terminal theme, expressed as ANSI truecolor:
 *
 *   carbon  the ink   — dim/secondary text (#8C8B86 / #6E6D69)
 *   bone    the ground — primary text on dark (#F4F3F0)
 *   cobalt  the signal — THE one rented color (#6784F0 on dark);
 *           links, focus, selection, the live signal. Nothing else
 *           gets to be blue (accent contract from the render spec).
 *
 * Truecolor when the terminal declares it (`COLORTERM=truecolor|24bit`),
 * classic ANSI otherwise, identity under NO_COLOR / non-TTY.
 */

import { ANSI_STYLE, PLAIN_STYLE, type Style } from './style.js'

export const TOKENS = {
  bone: '#F4F3F0',
  carbonDim: '#8C8B86', // carbon-300 — meta text (render spec §12)
  carbonFaint: '#6E6D69', // carbon-400 — structure glyphs (⎿ › │)
  cobalt: '#93A9F9', // cobalt-300 — THE accent on dark (render spec §12)
  success: '#3FB950',
  warning: '#D29922',
  danger: '#F85149',
} as const

function rgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

function fg(hex: string): (s: string) => string {
  const [r, g, b] = rgb(hex)
  return (s) => `\u001b[38;2;${r};${g};${b}m${s}\u001b[39m`
}

function sgr(open: number, close: number): (s: string) => string {
  return (s) => `\u001b[${open}m${s}\u001b[${close}m`
}

export const TOKEN_STYLE: Style = {
  dim: fg(TOKENS.carbonDim),
  dim2: fg(TOKENS.carbonFaint),
  bold: sgr(1, 22),
  italic: sgr(3, 23),
  red: fg(TOKENS.danger),
  green: fg(TOKENS.success),
  warn: fg(TOKENS.warning),
  cyan: fg(TOKENS.cobalt),
  strike: sgr(9, 29),
}

export function supportsTruecolor(env: NodeJS.ProcessEnv = process.env): boolean {
  const colorterm = env['COLORTERM'] ?? ''
  if (colorterm === 'truecolor' || colorterm === '24bit') return true
  // Terminals that always do truecolor but don't always say so.
  const program = env['TERM_PROGRAM'] ?? ''
  // NOTE: Apple Terminal has no truecolor — deliberately absent.
  return ['iTerm.app', 'WezTerm', 'ghostty', 'vscode'].includes(program)
}

/** Token truecolor when possible, classic ANSI otherwise, plain when off. */
export function detectTheme(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout.isTTY === true,
): Style {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return PLAIN_STYLE
  if (!isTTY) return PLAIN_STYLE
  return supportsTruecolor(env) ? TOKEN_STYLE : ANSI_STYLE
}
