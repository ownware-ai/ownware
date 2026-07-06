/**
 * Tool Policy — apply allow/deny rules to a tool list.
 *
 * Rules:
 * 1. If deny matches → tool is REMOVED (no override possible)
 * 2. If allow is empty → all non-denied tools are kept
 * 3. If allow is non-empty → only matching tools are kept
 * 4. Deny ALWAYS wins over allow
 *
 * Patterns support simple glob matching:
 * - "filesystem.*" matches "filesystem_readFile", "filesystem_writeFile"
 * - "shell_*" matches "shell_execute"
 * - "*" matches everything
 * - Exact match: "readFile" matches only "readFile"
 */

import { builtinTools, filesystemTools, shellTools } from '@ownware/loom'
import type { Tool } from '@ownware/loom'

/**
 * Filter a tool list based on allow/deny glob patterns.
 *
 * @param tools - Full tool list to filter
 * @param allow - Glob patterns for allowed tools (empty = allow all)
 * @param deny - Glob patterns for denied tools (always wins)
 * @returns Filtered tool array
 */
export function applyToolPolicy(
  tools: Tool[],
  allow: readonly string[],
  deny: readonly string[],
): Tool[] {
  return tools.filter(tool => {
    // Deny always wins — check first
    if (deny.length > 0 && deny.some(pattern => matchesGlob(tool.name, pattern))) {
      return false
    }

    // If allow is empty, keep all non-denied tools
    if (allow.length === 0) {
      return true
    }

    // If allow is non-empty, only keep matching tools
    return allow.some(pattern => matchesGlob(tool.name, pattern))
  })
}

/**
 * Simple glob matching for tool names.
 *
 * Supports:
 * - "*" matches everything
 * - "prefix.*" matches "prefix_anything" and "prefix.anything"
 * - "prefix_*" matches "prefix_anything"
 * - Exact match
 *
 * The "." in patterns matches both literal "." and "_" in tool names,
 * since tool naming conventions vary (filesystem.read vs filesystem_read).
 */
/**
 * Resolve a profile's preset to its base built-in tool set. Mirrors the
 * resolution in `gateway/handlers/tools.ts` so every consumer counts the
 * same way.
 */
export function resolvePresetTools(preset: string | undefined): Tool[] {
  switch (preset) {
    case 'full':
      return [...builtinTools]
    case 'coding':
      return [...filesystemTools, ...shellTools]
    case 'readonly':
      return filesystemTools.filter((t) => t.isReadOnly === true)
    case 'none':
      return []
    default:
      return [...builtinTools]
  }
}

/**
 * Count the effective tools a profile exposes:
 *   resolved built-ins (preset → allow/deny) + MCP servers + custom.
 *
 * This is the number shown in the profile UI (Abilities tab count,
 * lobby card "N abilities", helper card stats).
 */
export function countResolvedTools(toolsConfig: {
  readonly preset?: string
  readonly allow: readonly string[]
  readonly deny: readonly string[]
  readonly custom: readonly unknown[]
  readonly mcp: Record<string, unknown>
}): number {
  const base = resolvePresetTools(toolsConfig.preset)
  const builtinCount = applyToolPolicy(base, toolsConfig.allow, toolsConfig.deny).length
  const mcpCount = Object.keys(toolsConfig.mcp).length
  const customCount = toolsConfig.custom.length
  return builtinCount + mcpCount + customCount
}

export function matchesGlob(toolName: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (pattern === toolName) return true

  // Convert glob pattern to regex
  // Escape regex special chars except *
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape all except *
    .replace(/\\\./g, '[._]')               // . matches both . and _
    .replace(/\*/g, '.*')                    // * matches anything

  const regex = new RegExp(`^${regexStr}$`)
  return regex.test(toolName)
}
