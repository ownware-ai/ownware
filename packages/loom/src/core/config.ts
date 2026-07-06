/**
 * Loom Configuration
 *
 * Layered config: defaults < profile config < runtime overrides.
 * Every option has a sensible default so you can run with just a model string.
 */

import type { CompactionStrategy } from '../compaction/types.js'
import type { CheckpointStore } from '../checkpoint/types.js'
import type { SystemPrompt } from './system-prompt.js'
import type { CacheProfile } from './cache-control.js'
import type { STTProvider, TTSProvider } from './speech-types.js'

// ---------------------------------------------------------------------------
// Main config
// ---------------------------------------------------------------------------

export interface LoomConfig {
  /** Model identifier (e.g., "anthropic:claude-sonnet-4-20250514", "openai:gpt-4o") */
  readonly model: string

  /** Maximum turns (model calls) per session. 0 = unlimited. */
  readonly maxTurns: number

  /** Maximum output tokens per model call */
  readonly maxTokens: number

  /** Maximum total cost in USD. 0 = unlimited. */
  readonly maxBudgetUsd: number

  /** Temperature (0-2). Null = provider default. */
  readonly temperature: number | null

  /**
   * System prompt. Accepts either:
   *   - a bare string (the whole prompt, cached as one block), or
   *   - an ordered array of `SystemPromptBlock` entries where each block
   *     independently chooses whether it gets a cache_control marker.
   *
   * The block form is how the prompt cache delivers its full value: the
   * stable prefix (tool rules, identity, policies) lives in cache-marked
   * blocks, the volatile tail (date, cwd, memory) lives in unmarked blocks.
   * A change to the tail never invalidates the prefix's cache entry.
   */
  readonly systemPrompt: SystemPrompt

  /** Compaction configuration */
  readonly compaction: CompactionConfig

  /** Retry configuration */
  readonly retry: RetryConfig

  /** Tool execution configuration */
  readonly toolExecution: ToolExecutionConfig

  /** Checkpoint store (null = no checkpointing) */
  readonly checkpointStore: CheckpointStore | null

  /** Fallback model when primary is overloaded (deprecated — use fallbackModels) */
  readonly fallbackModel: string | null

  /** Ordered list of fallback models. Tried in sequence when primary fails. */
  readonly fallbackModels: readonly string[]

  /** Abort signal for external cancellation */
  readonly abortSignal: AbortSignal | null

  /** Agent ID (null = root agent, string = sub-agent) */
  readonly agentId: string | null

  /** Session ID for checkpoint/resume */
  readonly sessionId: string

  /** Root session id of this agent's spawn/fork lineage — the top-most
   *  session in the tree. Equals `sessionId` for a root agent; a spawned or
   *  forked child inherits its parent's `rootSessionId`. Lets tools address a
   *  stable per-lineage location deterministically, without parsing the
   *  `parent:child` shape of `sessionId`. Undefined on a root config →
   *  resolve as `rootSessionId ?? sessionId`. */
  readonly rootSessionId?: string

  /** Workspace path — the project directory this session operates in.
   *  Used as cwd for tool execution and as the zone security boundary.
   *  Null = use process.cwd(). */
  readonly workspacePath: string | null

  /** Additional directories the agent may read/write beyond
   *  `workspacePath`. Empty by default. The session host (e.g. the
   *  Cortex gateway) appends entries when the user grants access via
   *  the HITL permission flow ("Allow this folder for the session").
   *  Filesystem tools resolve a target path against `workspacePath`
   *  first, then any of these roots; symlink-escape and sensitive-
   *  path checks apply to every root identically. Entries should be
   *  absolute, canonical paths. */
  readonly additionalWorkspaceRoots: readonly string[]

  /** Extended thinking configuration. Null = disabled.
   *  When enabled, reasoning-capable models emit a thinking block before the
   *  response. Providers that don't support thinking ignore this field. */
  readonly thinking: LoomThinkingConfig | null

  /**
   * Cache profile for this session. When omitted, the loop emits the
   * provider's default 5-minute ephemeral markers. Setting `ttl: '1h'`
   * extends cache entries to survive routine between-turn pauses
   * (reading, thinking, typing) that regularly exceed 5 minutes.
   *
   * Profile-level opt-in: the default stays at 5m for every existing
   * caller, so this field cannot silently change the economics of a
   * running profile — a deliberate change in `agent.json` is required.
   */
  readonly cacheProfile?: CacheProfile

  /**
   * Speech-to-text provider. When set, the `speech_transcribe` builtin uses it
   * to turn audio files into text; when omitted the tool returns a clear
   * "not configured" error. Loom declares only the interface — the consumer
   * (Cortex) injects the credentialed implementation.
   */
  readonly sttProvider?: STTProvider

