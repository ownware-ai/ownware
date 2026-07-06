/**
 * Todo Tool
 *
 * Task tracking for the security review orchestrator.
 * Allows the root agent to create, update, and track testing tasks
 * across the assessment lifecycle.
 *
 * Mirrors Strix's todo system.
 */

import { defineTool } from '@ownware/loom'
import type { Tool } from '@ownware/loom'

// ---------------------------------------------------------------------------
// Types & Storage
// ---------------------------------------------------------------------------

interface TodoItem {
  readonly id: string
  title: string
  description: string | null
  priority: 'low' | 'normal' | 'high' | 'critical'
  status: 'pending' | 'in_progress' | 'done'
  readonly createdAt: string
  updatedAt: string
  completedAt: string | null
}

const todoStore = new Map<string, TodoItem>()
let nextTodoId = 1

const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'critical'])
const VALID_STATUSES = new Set(['pending', 'in_progress', 'done'])

function sortedTodos(): TodoItem[] {
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 }
  const statusOrder: Record<string, number> = { in_progress: 0, pending: 1, done: 2 }

  return Array.from(todoStore.values()).sort((a, b) => {
    const sd = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9)
    if (sd !== 0) return sd
    return (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9)
  })
}

function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return 'No tasks.'

  const statusIcon: Record<string, string> = {
    pending: '[ ]',
    in_progress: '[~]',
    done: '[x]',
  }

  return todos.map(t => {
    const icon = statusIcon[t.status] ?? '[ ]'
    const prio = t.priority !== 'normal' ? ` (${t.priority})` : ''
    return `${icon} ${t.id}: ${t.title}${prio}${t.description ? `\n    ${t.description.slice(0, 80)}` : ''}`
  }).join('\n')
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const createTodo: Tool = defineTool({
  name: 'create_todo',
  description:
    'Create a task to track during the security assessment.\n' +
    '- Use to plan and track testing tasks\n' +
    '- Priority: low, normal, high, critical',
  category: 'custom',
  isReadOnly: false,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Task title' },
      description: { type: 'string', description: 'Task details (optional)' },
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high', 'critical'],
        description: 'Priority level. Default: normal',
      },
    },
    required: ['title'],
  },
  async execute(input) {
    const title = (input.title as string)?.trim()
    if (!title) return { content: 'Error: title cannot be empty', isError: true }

    const priority = (input.priority as string) ?? 'normal'
    if (!VALID_PRIORITIES.has(priority)) {
      return { content: `Error: priority must be one of: ${Array.from(VALID_PRIORITIES).join(', ')}`, isError: true }
    }

    const id = `task_${String(nextTodoId++).padStart(3, '0')}`
    const now = new Date().toISOString()
    const todo: TodoItem = {
      id,
      title,
      description: (input.description as string)?.trim() ?? null,
      priority: priority as TodoItem['priority'],
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
    todoStore.set(id, todo)

    const all = sortedTodos()
    return {
      content: `Task created: ${id}\n\n${formatTodoList(all)}`,
      isError: false,
      metadata: { todoId: id, totalTasks: all.length },
    }
  },
})

export const listTodos: Tool = defineTool({
  name: 'list_todos',
  description: 'List all tasks, optionally filtered by status or priority.',
  category: 'custom',
  isReadOnly: true,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Filter by status' },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'Filter by priority' },
    },
    required: [],
  },
  async execute(input) {
    let todos = sortedTodos()
    if (input.status) todos = todos.filter(t => t.status === input.status)
    if (input.priority) todos = todos.filter(t => t.priority === input.priority)

    const pending = todos.filter(t => t.status === 'pending').length
    const inProgress = todos.filter(t => t.status === 'in_progress').length
    const done = todos.filter(t => t.status === 'done').length

    return {
      content: `Tasks (${pending} pending, ${inProgress} in progress, ${done} done):\n\n${formatTodoList(todos)}`,
      isError: false,
      metadata: { total: todos.length, pending, inProgress, done },
    }
  },
})

export const updateTodo: Tool = defineTool({
  name: 'update_todo',
  description: 'Update a task — change title, description, priority, or status.',
  category: 'custom',
  isReadOnly: false,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      todoId: { type: 'string', description: 'Task ID to update' },
      title: { type: 'string', description: 'New title (optional)' },
      description: { type: 'string', description: 'New description (optional)' },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'New priority (optional)' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'New status (optional)' },
    },
    required: ['todoId'],
  },
  async execute(input) {
    const id = input.todoId as string
    const todo = todoStore.get(id)
    if (!todo) return { content: `Error: task "${id}" not found`, isError: true }

    const now = new Date().toISOString()
    if (input.title) todo.title = (input.title as string).trim()
    if (input.description !== undefined) todo.description = (input.description as string)?.trim() ?? null
    if (input.priority && VALID_PRIORITIES.has(input.priority as string)) {
      todo.priority = input.priority as TodoItem['priority']
    }
    if (input.status && VALID_STATUSES.has(input.status as string)) {
      todo.status = input.status as TodoItem['status']
      if (todo.status === 'done') todo.completedAt = now
      else todo.completedAt = null
    }
    todo.updatedAt = now

    const all = sortedTodos()
    return {
      content: `Task "${id}" updated.\n\n${formatTodoList(all)}`,
      isError: false,
      metadata: { todoId: id },
    }
  },
})

export const markTodoDone: Tool = defineTool({
  name: 'mark_todo_done',
  description: 'Mark one or more tasks as done.',
  category: 'custom',
  isReadOnly: false,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      todoId: { type: 'string', description: 'Single task ID to mark done' },
      todoIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Multiple task IDs to mark done',
      },
    },
    required: [],
  },
  async execute(input) {
    const ids: string[] = []
    if (input.todoId) ids.push(input.todoId as string)
    if (input.todoIds) ids.push(...(input.todoIds as string[]))

    if (ids.length === 0) return { content: 'Error: provide todoId or todoIds', isError: true }

    const now = new Date().toISOString()
    const marked: string[] = []
    const errors: string[] = []

    for (const id of ids) {
      const todo = todoStore.get(id)
      if (!todo) {
        errors.push(`"${id}" not found`)
        continue
      }
      todo.status = 'done'
      todo.completedAt = now
      todo.updatedAt = now
      marked.push(id)
    }

    const all = sortedTodos()
    const result = marked.length > 0
      ? `Marked done: ${marked.join(', ')}`
      : 'No tasks marked'
    const errStr = errors.length > 0 ? `\nErrors: ${errors.join(', ')}` : ''

    return {
      content: `${result}${errStr}\n\n${formatTodoList(all)}`,
      isError: errors.length > 0 && marked.length === 0,
      metadata: { marked, errors, totalTasks: all.length },
    }
  },
})
