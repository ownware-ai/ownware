/**
 * Per-schedule safety envelope — the tool boundary for an UNATTENDED run.
 *
 * Mirrors the team member-policy boundary (`team/member-policy.ts`): a
 * scheduled run is headless, so capability is governed by WHICH TOOLS it is
 * handed — never by a permission prompt (there is no human to answer an
 * `ask`, so the run uses `permissionMode: 'auto'` and the tool filter below
 * is the real boundary). A withheld tool simply isn't there; the model
 * cannot argue its way past a missing capability.
 *
 * Levels (what the create dialog's three cards map to):
 *   - 'full-access'    → every tool. The user explicitly opted in.
 *   - 'read-only'      → only tools that declare `isReadOnly === true`. An
 *                        unknown/undefined flag is treated as mutating and
 *                        removed (safe default, same as member-policy).
 *   - 'draft-approval' → until the draft-hold pipeline lands (Slice 8d) this
 *                        behaves EXACTLY like read-only: no write/send tool is
 *                        handed over, so a scheduled run can never send or
 *                        mutate unattended. 8d upgrades the withheld write/send
 *                        tools to held-for-approval (parked as a draft) instead
 *                        of withheld. Safe-by-default holds at every point in
 *                        the build — never a window where a draft-approval run
 *                        could auto-send.
 */

import { z } from 'zod'
import type { Tool } from '@ownware/loom'

export const SafetyLevelSchema = z.enum(['read-only', 'draft-approval', 'full-access'])
export type SafetyLevel = z.infer<typeof SafetyLevelSchema>

/** The safe default for a new schedule (owner-locked 2026-06-24). */
export const DEFAULT_SAFETY_LEVEL: SafetyLevel = 'draft-approval'

/**
 * Filter a scheduled run's assembled tools to its safety level. Pure — no
 * DB, no model — so it is unit-tested without the native sqlite module.
 */
export function applySafetyLevel(tools: readonly Tool[], level: SafetyLevel): Tool[] {
  switch (level) {
    case 'full-access':
      return [...tools]
    case 'read-only':
    case 'draft-approval':
      // Withhold everything not provably read-only. Unknown flag = mutating.
      return tools.filter((t) => t.isReadOnly === true)
    default: {
      // Exhaustiveness guard — an unrecognized level fails CLOSED (read-only),
      // never open. (`never` makes a new enum member a compile error here.)
      const _exhaustive: never = level
      void _exhaustive
      return tools.filter((t) => t.isReadOnly === true)
    }
  }
}

/**
 * Whether a level still permits write/send tools to be HANDED to the run.
 * Today only 'full-access' does. (Used by callers that want to short-circuit
 * the filter; the filter itself is the source of truth.)
 */
export function allowsMutatingTools(level: SafetyLevel): boolean {
  return level === 'full-access'
}
