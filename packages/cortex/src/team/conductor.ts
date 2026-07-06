/**
 * Conductor materialization — a team's lead as a synthetic profile.
 *
 * A team is DATA (rows in `teams`/`team_members`), not a folder on
 * disk. Its Conductor is materialized from the team row into an
 * in-memory `ProfileConfig` and registered programmatically via
 * `ProfileRegistry.register()` (registry.ts:493) — no disk writes, no
 * pollution of the profiles directory. Registration is repeated at
 * every gateway boot by the team module (in-memory registrations don't
 * survive restarts).
 *
 * Tool surface (L6, staged): the conductor profile allows ONLY
 * `ask_user` + `todo_write` from the builtins — every work tool,
 * including readFile, is absent by construction (allow-list over the
 * preset). The three board tools (board_write / check_status /
 * finish_run) are appended at session creation by the team module.
 * `agent_spawn`+Scout and `memory_*` are deferred to S3 (BUILD-BOARD
 * decision B5): loom's spawner isolates helpers to a SUBSET of the
 * parent's tools, so a read-only Scout under a tool-less conductor
 * needs the spawn pool widened — that lands with the S3 slice.
 */

import { ProfileSchema, type ProfileConfig } from '../profile/schema.js'
import { renderReferenceSection } from './references.js'
import type { Team, TeamConductorEscalation } from './schema.js'

/** Registry id for a team's conductor profile. Collision-safe: team ids are generated. */
export function conductorProfileId(teamId: string): string {
  return `team-conductor-${teamId}`
}

/**
 * Compose the company's instruction fragments (D26) into SOUL
 * sections. Fragments win; the legacy freeform charter is the
 * fallback when no fragment is authored.
 */
function renderCharterSections(team: Team): string {
  const f = team.fragments
  const sections: Array<readonly [string, string | undefined]> = [
    ['Identity — who this company is', f.identity],
    ['Principles — how the team works', f.principles],
    ['Workflow — how work moves between roles', f.workflow],
    ['Done means — what counts as finished here', f.doneMeans],
    ['Rules — the always and the nevers', f.rules],
    ['Voice — how you talk to the user', f.voice],
  ]
  const rendered = sections
    .filter((s): s is readonly [string, string] => s[1] !== undefined && s[1].trim().length > 0)
    .map(([title, text]) => `## ${title}\n\n${text.trim()}\n`)
  if (rendered.length > 0) return rendered.join('\n')
  return team.charter ? `## Charter\n\n${team.charter}\n` : ''
}

/**
 * The escalation stance (conductor modal "When members are unsure")
 * rendered as a directive the lead reads at every wake. Each value maps
 * to genuinely different behavior at judgment points, not flavor text.
 */
function escalationGuidance(escalation: TeamConductorEscalation): string {
  switch (escalation) {
    case 'autonomous':
      return 'Minimize interruptions. Decide the judgment calls yourself — unassigned work, failures, verifier gaps, ambiguous scope — and keep the work moving. Only stop to ask the user on a hard budget limit, or before an action that leaves the workspace (deploying, sending, publishing).'
    case 'consultative':
      return 'Keep the user closely in the loop. At each judgment point — unassigned work, a failed task, a verifier gap, an ambiguous scope — check in with `ask_user` before you decide, rather than deciding alone.'
    case 'balanced':
    default:
      return 'Resolve the routine coordination yourself — assigning filed work, rerouting failures, scheduling. Bring the user scope decisions, budget limits, and any action that leaves the workspace; handle everything else without asking.'
  }
}

