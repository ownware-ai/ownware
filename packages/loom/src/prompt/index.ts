/**
 * Prompt Module
 *
 * Composable prompt construction from typed fragments.
 * Replaces middleware-based prompt injection with a clean builder pattern.
 */

// Types
export type { PromptFragment, PromptSlot, AssembledPrompt } from './types.js'
export { SLOT_ORDER } from './types.js'

// Builder
export { PromptBuilder } from './builder.js'
export type { AddFragmentOptions } from './builder.js'

// Cache strategy
export {
  computeCacheBreakpoints,
  isCacheable,
  isStableSlot,
  isVolatileSlot,
} from './cache.js'

// Fragment factories
export { createIdentityFragment } from './fragments/identity.js'
export { createContextFragment } from './fragments/context.js'
export type { ContextFragmentOptions } from './fragments/context.js'
export { createMemoryFragment, createLayeredMemoryFragment } from './fragments/memory.js'
export {
  createBehaviorFragment,
  createSafetyPrincipleFragment,
  createSafetyFragment,
  createEngineeringDisciplineFragment,
} from './fragments/behavior.js'
export { createToolsFragment, createToolUsageFragment } from './fragments/tools.js'
export { createOutputFragment } from './fragments/output.js'
export {
  createSystemFragment,
  createCompactionFragment,
  createSecurityPolicyFragment,
  createThinkingFrequencyFragment,
} from './fragments/system.js'
export { createSkillsFragment } from './fragments/skills.js'
