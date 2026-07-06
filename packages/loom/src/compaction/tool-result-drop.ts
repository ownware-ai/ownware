/**
 * Tool-result drop — tool-result body replacement without an LLM call.
 *
 * Tool outputs are the fastest-growing part of any long conversation.
 * A single file read can be 5-10K tokens; a grep over a large repo can
 * push 20K+. By turn 20 the message history is often dominated by
 * content the model has already processed and moved past. Full
 * summarising compaction can reclaim that space, but it costs a live
 * model call and rewrites the message prefix (breaking the prompt
 * cache).
 *
 * `dropStaleToolResults` is the cheap alternative. It walks the history,
 * finds `tool_result` blocks older than the last `keepRecentTurns` user
 * turns, and replaces their bodies with a short placeholder. The
 * `tool_use` blocks that produced them stay untouched — the model can
 * still see that it called the tool, which tools were used, and with
 * what arguments. It just can't read the old output anymore.
 *
 * The placeholder is designed to be *useful*, not just a removal marker:
 *   - It names the tool that produced the result (pulled from the paired
 *     `tool_use` block), so the model knows which call it was without
 *     having to scan backwards.
 *   - It keeps a short head-preview of the original content (configurable
 *     via `previewBytes`), so the model still has a hint of what came
 *     back before deciding whether to re-fetch.
 *   - It reports the original size, so the model can tell whether the
 *     dropped content was a one-liner or a 10KB dump.
 *
 * What the model can do when it needs content back:
 *   - Call the tool again (the placeholder names it explicitly).
 *   - Rely on the preview when the first few lines are enough.
 *   - Rely on its own notes (assistant text messages are untouched).
 *
 * Invariants this function preserves:
 *
 * 1. `tool_use_id` pairing is never broken. A `tool_result` always
 *    keeps the same `toolUseId` so the provider API does not 400 on
 *    an orphaned tool_use.
 * 2. `tool_use` blocks (the call records) are never modified. The model
 *    sees the same call trace it saw on the previous turn.
 * 3. The `isError` flag is preserved. "Tool failed with ENOENT" and
 *    "tool returned 8KB of JSON" compact to different placeholders, so
 *    the model still knows whether the past call succeeded.
 * 4. The most recent `keepRecentTurns` user turns are left completely
 *    alone. The model's working set — the stuff it is reasoning about
 *    right now — is never touched.
 * 5. Assistant text and thinking blocks inside tool-bearing assistant
 *    messages are preserved — reasoning does not evaporate with the
 *    tool output.
 * 6. The function is deterministic: identical input yields identical
 *    output. This matters for retry paths and for cache stability —
 *    two requests that run this function independently on the same
 *    message list produce byte-identical transformed lists.
 *
 * Not within scope here:
 *   - Deciding WHEN to run. The loop owns the pressure-based trigger.
 *   - Counting tokens. The loop already knows the pressure level.
 *   - Emitting events. The loop wraps the call with turn-boundary
 *     events so consumers see it happen.
 */

import type {
  CacheControl,
  ContentBlock,
  Message,
  ToolResultBlock,
  ToolUseBlock,
} from '../messages/types.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DropStaleToolResultsOptions {
  /**
   * How many of the most recent user turns to leave untouched. A user
   * turn is one message with `role === 'user'` whose content is NOT a
   * pure `tool_result` array (those are engine-produced follow-ups, not
   * real user turns).
   *
   * Minimum 1 — the current turn is ALWAYS preserved, otherwise the
   * model could not see the tool result it just triggered.
   */
  readonly keepRecentTurns: number

  /**
   * Approximate byte threshold below which a tool result is left alone.
   * A 200-byte result is cheaper to keep verbatim than to replace with
   * an 80-byte placeholder. Default 500.
   */
  readonly minBytesToDrop?: number

  /**
   * How many characters of the original content to keep verbatim inside
   * the placeholder as a head-preview. The preview helps the model
   * remember roughly what the tool returned — often enough to decide
   * whether to re-fetch. Default 150; set to 0 to disable preview
   * entirely (the placeholder then contains only the size + tool name).
   */
  readonly previewBytes?: number
}