  /**
   * Text-to-speech provider. Backs the `speech_synthesize` builtin. Same
   * injected-by-consumer contract as `sttProvider`.
   */
  readonly ttsProvider?: TTSProvider
}

// ---------------------------------------------------------------------------
// Extended thinking
// ---------------------------------------------------------------------------

/**
 * Normalized extended-thinking configuration across providers.
 *
 * Anthropic: budgetTokens maps to the API's `budget_tokens` (>=1024, < maxTokens).
 * OpenAI / Google: not yet wired — field is accepted but ignored by those
 * adapters; they will implement their own reasoning primitives in a follow-up.
 */
export interface LoomThinkingConfig {
  readonly enabled: boolean
  /** Token budget Claude may spend on internal reasoning. Anthropic min 1024. */
  readonly budgetTokens: number
  /**
   * Categorical effort level for providers that don't take a token budget
   * (OpenAI o-series / gpt-5 non-chat use `reasoning_effort`). Optional —
   * adapters derive a sensible value from `budgetTokens` when omitted.
   */
  readonly effort?: 'low' | 'medium' | 'high'
}

// ---------------------------------------------------------------------------
// Sub-configs
// ---------------------------------------------------------------------------

export interface CompactionConfig {
  /** When to trigger compaction */
  readonly trigger: CompactionTrigger
  /** How much context to keep after compaction */
  readonly retain: CompactionRetain
  /** Which strategy to use */
  readonly strategy: CompactionStrategy
  /** Model to use for summarization (null = same as main model) */
  readonly summaryModel: string | null
  /** Safety timeout in ms for compaction operations. Aborts and falls back to truncation if exceeded. Default: 30000. */
  readonly safetyTimeoutMs?: number
  /**
   * Tool-result drop — an LLM-free, per-turn pass that replaces the
   * body of `tool_result` blocks older than `keepRecentTurns` with
   * short placeholders. It runs at a LOWER pressure threshold than
   * full compaction and reclaims context without rewriting message
   * history or summarising anything. The goal is to push the
   * full-compaction trigger further into the future, keeping the
   * cache prefix alive longer and avoiding the cost of a summary
   * call.
   *
   * Default is `enabled: false`. Opt-in per profile until field-validated
   * — silently changing what the model sees in older turns is a
   * correctness concern, not a performance-only tweak.
   */
  readonly toolResultDrop?: ToolResultDropConfig
  /**
   * Browser-aware snapshot supersession — drops the bodies of
   * `tool_result` blocks whose `metadata.kind === 'browser-snapshot'`
   * has been superseded by a newer snapshot of the same
   * `metadata.targetId`. LLM-free, per-turn pass that runs alongside
   * the generic `toolResultDrop`. Much higher precision than the
   * generic drop for browser sessions because it knows what's
   * actually superseded vs what's still load-bearing.
   *
   * Default is `enabled: false`. Opt-in per profile until field-
   * validated — profiles that ship browser tools by default
   * (`ownware-browser`) flip this on at the Cortex layer.
   */
  readonly browserSnapshotCompaction?: BrowserSnapshotCompactionConfig
}

/**
 * Tool-result drop configuration.
 *
 * Semantics:
 *   - `enabled: true` activates the check on every turn.
 *   - `triggerFraction` sets the pressure threshold at which the drop
 *     fires. Expressed as a fraction of the model's context window
 *     (0 < x < 1). Should be STRICTLY LESS than the full-compaction
 *     trigger fraction — otherwise full compaction would fire first
 *     and this pass would never see any work.
 *   - `keepRecentTurns` names how many of the most recent user turns
 *     are preserved verbatim. Turns older than this have their
 *     `tool_result` bodies replaced. Must be >= 1.
 *   - `minBytesToDrop` skips very small results. A 200-byte result
 *     is not worth replacing with a 90-byte placeholder.
 *   - `previewBytes` controls how much of the original content to keep
 *     verbatim inside the placeholder. A short head-preview lets the
 *     model remember roughly what was returned without paying the full
 *     storage cost. Default 150; set to 0 to disable preview entirely.
 */
export interface ToolResultDropConfig {
  readonly enabled: boolean
  /** Fire when estimated context usage >= this fraction of the window. Default 0.6. */
  readonly triggerFraction?: number
  /** Keep tool results in the last N user turns untouched. Default 3. */
  readonly keepRecentTurns?: number
  /** Skip tool results whose content is smaller than this. Default 500. */
  readonly minBytesToDrop?: number
  /** Preserve this many characters of the original content as a preview inside the placeholder. Default 150. */
  readonly previewBytes?: number
}

