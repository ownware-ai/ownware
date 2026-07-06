/**
 * Persistent Permission Store
 *
 * Saves user permission preferences per profile to disk.
 * Location: ~/.ownware/permissions/<profileId>.json
 *
 * These persist across sessions — when a user clicks "Always allow",
 * the preference is saved here and reloaded on next session start.
 *
 * Two safeguards:
 * 1. Saved rules respect the security level — if the level is tightened,
 *    old approvals don't weaken it (security level is the ceiling).
 * 2. Zone 6 (NEVER) can never be persisted as "allow" — hardcoded block.
 *
 * @security Stored as plain JSON. Filesystem permissions are the boundary.
 * Follows the same pattern as MCP credentials (~/.ownware/credentials/).
 */

import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { DEFAULT_DATA_DIR_NAME } from '../constants.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = join(homedir(), DEFAULT_DATA_DIR_NAME)
const PERMISSIONS_DIR = join(DATA_DIR, 'permissions')

/** Zone 6 (NEVER) can never be saved as "allow". Hardcoded. */
const ZONE_NEVER = 6

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single saved permission rule.
 *
 * Post-redesign (2026-05-14): the only meaningful saved decision is
 * `'allow'` — the user telling Ownware "this tool/pattern is always
 * fine for this profile." There is no `'deny'`: every risky call
 * surfaces to the user. Legacy `'deny'` rules on disk are dropped on
 * load (see `load()` below) so old files don't silently re-introduce
 * the blocking behavior we eliminated.
 */
export interface SavedPermissionRule {
  /** Glob pattern for tool name (e.g., "shell_execute", "mcp__github__*") */
  readonly toolPattern: string
  /** Maximum zone level this rule applies to (0-5, never 6) */
  readonly maxZone: number
  /** The saved decision */
  readonly decision: 'allow'
  /** When the rule was created */
  readonly createdAt: string
  /** Human-readable reason (shown in UI for review) */
  readonly reason?: string
}

/** Full permission file for a profile. */
export interface ProfilePermissions {
  /** Profile this applies to */
  readonly profileId: string
  /** Schema version for forward compatibility */
  readonly version: 1
  /** Saved permission rules */
  readonly rules: SavedPermissionRule[]
}

// ---------------------------------------------------------------------------
// Permission Store
// ---------------------------------------------------------------------------

export class PermissionStore {
  private readonly dir: string

  constructor(dir?: string) {
    this.dir = dir ?? PERMISSIONS_DIR
  }

  /**
   * Save a permission rule for a profile.
   *
   * Post-redesign (2026-05-14): only `decision: 'allow'` rules are
   * meaningful. The type system enforces this — `SavedPermissionRule`
   * has no other variant. The historical NEVER-zone safeguard is
   * preserved (saved allows cannot apply to Zone 6) so a user who
   * granted "always allow shell" before the redesign cannot
   * accidentally pre-auth a `rm -rf /` pattern that now classifies
   * NEVER but reaches the user via 'ask' instead of being denied.
   */
  async saveRule(profileId: string, rule: Omit<SavedPermissionRule, 'createdAt'>): Promise<void> {
    // Safeguard: a saved 'allow' grant cannot cover the NEVER zone.
    // The user will still see the prompt for NEVER-level actions and
    // can decide each time.
    if (rule.maxZone >= ZONE_NEVER) {
      throw new Error(
        `Cannot save "allow" rule for zone ${rule.maxZone} (NEVER). ` +
        `Zone 6 actions always prompt the user.`,
      )
    }

    const permissions = await this.load(profileId)
    const now = new Date().toISOString()

    // Remove existing rule for same tool pattern (replace, not duplicate)
    const filtered = permissions.rules.filter(r => r.toolPattern !== rule.toolPattern)

    const newRule: SavedPermissionRule = {
      toolPattern: rule.toolPattern,
      maxZone: rule.maxZone,
      decision: rule.decision,
      createdAt: now,
      reason: rule.reason,
    }

    const updated: ProfilePermissions = {
      profileId,
      version: 1,
      rules: [...filtered, newRule],
    }

    await this.write(profileId, updated)
  }

  /**
   * Load all permission rules for a profile.
   * Returns empty rules if no file exists.
   */
  async load(profileId: string): Promise<ProfilePermissions> {
    const filePath = this.filePath(profileId)
    try {
      const raw = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as ProfilePermissions

      // Validate structure
      if (!parsed.rules || !Array.isArray(parsed.rules)) {
        return { profileId, version: 1, rules: [] }
      }

      // Filter out any corrupt rules. Legacy 'deny' rules from
      // before the 2026-05-14 redesign are dropped here — those used
      // to mean "always block this tool"; the redesign replaces that
      // with always-ask. Surfacing them as 'allow' would be wrong,
      // and we don't support a third saved verdict, so we drop them.
      const validRules = parsed.rules.filter(r =>
        typeof r.toolPattern === 'string' &&
        typeof r.maxZone === 'number' &&
        r.decision === 'allow' &&
        r.maxZone < ZONE_NEVER, // Safeguard: NEVER zone always prompts
      ) as SavedPermissionRule[]

      return { profileId, version: 1, rules: validRules }
    } catch {
      return { profileId, version: 1, rules: [] }
    }
  }

  /**
   * Get rules that should be applied for a given security level.
   *
   * Safeguard 1: Rules are filtered against the security level's maxAutoZone.
   * A saved "allow" at zone 3 won't auto-allow if the security level's
   * maxAutoZone is 1 — it becomes an "ask" instead.
   *
   * @param profileId - Profile to load rules for
   * @param maxAutoZone - The security level's auto-allow threshold
   * @returns Rules filtered to respect the current security level
   */
  async getEffectiveRules(
    profileId: string,
    maxAutoZone: number,
  ): Promise<SavedPermissionRule[]> {
    const permissions = await this.load(profileId)

    // Only 'allow' rules exist post-redesign. A rule applies if its
    // zone is within the security level's auto-allow range — a saved
    // grant for Zone 3 has no effect on a 'standard' profile whose
    // maxAutoZone is Zone 1, because Zone 3 still needs to ask under
    // that security ceiling.
    return permissions.rules.filter(rule => rule.maxZone <= maxAutoZone)
  }

  /**
   * Revoke a specific rule by tool pattern.
   */
  async revokeRule(profileId: string, toolPattern: string): Promise<boolean> {
    const permissions = await this.load(profileId)
    const before = permissions.rules.length
    const filtered = permissions.rules.filter(r => r.toolPattern !== toolPattern)

    if (filtered.length === before) return false // nothing removed

    await this.write(profileId, { ...permissions, rules: filtered })
    return true
  }

  /**
   * Revoke all rules for a profile.
   */
  async revokeAll(profileId: string): Promise<void> {
    const filePath = this.filePath(profileId)
    try {
      await rm(filePath)
    } catch {
      // File doesn't exist — that's fine
    }
  }

  /**
   * List all profiles that have saved permissions.
   */
  async listProfiles(): Promise<string[]> {
    try {
      const files = await readdir(this.dir)
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''))
    } catch {
      return []
    }
  }

  // ── Internal ────────────────────────────────────────────────────────

  private filePath(profileId: string): string {
    // Sanitize profile ID to prevent path traversal
    const safe = profileId.replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(this.dir, `${safe}.json`)
  }

  private async write(profileId: string, data: ProfilePermissions): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const filePath = this.filePath(profileId)
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
  }
}

// ---------------------------------------------------------------------------
// Default instance
// ---------------------------------------------------------------------------

/** Default permission store at ~/.ownware/permissions/ */
export const permissionStore = new PermissionStore()