export interface DropStaleToolResultsReport {
  /** New message list with stale tool results replaced. */
  readonly messages: Message[]
  /** How many tool_result blocks were rewritten. */
  readonly droppedCount: number
  /**
   * Approximate bytes reclaimed — sum of original content sizes minus
   * placeholder sizes, before tokenisation. Not a token count, but a
   * reasonable proxy for how much pressure the operation relieved.
   */
  readonly bytesReclaimed: number
}

/** Metadata about the tool call that produced a given `tool_result`. */
interface ToolCallInfo {
  readonly name: string
  readonly input: Record<string, unknown>
}

/**
 * Walk `messages` end-to-start, count user turns, and rewrite any
 * `tool_result` content that sits before the `keepRecentTurns`
 * boundary. Returns a new array — the input is not mutated.
 */
export function dropStaleToolResults(
  messages: Message[],
  options: DropStaleToolResultsOptions,
): DropStaleToolResultsReport {
  const keepRecentTurns = Math.max(1, Math.floor(options.keepRecentTurns))
  const minBytesToDrop = options.minBytesToDrop ?? 500
  const previewBytes = Math.max(0, Math.floor(options.previewBytes ?? 150))

  if (messages.length === 0) {
    return { messages: [], droppedCount: 0, bytesReclaimed: 0 }
  }

  // Pre-build a `toolUseId → { name, input }` map so the placeholder
  // can reference the tool by name. A single forward pass over the
  // messages is O(n) and amortises across every rewrite below.
  const toolCallIndex = buildToolCallIndex(messages)

  // Find the index BELOW which a tool_result is in-scope for
  // replacement. We walk from the end, counting user turns that are
  // NOT pure tool-result messages. Once we have counted
  // `keepRecentTurns` of them, every message index strictly less than
  // the position of that last-counted user turn is eligible.
  const cutoffIndex = findCutoffIndex(messages, keepRecentTurns)

  // If cutoff is 0 or negative, nothing is old enough to drop.
  if (cutoffIndex <= 0) {
    return { messages: [...messages], droppedCount: 0, bytesReclaimed: 0 }
  }

  let droppedCount = 0
  let bytesReclaimed = 0
  const out: Message[] = new Array(messages.length)

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    // Recent slice — pass through untouched.
    if (i >= cutoffIndex) {
      out[i] = msg
      continue
    }

    // Stale slice — inspect for tool_result blocks to rewrite.
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      let changed = false
      const newBlocks: ContentBlock[] = msg.content.map(block => {
        if (block.type !== 'tool_result') return block
        const rewrite = rewriteToolResult(block, {
          minBytesToDrop,
          previewBytes,
          toolCallInfo: toolCallIndex.get(block.toolUseId),
        })
        if (rewrite === null) return block
        changed = true
        droppedCount++
        bytesReclaimed += rewrite.bytesReclaimed
        return rewrite.block
      })
      out[i] = changed ? { ...msg, content: newBlocks } : msg
      continue
    }

    // Assistant messages never hold tool_result blocks (the model does
    // not produce them) but we still walk their content defensively —
    // if a future message shape change puts tool_result there, we want
    // this loop to react rather than silently skip.
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      let changed = false
      const newBlocks: ContentBlock[] = msg.content.map(block => {
        if (block.type !== 'tool_result') return block
        const rewrite = rewriteToolResult(block, {
          minBytesToDrop,
          previewBytes,
          toolCallInfo: toolCallIndex.get(block.toolUseId),
        })
        if (rewrite === null) return block
        changed = true
        droppedCount++
        bytesReclaimed += rewrite.bytesReclaimed
        return rewrite.block
      })
      out[i] = changed ? { ...msg, content: newBlocks } : msg
      continue
    }

    out[i] = msg
  }

  return { messages: out, droppedCount, bytesReclaimed }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Scan every message once and collect the `{ name, input }` of each
 * `tool_use` block keyed by its id. This lets us annotate dropped
 * `tool_result` placeholders with the name of the call that produced
 * them, without a nested walk on each rewrite.
 */
