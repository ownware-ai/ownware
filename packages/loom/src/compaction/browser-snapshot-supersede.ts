/**
 * Browser-aware compaction — drop superseded snapshots, keep the latest.
 *
 * Browser sessions accumulate `tool_result` blocks whose content is a
 * full accessibility snapshot of the page after each action. Once the
 * model takes a newer snapshot of the SAME tab, the older one is
 * superseded: the page state it captured is dead, the refs it
 * exposed are dead, and nothing in the loop is going to look at it
 * again. Holding it in the message log just burns tokens on every
 * follow-up turn.
 *
 * `compactSupersededBrowserSnapshots` is the cheap reclaim. It walks
 * the history, groups `tool_result` blocks by `metadata.targetId`,
 * keeps the most recent K snapshots per tab (default 1), and
 * replaces the bodies of the rest with a short breadcrumb. The
 * `tool_use` blocks that produced them stay untouched — the model
 * can still see that it called the tool, with what arguments, and
 * which tab.
 *
 * What makes this different from the generic `tool-result-drop`:
 *   - **Typed**, not age-based. We don't trim by turn distance; we
 *     trim by supersession proof. A 30-turn-old snapshot is fine if
 *     it's the only one for that tab; a 2-turn-old snapshot is gone
 *     the moment a newer one arrives.
 *   - **Per-tab grouping** via `metadata.targetId`. A two-tab session
 *     keeps two snapshots, not one.
 *   - **No regex on content**. Everything keys on the typed
 *     `metadata.kind === 'browser-snapshot'` discriminator set by
 *     `withSnapshot` (B1).
 *
 * Invariants this function preserves:
 *
 * 1. `tool_use_id` pairing is never broken. Same as the generic drop.
 * 2. `tool_use` blocks are never modified.
 * 3. `isError`, `cache_control`, and `metadata` survive the rewrite.
 * 4. Non-browser tool results are NEVER touched — only blocks whose
 *    `metadata.kind === 'browser-snapshot'` AND
 *    `metadata.supersedable === true` are eligible.
 * 5. The K most recent snapshots per tab (newest-first) are
 *    preserved verbatim. Setting K = 0 is allowed and replaces ALL
 *    snapshots (e.g. on a force-compact step).
 * 6. The current turn's tool results are always preserved — the
 *    `keepRecentTurns` boundary mirrors the generic drop.
 * 7. Deterministic: identical input → identical output.
 *
 * Not in scope here:
 *   - Deciding WHEN to run. The loop owns the pressure trigger.
 *   - Counting tokens. The loop already knows the pressure level.
 *   - Emitting events. The loop wraps the call with the
 *     `tool_result.drop` event so consumers see it happen.
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

export interface CompactSupersededBrowserSnapshotsOptions {
  /**
   * How many of the most recent snapshots per tab (per `targetId`)
   * to preserve verbatim. Default 1 — keep only the latest. Set to
   * 2+ if the model needs a short history of page states; set to 0
   * to compact every snapshot regardless of age.
   */
  readonly keepLatestPerTarget?: number

  /**
   * How many of the most recent user turns to leave entirely
   * untouched. Mirrors the generic `tool-result-drop` semantics —
   * the model's working set is never modified. Default 1.
   */
  readonly keepRecentTurns?: number

  /**
   * Byte threshold below which a snapshot is left alone. A small
   * snapshot block is not worth replacing with a placeholder.
   * Default 500.
   */
  readonly minBytesToDrop?: number
}

export interface CompactSupersededBrowserSnapshotsReport {
  readonly messages: Message[]
  readonly droppedCount: number
  readonly bytesReclaimed: number
}

interface ToolCallInfo {
  readonly name: string
  readonly input: Record<string, unknown>
}

/**
 * Walk `messages` end-to-start, group browser-snapshot tool_results
 * by `metadata.targetId`, and replace the bodies of all but the
 * most-recent `keepLatestPerTarget` per tab with a breadcrumb. The
 * input is not mutated; a new array is returned.
 */
