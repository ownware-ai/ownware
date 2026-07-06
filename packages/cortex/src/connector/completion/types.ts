/**
 * ConnectionCompletionListener — source-agnostic contract for "is this
 * OAuth/API-key attempt finished?"
 *
 * Phase 2a ships the interface + a polling framework that drives it
 * (see `poller.ts`). Every source that uses polling to discover
 * completion (Composio's `connected_accounts` endpoint, future
 * vendor-specific flows) implements this one method. Webhook-driven
 * sources skip polling entirely — they feed the connections store
 * directly from their HTTP handler and never instantiate a listener.
 *
 * The listener is deliberately narrow: it does not own the store, it
 * does not decide retry timing, it does not emit events. Its single
 * responsibility is "given this connection id + metadata, what's the
 * current vendor-side state?" The poller (the vendor-agnostic engine)
 * handles everything else.
 */

import { z } from 'zod'

/**
 * Outcome of a single poll attempt.
 *
 * - `pending`    — vendor says "still in progress". Poller backs off
 *                  and tries again.
 * - `ready`      — success. Poller marks the row `ready`, emits a
 *                  status event, stops polling.
 * - `failed`     — terminal vendor-side failure. Poller marks `failed`
 *                  with the supplied reason, emits, stops.
 * - `not_found`  — vendor has no record of this id. Treated as
 *                  `failed` (the attempt never reached them). The
 *                  listener may return this when the user abandoned
 *                  the flow before the vendor saw anything.
 */
export const ConnectionCheckResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('pending'),
    /** Optional merged-in metadata to persist alongside the row. */
    completedMetadata: z.record(z.unknown()).optional(),
  }),
  z.object({
    status: z.literal('ready'),
    completedMetadata: z.record(z.unknown()).optional(),
    /**
     * Vendor-frozen identity captured at completion. Plumbed through
     * to `ConnectorConnectionsStore.markReady` so the row records:
     *
     *   • `vendorAccountId` — the vendor's pointer (e.g. Composio's
     *     `connected_account_id`). The unambiguous reference used by
     *     `ConnectorIdentityResolver` at execute-time.
     *   • `vendorUserId`    — what we sent to the vendor as their
     *     `user_id` at connect-time. Captured once, frozen, never
     *     re-derived from local state.
     *
     * Both optional because not every source has these concepts (MCP /
     * custom_mcp don't). The resolver handles null cleanly.
     */
    vendorAccountId: z.string().min(1).optional(),
    vendorUserId: z.string().min(1).optional(),
  }),
  z.object({
    status: z.literal('failed'),
    errorReason: z.string().min(1),
    completedMetadata: z.record(z.unknown()).optional(),
  }),
  z.object({
    status: z.literal('not_found'),
    errorReason: z.string().min(1).optional(),
  }),
])
export type ConnectionCheckResult = z.infer<typeof ConnectionCheckResultSchema>

/**
 * Implemented by each source that wants polling-driven completion
 * detection. `source` is the string written to
 * `connector_connections.source` for rows this listener handles —
 * the manager routes by this key.
 */
export interface ConnectionCompletionListener {
  readonly source: string
  /**
   * Single poll attempt. Implementations should:
   *   - Be idempotent (may be called many times for the same id).
   *   - Respect AbortSignal (cancelled when the poller cancels).
   *   - NOT retry internally; return `pending` and let the poller
   *     schedule the next attempt.
   *   - NOT throw for transient errors; return `pending` and let the
   *     poller's timeout/max-attempt logic catch truly-stuck cases.
   *     Throwing IS appropriate for terminal programmer errors
   *     (missing API key, malformed id — those the poller surfaces
   *     as `failed`).
   */
  checkStatus(
    connectionId: string,
    metadata: Record<string, unknown> | null,
    signal: AbortSignal,
  ): Promise<ConnectionCheckResult>
}
