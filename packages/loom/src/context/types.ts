/**
 * Context Usage Types
 *
 * `ContextUsage` is what `Session.getContextUsage()` returns — a typed
 * breakdown of how the model's context window is being spent right now:
 * total used, free space, and a per-category breakdown so consumers
 * (UI clients, the model itself via the `/context` skill) can see
 * where the bloat is.
 *
 * Methodology:
 *   - Counts come from the local `chars/4` estimator (`messages/tokens.ts`)
 *     by default — fast, deterministic, no API call. Within ~10% of actual.
 *   - The breakdown sums to `used` exactly. The total is consistent with
 *     itself even when the absolute numbers are estimates.
 *   - The `method` field reports whether the total is `'exact'` (came
 *     from `provider.countTokens`) or `'estimate'` (local heuristic).
 *
 * Future paths (intentionally not in v1):
 *   - Exact-counts via `provider.countTokens` for Anthropic-routed models
 *     where the API is free.
 *   - Bundling `@anthropic-ai/tokenizer` for offline-exact Claude counts.
 *   - Bundling `tiktoken` for offline-exact OpenAI counts.
 */

// ---------------------------------------------------------------------------
// Breakdown — five categories, mirroring CC's /context UI
// ---------------------------------------------------------------------------

export interface ContextUsageBreakdown {
  /**
   * Tokens consumed by the assembled system prompt — identity, behavior,
   * output style, system rules, environment context. Does NOT include
   * tool definitions (which are a separate top-level field on the wire)
   * nor the `memory` slot when fragment-aware counting is enabled.
   */
  readonly systemPrompt: number

  /**
   * Tokens consumed by tool definitions sent to the model. Counted as
   * `name + description + JSON.stringify(inputSchema)` per tool.
   */
  readonly tools: number

  /**
   * Tokens consumed by memory fragment(s). Currently always 0 in the
   * default path because the local counter cannot distinguish the
   * `memory` slot from the rest of the system prompt without fragment
   * introspection. Set to a real number when callers pass `fragments`.
   */
  readonly memory: number

  /**
   * Tokens consumed by skill bodies the agent has loaded this session.
   * Computed by scanning tool_result blocks whose paired tool_use was
   * named `skill`. Subtracted from `messages` so the categories do not
   * double-count.
   */
  readonly skills: number

  /**
   * Tokens consumed by conversation messages — user, assistant, tool
   * results — EXCLUDING skill tool_result bodies (which are tallied
   * under `skills`). The model's running record of the work.
   */
  readonly messages: number
}

// ---------------------------------------------------------------------------
// Top-level usage shape
// ---------------------------------------------------------------------------

/**
 * How accurate the breakdown is.
 *
 *   - `'exact'`    — every category was counted by the provider's own
 *                    tokenizer or a bundled offline tokenizer. 0% variance.
 *   - `'mixed'`    — at least one category (typically system+messages) came
 *                    from the provider; others (typically tools) from the
 *                    local chars/4 heuristic. The exact part is anchored;
 *                    the estimate part is within ~10% of actual.
 *   - `'estimate'` — every category from the local chars/4 heuristic. Within
 *                    ~10–15% of actual for mixed code/prose. Suitable for
 *                    UI display; not suitable for hard budget gates.
 */
export type CountMethod = 'exact' | 'mixed' | 'estimate'

export interface ContextUsage {
  /** Provider-prefixed model identifier (e.g. `anthropic:claude-sonnet-4-6`). */
  readonly model: string

  /** Context-window size in tokens for the model (200k for Claude, 1M for Opus 4.7, etc.). */
  readonly contextWindow: number

  /** Total tokens in use this turn. Equal to the sum of breakdown fields. */
  readonly used: number

  /** Tokens still available before hitting the context window. `contextWindow - used`. */
  readonly free: number

  /** Fraction of the context window in use. Range [0, 1]. */
  readonly utilization: number

  /** Per-category breakdown summing to `used`. */
  readonly breakdown: ContextUsageBreakdown

  /** How the breakdown was computed; see `CountMethod`. */
  readonly method: CountMethod
}

/**
 * Pluggable token counter. When supplied to `measureContextUsage`, it
 * provides exact counts for the messages+system portion of the request;
 * the loop's tools fragment falls back to the local chars/4 estimate
 * because most provider `countTokens` APIs don't accept tools yet.
 *
 * The default `Session.getContextUsage()` wires the active provider's
 * own `countTokens` as the counter — Anthropic and Google both expose
 * a free count_tokens API that returns exact counts.
 *
 * Failures (network, rate limit, unsupported model) cause a graceful
 * fallback to all-local estimation; the resulting `ContextUsage`
 * reports `method: 'estimate'` rather than throwing.
 */
export interface TokenCounter {
  count(messages: import('../messages/types.js').Message[], system?: string): Promise<number>
}
