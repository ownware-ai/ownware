/**
 * Zone Security System — Zone Expansion Tracker
 *
 * Tracks user-approved zone escalations within a session.
 * When a user approves a tool that requires a higher zone,
 * the expansion is remembered so they're not asked again.
 *
 * Supports three scopes:
 * - 'once': consumed on first use, then removed
 * - 'session': lasts until session ends or reset
 * - 'tool-pattern': lasts for session, but only for matching tools
 *
 * @security Expansions are session-scoped (in-memory). They do NOT persist
 * to disk — every new session starts with zero expansions.
 */

import type { ZoneExpansion, ZoneLevel } from './types.js'

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/**
 * Match a tool name against a glob pattern.
 * Consistent with classifier.ts pattern matching.
 */
function matchesGlob(toolName: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (pattern === toolName) return true
  if (!pattern.includes('*')) return false

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regexStr = escaped.replace(/\*/g, '.*')
  try {
    return new RegExp(`^${regexStr}$`).test(toolName)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// ZoneExpansionTracker
// ---------------------------------------------------------------------------

export class ZoneExpansionTracker {
  private readonly expansions: ZoneExpansion[] = []

  /**
   * Record that a user approved a zone escalation.
   *
   * @param level - Zone level that was approved
   * @param toolPattern - Tool pattern that was approved ('*' for all)
   * @param scope - How long the approval lasts
   * @param ttlMs - Time-to-live in ms (null = session lifetime)
   */
  grant(opts: {
    readonly level: ZoneLevel
    readonly toolPattern: string
    readonly scope: 'once' | 'session' | 'tool-pattern'
    readonly ttlMs?: number | null
  }): void {
    const now = Date.now()
    this.expansions.push({
      level: opts.level,
      toolPattern: opts.toolPattern,
      grantedAt: now,
      expiresAt: opts.ttlMs != null ? now + opts.ttlMs : null,
      scope: opts.scope,
    })
  }

  /**
   * Check if there's an active expansion covering this tool + zone level.
   *
   * @param toolName - Tool being invoked
   * @param level - Zone level required
   * @returns true if an expansion covers this tool at this level
   */
  check(toolName: string, level: ZoneLevel): boolean {
    this.prune()

    for (let i = this.expansions.length - 1; i >= 0; i--) {
      const exp = this.expansions[i]!

      // Must cover the requested zone level
      if (exp.level < level) continue

      // Must match the tool pattern
      if (!matchesGlob(toolName, exp.toolPattern)) continue

      // 'once' scope — consume it
      if (exp.scope === 'once') {
        this.expansions.splice(i, 1)
        return true
      }

      return true
    }

    return false
  }

  /**
   * Get the effective maximum auto-zone considering all active wildcard expansions.
   *
   * Only considers expansions with pattern '*' (all tools).
   * For specific tool patterns, use check() instead.
   */
  effectiveMaxAutoZone(baseMax: ZoneLevel): ZoneLevel {
    this.prune()

    let max = baseMax
    for (const exp of this.expansions) {
      if (exp.toolPattern === '*' && exp.level > max) {
        max = exp.level
      }
    }
    return max
  }

  /** Get all active (non-expired) expansions. */
  getActive(): readonly ZoneExpansion[] {
    this.prune()
    return [...this.expansions]
  }

  /** Remove expired expansions. */
  prune(): void {
    const now = Date.now()
    for (let i = this.expansions.length - 1; i >= 0; i--) {
      const exp = this.expansions[i]!
      if (exp.expiresAt !== null && exp.expiresAt <= now) {
        this.expansions.splice(i, 1)
      }
    }
  }

  /** Clear all expansions. */
  clear(): void {
    this.expansions.length = 0
  }

  /**
   * Remove every expansion whose `toolPattern` matches `toolPattern`
   * exactly. Returns `true` if at least one expansion was removed.
   *
   * Used by the inverse of `grant()` when the user revokes a saved
   * "Always allow" rule on disk: cortex iterates live ZoneManagers
   * and calls `revoke(rule.toolPattern)` so the in-memory expansion
   * pre-populated at session start (or granted in-turn) stops
   * upgrading 'ask' to 'allow' immediately, not at session end.
   */
  revoke(toolPattern: string): boolean {
    let removed = false
    for (let i = this.expansions.length - 1; i >= 0; i--) {
      if (this.expansions[i]!.toolPattern === toolPattern) {
        this.expansions.splice(i, 1)
        removed = true
      }
    }
    return removed
  }

  /** Number of active expansions. */
  get size(): number {
    this.prune()
    return this.expansions.length
  }
}