/**
 * Browser-aware snapshot compaction configuration (B4b).
 *
 * Semantics:
 *   - `enabled: true` activates the check on every turn.
 *   - `triggerFraction` is the context-window fraction at which the
 *     pass fires. Defaults below the generic toolResultDrop trigger
 *     so a chatty browser session reclaims via supersession before
 *     paying the generic-drop cost of dropping unrelated tool
 *     results.
 *   - `keepLatestPerTarget` controls how many snapshots per tab
 *     survive verbatim. Default 1 — only the freshest. Set to 2+
 *     for "model can compare last two states"; set to 0 to compact
 *     every snapshot regardless.
 *   - `keepRecentTurns` mirrors toolResultDrop — current turn is
 *     always preserved. Default 1.
 *   - `minBytesToDrop` skips small snapshot blocks where the
 *     breadcrumb would be nearly the same size.
 */
export interface BrowserSnapshotCompactionConfig {
  readonly enabled: boolean
  /** Fire when estimated context usage >= this fraction of the window. Default 0.5. */
  readonly triggerFraction?: number
  /** Keep this many of the most recent snapshots per tab. Default 1. */
  readonly keepLatestPerTarget?: number
  /** Keep tool results in the last N user turns untouched. Default 1. */
  readonly keepRecentTurns?: number
  /** Skip snapshots whose content is smaller than this. Default 500. */
  readonly minBytesToDrop?: number
}

export type CompactionTrigger =
  | { readonly type: 'tokens'; readonly threshold: number }
  | { readonly type: 'fraction'; readonly threshold: number }
  | { readonly type: 'messages'; readonly threshold: number }
  | { readonly type: 'disabled' }

export type CompactionRetain =
  | { readonly type: 'messages'; readonly count: number }
  | { readonly type: 'fraction'; readonly amount: number }
  | { readonly type: 'tokens'; readonly count: number }

export interface RetryConfig {
  /** Maximum retry attempts */
  readonly maxRetries: number
  /** Base delay in ms (doubles each retry with jitter) */
  readonly baseDelayMs: number
  /** Maximum delay in ms */
  readonly maxDelayMs: number
  /** Retry on these HTTP status codes */
  readonly retryableStatusCodes: readonly number[]
}

export interface ToolExecutionConfig {
  /** Default timeout per tool in ms */
  readonly defaultTimeoutMs: number
  /** Maximum concurrent tool executions */
  readonly maxConcurrency: number
  /** Maximum tool result size in characters before truncation */
  readonly maxResultSize: number
  /**
   * Directory to spill the full pre-truncation tool result into when output
   * exceeds `maxResultSize`. When set, the loop writes the untruncated output
   * here and cites the path in the in-context marker, so the model can
   * retrieve the omitted middle via readFile/grep — truncation becomes
   * recoverable instead of destroying the dropped bytes. Optional and
   * opinion-free: when unset (e.g. environments with no writable filesystem),
   * truncation falls back to in-context-only with an honest marker. The host
   * (Cortex desktop) points this at a readFile-reachable location.
   */
  readonly spillDir?: string
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  retryableStatusCodes: [429, 500, 502, 503, 529],
}

export const DEFAULT_TOOL_EXECUTION_CONFIG: ToolExecutionConfig = {
  defaultTimeoutMs: 120_000,
  maxConcurrency: 10,
  maxResultSize: 100_000,
  // spillDir intentionally unset by default — loom stays filesystem-agnostic;
  // the host opts in by pointing it at a writable, readFile-reachable dir.
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  trigger: { type: 'fraction', threshold: 0.80 },
  retain: { type: 'messages', count: 6 },
  strategy: 'summarize',
  summaryModel: null,
}

export function createDefaultConfig(model: string): LoomConfig {
  return {
    model,
    maxTurns: 100,
    maxTokens: 16_384,
    maxBudgetUsd: 0,
    temperature: null,
    systemPrompt: '',
    compaction: DEFAULT_COMPACTION_CONFIG,
    retry: DEFAULT_RETRY_CONFIG,
    toolExecution: DEFAULT_TOOL_EXECUTION_CONFIG,
    checkpointStore: null,
    fallbackModel: null,
    fallbackModels: [],
    abortSignal: null,
    agentId: null,
    sessionId: crypto.randomUUID(),
    workspacePath: null,
    additionalWorkspaceRoots: [],
    thinking: null,
  }
}

export function mergeConfig(
  base: LoomConfig,
  overrides: Partial<LoomConfig>,
): LoomConfig {
  return {
    ...base,
    ...overrides,
    compaction: { ...base.compaction, ...overrides.compaction },
    retry: { ...base.retry, ...overrides.retry },
    toolExecution: { ...base.toolExecution, ...overrides.toolExecution },
  }
}
