/**
 * Pane kind policy — single source of truth for "is this kind tied to a
 * specific chat or shared across the workspace?".
 *
 * Two callers consult this:
 *
 *   1. The `open_pane` tool (`packages/cortex/src/tools/open-pane/tool.ts`)
 *      when the agent opens a pane during a chat. If the kind is
 *      `'chat-scoped'`, the resulting pane row carries
 *      `metadata.scopedToChatId = <activeChatPaneId>`, which the client
 *      side then uses to hide/show the pane per chat tab.
 *
 *   2. The client's Tools dropdown
 *      when the user opens a pane manually. Same lookup — same
 *      behaviour. The agent path and the user path stay symmetric.
 *
 * Why one place, not two: a future pane kind (`excalidraw`, `terminal-vim`,
 * `pgadmin`, `pdf-annot`, …) should require a SINGLE policy decision,
 * not edits in three different files. The `Record<PaneKind, …>`
 * exhaustiveness check below forces every kind to declare a scope at
 * compile time — adding a new kind to the `PaneConfig` discriminated
 * union without an entry here breaks the build immediately.
 *
 * The mapping itself is a product decision, not a technical one:
 *
 *   - **Workspace-wide** — the user's persistent tools that benefit
 *     from sharing state across conversations. Today: `terminal`
 *     (one shell running `npm run dev` across all chats), `files`
 *     (the workspace's filesystem — same files regardless of which
 *     chat is focused). Chat panes are workspace-wide for a different
 *     reason: a chat IS the tab, it has no parent to scope to.
 *
 *   - **Chat-scoped** — agent output that belongs to the conversation
 *     that produced it. Today: every content viewer (markdown, code,
 *     image, url, html, mermaid, pdf, video, audio, csv, txt, json,
 *     diff, notebook), embedded browser (chrome), specialty surfaces
 *     (3d, scratchpad), and the conversation-specific working state
 *     panes (tasks, plan). Switching chat tabs swaps these in/out;
 *     closing a chat cascades-deletes them (DB-layer, Slice 3b).
 *
 * When a kind doesn't fit either bucket cleanly, the default is
 * `'chat-scoped'` — agent's output is scoped by default; sharing
 * across conversations is the opt-in. That matches the product
 * theme: each conversation is its own unit of work.
 *
 * Wave 3c of the workspace-tab-architecture work.
 */

import type { PaneKind } from './types.js'

export type PaneKindScope = 'chat-scoped' | 'workspace-wide'

/**
 * Per-kind scope policy. Exhaustive over `PaneKind` — adding a new
 * variant to `PaneConfig` (in `types.ts`) without an entry here is a
 * compile error.
 *
 * Each entry has a one-line rationale so future readers know *why*,
 * not just *what*.
 */
const DEFAULT_SCOPE: Record<PaneKind, PaneKindScope> = {
  // ── Workspace-wide ────────────────────────────────────────────────
  chat:       'workspace-wide', // a chat IS the tab; it has no parent chat to scope to
  terminal:   'workspace-wide', // user's persistent shell — `npm run dev` runs across conversations
  files:      'workspace-wide', // the workspace's filesystem tree — same files regardless of chat

  // ── Chat-scoped — conversation working state ──────────────────────
  tasks:      'chat-scoped',    // each conversation builds its own todo list
  plan:       'chat-scoped',    // each conversation plans its own approach

  // ── Chat-scoped — content viewers (agent's output for THIS chat) ──
  markdown:   'chat-scoped',
  code:       'chat-scoped',
  image:      'chat-scoped',
  url:        'chat-scoped',
  html:       'chat-scoped',
  mermaid:    'chat-scoped',
  pdf:        'chat-scoped',
  video:      'chat-scoped',
  audio:      'chat-scoped',
  csv:        'chat-scoped',
  txt:        'chat-scoped',
  json:       'chat-scoped',
  diff:       'chat-scoped',
  notebook:   'chat-scoped',

  // ── Chat-scoped — specialty / embedded ────────────────────────────
  chrome:     'chat-scoped',    // an embedded browser the agent opened for THIS conversation
  '3d':       'chat-scoped',
  scratchpad: 'chat-scoped',    // a remote shared scratchpad bound to the conversation context
}

/**
 * Return the default scope for a pane kind. Pure, branchless lookup.
 *
 * Callers should pass this through to pane metadata as
 * `scopedToChatId = activeChatPaneId` when the result is `'chat-scoped'`,
 * and leave `scopedToChatId` undefined when the result is
 * `'workspace-wide'`. No caller should hard-code "if kind === X then …"
 * — consult this function instead so the rule lives in one place.
 */
export function defaultScopeForKind(kind: PaneKind): PaneKindScope {
  return DEFAULT_SCOPE[kind]
}

/**
 * Convenience: returns `true` iff the kind defaults to chat-scoped.
 * Two callers — agent's `open_pane`, the client's Tools dropdown — both
 * end up doing the same boolean check, so we expose it directly.
 */
export function isChatScopedKind(kind: PaneKind): boolean {
  return DEFAULT_SCOPE[kind] === 'chat-scoped'
}
