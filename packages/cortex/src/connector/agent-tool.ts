/**
 * `connectors()` agent tool.
 *
 * Two actions remain:
 *   - `list_attached`: what connectors does this profile have right now?
 *   - `status`: is a specific connector ready / needs_setup / error?
 *
 * The `search` action was removed 2026-05-12 as part of the connector
 * surfaces collapse.
 * Chat is no longer a marketplace; users add connectors via the chat
 * AbilityRail's `+ Add` button (canonical mid-chat home) or via Profile
 * abilities (canonical setup home). The agent NAMES connectors it can
 * route the user to (from a system-prompt addendum, slice B.3) and
 * routes the user to the chat AbilityRail's `+ Add` button via plain
 * text — see `buildSystemPrompt` in `../profile/assembler.ts` for the
 * one-line context block injected whenever this tool is in the session
 * catalog. The tool itself does NOT render marketplace cards inline.
 *
 * The wire types for the old search shape (ConnectorSearchResult,
 * ConnectorGroup, ConnectorGroupTier, ConnectorSourceSuggestion) were
 * deleted from `agent-tool-results.ts` in slice G (2026-05-16). Pre-rip
 * chat history with `connector_search_result` payloads now fails
 * `ConnectorAgentToolResultSchema.safeParse` and the chat card
 * gracefully no-ops (the agent's surrounding text content still
 * renders normally).
 *
 * ## Result shape — content + metadata
 *
 * The tool packs the result into BOTH places:
 *   - `content`: JSON-stringified `ConnectorAgentToolResult` so the
 *     agent (LLM) sees the structured data for follow-up reasoning.
 *   - `metadata.connectorAgentResult`: the same object, parsed, so
 *     the chat UI's hint-message handler catches it without
 *     re-parsing arbitrary content strings.
 */

import {
  defineTool,
  type JsonSchema,
  type Tool,
  type ToolResult,
} from '@ownware/loom'
import type {
  ConnectorAgentToolResult,
  ConnectorAttachedItem,
  ConnectorAttachedListResult,
  ConnectorCard,
  ConnectorStatusResult,
} from './agent-tool-results.js'
import { connectorToCard } from './agent-tool-results.js'
import type { ConnectorRegistry } from './registry.js'

// ---------------------------------------------------------------------------
// Deps + factory
// ---------------------------------------------------------------------------

export interface ConnectorsToolDeps {
  /**
   * The registry the tool queries. Caller passes a configured
   * instance (with profileRegistry, customMCPState, etc.).
   */
  readonly registry: ConnectorRegistry
  /**
   * The active profile's id. `list_attached` filters to this
   * profile.
   */
  readonly profileId: string
}

const TOOL_DESCRIPTION = [
  'List the connectors attached to this profile, or check the status of one.',
  '',
  'Use ONLY when the user asks what services are already connected or asks',
  'about the state of a specific service — e.g. "what tools do you have",',
  '"is Slack connected", "list my connections". Do NOT call for general chat.',
  '',
  'You CANNOT add new connectors from chat. Users add them via the +Add',
  'button in the chat ability rail or via their profile settings. If the user',
  'asks to add or connect a service you don\'t already have, just tell them to',
  'use the +Add button — name the service so they can find it.',
  '',
  'Actions:',
  '- list_attached: list services connected to the active profile. No query needed.',
  '- status: check one connection. Pass the canonicalId or source-local id as `query`.',
].join('\n')

interface ConnectorsToolInput extends Record<string, unknown> {
  readonly action: 'list_attached' | 'status'
  readonly query?: string
  readonly filters?: {
    readonly source?: 'builtin' | 'mcp' | 'composio'
    readonly status?: 'ready' | 'needs_setup' | 'error'
    readonly category?: string
  }
}

const INPUT_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list_attached', 'status'],
      description:
        'What the user wants. "list_attached" to see what is already connected; "status" to check one connection.',
    },
    query: {
      type: 'string',
      description:
        'For "status": the connector id (e.g. "github" or "mcp:github"). Omit for "list_attached".',
    },
    filters: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['builtin', 'mcp', 'composio'] },
        status: { type: 'string', enum: ['ready', 'needs_setup', 'error'] },
        category: { type: 'string' },
      },
    },
  },
  required: ['action'],
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the result-shaped ToolResult: content carries the JSON, the
 * metadata channel carries the parsed object for the chat UI.
 */
function buildToolResult(result: ConnectorAgentToolResult): ToolResult {
  return {
    content: JSON.stringify(result),
    isError: false,
    metadata: {
      // Stable key the chat UI's hint-message handler keys on
      // (Phase 6-B). Adding new metadata is additive; never widen
      // this key into a different shape without updating both
      // sides.
      connectorAgentResult: result,
    },
  }
}

