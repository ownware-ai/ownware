/**
 * Tool Description Registry
 *
 * Holds modular tool descriptions indexed by tool name. The PromptBuilder
 * consults the registry when assembling the tools fragment; tools without
 * a registered description fall back to their flat `description: string`.
 *
 * Builtin descriptions register themselves by name (`skill`,
 * `shell_execute`, …); Cortex profiles can register additional
 * descriptions parsed from disk via `parseToolDescription`.
 */

import type { ToolDescription } from './types.js'

export class ToolDescriptionRegistry {
  private readonly byName = new Map<string, ToolDescription>()

  /**
   * Register a description. Re-registering the same name overwrites —
   * profiles that ship their own description for a builtin tool can
   * replace the engine-shipped default.
   */
  register(desc: ToolDescription): this {
    this.byName.set(desc.name, desc)
    return this
  }

  registerAll(descs: readonly ToolDescription[]): this {
    for (const d of descs) this.byName.set(d.name, d)
    return this
  }

  get(toolName: string): ToolDescription | undefined {
    return this.byName.get(toolName)
  }

  has(toolName: string): boolean {
    return this.byName.has(toolName)
  }

  /** Drop a registration by tool name. Returns true if anything was removed. */
  unregister(toolName: string): boolean {
    return this.byName.delete(toolName)
  }

  list(): readonly ToolDescription[] {
    return [...this.byName.values()]
  }

  get size(): number {
    return this.byName.size
  }

  clear(): void {
    this.byName.clear()
  }
}
