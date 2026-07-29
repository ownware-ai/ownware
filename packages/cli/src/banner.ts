/**
 * The launch banner — the product's face when the CLI opens.
 *
 *   ▌ ownware v0.3.0
 *   ▌ ownware-code · anthropic:claude-sonnet-4-6
 *   ▌ ~/projects/ownware · 127.0.0.1:60565 (local)
 *
 * Cobalt bar (the one rented color), bone wordmark, carbon detail —
 * printed into ordinary scrollback before any renderer takes over, so
 * it behaves identically under the TUI and the fallback REPL.
 */

import { homedir } from 'node:os'
import type { Style } from './style.js'

export interface BannerInfo {
  readonly version: string | null
  readonly profileId: string
  readonly model: string | null
  readonly cwd: string
  readonly baseUrl: string
  readonly owned: boolean
  readonly logFile?: string | undefined
}

export function shortenHome(path: string): string {
  const home = homedir()
  return path === home ? '~' : path.startsWith(home + '/') ? '~' + path.slice(home.length) : path
}

/** The `▌ ` prefix, in visible columns. */
const BAR_WIDTH = 2

/**
 * Keep a path inside `max` columns by dropping the MIDDLE.
 *
 * The tail identifies the project and the head says where it lives;
 * the middle is the part nobody reads. Truncating the tail instead
 * would hide exactly the segment the customer is looking for.
 */
export function fitPath(path: string, max: number): string {
  if (max <= 1) return path.slice(0, Math.max(0, max))
  if (path.length <= max) return path
  const tail = Math.max(1, Math.ceil((max - 1) * 0.6))
  const head = max - 1 - tail
  return `${path.slice(0, Math.max(0, head))}…${path.slice(path.length - tail)}`
}

/**
 * The banner is a set of ONE-LINE rows. A row wider than the terminal
 * wraps into a second row with no `▌`, which reads as debris rather
 * than a header — and a deep working directory made that the normal
 * case, not an edge case (FINDINGS F1). Every row is therefore fitted
 * to the terminal width, measured on the PLAIN text: styling adds
 * escape bytes that occupy no columns.
 */
export function buildBanner(info: BannerInfo, s: Style, width?: number): string {
  const cols = width ?? process.stdout.columns ?? 80
  const budget = Math.max(8, cols - BAR_WIDTH)
  const bar = s.cyan('▌ ')
  const version = info.version === null ? '' : ` ${s.dim(`v${info.version}`)}`
  const host = info.baseUrl.replace(/^https?:\/\//, '')
  const where = `${host}${info.owned ? ' (local)' : ''}`

  // The location row: the gateway is fixed-width, so the path absorbs
  // whatever is left rather than pushing the row over the edge.
  const locationSuffix = ` · ${where}`
  const cwd = fitPath(shortenHome(info.cwd), Math.max(4, budget - locationSuffix.length))

  const identity = `${info.profileId}${info.model !== null ? ` · ${info.model}` : ''}`
  const lines = [
    bar + s.bold('ownware') + version,
    bar +
      (identity.length <= budget
        ? info.profileId + (info.model !== null ? s.dim(` · ${info.model}`) : '')
        : s.dim(fitPath(identity, budget))),
    bar + s.dim(`${cwd}${locationSuffix}`),
  ]
  if (info.logFile !== undefined) {
    lines.push(bar + s.dim(`logs ${fitPath(shortenHome(info.logFile), budget - 'logs '.length)}`))
  }
  return lines.join('\n') + '\n\n'
}
