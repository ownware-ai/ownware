/**
 * Tool listing handler.
 *
 * Returns the resolved set of built-in tools for a profile based on its
 * preset + allow/deny config. Does NOT connect MCP servers — MCP tools are
 * managed separately via the /mcp endpoints. Using assembleAgent() here was
 * wrong: it connected MCP child processes on every UI poll and left them
 * open, causing resource leaks and 500 errors when MCP was unavailable.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJSON, sendError } from '../router.js'
import type { ProfileRegistry } from '../../profile/registry.js'
import { applyToolPolicy } from '../../profile/tool-policy.js'
import { builtinTools, filesystemTools, shellTools } from '@ownware/loom'
import type { ToolInfo } from '../types.js'

export function createToolHandlers(registry: ProfileRegistry) {

  // GET /api/v1/profiles/:profileId/tools
  //
  // Returns the built-in tools the profile has access to, resolved from its
  // preset + allow/deny policy. MCP tools are intentionally excluded here —
  // they require live connections and are surfaced via /profiles/:id/mcp.
  async function getProfileTools(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const profileId = params['profileId']!
    if (!registry.has(profileId)) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }

    try {
      const profile = await registry.get(profileId)
      const toolsConfig = profile.config.tools

      // Resolve preset → base tool set (mirrors assembler.ts:assembleTools)
      let tools = (() => {
        switch (toolsConfig.preset) {
          case 'full':     return [...builtinTools]
          case 'coding':   return [...filesystemTools, ...shellTools]
          case 'readonly': return filesystemTools.filter(t => t.isReadOnly === true)
          case 'none':     return []
          default:         return [...builtinTools]
        }
      })()

      // Apply allow/deny policy
      tools = applyToolPolicy(tools, toolsConfig.allow, toolsConfig.deny)

      const result: ToolInfo[] = tools.map(t => ({
        name: t.name,
        description: t.description,
        category: t.category ?? 'custom',
        isReadOnly: t.isReadOnly ?? false,
        requiresPermission: t.requiresPermission ?? false,
      }))

      sendJSON(res, 200, result)
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : 'Failed to load tools')
    }
  }

  return { getProfileTools }
}
