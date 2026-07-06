/**
 * Credential Classification Patterns
 *
 * Single source of truth for two adjacent classification decisions:
 *
 *   1. Env-var key classification — given `KEY` from a `KEY=value` line,
 *      is it a secret (redact the value from shell output, store the
 *      value in the vault at .env import time) or a plain config
 *      (leave the value visible, inject into the system prompt)?
 *   2. Filesystem blocked-path check — given an absolute path, is it
 *      one of the secret-material files the agent must never read?
 *
 * Both lists are public because Cortex reuses the env classifier for
 * `.env` auto-import and a future connector may add to the blocked-file
 * list when shipping new kinds of credential stores (terraform.tfvars,
 * docker-compose env sections, ansible vaults, …).
 *
 * **Safe default**: an unknown env key classifies as SENSITIVE. Adding
 * a new ambiguous key to a user's .env without us knowing should err
 * toward hiding the value, not leaking it.
 */

// ---------------------------------------------------------------------------
// Env key patterns — substring match, case-insensitive on the upper-cased key
// ---------------------------------------------------------------------------

/**
 * Substring patterns that flag an env var key as secret-bearing. If the
 * upper-cased key contains ANY of these, the value is treated as sensitive.
 *
 * Ordering is irrelevant — `classifyEnvKey` returns the first match, but
 * any match produces the same `sensitive` verdict. Keep the list
 * alphabetically grouped so adds are easy to audit.
 */
export const SENSITIVE_KEY_PATTERNS: readonly string[] = Object.freeze([
  // Cloud / vendor
  'AWS_SECRET',
  'ANTHROPIC',
  'OPENAI',
  'SENDGRID',
  'STRIPE',
  'TWILIO',
  // Auth material
  'AUTH',
  'CREDENTIAL',
  'KEY',
  'PASS',
  'PASSWORD',
  'SECRET',
  'TOKEN',
  // Connection strings
  'CONNECTION_STRING',
  'DATABASE_URL',
  'DSN',
  'MONGO_URI',
  'REDIS_URL',
  'SMTP',
  // Crypto primitives
  'CERTIFICATE',
  'ENCRYPTION',
  'GPG',
  'HASH',
  'MASTER',
  'PEM',
  'PRIVATE',
  'RSA',
  'SALT',
  'SIGNING',
  'SSH',
  // Generic forms
  'ACCESS_KEY',
  'API_KEY',
  'WEBHOOK',
])

/**
 * Substring patterns that flag an env var key as plain config. Matches
 * here ONLY take effect when no SENSITIVE pattern matched — sensitivity
 * wins on conflict (e.g. a made-up `HOST_API_KEY` is secret, not safe,
 * because `KEY` > `HOST`).
 */
export const SAFE_KEY_PATTERNS: readonly string[] = Object.freeze([
  'APP_NAME',
  'DEBUG',
  'DISPLAY',
  'EDITOR',
  'HOME',
  'HOST',
  'HOSTNAME',
  'LANG',
  'LOG_LEVEL',
  'NODE_ENV',
  'PATH',
  'PORT',
  'REGION',
  'SHELL',
  'TERM',
  'TZ',
])

export type EnvKeyClassification = 'sensitive' | 'safe' | 'unknown'

/**
 * Classify an environment-variable key as sensitive, safe, or unknown.
 *
 * The comparison is case-insensitive and uses substring matching on the
 * upper-cased key. Sensitive wins on conflict. Unknown means "we have no
 * opinion"; callers (.env classifier, shell redactor) should treat it
 * as sensitive under the secure-default rule.
 */
export function classifyEnvKey(key: string): EnvKeyClassification {
  const upper = key.toUpperCase()
  for (const pattern of SENSITIVE_KEY_PATTERNS) {
    if (upper.includes(pattern)) return 'sensitive'
  }
  for (const pattern of SAFE_KEY_PATTERNS) {
    if (upper.includes(pattern)) return 'safe'
  }
  return 'unknown'
}

/**
 * Treat an unknown key as sensitive. Convenience used by consumers that
 * want the secure-default rule baked in without re-implementing it.
 */
export function isSensitiveEnvKey(key: string): boolean {
  return classifyEnvKey(key) !== 'safe'
}

// ---------------------------------------------------------------------------
// Blocked file paths — regex match against the resolved absolute path
// ---------------------------------------------------------------------------

