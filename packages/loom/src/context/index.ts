/**
 * Context Usage — public API
 *
 * Token-budget measurement for a session's current context state —
 * a context-window usage breakdown: total used, free space, per-
 * category breakdown (system prompt / tools / memory / skills / messages).
 *
 * See ./types.ts for the data shape and ./usage.ts for the algorithm.
 */

export type {
  ContextUsage,
  ContextUsageBreakdown,
  CountMethod,
  TokenCounter,
} from './types.js'

export { measureContextUsage, measureContextUsageWithDiagnostics } from './usage.js'
export type {
  MeasureContextUsageOptions,
  MeasureContextUsageDiagnostics,
} from './usage.js'
