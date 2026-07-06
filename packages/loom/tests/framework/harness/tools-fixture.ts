/**
 * Tool Fixtures
 *
 * Pre-built tool sets for framework tests. Instead of importing and
 * assembling tools manually in every test, use these presets.
 *
 * These mirror the tool presets available in Cortex profiles but are
 * configured directly for Loom Session usage.
 */

import {
  builtinTools,
  filesystemTools,
  shellTools,
  defineTool,
} from '../../../src/index.js'
import type { Tool } from '../../../src/tools/types.js'

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** All builtin tools (filesystem, shell, search, web-fetch, agent_spawn). */
export function fullToolSet(): Tool[] {
  return [...builtinTools]
}

/** Filesystem + shell tools (typical coding agent). */
export function codingToolSet(): Tool[] {
  return [...filesystemTools, ...shellTools]
}

/** Read-only filesystem tools (safe for exploration). */
export function readOnlyToolSet(): Tool[] {
  return filesystemTools.filter(t => t.isReadOnly === true)
}

/** No tools (text-only agent). */
export function noTools(): Tool[] {
  return []
}

// ---------------------------------------------------------------------------
// Test-specific tools
// ---------------------------------------------------------------------------

/**
 * A simple calculator tool for testing tool execution.
 * Deterministic, no side effects, easy to assert on.
 */
export const calculatorTool: Tool = defineTool({
  name: 'calculate',
  description: 'Evaluate a simple math expression. Supports +, -, *, /.',
  category: 'custom',
  isReadOnly: true,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Math expression like "2 + 3"' },
    },
    required: ['expression'],
  },
  async execute(input) {
    const expr = (input as { expression: string }).expression
    // Safe eval of simple math expressions (no eval() — parse manually)
    const result = evaluateSimpleMath(expr)
    if (result === null) {
      return { content: `Cannot evaluate: ${expr}`, isError: true }
    }
    return { content: String(result), isError: false }
  },
})

/**
 * A tool that always fails. For testing error recovery paths.
 */
export const failingTool: Tool = defineTool({
  name: 'always_fail',
  description: 'This tool always returns an error. For testing error handling.',
  category: 'custom',
  isReadOnly: true,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Error message to return' },
    },
    required: ['message'],
  },
  async execute(input) {
    const msg = (input as { message: string }).message
    return { content: `Error: ${msg}`, isError: true }
  },
})

/**
 * A tool that takes a configurable amount of time. For testing timeouts.
 */
export const slowTool: Tool = defineTool({
  name: 'slow_operation',
  description: 'Simulates a slow operation that takes a specified number of milliseconds.',
  category: 'custom',
  isReadOnly: true,
  requiresPermission: false,
  inputSchema: {
    type: 'object',
    properties: {
      delayMs: { type: 'number', description: 'How many milliseconds to wait' },
      result: { type: 'string', description: 'What to return after the delay' },
    },
    required: ['delayMs', 'result'],
  },
  async execute(input) {
    const { delayMs, result } = input as { delayMs: number; result: string }
    await new Promise(resolve => setTimeout(resolve, delayMs))
    return { content: result, isError: false }
  },
})

/**
 * A write tool that requires permission. For testing HITL flows.
 */
export const permissionTool: Tool = defineTool({
  name: 'write_sensitive',
  description: 'Write to a sensitive location. Requires explicit permission.',
  category: 'custom',
  isReadOnly: false,
  requiresPermission: true,
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['content'],
  },
  async execute(input) {
    const { content } = input as { content: string }
    return { content: `Written: ${content}`, isError: false }
  },
})

// ---------------------------------------------------------------------------
// Resolve preset
// ---------------------------------------------------------------------------

export type ToolPreset = 'full' | 'coding' | 'readonly' | 'none' | 'calculator'

export function resolveTools(preset: ToolPreset | Tool[]): Tool[] {
  if (Array.isArray(preset)) return preset
  switch (preset) {
    case 'full': return fullToolSet()
    case 'coding': return codingToolSet()
    case 'readonly': return readOnlyToolSet()
    case 'none': return noTools()
    case 'calculator': return [calculatorTool]
  }
}

// ---------------------------------------------------------------------------
// Safe math evaluator (no eval())
// ---------------------------------------------------------------------------

function evaluateSimpleMath(expr: string): number | null {
  // Tokenize: numbers and operators
  const tokens = expr.match(/(\d+\.?\d*|[+\-*/])/g)
  if (!tokens || tokens.length === 0) return null

  // Simple left-to-right with operator precedence
  const numbers: number[] = []
  const ops: string[] = []

  const applyOp = () => {
    const b = numbers.pop()!
    const a = numbers.pop()!
    const op = ops.pop()!
    switch (op) {
      case '+': numbers.push(a + b); break
      case '-': numbers.push(a - b); break
      case '*': numbers.push(a * b); break
      case '/': numbers.push(b !== 0 ? a / b : NaN); break
    }
  }

  const precedence = (op: string) => (op === '*' || op === '/') ? 2 : 1

  for (const token of tokens) {
    if (/\d/.test(token)) {
      numbers.push(parseFloat(token))
    } else {
      while (ops.length > 0 && precedence(ops[ops.length - 1]!) >= precedence(token)) {
        applyOp()
      }
      ops.push(token)
    }
  }

  while (ops.length > 0) applyOp()

  return numbers.length === 1 && isFinite(numbers[0]!) ? numbers[0]! : null
}
