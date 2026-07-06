/**
 * Timeout Parser
 *
 * Parses human-readable timeout strings into milliseconds.
 * Supports: s (seconds), m (minutes), h (hours), d (days).
 * Raw numbers are treated as milliseconds.
 */

const TIMEOUT_PATTERN = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i

const MULTIPLIERS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/**
 * Parse a human-readable timeout string to milliseconds.
 *
 * @param timeout - Duration string (e.g., "5s", "30m", "2h", "1d") or raw ms as string
 * @returns Duration in milliseconds
 * @throws Error if the format is not recognized
 *
 * @example
 * parseTimeout("5s")   // 5000
 * parseTimeout("30m")  // 1800000
 * parseTimeout("2h")   // 7200000
 * parseTimeout("1d")   // 86400000
 * parseTimeout("500")  // 500
 */
export function parseTimeout(timeout: string): number {
  const trimmed = timeout.trim()

  // Raw number — treat as milliseconds
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed)
    if (ms <= 0) {
      throw new Error(`Invalid timeout "${timeout}": must be a positive number.`)
    }
    return ms
  }

  const match = trimmed.match(TIMEOUT_PATTERN)
  if (!match) {
    throw new Error(
      `Invalid timeout "${timeout}". ` +
      `Expected format: <number><unit> where unit is s (seconds), m (minutes), h (hours), or d (days). ` +
      `Examples: "5s", "30m", "2h", "1d".`,
    )
  }

  const value = parseFloat(match[1]!)
  const unit = match[2]!.toLowerCase()
  const multiplier = MULTIPLIERS[unit]

  if (multiplier === undefined) {
    throw new Error(`Unknown timeout unit "${unit}".`)
  }

  const ms = Math.round(value * multiplier)
  if (ms <= 0) {
    throw new Error(`Invalid timeout "${timeout}": resolves to 0ms.`)
  }

  return ms
}
