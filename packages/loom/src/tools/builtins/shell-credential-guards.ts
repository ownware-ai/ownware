/**
 * Shell-specific credential guards.
 *
 * Three responsibilities, each used in shell_execute:
 *
 *   1. Command pre-execution scan: block commands that read .env /
 *      sensitive files OR that inline a known credential value.
 *   2. Subprocess env injection: merge vault credentials into the
 *      spawn() env map deterministically every time.
 *   3. Output redaction: scrub stdout/stderr so credential values never
 *      flow back into the model's context. Covers plaintext, base64,
 *      URL-encoded, AND sensitive `KEY=VALUE` lines (env/printenv
 *      output) — which is why simple string-replace isn't enough.
 *
 * All logic here is pure (no I/O, no child_process) so it's unit-testable
 * in isolation and reusable by other shell-flavoured tools (subagent
 * runners, custom bash tools) without duplicating redaction code.
 */

import type {
  CredentialValue,
  EnvCredentialEntry,
} from '../../credentials/types.js'
import { classifyEnvKey } from '../../credentials/patterns.js'

// ---------------------------------------------------------------------------
// 1. Command-string scans (block + inline-value detection)
// ---------------------------------------------------------------------------

/**
 * Verbs that, when combined with a `.env` target elsewhere in the command
 * string, flag the command as reading secret material. Using a verb-plus-
 * target heuristic (instead of one mega-regex per verb) handles every
 * flag / option shape — `head -n 5 .env`, `tr "\n" " " < .env`, shell
 * pipelines, heredocs — without a regex explosion.
 */
const ENV_FILE_READ_VERBS: readonly string[] = Object.freeze([
  'cat', 'less', 'more', 'head', 'tail', 'bat', 'xxd', 'od',
  'grep', 'sed', 'awk', 'cut', 'tr', 'perl', 'ruby', 'python',
])

/**
 * Matches a `.env` or `.env.<suffix>` path token anywhere in the command.
 * Anchored with `(?:^|[\s"'<>;&|])` so we do NOT match inside an
 * identifier like `my_envfile` or `src/env.ts` — the path must be
 * preceded by a token boundary shell-like character. The filename
 * itself is `.env` or `.env.<ext>`; a leading path prefix is allowed.
 */
const ENV_PATH_TOKEN_REGEX =
  /(?:^|[\s"'<>;&|(){}`])(?:[^\s"'<>;&|(){}`]+\/)?\.env(?:\.[A-Za-z0-9._-]+)?(?=$|[\s"'<>;&|(){}`])/

/**
 * Matches the POSIX `source` / `.` builtin invocation. `.` is a special
 * case — we only want the builtin, not a bare literal dot in the middle
 * of a command — so we require it be preceded by a statement boundary
 * (start, whitespace, shell operator) AND followed by whitespace then
 * a real token.
 */
const SOURCE_BUILTIN_REGEX =
  /(?:^|[\s"'<>;&|(){}`])(?:source|\.)\s+(?=[^\s;&|])/

/**
 * True if `command` reads or sources a `.env` / `.env.*` file.
 *
 * Heuristic: presence of a `.env` path token AND EITHER a read-like
 * verb OR a source-style invocation anywhere in the command. The model
 * of "command string as one potentially-piped shell line" matches how
 * `shell_execute` ultimately runs it through `/bin/sh -c`.
 *
 * False negatives here degrade gracefully — the redaction + env-injection
 * layers still prevent value leakage. This guard just catches obvious
 * reads upfront so the model gets a clean "use request_credential" error
 * instead of a redaction-scrubbed output it can't learn from.
 */
export function commandTargetsEnvFile(command: string): boolean {
  if (!ENV_PATH_TOKEN_REGEX.test(command)) return false
  // A .env token is present. Is there a verb that reads it?
  for (const verb of ENV_FILE_READ_VERBS) {
    // Word-boundary match so `head` doesn't match `forehead`.
    if (new RegExp(`\\b${verb}\\b`).test(command)) return true
  }
  if (SOURCE_BUILTIN_REGEX.test(command)) return true
  // export $(cat .env) / export $(< .env). `cat` is covered by the verb
  // list; a bare `<` input-redirect without a verb is unusual but still
  // reads the file — match the redirect shape.
  if (/<\s*(?:[^\s;&|]+\/)?\.env(?:\.[A-Za-z0-9._-]+)?\b/.test(command)) return true
  return false
}

