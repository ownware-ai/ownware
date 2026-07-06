/**
 * Team vertical — schemas and types.
 *
 * One new vertical per root CLAUDE.md Principle 22: teams own their
 * tables (`teams`, `team_members`, `team_runs`, `team_tasks`,
 * `team_leases` — migration 035), their zod schemas (this file), their
 * gateway handlers, and nothing else. The `threads` and `profiles`
 * tables stay untouched — a team run binds to a thread via
 * `team_runs.thread_id` (the `thread_designs` join pattern).
 *
 * Naming is locked:
 * the shared state is the **Board**; every row on it is a task.
 *
 * Writer discipline (L3, enforced by the store, not by convention):
 *   - filer writes kind/title/brief/resourceHints at filing time
 *   - the Conductor (via board_write) owns structure: doneCriteria,
 *     deliverables, dependsOn, owner — and `owner` is always a member
 *   - the KERNEL alone writes `status` (derived from events)
 *   - the task's owner alone writes `result`
 */

import { z } from 'zod'
import { productSlugSchema } from '../product/manifest.js'

// ---------------------------------------------------------------------------
// Task — everything on the board is one of these (L2)
// ---------------------------------------------------------------------------

export const TEAM_TASK_KINDS = ['goal', 'work', 'question', 'verify'] as const
export type TeamTaskKind = (typeof TEAM_TASK_KINDS)[number]

export const TEAM_TASK_STATUSES = [
  'draft',
  'ready',
  'active',
  'blocked',
  'review',
  'done',
  'failed',
  'cancelled',
] as const
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number]

/** Statuses that count as "open" for the termination rule (L9). */
export const OPEN_TASK_STATUSES: ReadonlySet<TeamTaskStatus> = new Set([
  'draft',
  'ready',
  'active',
  'blocked',
  'review',
])

/**
 * Legal kernel status transitions. The store rejects anything else —
 * a wrong transition is a kernel bug and must fail loudly, never
 * silently coerce (Principle 21).
 */
export const TASK_STATUS_TRANSITIONS: Readonly<
  Record<TeamTaskStatus, readonly TeamTaskStatus[]>
> = {
  draft: ['ready', 'cancelled'],
  // ready → done is the direct path for question tasks answered by the
  // Conductor without a working session (board_write answer_question).
  ready: ['active', 'blocked', 'done', 'cancelled'],
  active: ['done', 'failed', 'blocked', 'ready', 'cancelled'],
  blocked: ['ready', 'cancelled', 'failed'],
  review: ['done', 'failed', 'cancelled'],
  done: [],
  failed: ['ready', 'cancelled'],
  cancelled: [],
}