function buildConductorSoul(team: Team): string {
  const roster = team.members
    .map((m) => `- **${m.slug}** — ${m.role}${m.instructions ? ` (${m.instructions})` : ''}`)
    .join('\n')

  const operatorInstructions =
    team.conductorInstructions && team.conductorInstructions.trim().length > 0
      ? `## Direct instructions from your operator\n\n${team.conductorInstructions.trim()}\n\n`
      : ''

  const references = renderReferenceSection(team.references)
  const referencesBlock = references ? `${references}\n` : ''

  return `# ${team.conductorName} — Conductor of ${team.displayName}

You are ${team.conductorName}, the lead of the team "${team.displayName}". You speak to the user with one clear voice, and you coordinate the team through the shared **board** — never by doing the work yourself.

${renderCharterSections(team)}
${operatorInstructions}${referencesBlock}## How closely to involve the user

${escalationGuidance(team.conductorEscalation)}

## Your team

${roster}

## How you work — the law

1. **You never do the work.** You have no file, shell, or search tools — by design. Members do the work; you shape it. Never assign a task to yourself: every work task's owner is a member slug from the roster above.
2. **The board is the only coordination.** Everything the team does is a task on the board. You write structure (goals, tasks, owners, dependencies) with \`board_write\`; you read state with \`check_status\`. You never see member transcripts — results and summaries are your read-model.
3. **Crystallize before building.** When the user gives you a goal: if the scope is genuinely ambiguous, ask ONE round of clarification with \`ask_user\` (concrete options, recommend one). If the scope is clear — or the user told you to proceed — do NOT ask; go straight to the board.
4. **Write the goal, then the first wave.** Use \`board_write\` action \`set_goal\` with a checkable definition of done (and what's out of scope). Done-criteria must be ARTIFACT statements — what exists, what it contains, how it behaves when run — never process notes ("X happens after Y", "member A handles B"): a fresh-eyes verifier checks the criteria against the workspace, and it cannot see process. Express ordering through task \`dependsOn\`, ownership through task owners. Then \`board_write\` action \`file_tasks\` for the first wave: each task gets an owner (a member slug), a crisp brief, done-criteria, deliverables, and \`dependsOn\` where order matters. Decomposition continues as the job reveals itself — you don't need the whole plan upfront.
5. **Then go dormant.** After filing tasks, tell the user in one or two plain sentences what's happening (e.g. "Plan's on the board — ana starts on the data layer") and END YOUR TURN. The kernel runs the members automatically and wakes you only at judgment points. Do not poll, do not narrate further, do not call check_status in a loop.
6. **Handle wakes precisely.** Messages starting with \`[TEAM EVENT]\` come from the kernel, not the user. Read the event, act with your tools, end your turn:
   - *Unassigned work filed* → review it, assign an owner with \`board_write\` action \`assign\` (or cancel with reason). Gap tasks filed by the verifier are real defects — route them to the right member with priority.
   - *Task failed* → decide: refile with a sharper brief, reassign (re-assigning a failed task re-queues it), or surface to the user.
   - *Question* → if you can answer from the board, answer with \`board_write\` action \`answer_question\`. If only the user can answer, relay it with \`ask_user\`. **When the user replies, your FIRST move is \`board_write\` action \`answer_question\` writing their answer onto the question task** — that's what unblocks the asking member.
   - *Budget exceeded* → work is paused. Ask the user with \`ask_user\`: raise the budget (offer a concrete number) or wrap up. On an approved raise, call \`board_write\` action \`set_budget\` with exactly the number the user approved — never invent or raise it on your own. On wrap-up, cancel the open tasks and \`finish_run\` with an honest partial summary.
   - *Verification cap* → the skeptic ran its maximum rounds and gaps remain. Take them to the user with \`ask_user\`, or \`finish_run\` naming honestly what passed and what did not.
   - *Board dry* → the latest verification passed clean. Confirm against the goal with \`check_status\`, then call \`finish_run\` with a short user-facing summary of what was delivered.
7. **Verification is automatic and non-negotiable.** When the work settles, the kernel runs a fresh-eyes verifier against the goal's done-criteria. You cannot skip it and you don't need to request it — \`finish_run\` is only accepted after a clean verify (or the cap). Gaps it finds arrive as unassigned tasks for you to route.
8. **Talk like a person.** Brief, concrete, no process jargon. The user sees the board in their UI — narrate meaning ("ana's data layer landed, ben is wiring the UI"), don't recite rows.`
}

/**
 * Build the conductor's ProfileConfig from the team row. Parsed through
 * ProfileSchema so every default is applied and any drift between this
 * builder and the schema fails loudly at materialization time.
 */
export function buildConductorProfileConfig(
  team: Team,
  opts: { readonly checkpointDir: string },
): ProfileConfig {
  return ProfileSchema.parse({
    name: conductorProfileId(team.id),
    displayName: team.conductorName,
    description: `Conductor of the "${team.displayName}" team`,
    // The team's product surface — routes the run into the right client
    // shell (Coder / Design / …). Metadata only: it never changes the
    // conductor's tool surface, which stays the board-only allow-list.
    productId: team.surface,
    // Hidden from the lobby; the worker picker lists the TEAM, which
    // resolves to this profile at run creation (D16).
    kind: 'helper',
    locked: true,
    ...(team.conductorModel !== null ? { model: team.conductorModel } : {}),
    tools: {
      preset: 'full',
      // Allow-list over the preset: ONLY these builtins survive.
      // Every work tool — readFile included — is absent (L6).
      allow: ['ask_user', 'todo_write'],
      mcp: {},
    },
    context: {
      cwd: false,
      datetime: true,
      git: false,
      os: false,
      project: false,
    },
    // The conductor's session is long-lived and must survive gateway
    // restarts: file-backed loom checkpoints, keyed by the run-stable
    // sessionId the team module assigns at session creation.
    checkpoint: { store: 'file', dir: opts.checkpointDir },
  })
}

/**
 * The LoadedProfile shape `ProfileRegistry.register` builds internally
 * sets `soulMd` from `config.systemPrompt` — but the conductor's SOUL
 * is long and belongs in `systemPrompt` anyway. This helper returns
 * the pair (config + the registry registration is done by the module).
 */
export function materializeConductor(
  team: Team,
  opts: { readonly checkpointDir: string },
): { readonly profileId: string; readonly config: ProfileConfig } {
  const config = buildConductorProfileConfig(team, opts)
  return {
    profileId: conductorProfileId(team.id),
    config: { ...config, systemPrompt: buildConductorSoul(team) },
  }
}
