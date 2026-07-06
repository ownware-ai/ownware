/**
 * `board_write` — lay out (or re-draft) a whole effort as a Board.
 *
 * The top rung of the work ladder (todo → plan → BOARD). One call writes
 * the STRUCTURE: goal, approach, and the ordered slices the agent works
 * one-by-one. It does NOT write code or tests — each slice's tests are
 * part of executing that slice (decision D2).
 *
 * Idempotent on (workspace, slug): the same slug updates the board in
 * place rather than spawning board-v2. Findings logged so far are kept
 * (decision D6) — only the structure is replaced.
 *
 * Cortex-side, bound per session to (store, workspaceId, originThreadId)
 * — same wiring model as `open_pane`. Loom stays domain-neutral; "boards"
 * are a Ownware convention.
 */

import { z } from 'zod'
import { defineTool, type Tool } from '@ownware/loom'
import type { SqliteBoardStore } from './store.js'

export interface BoardWriteDeps {
  readonly store: SqliteBoardStore
  readonly workspaceId: string
  /** Chat that drafted this board, when known. */
  readonly originThreadId: string | null
}

const SliceInputSchema = z.object({
  title: z.string().min(1, 'slice title must be non-empty'),
  summary: z.string().optional(),
  plan: z.string().optional(),
  evidence: z.string().optional(),
})

const BoardWriteInputSchema = z.object({
  slug: z.string().min(1, 'slug must be non-empty'),
  title: z.string().min(1, 'title must be non-empty'),
  goal: z.string().optional(),
  approach: z.string().optional(),
  slices: z.array(SliceInputSchema).min(1, 'a board needs at least one slice'),
})

/** Normalize a freeform slug into a stable, filesystem-safe identity. */
function slugify(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s.length > 0 ? s.slice(0, 60).replace(/-+$/g, '') : 'board'
}

const BOARD_WRITE_DESCRIPTION = `Lay out a multi-slice effort as a BOARD — a goal, an approach, and ordered slices you work one-by-one, verifying each before the next. The top rung of the work ladder.

## When to use
- A feature/effort with 3+ independent, separately-verifiable slices.
- Work you'll pause and resume (possibly across sessions).
- Anything where the user should approve the whole shape before you start.

## When NOT to use
- A single change that just needs sign-off → use \`plan_write\`.
- A quick multi-step task → use \`todo_write\`.

## Inputs
- \`slug\`: stable id for this effort (e.g. "login-hardening"). The SAME slug updates the board in place — re-draft freely.
- \`title\`: the goal in a sentence.
- \`goal\`: 1–3 sentences — what "done" looks like and why.
- \`approach\`: prose — the order of attack and the reasoning.
- \`slices\`: ordered list, each \`{ title, summary, plan, evidence }\`. \`evidence\` is how that slice proves itself (e.g. "tests pass", "PR opened", "preview"). Not every slice is testable.

Write the STRUCTURE only — do NOT write code or tests here. Each slice's tests are part of executing that slice.

## After writing
Present the board for the user's approval. Once approved, drive it with \`board_update\`: set the board \`running\`, flip each slice queued→running→done, and log findings as you hit them. Nothing runs until the user approves.`

export function createBoardWriteTool(deps: BoardWriteDeps): Tool {
  return defineTool({
    name: 'board_write',
    description: BOARD_WRITE_DESCRIPTION,
    category: 'custom',
    isReadOnly: false,
    requiresPermission: false,
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description:
            'Stable slug for this effort (e.g. "login-hardening"). The same slug updates the board in place across calls.',
        },
        title: { type: 'string', description: 'The goal in a sentence (the board title).' },
        goal: { type: 'string', description: 'What "done" looks like and why (1–3 sentences).' },
        approach: {
          type: 'string',
          description: 'Prose: the overall order of attack and the reasoning behind it.',
        },
        slices: {
          type: 'array',
          description: 'Ordered slices, each shipped and verified on its own. Structure only — no code/tests here.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'What this slice delivers.' },
              summary: { type: 'string', description: 'One-line subtitle.' },
              plan: { type: 'string', description: 'The slice’s own mini-plan / approach.' },
              evidence: {
                type: 'string',
                description: 'How this slice proves itself (e.g. "tests pass", "PR opened", "preview"). Optional.',
              },
            },
            required: ['title'],
          },
        },
      },
      required: ['slug', 'title', 'slices'],
    },
    async execute(input) {
      const parsed = BoardWriteInputSchema.safeParse(input)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        return {
          content: `Invalid input: ${issue?.path.join('.') ?? 'input'}: ${issue?.message ?? 'unknown'}`,
          isError: true,
        }
      }
      const { slug, title, goal, approach, slices } = parsed.data

      let board
      try {
        board = deps.store.replaceStructure({
          workspaceId: deps.workspaceId,
          originThreadId: deps.originThreadId,
          slug: slugify(slug),
          title,
          ...(goal != null ? { goal } : {}),
          ...(approach != null ? { approach } : {}),
          slices: slices.map((s) => ({
            title: s.title,
            ...(s.summary != null ? { summary: s.summary } : {}),
            ...(s.plan != null ? { plan: s.plan } : {}),
            ...(s.evidence != null ? { evidence: s.evidence } : {}),
          })),
        })
      } catch (err) {
        return {
          content: `Failed to write board: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }

      const sliceLines = board.slices
        .map((s, i) => `${i + 1}. ${s.title}${s.summary ? ` — ${s.summary}` : ''}  [${s.status}]`)
        .join('\n')

      return {
        content:
          `Board "${board.title}" written (id ${board.id}, slug ${board.slug}, ${board.slices.length} ${board.slices.length === 1 ? 'slice' : 'slices'}).\n\n` +
          `${sliceLines}\n\n` +
          `Next: present this to the user for approval. Once approved, drive it with \`board_update\` — set the board \`running\`, flip each slice queued→running→done, and log findings as you go. Nothing runs until the user approves.`,
        isError: false,
        metadata: { boardId: board.id, slug: board.slug, slices: board.slices.length },
      }
    },
  })
}
