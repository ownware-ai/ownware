/**
 * Zone Security System
 *
 * Seven-level classification framework for agent tool calls.
 * Every tool call is classified into a zone (0=SAFE through 6=NEVER),
 * evaluated against the session's security policy, checked for
 * dangerous cross-zone combinations, and explained in plain language.
 *
 * Usage:
 *   import { ZoneManager, createZoneConfig } from '@ownware/loom/zones'
 *
 *   const config = createZoneConfig('standard')
 *   const zones = new ZoneManager(config)
 *
 *   const evaluator = new PermissionEvaluator({
 *     safetyRules: [zones.asSafetyRule()]
 *   })
 */

// Types (value + type re-exports)
export { ZoneLevel, ZONE_LEVEL_NAMES, ZONE_NAME_LEVELS } from './types.js'
export type {
  ZoneLevelName,
  ClassifierLayer,
  SeverityTag,
  ZoneClassification,
  ZoneDecision,
  CombinationBlockReason,
  CombinationToolEntry,
  CombinationRule,
  CombinationTrigger,
  ZoneConfig,
  ZoneOverride,
  ZoneExpansion,
  ZoneContext,
} from './types.js'

// Classifier
export { classifyToolCall } from './classifier.js'

// Policy
export { evaluateZonePolicy } from './policy.js'

// Combination detection
export { CombinationTracker } from './combinations.js'

// Expansion tracking
export { ZoneExpansionTracker } from './expansion.js'

// Explanation generation
export { explainZoneDecision } from './explainer.js'

// Default configurations
export {
  ZONE_CONFIGS,
  DEFAULT_COMBINATION_RULES,
  createZoneConfig,
} from './defaults.js'

// Manager (the main entry point)
export { ZoneManager } from './manager.js'
