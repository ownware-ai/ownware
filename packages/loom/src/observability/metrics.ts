/**
 * @ownware/loom - Metrics collector for token usage, tool calls, turns, and cost.
 * Zero external dependencies.
 */

export interface ToolCallMetric {
  count: number;
  totalDurationMs: number;
  errorCount: number;
  /** Sum of UTF-8 bytes a tool produced before any cap. */
  bytesRaw: number;
  /** Sum of UTF-8 bytes actually returned to the model after cap. */
  bytesToModel: number;
  /** Number of calls whose output was truncated to fit the cap. */
  truncatedCount: number;
  /** Number of calls served from the result cache. */
  cacheHitCount: number;
}

export interface ContextSavings {
  /** Total raw bytes produced by all tool calls in the session. */
  totalBytesRaw: number;
  /** Total bytes actually delivered to the model. */
  totalBytesToModel: number;
  /** Bytes saved by capping (raw − to-model). */
  bytesSaved: number;
  /** Fraction saved, in [0,1]. 0 when no tool output was produced. */
  savingsRatio: number;
  /** Bytes the cache spared the agent from re-emitting (sum of cache-hit
   *  result sizes). Distinct from `bytesSaved`, which is about cap. */
  bytesSavedFromCache: number;
  /** Total cache-hit count across all tools. */
  cacheHits: number;
}

export interface MetricsSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  turnCount: number;
  avgTurnDurationMs: number;
  toolCalls: Record<string, ToolCallMetric>;
  contextSavings: ContextSavings;
}

interface TurnMetric {
  turnIndex: number;
  durationMs: number;
}

export class MetricsCollector {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheCreationTokens = 0;
  private costUsd = 0;
  private turns: TurnMetric[] = [];
  private tools: Record<string, ToolCallMetric> = {};
  private bytesSavedFromCache = 0;

  trackTokenUsage(
    _model: string,
    input: number,
    output: number,
    cacheRead: number,
    cacheCreation: number,
  ): void {
    this.inputTokens += input;
    this.outputTokens += output;
    this.cacheReadTokens += cacheRead;
    this.cacheCreationTokens += cacheCreation;
  }

  trackToolCall(
    toolName: string,
    durationMs: number,
    isError: boolean,
    bytes?: { raw?: number; toModel?: number; truncated?: boolean; cacheHit?: boolean },
  ): void {
    if (!this.tools[toolName]) {
      this.tools[toolName] = {
        count: 0,
        totalDurationMs: 0,
        errorCount: 0,
        bytesRaw: 0,
        bytesToModel: 0,
        truncatedCount: 0,
        cacheHitCount: 0,
      };
    }
    const metric = this.tools[toolName];
    metric.count += 1;
    metric.totalDurationMs += durationMs;
    if (isError) metric.errorCount += 1;
    if (bytes) {
      metric.bytesRaw += bytes.raw ?? 0;
      metric.bytesToModel += bytes.toModel ?? 0;
      if (bytes.truncated) metric.truncatedCount += 1;
      if (bytes.cacheHit) {
        metric.cacheHitCount += 1;
        this.bytesSavedFromCache += bytes.toModel ?? 0;
      }
    }
  }

  trackTurn(turnIndex: number, durationMs: number): void {
    this.turns.push({ turnIndex, durationMs });
  }

  trackCost(_model: string, costUsd: number): void {
    this.costUsd += costUsd;
  }

  getSummary(): MetricsSummary {
    const turnCount = this.turns.length;
    const totalTurnDuration = this.turns.reduce((sum, t) => sum + t.durationMs, 0);
    const avgTurnDurationMs = turnCount > 0 ? totalTurnDuration / turnCount : 0;

    let totalBytesRaw = 0;
    let totalBytesToModel = 0;
    let cacheHits = 0;
    for (const m of Object.values(this.tools)) {
      totalBytesRaw += m.bytesRaw;
      totalBytesToModel += m.bytesToModel;
      cacheHits += m.cacheHitCount;
    }
    const bytesSaved = totalBytesRaw - totalBytesToModel;
    const savingsRatio = totalBytesRaw > 0 ? bytesSaved / totalBytesRaw : 0;

    return {
      totalInputTokens: this.inputTokens,
      totalOutputTokens: this.outputTokens,
      totalCacheReadTokens: this.cacheReadTokens,
      totalCacheCreationTokens: this.cacheCreationTokens,
      totalCostUsd: this.costUsd,
      turnCount,
      avgTurnDurationMs,
      toolCalls: { ...this.tools },
      contextSavings: {
        totalBytesRaw,
        totalBytesToModel,
        bytesSaved,
        savingsRatio,
        bytesSavedFromCache: this.bytesSavedFromCache,
        cacheHits,
      },
    };
  }

  reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheCreationTokens = 0;
    this.costUsd = 0;
    this.turns = [];
    this.tools = {};
    this.bytesSavedFromCache = 0;
  }
}
