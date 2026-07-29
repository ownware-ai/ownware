/**
 * Output Sanitizer
 *
 * Redacts secrets from tool output BEFORE it goes back to the model.
 * Prevents the model from seeing API keys, private keys, connection
 * strings, and tokens — then leaking them in responses.
 *
 * @security This module owns the ONE canonical secret-pattern list.
 * Anything that needs to redact secrets imports from here — never
 * copies the patterns. Two entry points:
 *
 *   - `sanitizeOutput`       — free-form text (tool results, logs).
 *   - `sanitizeJsonFragment` — a fragment of a JSON document, where a
 *                              replacement must not break parsing.
 *
 *   - `sanitizeToolResultText` — a COMPLETE tool result: parses JSON
 *                                first so redaction cannot break it.
 *   - `redactSecretsDeep`      — an already-parsed value.
 *
 * `executeTool` (`tools/executor.ts`) applies `sanitizeToolResultText`
 * to EVERY tool result, which is what makes the first line of this
 * docstring true — before that, only `shell` and `filesystem` sanitized
 * themselves and every other tool's output reached the model verbatim.
 * The kernel gateway additionally redacts tool arguments at each of its
 * store write paths.
 *
 * Zero external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SanitizeResult {
  /** The sanitized output string */
  readonly sanitized: string
  /** Number of secrets that were redacted */
  readonly redactedCount: number
  /** Types of secrets that were found */
  readonly redactedTypes: readonly string[]
}

// ---------------------------------------------------------------------------
// Secret patterns
// ---------------------------------------------------------------------------

interface SecretPattern {
  readonly type: string
  readonly pattern: RegExp
  /**
   * True when this pattern's MATCH can never contain `"` or `\` — the
   * only two characters that can end or escape a JSON string. Such a
   * match always lies wholly INSIDE one string value, so swapping it for
   * `[REDACTED:TYPE]` (which also contains neither) leaves the document's
   * structure untouched. `:`, `,` and braces are irrelevant here: they
   * carry no meaning inside a string literal.
   *
   * @security This flag decides whether the pattern may run against a
   * *fragment* of a JSON document (`sanitizeJsonFragment`). A pattern
   * that can swallow the closing quote destroys everything after it —
   * verified, not theorised:
   *
   *   {"a":"X_SECRET=abcdefghij","b":"keep me"}
   *     → {"a":"X[REDACTED:SECRET_ASSIGNMENT],"b":"keep me"}   // unparseable
   *
   * The consumer then silently loses the WHOLE object — a worse outcome
   * than the leak we were closing, since the tool card or design-canvas
   * replay that reads it just renders nothing.
   *
   * `false` does NOT mean "not a secret" — it means "only safe to redact
   * once the JSON has been parsed, where rewriting a value can no longer
   * break the document." Those four patterns are still applied in full at
   * the object level.
   */
  readonly jsonSafe: boolean
}

