/**
 * Skill Matcher
 *
 * Matches user input against skill triggers to find the best
 * matching skill to activate.
 */

import type { SkillDefinition } from './types.js'

// ---------------------------------------------------------------------------
// Match result
// ---------------------------------------------------------------------------

export interface SkillMatch {
  /** The matched skill */
  readonly skill: SkillDefinition
  /** Match confidence (0-1) */
  readonly confidence: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Match user input against available skill triggers.
 *
 * Matching rules:
 * - String triggers: case-insensitive prefix match (e.g., "/commit" matches "commit message")
 * - RegExp triggers: tested against the full input
 *
 * Returns the best matching skill, or null if no match.
 *
 * @param input - The user's input text
 * @param skills - Available skill definitions
 * @returns The best matching skill, or null
 */
export function matchSkill(
  input: string,
  skills: readonly SkillDefinition[],
): SkillDefinition | null {
  const match = matchSkillWithConfidence(input, skills)
  return match?.skill ?? null
}

/**
 * Match user input with confidence scoring.
 *
 * @param input - The user's input text
 * @param skills - Available skill definitions
 * @returns Best match with confidence, or null
 */
export function matchSkillWithConfidence(
  input: string,
  skills: readonly SkillDefinition[],
): SkillMatch | null {
  if (!input.trim() || skills.length === 0) return null

  const trimmed = input.trim()
  let bestMatch: SkillMatch | null = null

  for (const skill of skills) {
    const confidence = scoreTrigger(trimmed, skill.trigger)
    if (confidence > 0 && (bestMatch === null || confidence > bestMatch.confidence)) {
      bestMatch = { skill, confidence }
    }
  }

  return bestMatch
}

/**
 * Find all skills that match the input, sorted by confidence.
 */
export function matchAllSkills(
  input: string,
  skills: readonly SkillDefinition[],
): SkillMatch[] {
  if (!input.trim() || skills.length === 0) return []

  const trimmed = input.trim()
  const matches: SkillMatch[] = []

  for (const skill of skills) {
    const confidence = scoreTrigger(trimmed, skill.trigger)
    if (confidence > 0) {
      matches.push({ skill, confidence })
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence)
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score how well the input matches a trigger.
 *
 * @returns confidence between 0 (no match) and 1 (exact match)
 */
function scoreTrigger(input: string, trigger: string | RegExp): number {
  if (trigger instanceof RegExp) {
    return trigger.test(input) ? 0.9 : 0
  }

  // String trigger: check for slash-command prefix or substring match
  const triggerLower = trigger.toLowerCase()
  const inputLower = input.toLowerCase()

  // Exact match
  if (inputLower === triggerLower || inputLower === `/${triggerLower}`) {
    return 1.0
  }

  // Slash-command prefix: "/commit fix bug" matches trigger "commit"
  if (inputLower.startsWith(`/${triggerLower} `) || inputLower.startsWith(`/${triggerLower}\n`)) {
    return 0.95
  }

  // Input starts with trigger word
  if (inputLower.startsWith(`${triggerLower} `) || inputLower.startsWith(`${triggerLower}\n`)) {
    return 0.8
  }

  return 0
}
