/**
 * Zone Security System — Zone Manager
 *
 * Central orchestrator that ties classification, policy, combination
 * detection, expansion tracking, and explanation generation together.
 *
 * The key method is `asSafetyRule()` which returns a SafetyRule function
 * compatible with Loom's PermissionEvaluator. This is how zones plug into
 * the existing permission pipeline with zero changes to loop.ts or session.ts.
 *
 * @security This is the integration point between zones and the Loom engine.
 */

import type { PolicyDecision, SafetyRule } from '../permissions/types.js'
import type { AuditLog } from '../security/audit.js'
import type {
  ZoneConfig,
  ZoneContext,
  ZoneDecision,
  ZoneExpansion,
} from './types.js'
import { ZoneLevel } from './types.js'
import { classifyToolCall } from './classifier.js'
import { evaluateZonePolicy } from './policy.js'
import { CombinationTracker } from './combinations.js'
import { ZoneExpansionTracker } from './expansion.js'
import { explainZoneDecision } from './explainer.js'

// ---------------------------------------------------------------------------
// ZoneManager
// ---------------------------------------------------------------------------

export class ZoneManager {
  private readonly config: ZoneConfig
  private readonly combinations: CombinationTracker
  private readonly expansions: ZoneExpansionTracker
  private readonly auditLog?: AuditLog

  constructor(
    config: ZoneConfig,
    opts?: {
      readonly auditLog?: AuditLog
    },
  ) {
    this.config = config
    this.combinations = new CombinationTracker()
    this.expansions = new ZoneExpansionTracker()
    this.auditLog = opts?.auditLog
  }

  // -------------------------------------------------------------------------
  // SafetyRule adapter — THE KEY METHOD
  // -------------------------------------------------------------------------

  /**
   * Returns a SafetyRule function compatible with PermissionEvaluator.
   *
   * Integration:
   *   const evaluator = new PermissionEvaluator({
   *     safetyRules: [zoneManager.asSafetyRule(), ...otherRules]
   *   })
   *
   * Behavior:
   * - deny/ask → always returned (zone enforces the decision)
   * - allow → returned for all zones, enforcing the zone's permission
   *
   * @security The zone system always returns a decision (never null) to ensure
   * every tool call passes through zone evaluation. Other safety rules in the
   * PermissionEvaluator chain run BEFORE zones (they're earlier in the array),
   * so they can still block. But zones never defer — they always have an opinion.
   *
   * If you need zones to defer to other rules for specific tools, use
   * ZoneOverride to explicitly classify those tools as Zone 0 (SAFE).
   */
  asSafetyRule(): SafetyRule {
    return (toolName: string, input: Record<string, unknown>): PolicyDecision | null => {
      const ctx: ZoneContext = {
        toolName,
        input,
        sessionId: '',
      }

      const decision = this.evaluate(ctx)

      // Record in combination tracker for future combo detection
      this.combinations.record(
        toolName,
        decision.classification.level,
        input,
      )

      // Audit logging
      if (this.auditLog) {
        this.auditLog.log(toolName, input, decision.decision, {
          validation: {
            level: `zone-${decision.classification.zoneName}`,
            reason: decision.explanation || decision.classification.reason,
          },
        })
      }

      // Always return the decision — zones never defer
      // Other safety rules should be placed BEFORE zones in the array
      // if they need to override zone decisions
      return decision.decision
    }
  }

  // -------------------------------------------------------------------------
  // Full evaluation pipeline
  // -------------------------------------------------------------------------