function buildToolCallIndex(messages: Message[]): Map<string, ToolCallInfo> {
  const index = new Map<string, ToolCallInfo>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue
      const use = block as ToolUseBlock
      index.set(use.id, { name: use.name, input: use.input })
    }
  }
  return index
}

/**
 * Walk backwards through messages, counting user turns that are NOT
 * pure tool-result follow-ups. Return the index of the earliest user
 * turn we want to keep untouched; anything strictly less is stale.
 *
 * Example with keepRecentTurns=2:
 *   [ user:"hi",            ← index 0, counted as turn 4 (oldest)
 *     assistant:"tool_use", ← index 1
 *     user:"tool_result",   ← index 2, NOT a user turn (engine-produced)
 *     assistant:"reply",    ← index 3
 *     user:"follow-up",     ← index 4, counted as turn 3
 *     assistant:"tool_use", ← index 5
 *     user:"tool_result",   ← index 6, NOT a user turn
 *     assistant:"reply",    ← index 7
 *     user:"latest" ]       ← index 8, counted as turn 2 — KEEP from here
 *
 * Cutoff = 8. Messages at index 0..7 are eligible for rewriting.
 *
 * When there are fewer user turns than `keepRecentTurns`, return 0
 * (nothing to drop). That is strictly safer than picking an arbitrary
 * cutoff on a short conversation.
 */
function findCutoffIndex(messages: Message[], keepRecentTurns: number): number {
  let kept = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role !== 'user') continue
    // A user message whose content is a `tool_result` array is an
    // engine-produced follow-up, not a user turn. Skip it.
    if (Array.isArray(msg.content) && msg.content.every(b => b.type === 'tool_result')) {
      continue
    }
    kept++
    if (kept >= keepRecentTurns) {
      return i
    }
  }
  return 0
}

interface ToolResultRewrite {
  readonly block: ContentBlock
  readonly bytesReclaimed: number
}

interface RewriteContext {
  readonly minBytesToDrop: number
  readonly previewBytes: number
  readonly toolCallInfo: ToolCallInfo | undefined
}

/**
 * Decide whether a single `tool_result` block is worth rewriting, and
 * if so produce the replacement. Returns null when the block is too
 * small to bother (the placeholder would be nearly as long as the
 * original content).
 */
function rewriteToolResult(
  block: ToolResultBlock & { readonly cache_control?: CacheControl },
  ctx: RewriteContext,
): ToolResultRewrite | null {
  const originalBytes = approximateContentBytes(block.content)
  if (originalBytes < ctx.minBytesToDrop) return null

  const placeholder = buildPlaceholder({
    originalBytes,
    isError: block.isError,
    originalText: toPlainText(block.content),
    previewBytes: ctx.previewBytes,
    toolCallInfo: ctx.toolCallInfo,
  })

  // If the placeholder is NOT meaningfully shorter than the original,
  // rewriting is a net loss. Skip. Threshold is half the original size
  // as a rough break-even — below that, the cost of the placeholder's
  // overhead text eats most of the savings.
  if (placeholder.length >= Math.floor(originalBytes / 2)) {
    return null
  }

  const newBlock: ToolResultBlock & { readonly cache_control?: CacheControl } = {
    type: 'tool_result',
    toolUseId: block.toolUseId,
    content: placeholder,
    isError: block.isError,
    // Preserve any cache_control marker so the block's position in the
    // cache lineage does not silently change. Rewriting content drops
    // the old block from the cache prefix match anyway, but preserving
    // the marker keeps downstream logic simple: the rewrite only
    // changes `content`, nothing else.
    ...(block.cache_control !== undefined ? { cache_control: block.cache_control } : {}),
    // Preserve B4a metadata. The placeholder still describes the same
    // call — the typed discriminators (`kind`, `targetId`,
    // `supersedable`, etc.) remain accurate for downstream consumers,
    // even though the verbatim content has been replaced.
    ...(block.metadata !== undefined ? { metadata: block.metadata } : {}),
  }
  return {
    block: newBlock,
    bytesReclaimed: Math.max(0, originalBytes - placeholder.length),
  }
}

