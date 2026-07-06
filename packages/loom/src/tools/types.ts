/**
 * Loom Tool System Types
 *
 * Tools are the actions an agent can take. Each tool has a name,
 * JSON schema for input validation, and an execute function that
 * returns results (optionally streaming progress).
 *
 * Tools are provider-agnostic — the same tool works with Anthropic,
 * OpenAI, and Google models.
 */

import type { JsonSchema } from '../provider/types.js'
import type { LoomConfig } from '../core/config.js'
import type {
  CredentialHandle,
  CredentialRequest,
  CredentialValue,
  EnvCredentialEntry,
} from '../credentials/types.js'
import type { CredentialResolver } from '../credentials/resolver.js'
import type { CredentialDescriptor } from '../credentials/descriptor.js'

// ---------------------------------------------------------------------------
// Tool context (passed to every tool execution)
// ---------------------------------------------------------------------------

export interface ToolContext {
  /** Working directory */
  readonly cwd: string
  /** Abort signal (from session or timeout) */
  readonly signal: AbortSignal
  /** Session ID */
  readonly sessionId: string
  /** Root session id of this agent's spawn/fork lineage. The framework
   *  guarantees a parent and every sub-agent it spawns/forks see the SAME
   *  value. Use this (not `sessionId`) to address a location shared across
   *  the lineage — e.g. a sub-agent writing results the parent reads back. */
  readonly rootSessionId: string
  /** Agent ID (null = root agent) */
  readonly agentId: string | null
  /** Workspace root path */
  readonly workspacePath: string
  /**
   * Additional workspace roots the agent has been granted access to
   * for this session, in addition to `workspacePath`. Empty by default.
   * Filesystem tools must accept paths within ANY of these roots and
   * apply the same security checks (symlink-escape, sensitive-path)
   * to each. Entries are absolute, canonical paths set by the session
   * host when the user grants per-folder access via the HITL flow.
   */
  readonly additionalWorkspaceRoots: readonly string[]
  /** Read-only config reference */
  readonly config: Readonly<LoomConfig>
  /** Request permission for a dangerous action */
  requestPermission(action: string, detail: string): Promise<boolean>

  /**
   * Request a secret credential from the user via HITL.
   *
   * The value is entered by the user out-of-band (gateway endpoint),
   * encrypted at rest, and NEVER returned to the tool or embedded in any
   * event/message. The tool receives only a `CredentialHandle` on
   * success, or `null` when the user denies.
   *
   * Implementation note: the `request_credential` built-in tool does NOT
   * call this directly — it yields a `ToolProgress` with `credentialRequest`
   * set, and the loop wires the HITL flow so the `credential.request` /
   * `credential.response` events stream out at the right moment. This
   * callback is provided for tools that want to ask for a credential from
   * inside a non-streaming execute(); default behaviour is "no HITL
   * wired" → resolves to `null` (deny).
   */
  requestCredential(request: CredentialRequest): Promise<CredentialHandle | null>

  /**
   * Resolve a credential id to its plaintext value.
   *
   * Synchronous by design — consumers (shell env-injection) must be able
   * to call this per-spawn without awaiting. The session pre-loads values
   * into a cache at assembly time and keeps them in memory only.
   *
   * **SECURITY CRITICAL**: the returned string is a raw secret. It must
   * NEVER appear in a `ToolResult.content`, a `LoomEvent`, a log line,
   * or any value that reaches the model. Legitimate callers are:
   *   - shell_execute env-merge (value goes to child process env)
   *   - shell_execute output redactor (value used to build replacement map)
   *
   * Returns `null` when the id is unknown. Unknown includes "not yet
   * stored" and "was deleted".
   */
  resolveCredential(credentialId: string): string | null

  /**
   * Enumerate credentials that should be auto-injected as environment
   * variables. Returned entries carry only the `credentialId` +
   * `variableName`; the value is fetched via `resolveCredential` at
   * injection time.
   */
  listEnvCredentials(): readonly EnvCredentialEntry[]

