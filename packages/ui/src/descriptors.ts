/**
 * Tool UI descriptors — how a tool call renders as a card.
 *
 * The descriptor is pure data (mirrors Loom's `ToolUIDescriptor`): it says a
 * tool's kind, the summary verb + which input field is the headline, an
 * optional expandable preview (which field + format), and an optional open
 * action. A client renders ANY tool from its descriptor — no per-tool UI code.
 *
 * The exact tool instance's descriptor may travel with `tool.call.start`.
 * There is deliberately NO name-keyed descriptor catalogue in this package: a
 * tool's name is not evidence of what it does, so a familiar-looking name earns
 * no kind, primary field or open action. A call without an exact descriptor
 * renders generically under its own name.
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

const MAX_DESCRIPTOR_TEXT = 120
const MAX_DESCRIPTOR_META_FIELDS = 16
const MAX_PREVIEW_LINES = 10_000

/**
 * Structurally validate and copy untrusted presentation metadata. This proves
 * only that a descriptor is bounded and renderable; it never proves an effect.
 */
export function normalizeToolUIDescriptor(value: unknown): ToolUIDescriptor | undefined {
  if (!isRecord(value) || !isToolKind(value['kind']) || !isRecord(value['summary'])) {
    return undefined
  }
  const verb = boundedString(value['summary']['verb'])
  if (!verb) return undefined
  const primaryField = value['summary']['primaryField'] === undefined
    ? undefined
    : boundedString(value['summary']['primaryField'])
  if (value['summary']['primaryField'] !== undefined && !primaryField) return undefined

  let metaFields: readonly string[] | undefined
  if (value['summary']['metaFields'] !== undefined) {
    const raw = value['summary']['metaFields']
    if (
      !Array.isArray(raw)
      || raw.length > MAX_DESCRIPTOR_META_FIELDS
      || raw.some(item => boundedString(item) === undefined)
    ) return undefined
    metaFields = raw.map(item => item as string)
  }

  let preview: ToolUIPreview | undefined
  if (value['preview'] !== undefined) {
    const raw = value['preview']
    if (!isRecord(raw)) return undefined
    const contentField = boundedString(raw['contentField'])
    const truncateAtLines = raw['truncateAtLines']
    if (
      !contentField
      || !isPreviewFormat(raw['format'])
      || (truncateAtLines !== undefined && (
        !Number.isSafeInteger(truncateAtLines)
        || (truncateAtLines as number) <= 0
        || (truncateAtLines as number) > MAX_PREVIEW_LINES
      ))
    ) return undefined
    preview = {
      contentField,
      format: raw['format'],
      ...(truncateAtLines === undefined ? {} : { truncateAtLines: truncateAtLines as number }),
    }
  }

  let openAction: ToolUIOpenAction | undefined
  if (value['openAction'] !== undefined) {
    const raw = value['openAction']
    if (!isRecord(raw)) return undefined
    const pathField = boundedString(raw['pathField'])
    if (!pathField || !isOpenTarget(raw['target'])) return undefined
    openAction = { target: raw['target'], pathField }
  }

  return {
    kind: value['kind'],
    summary: {
      verb,
      ...(primaryField === undefined ? {} : { primaryField }),
      ...(metaFields === undefined ? {} : { metaFields }),
    },
    ...(preview === undefined ? {} : { preview }),
    ...(openAction === undefined ? {} : { openAction }),
  }
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
  const d = descriptor ?? call.uiDescriptor
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

  const openUrl = d.openAction?.target === 'url'
    ? safeHttpUrl(asString(call.input[d.openAction.pathField]))
    : undefined

  return {
    kind: d.kind,
    conversational: d.kind === 'conversational',
    verb: d.summary.verb,
    primary: primary || undefined,
    preview,
    openUrl,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DESCRIPTOR_TEXT) {
    return undefined
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return undefined
  }
  return value
}

function isToolKind(value: unknown): value is ToolUIKind {
  return value === 'file-write'
    || value === 'file-read'
    || value === 'file-edit'
    || value === 'shell'
    || value === 'search'
    || value === 'image'
    || value === 'external-action'
    || value === 'conversational'
}

function isPreviewFormat(value: unknown): value is ToolUIPreview['format'] {
  return value === 'code'
    || value === 'diff'
    || value === 'markdown'
    || value === 'plain'
    || value === 'image-thumb'
}

function isOpenTarget(value: unknown): value is ToolUIOpenAction['target'] {
  return value === 'file-pane'
    || value === 'terminal-pane'
    || value === 'image-pane'
    || value === 'search-pane'
    || value === 'url'
}

function safeHttpUrl(value: string): string | undefined {
  if (value.length === 0) return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : undefined
  } catch {
    return undefined
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
