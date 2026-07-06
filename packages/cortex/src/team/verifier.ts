/**
 * The kernel-provided verifier (L7/L9, doc 11 Part 2 seam 4).
 *
 * A fresh-context skeptic: it sees ONLY the goal's done-criteria, the
 * declared deliverables, and read+run tools — never member transcripts,
 * never member result summaries. The moment it inherits anyone's belief
 * that the work is fine, the done-loop is theater (doc 11 Part 10).
 *
 * Tool surface: read + run (`coding` preset minus every write), plus
 * the member team tools bound to slug 'verifier' so gaps are filed as
 * ordinary unassigned work tasks and the verdict lands via
 * complete_task — one mechanism, no special verdict channel.
 */

import { ProfileSchema } from '../profile/schema.js'
import type { LoadedProfile } from '../profile/loader.js'
import type { Team, TeamRun, TeamTask } from './schema.js'

export const VERIFIER_SLUG = 'verifier'
export const VERIFY_ROUND_CAP = 3

const VERIFIER_SOUL = `# Verification agent

You are a fresh-eyes verification agent. You have NO history with this work and you trust nothing you have not checked yourself.

Rules:
- Verify EVERY done-criterion against reality: read the actual files, run the actual commands. Claims are not evidence; output is.
- Verify ONLY what is checkable in the workspace: file contents, structure, behavior of things you can run. Process facts (who did what, in which order, how the team worked) are NOT verifiable from artifacts — skip such criteria silently; they are never gaps.
- You cannot write or fix anything — you only inspect, run, and report.
- For EACH unmet criterion you find, call \`file_task\` once: a crisp title, a brief that tells a fixer exactly what is wrong and where, and what "fixed" means. Never file a gap that a fixer could not action by changing files or code.
- When your inspection is complete, call \`complete_task\` exactly once. The result MUST start with "PASS —" (you filed zero gap tasks; name what you checked) or "FAIL —" (you filed N gap tasks; list them in one line each).
- Be fast and concrete. No commentary beyond the verdict.`

export function buildVerifierProfile(team: Team, run: TeamRun): LoadedProfile {
  const config = ProfileSchema.parse({
    name: `team-verifier-${run.id}`,
    displayName: 'Verifier',
    description: 'Kernel-provided fresh-context verification agent',
    kind: 'helper',
    locked: true,
    ...(team.conductorModel !== null ? { model: team.conductorModel } : {}),
    tools: {
      // Read + run: filesystem reads, search, shell — every write denied.
      preset: 'coding',
      deny: ['writeFile', 'editFile', 'request_credential', 'plan_draft', 'plan_submit'],
      mcp: {},
    },
    context: { cwd: false, datetime: false, git: false, os: false, project: false },
  })
  return {
    config: { ...config, systemPrompt: VERIFIER_SOUL },
    soulMd: VERIFIER_SOUL,
    agentsMd: null,
    skills: [],
    basePath: process.cwd(),
    timeoutMs: 900_000,
  }
}

/**
 * The verifier's handoff: done-criteria + deliverables, nothing else.
 * Deliverable paths come from the goal row plus the work tasks'
 * declared deliverables — pointers to artifacts, not claims about them.
 */
export function buildVerifierPrompt(
  goal: TeamTask,
  tasks: readonly TeamTask[],
  round: number,
): string {
  const deliverables = new Set<string>(goal.deliverables)
  for (const t of tasks) {
    if (t.kind === 'work') {
      for (const d of t.deliverables) deliverables.add(d)
    }
  }
  const lines = [
    `[VERIFICATION — round ${round} of ${VERIFY_ROUND_CAP}]`,
    `Goal: ${goal.title}`,
    `Done means:`,
    goal.doneCriteria,
    deliverables.size > 0 ? `Declared deliverables: ${[...deliverables].join(', ')}` : '',
    '',
    'Inspect the workspace and verify every criterion above against reality. ' +
      'File one task per gap with file_task, then deliver your verdict with complete_task ' +
      '("PASS — …" or "FAIL — …"). Do not trust prior claims — check everything yourself.',
  ]
  return lines.filter((l) => l !== '').join('\n')
}