  /**
   * Enumerate every known credential **with its raw value** — ONLY for
   * output redaction. This is the one ToolContext method that returns
   * secret strings. The redactor uses them to scrub matching substrings
   * from captured stdout/stderr before returning output to the model.
   *
   * MUST NOT be used to send credentials to the model. Any caller that
   * passes a returned `value` into `ToolResult.content` or an event is a
   * security bug.
   */
  listAllCredentialValues(): readonly CredentialValue[]

  /**
   * The unified credential resolver (board: credentials-unification —
   * C20). When set, tools can resolve a credential by canonical
   * variable name and receive an opaque handle that the gateway
   * dereferences at the OS boundary.
   *
   * `undefined` when the consumer (Cortex during the cutover; loom's
   * standalone CLI; tests) hasn't wired the new resolver path yet —
   * tools must fall back to the legacy `resolveCredential(id)`
   * callback (which keeps working in parallel) or report a missing
   * credential to the user via their normal error path.
   *
   * Tools that opt into the new path should declare a static
   * `requires: CredentialDescriptor[]` on the tool definition (C37);
   * a future tool dispatcher will pre-resolve those declarations
   * and attach the handles to `context` before invoking the tool's
   * `execute()`.
   */
  readonly credentialResolver?: CredentialResolver
}

// ---------------------------------------------------------------------------
// Tool result
// ---------------------------------------------------------------------------

export interface ToolResult {
  /** String content returned to the model */
  readonly content: string
  /** Whether the result represents an error */
  readonly isError: boolean
  /** Metadata (not sent to model, used for observability) */
  readonly metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Pre-execute validation
// ---------------------------------------------------------------------------

/**
 * Result of a tool's optional `validateInput` phase.
 *
 * `errorCode` is a numeric classification consumers (telemetry, UI
 * tool cards) can switch on without parsing message strings. The loom
 * builtins reserve specific ranges:
 *   - 10–19  filesystem path / boundary errors
 *   - 20–29  filesystem content / mutation errors
 * Custom tools may use any code; pick something distinguishable from
 * the reserved ranges if you want telemetry to disambiguate.
 */
export type ValidateInputResult =
  | { readonly result: true }
  | {
      readonly result: false
      readonly message: string
      readonly errorCode?: number
    }

// ---------------------------------------------------------------------------
// Tool progress (for streaming tool output)
// ---------------------------------------------------------------------------

export interface ToolProgress {
  /** Progress message (shown to user, not sent to model) */
  readonly message: string
  /** Optional percentage (0-100) */
  readonly percent?: number
  /**
   * When set, the loop treats this yield as a HITL credential request:
   *   1. Emits a `credential.request` LoomEvent on the loop's stream.
   *   2. Awaits the session's credential-request callback.
   *   3. Emits a `credential.response` event.
   *   4. Resumes the generator via `.next(handle)` so the tool's `yield`
   *      expression evaluates to `CredentialHandle | null`.
   *
   * Tools consume the resumed value with
   * `const handle = (yield { message, credentialRequest }) as CredentialHandle | null`.
   *
   * Used by the `request_credential` built-in; other tools can adopt the
   * same mechanism if they need in-band credential HITL without going
   * through a prior `request_credential` call.
   */
  readonly credentialRequest?: CredentialRequest
}

// ---------------------------------------------------------------------------
// Tool UI Descriptor — render-metadata declared on the tool
// ---------------------------------------------------------------------------
//
// Pure-data shape (no React, no zod). The canonical wire schema lives
// in cortex (`packages/cortex/src/connector/schema.ts` →
// `ToolUIDescriptorSchema`); Loom duplicates the TS type to honor the
// "Loom imports nothing" rule. Cortex's zod parser validates at the
// wire boundary — if the types drift, the cortex parse fails loudly
// rather than silently delivering an inconsistent shape to the client.
//
// Tools that omit `uiDescriptor` render via the client's generic fallback
// keyed off the tool's name + category. Tools that declare one drive
// the inline tool row's summary, chevron-expand preview, and [Open]
// affordance. A client MAY register a bespoke renderer keyed by tool
// name to override the descriptor-driven render — the dispatcher
// prefers bespoke over generic.

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
  readonly target:
    | 'file-pane'
    | 'terminal-pane'
    | 'image-pane'
    | 'search-pane'
    | 'url'
  readonly pathField: string
}

