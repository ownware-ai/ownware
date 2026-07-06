/**
 * `plan_draft` — the single tool an agent uses to write a plan file.
 *
 * Flow:
 *   1. Agent calls `plan_draft({ feature: "Add OAuth", content: "..." })`
 *   2. Cortex resolves `.ownware/plans/<YYYYMMDD>-<slug>.md` and either
 *      creates the file (first call for that feature today) or replaces
 *      its body (subsequent calls — the agent rewrites as it iterates).
 *   3. The agent calls `plan_draft` repeatedly with updated content as
 *      it thinks. The tool is idempotent on file existence; the agent
 *      doesn't have to track "is this the first call?"
 *
 * The plan content itself is FREEFORM. The agent decides the shape —
 * paragraphs, sections, tables, whatever fits the task. The only
 * convention enforced elsewhere (`plan_submit` parser) is that the
 * file ends with a `- [ ]` checklist.
 *
 * Why a single tool with `content` (full body) instead of separate
 * append/replace operations:
 *   - The agent already maintains the full plan in its context as it
 *     writes; passing the whole body is no harder than passing a diff.
 *   - "Replace the body" is the simplest mental model: agent thinks,
 *     emits the latest version of the plan, file mirrors it. No edit
 *     primitives, no merge logic, no race conditions on append.
 *   - The client's right-side viewer just streams the file; whether the
 *     agent appends or replaces doesn't change rendering.
 *
 * Cortex-side tool. Lives in Cortex (not Loom) because `.ownware/plans/`
 * is a Cortex product convention, not a Loom engine concern. Loom stays
 * domain-neutral.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { defineTool, type Tool } from '@ownware/loom'
import { resolvePlanPath } from './paths.js'

const PLAN_DRAFT_DESCRIPTION = `Write or update a plan file under .ownware/plans/. Use this when you need to draft an implementation plan before writing code, especially for non-trivial work (multi-file changes, new abstractions, anything that benefits from user sign-off before execution).

## When to use
- The user asked for something non-trivial and you want to align on the approach before editing.
- You want a durable artifact (plan persists as a file in the workspace; user can review, edit, commit).
- You expect the work to span multiple steps and want a checklist that becomes live todos on approval.

## When NOT to use
- Single-file edits or trivial fixes — just do them.
- Pure exploration or Q&A — write the answer in your reply, not a plan file.
- The user hasn't asked for planning. Don't draft a plan unprompted for small tasks.

## Inputs
- \`feature\`: short human-readable name (e.g. "add OAuth", "fix auth race"). Becomes part of the filename.
- \`content\`: the full plan body in Markdown. Freeform — write whatever shape fits the task. The ONE convention: end the file with a \`- [ ]\` checklist of action steps. The checklist becomes todo items when you call \`plan_submit\`.

## Output
- Returns the absolute file path. Subsequent calls with the same \`feature\` (within the same day) replace the body — call as many times as you need to refine the plan. The side panel streams the file live so the user watches the plan form.

## Multi-call iteration
The first call creates the file; later calls overwrite it. You don't track state — just send the latest full plan each time.

After you're done iterating, call \`plan_submit\` to present it for the user's approval and convert the trailing checklist into todos.`

const PlanDraftInputSchema = z.object({
  feature: z.string().min(1, 'feature must be non-empty'),
  content: z.string().min(1, 'content must be non-empty'),
})

export type PlanDraftInput = z.infer<typeof PlanDraftInputSchema>

export function createPlanDraftTool(): Tool {
  return defineTool({
    name: 'plan_draft',
    description: PLAN_DRAFT_DESCRIPTION,
    category: 'custom',
    isReadOnly: false,
    requiresPermission: false,
    inputSchema: {
      type: 'object',
      properties: {
        feature: {
          type: 'string',
          description:
            'Short human-readable feature name (e.g. "add-oauth", "fix-auth-race"). Used to derive the filename. Stable across calls — use the same feature on iterations.',
        },
        content: {
          type: 'string',
          description:
            'Full plan body in Markdown. Freeform shape. End with a `- [ ]` checklist of action steps for the auto-todo bridge. Each call overwrites the file; pass the latest full version, not a diff.',
        },
      },
      required: ['feature', 'content'],
    },
    async execute(input, context) {
      const parsed = PlanDraftInputSchema.safeParse(input)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        return {
          content: `Invalid input: ${issue?.path.join('.') ?? 'input'}: ${issue?.message ?? 'unknown'}`,
          isError: true,
        }
      }
      const { feature, content } = parsed.data

      // Plan files belong inside the workspace so the user can see /
      // edit / commit them like any other file. The session host sets
      // workspacePath at session creation; plans live next to the
      // user's code, not in some hidden runtime location.
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

      try {
        await mkdir(dirname(planPath), { recursive: true })
        await writeFile(planPath, content, 'utf-8')
      } catch (err) {
        return {
          content:
            `Failed to write plan file at ${planPath}: ` +
            (err instanceof Error ? err.message : String(err)),
          isError: true,
        }
      }

      return {
        content:
          `Plan written to ${planPath}.\n\n` +
          `Iterate by calling \`plan_draft\` again with the updated content. ` +
          `When the plan is ready for the user's approval, call \`plan_submit\` with feature="${feature}".`,
        isError: false,
        metadata: { path: planPath, feature },
      }
    },
  })
}