/**
 * Minimum value length before we treat a credential value as
 * "inline-able" in a command string. Below this threshold, the chance
 * of incidental collision with normal shell text (e.g. a 2-char PIN)
 * is higher than the leak risk, and false-positive blocks would be a
 * DoS on the agent. Credentials shorter than this are a security issue
 * at storage time — they shouldn't be stored at all — and that's the
 * layer to complain about it.
 */
const INLINE_VALUE_MIN_LENGTH = 4

/**
 * If the command contains the raw value of any known credential, return
 * the matching credential for error-message context. Otherwise null.
 *
 * Why this exists: the agent should reference credentials via their env
 * variable (`curl -H "Authorization: Bearer $USER_JWT" ...`) so the
 * value only enters the child process env, never the command string.
 * An inline value means either (a) the agent reconstructed it somehow
 * (shouldn't be possible — it never received it), or (b) a custom tool
 * handed it back, or (c) the value travelled via a log line and the
 * redactor missed it. Any of those is a security signal worth blocking
 * and flagging.
 *
 * Iteration order is longest-value-first so we match the most specific
 * credential when two share a prefix (rare, but keeps tests deterministic).
 */
export function commandContainsInlineCredentialValue(
  command: string,
  values: readonly CredentialValue[],
): CredentialValue | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => b.value.length - a.value.length)
  for (const cv of sorted) {
    if (cv.value.length < INLINE_VALUE_MIN_LENGTH) continue
    if (command.includes(cv.value)) return cv
  }
  return null
}

// ---------------------------------------------------------------------------
// 2. Subprocess env injection
// ---------------------------------------------------------------------------

/**
 * Build the env map for a child process: start from process.env, merge
 * every env-placed credential's resolved value on top. Credentials win
 * on conflict — if the parent process happens to have a `DATABASE_URL`
 * AND the vault has one, the vault value is what the child sees.
 *
 * Missing values (resolveCredential returns null) are skipped. Missing
 * is not an error: the .env import path or the runtime HITL may not
 * have populated the vault yet, and the child process will fail with
 * its own "variable not set" error which the agent can then react to
 * by calling `request_credential`.
 */
export function buildSubprocessEnv(
  parentEnv: NodeJS.ProcessEnv,
  listEnvCredentials: () => readonly EnvCredentialEntry[],
  resolveCredential: (credentialId: string) => string | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv }
  for (const entry of listEnvCredentials()) {
    const value = resolveCredential(entry.credentialId)
    if (value !== null) {
      env[entry.variableName] = value
    }
  }
  return env
}

// ---------------------------------------------------------------------------
// 3. Output redaction
// ---------------------------------------------------------------------------

export interface RedactionResult {
  readonly redacted: string
  /** Count of distinct credentials that had at least one replacement. */
  readonly redactedCount: number
  /** Labels of redacted credentials — for SecurityRedact metadata. */
  readonly redactedLabels: readonly string[]
  /** Count of sensitive KEY=VALUE lines collapsed. */
  readonly envLineRedactionCount: number
}

/**
 * Base64 encoding on raw UTF-8 bytes of the value. Some tools log
 * credentials in base64 (auth headers, docker config) — we want the
 * encoded form redacted too, otherwise a `printenv | base64` pipe
 * leaks everything.
 */
function toBase64(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64')
}

/** Form-safe URL encoding — matches how browsers serialize form fields. */
function toUrlEncoded(value: string): string {
  return encodeURIComponent(value)
}

/** Minimum encoded length before we redact to avoid tiny collisions. */
const ENCODED_REDACTION_MIN_LENGTH = 6

/**
 * Replace every occurrence of each credential value (plain, base64, and
 * URL-encoded forms) with `***REDACTED::<label>***` in `output`.
 *
 * Longest-first iteration prevents a short value from shadowing a
 * longer one that contains it as a substring (unlikely but real).
 */
