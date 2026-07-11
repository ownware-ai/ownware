/**
 * Tool UI descriptors — how a tool call renders as a card.
 *
 * The descriptor is pure data (mirrors Loom's `ToolUIDescriptor`): it says a
 * tool's kind, the summary verb + which input field is the headline, an
 * optional expandable preview (which field + format), and an optional open
 * action. A client renders ANY tool from its descriptor — no per-tool UI code.
 *
 * The built-in tools' descriptors are STATIC (defined in Loom), so we ship
 * them here as `BUILTIN_DESCRIPTORS` — the built-ins render correctly out of
 * the box, no gateway fetch. Custom tools: pass your own descriptor map.
 * `describeToolCall()` resolves a ToolCall + descriptor into render-ready parts.
 */

import type { ToolCall } from './types.js'

export type ToolUIKind =
  | 'file-write'
  | 'file-read'
  | 'file-edit'
  | 'shell'
  | 'search'
  | 'image'
  | 'external-action'
  | 'conversational'

export interface ToolUISummary {
  readonly verb: string
  readonly primaryField?: string
  readonly metaFields?: readonly string[]
}

export interface ToolUIPreview {
  readonly contentField: string
  readonly format: 'code' | 'diff' | 'markdown' | 'plain' | 'image-thumb'
  readonly truncateAtLines?: number
}

export interface ToolUIOpenAction {
  readonly target: 'file-pane' | 'terminal-pane' | 'image-pane' | 'search-pane' | 'url'
  readonly pathField: string
}

export interface ToolUIDescriptor {
  readonly kind: ToolUIKind
  readonly summary: ToolUISummary
  readonly preview?: ToolUIPreview
  readonly openAction?: ToolUIOpenAction
}

/** The built-in tools' descriptors, mirrored from Loom (packages/loom/src/tools/builtins). */
export const BUILTIN_DESCRIPTORS: Readonly<Record<string, ToolUIDescriptor>> = {
  // filesystem
  readFile: { kind: 'file-read', summary: { verb: 'Read', primaryField: 'file_path' }, preview: { contentField: 'content', format: 'code', truncateAtLines: 10 }, openAction: { target: 'file-pane', pathField: 'file_path' } },
  writeFile: { kind: 'file-write', summary: { verb: 'Wrote', primaryField: 'file_path' }, preview: { contentField: 'content', format: 'code', truncateAtLines: 10 }, openAction: { target: 'file-pane', pathField: 'file_path' } },
  editFile: { kind: 'file-edit', summary: { verb: 'Edited', primaryField: 'file_path' }, preview: { contentField: 'new_string', format: 'diff', truncateAtLines: 10 }, openAction: { target: 'file-pane', pathField: 'file_path' } },
  listFiles: { kind: 'file-read', summary: { verb: 'Listed', primaryField: 'path' }, openAction: { target: 'file-pane', pathField: 'path' } },
  glob: { kind: 'search', summary: { verb: 'Matched', primaryField: 'pattern' }, preview: { contentField: 'content', format: 'plain', truncateAtLines: 10 } },
  grep: { kind: 'search', summary: { verb: 'Searched', primaryField: 'pattern' }, preview: { contentField: 'content', format: 'plain', truncateAtLines: 10 } },
  // shell
  shell_execute: { kind: 'shell', summary: { verb: 'Ran', primaryField: 'command' }, preview: { contentField: 'output', format: 'plain', truncateAtLines: 10 }, openAction: { target: 'terminal-pane', pathField: 'sessionId' } },
  // web
  web_search: { kind: 'search', summary: { verb: 'Searched web', primaryField: 'query' }, preview: { contentField: 'results', format: 'markdown', truncateAtLines: 10 } },
  web_fetch: { kind: 'external-action', summary: { verb: 'Fetched', primaryField: 'url' }, preview: { contentField: 'content', format: 'markdown', truncateAtLines: 10 }, openAction: { target: 'url', pathField: 'url' } },
  // memory / tasks / agents / skills
  memory_store: { kind: 'external-action', summary: { verb: 'Remembered', primaryField: 'content' } },
  memory_search: { kind: 'search', summary: { verb: 'Recalled', primaryField: 'query' } },
  memory_forget: { kind: 'external-action', summary: { verb: 'Forgot', primaryField: 'id' } },
  todo_write: { kind: 'conversational', summary: { verb: 'Updated tasks' } },
  agent_spawn: { kind: 'conversational', summary: { verb: 'Delegated', primaryField: 'subagent_type' } },
  skill: { kind: 'external-action', summary: { verb: 'Invoked skill', primaryField: 'name' } },
  ask_user: { kind: 'conversational', summary: { verb: 'Asked you' } },
  request_credential: { kind: 'conversational', summary: { verb: 'Requested a credential' } },
  image_generate: { kind: 'image', summary: { verb: 'Generated image', primaryField: 'prompt' } },
}

/** Render-ready view of a tool call, resolved from its descriptor. */
export interface ToolRender {
  readonly kind: ToolUIKind
  /** Conversational tools render as a compact one-liner, not a card. */
  readonly conversational: boolean
  readonly verb: string
  /** The headline input value (path, command, query, url…). */
  readonly primary?: string
  /** The expandable preview body + its format. */
  readonly preview?: { readonly text: string; readonly format: ToolUIPreview['format'] }
  /** A clickable URL when the descriptor's open action targets one. */
  readonly openUrl?: string
}

/**
 * Resolve a ToolCall + its descriptor into render-ready parts. Falls back to a
 * generic view (tool name + first input + raw result) when no descriptor exists.
 */
export function describeToolCall(call: ToolCall, descriptor?: ToolUIDescriptor): ToolRender {
  const d = descriptor ?? BUILTIN_DESCRIPTORS[call.name]
  if (!d) {
    return {
      kind: 'external-action',
      conversational: false,
      verb: call.name,
      primary: firstStringValue(call.input),
      preview: call.result ? { text: call.result, format: 'plain' } : undefined,
    }
  }

  const primary = d.summary.primaryField ? asString(call.input[d.summary.primaryField]) : ''

  let preview: ToolRender['preview']
  if (d.preview) {
    // The preview field is either an INPUT field (e.g. the content written) or
    // names the tool's OUTPUT (e.g. shell 'output') — fall back to the result.
    const text = asString(call.input[d.preview.contentField]) || (call.result ?? '')
    if (text) preview = { text, format: d.preview.format }
  } else if (call.result && d.kind !== 'conversational') {
    preview = { text: call.result, format: 'plain' }
  }

  const openUrl = d.openAction?.target === 'url' ? asString(call.input[d.openAction.pathField]) : ''

  return {
    kind: d.kind,
    conversational: d.kind === 'conversational',
    verb: d.summary.verb,
    primary: primary || undefined,
    preview,
    openUrl: openUrl || undefined,
  }
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function firstStringValue(input: Record<string, unknown>): string | undefined {
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  }
  return undefined
}
