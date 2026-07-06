/**
 * Unit tests for the workspace pane substrate Zod schemas.
 *
 * Pairs with the TypeScript types in
 * `packages/cortex/src/gateway/types.ts`. The discriminated unions
 * here MUST stay in sync with the TS unions there — these tests are
 * the regression net.
 */

import { describe, it, expect } from 'vitest'
import {
  PaneConfigSchema,
  PaneMetadataSchema,
  CreateWorkspacePaneSchema,
  UpdateWorkspacePaneSchema,
  ReorderWorkspacePanesSchema,
  SetWorkspaceLayoutSchema,
} from '../../../src/gateway/validation/schemas.js'

// ---------------------------------------------------------------------------
// PaneConfigSchema — every kind round-trips
// ---------------------------------------------------------------------------

describe('PaneConfigSchema: source variants', () => {
  it('accepts inline source', () => {
    expect(
      PaneConfigSchema.safeParse({
        kind: 'markdown',
        source: { origin: 'inline', content: '# hi' },
      }).success,
    ).toBe(true)
  })

  it('accepts path source', () => {
    expect(
      PaneConfigSchema.safeParse({
        kind: 'markdown',
        source: { origin: 'path', path: 'README.md' },
      }).success,
    ).toBe(true)
  })

  it('accepts url source', () => {
    expect(
      PaneConfigSchema.safeParse({
        kind: 'markdown',
        source: { origin: 'url', url: 'https://example.com/x.md' },
      }).success,
    ).toBe(true)
  })

  it('rejects empty path', () => {
    expect(
      PaneConfigSchema.safeParse({
        kind: 'markdown',
        source: { origin: 'path', path: '' },
      }).success,
    ).toBe(false)
  })

  it('rejects malformed url', () => {
    expect(
      PaneConfigSchema.safeParse({
        kind: 'markdown',
        source: { origin: 'url', url: 'not-a-url' },
      }).success,
    ).toBe(false)
  })

  it('rejects unknown source.origin discriminator', () => {
    const result = PaneConfigSchema.safeParse({
      kind: 'markdown',
      source: { origin: 'invented', payload: 'x' },
    })
    expect(result.success).toBe(false)
  })
})

