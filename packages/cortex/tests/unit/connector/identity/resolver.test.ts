/**
 * ConnectorIdentityResolver — unit tests.
 *
 * The architectural rule under test:
 *
 *   "Vendor-frozen values stay on the row. Our locally-derived values
 *    can change. We only ever send vendor-frozen values BACK to the
 *    vendor."
 *
 * These tests pin the resolver's contract per source. If a future
 * change to entity_id (multi-user, env rename) breaks the rule by
 * leaking entity_id into resolveExecuteIdentity, exactly one of
 * these tests fails — fast, with a clear message.
 */

import { describe, it, expect } from 'vitest'
import {
  ComposioIdentityResolver,
  MCPIdentityResolver,
  BuiltinIdentityResolver,
  createIdentityResolver,
} from '../../../../src/connector/identity/resolver.js'
import type { ConnectionRow } from '../../../../src/connector/connections/store.js'

function row(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    connectionId: 'conn_x',
    connectorId: 'gmail',
    source: 'composio',
    entityId: 'cortex-default-user',
    status: 'ready',
    initiatedAt: 1,
    completedAt: 2,
    lastPolledAt: null,
    expiresAt: null,
    errorReason: null,
    metadata: null,
    authConfigId: 'ac_1',
    vendorAccountId: 'ca_real',
    vendorUserId: 'cortex-default-user',
    ...overrides,
  }
}

describe('ComposioIdentityResolver', () => {
  const resolver = new ComposioIdentityResolver()

  it('returns connectedAccountId when only vendor_account_id is set', () => {
    const id = resolver.resolveExecuteIdentity(
      row({ vendorAccountId: 'ca_X', vendorUserId: null }),
    )
    expect(id.connectedAccountId).toBe('ca_X')
    expect(id.vendorUserId).toBeUndefined()
  })

  it('returns BOTH when both vendor identity columns are set (universal rule, 2026-04-28)', () => {
    // The "Sheets fix": post-021 fresh connections have BOTH columns
    // populated. Both came from the same OAuth handshake — they can't
    // drift relative to each other — so sending both is safe AND
    // required by some toolkits (Google Sheets demands user_id even
    // when connected_account_id is supplied).
    const id = resolver.resolveExecuteIdentity(
      row({ vendorAccountId: 'ca_X', vendorUserId: 'frozen-at-connect' }),
    )
    expect(id.connectedAccountId).toBe('ca_X')
    expect(id.vendorUserId).toBe('frozen-at-connect')
  })

  it('NEVER returns entity_id under any condition', () => {
    // The bug class: any code path that surfaces entity_id at execute
    // time creates drift when entity_id later migrates. This test
    // pins the rule. Note: the resolver now returns vendor_user_id
    // alongside connectedAccountId (post-2026-04-28 universal rule),
    // so the assertion is "neither field equals entity_id".
    const id = resolver.resolveExecuteIdentity(
      row({
        entityId: 'someone-else-completely-different',
        vendorAccountId: 'ca_X',
        vendorUserId: 'frozen-at-connect',
      }),
    )
    expect(id.connectedAccountId).toBe('ca_X')
    expect(id.vendorUserId).toBe('frozen-at-connect')
    // Neither field equals entity_id.
    expect(id.connectedAccountId).not.toBe('someone-else-completely-different')
    expect(id.vendorUserId).not.toBe('someone-else-completely-different')
  })

  it('falls back to vendorUserId when vendorAccountId is null', () => {
    // Defensive path: row reached ready without the unambiguous pointer
    // (e.g. metadata also missing it; rare). The resolver returns the
    // frozen vendor_user_id rather than current entity_id.
    const id = resolver.resolveExecuteIdentity(
      row({
        vendorAccountId: null,
        vendorUserId: 'frozen-original-user',
        entityId: 'migrated-different-user',
      }),
    )
    expect(id.vendorUserId).toBe('frozen-original-user')
    expect(id.connectedAccountId).toBeUndefined()
  })

  it('throws when both vendor identity columns are null', () => {
    // The most pathological case: pre-021 row, migration backfill
    // also missed it (metadata didn't have composioConnectedAccountId).
    // We throw a clear, attributable error rather than silently fall
    // back to entity_id and watch Composio reject three hops away.
    expect(() =>
      resolver.resolveExecuteIdentity(
        row({ vendorAccountId: null, vendorUserId: null }),
      ),
    ).toThrow(/missing vendor identity/i)
  })

  it('throw message names the connector + connection so the cause is visible', () => {
    expect(() =>
      resolver.resolveExecuteIdentity(
        row({
          connectionId: 'conn_abc',
          connectorId: 'googlesheets',
          vendorAccountId: null,
          vendorUserId: null,
        }),
      ),
    ).toThrow(/conn_abc.*googlesheets|googlesheets.*conn_abc/i)
  })
})

describe('MCP / builtin resolvers', () => {
  // Phase 17 (2026-05-01): `CustomMCPIdentityResolver` removed — the
  // unified `MCPIdentityResolver` now covers user-registered rows that
  // used to flow through `'custom_mcp'`.
  it('all return empty identity (no vendor user_id concept)', () => {
    expect(new MCPIdentityResolver().resolveExecuteIdentity(row())).toEqual({})
    expect(new BuiltinIdentityResolver().resolveExecuteIdentity(row())).toEqual({})
  })

  it('all expose the correct source string for the registry', () => {
    expect(new MCPIdentityResolver().source).toBe('mcp')
    expect(new BuiltinIdentityResolver().source).toBe('builtin')
  })
})

describe('createIdentityResolver — factory', () => {
  it('returns the right resolver for every source', () => {
    expect(createIdentityResolver('composio')).toBeInstanceOf(ComposioIdentityResolver)
    expect(createIdentityResolver('mcp')).toBeInstanceOf(MCPIdentityResolver)
    expect(createIdentityResolver('builtin')).toBeInstanceOf(BuiltinIdentityResolver)
  })
})

describe('Architectural invariant: entity_id mutation does NOT change resolver output', () => {
  it('Composio: same row, two different entity_ids → identical execute identity', () => {
    const resolver = new ComposioIdentityResolver()
    const before = resolver.resolveExecuteIdentity(
      row({
        entityId: 'cortex-default-user',
        vendorAccountId: 'ca_X',
        vendorUserId: 'frozen-at-connect',
      }),
    )
    const after = resolver.resolveExecuteIdentity(
      row({
        entityId: 'multi-user-future-id-42',
        vendorAccountId: 'ca_X',
        vendorUserId: 'frozen-at-connect',
      }),
    )
    expect(before).toEqual(after)
    expect(after.connectedAccountId).toBe('ca_X')
    expect(after.vendorUserId).toBe('frozen-at-connect')
  })

  it('MCP/builtin: trivially invariant (return {})', () => {
    for (const r of [
      new MCPIdentityResolver(),
      new BuiltinIdentityResolver(),
    ]) {
      expect(r.resolveExecuteIdentity(row({ entityId: 'a' }))).toEqual({})
      expect(r.resolveExecuteIdentity(row({ entityId: 'b' }))).toEqual({})
    }
  })
})
