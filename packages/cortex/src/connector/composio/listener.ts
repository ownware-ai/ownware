/**
 * ComposioCompletionListener — polls the Composio v3 API for connected-
 * account status and maps it onto the vendor-agnostic
 * `ConnectionCheckResult` the 2a poller consumes.
 *
 * Status enum mapping (verified against openapi.json
 * /api/v3/connected_accounts/{nanoid} GET, fetched 2026-04-13):
 *
 *   INITIALIZING → pending
 *   INITIATED    → pending
 *   ACTIVE       → ready
 *   FAILED       → failed (terminal, carries status_reason if present)
 *   EXPIRED      → failed (terminal, "Connection expired — please reconnect.")
 *   INACTIVE     → failed (terminal, "Connection was disabled.")
 *   HTTP 404     → not_found
 *
 * AbortSignal handling: the signal passed in is the poller's per-call
 * abort controller; the client's internal 30s timeout is independent.
 * If the signal is already aborted we short-circuit to `pending` — the
 * poller will not dispatch again until the next tick anyway.
 */

import type {
  ConnectionCheckResult,
  ConnectionCompletionListener,
} from '../completion/types.js'
import {
  ConnectorNetworkError,
  ConnectorRateLimitedError,
  ConnectorValidationError,
  ConnectorVendorError,
} from '../errors.js'
import type { ComposioClient } from './client.js'

export interface ComposioCompletionListenerOptions {
  readonly client: ComposioClient
}

export class ComposioCompletionListener implements ConnectionCompletionListener {
  readonly source = 'composio'
  private readonly client: ComposioClient

  constructor(opts: ComposioCompletionListenerOptions) {
    this.client = opts.client
  }

  async checkStatus(
    connectionId: string,
    _metadata: Record<string, unknown> | null,
    signal: AbortSignal,
  ): Promise<ConnectionCheckResult> {
    if (signal.aborted) {
      return { status: 'pending' }
    }
    try {
      const account = await this.client.getConnectedAccount(connectionId)
      switch (account.status) {
        case 'INITIALIZING':
        case 'INITIATED':
          return { status: 'pending' }
        case 'ACTIVE':
          return {
            status: 'ready',
            completedMetadata: {
              composioConnectedAccountId: account.id,
              composioAuthConfigId: account.auth_config.id,
              composioToolkitSlug: account.toolkit.slug,
            },
            // First-class vendor identity so the resolver at execute-time
            // never needs to dig into metadata. `account.id` is Composio's
            // unambiguous pointer; `account.user_id` is the value frozen
            // on Composio's side at connect-time (what they'll expect to
            // see if their API ever requires user_id again — we send the
            // frozen value, never the live entity_id).
            vendorAccountId: account.id,
            ...(account.user_id !== undefined && account.user_id.length > 0
              ? { vendorUserId: account.user_id }
              : {}),
          }
        case 'FAILED': {
          const reason =
            (account.status_reason && account.status_reason.length > 0)
              ? account.status_reason
              : 'Composio reported the connection as failed. Please reconnect.'
          return { status: 'failed', errorReason: reason }
        }
        case 'EXPIRED':
          return {
            status: 'failed',
            errorReason: 'Connection expired — please reconnect.',
          }
        case 'INACTIVE':
          return {
            status: 'failed',
            errorReason: 'Connection was disabled — please reconnect.',
          }
      }
    } catch (err) {
      return mapClientErrorToResult(err)
    }
  }
}

function mapClientErrorToResult(err: unknown): ConnectionCheckResult {
  // 404 — vendor has no record. Composio returns a JSON body the client
  // already classified as ConnectorValidationError (4xx). Distinguish by
  // message pattern: "HTTP 404" is present in the default message.
  if (err instanceof ConnectorValidationError && /404/.test(err.message)) {
    return {
      status: 'not_found',
      errorReason: 'Composio has no record of this connection attempt.',
    }
  }
  // Transient — keep polling.
  if (err instanceof ConnectorNetworkError) {
    return { status: 'pending' }
  }
  if (err instanceof ConnectorRateLimitedError) {
    return { status: 'pending' }
  }
  if (err instanceof ConnectorVendorError) {
    // Schema drift or 5xx that exhausted retries — fail loudly. The
    // poller catches throws and marks `failed` with this message, so
    // the user sees an honest, actionable reason.
    throw err
  }
  // Any 4xx other than 404 — terminal configuration/validation error.
  if (err instanceof ConnectorValidationError) {
    return {
      status: 'failed',
      errorReason: err.message,
    }
  }
  // Unknown — let the poller's generic catch handle it.
  throw err
}
