/**
 * Conductor tools — board_write · check_status · finish_run (L6).
 *
 * Cortex-owned loom Tools (the remember-tool / plan-tools pattern),
 * bound to one run at session-creation time by the team module. All
 * board mutations go through TeamStore, which enforces the writer
 * discipline; every mutation notifies the scheduler so deterministic
 * dispatch happens immediately — the Conductor never schedules.
 */

import { defineTool, type Tool } from '@ownware/loom'
import {
  BoardWriteInputSchema,
  FinishRunInputSchema,
  OPEN_TASK_STATUSES,
  TEAM_TASK_STATUSES,
  type TeamRunReceipt,
  type TeamTask,
  type TeamTaskStatus,
} from './schema.js'
import type { TeamStore } from './store.js'
import { renderBoardForConductor } from './digest.js'

export interface ConductorToolDeps {
  readonly store: TeamStore
  readonly runId: string
  /** Fired after every successful board mutation — wires the scheduler. */
  readonly onBoardChange: () => void
}

/** Resolve a "T<seq>" reference (case-insensitive, "T3" or "3"). */
function resolveTaskRef(store: TeamStore, runId: string, ref: string): TeamTask | null {
  const match = /^[tT]?(\d+)$/.exec(ref.trim())
  if (!match) return null
  return store.getTaskBySeq(runId, Number(match[1]))
}

function err(content: string): { content: string; isError: true } {
  return { content, isError: true }
}

function ok(content: string): { content: string; isError: false } {
  return { content, isError: false }
}

