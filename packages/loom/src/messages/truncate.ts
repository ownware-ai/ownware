/**
 * Byte-safe truncation utilities for tool output and message content.
 *
 * Three helpers, all UTF-8-safe:
 *   - byteSafePrefix(str, maxBytes)       — longest char-prefix whose UTF-8 fits
 *   - capBytes(str, maxBytes, marker?)    — head-only truncation with marker
 *   - headTailTruncate(str, maxBytes, …)  — head + tail at line boundaries
 *
 * `headTailTruncate` is the one you almost always want for tool results:
 * it preserves both the setup context AND the failure tail (stack trace,
 * exit code, last error), because the most actionable signal in a long
 * output is usually at the end.
 *
 * Sizes are measured in **UTF-8 bytes**, not characters. This matches
 * what the model actually pays for (tokens correlate with bytes, not
 * code points), and prevents UTF-16-surrogate / emoji corruption.
 */

const SURROGATE_HIGH_START = 0xd800
const SURROGATE_HIGH_END = 0xdbff

/**
 * Longest character-prefix of `str` whose UTF-8 encoding is <= `maxBytes`.
 *
 * Uses binary search on the JS string index (O(log n) byte-length probes)
 * so we never scan the whole string. Backs off by one code unit if the
 * prefix would land between a high and low surrogate, so the result
 * round-trips through UTF-8 without producing U+FFFD replacements.
 */
export function byteSafePrefix(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str

  let lo = 0
  let hi = str.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (Buffer.byteLength(str.slice(0, mid), 'utf8') <= maxBytes) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }

  if (lo > 0) {
    const code = str.charCodeAt(lo - 1)
    if (code >= SURROGATE_HIGH_START && code <= SURROGATE_HIGH_END) lo -= 1
  }
  return str.slice(0, lo)
}

/**
 * Symmetric to byteSafePrefix — longest character-suffix of `str` whose
 * UTF-8 encoding is <= `maxBytes`. Used by headTailTruncate to keep the
 * end of long output (where errors and exit codes live).
 *
 * Guards against splitting on a low surrogate by stepping forward one
 * code unit if the suffix starts on one.
 */
export function byteSafeSuffix(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str

  // Binary search for the smallest start index whose suffix fits.
  let lo = 0
  let hi = str.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (Buffer.byteLength(str.slice(mid), 'utf8') <= maxBytes) {
      hi = mid
    } else {
      lo = mid + 1
    }
  }

  if (lo < str.length) {
    const code = str.charCodeAt(lo)
    // Low surrogate at the start means we sliced through a pair — step forward.
    if (code >= 0xdc00 && code <= 0xdfff) lo += 1
  }
  return str.slice(lo)
}

/**
 * Cap `str` to at most `maxBytes` of UTF-8 with a trailing marker.
 *
 * Use this when the tail isn't useful (e.g. a single value field, JSON
 * blob, chat message). For tool output, prefer `headTailTruncate`.
 *
 * The returned string is always <= `maxBytes` bytes. If `maxBytes` is
 * smaller than the marker itself, the marker is byte-safely truncated.
 */
export function capBytes(
  str: string,
  maxBytes: number,
  marker: string = '\n\n[truncated]',
): string {
  const inputBytes = Buffer.byteLength(str, 'utf8')
  if (inputBytes <= maxBytes) return str

  const markerBytes = Buffer.byteLength(marker, 'utf8')
  if (maxBytes <= markerBytes) return byteSafePrefix(marker, maxBytes)

  return byteSafePrefix(str, maxBytes - markerBytes) + marker
}

export interface HeadTailOptions {
  /**
   * Fraction of the byte budget allocated to the HEAD slice. The remainder
   * (after the marker) goes to the TAIL. Defaults to 0.6 — head bias is
   * deliberate because the head sets context (file paths, command being
   * run, header fields) while the tail carries the outcome.
   */
  readonly headFraction?: number
  /**
   * If true (default), snap head and tail to line boundaries so we never
   * cut mid-line. The marker reports the original line/byte counts.
   */
  readonly snapToLines?: boolean
}

/**
 * Head + tail truncation. When `str` exceeds `maxBytes` of UTF-8, return
 * the first `headFraction` of the byte budget plus the last `1-headFraction`,
 * separated by a marker that reports how much was dropped.
 *
 * Both halves are snapped to line boundaries by default — we'd rather
 * lose a few extra bytes than show the model a mid-line fragment.
 *
 * The returned string is always <= `maxBytes` bytes.
 */
export function headTailTruncate(
  str: string,
  maxBytes: number,
  opts: HeadTailOptions = {},
): string {
  const inputBytes = Buffer.byteLength(str, 'utf8')
  if (inputBytes <= maxBytes) return str

  const headFraction = clamp(opts.headFraction ?? 0.6, 0.1, 0.9)
  const snapToLines = opts.snapToLines ?? true

  // Reserve marker space — we don't know the exact length yet because it
  // includes the dropped-byte count, but a 96-byte estimate is more than
  // enough for any plausible message ("[ N lines / N.NN MB truncated …]").
  const markerReserve = 96
  if (maxBytes <= markerReserve) {
    // Budget too small to do head+tail meaningfully — fall back to head cap.
    return capBytes(str, maxBytes)
  }

  const contentBudget = maxBytes - markerReserve
  const headBudget = Math.floor(contentBudget * headFraction)
  const tailBudget = contentBudget - headBudget

  let head = byteSafePrefix(str, headBudget)
  let tail = byteSafeSuffix(str, tailBudget)

  if (snapToLines) {
    // Snap head DOWN to the last newline so we end on a clean line.
    const lastNl = head.lastIndexOf('\n')
    if (lastNl > 0) head = head.slice(0, lastNl)

    // Snap tail UP to the first newline so we start on a clean line.
    const firstNl = tail.indexOf('\n')
    if (firstNl >= 0 && firstNl < tail.length - 1) tail = tail.slice(firstNl + 1)
  }

  const droppedBytes = inputBytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8')
  const totalLines = countLines(str)
  const headLines = countLines(head)
  const tailLines = countLines(tail)
  const droppedLines = Math.max(0, totalLines - headLines - tailLines)

  const marker =
    `\n\n... [${droppedLines} lines / ${formatBytes(droppedBytes)} truncated` +
    ` — head ${headLines} lines + tail ${tailLines} lines] ...\n\n`

  // If the assembled marker exceeds our reserve, byte-cap it. In practice
  // it's always smaller, but we never want to violate the maxBytes contract.
  const safeMarker =
    Buffer.byteLength(marker, 'utf8') <= markerReserve
      ? marker
      : byteSafePrefix(marker, markerReserve)

  const result = head + safeMarker + tail
  // Final guard — if line-snap pushed us back over, head-cap.
  if (Buffer.byteLength(result, 'utf8') > maxBytes) {
    return capBytes(result, maxBytes)
  }
  return result
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min
  if (n > max) return max
  return n
}

function countLines(str: string): number {
  if (str.length === 0) return 0
  let count = 1
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 0x0a) count++
  }
  return count
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
