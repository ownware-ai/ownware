/**
 * Dashboard handlers — aggregated stats, KPIs, usage charts, storage, and data export.
 *
 * GET  /api/v1/dashboard                  — backward-compat aggregated stats
 * GET  /api/v1/dashboard/kpis             — KPI cards with deltas and sparklines
 * GET  /api/v1/dashboard/usage-chart      — time-series usage buckets
 * GET  /api/v1/dashboard/profile-breakdown — per-profile aggregated stats
 * GET  /api/v1/dashboard/recent-activity  — recent completed runs
 * GET  /api/v1/storage/stats              — database size and record counts
 * POST /api/v1/storage/clear-cache        — clear in-memory event logs
 * POST /api/v1/data/export                — export all user data as JSON
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { statSync } from 'node:fs'
import { sendJSON } from '../router.js'
import type { GatewayState } from '../state.js'
import type { DashboardRange } from '../types.js'

/** Valid range values for dashboard queries. */
const VALID_RANGES = new Set<DashboardRange>(['24h', '7d', '30d', '90d'])

/** Default dashboard range. */
const DEFAULT_RANGE: DashboardRange = '7d'

/** Maximum limit for recent-activity query. */
const MAX_ACTIVITY_LIMIT = 100

/** Default limit for recent-activity query. */
const DEFAULT_ACTIVITY_LIMIT = 20

function parseRange(req: IncomingMessage): DashboardRange {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const raw = url.searchParams.get('range') ?? DEFAULT_RANGE
  return VALID_RANGES.has(raw as DashboardRange) ? raw as DashboardRange : DEFAULT_RANGE
}

function parseLimit(req: IncomingMessage, defaultVal: number, max: number): number {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const raw = url.searchParams.get('limit')
  if (!raw) return defaultVal
  const n = parseInt(raw, 10)
  if (isNaN(n) || n < 1) return defaultVal
  return Math.min(n, max)
}

export function createDashboardHandlers(state: GatewayState) {

  // GET /api/v1/dashboard — backward-compat aggregated stats
  async function getDashboard(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendJSON(res, 200, state.getDashboardStats())
  }

  // GET /api/v1/dashboard/kpis?range=7d
  async function getKPIs(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const range = parseRange(req)
    sendJSON(res, 200, state.getKPIs(range))
  }

  // GET /api/v1/dashboard/usage-chart?range=7d
  async function getUsageChart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const range = parseRange(req)
    const buckets = state.getUsageTimeSeries(range)

    let peakTokens = 0
    let peakCost = 0
    let peakRuns = 0
    let totalTokens = 0
    let totalCost = 0
    let totalRuns = 0

    for (const b of buckets) {
      if (b.tokens > peakTokens) peakTokens = b.tokens
      if (b.cost > peakCost) peakCost = b.cost
      if (b.runs > peakRuns) peakRuns = b.runs
      totalTokens += b.tokens
      totalCost += b.cost
      totalRuns += b.runs
    }

    sendJSON(res, 200, {
      buckets,
      peak: { tokens: peakTokens, cost: peakCost, runs: peakRuns },
      total: { tokens: totalTokens, cost: totalCost, runs: totalRuns },
    })
  }

  // GET /api/v1/dashboard/profile-breakdown
  async function getProfileBreakdown(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendJSON(res, 200, state.getProfileBreakdown())
  }

  // GET /api/v1/dashboard/recent-activity?limit=20
  async function getRecentActivity(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const limit = parseLimit(req, DEFAULT_ACTIVITY_LIMIT, MAX_ACTIVITY_LIMIT)
    sendJSON(res, 200, state.getRecentActivity(limit))
  }

  // GET /api/v1/storage/stats
  async function getStorageStats(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const dbStats = state.getStorageStats()
    let dbSizeBytes = 0
    try {
      const stat = statSync(state.dbPath)
      dbSizeBytes = stat.size
    } catch {
      // DB path might not be readable (shouldn't happen)
    }

    sendJSON(res, 200, {
      dbSizeBytes,
      threadCount: dbStats.threadCount,
      messageCount: dbStats.messageCount,
      usageRecordCount: dbStats.usageRecordCount,
      eventLogEntries: state.eventLogEntryCount,
    })
  }

  // POST /api/v1/storage/clear-cache
  async function clearCache(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const eventLogs = state.clearEventLogs()
    sendJSON(res, 200, {
      cleared: { eventLogs, oldUsage: 0 },
    })
  }

  // POST /api/v1/data/export
  async function exportData(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const data = state.exportAllData()
    sendJSON(res, 200, {
      ...data,
      exportedAt: new Date().toISOString(),
    })
  }

  return {
    getDashboard,
    getKPIs,
    getUsageChart,
    getProfileBreakdown,
    getRecentActivity,
    getStorageStats,
    clearCache,
    exportData,
  }
}