export interface TeamTask {
  readonly id: string
  readonly runId: string
  /** Per-run ordinal — rendered as T1, T2, … everywhere humans look. */
  readonly seq: number
  /** Parent task id — a question filed from inside a work task points here. */
  readonly parentId: string | null
  readonly kind: TeamTaskKind
  readonly title: string
  readonly brief: string
  readonly doneCriteria: string
  readonly deliverables: readonly string[]
  /** Task ids this task waits on. Results of these are this task's inputs. */
  readonly dependsOn: readonly string[]
  /** Member slug. Never 'conductor' for work tasks (L3). Null = unassigned. */
  readonly owner: string | null
  /** 'user' | 'conductor' | member slug | 'verifier' */
  readonly filedBy: string
  /** Advisory scope (paths / record ids) for the scheduler. Not enforcement. */
  readonly resourceHints: readonly string[]
  readonly status: TeamTaskStatus
  /** Bounded summary written by the owner at completion — the handoff. */
  readonly result: string | null
  readonly blockedReason: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

// ---------------------------------------------------------------------------
// Team (configuration — built in the Companies section, durable)
// ---------------------------------------------------------------------------

/**
 * Named instruction fragments (D26) — the company's brain in plain
 * pieces, each authored in its own focused editor. All optional; the
 * legacy freeform `charter` remains the fallback for teams authored
 * before fragments existed.
 */
export const TeamFragmentsSchema = z
  .object({
    identity: z.string().max(4_000).optional(),
    principles: z.string().max(4_000).optional(),
    workflow: z.string().max(4_000).optional(),
    doneMeans: z.string().max(4_000).optional(),
    rules: z.string().max(4_000).optional(),
    voice: z.string().max(4_000).optional(),
  })
  .strict()

export type TeamFragments = z.infer<typeof TeamFragmentsSchema>

/**
 * A standing reference document the team always has on hand — a style
 * guide, an API contract, a brief. Injected (bounded) into the
 * conductor's SOUL and every member handoff so the whole team works
 * from the same source. Content is capped to keep standing context
 * economical (≤8k chars each, ≤6 docs per team).
 */
export const TeamReferenceSchema = z
  .object({
    name: z.string().min(1).max(120),
    content: z.string().min(1).max(8_000),
  })
  .strict()

export type TeamReference = z.infer<typeof TeamReferenceSchema>

/**
 * A member's autonomy on the team — enforced as TOOL ACCESS, not a
 * permission prompt. A team run is headless (no human to answer a
 * mid-task `ask`), so capability is governed by which tools the member
 * is assembled with, at the cortex security boundary:
 *   - inherit   — the member's full profile tool surface.
 *   - read-only — only read tools survive; it physically cannot mutate
 *                 the workspace (stronger than an unanswerable prompt).
 * (A "can publish / ask the lead before out-of-workspace actions" tier
 *  needs a member→conductor approval gate that does not exist yet — it
 *  is a separate future slice, not faked here.)
 */
export const TEAM_MEMBER_AUTONOMIES = ['inherit', 'read-only'] as const
export type TeamMemberAutonomy = (typeof TEAM_MEMBER_AUTONOMIES)[number]

export const TeamMemberSchema = z
  .object({
    /** Short handle used on the board and in digests, e.g. "maya". */
    slug: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase kebab-case'),
    /** Registered profile this member runs as. */
    profileId: z.string().min(1),
    /** Role line shown to the Conductor and in digests, e.g. "Frontend". */
    role: z.string().min(1).max(120),
    /** Optional per-team instructions overlaid on the member's handoff. */
    instructions: z.string().max(4_000).optional(),
    /** Optional model override for this member within this team. */
    model: z.string().min(1).optional(),
    /** Capability on the team — enforced by tool access (see above). */
    autonomy: z.enum(TEAM_MEMBER_AUTONOMIES).default('inherit'),
    /** Tool-name globs removed from this member's surface on the team. */
    toolRestricts: z.array(z.string().min(1).max(100)).max(40).default([]),
  })
  .strict()

export type TeamMember = z.infer<typeof TeamMemberSchema>

/**
 * How closely the Conductor leans on the user at judgment points
 * (inside-company conductor modal — "When members are unsure"):
 *   - balanced     — resolve routine coordination alone; bring scope,
 *                    budget, and any out-of-workspace action to the user.
 *   - autonomous   — minimize interruptions; only stop the user for a
 *                    hard budget limit or an action that leaves the
 *                    workspace (deploy / send / publish).
 *   - consultative — check in with the user at each judgment point
 *                    (unassigned work, a failure, a verifier gap, scope).
 */
export const TEAM_CONDUCTOR_ESCALATIONS = ['balanced', 'autonomous', 'consultative'] as const
export type TeamConductorEscalation = (typeof TEAM_CONDUCTOR_ESCALATIONS)[number]

export const CreateTeamSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'name must be lowercase kebab-case'),
    displayName: z.string().min(1).max(120),
    /** Standing charter — who this team is, how it works. Per-run goals live on the board. */
    charter: z.string().max(8_000).default(''),
    /** Named instruction fragments (D26). */
    fragments: TeamFragmentsSchema.default({}),
    conductorName: z.string().min(1).max(60).default('Juno'),
    /** Conductor model. Default resolved at run time (strongest available, L12). */
    conductorModel: z.string().min(1).optional(),
    /** How closely the lead leans on the user at judgment points. */
    conductorEscalation: z.enum(TEAM_CONDUCTOR_ESCALATIONS).default('balanced'),
    /** Free-text extra instructions for the lead, woven into its brief. */
    conductorInstructions: z.string().max(4_000).optional(),
    /** Product surface the team runs in — routes the run's shell, not its tools. */
    surface: productSlugSchema.default('ownware'),
    /** Standing reference docs the whole team works from. */
    references: z.array(TeamReferenceSchema).max(6).default([]),
    /**
     * Composio toolkit slugs (e.g. "gmail", "github") granted to every
     * member — merged additively into each member's own composio toolkits
     * at assembly. A member only gets a toolkit's tools if its entity has
     * that toolkit connected (the grant never bypasses auth). MCP-server
     * grants are a separate future slice (they need id→config resolution).
     */
    composioToolkits: z.array(z.string().min(1).max(80)).max(20).default([]),
    maxCostUsd: z.number().positive().optional(),
    members: z.array(TeamMemberSchema).min(1).max(12),
  })
  .strict()
  .superRefine((team, ctx) => {
    const slugs = new Set<string>()
    for (const m of team.members) {
      if (slugs.has(m.slug)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate member slug "${m.slug}"`,
        })
      }
      slugs.add(m.slug)
    }
  })

export type CreateTeamInput = z.infer<typeof CreateTeamSchema>

export const UpdateTeamSchema = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    charter: z.string().max(8_000).optional(),
    fragments: TeamFragmentsSchema.optional(),
    conductorName: z.string().min(1).max(60).optional(),
    conductorModel: z.string().min(1).nullable().optional(),
    conductorEscalation: z.enum(TEAM_CONDUCTOR_ESCALATIONS).optional(),
    conductorInstructions: z.string().max(4_000).nullable().optional(),
    surface: productSlugSchema.optional(),
    references: z.array(TeamReferenceSchema).max(6).optional(),
    composioToolkits: z.array(z.string().min(1).max(80)).max(20).optional(),
    maxCostUsd: z.number().positive().nullable().optional(),
    members: z.array(TeamMemberSchema).min(1).max(12).optional(),
  })
  .strict()

export type UpdateTeamInput = z.infer<typeof UpdateTeamSchema>

export interface Team {
  readonly id: string
  readonly name: string
  readonly displayName: string
  readonly charter: string
  readonly fragments: TeamFragments
  readonly conductorName: string
  readonly conductorModel: string | null
  readonly conductorEscalation: TeamConductorEscalation
  readonly conductorInstructions: string | null
  readonly surface: string
  readonly references: readonly TeamReference[]
  readonly composioToolkits: readonly string[]
  readonly maxCostUsd: number | null
  readonly members: readonly TeamMember[]
  readonly createdAt: string
  readonly updatedAt: string
}

// ---------------------------------------------------------------------------
// Run — one goal's lifecycle on one board, bound to one thread
// ---------------------------------------------------------------------------

export const TEAM_RUN_STATUSES = ['active', 'done', 'failed', 'cancelled'] as const
export type TeamRunStatus = (typeof TEAM_RUN_STATUSES)[number]

/** Receipt written by finish_run — feeds the directory's "last run" card. */
export interface TeamRunReceipt {
  readonly summary: string
  readonly outcome: 'done' | 'failed'
  readonly taskCounts: Readonly<Record<TeamTaskStatus, number>>
  readonly costUsd: number
  readonly durationMs: number
}

export interface TeamRun {
  readonly id: string
  readonly teamId: string
  readonly threadId: string
  readonly workspaceId: string | null
  readonly status: TeamRunStatus
  /** Member + verifier session spend (conductor turns live on the thread). */
  readonly costUsd: number
  /** Per-run cap (seeded from the team; raised via set_budget). Null = no cap. */
  readonly maxCostUsd: number | null
  readonly receipt: TeamRunReceipt | null
  readonly createdAt: string
  readonly updatedAt: string
}

// ---------------------------------------------------------------------------
// Lease (D7/D8) — single writer per resource, derived from tool args
// ---------------------------------------------------------------------------

export interface TeamLease {
  readonly runId: string
  /** Canonical resource key — e.g. an absolute file path. */
  readonly resourceKey: string
  /** The task whose work holds this resource (lease is task-scoped). */
  readonly taskId: string
  /** Member slug holding it. */
  readonly agentId: string
  /** Renewed by ANY tool call from the holder (the free heartbeat). */
  readonly lastActivityAt: string
}

// ---------------------------------------------------------------------------
// Tool inputs — validated with zod inside each tool's execute()
// (the JSON Schema on the Tool object is for the model; this is the boundary)
// ---------------------------------------------------------------------------

/** A task as the Conductor files it in a board_write file_tasks batch. */
export const FileTaskEntrySchema = z
  .object({
    /** Batch-local handle so later entries can depend on earlier ones. */
    localId: z.string().min(1).max(20),
    title: z.string().min(1).max(200),
    brief: z.string().min(1).max(4_000),
    doneCriteria: z.string().min(1).max(2_000),
    deliverables: z.array(z.string().min(1).max(300)).max(20).default([]),
    /** "T<seq>" refs to existing tasks, or localIds within this batch. */
    dependsOn: z.array(z.string().min(1).max(20)).max(20).default([]),
    /** Member slug. The Conductor never assigns itself (L3). */
    owner: z.string().min(1).max(40),
    resourceHints: z.array(z.string().min(1).max(300)).max(20).default([]),
  })
  .strict()

export const BoardWriteInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('set_goal'),
      title: z.string().min(1).max(200),
      brief: z.string().min(1).max(4_000),
      doneCriteria: z.string().min(1).max(4_000),
      outOfScope: z.string().max(2_000).optional(),
      deliverables: z.array(z.string().min(1).max(300)).max(20).default([]),
    })
    .strict(),
  z
    .object({
      action: z.literal('file_tasks'),
      tasks: z.array(FileTaskEntrySchema).min(1).max(20),
    })
    .strict(),
  z
    .object({
      action: z.literal('assign'),
      taskRef: z.string().min(1).max(20),
      owner: z.string().min(1).max(40),
    })
    .strict(),
  z
    .object({
      action: z.literal('update'),
      taskRef: z.string().min(1).max(20),
      title: z.string().min(1).max(200).optional(),
      brief: z.string().min(1).max(4_000).optional(),
      doneCriteria: z.string().min(1).max(2_000).optional(),
      deliverables: z.array(z.string().min(1).max(300)).max(20).optional(),
      resourceHints: z.array(z.string().min(1).max(300)).max(20).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('answer_question'),
      taskRef: z.string().min(1).max(20),
      answer: z.string().min(1).max(4_000),
    })
    .strict(),
  z
    .object({
      action: z.literal('cancel'),
      taskRef: z.string().min(1).max(20),
      reason: z.string().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      action: z.literal('set_budget'),
      maxCostUsd: z.number().positive(),
    })
    .strict(),
])

export type BoardWriteInput = z.infer<typeof BoardWriteInputSchema>

export const FinishRunInputSchema = z
  .object({
    summary: z.string().min(1).max(4_000),
  })
  .strict()

export const CompleteTaskInputSchema = z
  .object({
    result: z.string().min(1).max(4_000),
  })
  .strict()

export const MemberFileTaskInputSchema = z
  .object({
    title: z.string().min(1).max(200),
    brief: z.string().min(1).max(4_000),
    doneCriteria: z.string().max(2_000).optional(),
    resourceHints: z.array(z.string().min(1).max(300)).max(20).default([]),
  })
  .strict()

export const AskTeamInputSchema = z
  .object({
    question: z.string().min(1).max(2_000),
    /** Optional context the answerer needs. */
    context: z.string().max(2_000).optional(),
  })
  .strict()

// ---------------------------------------------------------------------------
// Wire types (gateway responses)
// ---------------------------------------------------------------------------

export interface TeamSummary {
  readonly id: string
  readonly name: string
  readonly displayName: string
  readonly conductorName: string
  /** Product surface the team runs in (catalog slug) — the "runs on" label. */
  readonly surface: string
  /** Serif mission line for the directory band — first line of the
   *  Identity fragment, else of the legacy charter. Null when unset. */
  readonly mission: string | null
  readonly memberCount: number
  readonly members: ReadonlyArray<Pick<TeamMember, 'slug' | 'profileId' | 'role'>>
  readonly lastRun: {
    readonly runId: string
    readonly status: TeamRunStatus
    readonly receipt: TeamRunReceipt | null
    readonly updatedAt: string
  } | null
}

export interface BoardView {
  readonly run: TeamRun
  readonly teamId: string
  readonly teamName: string
  readonly tasks: readonly TeamTask[]
}
