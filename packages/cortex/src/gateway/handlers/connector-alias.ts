/**
 * PATCH /api/v1/connectors/alias/:logicalKey/source
 *
 * User-facing override for the connector alias resolver. When the same
 * logical app (e.g. Notion) is surfaced by multiple sources, the
 * registry picks a default via `resolveSourceForLogicalKey`. This
 * endpoint lets the user persist a different choice — next
 * `GET /api/v1/connectors` read reflects it.
 *
 * Status codes:
 *   - 200: preference saved; body contains the freshly-resolved connector.
 *   - 400: body malformed OR source has no candidate for this logicalKey.
 *   - 404: logicalKey not in the alias table.
 *   - 500: persistence failure.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { readJSON, sendError, sendJSON } from '../router.js'
import type { ConnectorRegistry } from '../../connector/registry.js'
import type { SourcePreferences } from '../../connector/source-preferences.js'
import {
  isAliasLogicalKey,
  getCanonicalIdsFor,
} from '../../connector/aliases.js'

export const PatchAliasSourceBodySchema = z.object({
  /** The source to pin for this logical key (e.g. `'mcp'`, `'composio'`). */
  source: z.string().min(1),
}).strict()
export type PatchAliasSourceBody = z.infer<typeof PatchAliasSourceBodySchema>

export interface ConnectorAliasHandlersDeps {
  readonly registry: ConnectorRegistry
  readonly preferences: SourcePreferences
}

export function createConnectorAliasHandlers(deps: ConnectorAliasHandlersDeps) {
  const { registry, preferences } = deps

  async function setAliasSource(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const logicalKey = params['logicalKey']
    if (!logicalKey || logicalKey.length === 0) {
      sendError(res, 400, 'logicalKey is required.')
      return
    }
    if (!isAliasLogicalKey(logicalKey)) {
      sendError(res, 404, `Unknown alias logical key: '${logicalKey}'`)
      return
    }

    let rawBody: unknown
    try {
      rawBody = await readJSON(req)
    } catch (e) {
      sendError(res, 400, `Invalid JSON body: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if (rawBody === null) {
      sendError(res, 400, 'Request body is required.')
      return
    }
    const parsed = PatchAliasSourceBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      sendError(res, 400, `Invalid body: ${parsed.error.message}`)
      return
    }
    const requestedSource = parsed.data.source.trim()

    // Verify the requested source actually has a candidate for this
    // logicalKey RIGHT NOW. We don't pin a preference to a source that
    // can't currently satisfy it — the user would see no change.
    const candidates = await registry.listAllForLogicalKey(logicalKey)
    if (candidates.length === 0) {
      // Alias key is in the table, but no source currently surfaces it.
      // 400: body is well-formed; environment doesn't satisfy it yet.
      sendError(
        res,
        400,
        `No connectors currently available for '${logicalKey}'. Install an MCP server or enable Composio first.`,
      )
      return
    }
    const hasCandidate = candidates.some(c => c.source === requestedSource)
    if (!hasCandidate) {
      const available = [...new Set(candidates.map(c => c.source))].sort().join(', ')
      sendError(
        res,
        400,
        `Source '${requestedSource}' is not available for '${logicalKey}'. Available: ${available}.`,
      )
      return
    }

    // Persist. `SourcePreferences.set` validates the logical key again.
    try {
      preferences.set(logicalKey, requestedSource)
    } catch (e) {
      sendError(res, 400, e instanceof Error ? e.message : String(e))
      return
    }

    // Return the freshly-resolved connector post-update. The de-dup
    // pass now honours the persisted preference.
    const deduped = await registry.list()
    const winningCanonIds = new Set(getCanonicalIdsFor(logicalKey))
    const winner = deduped.find(c => winningCanonIds.has(c.canonicalId)) ?? null

    sendJSON(res, 200, {
      logicalKey,
      source: requestedSource,
      connector: winner,
    })
  }

  return { setAliasSource }
}