  /**
   * Evaluate a tool call through the complete zone pipeline.
   *
   * Pipeline:
   *   1. Classify tool call → zone level + severity
   *   2. Check combination rules → if a dangerous cross-zone combination
   *      is detected, return 'ask' with the combinationBlock attached so
   *      the UI can render an elevated warning
   *   3. Evaluate policy → 'allow' if within auto threshold, else 'ask'
   *   4. Apply expansion tracker → upgrade 'ask' to 'allow' if approved
   *   5. Generate explanation → human-readable text
   *
   * Post-redesign: this method never returns 'deny'. Combination
   * detection and Zone NEVER both surface as 'ask' with elevated
   * severity — the user always sees the prompt and decides.
   *
   * @param ctx - Tool call context
   * @returns Full zone decision with classification, policy, and explanation
   */
  evaluate(ctx: ZoneContext): ZoneDecision {
    // Step 1: Classify
    const classification = classifyToolCall(ctx, this.config.overrides)

    // Step 2: Check combinations FIRST. A matched combination surfaces
    // as 'ask' (the user is told what cross-call pattern looked risky
    // and decides). The combinationBlock travels with the decision so
    // the UI can render the elevated warning.
    const comboBlock = this.combinations.check(
      ctx.toolName,
      classification.level,
      ctx.input,
      this.config.combinationRules,
    )
    if (comboBlock) {
      const decision: ZoneDecision = {
        classification,
        decision: 'ask',
        explanation: '',
        combinationBlock: comboBlock,
      }
      return {
        ...decision,
        explanation: explainZoneDecision(ctx, decision),
      }
    }

    // Step 3: Check expansions (can upgrade 'ask' to 'allow')
    const hasExpansion = this.expansions.check(ctx.toolName, classification.level)

    // Step 4: Evaluate policy
    let policyDecision = evaluateZonePolicy(classification, this.config)

    // Expansion overrides 'ask' → 'allow' when the user has already
    // approved this pattern (session-wide or saved on disk) — but
    // never for Zone NEVER. NEVER stays an explicit prompt every
    // time so the user always sees the critical-severity action,
    // even if a prior grant covered the pattern. This mirrors the
    // persistence-layer safeguard at cortex's `saveRule` which
    // rejects saved 'allow' rules at the NEVER level.
    if (
      hasExpansion &&
      policyDecision === 'ask' &&
      classification.level !== ZoneLevel.NEVER
    ) {
      policyDecision = 'allow'
    }

    // Step 5: Generate explanation
    const decision: ZoneDecision = {
      classification,
      decision: policyDecision,
      explanation: '',
    }

    return {
      ...decision,
      explanation: explainZoneDecision(ctx, decision),
    }
  }

  // -------------------------------------------------------------------------
  // Expansion management
  // -------------------------------------------------------------------------

  /**
   * Record a user-approved zone expansion.
   *
   * Called by the HITL handler after the user approves a zone escalation.
   *
   * @param toolName - Tool that was approved (or '*' for all)
   * @param level - Zone level that was approved
   * @param scope - How long the approval lasts
   */
  grantExpansion(
    toolName: string,
    level: ZoneLevel,
    scope: 'once' | 'session' | 'tool-pattern' = 'session',
  ): void {
    this.expansions.grant({ level, toolPattern: toolName, scope })
  }

  /** Get all active zone expansions. */
  getExpansions(): readonly ZoneExpansion[] {
    return this.expansions.getActive()
  }

  /**
   * Revoke every active expansion whose `toolPattern` matches the
   * argument exactly. Returns `true` if at least one expansion was
   * removed.
   *
   * Inverse of `grantExpansion()`. Called by cortex's
   * `DELETE /api/v1/permissions/rules` handler so a user revoking a
   * saved "Always allow" rule immediately stops auto-allowing the tool
   * on every live session for that profile — without this poke, the
   * disk row is gone but the in-memory expansion (pre-populated at
   * session start by the profile assembler) keeps the auto-allow
   * alive until session end. See BUG #8.
   */
  revokeExpansion(toolPattern: string): boolean {
    return this.expansions.revoke(toolPattern)
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  /** Get the zone configuration. */
  getConfig(): Readonly<ZoneConfig> {
    return this.config
  }

  /** Reset all session state (combinations + expansions). */
  resetSession(): void {
    this.combinations.clear()
    this.expansions.clear()
  }

  /** Get the combination tracker (for testing/debugging). */
  getCombinationTracker(): CombinationTracker {
    return this.combinations
  }

  /** Get the expansion tracker (for testing/debugging). */
  getExpansionTracker(): ZoneExpansionTracker {
    return this.expansions
  }
}