function redactKnownValues(
  output: string,
  values: readonly CredentialValue[],
): { redacted: string; redactedCount: number; redactedLabels: Set<string> } {
  const labels = new Set<string>()
  if (values.length === 0) {
    return { redacted: output, redactedCount: 0, redactedLabels: labels }
  }

  const sorted = [...values].sort((a, b) => b.value.length - a.value.length)
  let current = output
  let count = 0

  for (const cv of sorted) {
    if (cv.value.length < INLINE_VALUE_MIN_LENGTH) continue
    const replacement = `***REDACTED::${cv.label}***`
    let matched = false

    // Plain
    if (current.includes(cv.value)) {
      current = current.split(cv.value).join(replacement)
      matched = true
    }

    // Base64
    const b64 = toBase64(cv.value)
    if (b64.length >= ENCODED_REDACTION_MIN_LENGTH && current.includes(b64)) {
      current = current.split(b64).join(replacement)
      matched = true
    }

    // URL-encoded — only if it actually differs from the plain form
    // (for ASCII-only credentials encodeURIComponent may be a no-op).
    const urlEnc = toUrlEncoded(cv.value)
    if (
      urlEnc !== cv.value &&
      urlEnc.length >= ENCODED_REDACTION_MIN_LENGTH &&
      current.includes(urlEnc)
    ) {
      current = current.split(urlEnc).join(replacement)
      matched = true
    }

    if (matched) {
      count++
      labels.add(cv.label)
    }
  }

  return { redacted: current, redactedCount: count, redactedLabels: labels }
}

/**
 * Regex matching a single `KEY=value` line in `env` / `printenv` / `export -p`
 * style output. KEY uppercase conventional: starts with letter or `_`,
 * rest is letter/digit/`_`. Value captures up to the next newline.
 *
 * Anchored to a line boundary (after `\n` or start-of-string) so we
 * don't accidentally redact a `KEY=value` pair that appears mid-line
 * inside a JSON blob.
 */
const ENV_LINE_REGEX = /(^|\n)([A-Za-z_][A-Za-z0-9_]*)=([^\n]*)/g

/** Drop the value half of sensitive `KEY=value` lines in env-style output. */
function redactSensitiveEnvLines(output: string): { redacted: string; count: number } {
  let count = 0
  const redacted = output.replace(ENV_LINE_REGEX, (_match, lead: string, key: string, value: string) => {
    // If the value is already a REDACTED marker (from the value-matching
    // pass above), don't re-wrap or inflate the count. Also leave empty
    // values untouched — nothing to redact.
    if (value === '' || value.includes('***REDACTED::')) {
      return `${lead}${key}=${value}`
    }
    if (classifyEnvKey(key) === 'sensitive') {
      count++
      return `${lead}${key}=***REDACTED::SENSITIVE_ENV***`
    }
    return `${lead}${key}=${value}`
  })
  return { redacted, count }
}

/**
 * Run the full redaction pipeline over one output string.
 *
 * Order is load-bearing:
 *   1. Value-match first (plain + base64 + urlencoded). This catches
 *      every known credential wherever it appears — inside a JSON blob,
 *      inside a log line, inside a shell error message.
 *   2. Env-line redaction second. By this point any known value inside
 *      a `KEY=value` line is already replaced, so step 2 only hits
 *      `KEY=value` lines where the VALUE wasn't a known credential but
 *      the KEY looks sensitive (e.g. the user's own `printenv SOMETHING_SECRET`
 *      where the value isn't in the vault).
 */
export function redactShellOutput(
  output: string,
  values: readonly CredentialValue[],
): RedactionResult {
  const { redacted: step1, redactedCount, redactedLabels } = redactKnownValues(output, values)
  const { redacted: step2, count: envLineCount } = redactSensitiveEnvLines(step1)
  return {
    redacted: step2,
    redactedCount,
    redactedLabels: Array.from(redactedLabels),
    envLineRedactionCount: envLineCount,
  }
}
