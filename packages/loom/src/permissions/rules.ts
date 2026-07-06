/**
 * Built-in Safety Rules
 *
 * Loom's permission system ships with NO rules by default.
 * The engine is a general framework — consumers (like Cortex)
 * import rule presets from security/default-rules.ts.
 *
 * Shell security is now handled at the TOOL level (shell-security.ts),
 * not the permission level. This keeps the engine unopinionated.
 *
 * To add rules for your deployment:
 *   import { CODING_AGENT_RULES } from '../security/default-rules.js'
 *   const evaluator = new PermissionEvaluator({ safetyRules: CODING_AGENT_RULES })
 */

import type { SafetyRule } from './types.js'

// ---------------------------------------------------------------------------
// Export empty built-in rules (engine ships unopinionated)
// ---------------------------------------------------------------------------

/**
 * Built-in safety rules, evaluated in order.
 *
 * Empty by default — Loom is a general engine.
 * Use rule presets from security/default-rules.ts for specific deployments:
 * - CODING_AGENT_RULES: For developer tools (blocks rm -rf, sudo, etc.)
 * - ENTERPRISE_AGENT_RULES: For legal/finance/healthcare (strict)
 * - SANDBOX_AGENT_RULES: For sandboxed environments (minimal)
 */
export const BUILT_IN_SAFETY_RULES: SafetyRule[] = []
