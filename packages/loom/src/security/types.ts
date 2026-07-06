/**
 * Security Module Types
 *
 * Defines security levels, configurations, and audit types for
 * Loom's engine-level security guardrails.
 */

// ---------------------------------------------------------------------------
// Security levels
// ---------------------------------------------------------------------------

/**
 * Security level presets that control how strict the engine is.
 *
 * - 'permissive': Minimal checks. For sandboxed/isolated environments.
 * - 'standard': Balanced. Good for coding agents. Default.
 * - 'strict': Blocks most dangerous patterns. For enterprise.
 * - 'paranoid': Maximum security. For legal/finance/healthcare.
 */
export type SecurityLevel = 'permissive' | 'standard' | 'strict' | 'paranoid'

// ---------------------------------------------------------------------------
// Security configuration
// ---------------------------------------------------------------------------

export interface SecurityConfig {
  /** Security level preset */
  readonly level: SecurityLevel
  /** Additional patterns to block (on top of level defaults) */
  readonly customBlocklist?: readonly RegExp[]
  /** Command prefixes that bypass validation */
  readonly customAllowlist?: readonly string[]
  /** Enable audit logging */
  readonly auditEnabled: boolean
  /** Sanitize tool output (redact secrets) */
  readonly sanitizeOutput: boolean
  /** Sanitize tool input (detect injection) */
  readonly sanitizeInput: boolean
  /** Maximum command length in characters */
  readonly maxCommandLength: number
  /** Maximum tool output size in characters */
  readonly maxOutputSize: number
}

// ---------------------------------------------------------------------------
// Audit types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  /** ISO timestamp */
  readonly timestamp: string
  /** Tool that was called */
  readonly toolName: string
  /** Sanitized input (secrets removed) */
  readonly input: Record<string, unknown>
  /** Validation result */
  readonly validation: {
    readonly level: string
    readonly reason?: string
  }
  /**
   * Final decision: 'allow' or 'ask'. The legacy 'deny' value is
   * retained in the union so existing on-disk audit logs (pre-2026-05-14
   * redesign) keep loading; new entries are never written with 'deny'.
   */
  readonly decision: 'allow' | 'ask' | 'deny'
  /** Sanitized output summary */
  readonly outputSummary?: string
  /** Execution duration in ms */
  readonly durationMs?: number
  /** Agent ID if from sub-agent */
  readonly agentId?: string
  /** Session ID */
  readonly sessionId?: string
}

// ---------------------------------------------------------------------------
// Default configs per level
// ---------------------------------------------------------------------------

export const SECURITY_CONFIGS: Record<SecurityLevel, SecurityConfig> = {
  permissive: {
    level: 'permissive',
    auditEnabled: false,
    sanitizeOutput: false,
    sanitizeInput: false,
    maxCommandLength: 500_000,
    maxOutputSize: 10_000_000,
  },
  standard: {
    level: 'standard',
    auditEnabled: true,
    sanitizeOutput: true,
    sanitizeInput: true,
    maxCommandLength: 100_000,
    maxOutputSize: 1_000_000,
  },
  strict: {
    level: 'strict',
    auditEnabled: true,
    sanitizeOutput: true,
    sanitizeInput: true,
    maxCommandLength: 50_000,
    maxOutputSize: 500_000,
  },
  paranoid: {
    level: 'paranoid',
    auditEnabled: true,
    sanitizeOutput: true,
    sanitizeInput: true,
    maxCommandLength: 10_000,
    maxOutputSize: 100_000,
  },
}
