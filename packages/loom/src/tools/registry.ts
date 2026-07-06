/**
 * Tool Registry
 *
 * Register, resolve, and manage tools. Supports merging multiple
 * registries (global + profile + runtime + MCP).
 */

import type { Tool, ToolCategory } from './types.js'

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  remove(name: string): boolean {
    return this.tools.delete(name)
  }

  list(): Tool[] {
    return [...this.tools.values()]
  }

  listByCategory(category: ToolCategory): Tool[] {
    return this.list().filter(t => t.category === category)
  }

  names(): string[] {
    return [...this.tools.keys()]
  }

  get size(): number {
    return this.tools.size
  }

  /** Merge another registry into this one (incoming tools override existing) */
  merge(other: ToolRegistry): void {
    for (const tool of other.list()) {
      this.register(tool)
    }
  }

  /** Create a filtered copy based on allow/deny lists */
  filter(opts: {
    allow?: string[]
    deny?: string[]
  }): ToolRegistry {
    const filtered = new ToolRegistry()
    for (const tool of this.list()) {
      if (opts.deny?.includes(tool.name)) continue
      if (opts.allow && !opts.allow.includes(tool.name)) continue
      filtered.register(tool)
    }
    return filtered
  }

  /** Clone this registry */
  clone(): ToolRegistry {
    const cloned = new ToolRegistry()
    cloned.merge(this)
    return cloned
  }
}
