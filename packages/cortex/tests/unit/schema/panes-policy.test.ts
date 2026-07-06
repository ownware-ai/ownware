/**
 * Unit tests for `ProfilePanePolicySchema` + `panes` field on the
 * root `ProfileSchema`. Plus a sanity check that the local
 * `PANE_KIND_VALUES` list in `profile/schema.ts` agrees with the
 * canonical `PANE_KINDS` in `gateway/validation/schemas.ts`.
 *
 * Slice 3.1 (profile schema panes block) regression net.
 */

import { describe, it, expect } from 'vitest'
import {
  ProfileSchema,
  ProfilePanePolicySchema,
  ProfilePanePresetSchema,
} from '../../../src/profile/schema.js'
import { PANE_KINDS, PaneKindSchema } from '../../../src/gateway/validation/schemas.js'

// ---------------------------------------------------------------------------
// PANE_KINDS is the canonical list — profile/schema.ts mirrors it
// ---------------------------------------------------------------------------

describe('PANE_KINDS canonical list', () => {
  it('contains all 22 pane kinds from DESIGN.md §6', () => {
    expect(PANE_KINDS).toHaveLength(22)
    expect([...PANE_KINDS].sort()).toEqual([
      '3d',
      'audio',
      'chat',
      'chrome',
      'code',
      'csv',
      'diff',
      'files',
      'html',
      'image',
      'json',
      'markdown',
      'mermaid',
      'notebook',
      'pdf',
      'plan',
      'scratchpad',
      'tasks',
      'terminal',
      'txt',
      'url',
      'video',
    ])
  })

  it('PaneKindSchema accepts every value in PANE_KINDS', () => {
    for (const k of PANE_KINDS) {
      expect(PaneKindSchema.safeParse(k).success).toBe(true)
    }
  })

  it('PaneKindSchema rejects unknown kinds', () => {
    expect(PaneKindSchema.safeParse('invented').success).toBe(false)
    expect(PaneKindSchema.safeParse('').success).toBe(false)
  })

  it('the profile schema and the gateway validation schema agree on the kind list', () => {
    // ProfilePanePolicy validates allowedKinds against its own local
    // copy of the kind tuple. This test asserts the two lists stay
    // synced — adding a kind in one place without the other would
    // fail this assertion.
    for (const k of PANE_KINDS) {
      const result = ProfilePanePolicySchema.safeParse({ allowedKinds: [k] })
      expect(result.success, `kind=${k} should be accepted by profile policy`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// ProfilePanePresetSchema
// ---------------------------------------------------------------------------

describe('ProfilePanePresetSchema', () => {
  it('accepts a minimal preset (label + kind)', () => {
    expect(
      ProfilePanePresetSchema.safeParse({
        label: 'Live preview',
        kind: 'chrome',
      }).success,
    ).toBe(true)
  })

  it('accepts a preset with author-supplied data', () => {
    expect(
      ProfilePanePresetSchema.safeParse({
        label: 'Notion workspace',
        kind: 'chrome',
        data: { url: 'https://notion.so/me/team' },
      }).success,
    ).toBe(true)
  })

  it('rejects unknown kind', () => {
    expect(
      ProfilePanePresetSchema.safeParse({ label: 'X', kind: 'invented' }).success,
    ).toBe(false)
  })

  it('rejects missing label', () => {
    expect(ProfilePanePresetSchema.safeParse({ kind: 'chat' }).success).toBe(false)
  })

  it('rejects empty label', () => {
    expect(
      ProfilePanePresetSchema.safeParse({ label: '', kind: 'chat' }).success,
    ).toBe(false)
  })

  it('strict — unknown keys rejected', () => {
    expect(
      ProfilePanePresetSchema.safeParse({
        label: 'X',
        kind: 'chat',
        somethingElse: true,
      }).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ProfilePanePolicySchema
// ---------------------------------------------------------------------------

describe('ProfilePanePolicySchema', () => {
  it('accepts a minimal policy and fills defaults', () => {
    const result = ProfilePanePolicySchema.parse({})
    expect(result.allowedKinds).toEqual(['chat', 'markdown'])
    expect(result.defaultAgentPlacement).toBe('split')
    expect(result.newTabPresets).toEqual([])
  })

  it('honours an explicit allowedKinds array', () => {
    const result = ProfilePanePolicySchema.parse({
      allowedKinds: ['chat', 'markdown', 'code', 'terminal'],
    })
    expect(result.allowedKinds).toEqual(['chat', 'markdown', 'code', 'terminal'])
  })

  it('deduplicates allowedKinds', () => {
    const result = ProfilePanePolicySchema.parse({
      allowedKinds: ['chat', 'markdown', 'chat', 'markdown'],
    })
    expect(result.allowedKinds).toEqual(['chat', 'markdown'])
  })

  it('rejects an unknown kind in allowedKinds', () => {
    expect(
      ProfilePanePolicySchema.safeParse({ allowedKinds: ['chat', 'invented'] }).success,
    ).toBe(false)
  })

  it('honours an explicit defaultAgentPlacement', () => {
    expect(ProfilePanePolicySchema.parse({ defaultAgentPlacement: 'new-tab' }).defaultAgentPlacement).toBe('new-tab')
  })

  it('rejects an invalid defaultAgentPlacement', () => {
    expect(
      ProfilePanePolicySchema.safeParse({ defaultAgentPlacement: 'overlay' }).success,
    ).toBe(false)
  })

  it('honours newTabPresets', () => {
    const result = ProfilePanePolicySchema.parse({
      newTabPresets: [
        { label: 'Live preview', kind: 'chrome' },
        { label: 'Files', kind: 'files', data: { rootPath: '/' } },
      ],
    })
    expect(result.newTabPresets).toHaveLength(2)
    expect(result.newTabPresets[0]?.label).toBe('Live preview')
  })

  it('strict — unknown top-level keys rejected', () => {
    expect(
      ProfilePanePolicySchema.safeParse({ foo: 'bar' }).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ProfileSchema: the panes field
// ---------------------------------------------------------------------------

describe('ProfileSchema: panes field', () => {
  it('a minimal profile config gets a default panes block', () => {
    const result = ProfileSchema.parse({ name: 'test-agent' })
    expect(result.panes).toEqual({
      allowedKinds: ['chat', 'markdown'],
      defaultAgentPlacement: 'split',
      newTabPresets: [],
    })
  })

  it('an explicit panes block is honoured', () => {
    const result = ProfileSchema.parse({
      name: 'coder',
      panes: {
        allowedKinds: ['chat', 'markdown', 'code', 'terminal', 'files'],
        defaultAgentPlacement: 'split',
        newTabPresets: [
          { label: 'Live preview', kind: 'chrome' },
        ],
      },
    })
    expect(result.panes.allowedKinds).toEqual([
      'chat', 'markdown', 'code', 'terminal', 'files',
    ])
    expect(result.panes.newTabPresets).toHaveLength(1)
  })

  it('a partial panes block fills missing fields with defaults', () => {
    const result = ProfileSchema.parse({
      name: 'writer',
      panes: { allowedKinds: ['chat', 'markdown', 'pdf'] },
    })
    expect(result.panes.allowedKinds).toEqual(['chat', 'markdown', 'pdf'])
    expect(result.panes.defaultAgentPlacement).toBe('split')
    expect(result.panes.newTabPresets).toEqual([])
  })

  it('rejects a profile with an invalid pane kind in allowedKinds', () => {
    expect(
      ProfileSchema.safeParse({
        name: 'broken',
        panes: { allowedKinds: ['chat', 'sourcery'] },
      }).success,
    ).toBe(false)
  })
})
