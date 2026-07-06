/**
 * Skills Module
 *
 * Reusable prompt templates activated by user input triggers.
 */

// Types
export type {
  SkillDefinition,
  SkillManifest,
  SkillFrontmatter,
} from './types.js'

// Registry
export { SkillRegistry } from './registry.js'

// Loader
export { loadSkills, parseSkillFile } from './loader.js'

// Matcher
export { matchSkill, matchSkillWithConfidence, matchAllSkills } from './matcher.js'
export type { SkillMatch } from './matcher.js'

// Dispatcher tool — built-in `skill` tool that lazy-loads a named skill
// from the registry and returns its body as a tool result.
export { createSkillTool } from '../tools/builtins/skill.js'
export type { SkillToolOptions } from '../tools/builtins/skill.js'
