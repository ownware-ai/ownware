/**
 * Kimi tool-call ID canonicalization.
 *
 * Per Moonshot's official guidance
 * (https://huggingface.co/moonshotai/Kimi-K2-Thinking/blob/main/docs/tool_call_guidance.md),
 * the canonical Kimi tool-call ID format is:
 *
 *     functions.<func_name>:<idx>
 *
 * where `idx` is a global counter that starts at 0 and increments with
 * each function invocation in a conversation. **Non-canonical IDs sent
 * back to Kimi on multi-turn calls are a known cause of tool-call
 * accuracy degradation** (see the vLLM team's deep-dive at
 * https://vllm.ai/blog/Kimi-K2-Accuracy — Moonshot's primary
 * recommendation is "normalize all historical tool_call IDs to
 * functions.func_name:idx format before sending them to the model").
 *
 * Ownware's pre-fix behaviour minted Loom-internal `call_<hex32>` UUIDs
 * for Kimi's tool calls and sent those UUIDs back as `tool_call_id` on
 * the follow-up turn. That violates the spec and silently degraded
 * multi-turn reliability. This module fixes it.
 *
 * The fix is stateless on purpose. Earlier drafts kept a session-scoped
 * `Map<sessionId, KimiIdMapper>` to translate UUIDs → canonical IDs;
 * that required threading the session id through the provider request
 * (a layering change), and risked leaking state across sessions if the
 * cleanup ever missed a teardown. Instead, we **encode the canonical
 * (name, idx) directly into the Loom-internal ID prefix**:
 *
 *     call_kimi_<sanitized-name>_<idx>_<24-hex-entropy>
 *
 * The 24 hex chars of entropy guarantee uniqueness across sessions. On
 * the wire serializer for Kimi we decode the prefix back to
 * `functions.<name>:<idx>`. No maps, no per-session state, no leaks —
 * the ID itself carries the canonical info.
 *
 * Non-Kimi-minted IDs (e.g. legacy `call_<hex32>` from before this
 * fix, or IDs from other providers) pass through `toCanonicalKimiId`
 * unchanged. The fix is forward-going; old conversation history keeps
 * its old IDs.
 */

const KIMI_ID_PREFIX = 'call_kimi_'

// Match: call_kimi_<name>_<idx>_<24 hex chars>
// `<name>` is alphanumeric only (sanitized at mint time so the parser
// regex stays unambiguous — tool names like `read_file` get sanitized
// to `readfile`; we don't actually need the original separator since
// the canonical form is what matters on the wire).
const KIMI_ID_PARSE_RE = /^([A-Za-z0-9]+)_(\d+)_[a-f0-9]{24}$/

/**
 * Mint a Loom-internal tool-call ID that round-trips losslessly to a
 * canonical Kimi ID via `toCanonicalKimiId`.
 *
 * The minted ID is globally unique across sessions (24 hex chars of
 * entropy) and identifiable as Kimi-origin via the `call_kimi_`
 * prefix.
 *
 * `name` is sanitized to alphanumeric — punctuation in tool names
 * (`get-weather`, `read_file`) is stripped. The canonical Kimi spec
 * permits alphanumeric + underscore in `func_name`, but on the wire
 * the bare tool name is what the model needs to match; for our
 * registry-driven dispatch the canonical form is informational, so
 * the sanitization is harmless.
 *
 * Pure / deterministic given a crypto source for the entropy.
 */
export function mintKimiId(name: string, idx: number): string {
  if (!Number.isInteger(idx) || idx < 0) {
    throw new Error(`mintKimiId: idx must be a non-negative integer, got ${idx}`)
  }
  const sanitized = name.replace(/[^A-Za-z0-9]/g, '')
  if (sanitized.length === 0) {
    throw new Error(`mintKimiId: name sanitizes to empty (input: "${name}")`)
  }
  const entropy = crypto.randomUUID().replace(/-/g, '').slice(0, 24)
  return `${KIMI_ID_PREFIX}${sanitized}_${idx}_${entropy}`
}

/**
 * Parse a previously-minted Kimi ID back into its `(name, idx)`. Returns
 * `null` for IDs that weren't minted by `mintKimiId` — including legacy
 * `call_<hex32>` IDs from before this fix, IDs from other providers,
 * and malformed inputs. Pure.
 */
export function parseKimiId(id: string): { readonly name: string; readonly idx: number } | null {
  if (typeof id !== 'string' || !id.startsWith(KIMI_ID_PREFIX)) return null
  const rest = id.slice(KIMI_ID_PREFIX.length)
  const match = rest.match(KIMI_ID_PARSE_RE)
  if (match == null) return null
  const name = match[1]
  const idxStr = match[2]
  if (typeof name !== 'string' || typeof idxStr !== 'string') return null
  return { name, idx: parseInt(idxStr, 10) }
}

/**
 * Translate a Loom-internal tool-call ID to the canonical Kimi wire
 * format `functions.<name>:<idx>`. Pass-through for IDs that don't
 * match the Kimi-mint pattern — safe to call unconditionally on any
 * ID, including legacy / cross-provider / hand-crafted strings.
 *
 * Apply this only on the Kimi serialization boundary
 * (`provider/openai.ts` → wire `tool_call_id`). Non-Kimi providers
 * keep the original Loom-internal ID, since their wire format doesn't
 * require canonicalization.
 */
export function toCanonicalKimiId(id: string): string {
  const parsed = parseKimiId(id)
  if (parsed == null) return id
  return `functions.${parsed.name}:${parsed.idx}`
}
