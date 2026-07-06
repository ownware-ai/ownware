/**
 * Token Estimation
 *
 * Rough token counting for compaction trigger decisions and budget tracking.
 * These are estimates — exact counts come from the provider's tokenizer.
 *
 * The heuristic (~4 chars per token) matches the industry standard for
 * English text with code. It's intentionally conservative (overestimates)
 * so compaction triggers slightly early rather than hitting prompt_too_long.
 */

import type { Message, ContentBlock } from './types.js'
import { getModelInfo } from '../provider/pricing.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Average characters per token. Overestimates for safety.
 * - English prose: ~4.5 chars/token
 * - Code: ~3.5 chars/token
 * - Mixed (typical agent session): ~4.0 chars/token
 */
const CHARS_PER_TOKEN = 4

/** Per-message overhead: role markers, formatting, separators */
const MESSAGE_OVERHEAD_TOKENS = 4

/** Known model context windows */
const MODEL_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  // Anthropic
  ['claude-sonnet', 200_000],
  ['claude-opus', 200_000],
  ['claude-haiku', 200_000],
  ['claude-sonnet-4', 200_000],
  ['claude-opus-4', 200_000],
  ['claude-haiku-3.5', 200_000],
  ['claude-3-5-sonnet', 200_000],
  ['claude-3-5-haiku', 200_000],
  ['claude-3-opus', 200_000],
  ['claude-3-sonnet', 200_000],
  ['claude-3-haiku', 200_000],
  // Anthropic 1M-context variants
  ['claude-opus-4-7', 1_000_000],
  ['claude-sonnet-4-6', 1_000_000],
  // Moonshot Kimi (via OpenRouter)
  ['kimi-k2', 256_000],
  ['kimi-k2.5', 256_000],
  ['kimi-k2.6', 256_000],
  // DeepSeek (via OpenRouter)
  ['deepseek-v3.2', 128_000],
  ['deepseek-chat', 128_000],
  // Z.AI / Zhipu (via OpenRouter)
  ['glm-4.6', 200_000],
  // OpenAI
  ['gpt-4o', 128_000],
  ['gpt-4o-mini', 128_000],
  ['gpt-4-turbo', 128_000],
  ['gpt-4', 8_192],
  ['gpt-3.5-turbo', 16_385],
  ['o1', 200_000],
  ['o1-mini', 128_000],
  ['o1-pro', 200_000],
  ['o3', 200_000],
  ['o3-mini', 200_000],
  ['o4-mini', 200_000],
  // Google
  ['gemini-2.5-pro', 1_000_000],
  ['gemini-2.5-flash', 1_000_000],
  ['gemini-2.0-flash', 1_000_000],
  ['gemini-1.5-pro', 2_000_000],
  ['gemini-1.5-flash', 1_000_000],
])

/**
 * Default context window when both the live models.dev catalog AND the
 * hardcoded table below have nothing for this model.
 *
 * Set to 200K — the smallest window any flagship 2026 model ships with
 * (Anthropic, OpenAI, Google, Moonshot all at >= 200K). 128K was the
 * old default but caused compaction to fire prematurely on modern
 * models that genuinely have larger windows (e.g. GPT-5.5 → 400K).
 * 200K is the safer floor: a real model with a larger window
 * underestimates its budget by some, but compaction-too-early is far
 * worse UX than compaction-slightly-late.
 */
const DEFAULT_CONTEXT_WINDOW = 200_000

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a plain text string.
 *
 * Uses chars/4 heuristic with a minimum of 1 token for non-empty strings.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN))
}

/**
 * Estimate total tokens for a message array.
 *
 * Accounts for message overhead (role markers, formatting) and
 * recursively estimates content blocks.
 */
export function estimateMessageTokens(messages: Message[]): number {
  let total = 0

  for (const msg of messages) {
    total += MESSAGE_OVERHEAD_TOKENS
    total += estimateContentTokens(msg.content)
  }

  return total
}

/**
 * Estimate tokens for a system prompt string.
 *
 * System prompts have slightly more overhead due to caching markers
 * and formatting, so we add a small buffer.
 */
export function estimateSystemPromptTokens(prompt: string): number {
  if (!prompt) return 0
  // System prompt overhead: cache_control markers, role prefix
  return estimateTokens(prompt) + 10
}

/**
 * Snapshot of the most-recent provider `usage` response plus a
 * message-count bookmark. Mirrors the `LastUsageSnapshot` interface
 * in `core/loop.ts` — duplicated here to keep `messages/tokens.ts`
 * importable without pulling in the loop's types.
 */
export interface UsageBaseline {
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheCreationTokens: number
  readonly outputTokens: number
  readonly messageCountAtCapture: number
}

/**
 * Effective context size for the NEXT provider call.
 *
 * Strategy: use the exact `usage` from the previous response as the
 * baseline, then estimate ONLY the messages that have been added
 * since that response (typically 1–3 messages, usually a user prompt
 * and/or tool results). This keeps the baseline 100% accurate after
 * the first turn — only the tiny delta is heuristic, and even chars÷4
 * error on 1000 tokens is invisible against a 200K window.
 *
 * Replaces three separate `estimateMessageTokens(state.messages)`
 * walks (loop pressure check, tool-result-drop trigger, proactive
 * compaction) AND the `provider.countTokens` API round-trip the
 * compaction manager used to make per turn. One function, one source
 * of truth.
 *
 * First-turn fallback: when `baseline` is `null` (no usage captured
 * yet), falls through to the full chars÷4 walk. Acceptable because
 * the first turn is typically small and below any compaction
 * threshold; even a 20-30% overestimate doesn't fire compaction at
 * realistic starting sizes.
 *
 * Cache tokens count at FULL weight toward the conversation size:
 * cached tokens share the context window budget, so they're part of
 * the "how full is the conversation" math, not free.
 */