function buildErrorResult(message: string): ToolResult {
  return {
    content: JSON.stringify({ error: message }),
    isError: true,
  }
}

function matchesFilters(
  card: ConnectorCard,
  filters: ConnectorsToolInput['filters'],
): boolean {
  if (filters == null) return true
  if (filters.source != null && card.source !== filters.source) return false
  if (filters.status != null && card.status !== filters.status) return false
  if (filters.category != null && card.category !== filters.category) return false
  return true
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function handleListAttached(
  deps: ConnectorsToolDeps,
  filters: ConnectorsToolInput['filters'],
): Promise<ConnectorAttachedListResult> {
  // "Attached" = profile-scoped, ready-status, and NOT a built-in.
  // Built-ins (filesystem, shell, browser, web_search, memory, …)
  // are inherent capabilities of the agent runtime — they ride on
  // the profile preset and are always available. Surfacing them in
  // a "what services do I have CONNECTED?" answer misleads the
  // agent (and the user via the chat card): the user asked about
  // the third-party services they explicitly connected (Notion,
  // Gmail, Slack, …), not the OS-level primitives that ship with
  // Ownware. The architectural mistake was conflating "ready
  // capabilities" with "user-installed connections" — list_attached
  // is the second concept. Surfaced by user e2e on 2026-05-07
  // when Filesystem/Shell/Browser/Memory/Web Search/etc. all
  // appeared as "Connected" alongside the user's Notion.
  const all = await deps.registry.listForProfile(deps.profileId)
  const attached: ConnectorAttachedItem[] = all
    .filter((c) => c.source !== 'builtin')
    .filter((c) => c.status === 'ready')
    .filter((c) =>
      matchesFilters(connectorToCard(c), filters),
    )
    .map((c) => ({
      ...connectorToCard(c),
      // v1: no per-attachment timestamp tracked anywhere in the
      // store. Use the current ISO time as a placeholder. Tracked
      // in BUGS.md for the Phase 5+ persistence cleanup.
      connectedAt: new Date().toISOString(),
      toolCount: c.toolNames?.length ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return {
    type: 'connector_attached_list',
    items: attached,
  }
}

async function handleStatus(
  deps: ConnectorsToolDeps,
  rawQuery: string,
): Promise<ConnectorStatusResult | null> {
  const id = rawQuery.trim()
  if (id.length === 0) return null

  // Status lookup uses the global list so the agent can check
  // connectors the user hasn't attached yet ("is Slack
  // available?"). Try canonicalId first (mcp:github), then
  // source-local (github).
  const all = await deps.registry.list()
  const match =
    all.find((c) => c.canonicalId === id) ??
    all.find((c) => c.id === id) ??
    null
  if (match == null) return null

  return {
    type: 'connector_status',
    id: match.id,
    canonicalId: match.canonicalId,
    name: match.name,
    status: match.status,
    ...(match.error != null ? { error: match.error } : {}),
    // toolCount only for ready connectors; the schema mirrors the
    // architecture doc's contract.
    ...(match.status === 'ready' && match.toolNames != null
      ? { toolCount: match.toolNames.length }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createConnectorsTool(deps: ConnectorsToolDeps): Tool<ConnectorsToolInput> {
  return defineTool<ConnectorsToolInput>({
    name: 'connectors',
    description: TOOL_DESCRIPTION,
    inputSchema: INPUT_JSON_SCHEMA,
    isReadOnly: true,
    requiresPermission: false,
    category: 'custom',
    uiDescriptor: {
      // 'connectors' tool renders as ConnectorAgentCard in chat-stream,
      // not as an inline tool row. The dispatcher routes by kind.
      kind: 'conversational',
      summary: { verb: 'Browsed services', primaryField: 'action' },
    },
    async execute(input): Promise<ToolResult> {
      switch (input.action) {
        case 'list_attached': {
          const result = await handleListAttached(deps, input.filters)
          return buildToolResult(result)
        }
        case 'status': {
          const result = await handleStatus(deps, input.query ?? '')
          if (result == null) {
            // No "use search first" hint — search is gone. The user
            // adds connectors through the chat AbilityRail's +Add or
            // through Profile abilities, not through the agent.
            return buildErrorResult(
              `No connector matches "${input.query ?? ''}". The user can add it from the chat ability rail's +Add button.`,
            )
          }
          return buildToolResult(result)
        }
      }
    },
  })
}
