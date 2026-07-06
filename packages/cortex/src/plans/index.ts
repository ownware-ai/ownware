/**
 * Cortex `plans` module — `.ownware/plans/<date>-<slug>.md` artifacts +
 * the `plan_draft` / `plan_submit` agent tools that produce them.
 *
 * Lives in Cortex (not Loom) because the `.ownware/` directory and the
 * plan file convention are Cortex product concerns; Loom stays
 * domain-neutral on prompting and tooling baseline.
 */

export {
  PLANS_SUBDIR,
  sanitizeFeatureSlug,
  formatDateStamp,
  resolvePlanPath,
  resolvePlansDir,
} from './paths.js'

export {
  extractTrailingChecklist,
  type ChecklistItem,
} from './parser.js'

export { createPlanDraftTool, type PlanDraftInput } from './draft-tool.js'
export { createPlanSubmitTool, type PlanSubmitInput } from './submit-tool.js'

import type { Tool } from '@ownware/loom'
import { createPlanDraftTool } from './draft-tool.js'
import { createPlanSubmitTool } from './submit-tool.js'

/**
 * Build the full set of plan tools. Returned as a fresh array each
 * call so callers can mutate / filter it freely.
 */
export function createPlanTools(): Tool[] {
  return [createPlanDraftTool(), createPlanSubmitTool()]
}

/** Names of the tools this module ships. Useful for allow-list checks
 *  in the assembler without instantiating the tools. */
export const PLAN_TOOL_NAMES = ['plan_draft', 'plan_submit'] as const
