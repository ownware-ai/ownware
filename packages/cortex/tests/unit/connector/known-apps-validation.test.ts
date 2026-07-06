/**
 * Strict catalog validation for `known-apps.json`.
 *
 * Phase 2 (2026-05-06) of the connector production rebuild.
 *
 * The standard `loadKnownApps()` reader silently skips malformed
 * rows; that's the right behavior at runtime (don't crash the gateway
 * for one bad row). But at build time, we want loud failure: any
 * dangling entry — a row whose `via` doesn't resolve to a real
 * featured connector — is a UX hazard. It surfaces in `/tools` as a
 * "Connect →" card that has nothing to actually connect to.
 *
 * This test is the gate. It fails CI on any structural OR
 * cross-reference failure, with a per-row reason.
 *
 * To diagnose a failure:
 *   - "via points at MCP id 'X' which is not in FEATURED_SERVERS" —
 *     either add 'X' to packages/cortex/src/connector/mcp/featured.ts,
 *     or remove the offending row from the known-apps.json catalog.
 *   - "via points at Composio slug 'X' which is not in
 *     FEATURED_COMPOSIO_TOOLKITS" — Composio is dropped from Tier 1
 *     in v1; drop the row, or wait for the Advanced →
 *     BYO-Composio surface.
 *   - "structural validation failed: …" — the row's shape doesn't
 *     match `KnownAppEntrySchema`. Fix the JSON.
 */

import { describe, it, expect } from 'vitest'
import { validateKnownAppsCatalog } from '../../../src/connector/known-apps.js'

describe('known-apps.json catalog validation', () => {
  it('every row resolves to a real featured connector (no dangling entries)', async () => {
    const failures = await validateKnownAppsCatalog()
    if (failures.length > 0) {
      // Fail with a structured, copy-pasteable diagnostic so the dev
      // doesn't have to scroll through assertion noise to find the
      // offending row.
      const message = [
        `${failures.length} known-apps.json row(s) failed validation:`,
        '',
        ...failures.map(f => `  • ${f.platformId}\n    ${f.reason}`),
      ].join('\n')
      throw new Error(message)
    }
    expect(failures).toEqual([])
  })

  it('catalog is non-empty (we ship at least one detected-app hint)', async () => {
    // Sanity: an empty catalog probably means the file moved or the
    // search-paths broke. Better to fail here than silently disable
    // detection hints in the lobby.
    const failures = await validateKnownAppsCatalog()
    // If everything's valid, also assert the catalog has some content.
    // We don't pin a specific count — the curated set evolves — but
    // empty would be a regression.
    if (failures.length === 0) {
      const { loadKnownApps, __resetKnownAppsCacheForTests } = await import(
        '../../../src/connector/known-apps.js'
      )
      __resetKnownAppsCacheForTests()
      const idx = await loadKnownApps()
      expect(idx.byPlatformId.size).toBeGreaterThan(0)
    }
  })
})
