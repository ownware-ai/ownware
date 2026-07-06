/**
 * Tool Policy
 *
 * Controls which tools are allowed or denied. Supports:
 * - Exact name matching: "readFile"
 * - Wildcard patterns: "filesystem.*", "shell.*"
 * - Category-based rules: allow all "filesystem" category tools
 *
 * Deny rules take precedence over allow rules.
 */

import type { Tool, ToolCategory } from './types.js'

// ---------------------------------------------------------------------------
// Policy rule types
// ---------------------------------------------------------------------------

export interface PolicyRule {
  /** Pattern to match against tool name (supports * wildcard) */
  readonly pattern: string
  /** Whether this rule allows or denies */
  readonly action: 'allow' | 'deny'
}

export interface CategoryRule {
  /** Tool category to match */
  readonly category: ToolCategory
  /** Whether this rule allows or denies */
  readonly action: 'allow' | 'deny'
}

export interface ToolPolicyConfig {
  /** Default behavior when no rule matches */
  readonly defaultAction: 'allow' | 'deny'
  /** Name-pattern rules */
  readonly rules: PolicyRule[]
  /** Category-based rules */
  readonly categoryRules: CategoryRule[]
}

// ---------------------------------------------------------------------------
// ToolPolicy
// ---------------------------------------------------------------------------

export class ToolPolicy {
  private readonly config: ToolPolicyConfig

  constructor(config: Partial<ToolPolicyConfig> = {}) {
    this.config = {
      defaultAction: config.defaultAction ?? 'allow',
      rules: config.rules ?? [],
      categoryRules: config.categoryRules ?? [],
    }
  }

  /**
   * Check if a tool is allowed by this policy.
   * Deny rules always take precedence over allow rules.
   */
  isAllowed(toolName: string, category?: ToolCategory): boolean {
    // Check deny rules first — any match means denied
    for (const rule of this.config.rules) {
      if (rule.action === 'deny' && matchPattern(rule.pattern, toolName)) {
        return false
      }
    }
    for (const rule of this.config.categoryRules) {
      if (
        rule.action === 'deny' &&
        category != null &&
        rule.category === category
      ) {
        return false
      }
    }

    // Check allow rules — any match means allowed
    for (const rule of this.config.rules) {
      if (rule.action === 'allow' && matchPattern(rule.pattern, toolName)) {
        return true
      }
    }
    for (const rule of this.config.categoryRules) {
      if (
        rule.action === 'allow' &&
        category != null &&
        rule.category === category
      ) {
        return true
      }
    }

    return this.config.defaultAction === 'allow'
  }

  /**
   * Check if a Tool instance is allowed.
   */
  isToolAllowed(tool: Tool): boolean {
    return this.isAllowed(tool.name, tool.category)
  }

  /**
   * Filter a list of tools, returning only allowed ones.
   */
  filterAllowed(tools: Tool[]): Tool[] {
    return tools.filter((t) => this.isToolAllowed(t))
  }

  // ── Static factories ──────────────────────────────────────────────

  /**
   * Create a policy that allows only the specified tools.
   */
  static allowOnly(...patterns: string[]): ToolPolicy {
    return new ToolPolicy({
      defaultAction: 'deny',
      rules: patterns.map((pattern) => ({ pattern, action: 'allow' as const })),
    })
  }

  /**
   * Create a policy that denies only the specified tools.
   */
  static denyOnly(...patterns: string[]): ToolPolicy {
    return new ToolPolicy({
      defaultAction: 'allow',
      rules: patterns.map((pattern) => ({ pattern, action: 'deny' as const })),
    })
  }

  /**
   * Create a permissive policy that allows everything.
   */
  static allowAll(): ToolPolicy {
    return new ToolPolicy({ defaultAction: 'allow' })
  }
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/**
 * Match a tool name against a pattern with wildcard support.
 *
 * Patterns:
 * - "readFile" — exact match
 * - "filesystem.*" — matches "filesystem.readFile", "filesystem.writeFile"
 * - "*" — matches everything
 * - "*.read*" — matches "filesystem.readFile", "shell.readLink"
 */
function matchPattern(pattern: string, name: string): boolean {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === name

  // Convert glob pattern to regex
  const regexStr =
    '^' +
    pattern
      .split('*')
      .map(escapeRegex)
      .join('.*') +
    '$'

  return new RegExp(regexStr).test(name)
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
