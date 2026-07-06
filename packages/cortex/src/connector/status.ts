/**
 * Pure status decision for MCP-source connectors.
 *
 * Replaces three near-identical inline implementations that lived in
 * `mcpServerToConnector` (registry.ts), `customRowToConnector` (registry.ts),
 * and `computeMCPStatus` (gateway/handlers/mcp.ts).
 *
 * **Why pure?** Status is the same answer regardless of HOW the inputs
 * arrived. Callers hydrate the inputs (vault check, OAuth bundle presence,
 * runtime-setup marker, bridge file presence) however they like. The
 * decision lives here so it's testable in isolation and consistent across
 * surfaces.
 *
 * Added 2026-04-30 (Milestone A Phase 5).
 */

import type { AuthMode } from './schema.js'
import type { FeaturedTransport } from './mcp/featured.js'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ConnectorStatusInputs {
  /** Resolved auth mode for this connector. */
  readonly auth: AuthMode
  /**
   * Transport — used for `http_bridge` presence checks. Not needed for
   * stdio or http_remote (status is auth-driven there).
   */
  readonly transport?: FeaturedTransport
  /**
   * Whether each required env var is set (true) or missing (false).
   * Used by `api_key` and the api-key fallback path of `oauth`.
   * Empty for connectors with no env vars.
   */
  readonly envCheck: Readonly<Record<string, boolean>>
  /**
   * Required env-var entries; `isRequired` flag is honored.
   */
  readonly requiredVars: readonly { readonly name: string; readonly isRequired: boolean }[]
  /**
   * `true` when the credential vault holds an OAuth bundle for this
   * connector with at least one non-empty value. Set by the OAuth handler
   * after `tokenTransform` / `tokenToEnv` saves tokens. Used to decide
   * `ready` for OAuth-preset servers regardless of `requiredVars`.
   */
  readonly oauthBundlePresent: boolean
  /**
   * `true` when the runtime-setup completion marker is present in the
   * vault. Set by the runtime-setup endpoint after a successful spawn
   * (or manual confirmation). Cleared on disconnect / session expiry.
   */
  readonly runtimeSetupComplete: boolean
  /**
   * For `http_bridge` transport: `true` when the announced bridge file
   * is present and the most recent ping succeeded. `undefined` for other
   * transports (ignored).
   */
  readonly bridgeReachable?: boolean
}

/**
 * Local re-declaration of the wire enum. Kept aligned with
 * `schema.ts:ConnectorStatusSchema`. `computeConnectorStatus` itself only
 * returns the three "first-decision" values (`ready` / `needs_setup` /
 * `error` are never returned today — error and the two new failure modes
 * `stale` / `auth_error` come from reconcilers, not the static decision).
 * The type is widened to the full union so callers that hold a
 * `ConnectorStatus` interchangeably across surfaces type-check correctly.
 */
export type ConnectorStatus =
  | 'ready'
  | 'stale'
  | 'needs_setup'
  | 'auth_error'
  | 'error'

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * Pure: given hydrated inputs, return the connector's readiness.
 *
 * Branches:
 * - `none` — always `ready` (caller may flip to `error` via a separate
 *   liveness probe; that signal isn't represented here).
 * - `api_key` — `ready` iff every required env var is set.
 * - `oauth` — `ready` iff the OAuth bundle is present OR the api-key
 *   fallback path holds (every required env var set, `requiredVars`
 *   non-empty). Closes the lying-badge bug where empty-`requiredVars`
 *   would vacuously evaluate `every(...) === true` and surface `ready`.
 * - `runtime_setup` — `ready` iff the setup-completion marker is in the vault.
 *
 * Bridge-transport overlay (independent of auth mode): when transport is
 * `http_bridge` and `bridgeReachable === false`, downgrade to
 * `needs_setup` regardless of credential state — the local app isn't
 * running, so even valid credentials can't reach the server.
 */
export function computeConnectorStatus(inp: ConnectorStatusInputs): ConnectorStatus {
  const { auth, transport, envCheck, requiredVars, oauthBundlePresent, runtimeSetupComplete, bridgeReachable } = inp

  // Bridge unreachable overrides everything else: no point claiming ready
  // when the local app's HTTP server isn't accepting connections.
  if (transport?.kind === 'http_bridge' && bridgeReachable === false) {
    return 'needs_setup'
  }

  switch (auth.mode) {
    case 'none':
      return 'ready'

    case 'api_key': {
      const allSet = requiredVars.every(v => !v.isRequired || envCheck[v.name] === true)
      return allSet ? 'ready' : 'needs_setup'
    }

    case 'oauth': {
      const apiKeyPathReady =
        requiredVars.length > 0 &&
        requiredVars.every(v => !v.isRequired || envCheck[v.name] === true)
      return oauthBundlePresent || apiKeyPathReady ? 'ready' : 'needs_setup'
    }

    case 'runtime_setup':
      return runtimeSetupComplete ? 'ready' : 'needs_setup'
  }
}