export function createConductorTools(deps: ConductorToolDeps): Tool[] {
  const { store, runId, onBoardChange } = deps

  const boardWrite = defineTool({
    name: 'board_write',
    description:
      'Write structure to the team board. Actions: set_goal (the crystallized goal with checkable done-criteria), ' +
      'file_tasks (a wave of work tasks with owner/deps/criteria — owners are member slugs, never yourself), ' +
      'assign (give an unassigned task an owner), update (edit structure fields), ' +
      'answer_question (write an answer onto a question task), cancel (cancel a task with a reason), ' +
      'set_budget (raise the per-run budget cap — ONLY after the user explicitly approved the new number). ' +
      'Task references are "T<seq>" (e.g. "T3"). The kernel schedules members automatically after every write.',
    category: 'custom',
    isReadOnly: false,
    uiDescriptor: {
      kind: 'external-action',
      summary: { verb: 'Wrote to the board', primaryField: 'action' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set_goal', 'file_tasks', 'assign', 'update', 'answer_question', 'cancel', 'set_budget'],
        },
        title: { type: 'string', description: 'set_goal/update: title' },
        brief: { type: 'string', description: 'set_goal/update: what and why' },
        doneCriteria: { type: 'string', description: 'set_goal/update: checkable definition of done' },
        outOfScope: { type: 'string', description: 'set_goal: explicitly out of scope' },
        deliverables: { type: 'array', items: { type: 'string' }, description: 'named artifact keys' },
        tasks: {
          type: 'array',
          description: 'file_tasks: the wave. Each task needs localId, title, brief, doneCriteria, owner (member slug); dependsOn may reference "T<seq>" or other localIds in this batch.',
          items: {
            type: 'object',
            properties: {
              localId: { type: 'string' },
              title: { type: 'string' },
              brief: { type: 'string' },
              doneCriteria: { type: 'string' },
              deliverables: { type: 'array', items: { type: 'string' } },
              dependsOn: { type: 'array', items: { type: 'string' } },
              owner: { type: 'string' },
              resourceHints: { type: 'array', items: { type: 'string' } },
            },
            required: ['localId', 'title', 'brief', 'doneCriteria', 'owner'],
          },
        },
        taskRef: { type: 'string', description: 'assign/update/answer_question/cancel: "T<seq>"' },
        owner: { type: 'string', description: 'assign: member slug' },
        answer: { type: 'string', description: 'answer_question: the answer' },
        reason: { type: 'string', description: 'cancel: why' },
        resourceHints: { type: 'array', items: { type: 'string' } },
        maxCostUsd: {
          type: 'number',
          description: 'set_budget: the new per-run budget cap in USD — ONLY after the user explicitly approved this number.',
        },
      },
      required: ['action'],
    },
    async execute(rawInput) {
      const parsed = BoardWriteInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return err(`board_write input invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
      }
      const input = parsed.data

      const run = store.getRun(runId)
      if (!run) return err(`Team run "${runId}" not found — this is a kernel bug.`)
      if (run.status !== 'active') {
        return err(`This run is ${run.status}. The board is closed; no further writes.`)
      }
      const team = store.getTeam(run.teamId)
      if (!team) return err(`Team "${run.teamId}" not found — this is a kernel bug.`)
      const memberSlugs = new Set(team.members.map((m) => m.slug))

      switch (input.action) {
        case 'set_goal': {
          const existing = store.listTasks(runId).find((t) => t.kind === 'goal')
          const brief = input.outOfScope
            ? `${input.brief}\n\nOut of scope: ${input.outOfScope}`
            : input.brief
          if (existing) {
            store.updateTaskStructure(existing.id, {
              title: input.title,
              brief,
              doneCriteria: input.doneCriteria,
              deliverables: input.deliverables,
            })
            onBoardChange()
            return ok(`Goal T${existing.seq} updated: "${input.title}".`)
          }
          const goal = store.insertTask(runId, {
            kind: 'goal',
            title: input.title,
            brief,
            doneCriteria: input.doneCriteria,
            deliverables: input.deliverables,
            filedBy: 'conductor',
            status: 'active',
          })
          onBoardChange()
          return ok(`Goal written as T${goal.seq}: "${goal.title}". Now file the first wave of tasks.`)
        }

        case 'file_tasks': {
          // Validate owners + dependency references BEFORE inserting
          // anything — a wave is filed atomically or not at all.
          const localIds = new Set(input.tasks.map((t) => t.localId))
          for (const t of input.tasks) {
            if (!memberSlugs.has(t.owner)) {
              return err(
                `Task "${t.title}": owner "${t.owner}" is not on the roster. Members: ${[...memberSlugs].join(', ')}. You can never assign yourself.`,
              )
            }
            for (const dep of t.dependsOn) {
              const isLocal = localIds.has(dep)
              const existing = isLocal ? null : resolveTaskRef(store, runId, dep)
              if (!isLocal && !existing) {
                return err(`Task "${t.title}": dependency "${dep}" is neither a localId in this batch nor an existing "T<seq>".`)
              }
            }
          }
          const filed: Array<{ localId: string; task: TeamTask }> = []
          const idByLocal = new Map<string, string>()
          for (const t of input.tasks) {
            const dependsOn = t.dependsOn.map((dep) => {
              const local = idByLocal.get(dep)
              if (local) return local
              const existing = resolveTaskRef(store, runId, dep)
              if (existing) return existing.id
              // Forward reference within the batch: defer resolution.
              return `local:${dep}`
            })
            const task = store.insertTask(runId, {
              kind: 'work',
              title: t.title,
              brief: t.brief,
              doneCriteria: t.doneCriteria,
              deliverables: t.deliverables,
              dependsOn,
              owner: t.owner,
              filedBy: 'conductor',
              resourceHints: t.resourceHints,
              status: 'ready',
            })
            idByLocal.set(t.localId, task.id)
            filed.push({ localId: t.localId, task })
          }
          // Second pass: resolve forward references now every batch
          // member has a real id.
          for (const { task } of filed) {
            if (task.dependsOn.some((d) => d.startsWith('local:'))) {
              const resolved = task.dependsOn.map((d) => {
                if (!d.startsWith('local:')) return d
                const real = idByLocal.get(d.slice('local:'.length))
                if (!real) throw new Error(`Unresolved batch dependency "${d}" on T${task.seq}`)
                return real
              })
              store.updateTaskStructure(task.id, { dependsOn: resolved })
            }
          }
          onBoardChange()
          const lines = filed.map(
            ({ localId, task }) => `${localId} → T${task.seq} "${task.title}" (owner: ${task.owner})`,
          )
          return ok(`Filed ${filed.length} task(s):\n${lines.join('\n')}\nThe kernel starts members automatically — end your turn after updating the user.`)
        }

        case 'assign': {
          const task = resolveTaskRef(store, runId, input.taskRef)
          if (!task) return err(`No task "${input.taskRef}" on this board.`)
          if (!memberSlugs.has(input.owner)) {
            return err(`"${input.owner}" is not on the roster. Members: ${[...memberSlugs].join(', ')}.`)
          }
          if (task.status === 'done' || task.status === 'cancelled') {
            return err(`T${task.seq} is ${task.status}; assignment is moot.`)
          }
          store.assignTask(task.id, input.owner)
          // Re-assigning a failed task is the retry gesture: the kernel
          // puts it back in the schedulable pool.
          if (task.status === 'failed') {
            store.setTaskStatus(task.id, 'ready')
          }
          onBoardChange()
          return ok(`T${task.seq} "${task.title}" assigned to ${input.owner}${task.status === 'failed' ? ' and re-queued' : ''}.`)
        }

        case 'update': {
          const task = resolveTaskRef(store, runId, input.taskRef)
          if (!task) return err(`No task "${input.taskRef}" on this board.`)
          store.updateTaskStructure(task.id, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.brief !== undefined ? { brief: input.brief } : {}),
            ...(input.doneCriteria !== undefined ? { doneCriteria: input.doneCriteria } : {}),
            ...(input.deliverables !== undefined ? { deliverables: input.deliverables } : {}),
            ...(input.resourceHints !== undefined ? { resourceHints: input.resourceHints } : {}),
          })
          onBoardChange()
          return ok(`T${task.seq} updated.`)
        }

        case 'answer_question': {
          const task = resolveTaskRef(store, runId, input.taskRef)
          if (!task) return err(`No task "${input.taskRef}" on this board.`)
          if (task.kind !== 'question') return err(`T${task.seq} is a ${task.kind} task, not a question.`)
          if (task.status === 'done') return err(`T${task.seq} is already answered.`)
          store.answerQuestion(task.id, input.answer)
          onBoardChange()
          return ok(`Answer written to T${task.seq}. The asker sees it in their next digest; any blocked task resumes automatically.`)
        }

        case 'cancel': {
          const task = resolveTaskRef(store, runId, input.taskRef)
          if (!task) return err(`No task "${input.taskRef}" on this board.`)
          if (task.kind === 'goal') return err(`The goal cannot be cancelled — re-scope it with set_goal, or finish the run.`)
          if (task.status === 'done' || task.status === 'cancelled') {
            return err(`T${task.seq} is already ${task.status}.`)
          }
          store.setTaskStatus(task.id, 'cancelled', input.reason)
          onBoardChange()
          return ok(`T${task.seq} cancelled: ${input.reason}`)
        }

        case 'set_budget': {
          // Trust boundary note: only call this after the USER explicitly
          // approved the new number (the SOUL binds it; the kernel can't
          // verify chat consent). The cap is per-run, never the team's
          // standing config.
          store.setRunBudget(runId, input.maxCostUsd)
          onBoardChange()
          return ok(
            `Run budget set to $${input.maxCostUsd.toFixed(2)}. Work resumes automatically if it was paused on budget.`,
          )
        }
      }
    },
  })

  const checkStatus = defineTool({
    name: 'check_status',
    description:
      'Read the team board: the goal, every task with owner/status/dependencies, and result summaries. ' +
      'This is your whole read-model — you never see member transcripts.',
    category: 'custom',
    isReadOnly: true,
    uiDescriptor: {
      kind: 'external-action',
      summary: { verb: 'Checked the board', primaryField: 'action' },
    },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      const run = store.getRun(runId)
      if (!run) return err(`Team run "${runId}" not found — this is a kernel bug.`)
      const team = store.getTeam(run.teamId)
      if (!team) return err(`Team "${run.teamId}" not found — this is a kernel bug.`)
      return ok(renderBoardForConductor(team, run, store.listTasks(runId), store.listLeases(runId)))
    },
  })

  const finishRun = defineTool({
    name: 'finish_run',
    description:
      'Close the run when the goal is genuinely done: every task settled and the results cover the done-criteria. ' +
      'Writes the receipt the user sees on the team card. Fails (and tells you what is open) if work remains.',
    category: 'custom',
    isReadOnly: false,
    uiDescriptor: {
      kind: 'external-action',
      summary: { verb: 'Finished the run', primaryField: 'summary' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Short user-facing summary of what was delivered (plain language).',
        },
      },
      required: ['summary'],
    },
    async execute(rawInput) {
      const parsed = FinishRunInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return err(`finish_run input invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
      }
      const run = store.getRun(runId)
      if (!run) return err(`Team run "${runId}" not found — this is a kernel bug.`)
      if (run.status !== 'active') return err(`This run is already ${run.status}.`)

      const tasks = store.listTasks(runId)
      const open = tasks.filter((t) => t.kind !== 'goal' && OPEN_TASK_STATUSES.has(t.status))
      if (open.length > 0) {
        return err(
          `Cannot finish — ${open.length} task(s) still open:\n` +
            open.map((t) => `T${t.seq} "${t.title}" — ${t.owner ?? 'unassigned'} — ${t.status}`).join('\n') +
            `\nResolve them (wait for completion, cancel with reason, or reassign) before finishing.`,
        )
      }

      const goal = tasks.find((t) => t.kind === 'goal')
      if (!goal) return err(`No goal on the board — nothing to finish. Write the goal first.`)

      // L9's termination rule, enforced: done = board settled AND the
      // latest verify passed with no work filed after it. The kernel
      // runs verify rounds automatically when work settles — the
      // Conductor cannot skip the skeptic. Exception: a run with zero
      // completed work has nothing to verify (pure-conversation runs).
      const doneWork = tasks.filter((t) => t.kind === 'work' && t.status === 'done')
      if (doneWork.length > 0) {
        const verifies = tasks.filter((t) => t.kind === 'verify')
        const latestVerify = verifies[verifies.length - 1]
        const verifiedClean =
          latestVerify !== undefined &&
          latestVerify.status === 'done' &&
          !tasks.some((t) => t.kind === 'work' && t.createdAt > latestVerify.createdAt)
        const capReached = verifies.length >= 3
        if (!verifiedClean && !capReached) {
          return err(
            'Cannot finish — the work has not passed verification yet. The kernel files a verify round ' +
              'automatically when the board settles; end your turn and you will be woken with the verdict.',
          )
        }
      }
      if (goal.status === 'active') store.setTaskStatus(goal.id, 'done')

      const taskCounts = Object.fromEntries(
        TEAM_TASK_STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length]),
      ) as Record<TeamTaskStatus, number>

      const receipt: TeamRunReceipt = {
        summary: parsed.data.summary,
        outcome: 'done',
        taskCounts,
        costUsd: store.getRun(runId)?.costUsd ?? run.costUsd,
        durationMs: Date.now() - new Date(run.createdAt).getTime(),
      }
      store.setRunStatus(runId, 'done', receipt)
      onBoardChange()
      return ok(`Run finished. Receipt recorded. Give the user your closing summary in plain language.`)
    },
  })

  return [boardWrite, checkStatus, finishRun]
}
