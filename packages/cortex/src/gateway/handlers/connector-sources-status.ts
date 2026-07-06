/**
 * GET /api/v1/connectors/sources/status
 *
 * Reports which connector SOURCES (subsystems) are active on this
 * gateway and, when disabled, why. The client consumes this in Session 1.5b
 * to render per-source empty-state hints — most notably the Composio
 * section when `COMPOSIO_API_KEY` is not set.
 *
 * Shape (stable wire format):
 *   {
 *     builtin:    { status: 'enabled' },
 *     mcp:        { status: 'enabled' },
 *     composio:   { status: 'disabled', reason: 'COMPOSIO_API_KEY not set' },
 *     web_search: { status: 'enabled', activeProvider: 'duckduckgo' }
 *   }
 *
 * Note: `web_search` is NOT a source — it's a pluggable built-in. It's
 * reported here because the same UI surface the source-status panel
 * lives in needs the current web-search provider for its heading.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { sendJSON, sendError } from '../router.js'
import type { WebSearchService } from '../../connector/web-search/service.js'

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

const SourceStatusEntrySchema = z.object({
  status: z.enum(['enabled', 'disabled']),
  reason: z.string().min(1).optional(),
})

/**
 * Composio source entry — includes count metadata so the client can render
 * "Showing 15 featured of 1027 available" without a second round-trip.
 * Both counts are optional: they are absent when the source is disabled,
 * and pre-M-featured-filter consumers ignore them cleanly.
 */
const ComposioSourceStatusEntrySchema = z.object({
  status: z.enum(['enabled', 'disabled']),
  reason: z.string().min(1).optional(),
  /** Size of the curated featured shortlist (static, from featured.ts). */
  featuredCount: z.number().int().nonnegative().optional(),
  /** Size of the live catalogue (sync-populated). 0 until first sync lands. */
  totalCount: z.number().int().nonnegative().optional(),
  /**
   * Fully-qualified Composio dashboard base for this install's workspace,
   * e.g. `https://platform.composio.dev/<org>/<project>`. Present only
   * when the gateway successfully resolved the workspace at boot (via env
   * override or live `/auth/session/info` fetch). The client uses it to deep-
   * link the admin-setup "Open Composio" button at
   * `<base>/auth-configs?toolkit=<slug>`. Absent → frontend falls back to
   * `https://platform.composio.dev/`.
   */
  dashboardBaseUrl: z.string().url().optional(),
})

const WebSearchStatusEntrySchema = z.object({
  status: z.literal('enabled'),
  activeProvider: z.string().min(1),
})

export const ConnectorSourcesStatusSchema = z.object({
  builtin: SourceStatusEntrySchema,
  mcp: SourceStatusEntrySchema,
  composio: ComposioSourceStatusEntrySchema,
  web_search: WebSearchStatusEntrySchema,
})

export type ConnectorSourcesStatus = z.infer<typeof ConnectorSourcesStatusSchema>

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface SourcesStatusDeps {
  /**
   * Is the Composio source active on this gateway? Passed in from
   * `server.ts` which owns the `createComposioSource()` call — that's
   * the only code path that knows whether the key resolved to a
   * non-empty string (env OR vault).
   */
  readonly isComposioEnabled: boolean
  /** Custom disabled reason (defaults to the standard env-var hint). */
  readonly composioDisabledReason?: string
  /** Web-search service — used to read the active provider id. */
  readonly webSearchService: WebSearchService
  /**
   * Count providers for the Composio catalogue. Optional so tests and
   * pre-filter consumers keep working. `featuredCount` is the length of
   * the static curated list; `totalCount` is the live catalogue size
   * (0 until the first sync lands). Both are only surfaced when
   * `isComposioEnabled === true`.
   */
  readonly getComposioFeaturedCount?: () => number
  readonly getComposioTotalCount?: () => number
  /**
   * Optional — resolved Composio workspace dashboard base URL.
   * Called per-request but typically returns a cached value from the
   * boot-time resolver. `undefined` when resolution failed; the field is
   * omitted from the response in that case.
   */
  readonly getComposioDashboardBaseUrl?: () => string | undefined
}

export function createSourcesStatusHandler(deps: SourcesStatusDeps) {
  return async function sourcesStatus(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const resolved = await deps.webSearchService.resolve()
      const payload: ConnectorSourcesStatus = {
        builtin: { status: 'enabled' },
        mcp: { status: 'enabled' },
        composio: deps.isComposioEnabled
          ? {
              status: 'enabled',
              ...(deps.getComposioFeaturedCount
                ? { featuredCount: deps.getComposioFeaturedCount() }
                : {}),
              ...(deps.getComposioTotalCount
                ? { totalCount: deps.getComposioTotalCount() }
                : {}),
              ...(() => {
                const url = deps.getComposioDashboardBaseUrl?.()
                return url !== undefined && url.length > 0
                  ? { dashboardBaseUrl: url }
                  : {}
              })(),
            }
          : {
              status: 'disabled',
              reason:
                deps.composioDisabledReason ??
                'COMPOSIO_API_KEY not set',
            },
        web_search: {
          status: 'enabled',
          activeProvider: resolved.providerId,
        },
      }
      // Validate before send so shape drift trips tests loudly.
      const parsed = ConnectorSourcesStatusSchema.parse(payload)
      sendJSON(res, 200, parsed)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      sendError(res, 500, `Failed to read source status: ${message}`)
    }
  }
}
