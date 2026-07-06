/**
 * ConnectorIdentityResolver — single source of truth for "which
 * identifier do we send to the vendor when executing a tool on this
 * connection?"
 *
 * # Why this exists
 *
 * Every OAuth connection carries TWO identity strings:
 *
 *   1. Our local identity (`entity_id`)  — mutable, can migrate over
 *      time (migration 019, future multi-user, env var rename).
 *   2. The vendor's frozen identity      — set when the OAuth completed,
 *      never rewritable on the vendor's side.
 *
 * Drift between them is inevitable as our identity scheme evolves. If
 * any code path sends our local entity_id back to the vendor at
 * execute-time, that drift surfaces as "user ID does not match"
 * errors — exactly what broke pre-021 Google Sheets connections after
 * migration 019 healed entity_id.
 *
 * # The architectural rule
 *
 * **Vendor-frozen values stay on the row. Our locally-derived values
 *  can change. We only ever send vendor-frozen values BACK to the
 *  vendor.**
 *
 * This file enforces the rule. The tool-adapter never derives identity
 * inline — it asks the resolver. The resolver only reads vendor-
 * frozen columns (`vendor_account_id`, `vendor_user_id`) populated at
 * connect-time. If those are missing the resolver throws — better
 * than silently falling back to entity_id and watching the vendor
 * reject three hops away.
 *
 * # Source coverage
 *
 *   • Composio  — vendor_account_id is the unambiguous pointer; we
 *                  never include user_id alongside it (Composio's
 *                  validator rejects mismatch).
 *   • MCP        — credentials live in the credential store, not on
 *                  connector_connections. Resolver returns nothing
 *                  meaningful; the MCP path doesn't go through it.
 *   • custom_mcp — same as MCP.
 *   • builtin    — no vendor, no auth.
 *
 * The interface is uniform across all sources so a future provider
 * (Pipedream, Zapier) can't ship without implementing it. The
 * architectural rule is enforced at the type level.
 *
 * # Testing
 *
 * `tests/unit/connector/identity/resolver.test.ts` covers the
 * resolver in isolation. The cross-cutting invariant — "after
 * connection, mutating entity_id does NOT break tool execution" —
 * lives in `tests/unit/connector/composio/identity-invariant.test.ts`.
 */

import type { ConnectionRow } from '../connections/store.js'
import type { ConnectorSource } from '../schema.js'

/**
 * What an executeTool API needs to identify a connection. Subset
 * because not every source needs every field — Composio takes
 * `connectedAccountId`; a hypothetical Pipedream might take a token.
 * The discriminating shape is the resolver's responsibility.
 *
 * **Both fields together is OK** — the resolver returns every non-null
 * vendor-frozen identity it has on the row. Both come from the same
 * OAuth handshake, so they CAN'T drift relative to each other (unlike
 * the pre-021 era where the second value was the live `entity_id`).
 * Composio's cross-check passes because both values are exactly what
 * Composio's own record holds. Some toolkits (Google Sheets, others)
 * actually require both together; sending both universally fixes
 * those without per-toolkit branches.
 */
export interface ExecuteIdentity {
  /** Composio's connected_account_id (or any equivalent unambiguous
   *  vendor pointer). Vendor-frozen at connect-time. */
  readonly connectedAccountId?: string
  /**
   * The user_id we sent to the vendor at connect-time, frozen on the
   * row. Vendor-frozen at connect-time too — never `entity_id` from
   * current state. Sent alongside `connectedAccountId` when both are
   * available; sent alone for legacy rows where the unambiguous
   * pointer wasn't recorded.
   */
  readonly vendorUserId?: string
}

export interface ConnectorIdentityResolver {
  readonly source: ConnectorSource
  /**
   * Compute the identifier to send to the vendor's executeTool API
   * for THIS specific connection row. Must be pure — no DB reads, no
   * env reads, no global state. Same row in → same identity out.
   *
   * Throws when the row lacks the vendor-frozen identity that this
   * source requires. Throwing is intentional: the alternative
   * (silent fallback to entity_id) is the bug this whole
   * architecture exists to prevent.
   */
  resolveExecuteIdentity(row: ConnectionRow): ExecuteIdentity
}

// ---------------------------------------------------------------------------
// Per-source implementations
// ---------------------------------------------------------------------------

export class ComposioIdentityResolver implements ConnectorIdentityResolver {
  readonly source = 'composio' as const

  resolveExecuteIdentity(row: ConnectionRow): ExecuteIdentity {
    // Universal rule: emit every vendor-frozen identity field present on
    // the row. Both came from the same OAuth handshake → they can't
    // drift relative to each other → Composio's cross-check always
    // passes. Some toolkits (Google Sheets, possibly others) require
    // both together; sending both universally avoids per-toolkit
    // branches AND survives any future Composio API tightening.
    //
    // The pre-2026-04-28 rule "never send both" was specifically about
    // the pre-021 era where the second value was the live `entity_id`
    // (which DID drift after migration 019). Vendor_user_id is frozen
    // at connect-time and shares the same trust level as
    // vendor_account_id — there's no reason to withhold it.
    if (row.vendorAccountId === null && row.vendorUserId === null) {
      throw new Error(
        `Composio connection ${row.connectionId} (connector "${row.connectorId}") ` +
        `is missing vendor identity. Migration 021 should have backfilled ` +
        `vendor_account_id from metadata.composioConnectedAccountId; if it didn't, ` +
        `the metadata is also missing the pointer. Reconnect the integration to recover.`,
      )
    }
    return {
      ...(row.vendorAccountId !== null
        ? { connectedAccountId: row.vendorAccountId }
        : {}),
      ...(row.vendorUserId !== null
        ? { vendorUserId: row.vendorUserId }
        : {}),
    }
  }
}

/**
 * MCP / custom_mcp connections don't go through this resolver because
 * MCP credentials live in the credential store, not on
 * connector_connections rows. The resolver is implemented for shape
 * uniformity (so a registry covers every ConnectorSource) and
 * returns an empty identity — any caller that ever routes an MCP
 * tool through this resolver should treat the empty return as
 * "fall back to your existing credential-store path."
 */
export class MCPIdentityResolver implements ConnectorIdentityResolver {
  readonly source = 'mcp' as const
  resolveExecuteIdentity(_row: ConnectionRow): ExecuteIdentity {
    return {}
  }
}

// CustomMCPIdentityResolver removed 2026-05-01 (Milestone B Phase 17).
// User-registered MCP rows now flow through the unified `mcp` source,
// and `MCPIdentityResolver` covers them (it returns the same `{}` empty
// identity that the custom path used to).

/**
 * Builtin tools have no vendor and no auth. Implemented for the same
 * type-level uniformity reason as MCP.
 */
export class BuiltinIdentityResolver implements ConnectorIdentityResolver {
  readonly source = 'builtin' as const
  resolveExecuteIdentity(_row: ConnectionRow): ExecuteIdentity {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct the resolver for a given source. Single point of dispatch;
 * adding a new source means adding one case here AND implementing
 * ConnectorIdentityResolver, both required by the type system.
 */
export function createIdentityResolver(
  source: ConnectorSource,
): ConnectorIdentityResolver {
  switch (source) {
    case 'composio':    return new ComposioIdentityResolver()
    case 'mcp':         return new MCPIdentityResolver()
    case 'builtin':     return new BuiltinIdentityResolver()
  }
}
