/**
 * Skills Module Types
 *
 * Skills are reusable prompt templates that activate when user input
 * matches a trigger pattern. Each skill defines its own instructions,
 * allowed tools, and activation conditions.
 */

// ---------------------------------------------------------------------------
// Skill definition
// ---------------------------------------------------------------------------

/** A single skill that can be activated by user input */
export interface SkillDefinition {
  /** Unique skill name (e.g., "commit", "review-pr") */
  readonly name: string
  /** Human-readable description of what the skill does */
  readonly description: string
  /** Trigger pattern — string prefix or regex to match against user input */
  readonly trigger: string | RegExp
  /** The full prompt content injected when this skill activates */
  readonly content: string
  /** Optional list of tool names this skill is allowed to use */
  readonly allowedTools?: readonly string[]
  /**
   * Whether this skill is active in the runtime. Undefined = active
   * (default; legacy skills don't carry this flag). False = present on
   * disk but skipped at assembly time. Cortex sets this from the
   * `.disabled` marker file in nested skill folders.
   */
  readonly active?: boolean
}

// ---------------------------------------------------------------------------
// Skill manifest
// ---------------------------------------------------------------------------

/** Collection of skills loaded from a directory */
export interface SkillManifest {
  /** All loaded skill definitions */
  readonly skills: readonly SkillDefinition[]
  /** Directory path the skills were loaded from */
  readonly loadedFrom: string
}

// ---------------------------------------------------------------------------
// Skill frontmatter (parsed from SKILL.md YAML header)
// ---------------------------------------------------------------------------

/** YAML frontmatter schema for SKILL.md files */
export interface SkillFrontmatter {
  /** Skill name */
  readonly name: string
  /** Description */
  readonly description: string
  /** Trigger string or regex pattern */
  readonly trigger: string
  /** Whether trigger is a regex pattern */
  readonly triggerIsRegex?: boolean
  /** Allowed tool names */
  readonly allowedTools?: readonly string[]
}