export function getEffectiveContextUsage(
  messages: readonly Message[],
  baseline: UsageBaseline | null,
  model: string,
): { readonly tokens: number; readonly fraction: number; readonly window: number } {
  const window = getModelContextWindow(model)

  if (baseline == null) {
    // First turn — no exact baseline yet. Heuristic walk of everything.
    const tokens = estimateMessageTokens(messages as Message[])
    return { tokens, fraction: tokens / window, window }
  }

  // Baseline = exact conversation size after the previous assistant
  // response was appended (inputTokens + cache tokens = what the model
  // saw last time; outputTokens = the response now in history).
  const baselineTokens =
    baseline.inputTokens +
    baseline.cacheReadTokens +
    baseline.cacheCreationTokens +
    baseline.outputTokens

  // Delta = chars÷4 estimate of messages added AFTER the baseline was
  // captured. Defensive `Math.max(0, …)`: if the message array was
  // shortened (compaction occurred), the slice would be empty anyway,
  // but a negative index could mis-slice.
  const newMessageStart = Math.min(
    Math.max(0, baseline.messageCountAtCapture),
    messages.length,
  )
  const newMessages = messages.slice(newMessageStart)
  const deltaTokens = estimateMessageTokens(newMessages as Message[])

  const tokens = baselineTokens + deltaTokens
  return { tokens, fraction: tokens / window, window }
}

/**
 * Get the context window size for a known model.
 *
 * Resolution order:
 *   1. **Live models.dev catalog** via `getModelInfo(provider, model)`.
 *      Authoritative for every Anthropic / OpenAI / Google / Moonshot
 *      model in the catalog. The catalog is already synced for pricing
 *      lookups; we just consult it here too. Newly-released models that
 *      ship in catalog updates are automatically picked up — no code
 *      change required.
 *   2. **Hardcoded `MODEL_CONTEXT_WINDOWS` table** below — legacy
 *      fallback for bare model strings without a provider prefix, and
 *      for models the catalog doesn't carry (custom MCP, dev models,
 *      provider variants the catalog hasn't synced yet).
 *   3. **`DEFAULT_CONTEXT_WINDOW`** (200K) — final fallback for
 *      genuinely unknown models. Conservatively chosen — see the
 *      constant's docstring for the rationale.
 *
 * The prefix-strip handles fully-qualified `provider:model` IDs
 * (`anthropic:claude-sonnet-4-6`, `openai:gpt-5.5`, etc.) — those
 * route through the catalog. Bare model strings without a provider
 * fall straight to the hardcoded table.
 */
export function getModelContextWindow(model: string): number {
  // 1. Catalog lookup — only possible when the caller passed a fully
  //    qualified `provider:model` id. The catalog API expects them as
  //    separate args.
  const colonIdx = model.indexOf(':')
  if (colonIdx > 0) {
    const provider = model.slice(0, colonIdx)
    const bareName = model.slice(colonIdx + 1)
    const info = getModelInfo(provider, bareName)
    if (info?.contextWindow != null && info.contextWindow > 0) {
      return info.contextWindow
    }
  }

  // 2. Hardcoded table — match against the bare model name.
  const modelName = colonIdx > 0 ? model.slice(colonIdx + 1) : model

  // Exact match first
  if (MODEL_CONTEXT_WINDOWS.has(modelName)) {
    return MODEL_CONTEXT_WINDOWS.get(modelName)!
  }

  // Prefix match — find the longest matching prefix
  let bestMatch = ''
  let bestWindow = DEFAULT_CONTEXT_WINDOW

  for (const [key, window] of MODEL_CONTEXT_WINDOWS) {
    if (modelName.startsWith(key) && key.length > bestMatch.length) {
      bestMatch = key
      bestWindow = window
    }
  }

  return bestWindow
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Estimate tokens for message content (string or content blocks).
 */
function estimateContentTokens(content: string | readonly ContentBlock[]): number {
  if (typeof content === 'string') {
    return estimateTokens(content)
  }

  let total = 0
  for (const block of content) {
    total += estimateBlockTokens(block)
  }
  return total
}

/**
 * Estimate tokens for a single content block.
 */
function estimateBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTokens(block.text)
    case 'thinking':
      return estimateTokens(block.text)
    case 'tool_use':
      // Tool name + JSON-serialized input
      return estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input))
    case 'tool_result': {
      const resultText = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content)
      return estimateTokens(resultText)
    }
    case 'image':
      // Images are typically 1-2K tokens depending on resolution.
      // Use a conservative fixed estimate since we can't inspect pixel counts.
      return 1_000
    case 'redacted_thinking':
      // Redacted thinking data is opaque — use data length as proxy
      return estimateTokens(block.data)
    default:
      return 0
  }
}