describe('PaneConfigSchema: each kind', () => {
  it('chat — requires profileId AND threadId', () => {
    expect(
      PaneConfigSchema.safeParse({
        kind: 'chat',
        profileId: 'coder',
        threadId: 'th_123',
      }).success,
    ).toBe(true)
    expect(
      PaneConfigSchema.safeParse({
        kind: 'chat',
        profileId: 'coder',
      }).success,
    ).toBe(false)
    expect(
      PaneConfigSchema.safeParse({
        kind: 'chat',
        threadId: 'th_123',
      }).success,
    ).toBe(false)
  })

  it('code — language and filename are optional', () => {
    expect(
      PaneConfigSchema.safeParse({
        kind: 'code',
        source: { origin: 'inline', content: 'console.log(1)' },
      }).success,
    ).toBe(true)
    expect(
      PaneConfigSchema.safeParse({
        kind: 'code',
        source: { origin: 'inline', content: 'console.log(1)' },
        language: 'typescript',
        filename: 'index.ts',
      }).success,
    ).toBe(true)
  })

  it('image — alt is optional + bounded', () => {
    expect(
      PaneConfigSchema.safeParse({
        kind: 'image',
        source: { origin: 'url', url: 'https://x.com/y.png' },
        alt: 'a small picture',
      }).success,
    ).toBe(true)
    expect(
      PaneConfigSchema.safeParse({
        kind: 'image',
        source: { origin: 'url', url: 'https://x.com/y.png' },
        alt: 'x'.repeat(281),
      }).success,
    ).toBe(false)
  })

  it('url — restricts source.origin to "url"', () => {
    expect(
      PaneConfigSchema.safeParse({
        kind: 'url',
        source: { origin: 'url', url: 'https://x.com' },
      }).success,
    ).toBe(true)
    // path or inline source is not valid for kind: url
    expect(
      PaneConfigSchema.safeParse({
        kind: 'url',
        source: { origin: 'path', path: '/etc/hosts' },
      }).success,
    ).toBe(false)
    expect(
      PaneConfigSchema.safeParse({
        kind: 'url',
        source: { origin: 'inline', content: '<html/>' },
      }).success,
    ).toBe(false)
  })

  it('html / mermaid / pdf / video / audio / csv / txt / json — accept any PaneSource', () => {
    for (const kind of ['html', 'mermaid', 'pdf', 'video', 'audio', 'csv', 'txt', 'json'] as const) {
      const result = PaneConfigSchema.safeParse({
        kind,
        source: { origin: 'inline', content: 'x' },
      })
      expect(result.success, `kind=${kind}`).toBe(true)
    }
  })

  it('diff — requires before AND after; language optional', () => {
    expect(
      PaneConfigSchema.safeParse({
        kind: 'diff',
        before: { origin: 'inline', content: 'a' },
        after: { origin: 'inline', content: 'b' },
      }).success,
    ).toBe(true)
    expect(
      PaneConfigSchema.safeParse({
        kind: 'diff',
        before: { origin: 'inline', content: 'a' },
        after: { origin: 'inline', content: 'b' },
        language: 'json',
      }).success,
    ).toBe(true)
    expect(
      PaneConfigSchema.safeParse({
        kind: 'diff',
        before: { origin: 'inline', content: 'a' },
      }).success,
    ).toBe(false)
  })

  it('terminal — cwd / shell are optional', () => {
    expect(PaneConfigSchema.safeParse({ kind: 'terminal' }).success).toBe(true)
    expect(
      PaneConfigSchema.safeParse({
        kind: 'terminal',
        cwd: '/tmp',
        shell: 'zsh',
      }).success,
    ).toBe(true)
  })

  it('files / tasks / plan — require their explicit reference field', () => {
    expect(PaneConfigSchema.safeParse({ kind: 'files', rootPath: '/tmp' }).success).toBe(true)
    expect(PaneConfigSchema.safeParse({ kind: 'files' }).success).toBe(false)

    expect(PaneConfigSchema.safeParse({ kind: 'tasks', workspaceId: 'ws_1' }).success).toBe(true)
    expect(PaneConfigSchema.safeParse({ kind: 'tasks' }).success).toBe(false)

    expect(PaneConfigSchema.safeParse({ kind: 'plan', planId: 'pl_1' }).success).toBe(true)
    expect(PaneConfigSchema.safeParse({ kind: 'plan' }).success).toBe(false)
  })

  it('chrome — requires url + devtools', () => {
    expect(
      PaneConfigSchema.safeParse({
        kind: 'chrome',
        url: 'https://example.com',
        devtools: false,
      }).success,
    ).toBe(true)
    expect(
      PaneConfigSchema.safeParse({
        kind: 'chrome',
        url: 'not-a-url',
        devtools: false,
      }).success,
    ).toBe(false)
  })

  it('3d / notebook — accept any PaneSource', () => {
    for (const kind of ['3d', 'notebook'] as const) {
      expect(
        PaneConfigSchema.safeParse({
          kind,
          source: { origin: 'inline', content: '{}' },
        }).success,
        `kind=${kind}`,
      ).toBe(true)
    }
  })

  it('scratchpad — requires remoteUrl', () => {
    expect(
      PaneConfigSchema.safeParse({
        kind: 'scratchpad',
        remoteUrl: 'https://scratch.example.com/abc',
      }).success,
    ).toBe(true)
    expect(
      PaneConfigSchema.safeParse({
        kind: 'scratchpad',
        remoteUrl: 'not-a-url',
      }).success,
    ).toBe(false)
  })

  it('rejects unknown kind', () => {
    expect(
      PaneConfigSchema.safeParse({
        kind: 'invented',
        source: { origin: 'inline', content: 'x' },
      }).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PaneMetadataSchema
// ---------------------------------------------------------------------------

describe('PaneMetadataSchema', () => {
  it('accepts the minimal required shape', () => {
    expect(
      PaneMetadataSchema.safeParse({
        openedBy: 'agent',
        pinned: false,
        closeable: true,
      }).success,
    ).toBe(true)
  })

  it('rejects missing pinned / closeable', () => {
    expect(
      PaneMetadataSchema.safeParse({ openedBy: 'agent', closeable: true }).success,
    ).toBe(false)
    expect(
      PaneMetadataSchema.safeParse({ openedBy: 'agent', pinned: false }).success,
    ).toBe(false)
  })

  it('accepts subagent + scoped + attachment fields', () => {
    expect(
      PaneMetadataSchema.safeParse({
        openedBy: 'agent',
        subagentId: 'sa_42',
        subagentLabel: 'Explorer',
        scopedToChatId: 'pane_chat_1',
        pinned: false,
        closeable: true,
        attachedTo: { kind: 'database', databaseId: 'db_1' },
      }).success,
    ).toBe(true)
  })

  it('attachment discriminator — connector / file / database', () => {
    for (const att of [
      { kind: 'database' as const, databaseId: 'db_1' },
      { kind: 'connector' as const, connectorId: 'gh' },
      { kind: 'file' as const, path: '/x' },
    ]) {
      expect(
        PaneMetadataSchema.safeParse({
          openedBy: 'agent',
          pinned: false,
          closeable: true,
          attachedTo: att,
        }).success,
        JSON.stringify(att),
      ).toBe(true)
    }
  })

  it('rejects unknown openedBy', () => {
    expect(
      PaneMetadataSchema.safeParse({
        openedBy: 'cron',
        pinned: false,
        closeable: true,
      }).success,
    ).toBe(false)
  })

  it('is strict — unknown keys rejected', () => {
    expect(
      PaneMetadataSchema.safeParse({
        openedBy: 'agent',
        pinned: false,
        closeable: true,
        unknownField: 'x',
      }).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// CreateWorkspacePaneSchema
// ---------------------------------------------------------------------------

describe('CreateWorkspacePaneSchema', () => {
  it('accepts a minimal markdown create', () => {
    expect(
      CreateWorkspacePaneSchema.safeParse({
        config: { kind: 'markdown', source: { origin: 'inline', content: '# hi' } },
      }).success,
    ).toBe(true)
  })

  it('accepts a fully-decorated create', () => {
    expect(
      CreateWorkspacePaneSchema.safeParse({
        zone: 'tabs',
        title: 'README',
        config: { kind: 'markdown', source: { origin: 'inline', content: '# hi' } },
        metadata: { openedBy: 'agent', pinned: false },
        placement: 'split',
        focused: true,
      }).success,
    ).toBe(true)
  })

  it('placement variants', () => {
    for (const placement of [
      'split',
      'new-tab',
      { in: 'group_a' },
      { after: 'pane_x' },
    ] as const) {
      expect(
        CreateWorkspacePaneSchema.safeParse({
          config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } },
          placement,
        }).success,
        JSON.stringify(placement),
      ).toBe(true)
    }
  })

  it('zone — only "tabs" or "side"', () => {
    expect(
      CreateWorkspacePaneSchema.safeParse({
        zone: 'bottom',
        config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } },
      }).success,
    ).toBe(false)
  })

  it('rejects unknown top-level keys (strict)', () => {
    expect(
      CreateWorkspacePaneSchema.safeParse({
        config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } },
        kind: 'markdown', // not allowed at the top — server derives from config.kind
      }).success,
    ).toBe(false)
  })

  it('rejects an empty body', () => {
    expect(CreateWorkspacePaneSchema.safeParse({}).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// UpdateWorkspacePaneSchema
// ---------------------------------------------------------------------------

describe('UpdateWorkspacePaneSchema', () => {
  it('accepts focused: true', () => {
    expect(UpdateWorkspacePaneSchema.safeParse({ focused: true }).success).toBe(true)
  })

  it('rejects focused: false (defocus only via another pane focusing)', () => {
    expect(UpdateWorkspacePaneSchema.safeParse({ focused: false }).success).toBe(false)
  })

  it('accepts a position-only patch', () => {
    expect(UpdateWorkspacePaneSchema.safeParse({ position: 3 }).success).toBe(true)
    expect(UpdateWorkspacePaneSchema.safeParse({ position: -1 }).success).toBe(false)
  })

  it('accepts scopedToChatId: null (clear → pin globally)', () => {
    expect(
      UpdateWorkspacePaneSchema.safeParse({ scopedToChatId: null }).success,
    ).toBe(true)
    expect(
      UpdateWorkspacePaneSchema.safeParse({ scopedToChatId: 'pane_chat_1' }).success,
    ).toBe(true)
  })

  it('accepts a config swap (mutating the pane content)', () => {
    expect(
      UpdateWorkspacePaneSchema.safeParse({
        config: { kind: 'markdown', source: { origin: 'inline', content: 'updated' } },
      }).success,
    ).toBe(true)
  })

  it('rejects an empty body', () => {
    expect(UpdateWorkspacePaneSchema.safeParse({}).success).toBe(false)
  })

  it('strict — unknown keys rejected', () => {
    expect(
      UpdateWorkspacePaneSchema.safeParse({ title: 'x', unknownField: 'y' }).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ReorderWorkspacePanesSchema
// ---------------------------------------------------------------------------

describe('ReorderWorkspacePanesSchema', () => {
  it('accepts a non-empty ids array scoped to a zone', () => {
    expect(
      ReorderWorkspacePanesSchema.safeParse({
        zone: 'tabs',
        ids: ['p1', 'p2', 'p3'],
      }).success,
    ).toBe(true)
  })

  it('rejects an empty ids array', () => {
    expect(
      ReorderWorkspacePanesSchema.safeParse({ zone: 'tabs', ids: [] }).success,
    ).toBe(false)
  })

  it('rejects ids containing empty strings', () => {
    expect(
      ReorderWorkspacePanesSchema.safeParse({ zone: 'tabs', ids: ['p1', ''] }).success,
    ).toBe(false)
  })

  it('rejects unknown zone', () => {
    expect(
      ReorderWorkspacePanesSchema.safeParse({ zone: 'top', ids: ['p1'] }).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SetWorkspaceLayoutSchema
// ---------------------------------------------------------------------------

describe('SetWorkspaceLayoutSchema', () => {
  it('accepts a layout-only payload', () => {
    expect(
      SetWorkspaceLayoutSchema.safeParse({ layout: '{"groups":[]}' }).success,
    ).toBe(true)
  })

  it('accepts an empty layout string (caller intent: reset layout)', () => {
    expect(SetWorkspaceLayoutSchema.safeParse({ layout: '' }).success).toBe(true)
  })

  it('accepts a sideTrackWidth-only payload (drag handle PATCH)', () => {
    expect(
      SetWorkspaceLayoutSchema.safeParse({ sideTrackWidth: 720 }).success,
    ).toBe(true)
  })

  it('accepts a payload with both fields', () => {
    expect(
      SetWorkspaceLayoutSchema.safeParse({
        layout: '{}',
        sideTrackWidth: 480,
      }).success,
    ).toBe(true)
  })

  it('rejects empty body — at least one field required', () => {
    expect(SetWorkspaceLayoutSchema.safeParse({}).success).toBe(false)
  })

  it('rejects non-integer sideTrackWidth', () => {
    expect(
      SetWorkspaceLayoutSchema.safeParse({ sideTrackWidth: 480.5 }).success,
    ).toBe(false)
  })

  it('rejects zero or negative sideTrackWidth', () => {
    expect(
      SetWorkspaceLayoutSchema.safeParse({ sideTrackWidth: 0 }).success,
    ).toBe(false)
    expect(
      SetWorkspaceLayoutSchema.safeParse({ sideTrackWidth: -100 }).success,
    ).toBe(false)
  })

  it('rejects sideTrackWidth above the 5000 px ceiling', () => {
    expect(
      SetWorkspaceLayoutSchema.safeParse({ sideTrackWidth: 5001 }).success,
    ).toBe(false)
  })

  it('strict — unknown keys rejected', () => {
    expect(
      SetWorkspaceLayoutSchema.safeParse({ layout: '{}', extra: 1 }).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Round-trip: parse → stringify → parse equals input
// ---------------------------------------------------------------------------

describe('round-trip', () => {
  it('PaneConfig — markdown survives JSON serialization', () => {
    const input = {
      kind: 'markdown' as const,
      source: { origin: 'inline' as const, content: '# title\n\nbody' },
    }
    const reparsed = PaneConfigSchema.parse(JSON.parse(JSON.stringify(PaneConfigSchema.parse(input))))
    expect(reparsed).toEqual(input)
  })

  it('CreateWorkspacePaneSchema — full payload survives JSON serialization', () => {
    const input = {
      zone: 'tabs' as const,
      title: 'README',
      config: {
        kind: 'markdown' as const,
        source: { origin: 'inline' as const, content: '# hi' },
      },
      metadata: { openedBy: 'agent' as const, pinned: false },
      placement: 'split' as const,
      focused: true,
    }
    const parsed = CreateWorkspacePaneSchema.parse(input)
    const reparsed = CreateWorkspacePaneSchema.parse(JSON.parse(JSON.stringify(parsed)))
    expect(reparsed).toEqual(input)
  })
})
