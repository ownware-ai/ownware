/**
 * Tool Executor
 *
 * Runs a single tool with the full lifecycle:
 * 1. Permission check (if tool.requiresPermission)
 * 2. Hook: beforeToolCall
 * 3. Timeout enforcement via AbortSignal
 * 4. Execute (supports Promise<ToolResult> and AsyncGenerator<ToolProgress, ToolResult>)
 * 5. Result size capping
 * 6. Hook: afterToolCall
 * 7. Duration tracking
 */

import type {
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolProgress,
  ToolExecutionResult,
} from './types.js'
import type { ToolHookRegistry } from './hooks.js'
import type { ToolExecutionConfig } from '../core/config.js'
import { headTailTruncate } from '../messages/truncate.js'
import type { ToolResultCache } from './result-cache.js'

// ---------------------------------------------------------------------------
// Config defaults (used when no config is provided)
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_RESULT_SIZE = 100_000

// ---------------------------------------------------------------------------
// Execution options
// ---------------------------------------------------------------------------

export interface ExecuteToolOptions {
  /** Tool instance to execute */
  readonly tool: Tool
  /** The tool call from the model */
  readonly toolCall: ToolCall
  /** Tool execution context */
  readonly context: ToolContext
  /** Hook registry (optional) */
  readonly hooks?: ToolHookRegistry
  /** Execution config overrides */
  readonly config?: Partial<ToolExecutionConfig>
  /** Callback for progress events */
  readonly onProgress?: (progress: ToolProgress) => void
  /** Optional result cache. Tools that define `cacheKey` will be
   *  consulted; tools without `cacheKey` are unaffected. */
  readonly cache?: ToolResultCache
}

// ---------------------------------------------------------------------------
// executeTool — main entry point
// ---------------------------------------------------------------------------

export async function executeTool(
  options: ExecuteToolOptions,
): Promise<ToolExecutionResult> {
  const { tool, toolCall, context, hooks, config, onProgress, cache } = options
  const start = Date.now()

  // ── 1. Permission check ──────────────────────────────────────────────
  if (tool.requiresPermission) {
    const granted = await context.requestPermission(
      tool.name,
      `Execute tool "${tool.name}" with input: ${summarizeInput(toolCall.input)}`,
    )
    if (!granted) {
      return {
        toolCall,
        result: {
          content: `Permission denied for tool "${tool.name}".`,
          isError: true,
        },
        durationMs: Date.now() - start,
        wasPermissionDenied: true,
      }
    }
  }

  // ── 2. Before hooks ──────────────────────────────────────────────────
  let effectiveInput = toolCall.input
  if (hooks) {
    const hookResult = await hooks.runBeforeHooks(tool.name, effectiveInput, context)
    if (hookResult.blocked) {
      return {
        toolCall,
        result: {
          content: hookResult.reason ?? `Blocked by before-hook for "${tool.name}".`,
          isError: true,
        },
        durationMs: Date.now() - start,
        wasPermissionDenied: false,
      }
    }
    if (hookResult.modifiedInput) {
      effectiveInput = hookResult.modifiedInput
    }
  }

  // ── 2.5 Pre-execute validation ───────────────────────────────────────
  //
  // Tools may declare a cheap, side-effect-free pre-flight in
  // `validateInput`. Failures surface as a normal `ToolResult` with
  // `isError: true` and `metadata.validation = { errorCode }`, so existing
  // model-facing error handling continues to work and downstream
  // consumers (UI tool-card renderers, telemetry) can switch on the
  // numeric code. After-hooks do NOT run on validation failure — same
  // shape as permission denial and before-hook block above.
  if (tool.validateInput) {
    const validation = await tool.validateInput(effectiveInput as never, context)
    if (validation.result === false) {
      return {
        toolCall: { ...toolCall, input: effectiveInput },
        result: {
          content: validation.message,
          isError: true,
          metadata: {
            validation: {
              errorCode: validation.errorCode ?? 0,
            },
          },
        },
        durationMs: Date.now() - start,
        wasPermissionDenied: false,
      }
    }
  }

  // ── 3. Build timeout signal ──────────────────────────────────────────
  //
  // Two modes:
  //   • Timed (default): arm a setTimeout that aborts an inner controller
  //     after `timeoutMs`; the tool sees the combined (session | timeout)
  //     signal and any error bubbles as AbortError.
  //   • Disabled (`tool.disableTimeout === true`): no timer armed, the
  //     tool sees the session signal unchanged. User abort still works;
  //     only the wall-clock kill-switch is removed. Used by tools whose
  //     runtime is bounded internally (e.g. agent_spawn — sub-agents
  //     have their own maxTurns + budget + abort-propagation, and a
  //     120s tool-exec kill destroys work the parent cannot recover).
  const timeoutMs = resolveTimeout(tool, config)
  const timeoutDisabled = tool.disableTimeout === true

  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let effectiveSignal: AbortSignal
  if (timeoutDisabled) {
    effectiveSignal = context.signal
  } else {
    const timeoutController = new AbortController()
    timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs)
    effectiveSignal = combineSignals(context.signal, timeoutController.signal)
  }

  const timeoutContext: ToolContext = {
    ...context,
    signal: effectiveSignal,
  }

  // ── 4. Cache lookup or execute ───────────────────────────────────────
  // Tools without a `cacheKey` are never cached. A null return from
  // `cacheKey` means "this call isn't safe to cache" (e.g. path outside
  // the workspace) — bypass the cache for this call only.
  const cacheKey =
    cache && tool.cacheKey ? tool.cacheKey(effectiveInput, context) : null

  let result: ToolResult
  let cacheHit = false

  if (cache && cacheKey != null) {
    const hit = cache.get(tool.name, cacheKey)
    if (hit) {
      result = hit
      cacheHit = true
      if (timeoutId !== null) clearTimeout(timeoutId)
    }
  }

  if (!cacheHit) {
    try {
      result = await executeWithGenerator(
        tool,
        effectiveInput,
        timeoutContext,
        onProgress,
      )
    } catch (error) {
      if (timeoutId !== null) clearTimeout(timeoutId)
      result = errorToToolResult(error, timeoutMs)
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId)
    }

    // Populate cache with the RAW result (pre-cap). The cap is a
    // presentation concern that may differ between calls — caching
    // the raw answer keeps the cache correct under cap changes.
    if (cache && cacheKey != null) cache.set(tool.name, cacheKey, result!)
  }

  // ── 5. Cap result size ───────────────────────────────────────────────
  result = capResultSize(result!, resolveMaxResultSize(tool, config), config)

  // ── 6. After hooks ───────────────────────────────────────────────────
  if (hooks) {
    result = await hooks.runAfterHooks(tool.name, effectiveInput, result, context)
  }

  // ── 7. Return with timing ────────────────────────────────────────────
  return {
    toolCall: { ...toolCall, input: effectiveInput },
    result,
    durationMs: Date.now() - start,
    wasPermissionDenied: false,
    cacheHit,
  }
}

