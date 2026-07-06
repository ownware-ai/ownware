/**
 * Zone Security System — Policy Evaluation
 *
 * Maps a zone classification + security config → PolicyDecision.
 *
 * Post-redesign (2026-05-14) the verdict surface is two-valued:
 *   - Zone <= maxAutoZone → allow (no prompt)
 *   - else                → ask (prompt user, severity = zone name)
 *
 * The zone level still classifies how risky a call is; the UI uses
 * it to pick severity copy and styling. But there is no policy-level
 * deny — including Zone NEVER. The user always sees the prompt and
 * makes the call.
 *
 * @security Pure function. No side effects, no state.
 */

import type { PolicyDecision } from '../permissions/types.js'
import type { ZoneClassification, ZoneConfig } from './types.js'

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a zone classification against the zone config.
 *
 * @param classification - The zone level assigned to a tool call
 * @param config - Zone configuration with thresholds
 * @returns PolicyDecision: 'allow' or 'ask'
 */
export function evaluateZonePolicy(
  classification: ZoneClassification,
  config: ZoneConfig,
): PolicyDecision {
  const { level } = classification

  // Below or at auto threshold → allow without asking
  if (level <= config.maxAutoZone) {
    return 'allow'
  }

  // Anything else → prompt the user. Zone level survives on the
  // classification object so the UI can render an appropriate
  // severity badge (Zone 6 NEVER renders as 'critical', Zone 2 BUILD
  // as 'info', etc.). The user, not the policy, decides.
  return 'ask'
}
