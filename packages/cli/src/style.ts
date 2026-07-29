/**
 * Terminal styling for the fallback renderer.
 *
 * Plain ANSI only — no dependency, no cursor movement, no repaints. The
 * renderer is append-only real scrollback, so style is the only terminal
 * capability this module
 * touches. Honors `NO_COLOR` (https://no-color.org) and non-TTY stdout,
 * both of which collapse every style to identity.
 */

export interface Style {
  /** Meta text — carbon-300. */
  dim(s: string): string
  /** Structure glyphs (⎿ › │) — carbon-400, one step quieter. */
  dim2(s: string): string
  bold(s: string): string
  italic(s: string): string
  red(s: string): string
  green(s: string): string
  /** Warnings / approval frames — amber. */
  warn(s: string): string
  cyan(s: string): string
  strike(s: string): string
}

const identity = (s: string) => s

export const PLAIN_STYLE: Style = {
  dim: identity,
  dim2: identity,
  bold: identity,
  italic: identity,
  red: identity,
  green: identity,
  warn: identity,
  cyan: identity,
  strike: identity,
}

function sgr(open: number, close: number): (s: string) => string {
  return (s) => `\u001b[${open}m${s}\u001b[${close}m`
}

export const ANSI_STYLE: Style = {
  dim: sgr(2, 22),
  dim2: sgr(2, 22),
  bold: sgr(1, 22),
  italic: sgr(3, 23),
  red: sgr(31, 39),
  green: sgr(32, 39),
  warn: sgr(33, 39),
  cyan: sgr(36, 39),
  strike: sgr(9, 29),
}

export function detectStyle(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout.isTTY === true,
): Style {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return PLAIN_STYLE
  return isTTY ? ANSI_STYLE : PLAIN_STYLE
}
