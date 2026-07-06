/**
 * Built-in Task Tool — `todo_write`
 *
 * A single full-list-replacement tool the model calls to maintain its
 * plan: "the agent's TODO list". One writer (this tool), one store
 * (injected by the consumer), no partial updates. Full-list
 * replacement on every call is deliberate — the whole list comes in
 * each time, which keeps state self-healing across long sessions
 * (a dropped or malformed update is corrected by the next write
 * instead of corrupting incremental state).
 *
 * Loom stays stateless: the `TaskStore` interface is the only
 * contract. Consumers (Cortex) provide SQLite-backed implementations
 * and wire them into `config.taskStore` the same way `memoryStore` is
 * wired. When no store is present, the tool returns a friendly
 * `isError: true` — it does NOT throw, because the loop must not fail
 * when an optional store is unavailable.
 *
 * Scoping (per-session, per-thread, or global) is the store's
 * concern; this tool passes the list through and reads whatever
 * `sessionId` / `agentId` the ToolContext already carries.
 *
 * @security
 *   - No shell / network / filesystem access.
 *   - `content` is model-authored — sanitization is the renderer's
 *     responsibility (the UI client). Output redaction still runs via
 *     the loop's standard post-processing.
 */

import { defineTool } from '../types.js'
import type { Tool } from '../types.js'

// ---------------------------------------------------------------------------
// Public types — the TaskStore interface consumers implement.
// ---------------------------------------------------------------------------

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export interface TaskEntry {
  /** Stable id assigned by the store on first insert. */
  readonly id: string
  readonly content: string
  readonly status: TaskStatus
  /** 0-indexed position in the list as returned by the latest replaceAll. */
  readonly order: number
  /** ISO timestamp. Monotonic per task id. */
  readonly createdAt: string
  /** ISO timestamp. Updated on any field change. */
  readonly updatedAt: string
}

export interface TaskStoreWriteInput {
  readonly content: string
  readonly status: TaskStatus
}

export interface TaskStore {
  /**
   * Replace the entire task list for the current context (the store
   * decides the scope — typically per-thread). Input array order
   * becomes the stored order. Returns the stored entries with ids
   * and timestamps assigned so the tool can echo them to the model.
   */
  replaceAll(
    tasks: ReadonlyArray<TaskStoreWriteInput>,
  ): Promise<ReadonlyArray<TaskEntry>>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONTENT_LENGTH = 2_000
const VALID_STATUSES: ReadonlyArray<TaskStatus> = ['pending', 'in_progress', 'completed']
const STATUS_GLYPH: Record<TaskStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
}

// ---------------------------------------------------------------------------
// Input normalization + validation
// ---------------------------------------------------------------------------

interface RawTaskInput {
  readonly content?: unknown
  readonly status?: unknown
}

interface NormalizedInput {
  readonly tasks: ReadonlyArray<TaskStoreWriteInput>
}

type ValidationError = { readonly kind: 'error'; readonly message: string }
type ValidationOk = { readonly kind: 'ok'; readonly value: NormalizedInput }
type ValidationResult = ValidationError | ValidationOk

function validate(input: unknown): ValidationResult {
  if (input == null || typeof input !== 'object') {
    return { kind: 'error', message: 'Input must be an object with a `tasks` array.' }
  }
  const raw = (input as { tasks?: unknown }).tasks
  if (!Array.isArray(raw)) {
    return { kind: 'error', message: '`tasks` must be an array.' }
  }

  const out: TaskStoreWriteInput[] = []
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as RawTaskInput
    if (entry == null || typeof entry !== 'object') {
      return { kind: 'error', message: `tasks[${i}] must be an object.` }
    }
    if (typeof entry.content !== 'string') {
      return { kind: 'error', message: `tasks[${i}].content must be a string.` }
    }
    const content = entry.content.trim()
    if (content.length === 0) {
      return { kind: 'error', message: `tasks[${i}].content is empty.` }
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      return {
        kind: 'error',
        message: `tasks[${i}].content is ${content.length} chars; maximum is ${MAX_CONTENT_LENGTH}.`,
      }
    }
    let status: TaskStatus
    if (entry.status === undefined || entry.status === null) {
      status = 'pending'
    } else if (typeof entry.status !== 'string') {
      return { kind: 'error', message: `tasks[${i}].status must be a string.` }
    } else if ((VALID_STATUSES as ReadonlyArray<string>).includes(entry.status)) {
      status = entry.status as TaskStatus
    } else {
      return {
        kind: 'error',
        message:
          `tasks[${i}].status must be one of ${VALID_STATUSES.join(', ')}; got "${entry.status}".`,
      }
    }
    out.push({ content, status })
  }

  return { kind: 'ok', value: { tasks: out } }
}

