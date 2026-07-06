/**
 * Session Metrics — public API
 *
 * Unified shape for everything a `/metrics` panel wants about a
 * running session: context utilization, USD cost, token totals,
 * cache stats. See ./types.ts for the design overview.
 */

export type {
  SessionMetrics,
  CostBreakdown,
  TokenBreakdown,
  CacheStats,
} from './types.js'

export { computeCostBreakdown } from './cost.js'
export type { CostBreakdownInputs } from './cost.js'