// ---------------------------------------------------------------------------
// Execute handling — supports both Promise and AsyncGenerator
// ---------------------------------------------------------------------------

async function executeWithGenerator(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolContext,
  onProgress?: (progress: ToolProgress) => void,
): Promise<ToolResult> {
  const resultOrGen = tool.execute(input, context)

  // AsyncGenerator path
  if (isAsyncGenerator(resultOrGen)) {
    const gen = resultOrGen as AsyncGenerator<ToolProgress, ToolResult>
    let next = await gen.next()
    while (!next.done) {
      if (onProgress && next.value) {
        onProgress(next.value)
      }
      next = await gen.next()
    }
    return next.value
  }

  // Promise path
  return resultOrGen as Promise<ToolResult>
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator {
  return (
    value != null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in (value as object)
  )
}

// ---------------------------------------------------------------------------
// Timeout / signal helpers
// ---------------------------------------------------------------------------

function resolveTimeout(
  tool: Tool,
  config?: Partial<ToolExecutionConfig>,
): number {
  if (tool.timeoutMs != null) return tool.timeoutMs
  return config?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
}

function resolveMaxResultSize(
  tool: Tool,
  config?: Partial<ToolExecutionConfig>,
): number {
  if (tool.maxResultSize != null) return tool.maxResultSize
  return config?.maxResultSize ?? DEFAULT_MAX_RESULT_SIZE
}

/**
 * Combine two AbortSignals — abort when either fires.
 */
function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a
  if (b.aborted) return b

  const controller = new AbortController()
  const onAbort = () => controller.abort()

  a.addEventListener('abort', onAbort, { once: true })
  b.addEventListener('abort', onAbort, { once: true })

  return controller.signal
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

function errorToToolResult(error: unknown, timeoutMs: number): ToolResult {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return {
      content: `Tool execution timed out after ${Math.round(timeoutMs / 1000)}s.`,
      isError: true,
    }
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      content: 'Tool execution was cancelled.',
      isError: true,
    }
  }
  return {
    content: `Error: ${error instanceof Error ? error.message : String(error)}`,
    isError: true,
  }
}

// ---------------------------------------------------------------------------
// Result size capping
// ---------------------------------------------------------------------------

function capResultSize(
  result: ToolResult,
  maxSize: number,
  _config?: Partial<ToolExecutionConfig>,
): ToolResult {
  // maxSize is interpreted as UTF-8 bytes (matches token-cost more closely
  // than char count and avoids splitting multi-byte sequences).
  const originalBytes = Buffer.byteLength(result.content, 'utf8')
  if (originalBytes <= maxSize) return result

  const truncated = headTailTruncate(result.content, maxSize)

  return {
    ...result,
    content: truncated,
    metadata: {
      ...result.metadata,
      truncated: true,
      originalSize: originalBytes,
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input)
  if (json.length <= 200) return json
  return json.slice(0, 200) + '…'
}

// ---------------------------------------------------------------------------
// Batch executor (convenience for multiple tool calls)
// ---------------------------------------------------------------------------

export async function executeToolBatch(
  calls: Array<{ tool: Tool; toolCall: ToolCall }>,
  context: ToolContext,
  hooks?: ToolHookRegistry,
  config?: Partial<ToolExecutionConfig>,
  onProgress?: (toolCallId: string, progress: ToolProgress) => void,
): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = []
  for (const { tool, toolCall } of calls) {
    const result = await executeTool({
      tool,
      toolCall,
      context,
      hooks,
      config,
      onProgress: onProgress
        ? (p) => onProgress(toolCall.id, p)
        : undefined,
    })
    results.push(result)
  }
  return results
}
