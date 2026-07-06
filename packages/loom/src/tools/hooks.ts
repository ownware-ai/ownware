/**
 * Tool Hook Registry
 *
 * Hooks intercept tool execution at two points:
 * - beforeToolCall: can modify input, block execution, or allow
 * - afterToolCall: can modify output, log, trigger side effects
 *
 * Hooks can be registered globally (all tools) or per-tool-name.
 */

import type { ToolContext, ToolResult } from './types.js'

// ---------------------------------------------------------------------------
// Hook types
// ---------------------------------------------------------------------------

export interface BeforeHookResult {
  /** If true, execution is blocked */
  readonly blocked: boolean
  /** Reason for blocking (shown to model) */
  readonly reason?: string
  /** Modified input (if hook wants to transform input) */
  readonly modifiedInput?: Record<string, unknown>
}

export type BeforeToolHook = (
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
) => Promise<BeforeHookResult>

export type AfterToolHook = (
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
  context: ToolContext,
) => Promise<ToolResult>

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface RegisteredHook<T> {
  readonly id: string
  readonly hook: T
}

export class ToolHookRegistry {
  private readonly globalBefore: RegisteredHook<BeforeToolHook>[] = []
  private readonly globalAfter: RegisteredHook<AfterToolHook>[] = []
  private readonly toolBefore = new Map<string, RegisteredHook<BeforeToolHook>[]>()
  private readonly toolAfter = new Map<string, RegisteredHook<AfterToolHook>[]>()

  // ── Register hooks ─────────────────────────────────────────────────

  /**
   * Register a before-hook. Runs before tool execution.
   * @param toolName - tool name to target, or '*' for all tools
   * @param hook - the hook function
   * @param id - unique identifier for this hook (for removal)
   */
  registerBefore(toolName: string, hook: BeforeToolHook, id?: string): void {
    const hookId = id ?? `before-${toolName}-${Date.now()}`
    const entry: RegisteredHook<BeforeToolHook> = { id: hookId, hook }
    if (toolName === '*') {
      this.globalBefore.push(entry)
    } else {
      const list = this.toolBefore.get(toolName) ?? []
      list.push(entry)
      this.toolBefore.set(toolName, list)
    }
  }

  /**
   * Register an after-hook. Runs after tool execution.
   * @param toolName - tool name to target, or '*' for all tools
   * @param hook - the hook function
   * @param id - unique identifier for this hook (for removal)
   */
  registerAfter(toolName: string, hook: AfterToolHook, id?: string): void {
    const hookId = id ?? `after-${toolName}-${Date.now()}`
    const entry: RegisteredHook<AfterToolHook> = { id: hookId, hook }
    if (toolName === '*') {
      this.globalAfter.push(entry)
    } else {
      const list = this.toolAfter.get(toolName) ?? []
      list.push(entry)
      this.toolAfter.set(toolName, list)
    }
  }

  // ── Remove hooks ───────────────────────────────────────────────────

  remove(hookId: string): boolean {
    let removed = false
    removed = removeFromList(this.globalBefore, hookId) || removed
    removed = removeFromList(this.globalAfter, hookId) || removed
    for (const list of this.toolBefore.values()) {
      removed = removeFromList(list, hookId) || removed
    }
    for (const list of this.toolAfter.values()) {
      removed = removeFromList(list, hookId) || removed
    }
    return removed
  }

  // ── Execute hooks ──────────────────────────────────────────────────

  /**
   * Run all before-hooks for a tool. Global hooks run first, then tool-specific.
   * If any hook blocks, execution stops immediately.
   * If multiple hooks modify input, they chain (each sees the previous result).
   */
  async runBeforeHooks(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<BeforeHookResult> {
    const hooks = [
      ...this.globalBefore,
      ...(this.toolBefore.get(toolName) ?? []),
    ]

    let currentInput = input
    for (const { hook } of hooks) {
      const result = await hook(toolName, currentInput, context)
      if (result.blocked) {
        return result
      }
      if (result.modifiedInput) {
        currentInput = result.modifiedInput
      }
    }

    return {
      blocked: false,
      modifiedInput: currentInput !== input ? currentInput : undefined,
    }
  }

  /**
   * Run all after-hooks for a tool. Global hooks run first, then tool-specific.
   * Each hook receives the result from the previous hook (chaining).
   */
  async runAfterHooks(
    toolName: string,
    input: Record<string, unknown>,
    result: ToolResult,
    context: ToolContext,
  ): Promise<ToolResult> {
    const hooks = [
      ...this.globalAfter,
      ...(this.toolAfter.get(toolName) ?? []),
    ]

    let currentResult = result
    for (const { hook } of hooks) {
      currentResult = await hook(toolName, input, currentResult, context)
    }
    return currentResult
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function removeFromList<T>(
  list: RegisteredHook<T>[],
  hookId: string,
): boolean {
  const idx = list.findIndex((h) => h.id === hookId)
  if (idx === -1) return false
  list.splice(idx, 1)
  return true
}