export function compactSupersededBrowserSnapshots(
  messages: Message[],
  options: CompactSupersededBrowserSnapshotsOptions = {},
): CompactSupersededBrowserSnapshotsReport {
  const keepLatestPerTarget = Math.max(
    0,
    Math.floor(options.keepLatestPerTarget ?? 1),
  )
  const keepRecentTurns = Math.max(1, Math.floor(options.keepRecentTurns ?? 1))
  const minBytesToDrop = options.minBytesToDrop ?? 500

  if (messages.length === 0) {
    return { messages: [], droppedCount: 0, bytesReclaimed: 0 }
  }

  const toolCallIndex = buildToolCallIndex(messages)
  const cutoffIndex = findCutoffIndex(messages, keepRecentTurns)

  // First pass — walk newest → oldest within [0, cutoffIndex). For
  // each browser-snapshot tool_result with a known targetId, record
  // whether it should be kept (count < K) or rewritten.
  const verdicts = new Map<string, 'keep' | 'rewrite'>() // key: messageIndex + '#' + blockIndex
  const keptByTarget = new Map<string, number>()
  for (let i = cutoffIndex - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || !Array.isArray(msg.content)) continue
    for (let b = msg.content.length - 1; b >= 0; b--) {
      const block = msg.content[b]
      if (!block || block.type !== 'tool_result') continue
      if (!isSupersedableSnapshot(block)) continue
      const targetId = readTargetId(block)
      if (targetId === null) continue
      const key = `${i}#${b}`
      const kept = keptByTarget.get(targetId) ?? 0
      if (kept < keepLatestPerTarget) {
        verdicts.set(key, 'keep')
        keptByTarget.set(targetId, kept + 1)
      } else {
        verdicts.set(key, 'rewrite')
      }
    }
  }

  if (verdicts.size === 0) {
    return { messages: [...messages], droppedCount: 0, bytesReclaimed: 0 }
  }

  // Second pass — build the output, applying rewrites. System
  // messages (string content) and any non-array-content user
  // message pass through untouched; only user/assistant messages
  // with array content can hold tool_result blocks.
  let droppedCount = 0
  let bytesReclaimed = 0
  const out: Message[] = new Array(messages.length)
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (i >= cutoffIndex) {
      out[i] = msg
      continue
    }
    if (msg.role === 'system' || !Array.isArray(msg.content)) {
      out[i] = msg
      continue
    }
    let changed = false
    const newBlocks: ContentBlock[] = msg.content.map((block, b) => {
      const key = `${i}#${b}`
      if (verdicts.get(key) !== 'rewrite') return block
      const trBlock = block as ToolResultBlock & {
        readonly cache_control?: CacheControl
      }
      const rewrite = rewriteSupersededSnapshot(trBlock, {
        minBytesToDrop,
        toolCallInfo: toolCallIndex.get(trBlock.toolUseId),
      })
      if (rewrite === null) return block
      changed = true
      droppedCount++
      bytesReclaimed += rewrite.bytesReclaimed
      return rewrite.block
    })
    out[i] = changed ? { ...msg, content: newBlocks } : msg
  }

  return { messages: out, droppedCount, bytesReclaimed }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSupersedableSnapshot(block: ToolResultBlock): boolean {
  const md = block.metadata
  if (!md) return false
  if (md.kind !== 'browser-snapshot') return false
  if (md.supersedable !== true) return false
  return true
}

function readTargetId(block: ToolResultBlock): string | null {
  const md = block.metadata
  if (!md) return null
  const t = md.targetId
  return typeof t === 'string' && t.length > 0 ? t : null
}

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

function findCutoffIndex(messages: Message[], keepRecentTurns: number): number {
  let kept = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role !== 'user') continue
    if (Array.isArray(msg.content) && msg.content.every(b => b.type === 'tool_result')) {
      continue
    }
    kept++
    if (kept >= keepRecentTurns) return i
  }
  return 0
}

interface SnapshotRewrite {
  readonly block: ContentBlock
  readonly bytesReclaimed: number
}

interface RewriteContext {
  readonly minBytesToDrop: number
  readonly toolCallInfo: ToolCallInfo | undefined
}

function rewriteSupersededSnapshot(
  block: ToolResultBlock & { readonly cache_control?: CacheControl },
  ctx: RewriteContext,
): SnapshotRewrite | null {
  const originalBytes = approximateBytes(block.content)
  if (originalBytes < ctx.minBytesToDrop) return null

  const md = block.metadata ?? {}
  const url = typeof md.url === 'string' ? md.url : null
  const title = typeof md.title === 'string' ? md.title : null
  const placeholder = buildBreadcrumb({
    originalBytes,
    url,
    title,
    isError: block.isError,
    toolCallInfo: ctx.toolCallInfo,
  })

  if (placeholder.length >= Math.floor(originalBytes / 2)) {
    return null
  }

  const newBlock: ToolResultBlock & { readonly cache_control?: CacheControl } = {
    type: 'tool_result',
    toolUseId: block.toolUseId,
    content: placeholder,
    isError: block.isError,
    ...(block.cache_control !== undefined ? { cache_control: block.cache_control } : {}),
    // Metadata survives — the typed discriminators still accurately
    // describe the call, even though the content is now a breadcrumb.
    ...(block.metadata !== undefined ? { metadata: block.metadata } : {}),
  }
  return {
    block: newBlock,
    bytesReclaimed: Math.max(0, originalBytes - placeholder.length),
  }
}

function approximateBytes(content: string | ContentBlock[]): number {
  if (typeof content === 'string') return content.length
  let sum = 0
  for (const block of content) {
    if (block.type === 'text') sum += block.text.length
    else sum += 50
  }
  return sum
}

interface BreadcrumbArgs {
  readonly originalBytes: number
  readonly url: string | null
  readonly title: string | null
  readonly isError: boolean
  readonly toolCallInfo: ToolCallInfo | undefined
}

function buildBreadcrumb(args: BreadcrumbArgs): string {
  const callLabel = args.toolCallInfo?.name ?? 'browser tool'
  const where =
    args.url && args.title
      ? `${args.title} (${args.url})`
      : args.url ?? args.title ?? 'unknown page'
  const kind = args.isError ? 'error from' : 'snapshot of'
  return (
    `[${kind} ${callLabel} compacted — superseded by a newer snapshot ` +
    `of the same tab. Was ~${args.originalBytes} chars from ${where}. ` +
    `Call browser_snapshot again if you need the page state back.]`
  )
}
