/**
 * Plan-file path resolution.
 *
 * Plans are stored as Markdown files under `.ownware/plans/` inside the
 * agent's workspace. Naming: `<YYYYMMDD>-<feature-slug>.md`.
 *
 *   - Date prefix gives natural ordering and uniqueness across features.
 *   - Slug is human-readable; agent picks the feature name at draft time.
 *   - One file per feature per day. Subsequent draft calls within the
 *     same day update the existing file (append revision sections), so
 *     iteration during planning never spawns `plan.v2.md`.
 *
 * This module is pure path math + slug sanitization. Filesystem I/O
 * (creating directories, reading/writing files) lives in the
 * `plan_draft` and `plan_submit` tool implementations.
 */

import { join } from 'node:path'

import { PROJECT_PLANS_SUBDIR } from '../constants.js'

/** Directory (relative to workspace root) where plans live. */
export const PLANS_SUBDIR = PROJECT_PLANS_SUBDIR

/** Maximum slug length — prevents pathological feature names. */
const MAX_SLUG_LENGTH = 60

/**
 * Sanitize a freeform feature name into a filesystem-safe slug.
 *
 *   "Add OAuth"             → "add-oauth"
 *   "Refactor auth/session" → "refactor-auth-session"
 *   "Fix bug #142"          → "fix-bug-142"
 *   "  Padded   spaces  "   → "padded-spaces"
 *   "🚀 Launch the rocket"  → "launch-the-rocket"
 *   ""                      → throws (caller must give a name)
 *
 * Rules:
 *   - Lowercase
 *   - Replace any run of non-alphanumeric chars with a single `-`
 *   - Trim leading/trailing dashes
 *   - Cap at MAX_SLUG_LENGTH chars (cut at last dash before the cap so
 *     we don't slice a word in half)
 *   - Throw on empty result — the agent should always pass something
 *     human-readable; silently producing `untitled.md` would mask bugs.
 */
export function sanitizeFeatureSlug(raw: string): string {
  const lower = raw.toLowerCase()
  // Replace runs of non-alphanumeric with a single dash.
  const dashed = lower.replace(/[^a-z0-9]+/g, '-')
  const trimmed = dashed.replace(/^-+|-+$/g, '')
  if (trimmed.length === 0) {
    throw new Error(
      `Cannot derive a slug from feature name "${raw}". ` +
        `Pass a name with at least one alphanumeric character.`,
    )
  }
  if (trimmed.length <= MAX_SLUG_LENGTH) return trimmed
  // Cap, then back off to the last dash boundary so we don't cut a
  // word; if there's no dash within the window, hard-cut at the cap.
  const capped = trimmed.slice(0, MAX_SLUG_LENGTH)
  const lastDash = capped.lastIndexOf('-')
  return lastDash > MAX_SLUG_LENGTH / 2 ? capped.slice(0, lastDash) : capped
}

/**
 * Format today's date as YYYYMMDD. Caller can pass an explicit Date
 * for deterministic tests.
 */
export function formatDateStamp(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/**
 * Resolve the canonical plan file path for a feature in a workspace.
 *
 *   resolvePlanPath("/work/repo", "Add OAuth")
 *     → "/work/repo/.ownware/plans/20260510-add-oauth.md"
 */
export function resolvePlanPath(
  workspacePath: string,
  feature: string,
  now: Date = new Date(),
): string {
  const slug = sanitizeFeatureSlug(feature)
  const stamp = formatDateStamp(now)
  return join(workspacePath, PLANS_SUBDIR, `${stamp}-${slug}.md`)
}

/**
 * Resolve the directory plans live in for a given workspace. The tool
 * implementations call this before `mkdir -p` to ensure the directory
 * exists on the first draft of any feature.
 */
export function resolvePlansDir(workspacePath: string): string {
  return join(workspacePath, PLANS_SUBDIR)
}
