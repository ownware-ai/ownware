/**
 * `board_update` — one small, atomic change to an existing board during
 * execution. The cheap counterpart to `board_write`: never re-sends the
 * whole board (that's the failure-amplifier we avoid — decision D6).
 *
 * Four actions:
 *   - slice_status   — set a slice running / done / failed / skipped
 *   - board_status   — move the board's lifecycle (awaiting / running / paused / done / archived)
 *   - add_finding    — log a bug/note hit mid-build
 *   - finding_status — resolve / defer a finding
 *
 * Cortex-side, bound per session to the board store (same wiring as
 * `board_write`). A board carries its own workspace, so this tool only
 * needs the store + the boardId passed in each call.
 */

import { z } from 'zod'
import { defineTool, type Tool } from '@ownware/loom'
import type { SqliteBoardStore } from './store.js'
import {
  BoardStatusSchema,
  FindingStatusSchema,
  SliceStatusSchema,
} from './event-bus.js'

export interface BoardUpdateDeps {
  readonly store: SqliteBoardStore
}

const BoardUpdateInputSchema = z.intersection(
  z.object({ boardId: z.string().min(1, 'boardId must be non-empty') }),
  z.discriminatedUnion('action', [
    z.object({
      action: z.literal('slice_status'),
      sliceId: z.string().min(1),
      status: SliceStatusSchema,
    }),
    z.object({
      action: z.literal('board_status'),
      status: BoardStatusSchema,
    }),
    z.object({
      action: z.literal('add_finding'),
      title: z.string().min(1),
      detail: z.string().optional(),
      sliceId: z.string().min(1).optional(),
    }),
    z.object({
      action: z.literal('finding_status'),
      findingId: z.string().min(1),
      status: FindingStatusSchema,
    }),
  ]),
)

const BOARD_UPDATE_DESCRIPTION = `Make ONE small change to an existing board as you work it. Atomic and cheap — never re-send the whole board (use \`board_write\` only to (re)draft the structure).

## Actions (pick exactly one via \`action\`)
- \`slice_status\` — set a slice's status as you work it. Needs \`sliceId\` + \`status\` (one of: queued, running, done, failed, skipped).
- \`board_status\` — move the board's lifecycle. Needs \`status\` (one of: awaiting = presenting for approval, running = approved & started, paused = stopping mid-way, done = all verified, archived).
- \`add_finding\` — log a bug/note you hit mid-build. Needs \`title\`; optional \`detail\` and \`sliceId\` (the slice you found it in).
- \`finding_status\` — resolve or defer a finding. Needs \`findingId\` + \`status\` (open, deferred, resolved).

Slice and finding ids come from the \`board_write\` result and the board snapshot. Set the board \`running\` only after the user approves.`

export function createBoardUpdateTool(deps: BoardUpdateDeps): Tool {
  return defineTool({
    name: 'board_update',
    description: BOARD_UPDATE_DESCRIPTION,
    category: 'custom',
    isReadOnly: false,
    requiresPermission: false,
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string', description: 'Id of the board to update (from board_write).' },
        action: {
          type: 'string',
          enum: ['slice_status', 'board_status', 'add_finding', 'finding_status'],
          description: 'Which atomic change to make.',
        },
        sliceId: { type: 'string', description: 'Slice id — for action=slice_status, or to attribute a finding.' },
        findingId: { type: 'string', description: 'Finding id — for action=finding_status.' },
        status: {
          type: 'string',
          description:
            'New status. slice_status: queued|running|done|failed|skipped. board_status: awaiting|running|paused|done|archived. finding_status: open|deferred|resolved.',
        },
        title: { type: 'string', description: 'Finding title — for action=add_finding.' },
        detail: { type: 'string', description: 'Finding detail — for action=add_finding.' },
      },
      required: ['boardId', 'action'],
    },
    async execute(input) {
      const parsed = BoardUpdateInputSchema.safeParse(input)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        return {
          content: `Invalid input: ${issue?.path.join('.') ?? 'input'}: ${issue?.message ?? 'unknown'}`,
          isError: true,
        }
      }
      const data = parsed.data
      const { boardId } = data

      switch (data.action) {
        case 'slice_status': {
          const board = deps.store.updateSliceStatus(boardId, data.sliceId, data.status)
          if (board == null) {
            return { content: `Slice "${data.sliceId}" not found on board "${boardId}".`, isError: true }
          }
          return {
            content: `Slice set to ${data.status}.`,
            isError: false,
            metadata: { boardId, sliceId: data.sliceId, status: data.status },
          }
        }
        case 'board_status': {
          const board = deps.store.setBoardStatus(boardId, data.status)
          if (board == null) {
            return { content: `Board "${boardId}" not found.`, isError: true }
          }
          return {
            content: `Board moved to ${data.status}.`,
            isError: false,
            metadata: { boardId, status: data.status },
          }
        }
        case 'add_finding': {
          const board = deps.store.addFinding(boardId, {
            title: data.title,
            ...(data.detail != null ? { detail: data.detail } : {}),
            ...(data.sliceId != null ? { sliceId: data.sliceId } : {}),
          })
          if (board == null) {
            return { content: `Board "${boardId}" not found.`, isError: true }
          }
          const finding = board.findings[board.findings.length - 1]
          return {
            content: `Finding logged: "${data.title}".`,
            isError: false,
            metadata: { boardId, findingId: finding?.id },
          }
        }
        case 'finding_status': {
          const board = deps.store.updateFindingStatus(boardId, data.findingId, data.status)
          if (board == null) {
            return { content: `Finding "${data.findingId}" not found on board "${boardId}".`, isError: true }
          }
          return {
            content: `Finding set to ${data.status}.`,
            isError: false,
            metadata: { boardId, findingId: data.findingId, status: data.status },
          }
        }
      }
    },
  })
}
