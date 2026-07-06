/**
 * Kimi (Moonshot K2 series) tool-call quirk handling.
 *
 * The problem: Kimi K2.x models served via OpenRouter (and the direct
 * Moonshot endpoint) do not emit tool calls through the OpenAI-style
 * `delta.tool_calls` field. Instead they emit the entire call — name and
 * arguments — as plain text inside `delta.content`, wrapped in a tagged
 * section that uses literal markers:
 *
 *     <|tool_calls_section_begin|>
 *     <|tool_call_begin|>functions.writeFile:0<|tool_call_argument_begin|>
 *     {"file_path":"/x/y.ts","content":"..."}
 *     <|tool_call_end|>
 *     <|tool_calls_section_end|>
 *
 * Without translation, the OpenAI streaming adapter accumulates this into a
 * single text content block and reports `stopReason: "end_turn"` — the agent
 * loop never invokes the tool, the user sees a multi-minute spinner, and the
 * model retries blindly. We can't change Kimi's wire format, so we recognise
 * the tagged section in the assembled message and rewrite it: text out,
 * `tool_use` blocks in, `stopReason` flipped to `tool_use`.
 *
 * This rewriter intentionally operates only on the terminal `message_complete`
 * chunk. Kimi sends the section in a contiguous text run; once `message_complete`
 * fires we have the full text and can parse it deterministically. Trying to
 * recognise partial markers across streamed deltas adds state machinery for
 * no agent-loop benefit (tool dispatch only happens after `message_complete`
 * anyway). The streaming UX during the section — raw markers visible in the
 * UI — is a separate client-side concern.
 */

import type { ContentBlock, ToolUseBlock } from '../../messages/types.js'
import type { ProviderChunk, StreamMessageComplete } from '../types.js'
import { mintKimiId } from './kimi-id-mapper.js'

const TOOL_SECTION_BEGIN = '<|tool_calls_section_begin|>'
const TOOL_SECTION_END = '<|tool_calls_section_end|>'
const TOOL_CALL_BEGIN = '<|tool_call_begin|>'
const TOOL_CALL_ARG_BEGIN = '<|tool_call_argument_begin|>'
const TOOL_CALL_END = '<|tool_call_end|>'

/**
 * Kimi prefixes tool names with `functions.` per the official spec
 * (https://huggingface.co/moonshotai/Kimi-K2-Thinking/blob/main/docs/tool_call_guidance.md).
 * Spec says the prefix is fixed-lowercase, but K2.6 in the wild has
 * been observed emitting variants — capitalized (`Functions.`),
 * underscore (`Functions_`), and dash (`functions-`). The regex below
 * is intentionally tolerant of all of them. The vLLM team's
 * post-mortem (https://vllm.ai/blog/Kimi-K2-Accuracy) reaches the
 * same conclusion: parser robustness against deviations is required
 * for real-world reliability.
 */
const FUNCTIONS_PREFIX_RE = /^functions[._-]+/i

/**
 * One parsed tool call from a Kimi tagged section.
 *
 * `id` is a freshly minted `call_<32hex>` UUID, NOT the raw tagged
 * identifier Kimi emits (e.g. `functions.writeFile:0`). The raw form
 * uses a per-session counter that resets every session, so reopening
 * a long thread and calling the same tool again produces a collision
 * with the hydrated permission record from a previous session — a
 * client reducer that dedups on requestId silently drops the second
 * `permission.request`, leaving the UI stuck on "Thinking…" forever.
 *
 * Rewriting the id at parse time is safe because the agent loop's
 * `tool_result` round-trip runs entirely inside Loom — we control
 * both the assistant `tool_calls[].id` and the matching `tool_call_id`
 * on the tool message, and Kimi never validates the format on the
 * follow-up turn. This brings Kimi in line with Anthropic / OpenAI /
 * Google, which all mint globally-unique ids upstream.
 */
export interface ParsedKimiToolCall {
  readonly id: string
  readonly name: string
  readonly args: Record<string, unknown>
}

export interface ParsedKimiSection {
  readonly calls: readonly ParsedKimiToolCall[]
  /** The original text with the tagged section removed and trimmed. */
  readonly cleanText: string
}

/**
 * Parse a Kimi tagged tool-call section out of an assembled assistant text
 * block. Returns `null` when the text contains no recognisable section, or
 * when the section is malformed in a way we can't safely interpret (truncated
 * markers, non-JSON arguments, unknown nesting). Callers MUST treat null as
 * "leave the original text alone" — we never partially mutate.
 */
