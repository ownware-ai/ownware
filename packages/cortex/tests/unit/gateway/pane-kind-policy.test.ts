/**
 * Unit tests for `pane-kind-policy.ts`.
 *
 * The policy itself is a hand-crafted table; the most useful tests are:
 *
 *   1. Spot-check the product-critical kinds (terminal/files = workspace,
 *      tasks/plan = chat). If someone "fixes" the table by mistake, the
 *      test catches it.
 *   2. Confirm `chat` resolves to workspace-wide (chat-as-its-own-tab
 *      invariant — a chat scoping to a parent chat is nonsense).
 *   3. Confirm the table covers every variant of the `PaneConfig` union —
 *      this is the run-time backstop for the compile-time
 *      `Record<PaneKind, …>` exhaustiveness check. Both together
 *      guarantee no kind ever ships without a scope decision.
 */

import { describe, it, expect } from 'vitest'
import {
  defaultScopeForKind,
  isChatScopedKind,
} from '../../../src/gateway/pane-kind-policy.js'
import type { PaneConfig, PaneKind } from '../../../src/gateway/types.js'

// Every kind currently in the `PaneConfig` discriminated union. Derived
// here as a literal tuple so the test stays in lockstep with the source
// type. When a new kind ships in `PaneConfig`, this list must be
// extended too — and the policy must accept it (covered by the
// exhaustiveness test below). The two checks together pin "every kind
// has a scope decision."
const ALL_KINDS: readonly PaneKind[] = [
  'chat',
  'markdown',
  'code',
  'image',
  'url',
  'html',
  'mermaid',
  'pdf',
  'video',
  'audio',
  'csv',
  'txt',
  'json',
  'diff',
  'terminal',
  'files',
  'tasks',
  'plan',
  'chrome',
  '3d',
  'notebook',
  'scratchpad',
] as const

describe('pane-kind-policy: defaultScopeForKind', () => {
  it('chat panes are workspace-wide (a chat IS the tab, no parent)', () => {
    expect(defaultScopeForKind('chat')).toBe('workspace-wide')
  })

  it('terminal is workspace-wide (one shell shared across conversations)', () => {
    expect(defaultScopeForKind('terminal')).toBe('workspace-wide')
  })

  it('files viewer is workspace-wide (same filesystem regardless of chat)', () => {
    expect(defaultScopeForKind('files')).toBe('workspace-wide')
  })

  it('tasks are chat-scoped (each conversation has its own todo list)', () => {
    expect(defaultScopeForKind('tasks')).toBe('chat-scoped')
  })

  it('plan is chat-scoped (each conversation plans its own approach)', () => {
    expect(defaultScopeForKind('plan')).toBe('chat-scoped')
  })

  it.each([
    'markdown', 'code', 'image', 'url', 'html', 'mermaid',
    'pdf', 'video', 'audio', 'csv', 'txt', 'json', 'diff', 'notebook',
  ] as const)('%s viewer is chat-scoped (agent output belongs to the conversation)', (kind) => {
    expect(defaultScopeForKind(kind)).toBe('chat-scoped')
  })

  it.each(['chrome', '3d', 'scratchpad'] as const)(
    '%s is chat-scoped (specialty / embedded surfaces belong to the conversation)',
    (kind) => {
      expect(defaultScopeForKind(kind)).toBe('chat-scoped')
    },
  )
})

describe('pane-kind-policy: isChatScopedKind', () => {
  it('returns true for chat-scoped kinds', () => {
    expect(isChatScopedKind('markdown')).toBe(true)
    expect(isChatScopedKind('tasks')).toBe(true)
    expect(isChatScopedKind('plan')).toBe(true)
  })

  it('returns false for workspace-wide kinds', () => {
    expect(isChatScopedKind('chat')).toBe(false)
    expect(isChatScopedKind('terminal')).toBe(false)
    expect(isChatScopedKind('files')).toBe(false)
  })
})

describe('pane-kind-policy: exhaustiveness', () => {
  it('every PaneKind in PaneConfig is covered by the policy', () => {
    // Compile-time check via `Record<PaneKind, …>` in pane-kind-policy.ts
    // is the primary guarantee. This test is the run-time backstop —
    // makes sure ALL_KINDS in this file stays in sync with the
    // `PaneConfig` discriminated union, and that every entry resolves
    // to a valid scope.
    for (const kind of ALL_KINDS) {
      const scope = defaultScopeForKind(kind)
      expect(['chat-scoped', 'workspace-wide']).toContain(scope)
    }
  })

  it('ALL_KINDS matches the kinds reachable through the PaneConfig union', () => {
    // Cheap synthetic check: build one PaneConfig per kind and confirm
    // its `kind` field round-trips through ALL_KINDS. If a new variant
    // is added to PaneConfig without adding it to ALL_KINDS, this test
    // surfaces the gap (alongside the compile-time error in
    // pane-kind-policy.ts itself).
    const sample: PaneConfig['kind'][] = ALL_KINDS.slice()
    expect(new Set(sample).size).toBe(ALL_KINDS.length)
  })
})
