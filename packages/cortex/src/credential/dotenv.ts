/**
 * Minimal `.env` Parser.
 *
 * Zero dependencies (the repo's `no utility deps` rule forbids pulling in
 * `dotenv` just for parsing). Covers the shape conventions the ecosystem
 * has settled on:
 *
 *   - `KEY=value`                       — bare value, leading/trailing
 *                                         whitespace trimmed.
 *   - `KEY="value with spaces"`         — double-quoted; supports the
 *                                         escapes \\ \" \n \r \t.
 *   - `KEY='literal ${FOO}'`            — single-quoted; NO escapes, NO
 *                                         substitution.
 *   - `KEY=   `                         — empty value allowed.
 *   - `export KEY=value`                — the `export ` prefix is stripped.
 *   - `# comment line`                  — ignored.
 *   - `KEY=value # trailing comment`    — trailing `#` after whitespace is
 *                                         stripped from UNQUOTED values only
 *                                         (matches dotenv's historical rule).
 *   - Blank lines                       — ignored.
 *   - CRLF / LF                         — both accepted.
 *
 * Deliberately NOT supported (kept out because they change semantics in
 * ways a security-sensitive parser should not guess at):
 *
 *   - `${VAR}` interpolation inside values. Cortex resolves those at
 *     a higher layer (the existing `env.ts` helpers) using known-good
 *     substitution rules. A .env file consumed here is expected to
 *     contain only final values.
 *   - Multiline quoted values that span `\n` characters. Very rare
 *     in practice; parsing them correctly requires a proper state
 *     machine and the cost isn't worth it for the benefit.
 *
 * Malformed lines are skipped, not thrown. Reasoning: a single typo'd
 * line should not prevent the entire import from running, and the
 * session auto-import path is best-effort. The caller receives only
 * the valid parses plus, if requested, the list of skipped line numbers
 * for diagnostics.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedDotenvEntry {
  readonly key: string
  readonly value: string
  /** Line number (1-based) where the entry was parsed. */
  readonly line: number
}

export interface ParsedDotenv {
  readonly entries: readonly ParsedDotenvEntry[]
  /** 1-based line numbers that could not be parsed. */
  readonly skippedLines: readonly number[]
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * KEY must start with a letter or `_` and contain only letters, digits,
 * and `_`. Matches the POSIX env var rule.
 */
const KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Top-of-line decoration stripped before parsing the KEY. */
const EXPORT_PREFIX_REGEX = /^export[ \t]+/

export function parseDotenv(source: string): ParsedDotenv {
  const entries: ParsedDotenvEntry[] = []
  const skippedLines: number[] = []

  // Split on LF; CR is trimmed by the per-line handler so CRLF input works.
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    let raw = lines[i]!

    // Strip trailing CR (handles CRLF files on Unix without a mode flag).
    if (raw.endsWith('\r')) raw = raw.slice(0, -1)

    // Leading whitespace is insignificant.
    const trimmed = raw.replace(/^[ \t]+/, '')

    // Comments and blanks.
    if (trimmed === '' || trimmed.startsWith('#')) continue

    // `export` prefix — strip and continue.
    const withoutExport = trimmed.replace(EXPORT_PREFIX_REGEX, '')

    // Split on the FIRST `=`. Everything before is the key; everything
    // after is the value (we apply quoting rules to the value below).
    const eqIdx = withoutExport.indexOf('=')
    if (eqIdx === -1) {
      skippedLines.push(lineNo)
      continue
    }

    const rawKey = withoutExport.slice(0, eqIdx).trimEnd()
    const rawValue = withoutExport.slice(eqIdx + 1)

    if (!KEY_REGEX.test(rawKey)) {
      skippedLines.push(lineNo)
      continue
    }

    const parsedValue = parseValue(rawValue)
    if (parsedValue === null) {
      skippedLines.push(lineNo)
      continue
    }

    entries.push({ key: rawKey, value: parsedValue, line: lineNo })
  }

  return { entries, skippedLines }
}

/**
 * Normalize one value per the shape rules above. Returns `null` when the
 * line's right-hand side is malformed (e.g. unterminated quote).
 */
function parseValue(raw: string): string | null {
  // Strip leading whitespace only — trailing whitespace is preserved by
  // quoted values and explicitly handled for unquoted ones.
  let v = raw.replace(/^[ \t]+/, '')

  if (v === '') return ''

  const first = v[0]!
  if (first === '"') {
    return parseDoubleQuoted(v)
  }
  if (first === "'") {
    return parseSingleQuoted(v)
  }

  // Unquoted: strip trailing comment (` # ...` or tab before #), then trim.
  // The comment-boundary rule matches the historical dotenv behaviour —
  // only strip if preceded by whitespace so `foo=bar#baz` keeps `bar#baz`.
  const commentBoundary = v.search(/[ \t]#/)
  if (commentBoundary !== -1) v = v.slice(0, commentBoundary)
  return v.replace(/[ \t]+$/, '')
}

function parseDoubleQuoted(raw: string): string | null {
  // Scan character-by-character honoring escapes. Parser consumes the
  // leading " and walks until a matching unescaped ".
  let i = 1
  let out = ''
  while (i < raw.length) {
    const c = raw[i]!
    if (c === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1]!
      switch (next) {
        case 'n': out += '\n'; break
        case 'r': out += '\r'; break
        case 't': out += '\t'; break
        case '\\': out += '\\'; break
        case '"': out += '"'; break
        default:
          // Unknown escape — emit as-is (`\x` → `\x`). Most dotenv
          // parsers do this; dropping the backslash silently loses data.
          out += '\\' + next
      }
      i += 2
      continue
    }
    if (c === '"') {
      // Matched closing quote. The remainder of the line (after optional
      // whitespace + optional `# comment`) is ignored.
      return out
    }
    out += c
    i++
  }
  // Ran off the end without a closing quote.
  return null
}

function parseSingleQuoted(raw: string): string | null {
  // No escapes inside single quotes.
  const end = raw.indexOf("'", 1)
  if (end === -1) return null
  return raw.slice(1, end)
}
