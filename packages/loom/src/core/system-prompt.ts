/**
 * System Prompt — typed representation and helpers.
 *
 * The prompt cache does exact-prefix matching. Any block marked with a cache
 * marker becomes a write point: "remember the KV state up to and including
 * this block." Multiple markers let us snapshot the stable parts of the
 * prompt independently from the volatile parts, so a changing suffix does
 * not invalidate the cached prefix.
 *
 * Why the union shape:
 *   - A bare string keeps the simple-case ergonomics: "here's my prompt,
 *     cache the whole thing." Every existing caller stays unchanged.
 *   - An array of blocks is the production shape: each block carries an
 *     explicit `cacheControl` flag, and consecutive stable blocks can sit
 *     in front of volatile blocks so only the stable prefix gets a cache
 *     marker. The volatile tail can change freely without a cache write
 *     premium.
 *
 * The loop never reads this type directly. It calls `normalizeSystemPrompt`
 * which returns the always-array form, and the request builder emits one
 * text block per entry with a cache marker if and only if `cacheControl`
 * is true.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One slice of the system prompt. Sent to the provider as a single text
 * block. If `cacheControl` is true, the block carries an Anthropic
 * `cache_control: { type: 'ephemeral' }` marker — meaning "cache everything
 * up to and including this block." Blocks without `cacheControl` are sent
 * plain: they're part of the prompt the model reads, but they do not
 * participate in caching on their own.
 */
export interface SystemPromptBlock {
  readonly text: string
  readonly cacheControl?: boolean
}

/**
 * The public shape of a system prompt. A string is the simple case (treated
 * as a single cache-marked block). An array is the block form used by
 * consumers that want fine-grained cache control across stable and volatile
 * sections.
 */
export type SystemPrompt = string | ReadonlyArray<SystemPromptBlock>

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The hard ceiling Anthropic enforces on `cache_control` markers per request.
 * Exceeding this yields a 400 `invalid_request_error`. The cap is shared
 * across system blocks, tool definitions, and conversation messages, so the
 * caller must account for markers added elsewhere.
 */
export const CACHE_CONTROL_MARKER_LIMIT = 4

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize any `SystemPrompt` value into a concrete array of blocks.
 *
 *  - `""` (empty string) → `[]` (no blocks at all — lets the request builder
 *    emit no `system` field, which is exactly what the provider expects when
 *    there is no system prompt).
 *  - A non-empty string → `[{ text, cacheControl: true }]` — matches the
 *    pre-split behaviour where the entire prompt was one cache-marked block.
 *  - An array → returned as-is after filtering out empty-text entries.
 *
 * Filtering empty entries at normalization time keeps the request small and
 * predictable: callers can pass optional fragments without worrying that a
 * missing one will show up as an empty text block in the wire payload.
 */
export function normalizeSystemPrompt(sp: SystemPrompt): SystemPromptBlock[] {
  if (typeof sp === 'string') {
    if (sp.length === 0) return []
    return [{ text: sp, cacheControl: true }]
  }
  const result: SystemPromptBlock[] = []
  for (const block of sp) {
    if (block.text.length === 0) continue
    // Normalize to an explicit boolean so downstream code can cleanly check
    // `block.cacheControl === true` without worrying about undefined.
    result.push({ text: block.text, cacheControl: block.cacheControl === true })
  }
  return result
}

/**
 * Flatten a system prompt into a single text string. Used anywhere the
 * content is treated as opaque text — token counting, compaction, debug
 * logging. Cache-marker information is discarded intentionally; this is the
 * only place where losing it is correct.
 */
export function systemPromptToText(sp: SystemPrompt): string {
  if (typeof sp === 'string') return sp
  if (sp.length === 0) return ''
  return sp.map(b => b.text).join('')
}

/**
 * Count how many blocks in a system prompt carry a cache marker. Used by
 * the loop to reserve its share of the 4-marker request budget before it
 * places the message-side marker.
 */
export function countCacheMarkers(sp: SystemPrompt): number {
  if (typeof sp === 'string') return sp.length > 0 ? 1 : 0
  let n = 0
  for (const block of sp) {
    if (block.cacheControl === true && block.text.length > 0) n++
  }
  return n
}