export function parseKimiTaggedToolCalls(
  text: string,
): ParsedKimiSection | null {
  const sectionStart = text.indexOf(TOOL_SECTION_BEGIN)
  if (sectionStart === -1) return null
  const sectionEnd = text.indexOf(
    TOOL_SECTION_END,
    sectionStart + TOOL_SECTION_BEGIN.length,
  )
  if (sectionEnd === -1) return null

  const sectionBody = text.slice(
    sectionStart + TOOL_SECTION_BEGIN.length,
    sectionEnd,
  )

  const calls: ParsedKimiToolCall[] = []
  let cursor = 0

  while (cursor < sectionBody.length) {
    while (cursor < sectionBody.length && /\s/.test(sectionBody[cursor]!)) {
      cursor++
    }
    if (cursor >= sectionBody.length) break

    if (!sectionBody.startsWith(TOOL_CALL_BEGIN, cursor)) return null
    const idStart = cursor + TOOL_CALL_BEGIN.length

    const argMarker = sectionBody.indexOf(TOOL_CALL_ARG_BEGIN, idStart)
    if (argMarker === -1) return null
    const rawId = sectionBody.slice(idStart, argMarker).trim()
    if (!rawId) return null

    const argsStart = argMarker + TOOL_CALL_ARG_BEGIN.length
    const callEnd = sectionBody.indexOf(TOOL_CALL_END, argsStart)
    if (callEnd === -1) return null

    const rawArgs = sectionBody.slice(argsStart, callEnd).trim()
    let parsedArgs: Record<string, unknown>
    try {
      const candidate: unknown = JSON.parse(rawArgs)
      if (
        candidate === null ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate)
      ) {
        return null
      }
      parsedArgs = candidate as Record<string, unknown>
    } catch {
      return null
    }

    const { name, idx } = parseTaggedToolId(rawId)
    if (!name) return null

    // Mint a Loom-internal ID that encodes the canonical (name, idx)
    // so we can round-trip it back to `functions.<name>:<idx>` on the
    // wire when serializing to Kimi (see `kimi-id-mapper.ts` for the
    // full reasoning — short version: Kimi reliability on multi-turn
    // requires canonical IDs in history, and statelessly encoding the
    // canonical form into the internal ID avoids per-session state).
    calls.push({
      id: mintKimiId(name, idx),
      name,
      args: parsedArgs,
    })
    cursor = callEnd + TOOL_CALL_END.length
  }

  if (calls.length === 0) return null

  const cleanText = (
    text.slice(0, sectionStart) + text.slice(sectionEnd + TOOL_SECTION_END.length)
  ).trim()

  return { calls, cleanText }
}

/**
 * Parse a Kimi-tagged tool-call identifier
 * (e.g. `functions.writeFile:0`, `Functions_WriteFile:3`,
 * `writeFile:7`) into the canonical `(name, idx)` pair.
 *
 *   - The trailing `:<digits>` counter is the canonical `idx`. Spec
 *     guarantees its presence on every well-formed call; if absent
 *     (model regression), we fall back to `idx=0` so the conversation
 *     can still proceed — better degraded behaviour than a hard fail.
 *   - The `functions.` prefix is stripped case-insensitively and
 *     tolerantly of dot/underscore/dash separators. See the regex
 *     `FUNCTIONS_PREFIX_RE` for the exact rule.
 *
 * Returns an empty `name` for inputs that don't yield a valid name
 * after stripping (caller treats as a parse failure).
 */
function parseTaggedToolId(rawId: string): { name: string; idx: number } {
  const idxMatch = rawId.match(/:(\d+)$/)
  const idx = idxMatch != null && typeof idxMatch[1] === 'string'
    ? Number.parseInt(idxMatch[1], 10)
    : 0
  const withoutCounter = rawId.replace(/:\d+$/, '')
  const name = withoutCounter.replace(FUNCTIONS_PREFIX_RE, '').trim()
  return { name, idx: Number.isFinite(idx) && idx >= 0 ? idx : 0 }
}

/**
 * Async-generator wrapper that promotes Kimi's tagged-text tool calls in
 * the terminal `message_complete` chunk to first-class `tool_use` content
 * blocks. All other chunks pass through unchanged.
 *
 * If `message_complete` carries no tagged section, the chunk is yielded
 * unchanged — this wrapper is safe to apply unconditionally to any Kimi
 * stream, including ones where the model happened to emit normal prose.
 */
export async function* wrapKimiToolCallStream(
  source: AsyncGenerator<ProviderChunk>,
): AsyncGenerator<ProviderChunk> {
  for await (const chunk of source) {
    if (chunk.type !== 'message_complete') {
      yield chunk
      continue
    }
    yield rewriteMessageComplete(chunk)
  }
}

function rewriteMessageComplete(
  chunk: StreamMessageComplete,
): StreamMessageComplete {
  let mutated = false
  const newContent: ContentBlock[] = []

  for (const block of chunk.content) {
    if (block.type !== 'text') {
      newContent.push(block)
      continue
    }
    const parsed = parseKimiTaggedToolCalls(block.text)
    if (!parsed) {
      newContent.push(block)
      continue
    }
    mutated = true
    if (parsed.cleanText) {
      newContent.push({ type: 'text', text: parsed.cleanText })
    }
    for (const call of parsed.calls) {
      const toolBlock: ToolUseBlock = {
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.args,
      }
      newContent.push(toolBlock)
    }
  }

  if (!mutated) return chunk

  return {
    ...chunk,
    content: newContent,
    stopReason: 'tool_use',
  }
}

/**
 * True when the model identifier resolves to a Moonshot Kimi K2-series
 * model. Accepts both the Cortex short form (`kimi-k2.6`) and the
 * OpenRouter wire form (`moonshotai/kimi-k2.6`); case-insensitive so
 * profile config typos don't bypass the wrapper.
 */
export function isKimiModel(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  return lower.includes('kimi-k2') || lower.startsWith('moonshotai/kimi')
}
