/**
 * Permission Evaluator
 *
 * Evaluates tool calls against permission rules and safety checks.
 * First-match-wins rule evaluation with glob pattern support.
 */

import type {
  PermissionMode,
  PermissionRule,
  PolicyDecision,
  SafetyRule,
  SecurityContext,
} from './types.js'
import { BUILT_IN_SAFETY_RULES } from './rules.js'
import { SessionPermissionStore } from './session-store.js'

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export class PermissionEvaluator {
  private rules: PermissionRule[]
  private safetyRules: SafetyRule[]
  private sessionStore: SessionPermissionStore

  constructor(opts?: {
    rules?: PermissionRule[]
    safetyRules?: SafetyRule[]
    sessionStore?: SessionPermissionStore
  }) {
    this.rules = opts?.rules ?? []
    this.safetyRules = opts?.safetyRules ?? BUILT_IN_SAFETY_RULES
    this.sessionStore = opts?.sessionStore ?? new SessionPermissionStore()
  }

  /**
   * Evaluate whether a tool call should be allowed, denied, or requires approval.
   *
   * Evaluation order:
   * 1. Safety rules (built-in, always checked first)
   * 2. Session-remembered decisions
   * 3. User-defined permission rules (first match wins)
   * 4. Default policy based on permission mode
   *
   * @param toolName - The tool being invoked
   * @param input - The tool's input parameters
   * @param context - Security context for the evaluation
   */
  evaluate(
    toolName: string,
    input: Record<string, unknown>,
    context: SecurityContext,
  ): PolicyDecision {
    // 1. Safety rules — configured policy always runs before the mode
    //    fallback. Loom supplies no opinionated rules by default; when a
    //    host does provide them, `auto` cannot erase that policy.
    for (const rule of this.safetyRules) {
      const decision = rule(toolName, input)
      if (decision !== null) {
        return decision
      }
    }

    // 2. Session-remembered decisions (e.g., "always allow X this session")
    const remembered = this.sessionStore.check(toolName)
    if (remembered !== null) {
      return remembered
    }

    // 3. User-defined rules — first match wins
    for (const rule of this.rules) {
      if (matchesGlob(toolName, rule.pattern)) {
        return rule.decision
      }
    }

    // 4. Default policy based on mode
    return defaultForMode(context.mode)
  }

  /**
   * Remember a permission decision for the rest of this session.
   * Used for "always allow/deny X this session" patterns.
   */
  remember(toolName: string, decision: PolicyDecision): void {
    this.sessionStore.remember(toolName, decision)
  }

  /** Add a user-defined rule. */
  addRule(rule: PermissionRule): void {
    this.rules.push(rule)
  }

  /** Remove rules matching a pattern. */
  removeRule(pattern: string): void {
    this.rules = this.rules.filter(r => r.pattern !== pattern)
  }

  /** Replace all user-defined rules. */
  setRules(rules: PermissionRule[]): void {
    this.rules = [...rules]
  }

  /** Get the current rules (read-only). */
  getRules(): readonly PermissionRule[] {
    return this.rules
  }

  /** Clear session-remembered decisions. */
  clearSession(): void {
    this.sessionStore.clear()
  }
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Match a tool name against a glob pattern.
 *
 * Supported syntax:
 * - '*' matches any sequence of characters within a segment
 * - '**' matches any sequence of characters across segments
 * - '.' separates segments (e.g., "filesystem.readFile")
 * - Exact match for literal patterns
 *
 * Examples:
 * - "filesystem.*" matches "filesystem.readFile", "filesystem.writeFile"
 * - "*.read*" matches "filesystem.readFile", "search.readIndex"
 * - "shell" matches only "shell"
 */
function matchesGlob(toolName: string, pattern: string): boolean {
  // Exact match fast path
  if (pattern === toolName) return true
  if (pattern === '*') return true

  // Convert glob to regex
  const regexStr = pattern
    .replace(/\./g, '\\.')       // Escape dots
    .replace(/\*\*/g, '@@GLOB_STAR@@')  // Protect **
    .replace(/\*/g, '[^.]*')    // * matches within segment
    .replace(/@@GLOB_STAR@@/g, '.*')    // ** matches across segments

  const regex = new RegExp(`^${regexStr}$`)
  return regex.test(toolName)
}

// ---------------------------------------------------------------------------
// Default policies
// ---------------------------------------------------------------------------

/**
 * Return the default decision for a given permission mode.
 *
 * Post-redesign (2026-05-14): the policy layer cannot deny. Both the
 * deprecated 'deny' mode and the 'allowlist' mode fall through to
 * 'ask' — the user is always the final arbiter when no explicit
 * allow rule fires.
 */
function defaultForMode(mode: PermissionMode): PolicyDecision {
  switch (mode) {
    case 'auto': return 'allow'
    case 'ask': return 'ask'
    case 'deny': return 'ask'
    case 'allowlist': return 'ask'
  }
}
