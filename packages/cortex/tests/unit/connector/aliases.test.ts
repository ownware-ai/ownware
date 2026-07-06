/**
 * Tests for the connector alias table.
 *
 * The table itself is tiny; the contract is in the invariants:
 *   - Logical keys are lowercase slugs.
 *   - Every canonicalId is well-formed (matches `<source>:<id>`).
 *   - A canonicalId appears in exactly one logical key (uniqueness).
 *   - Helpers round-trip.
 *   - Each listed canonicalId references a real featured entry in the
 *     corresponding source-featured list (MCP or Composio).
 *
 * As of 2026-05-06 the table is empty by design: Composio was dropped
 * from the Tier 1 catalog, leaving every logical app with only one
 * canonicalId — no need for aliases. The invariants below remain the contract; they're written
 * to survive both the empty state and a future re-population without
 * change.
 */

import { describe, it, expect } from 'vitest'

import {
  CONNECTOR_ALIASES,
  getAliasesFor,
  getCanonicalIdsFor,
  isAliasLogicalKey,
  listAliasLogicalKeys,
} from '../../../src/connector/aliases.js'
import { parseCanonicalConnectorId } from '../../../src/connector/schema.js'
import { FEATURED_SERVERS } from '../../../src/connector/mcp/featured.js'
import { FEATURED_COMPOSIO_TOOLKITS } from '../../../src/connector/composio/featured.js'

describe('CONNECTOR_ALIASES table', () => {
  it('is empty for v1 (Composio dropped — no dual-source apps)', () => {
    expect(listAliasLogicalKeys()).toEqual([])
    expect(Object.keys(CONNECTOR_ALIASES).length).toBe(0)
  })

  it('logical keys are lowercase slugs (vacuously true on empty table)', () => {
    for (const key of listAliasLogicalKeys()) {
      expect(key).toMatch(/^[a-z0-9_-]+$/)
    }
  })

  it('every canonicalId is well-formed and non-empty (invariant survives re-population)', () => {
    for (const [, canonIds] of Object.entries(CONNECTOR_ALIASES)) {
      expect(canonIds.length).toBeGreaterThanOrEqual(2)
      for (const cid of canonIds) {
        expect(parseCanonicalConnectorId(cid)).not.toBeNull()
      }
    }
  })

  it('each canonicalId appears under exactly one logical key', () => {
    const seen = new Map<string, string>()
    for (const [key, canonIds] of Object.entries(CONNECTOR_ALIASES)) {
      for (const cid of canonIds) {
        expect(seen.has(cid)).toBe(false)
        seen.set(cid, key)
      }
    }
  })

  it('MCP-prefixed canonicalIds have a matching FEATURED_SERVERS entry', () => {
    const mcpIds = new Set(FEATURED_SERVERS.map(s => s.id))
    for (const canonIds of Object.values(CONNECTOR_ALIASES)) {
      for (const cid of canonIds) {
        const parsed = parseCanonicalConnectorId(cid)
        if (parsed?.source === 'mcp') {
          expect(mcpIds.has(parsed.id)).toBe(true)
        }
      }
    }
  })

  it('Composio-prefixed canonicalIds have a matching FEATURED_COMPOSIO_TOOLKITS entry', () => {
    const slugs = new Set(FEATURED_COMPOSIO_TOOLKITS.map(t => t.slug))
    for (const canonIds of Object.values(CONNECTOR_ALIASES)) {
      for (const cid of canonIds) {
        const parsed = parseCanonicalConnectorId(cid)
        if (parsed?.source === 'composio') {
          expect(slugs.has(parsed.id)).toBe(true)
        }
      }
    }
  })
})

describe('getAliasesFor', () => {
  it('returns null for any canonicalId while the table is empty', () => {
    expect(getAliasesFor('mcp:notion')).toBeNull()
    expect(getAliasesFor('composio:notion')).toBeNull()
    expect(getAliasesFor('mcp:slack')).toBeNull()
    expect(getAliasesFor('builtin:read_file')).toBeNull()
    expect(getAliasesFor('mcp:filesystem')).toBeNull()
    expect(getAliasesFor('composio:hubspot')).toBeNull()
    expect(getAliasesFor('composio:airtable')).toBeNull()
    expect(getAliasesFor('nope')).toBeNull()
  })
})

describe('getCanonicalIdsFor', () => {
  it('returns an empty array for any key while the table is empty', () => {
    expect(getCanonicalIdsFor('notion')).toEqual([])
    expect(getCanonicalIdsFor('stripe')).toEqual([])
    expect(getCanonicalIdsFor('unknown')).toEqual([])
    expect(getCanonicalIdsFor('')).toEqual([])
  })
})

describe('isAliasLogicalKey', () => {
  it('returns false for any key while the table is empty', () => {
    expect(isAliasLogicalKey('notion')).toBe(false)
    expect(isAliasLogicalKey('github')).toBe(false)
    expect(isAliasLogicalKey('hubspot')).toBe(false)
    expect(isAliasLogicalKey('')).toBe(false)
  })

  it('does not confuse inherited object properties', () => {
    // guard against accidental `toString`, `hasOwnProperty` etc.
    expect(isAliasLogicalKey('toString')).toBe(false)
    expect(isAliasLogicalKey('hasOwnProperty')).toBe(false)
  })
})

describe('listAliasLogicalKeys', () => {
  it('returns every key exactly once (vacuously true on empty table)', () => {
    const keys = listAliasLogicalKeys()
    expect(new Set(keys).size).toBe(keys.length)
  })
})
