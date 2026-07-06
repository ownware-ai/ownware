/**
 * Plan-file checklist parser.
 *
 * The plan body is freeform Markdown — the agent decides the structure.
 * The ONE convention: the file ends with a `- [ ]` / `- [x]` checklist.
 * That trailing checklist is the bridge to `todo_write`: each item
 * becomes a todo entry the agent seeds when the plan is approved.
 *
 * What "trailing" means precisely:
 *   - Walk lines from the END of the file backwards.
 *   - Skip blank lines (and trailing whitespace-only lines).
 *   - Collect every consecutive checklist line (regex below).
 *   - Stop the moment we hit a non-checklist, non-blank line.
 *   - The collected lines (reversed back to top-to-bottom order) ARE the
 *     trailing checklist.
 *
 * Why "trailing only" and not "any checklist anywhere":
 *   - Plans often quote bullet lists as part of design discussion (e.g.
 *     "options considered: - [ ] approach A - [ ] approach B"). Those
 *     are not the final action list.
 *   - The trailing-only rule gives the agent a clean, deterministic
 *     contract: write whatever you want, end with the checklist, the
 *     parser picks it up. No `## Steps` heading required.
 *
 * Pure function. No I/O.
 */

export interface ChecklistItem {
  /** The text after `- [ ]`/`- [x]`, trimmed. Empty string if the
   *  bracket was followed by nothing. */
  readonly text: string
  /** True for `- [x]` (case-insensitive). False for `- [ ]`. */
  readonly done: boolean
  /** 1-based line number in the source body. Useful when the agent
   *  wants to map an item back to its source for in-place updates. */
  readonly line: number
}

// `- [ ] text`   or   `- [x] text`   (case-insensitive on x)
//   capture group 1: `x` or ` ` (the box state)
//   capture group 2: the item text (may be empty)
//
// Leading whitespace allowed (handles indented sub-lists; we still
// pick them up if they're in the trailing run). Bullet must be `-`,
// not `*` or `+`, because Markdown lists in our agent prompts are
// always written with `-`. Keeping the rule strict avoids accidentally
// matching things like `- - -` (an HR-like sequence).
const CHECKLIST_LINE = /^\s*-\s+\[([ xX])\]\s*(.*)$/

/**
 * Extract the trailing checklist from a plan-file body.
 *
 * Returns an empty array if the file does not end in a checklist —
 * a totally valid intermediate state (the agent is still drafting and
 * hasn't finalized the action list yet). Caller decides what to do
 * with empty: `plan_submit` typically refuses to submit an emptily-
 * tailed plan.
 */
export function extractTrailingChecklist(body: string): ChecklistItem[] {
  if (body.length === 0) return []
  const lines = body.split('\n')

  // Walk from the end. Phase 1: skip trailing whitespace lines so the
  // checklist can have a final blank line under it without breaking.
  let i = lines.length - 1
  while (i >= 0 && lines[i]!.trim() === '') i--

  if (i < 0) return []

  // Phase 2: collect every consecutive checklist line moving backwards.
  // Stop on the first line that is not a checklist line.
  const collected: Array<{ line: number; match: RegExpMatchArray }> = []
  while (i >= 0) {
    const m = lines[i]!.match(CHECKLIST_LINE)
    if (!m) break
    collected.push({ line: i + 1, match: m })
    i--
  }

  // Reverse to top-to-bottom order.
  collected.reverse()

  return collected.map(({ line, match }) => ({
    text: (match[2] ?? '').trim(),
    done: (match[1] ?? ' ').toLowerCase() === 'x',
    line,
  }))
}
