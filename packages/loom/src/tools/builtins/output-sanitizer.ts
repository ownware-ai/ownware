/**
 * Output Sanitizer
 *
 * Redacts secrets from tool output BEFORE it goes back to the model.
 * Prevents the model from seeing API keys, private keys, connection
 * strings, and tokens — then leaking them in responses.
 *
 * @security Every tool result passes through this sanitizer.
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
}

/** @security Each pattern targets a specific credential format. */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  // AWS access keys (always 20 chars, start with AKIA or ASIA)
  { type: 'AWS_KEY', pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g },

  // AWS secret keys (40 chars base64-ish, often after = or : in config)
  { type: 'AWS_SECRET', pattern: /(?<=aws_secret_access_key\s*[=:]\s*)[A-Za-z0-9/+=]{40}\b/g },

  // OpenAI API keys
  { type: 'OPENAI_KEY', pattern: /\bsk-[a-zA-Z0-9]{20,}\b/g },

  // Anthropic API keys
  { type: 'ANTHROPIC_KEY', pattern: /\bsk-ant-[a-zA-Z0-9-]{20,}\b/g },

  // Google API keys
  { type: 'GOOGLE_KEY', pattern: /\bAIza[a-zA-Z0-9_-]{35}\b/g },

  // Google OAuth access tokens (ya29.<long>)
  { type: 'GOOGLE_OAUTH', pattern: /\bya29\.[a-zA-Z0-9_-]{20,}/g },

  // Hugging Face access tokens
  { type: 'HUGGINGFACE_TOKEN', pattern: /\bhf_[a-zA-Z0-9]{30,}\b/g },

  // Stripe keys
  { type: 'STRIPE_KEY', pattern: /\b[sp]k_(live|test)_[a-zA-Z0-9]{20,}\b/g },

  // GitHub tokens
  { type: 'GITHUB_TOKEN', pattern: /\b(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}\b/g },
  { type: 'GITHUB_PAT', pattern: /\bgithub_pat_[a-zA-Z0-9_]{22,}\b/g },

  // Private keys (PEM format)
  { type: 'PRIVATE_KEY', pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|ENCRYPTED\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|ENCRYPTED\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g },

  // Connection strings with passwords
  { type: 'CONNECTION_STRING', pattern: /(postgres|mysql|mongodb|redis|amqp|mssql):\/\/[^:\s]+:[^@\s]+@[^\s]+/g },

  // JWT tokens (three base64 sections)
  { type: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },

  // Bearer tokens in HTTP headers
  { type: 'BEARER_TOKEN', pattern: /\bBearer\s+[a-zA-Z0-9_.-]{20,}\b/g },

  // Generic secret assignments (key=value patterns)
  { type: 'SECRET_ASSIGNMENT', pattern: /(?:_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIAL)\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi },

  // Slack tokens
  { type: 'SLACK_TOKEN', pattern: /\bxox[bpas]-[a-zA-Z0-9-]{10,}\b/g },

  // Heroku API key (require HEROKU prefix to avoid UUID false positives)
  { type: 'HEROKU_KEY', pattern: /(?:HEROKU_API_KEY|heroku[_-]?api[_-]?key)\s*[=:]\s*['"]?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}['"]?/gi },

  // Twilio
  { type: 'TWILIO_KEY', pattern: /\bSK[a-f0-9]{32}\b/g },

  // SendGrid
  { type: 'SENDGRID_KEY', pattern: /\bSG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{22,}\b/g },
]

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

/**
 * Sanitize tool output by redacting secrets.
 *
 * @security Called on every tool result before it enters the message history.
 *
 * @param output - Raw tool output string
 * @returns Sanitized output with redaction metadata
 */
export function sanitizeOutput(output: string): SanitizeResult {
  if (!output) {
    return { sanitized: output, redactedCount: 0, redactedTypes: [] }
  }

  let sanitized = output
  let redactedCount = 0
  const redactedTypes = new Set<string>()

  for (const { type, pattern } of SECRET_PATTERNS) {
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
