/**
 * Boards — the top rung of the work ladder (todo → plan → BOARD).
 * Barrel + the per-session tool factory.
 *
 * A board is a whole effort: a goal + approach + ordered slices the
 * agent works one-by-one, plus findings logged mid-build. Cortex-side
 * (Ownware convention; Loom stays domain-neutral).
 */

import type { Tool } from '@ownware/loom'
import type { SqliteBoardStore } from './store.js'
import { createBoardWriteTool } from './write-tool.js'
import { createBoardUpdateTool } from './update-tool.js'

export * from './event-bus.js'
export { SqliteBoardStore } from './store.js'
export type {
  BoardStructureInput,
  SliceInput,
  FindingInput,
} from './store.js'
export { createBoardWriteTool } from './write-tool.js'
export { createBoardUpdateTool } from './update-tool.js'

/** Per-session binding: the store + which workspace/thread this session runs on. */
export interface BoardToolsDeps {
  readonly store: SqliteBoardStore
  readonly workspaceId: string
  /** Chat that drafted boards in this session, when known. */
  readonly originThreadId: string | null
}

/**
 * Build the board tool pair bound to a session's workspace/thread.
 * `board_write` closes over (store, workspaceId, originThreadId);
 * `board_update` needs only the store (the board carries its workspace).
 */
export function createBoardTools(deps: BoardToolsDeps): Tool[] {
  return [
    createBoardWriteTool({
      store: deps.store,
      workspaceId: deps.workspaceId,
      originThreadId: deps.originThreadId,
    }),
    createBoardUpdateTool({ store: deps.store }),
  ]
}
