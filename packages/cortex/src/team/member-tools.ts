/**
 * Member team tools — complete_task · file_task · ask_team (L8).
 *
 * Injected into a member's session alongside its profile tools at
 * dispatch time, bound to (run, task, member). Members create work;
 * the Conductor assigns it (L4) — file_task lands unassigned with
 * filedBy tagged. Status stays kernel-written: complete_task routes
 * through the store's owner-checked writer.
 */

import { defineTool, type Tool } from '@ownware/loom'
import {
  AskTeamInputSchema,
  CompleteTaskInputSchema,
  MemberFileTaskInputSchema,
} from './schema.js'
import type { TeamStore } from './store.js'

export interface MemberToolDeps {
  readonly store: TeamStore
  readonly runId: string
  readonly taskId: string
  readonly memberSlug: string
  /** Fired after every successful board mutation — wires the scheduler. */
  readonly onBoardChange: () => void
}

function err(content: string): { content: string; isError: true } {
  return { content, isError: true }
}

function ok(content: string): { content: string; isError: false } {
  return { content, isError: false }
}

export function createMemberTeamTools(deps: MemberToolDeps): Tool[] {
  const { store, runId, taskId, memberSlug, onBoardChange } = deps

  const completeTask = defineTool({
    name: 'complete_task',
    description:
      'Mark YOUR current task done. The result is the handoff: a concise summary (≤120 words) of what you did, ' +
      'naming every artifact path or id a teammate needs. Teammates see this summary, never your transcript. ' +
      'Call this exactly once, when your done-criteria are genuinely met.',
    category: 'custom',
    isReadOnly: false,
    uiDescriptor: {
      kind: 'external-action',
      summary: { verb: 'Completed task', primaryField: 'result' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        result: {
          type: 'string',
          description: 'Concise handoff summary naming artifact paths/ids (≤120 words).',
        },
      },
      required: ['result'],
    },
    async execute(rawInput) {
      const parsed = CompleteTaskInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return err(`complete_task input invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
      }
      const task = store.getTask(taskId)
      if (!task) return err(`Your task vanished from the board — this is a kernel bug.`)
      if (task.status === 'done') return err(`T${task.seq} is already complete. Do not call complete_task again.`)
      try {
        const updated = store.completeTask(memberSlug, taskId, parsed.data.result)
        onBoardChange()
        return ok(`T${updated.seq} "${updated.title}" is done. Your turn is complete — end it now with a one-line confirmation.`)
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  })

  const fileTask = defineTool({
    name: 'file_task',
    description:
      'File newly-discovered work on the team board (work your task revealed but does not cover). ' +
      'It lands unassigned — the Conductor will route it. Do NOT use this for your own task\'s steps.',
    category: 'custom',
    isReadOnly: false,
    uiDescriptor: {
      kind: 'external-action',
      summary: { verb: 'Filed new work', primaryField: 'title' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the discovered work.' },
        brief: { type: 'string', description: 'What needs doing and why — enough for someone else to pick up.' },
        doneCriteria: { type: 'string', description: 'Checkable definition of done, if you can state one.' },
        resourceHints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths / record ids this work will touch.',
        },
      },
      required: ['title', 'brief'],
    },
    async execute(rawInput) {
      const parsed = MemberFileTaskInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return err(`file_task input invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
      }
      const run = store.getRun(runId)
      if (!run || run.status !== 'active') {
        return err(`This run is no longer active; new work cannot be filed.`)
      }
      const task = store.insertTask(runId, {
        kind: 'work',
        title: parsed.data.title,
        brief: parsed.data.brief,
        ...(parsed.data.doneCriteria !== undefined ? { doneCriteria: parsed.data.doneCriteria } : {}),
        resourceHints: parsed.data.resourceHints,
        owner: null,
        filedBy: memberSlug,
        status: 'ready',
      })
      onBoardChange()
      return ok(`Filed T${task.seq} "${task.title}" (unassigned — the Conductor will route it). Continue your own task.`)
    },
  })

  const askTeam = defineTool({
    name: 'ask_team',
    description:
      'Ask the team a question you cannot answer from your brief, the digest, or the artifacts. ' +
      'It is filed on the board and routed by the Conductor (who may relay it to the user). ' +
      'After asking: if you can make progress on other parts of your task, continue; if the question fully blocks you, ' +
      'end your turn — you will be resumed with the answer.',
    category: 'custom',
    isReadOnly: false,
    uiDescriptor: {
      kind: 'external-action',
      summary: { verb: 'Asked the team', primaryField: 'question' },
    },
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, crisply.' },
        context: { type: 'string', description: 'What the answerer needs to know to answer well.' },
      },
      required: ['question'],
    },
    async execute(rawInput) {
      const parsed = AskTeamInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return err(`ask_team input invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
      }
      const run = store.getRun(runId)
      if (!run || run.status !== 'active') {
        return err(`This run is no longer active; questions cannot be filed.`)
      }
      const me = store.getTask(taskId)
      const question = store.insertTask(runId, {
        kind: 'question',
        title: parsed.data.question.length > 120 ? `${parsed.data.question.slice(0, 119)}…` : parsed.data.question,
        brief: parsed.data.context
          ? `${parsed.data.question}\n\nContext: ${parsed.data.context}`
          : parsed.data.question,
        parentId: me?.id ?? null,
        owner: null,
        filedBy: memberSlug,
        status: 'ready',
      })
      onBoardChange()
      return ok(
        `Question filed as T${question.seq}. If you can progress without the answer, continue; ` +
          `if you are fully blocked, end your turn now — you will be resumed when the answer lands.`,
      )
    },
  })

  return [completeTask, fileTask, askTeam]
}