export interface ToolUIDescriptor {
  readonly kind: ToolUIKind
  readonly summary: ToolUISummary
  readonly preview?: ToolUIPreview
  readonly openAction?: ToolUIOpenAction
}

// ---------------------------------------------------------------------------
// Tool interface
// ---------------------------------------------------------------------------

export interface Tool<TInput extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique tool name */
  readonly name: string

  /** Human-readable description (sent to model) */
  readonly description: string

  /** JSON Schema for input validation */
  readonly inputSchema: JsonSchema

  /**
   * Execute the tool.
   *
   * Can be a simple async function returning ToolResult,
   * or an AsyncGenerator that yields ToolProgress events
   * before returning the final ToolResult.
   */
  execute(
    input: TInput,
    context: ToolContext,
  ): Promise<ToolResult> | AsyncGenerator<ToolProgress, ToolResult>

  /**
   * Optional pre-execute validation phase.
   *
   * Called by `executeTool` AFTER permission and before-hooks but BEFORE the
   * timeout timer arms and `execute` runs. The intended use is tool-level
   * invariants that benefit from a clean early exit — sensitive-path blocks,
   * read-before-write checks, secret-content scans, content-shape rejections
   * — so the model sees a "validation rejected" result with a stable
   * `errorCode` instead of a tool that started executing and partially
   * succeeded before erroring.
   *
   * **Contract:**
   *  - Tools that omit this method are equivalent to always returning
   *    `{ result: true }`. Existing tools continue to work unchanged.
   *  - On `{ result: false }` the executor returns a `ToolResult` with
   *    `isError: true`, the supplied `message` as `content`, and
   *    `metadata.validation = { errorCode }`. After-hooks DO NOT run.
   *  - `validateInput` MUST NOT have observable side effects beyond what
   *    `execute` would have (read I/O is fine; writes are not). It runs
   *    inside the session's abort signal but without a timeout — keep it
   *    cheap.
   *  - When validation passes, `execute` runs normally. The tool's own
   *    `execute` may re-check the same invariants for defence in depth
   *    against direct callers that bypass `executeTool` (e.g. tests). Such
   *    duplication is expected and acceptable; idempotent checks are
   *    cheap.
   */
  validateInput?(
    input: TInput,
    context: ToolContext,
  ): Promise<ValidateInputResult>

  /**
   * Whether this tool is read-only (safe for parallel execution).
   * Read-only tools can run concurrently. Write tools run serially.
   * Default: false (write/mutating).
   */
  readonly isReadOnly?: boolean

  /**
   * Whether this tool requires explicit permission before execution.
   * Default: false.
   */
  readonly requiresPermission?: boolean

  /**
   * Custom timeout for this tool in ms.
   * Overrides the default from ToolExecutionConfig.
   * Null = use default.
   */
  readonly timeoutMs?: number | null

  /**
   * Opt out of tool-execution timeout entirely.
   *
   * Use this for tools whose runtime is bounded by their own internal
   * mechanisms (nested loop with maxTurns + budget + abort-propagation),
   * where a wall-clock tool timeout is actively harmful. `agent_spawn`
   * is the canonical case: a legitimate sub-agent may chain many tools
   * and run for 10+ minutes; killing it at the default 120s throws away
   * work the parent can never reconstruct.
   *
   * When true, the executor does NOT arm a timeout timer and passes the
   * session's AbortSignal straight through — so user abort still works.
   * `timeoutMs` is ignored when this is set. Default: false.
   */
  readonly disableTimeout?: boolean

  /**
   * Maximum result size in characters for this tool.
   * Null = use default from ToolExecutionConfig.
   */
  readonly maxResultSize?: number | null

  /**
   * Tool category for grouping and policy.
   */
  readonly category?: ToolCategory

  /**
   * Optional opt-in cache key. When defined, the executor consults a
   * session-scoped result cache before invoking `execute`: a cache hit
   * returns the cached `ToolResult` without re-running the tool.
   *
   * Contract:
   *   - Return a string key → cache lookup + on-miss populate.
   *   - Return `null` → bypass the cache for this call (e.g. input that
   *     can't be safely keyed, file paths outside the workspace, etc.).
   *   - Omit the field entirely → tool is never cached.
   *
   * Keys MUST be deterministic with respect to the inputs that affect
   * the result. The canonical filesystem pattern is `path:mtime`; for
   * pure-function tools, a stable JSON of `input` is enough. Tools whose
   * output depends on side effects (shell commands, network calls, the
   * current time) must NOT define this field.
   *
   * The cache lives in memory for the session only — disk-backed caches
   * are a Cortex concern. Loom is the engine.
   */
  readonly cacheKey?: (input: TInput, context: ToolContext) => string | null

  /**
   * Credentials this tool requires to operate (board:
   * credentials-unification — C37). Each descriptor declares one
   * credential by canonical variable name. The future tool
   * dispatcher (Phase 9 work) will resolve every descriptor BEFORE
   * invoking `execute()`, so the tool sees only opaque handles via
   * `context.credentialResolver`.
   *
   * When omitted (or empty), the tool declares no credential
   * dependencies — `request_credential` and the legacy
   * `resolveCredential` callback continue to be the integration
   * point for ad-hoc credential needs.
   */
  readonly requires?: readonly CredentialDescriptor[]

  /**
   * Optional render descriptor — drives the UI client's chat-stream
   * inline tool row. When present, cortex relays it through
   * `/api/v1/connectors` so a client can pair it with a bespoke
   * renderer (keyed by tool name) or feed it to the generic
   * descriptor-driven renderer.
   *
   * Pure data — no React, no zod. The wire schema is enforced in
   * cortex (`ToolUIDescriptorSchema`). See `ToolUIDescriptor` in
   * this file for the field shape and the kind enum.
   *
   * Tools that omit this field render via the client's name/category
   * heuristics today (FALLBACK_DESCRIPTOR + inferIconFromName). New
   * builtins should declare a descriptor explicitly — no fallthrough.
   */
  readonly uiDescriptor?: ToolUIDescriptor
}

