/**
 * Connector agent-tool result schemas.
 *
 * Phase 5-C, 2026-05-06. The wire contract between the gateway's
 * `connectors()` tool implementation (Phase 5-B) and the chat-UI
 * hint handlers (Phase 6-B). Discriminated on `type` so the UI's
 * single chat-stream listener can route to the right card renderer.
 *
 * ## Why slim, not the full `Connector` shape
 *
 * Search and attached-list results return MANY connector records to
 * the agent. Embedding the full `Connector` (auth discriminated
 * union, tokenInputs, oauthPreset, providers, etc.) would burn LLM
 * context tokens on fields the LLM never reasons about. The card
 * shape (`ConnectorCard`) is the rendering subset — id +
 * canonicalId + name + description + icon + source + category +
 * status + availableModes — and that's it.
 *
 * The UI side that needs the full record (e.g. to open the dialog
 * once the user clicks Connect) re-fetches via the existing
 * `/api/v1/connectors` endpoint keyed on `canonicalId`. The card
 * has enough info to render the inline list and trigger the
 * fetch-then-dialog flow.
 *
 * ## Discriminator stability
 *
 * The `type` field is the rendering contract: `'connector_attached_list'`
 * or `'connector_status'`. Adding a new result type means a new literal
 * — never widen an existing one. The chat-UI renderer pattern-matches on
 * `type` exhaustively; a silent default is a UX bug.
 *
 * `'connector_search_result'` retired 2026-05-16 with the agent-tool's
 * `search` action and the `/tools` lobby. Old chat history with that
 * type fails `safeParse` and the chat card gracefully no-ops.
 */

import { z } from 'zod'
import {
  ConnectorAvailableModeSchema,
  ConnectorCategorySchema,
  ConnectorSourceSchema,
  ConnectorStatusSchema,
  type Connector,
} from './schema.js'

// ---------------------------------------------------------------------------
// ConnectorCard — the slim rendering shape
// ---------------------------------------------------------------------------

/**
 * Subset of `Connector` returned in search / attached-list results.
 * Carries only what the inline card needs to render. The full
 * Connector record is one HTTP fetch away (`/connectors` keyed on
 * `canonicalId`).
 */
export const ConnectorCardSchema = z.object({
  id: z.string().min(1),
  canonicalId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  /** Optional brand-logo URL, matches `Connector.iconUrl`. */
  iconUrl: z.string().url().nullable().optional(),
  source: ConnectorSourceSchema,
  category: ConnectorCategorySchema,
  status: ConnectorStatusSchema,
  /**
   * Drives the card's Connect-button copy. Absent for connectors
   * that aren't user-connectable through the dialog (e.g. builtins,
   * runtime-setup-only).
   */
  availableModes: z.array(ConnectorAvailableModeSchema).readonly().optional(),
})
export type ConnectorCard = z.infer<typeof ConnectorCardSchema>

/**
 * Project a full `Connector` record into a search-result card. Used
 * by the gateway's `connectors()` tool when it builds search and
 * attached-list responses; also re-exported for tests so consumers
 * can derive cards without importing the registry.
 */
export function connectorToCard(connector: Connector): ConnectorCard {
  return {
    id: connector.id,
    canonicalId: connector.canonicalId,
    name: connector.name,
    description: connector.description,
    ...(connector.iconUrl !== undefined ? { iconUrl: connector.iconUrl } : {}),
    source: connector.source,
    category: connector.category,
    status: connector.status,
    ...(connector.availableModes !== undefined
      ? { availableModes: connector.availableModes }
      : {}),
  }
}

// ConnectorSearchResult / ConnectorGroup / ConnectorGroupTier /
// ConnectorSourceSuggestion all retired 2026-05-16 (slice G) alongside
// the agent-tool `search` action and the `/tools` lobby. Chat history
// hydrated AFTER the rip with a pre-rip `connector_search_result`
// payload will fail `ConnectorAgentToolResultSchema.safeParse` and the
// chat card gracefully no-ops — the agent's surrounding text content
// renders normally.

// ---------------------------------------------------------------------------
// `connectors(action: 'list_attached')` result
// ---------------------------------------------------------------------------

/**
 * An entry in the attached list. Extends the slim `ConnectorCard`
 * with attachment metadata (when connected, how many tools loaded).
 */
export const ConnectorAttachedItemSchema = ConnectorCardSchema.extend({
  /**
   * ISO 8601 timestamp the connector was attached to the active
   * profile. Used by the UI to render relative time ("connected
   * 2 days ago"); the agent doesn't reason about it directly.
   */
  connectedAt: z.string().datetime(),
  /** Number of tools the connector contributes once attached. */
  toolCount: z.number().int().nonnegative(),
})
export type ConnectorAttachedItem = z.infer<typeof ConnectorAttachedItemSchema>

export const ConnectorAttachedListResultSchema = z.object({
  type: z.literal('connector_attached_list'),
  items: z.array(ConnectorAttachedItemSchema).readonly(),
})
export type ConnectorAttachedListResult = z.infer<
  typeof ConnectorAttachedListResultSchema
>

// ---------------------------------------------------------------------------
// `connectors(action: 'status', query: <id>)` result
// ---------------------------------------------------------------------------

export const ConnectorStatusResultSchema = z.object({
  type: z.literal('connector_status'),
  id: z.string().min(1),
  canonicalId: z.string().min(1),
  name: z.string().min(1),
  status: ConnectorStatusSchema,
  /** Human-readable diagnostic when `status === 'error'`. */
  error: z.string().optional(),
  /** ISO 8601 last-used timestamp when `status === 'connected'`. */
  lastUsed: z.string().datetime().optional(),
  /** Tool count when `status === 'connected'`. */
  toolCount: z.number().int().nonnegative().optional(),
})
export type ConnectorStatusResult = z.infer<typeof ConnectorStatusResultSchema>

// ---------------------------------------------------------------------------
// Discriminated union — for callers that handle any result polymorphically
// ---------------------------------------------------------------------------

/**
 * Polymorphic result returned by the agent's `connectors()` tool.
 * The chat-UI's hint-message handler discriminates on `type` and
 * routes to the right card renderer. Exhaustive switch required —
 * a silent default is a UX bug because the user clicked something
 * that should have rendered.
 */
export const ConnectorAgentToolResultSchema = z.discriminatedUnion('type', [
  ConnectorAttachedListResultSchema,
  ConnectorStatusResultSchema,
])
export type ConnectorAgentToolResult = z.infer<typeof ConnectorAgentToolResultSchema>
