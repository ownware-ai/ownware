/**
 * Unit Tests — Output Sanitizer
 *
 * Tests that every secret type is redacted and normal output is unchanged.
 */

import { describe, it, expect } from 'vitest'
import { sanitizeOutput, containsSecrets } from '../../../tools/builtins/output-sanitizer.js'

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

describe('sanitizeOutput()', () => {
  it('redacts AWS access key', () => {
    const { sanitized, redactedCount, redactedTypes } = sanitizeOutput(
      'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    )
    expect(sanitized).toContain('[REDACTED:AWS_KEY]')
    expect(sanitized).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(redactedCount).toBe(1)
    expect(redactedTypes).toContain('AWS_KEY')
  })

  it('redacts OpenAI API key', () => {
    const { sanitized } = sanitizeOutput('sk-1234567890abcdefghijklmnopqrst')
    expect(sanitized).toContain('[REDACTED:OPENAI_KEY]')
  })

  it('redacts Anthropic API key', () => {
    const { sanitized } = sanitizeOutput('sk-ant-api03-1234567890abcdefghijklmnopqrst')
    expect(sanitized).toContain('[REDACTED:ANTHROPIC_KEY]')
  })

  it('redacts Google API key', () => {
    // Google API keys are exactly AIza + 35 chars
    // AIza + exactly 35 alphanumeric/dash/underscore chars = 39 total
    const { sanitized } = sanitizeOutput('AIzaSyA-1234567890abcdefghijklmnopqrstu')
    expect(sanitized).toContain('[REDACTED:GOOGLE_KEY]')
  })

  it('redacts Google OAuth access token (ya29.)', () => {
    const { sanitized } = sanitizeOutput('curl -H "Authorization: ya29.a0Ae4lvC1234567890abcdefghijklmnop"')
    expect(sanitized).toContain('[REDACTED:GOOGLE_OAUTH]')
    expect(sanitized).not.toContain('a0Ae4lvC')
  })

  it('redacts Hugging Face token (hf_)', () => {
    const { sanitized } = sanitizeOutput('hf_' + 'a'.repeat(34))
    expect(sanitized).toContain('[REDACTED:HUGGINGFACE_TOKEN]')
  })

  it('redacts Stripe live key', () => {
    // Use sk_test_ prefix to avoid GitHub push protection blocking fake sk_live_ keys
    const { sanitized } = sanitizeOutput('sk_test_FAKE1234567890abcdefghijklmnop')
    expect(sanitized).toContain('[REDACTED:STRIPE_KEY]')
  })

  it('redacts GitHub PAT (ghp_)', () => {
    const { sanitized } = sanitizeOutput('ghp_' + 'a'.repeat(36))
    expect(sanitized).toContain('[REDACTED:GITHUB_TOKEN]')
  })

  it('redacts GitHub OAuth (gho_)', () => {
    const { sanitized } = sanitizeOutput('gho_' + 'b'.repeat(36))
    expect(sanitized).toContain('[REDACTED:GITHUB_TOKEN]')
  })

  it('redacts github_pat_ token', () => {
    const { sanitized } = sanitizeOutput('github_pat_' + 'c'.repeat(22))
    expect(sanitized).toContain('[REDACTED:GITHUB_PAT]')
  })

  it('redacts RSA private key', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----'
    const { sanitized } = sanitizeOutput(key)
    expect(sanitized).toContain('[REDACTED:PRIVATE_KEY]')
    expect(sanitized).not.toContain('MIIE')
  })

  it('redacts EC private key', () => {
    const key = '-----BEGIN EC PRIVATE KEY-----\nMHQC...\n-----END EC PRIVATE KEY-----'
    const { sanitized } = sanitizeOutput(key)
    expect(sanitized).toContain('[REDACTED:PRIVATE_KEY]')
  })

  it('redacts postgres connection string', () => {
    const { sanitized } = sanitizeOutput('postgres://user:password123@localhost:5432/mydb')
    expect(sanitized).toContain('[REDACTED:CONNECTION_STRING]')
    expect(sanitized).not.toContain('password123')
  })

  it('redacts mongodb connection string', () => {
    const { sanitized } = sanitizeOutput('mongodb://admin:secret@mongo.host:27017/db')
    expect(sanitized).toContain('[REDACTED:CONNECTION_STRING]')
  })

  it('redacts JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    const { sanitized } = sanitizeOutput(`Token: ${jwt}`)
    expect(sanitized).toContain('[REDACTED:JWT]')
  })

  it('redacts Bearer tokens', () => {
    const { sanitized } = sanitizeOutput('Authorization: Bearer abc123def456ghi789jkl012mno')
    expect(sanitized).toContain('[REDACTED:BEARER_TOKEN]')
  })

  it('redacts Slack tokens', () => {
    const { sanitized } = sanitizeOutput('xoxb-123456789-abcdefghij')
    expect(sanitized).toContain('[REDACTED:SLACK_TOKEN]')
  })

  it('redacts secret assignments', () => {
    const { sanitized } = sanitizeOutput('DATABASE_PASSWORD="supersecret123"')
    expect(sanitized).toContain('[REDACTED:SECRET_ASSIGNMENT]')
  })

  // ---------------------------------------------------------------------------
  // Multiple secrets
  // ---------------------------------------------------------------------------

  it('redacts multiple secrets in one output', () => {
    const output = [
      'AWS key: AKIAIOSFODNN7EXAMPLE',
      'OpenAI: sk-1234567890abcdefghijklmnopqrst',
      'Normal text here',
    ].join('\n')

    const { sanitized, redactedCount } = sanitizeOutput(output)
    expect(sanitized).toContain('[REDACTED:AWS_KEY]')
    expect(sanitized).toContain('[REDACTED')
    expect(sanitized).toContain('Normal text here')
    expect(redactedCount).toBeGreaterThanOrEqual(2)
  })

  // ---------------------------------------------------------------------------
  // Normal output unchanged
  // ---------------------------------------------------------------------------

  it('does not redact normal text', () => {
    const output = 'Hello world! This is normal output.'
    const { sanitized, redactedCount } = sanitizeOutput(output)
    expect(sanitized).toBe(output)
    expect(redactedCount).toBe(0)
  })

  it('does not redact code', () => {
    const output = 'const x = 42;\nfunction add(a, b) { return a + b; }'
    const { sanitized } = sanitizeOutput(output)
    expect(sanitized).toBe(output)
  })

  it('does not redact short strings that look like key prefixes', () => {
    const output = 'sk-short'
    const { sanitized, redactedCount } = sanitizeOutput(output)
    expect(sanitized).toBe(output)
    expect(redactedCount).toBe(0)
  })

  it('handles empty string', () => {
    const { sanitized, redactedCount } = sanitizeOutput('')
    expect(sanitized).toBe('')
    expect(redactedCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// containsSecrets()
// ---------------------------------------------------------------------------

describe('containsSecrets()', () => {
  it('returns true for AWS key', () => {
    expect(containsSecrets('AKIAIOSFODNN7EXAMPLE')).toBe(true)
  })

  it('returns false for normal text', () => {
    expect(containsSecrets('just normal text')).toBe(false)
  })
})