/**
 * Paths the agent MUST NOT read. Each regex is tested against the
 * resolved absolute path (after symlink resolution). HARD BLOCK — no
 * permission option — the credential vault is the only secret surface
 * the runtime hands to tools.
 *
 * Adding a new pattern is a one-line change; the consumer APIs
 * (`isBlockedFilePath`, `filterBlockedPaths`) pick it up automatically.
 *
 * Not-blocked by design (callers should not false-positive these):
 *   - package.json, tsconfig.json
 *   - src/env.ts, .env.d.ts, src/config/*.ts
 *   - env.example, env.example.md
 */
export const BLOCKED_FILE_PATTERNS: readonly RegExp[] = Object.freeze([
  // dotenv family — .env, .env.local, .env.production, etc.
  // Anchor to a path separator or start-of-string so "src/env.ts" does
  // NOT match (basename "env.ts" has no leading dot).
  /(?:^|\/)\.env$/,
  /(?:^|\/)\.env\.[a-zA-Z0-9._-]+$/,
  // "*.env" — a file literally named something.env (not .env.ext)
  /(?:^|\/)[^/]+\.env$/,

  // TLS / certificate / key material
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\.jks$/,

  // SSH private keys
  /(?:^|\/)id_rsa(?:\.pub)?$/,
  /(?:^|\/)id_ed25519(?:\.pub)?$/,
  /(?:^|\/)id_ecdsa(?:\.pub)?$/,
  /(?:^|\/)id_dsa(?:\.pub)?$/,

  // Credential blobs
  /(?:^|\/)credentials\.json$/,
  /(?:^|\/)secrets\.json$/,
  /(?:^|\/)\.credentials(?:$|\/)/,
  /(?:^|\/)\.secrets(?:$|\/)/,

  // Tool-specific secret stores
  /(?:^|\/)\.netrc$/,
  /(?:^|\/)\.npmrc$/,
  /(?:^|\/)\.pgpass$/,
  /(?:^|\/)\.my\.cnf$/,

  // GPG
  /(?:^|\/)\.gnupg(?:$|\/)/,
])

/** Pre-built glob patterns for ripgrep / similar tools to exclude. */
export const BLOCKED_FILE_GLOBS: readonly string[] = Object.freeze([
  '!.env',
  '!.env.*',
  '!*.env',
  '!*.pem',
  '!*.key',
  '!*.p12',
  '!*.pfx',
  '!*.jks',
  '!id_rsa',
  '!id_rsa.pub',
  '!id_ed25519',
  '!id_ed25519.pub',
  '!id_ecdsa',
  '!id_ecdsa.pub',
  '!id_dsa',
  '!id_dsa.pub',
  '!credentials.json',
  '!secrets.json',
  '!.credentials/',
  '!.secrets/',
  '!.netrc',
  '!.npmrc',
  '!.pgpass',
  '!.my.cnf',
  '!.gnupg/',
])

/**
 * Explicit allow-list for paths that LOOK like they'd hit a blocked
 * pattern but are safe in practice. Narrow by design — each entry is a
 * known false-positive class.
 *
 *   - `.env.d.ts`: the dotenv-style TS declaration file; it documents
 *     types, never carries values. Blocking it would stop agents from
 *     reading env-typing without actually protecting anything.
 */
const BLOCKED_PATH_ALLOW_LIST: readonly RegExp[] = Object.freeze([
  /\.env\.d\.ts$/,
])

/** True if the resolved absolute path matches any blocked pattern. */
export function isBlockedFilePath(absolutePath: string): boolean {
  for (const allow of BLOCKED_PATH_ALLOW_LIST) {
    if (allow.test(absolutePath)) return false
  }
  for (const pattern of BLOCKED_FILE_PATTERNS) {
    if (pattern.test(absolutePath)) return true
  }
  return false
}

/** Drop every path from a list that `isBlockedFilePath` flags. */
export function filterBlockedPaths(paths: readonly string[]): string[] {
  return paths.filter(p => !isBlockedFilePath(p))
}

/**
 * Human-readable error message every blocked-file error surfaces so tools
 * give the same phrasing everywhere. The message actively guides the
 * agent toward the correct primitive (`request_credential`) instead of
 * leaving it guessing.
 */
export const BLOCKED_FILE_ERROR_MESSAGE =
  "Access denied: .env and secret files are managed by the credential vault. " +
  "Credentials are automatically injected as environment variables into shell " +
  "commands. If you need a new credential, use the request_credential tool."