/** @security Each pattern targets a specific credential format. */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  // AWS access keys (always 20 chars, start with AKIA or ASIA)
  { type: 'AWS_KEY', pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, jsonSafe: true },

  // AWS secret keys (40 chars base64-ish, often after = or : in config).
  // The `aws_secret_access_key=` prefix is a LOOKBEHIND — the match itself
  // is only the 40-char value, so it stays inside one JSON token.
  { type: 'AWS_SECRET', pattern: /(?<=aws_secret_access_key\s*[=:]\s*)[A-Za-z0-9/+=]{40}\b/g, jsonSafe: true },

  // OpenAI API keys
  { type: 'OPENAI_KEY', pattern: /\bsk-[a-zA-Z0-9]{20,}\b/g, jsonSafe: true },

  // Anthropic API keys
  { type: 'ANTHROPIC_KEY', pattern: /\bsk-ant-[a-zA-Z0-9-]{20,}\b/g, jsonSafe: true },

  // Google API keys
  { type: 'GOOGLE_KEY', pattern: /\bAIza[a-zA-Z0-9_-]{35}\b/g, jsonSafe: true },

  // Google OAuth access tokens (ya29.<long>)
  { type: 'GOOGLE_OAUTH', pattern: /\bya29\.[a-zA-Z0-9_-]{20,}/g, jsonSafe: true },

  // Hugging Face access tokens
  { type: 'HUGGINGFACE_TOKEN', pattern: /\bhf_[a-zA-Z0-9]{30,}\b/g, jsonSafe: true },

  // Stripe keys
  { type: 'STRIPE_KEY', pattern: /\b[sp]k_(live|test)_[a-zA-Z0-9]{20,}\b/g, jsonSafe: true },

  // GitHub tokens
  { type: 'GITHUB_TOKEN', pattern: /\b(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}\b/g, jsonSafe: true },
  { type: 'GITHUB_PAT', pattern: /\bgithub_pat_[a-zA-Z0-9_]{22,}\b/g, jsonSafe: true },

  // Private keys (PEM format).
  // NOT json-safe: the lazy `[\s\S]*?` body can run from a BEGIN marker in
  // one JSON string value to an END marker in a later one, swallowing the
  // structural characters in between.
  { type: 'PRIVATE_KEY', pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|ENCRYPTED\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|ENCRYPTED\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g, jsonSafe: false },

  // Connection strings with passwords.
  // NOT json-safe: the trailing `[^\s]+` host segment happily swallows
  // `","` and everything after it up to the next whitespace.
  { type: 'CONNECTION_STRING', pattern: /(postgres|mysql|mongodb|redis|amqp|mssql):\/\/[^:\s]+:[^@\s]+@[^\s]+/g, jsonSafe: false },

  // JWT tokens (three base64 sections)
  { type: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, jsonSafe: true },

  // Bearer tokens in HTTP headers
  { type: 'BEARER_TOKEN', pattern: /\bBearer\s+[a-zA-Z0-9_.-]{20,}\b/g, jsonSafe: true },

  // Generic secret assignments (key=value patterns).
  // NOT json-safe: against `{"API_TOKEN":"abcdefghij"}` this matches
  // `_TOKEN":"abcdefghij"` — quote, colon, quote and all.
  { type: 'SECRET_ASSIGNMENT', pattern: /(?:_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIAL)\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi, jsonSafe: false },

  // Slack tokens
  { type: 'SLACK_TOKEN', pattern: /\bxox[bpas]-[a-zA-Z0-9-]{10,}\b/g, jsonSafe: true },

  // Heroku API key (require HEROKU prefix to avoid UUID false positives).
  // NOT json-safe: the match spans the `[=:]` and surrounding quotes.
  { type: 'HEROKU_KEY', pattern: /(?:HEROKU_API_KEY|heroku[_-]?api[_-]?key)\s*[=:]\s*['"]?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}['"]?/gi, jsonSafe: false },

  // Twilio
  { type: 'TWILIO_KEY', pattern: /\bSK[a-f0-9]{32}\b/g, jsonSafe: true },

  // SendGrid
  { type: 'SENDGRID_KEY', pattern: /\bSG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{22,}\b/g, jsonSafe: true },
]

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

/**
 * Apply a subset of the pattern list to a string.
 *
 * Returns the INPUT STRING BY REFERENCE when nothing matched, so callers
 * can use `result.sanitized === input` as a cheap "was anything redacted"
 * check and skip allocating a rewritten copy of the surrounding object.
 */
function applyPatterns(
  input: string,
  patterns: readonly SecretPattern[],
): SanitizeResult {
  if (!input) {
    return { sanitized: input, redactedCount: 0, redactedTypes: [] }
  }

  let sanitized = input
  let redactedCount = 0
  const redactedTypes = new Set<string>()

  for (const { type, pattern } of patterns) {
    // Clone the regex so lastIndex resets
    const regex = new RegExp(pattern.source, pattern.flags)
    const matches = sanitized.match(regex)

    if (matches) {
      redactedCount += matches.length
      redactedTypes.add(type)
      sanitized = sanitized.replace(regex, `[REDACTED:${type}]`)
    }
  }

  return {
    sanitized,
    redactedCount,
    redactedTypes: Array.from(redactedTypes),
  }
}

/** Patterns whose match can never span a JSON structural boundary. */
const JSON_SAFE_PATTERNS: readonly SecretPattern[] =
  SECRET_PATTERNS.filter(p => p.jsonSafe)

/**
 * Sanitize free-form text by redacting secrets.
 *
 * @security Called by `shell` and `filesystem` on their results before
 * those results enter the message history, and by the kernel gateway on
 * already-parsed tool-call arguments. Use this whenever the text is NOT
 * a fragment of a JSON document — see `sanitizeJsonFragment` for that.
 *
 * @param output - Raw text
 * @returns Sanitized text with redaction metadata. `sanitized` is the
 *          input by reference when nothing was redacted.
 */
export function sanitizeOutput(output: string): SanitizeResult {
  return applyPatterns(output, SECRET_PATTERNS)
}

/**
 * Sanitize a fragment of a JSON document, preserving its structure.
 *
 * @security Applies only the patterns whose match can never contain `"`
 * or `\` (see `SecretPattern.jsonSafe`), and replaces it with
 * `[REDACTED:TYPE]`, which contains neither either. Both sides of the
 * substitution therefore live wholly inside one string value, and the
 * document still parses.
 *
 * Use this for streamed tool-call argument chunks, which arrive as
 * partial JSON and are reassembled and parsed downstream. The four
 * non-json-safe patterns are deliberately skipped here; they are applied
 * at the object level once the JSON has been parsed, where rewriting a
 * value can no longer break the document.
 *
 * @param fragment - A partial or complete JSON string
 * @returns Sanitized fragment with redaction metadata. `sanitized` is
 *          the input by reference when nothing was redacted.
 */
export function sanitizeJsonFragment(fragment: string): SanitizeResult {
  return applyPatterns(fragment, JSON_SAFE_PATTERNS)
}

/**
 * Deep-walk a parsed value, redacting secrets from every string in it.
 *
 * Returns the input BY REFERENCE when nothing changed, so a caller can
 * use `result === input` to skip rebuilding the enclosing object and to
 * leave untouched data byte-identical.
 *
 * Cycles are impossible for real input (these values come from
 * `JSON.parse`), but a `seen` set means a hand-built cyclic value
 * degrades to "left alone" rather than recursing forever.
 */
export function redactSecretsDeep(value: unknown): unknown {
  return walk(value, new WeakSet<object>())
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return sanitizeOutput(value).sanitized
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return value
  seen.add(value)

  if (Array.isArray(value)) {
    let changed = false
    const next = value.map(item => {
      const r = walk(item, seen)
      if (r !== item) changed = true
      return r
    })
    return changed ? next : value
  }

  let changed = false
  const next: Record<string, unknown> = {}
  for (const [k, item] of Object.entries(value as Record<string, unknown>)) {
    const r = walk(item, seen)
    if (r !== item) changed = true
    next[k] = r
  }
  return changed ? next : value
}

/**
 * Sanitize a complete tool-result string, preserving JSON structure.
 *
 * @security Tool results are not free text. Consumers parse several of
 * them and schema-validate the outcome, and the parse-failure path is
 * often a silent fallback — so a redaction that broke the JSON would
 * degrade behaviour with nothing in the logs. Running the plain
 * sanitizer over `{"a":"X_SECRET=abcdefghij","b":"keep me"}` yields
 * `{"a":"X[REDACTED:SECRET_ASSIGNMENT],"b":"keep me"}`, which no longer
 * parses.
 *
 * So: parse first when the content looks like JSON, redact the parsed
 * VALUES (full pattern set — structure is no longer at risk once
 * parsed), and re-serialize only when something actually changed.
 * Non-JSON content takes the plain sanitizer. Either way the input is
 * returned by reference when nothing matched, so a clean result keeps
 * its original formatting exactly.
 *
 * Unlike `sanitizeJsonFragment`, this expects a COMPLETE document — use
 * that one for streamed partial chunks.
 */
export function sanitizeToolResultText(text: string): string {
  if (!text) return text

  const trimmed = text.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text)
      const redacted = redactSecretsDeep(parsed)
      return redacted === parsed ? text : JSON.stringify(redacted)
    } catch {
      // Leading brace but not valid JSON — truncated by the size cap, or
      // prose that happens to start with one. No structure to protect.
    }
  }

  return sanitizeOutput(text).sanitized
}

/**
 * Check if a string contains any secret patterns WITHOUT redacting.
 * Useful for quick checks without the overhead of replacement.
 */
export function containsSecrets(text: string): boolean {
  for (const { pattern } of SECRET_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags)
    if (regex.test(text)) return true
  }
  return false
}
