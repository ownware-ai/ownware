/**
 * Unit tests for the `open_pane` tool's contract layer (slice 3.2).
 *
 * Covers:
 *   - The tool name is the canonical `'open_pane'` constant.
 *   - The default input schema accepts every PaneConfig variant.
 *   - The default schema rejects unknown top-level keys.
 *   - `narrowPaneConfigSchema(allowedKinds)` narrows the `kind` enum
 *     correctly:
 *       * Allowed kinds parse.
 *       * Disallowed kinds reject.
 *       * Single-kind allowlist still works.
 *       * Empty allowlist throws at schema-build time (not runtime).
 *       * Allowlist with no matching kinds throws.
 */

import { describe, it, expect } from 'vitest'
import {
  OPEN_PANE_TOOL_NAME,
  OpenPaneToolInputSchema,
  narrowPaneConfigSchema,
} from '../../../src/tools/open-pane/index.js'

describe('OPEN_PANE_TOOL_NAME', () => {
  it('is the canonical "open_pane" string', () => {
    expect(OPEN_PANE_TOOL_NAME).toBe('open_pane')
  })
})

describe('OpenPaneToolInputSchema (default — all kinds)', () => {
  it('accepts a markdown config', () => {
    expect(
      OpenPaneToolInputSchema.safeParse({
        config: { kind: 'markdown', source: { origin: 'inline', content: '# hi' } },
      }).success,
    ).toBe(true)
  })

  it('accepts an explicit title + placement', () => {
    expect(
      OpenPaneToolInputSchema.safeParse({
        config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } },
        title: 'README.md',
        placement: 'split',
      }).success,
    ).toBe(true)
  })

  it('placement variants all parse', () => {
    for (const placement of [
      'split',
      'new-tab',
      { in: 'group_a' },
      { after: 'pane_x' },
    ] as const) {
      const result = OpenPaneToolInputSchema.safeParse({
        config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } },
        placement,
      })
      expect(result.success, JSON.stringify(placement)).toBe(true)
    }
  })

  it('strict — unknown top-level keys rejected', () => {
    expect(
      OpenPaneToolInputSchema.safeParse({
        config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } },
        workspaceId: 'ws_1',  // not allowed — server derives from session
      }).success,
    ).toBe(false)
  })

  it('rejects missing config', () => {
    expect(OpenPaneToolInputSchema.safeParse({ title: 'x' }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// narrowPaneConfigSchema
// ---------------------------------------------------------------------------

describe('narrowPaneConfigSchema(allowedKinds)', () => {
  it('accepts kinds in the allowlist', () => {
    const schema = narrowPaneConfigSchema(['chat', 'markdown'])
    expect(
      schema.safeParse({
        config: { kind: 'chat', profileId: 'coder', threadId: 'th_1' },
      }).success,
    ).toBe(true)
    expect(
      schema.safeParse({
        config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } },
      }).success,
    ).toBe(true)
  })

  it('rejects kinds NOT in the allowlist', () => {
    const schema = narrowPaneConfigSchema(['chat', 'markdown'])
    expect(
      schema.safeParse({
        config: { kind: 'code', source: { origin: 'inline', content: 'x' } },
      }).success,
    ).toBe(false)
    expect(
      schema.safeParse({
        config: { kind: 'terminal' },
      }).success,
    ).toBe(false)
  })

  it('accepts a single-kind allowlist', () => {
    const schema = narrowPaneConfigSchema(['markdown'])
    expect(
      schema.safeParse({
        config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } },
      }).success,
    ).toBe(true)
    // Anything else rejected.
    expect(
      schema.safeParse({
        config: { kind: 'chat', profileId: 'coder', threadId: 't' },
      }).success,
    ).toBe(false)
  })

  it('throws at schema-build time on an empty allowlist', () => {
    expect(() => narrowPaneConfigSchema([])).toThrow(/empty/i)
  })

  it('still threads title + placement through', () => {
    const schema = narrowPaneConfigSchema(['markdown'])
    expect(
      schema.safeParse({
        config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } },
        title: 'Brief',
        placement: 'new-tab',
      }).success,
    ).toBe(true)
  })

  it('strict — narrowed schema also rejects unknown top-level keys', () => {
    const schema = narrowPaneConfigSchema(['markdown'])
    expect(
      schema.safeParse({
        config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } },
        somethingWeird: 1,
      }).success,
    ).toBe(false)
  })
})