export type ToolCategory =
  | 'filesystem'
  | 'shell'
  | 'browser'
  | 'search'
  | 'agent'
  | 'memory'
  | 'custom'
  | 'mcp'

// ---------------------------------------------------------------------------
// Tool builder (convenience for defining tools)
// ---------------------------------------------------------------------------

export function defineTool<TInput extends Record<string, unknown>>(
  spec: Tool<TInput>,
): Tool<TInput> {
  return {
    isReadOnly: false,
    requiresPermission: false,
    timeoutMs: null,
    maxResultSize: null,
    category: 'custom',
    ...spec,
  }
}

// ---------------------------------------------------------------------------
// Tool call (what the model requests)
// ---------------------------------------------------------------------------

export interface ToolCall {
  /** Unique ID for this tool call instance */
  readonly id: string
  /** Tool name */
  readonly name: string
  /** Tool input (parsed from model's JSON) */
  readonly input: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Tool execution result (internal, includes timing)
// ---------------------------------------------------------------------------

export interface ToolExecutionResult {
  readonly toolCall: ToolCall
  readonly result: ToolResult
  readonly durationMs: number
  readonly wasPermissionDenied: boolean
  /** True when the result was served from a `ToolResultCache` instead of
   *  executing the tool. Optional — present only when a cache was passed
   *  to `executeTool()`. */
  readonly cacheHit?: boolean
}
