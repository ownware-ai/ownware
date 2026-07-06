/**
 * Input Sanitizer
 *
 * Validates tool input from the model BEFORE execution.
 * Detects prompt injection attempts, path traversal, null bytes,
 * and oversized inputs that could DoS the system.
 *
 * @security The model may have been prompt-injected by user content
 * (documents, web pages, emails). This is the last defense before execution.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InputSanitizeResult {
  /** The sanitized input (with blocked fields removed) */
  readonly sanitized: Record<string, unknown>
  /** Whether the input was blocked entirely */
  readonly blocked: boolean
  /** Reason for blocking (if blocked) */
  readonly reason?: string
}

// ---------------------------------------------------------------------------
// Prompt injection patterns
// ---------------------------------------------------------------------------

/** @security Patterns indicating the model was prompt-injected. */
const INJECTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, reason: 'Prompt injection: ignore previous instructions' },
  { pattern: /ignore\s+(all\s+)?above\s+instructions/i, reason: 'Prompt injection: ignore above instructions' },
  { pattern: /you\s+are\s+now\s+a\s+different/i, reason: 'Prompt injection: role reassignment' },
  { pattern: /new\s+system\s*:\s*override/i, reason: 'Prompt injection: system override' },
  { pattern: /forget\s+(all\s+)?your\s+(previous\s+)?instructions/i, reason: 'Prompt injection: forget instructions' },
  { pattern: /disregard\s+(all\s+)?previous/i, reason: 'Prompt injection: disregard previous' },
  { pattern: /\[SYSTEM\]\s*:/i, reason: 'Prompt injection: fake system message' },
  { pattern: /<system>\s*override/i, reason: 'Prompt injection: XML system override' },
  { pattern: /\bDAN\s+mode\b/i, reason: 'Prompt injection: DAN mode' },
  { pattern: /jailbreak\s*:/i, reason: 'Prompt injection: jailbreak keyword' },
]

// ---------------------------------------------------------------------------
// Path traversal patterns
// ---------------------------------------------------------------------------

const TRAVERSAL_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\.\.[\/\\]/, reason: 'Path traversal: ../' },
  { pattern: /%2e%2e[%2f%5c]/i, reason: 'Path traversal: URL-encoded ../' },
  { pattern: /\.\.%252[fF]/, reason: 'Path traversal: double-encoded ../' },
  { pattern: /%252e%252e/i, reason: 'Path traversal: double-encoded ..' },
  { pattern: /\.\.[\/\\].*\.\.[\/\\]/, reason: 'Path traversal: multiple ../' },
]

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_INPUT_SIZE = 1_048_576 // 1MB
const MAX_STRING_LENGTH = 500_000 // 500KB per string field

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

/**
 * Sanitize tool input from the model.
 *
 * @security Checks for prompt injection, path traversal, null bytes, and size limits.
 *
 * @param toolName - The tool being called (for context-specific checks)
 * @param input - Raw input from the model
 * @returns Sanitized input or blocked result
 */
export function sanitizeInput(
  toolName: string,
  input: Record<string, unknown>,
): InputSanitizeResult {
  // Size check — prevent DoS via enormous inputs
  const serialized = JSON.stringify(input)
  if (serialized.length > MAX_INPUT_SIZE) {
    return {
      sanitized: {},
      blocked: true,
      reason: `Input exceeds maximum size (${Math.round(serialized.length / 1024)}KB > ${MAX_INPUT_SIZE / 1024}KB)`,
    }
  }

  // Check all string values in the input
  const issues: string[] = []
  const sanitized = deepSanitize(input, issues)

  if (issues.length > 0) {
    // For shell commands, block entirely on injection
    if (toolName.includes('shell') || toolName.includes('bash') || toolName.includes('execute')) {
      return { sanitized: {}, blocked: true, reason: issues[0] }
    }

    // For other tools, allow but record the issue
    return { sanitized, blocked: false, reason: issues.join('; ') }
  }

  return { sanitized: input, blocked: false }
}

// ---------------------------------------------------------------------------
// Deep sanitization
// ---------------------------------------------------------------------------

function deepSanitize(
  obj: Record<string, unknown>,
  issues: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = sanitizeString(value, issues)
    } else if (Array.isArray(value)) {
      result[key] = value.map(v =>
        typeof v === 'string' ? sanitizeString(v, issues) :
        typeof v === 'object' && v !== null ? deepSanitize(v as Record<string, unknown>, issues) : v,
      )
    } else if (typeof value === 'object' && value !== null) {
      result[key] = deepSanitize(value as Record<string, unknown>, issues)
    } else {
      result[key] = value
    }
  }

  return result
}

function sanitizeString(value: string, issues: string[]): string {
  // Length check
  if (value.length > MAX_STRING_LENGTH) {
    issues.push(`String exceeds maximum length (${value.length} > ${MAX_STRING_LENGTH})`)
    return value.slice(0, MAX_STRING_LENGTH)
  }

  // Null byte check
  if (value.includes('\x00') || value.includes('%00')) {
    issues.push('Null byte detected in input')
    return value.replace(/\x00/g, '').replace(/%00/g, '')
  }

  // Prompt injection check
  for (const { pattern, reason } of INJECTION_PATTERNS) {
    if (pattern.test(value)) {
      issues.push(reason)
    }
  }

  // Path traversal check
  for (const { pattern, reason } of TRAVERSAL_PATTERNS) {
    if (pattern.test(value)) {
      issues.push(reason)
    }
  }

  return value
}
