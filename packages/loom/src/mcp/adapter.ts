/**
 * MCP Tool Adapter
 *
 * Converts MCP tool definitions into Loom Tool interface objects.
 * This allows MCP tools to be used seamlessly alongside built-in tools.
 *
 * Also creates resource tools (list + read) for resource-capable servers.
 *
 * Respects tool annotations:
 * - readOnlyHint → isReadOnly (parallel execution)
 * - destructiveHint → requiresPermission
 */

import type { Tool, ToolResult } from '../tools/types.js'
import type { MCPTool } from './types.js'
import type { MCPClient } from './client.js'
import { MCPError } from './types.js'

// ---------------------------------------------------------------------------
// Tool name sanitization
// ---------------------------------------------------------------------------

/**
 * LLM providers (Anthropic, OpenAI, OpenRouter, Google) all require
 * tool names to match `^[a-zA-Z0-9_-]{1,64}$`. MCP server names from
 * the official registry follow a `<namespace>/<name>` reverse-DNS
 * pattern (e.g. `io.github.user/jira-cloud`, `com.notion/mcp`) which
 * contains `/` and `.` — provider rejects those tool names with
 * "Tool name <name> has invalid characters" and the entire turn
 * fails.
 *
 * Sanitize: replace every character outside `[a-zA-Z0-9_-]` with `_`.
 * The MCP server's REAL name (used for routing the call back to the
 * server) is unchanged; only the tool NAME exposed to the LLM gets
 * the safe transform. Collision risk is theoretically non-zero (two
 * servers whose names sanitize to the same string) but practically
 * negligible: registry namespaces are scoped enough that the
 * sanitized form is still unique in any realistic catalog.
 *
 * Surfaced 2026-05-07 by user e2e: connecting
 * `io.github.issuecapture/mcp-server` made every subsequent agent
 * turn fail with a misleading "AI service is temporarily overloaded"
 * error (the gateway translated the provider's tool-name rejection
 * into a generic 500).
 */
export function sanitizeMCPToolNamePart(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, '_')
}

// ---------------------------------------------------------------------------
// Tool adapter
// ---------------------------------------------------------------------------

/**
 * Adapt an MCP tool to the Loom Tool interface.
 *
 * The resulting tool calls the MCP server via the client when executed.
 * Tool name is prefixed: `mcp__serverName__toolName`
 *
 * Respects MCP tool annotations:
 * - `readOnlyHint: true` → `isReadOnly: true` (safe for parallel execution)
 * - `destructiveHint: true` → `requiresPermission: true`
 */
export function adaptMCPTool(mcpTool: MCPTool, client: MCPClient): Tool {
  const prefixedName = `mcp__${sanitizeMCPToolNamePart(mcpTool.serverName)}__${sanitizeMCPToolNamePart(mcpTool.name)}`

  // Determine read-only from annotations (default: false — treat as write)
  const isReadOnly = mcpTool.annotations?.readOnlyHint === true

  // Destructive tools require permission
  const requiresPermission = mcpTool.annotations?.destructiveHint === true

  return {
    name: prefixedName,
    description: truncateDescription(mcpTool.description),
    inputSchema: mcpTool.inputSchema as unknown as import('../provider/types.js').JsonSchema,
    category: 'mcp',
    isReadOnly,
    requiresPermission,
    timeoutMs: null,
    maxResultSize: null,

    async execute(input): Promise<ToolResult> {
      try {
        const result = await client.callTool(mcpTool.name, input)
        return {
          content: result,
          isError: false,
          metadata: {
            serverName: mcpTool.serverName,
            toolName: mcpTool.name,
            isReadOnly,
            annotations: mcpTool.annotations,
          },
        }
      } catch (err) {
        const message = err instanceof MCPError
          ? `MCP error (${err.serverName}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)

        return {
          content: message,
          isError: true,
          metadata: { serverName: mcpTool.serverName, toolName: mcpTool.name },
        }
      }
    },
  }
}

/**
 * Adapt all tools from an MCP client.
 */
export function adaptAllMCPTools(tools: MCPTool[], client: MCPClient): Tool[] {
  return tools.map(t => adaptMCPTool(t, client))
}

// ---------------------------------------------------------------------------
// Resource tools
// ---------------------------------------------------------------------------

/**
 * Create a "list resources" tool for an MCP server.
 * Returns a read-only tool that lists all available resources on the server.
 */
export function createListResourcesTool(serverName: string, client: MCPClient): Tool {
  return {
    name: `mcp__${sanitizeMCPToolNamePart(serverName)}__list_resources`,
    description: `List available resources from the "${serverName}" MCP server. Returns resource URIs, names, descriptions, and MIME types.`,
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    category: 'mcp',
    isReadOnly: true,
    requiresPermission: false,
    timeoutMs: null,
    maxResultSize: null,

    async execute(): Promise<ToolResult> {
      try {
        const resources = await client.listResources()
        if (resources.length === 0) {
          return { content: 'No resources available.', isError: false }
        }

        const text = resources.map(r => {
          let line = `- ${r.name} (${r.uri})`
          if (r.mimeType) line += ` [${r.mimeType}]`
          if (r.description) line += `\n  ${r.description}`
          return line
        }).join('\n')

        return {
          content: text,
          isError: false,
          metadata: { serverName, resourceCount: resources.length },
        }
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
          metadata: { serverName },
        }
      }
    },
  }
}

/**
 * Create a "read resource" tool for an MCP server.
 * Returns a read-only tool that reads a specific resource by URI.
 */
export function createReadResourceTool(serverName: string, client: MCPClient): Tool {
  return {
    name: `mcp__${sanitizeMCPToolNamePart(serverName)}__read_resource`,
    description: `Read a resource from the "${serverName}" MCP server by URI. Use list_resources first to discover available URIs.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        uri: { type: 'string', description: 'The resource URI to read' },
      },
      required: ['uri'],
    },
    category: 'mcp',
    isReadOnly: true,
    requiresPermission: false,
    timeoutMs: null,
    maxResultSize: null,

    async execute(input): Promise<ToolResult> {
      const uri = String(input.uri ?? '')
      if (!uri) {
        return { content: 'Error: uri is required', isError: true }
      }

      try {
        const contents = await client.readResource(uri)
        if (contents.length === 0) {
          return { content: `No content returned for: ${uri}`, isError: false }
        }

        // Concatenate text content, note binary blobs
        const parts: string[] = []
        for (const c of contents) {
          if (c.text != null) {
            parts.push(c.text)
          } else if (c.blob != null) {
            parts.push(`[Binary content: ${c.mimeType ?? 'unknown type'}, ${c.blob.length} chars base64]`)
          }
        }

        return {
          content: parts.join('\n'),
          isError: false,
          metadata: { serverName, uri, contentCount: contents.length },
        }
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
          metadata: { serverName, uri },
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_DESCRIPTION_LENGTH = 2048

/** Truncate overly long descriptions (common with auto-generated OpenAPI tools) */
function truncateDescription(desc: string): string {
  if (desc.length <= MAX_DESCRIPTION_LENGTH) return desc
  return desc.slice(0, MAX_DESCRIPTION_LENGTH - 3) + '...'
}
