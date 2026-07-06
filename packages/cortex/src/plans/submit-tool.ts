/**
 * `plan_submit` — present a drafted plan for user approval and bridge
 * its trailing checklist into the agent's todo list.
 *
 * MVP semantics (this chunk):
 *   - Reads the plan file written by `plan_draft`.
 *   - Parses the trailing `- [ ]` checklist.
 *   - Returns a structured tool result that:
 *       (a) shows the user where the plan lives,
 *       (b) lists the parsed checklist items as a recommended seed
 *           for `todo_write`, with the exact instruction telling the
 *           agent to call `todo_write` next.
 *   - The agent then calls `todo_write` itself. The user sees both
 *     the plan file (client side panel) and the seeded todos
 *     (existing Tasks panel).
 *
 * Deferred to follow-up chunks (NOT in this MVP):
 *   - A client approval card with Approve / Reject / Revise buttons.
 *     Today's behavior: the user sees the plan and gives a verbal
 *     "go ahead" in chat. Tomorrow's behavior: a clickable card
 *     pauses the agent until the user clicks.
 *   - Auto-blocking writes-except-plan-file while the agent is
 *     drafting. Today: the agent self-disciplines (per profile
 *     guidance). Tomorrow: a session flag enforced at the tool
 *     policy layer.
 *   - Auto-calling `todo_write` from inside `plan_submit`. Today
 *     the agent makes the call explicitly so both events appear in
 *     the transcript.
 *
 * The MVP shape is forward-compatible: when the client approval card
 * lands, this tool's signature does not change — the new approval flow
 * just gates what the tool result says.
 */

import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { defineTool, type Tool } from '@ownware/loom'
import { resolvePlanPath } from './paths.js'
import { extractTrailingChecklist } from './parser.js'

const PLAN_SUBMIT_DESCRIPTION = `Present a drafted plan for the user's review. Reads the plan file you wrote with \`plan_draft\`, parses the trailing checklist, and returns it so you can seed those items as todos via \`todo_write\` after the user approves.

## When to use
- After you've drafted a plan with \`plan_draft\` and it's ready for review.
- The user explicitly says they want to see the plan before you proceed.

## When NOT to use
- Mid-draft. Iterate on the plan with \`plan_draft\` first; only submit when the plan represents your finalized proposal.
- For trivial tasks where there's no plan to submit.

## Inputs
- \`feature\`: same feature name you passed to \`plan_draft\`. Used to locate the plan file.

## Output
- Returns the plan file path, the parsed trailing checklist, and an instruction for what to do next:
  1. Show the plan to the user (or wait for explicit approval if UI approval is wired).
  2. On approval, call \`todo_write\` to seed each checklist item as a pending todo.
  3. Begin executing each step, marking todos in_progress / completed as you go.

The plan file MUST end with a \`- [ ]\` checklist for this to extract todo items. If the parser finds no trailing checklist, this tool returns an error — go back to \`plan_draft\` and append a checklist of action steps.`

const PlanSubmitInputSchema = z.object({
  feature: z.string().min(1, 'feature must be non-empty'),
})

export type PlanSubmitInput = z.infer<typeof PlanSubmitInputSchema>

export function createPlanSubmitTool(): Tool {
  return defineTool({
    name: 'plan_submit',
    description: PLAN_SUBMIT_DESCRIPTION,
    category: 'custom',
    isReadOnly: true,
    requiresPermission: false,
    inputSchema: {
      type: 'object',
      properties: {
        feature: {
          type: 'string',
          description:
            'Same feature name you passed to plan_draft. Used to locate the plan file under .ownware/plans/.',
        },
      },
      required: ['feature'],
    },
    async execute(input, context) {
      const parsed = PlanSubmitInputSchema.safeParse(input)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        return {
          content: `Invalid input: ${issue?.path.join('.') ?? 'input'}: ${issue?.message ?? 'unknown'}`,
          isError: true,
        }
      }
      const { feature } = parsed.data

      const workspacePath = context.workspacePath || context.cwd
      let planPath: string
      try {
        planPath = resolvePlanPath(workspacePath, feature)
      } catch (err) {
        return {
          content:
            `Could not derive a plan filename from feature "${feature}". ` +
            (err instanceof Error ? err.message : String(err)),
          isError: true,
        }
      }

      let body: string
      try {
        body = await readFile(planPath, 'utf-8')
      } catch (err) {
        return {
          content:
            `Plan file not found at ${planPath}. Did you call plan_draft first with the same feature name? ` +
            (err instanceof Error ? err.message : String(err)),
          isError: true,
        }
      }

      const checklist = extractTrailingChecklist(body)
      if (checklist.length === 0) {
        return {
          content:
            `Plan at ${planPath} does not end with a \`- [ ]\` checklist. ` +
            `Add a checklist of action steps at the end of the plan, then call plan_submit again. ` +
            `The checklist is what becomes the live todo list during execution.`,
          isError: true,
        }
      }

      const itemLines = checklist.map(
        (item, idx) => `${idx + 1}. ${item.text}${item.done ? '  (already marked done)' : ''}`,
      )

      const content = [
        `Plan ready for review.`,
        ``,
        `**File**: ${planPath}`,
        `**Trailing checklist** (${checklist.length} ${checklist.length === 1 ? 'item' : 'items'}):`,
        ...itemLines,
        ``,
        `## Next step`,
        ``,
        `If the user approves the plan, call \`todo_write\` with each checklist item as a separate todo (status: pending). Then begin executing — mark each todo \`in_progress\` before the step, \`completed\` after. The user watches the live checklist in the Tasks panel as you work.`,
        ``,
        `If the user wants changes, go back to \`plan_draft\` with the same feature name and the revised content, then call \`plan_submit\` again.`,
      ].join('\n')

      return {
        content,
        isError: false,
        metadata: { path: planPath, feature, checklist },
      }
    },
  })
}