function formatStored(entries: ReadonlyArray<TaskEntry>): string {
  if (entries.length === 0) return 'No tasks.'
  const lines = entries.map((t, idx) => `${STATUS_GLYPH[t.status]} ${idx + 1}. ${t.content}`)
  return `Tasks (${entries.length}):\n${lines.join('\n')}`
}

function countByStatus(
  entries: ReadonlyArray<TaskEntry>,
): { pending: number; in_progress: number; completed: number } {
  let pending = 0
  let in_progress = 0
  let completed = 0
  for (const t of entries) {
    if (t.status === 'pending') pending++
    else if (t.status === 'in_progress') in_progress++
    else completed++
  }
  return { pending, in_progress, completed }
}

// ---------------------------------------------------------------------------
// todo_write
// ---------------------------------------------------------------------------

export const todoWrite: Tool = defineTool({
  name: 'todo_write',
  description:
    'Maintain a durable checklist of the work you are doing. The list is shown to the user so they can track progress in real time.\n' +
    '\n' +
    '## When to use\n' +
    '- Multi-step tasks with 3+ distinct actions.\n' +
    '- Tasks requiring careful planning or touching multiple files.\n' +
    '- When the user provides multiple things to do (numbered or comma-separated).\n' +
    '- When you receive new instructions mid-task — capture them as todos immediately.\n' +
    '- At the start of work: mark the first task `in_progress` BEFORE you begin it.\n' +
    '- After completing each task: mark it `completed` immediately, then start the next. Do not batch completions.\n' +
    '\n' +
    '## When NOT to use\n' +
    '- Single-step or trivial tasks (< 3 steps). Just do the work.\n' +
    '- Purely conversational or informational requests ("what does X do?"). Answer directly.\n' +
    '- Tasks where tracking adds no organizational benefit.\n' +
    '\n' +
    '## How to call\n' +
    '- Pass the ENTIRE current list on every call — this is a full replacement, not a patch. Missing entries are treated as removed.\n' +
    '- Exactly one task should be `in_progress` at any given moment. If you are blocked on the current one, keep it `in_progress` and add a new task describing what needs to unblock it.\n' +
    '- Never mark a task `completed` if tests are failing, the implementation is partial, or you could not verify it works. Keep it `in_progress` and be honest about the state.\n' +
    '- Status values: `pending` (not started), `in_progress` (active now), `completed` (done).\n' +
    '- Keep each `content` short and imperative — "Refactor auth middleware", not "I will now refactor the authentication middleware".',
  // `custom` keeps `todo_write` out of the user-facing Memory
  // connector card (which enumerates memory_store/search/forget).
  // Tasks are an agent coordination primitive, not a user-visible
  // storage surface — closer to `request_credential` / `ask_user`.
  category: 'custom',
  isReadOnly: false,
  requiresPermission: false,
  uiDescriptor: {
    // Tasks have a dedicated panel surface (Tasks panel T04); the
    // chat-stream skips rendering them as inline rows. 'conversational'
    // is the right escape hatch — same routing as ask_user.
    kind: 'conversational',
    summary: { verb: 'Updated tasks' },
  },
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description:
          'The complete ordered list of tasks for the current plan. Array order becomes the displayed order. Pass `[]` to clear the list.',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Short imperative description of the task.',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Current status. Defaults to `pending` when omitted.',
            },
          },
          required: ['content'],
        },
      },
    },
    required: ['tasks'],
  },
  async execute(input, context) {
    const store = (context.config as Record<string, unknown>).taskStore as
      | TaskStore | undefined

    if (!store) {
      return {
        content:
          'Task tracking is not configured in this session. ' +
          'Proceed without maintaining a TODO list.',
        isError: true,
        metadata: { reason: 'no_store' },
      }
    }

    const validated = validate(input)
    if (validated.kind === 'error') {
      return {
        content: `Invalid input: ${validated.message}`,
        isError: true,
        metadata: { reason: 'invalid_input' },
      }
    }

    try {
      const stored = await store.replaceAll(validated.value.tasks)
      const counts = countByStatus(stored)
      return {
        content: formatStored(stored),
        isError: false,
        metadata: {
          count: stored.length,
          pending: counts.pending,
          inProgress: counts.in_progress,
          completed: counts.completed,
        },
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return {
        content: `Failed to update tasks: ${message}`,
        isError: true,
        metadata: { reason: 'store_error' },
      }
    }
  },
})

// ---------------------------------------------------------------------------
// Aggregate export
// ---------------------------------------------------------------------------

export const taskTools: Tool[] = [todoWrite]