/**
 * Estimate byte size of a `tool_result.content` field. The field can be
 * a raw string or an array of content blocks; we sum the sizes of any
 * text-like inner blocks. Non-text blocks (images, documents) get a
 * conservative fixed estimate — they should not normally appear in a
 * tool result, but if they do we do not want to attempt to drop them.
 */
function approximateContentBytes(content: string | ContentBlock[]): number {
  if (typeof content === 'string') return content.length
  let sum = 0
  for (const block of content) {
    if (block.type === 'text') {
      sum += block.text.length
    } else {
      // Unknown / non-text block — give it a small fixed weight so
      // `minBytesToDrop` never triggers on these by accident.
      sum += 50
    }
  }
  return sum
}

/**
 * Extract the plain-text portion of a `tool_result.content` field, for
 * preview purposes. Mirrors what the model would have seen as text.
 */
function toPlainText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

interface PlaceholderArgs {
  readonly originalBytes: number
  readonly isError: boolean
  readonly originalText: string
  readonly previewBytes: number
  readonly toolCallInfo: ToolCallInfo | undefined
}

/**
 * Build the replacement string for a dropped tool result.
 *
 * Shape:
 *   [<error|output> of <tool-name>(<brief-args>) dropped — was ~NN chars.
 *    Preview: "<first N chars>...". Call the tool again if you need the full content.]
 *
 * Every piece degrades gracefully: if the tool-call index did not find
 * the paired tool_use (shouldn't happen, but robustness matters) we drop
 * to "previous tool output"; if `previewBytes` is 0 the preview line is
 * omitted entirely; if the original content was shorter than the preview
 * budget the preview is the full content (which is fine because we only
 * reach this path when size > minBytesToDrop anyway).
 */
function buildPlaceholder(args: PlaceholderArgs): string {
  const kind = args.isError ? 'error' : 'output'
  const toolLabel = renderToolLabel(args.toolCallInfo)
  const head = `[${kind} of ${toolLabel} dropped — was ~${args.originalBytes} chars.`
  const tail = args.isError
    ? 'Call the tool again if you need the exact error text.]'
    : 'Call the tool again if you need the full content.]'

  if (args.previewBytes === 0 || args.originalText.length === 0) {
    return `${head} ${tail}`
  }

  const preview = makePreview(args.originalText, args.previewBytes)
  if (preview.length === 0) {
    return `${head} ${tail}`
  }
  return `${head} Preview: "${preview}". ${tail}`
}

/**
 * Produce a short, single-line preview of the original text.
 *
 * Truncates to `previewBytes` characters, trims trailing whitespace,
 * replaces internal newlines with a space so the preview stays on one
 * line, and appends an ellipsis if we actually truncated. Escapes
 * embedded double quotes so the surrounding `"..."` quoting stays
 * well-formed.
 */
function makePreview(text: string, previewBytes: number): string {
  const slice = text.slice(0, previewBytes)
  const collapsed = slice.replace(/\s+/g, ' ').trim()
  const escaped = collapsed.replace(/"/g, '\\"')
  return text.length > previewBytes ? `${escaped}...` : escaped
}

/**
 * Render a compact human-readable label for the tool call that produced
 * a dropped result. Prefers `name(arg=value, ...)` when we have the
 * paired `tool_use`; falls back to `tool` when the call record is
 * missing (unusual — only on a malformed history).
 */
function renderToolLabel(info: ToolCallInfo | undefined): string {
  if (!info) return 'tool'
  const argKeys = Object.keys(info.input)
  if (argKeys.length === 0) return info.name
  // Keep the label compact: only the first two args, truncated values.
  const parts: string[] = []
  for (const key of argKeys.slice(0, 2)) {
    const raw = info.input[key]
    const shown = renderArgValue(raw)
    parts.push(`${key}=${shown}`)
  }
  if (argKeys.length > 2) parts.push(`+${argKeys.length - 2} more`)
  return `${info.name}(${parts.join(', ')})`
}

/** Stringify a single tool-argument value compactly for the label. */
function renderArgValue(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') {
    return v.length > 40 ? `"${v.slice(0, 40)}..."` : `"${v}"`
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  // Everything else (arrays, nested objects) — summarize rather than
  // dump. The label is not a debug trace; it's a hint.
  return typeof v
}
