/**
 * Risk Analysis Tools (TorchTrade-enhanced)
 *
 * Data source: Yahoo Finance (price history for volatility calculation)
 * All computation done in the tool — no raw data sent to LLM.
 *
 * Enhancements from TorchTrade production trading knowledge:
 * - Fee-aware position sizing (entry + exit fees deducted from margin)
 * - Bracket order scenarios (multiple SL/TP combinations)
 * - Sortino ratio (downside-only risk, more useful than Sharpe)
 * - Slippage estimation
 * - Account state vector (6-element position summary)
 *
 * Tools:
 * - calculate_risk_metrics: VaR, volatility, drawdown, position sizing, stop-loss
 */

import { defineTool } from '@ownware/loom'
import type { Tool } from '@ownware/loom'

function round(n: number, d = 2): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}

// ---------------------------------------------------------------------------
// Price data fetching (reuse Yahoo Finance chart API)
// ---------------------------------------------------------------------------

interface PriceRow {
  date: string
  close: number
  high: number
  low: number
}

async function fetchPriceHistory(symbol: string, months = 6): Promise<PriceRow[]> {
  const end = Math.floor(Date.now() / 1000)
  const start = end - months * 30 * 86400

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${start}&period2=${end}&interval=1d&includePrePost=false`

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Ownware/1.0 (trading-firm-profile)' },
  })

  if (!res.ok) throw new Error(`Price API error: ${res.status}`)

  const json = (await res.json()) as Record<string, unknown>
  const chart = json.chart as Record<string, unknown>
  const results = (chart.result as Record<string, unknown>[])?.[0]
  if (!results) throw new Error(`No data for ${symbol}`)

  const timestamps = results.timestamp as number[]
  const quote = (results.indicators as Record<string, unknown>).quote as Record<string, unknown>[]
  const q = quote[0]
  const closes = q.close as (number | null)[]
  const highs = q.high as (number | null)[]
  const lows = q.low as (number | null)[]

  const rows: PriceRow[] = []
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue
    rows.push({
      date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
      close: closes[i]!,
      high: highs[i] ?? closes[i]!,
      low: lows[i] ?? closes[i]!,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Risk computations
// ---------------------------------------------------------------------------

function dailyReturns(closes: number[]): number[] {
  const returns: number[] = []
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1])
  }
  return returns
}

function standardDeviation(values: number[]): number {
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const squaredDiffs = values.map(v => (v - mean) ** 2)
  return Math.sqrt(squaredDiffs.reduce((s, v) => s + v, 0) / values.length)
}

function percentile(sorted: number[], pct: number): number {
  const idx = Math.floor(sorted.length * pct)
  return sorted[Math.min(idx, sorted.length - 1)]
}

function maxDrawdown(closes: number[]): { maxDrawdownPct: number; peakDate: number; troughDate: number } {
  let peak = closes[0]
  let peakIdx = 0
  let maxDD = 0
  let ddPeakIdx = 0
  let ddTroughIdx = 0

  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > peak) {
      peak = closes[i]
      peakIdx = i
    }
    const dd = (peak - closes[i]) / peak
    if (dd > maxDD) {
      maxDD = dd
      ddPeakIdx = peakIdx
      ddTroughIdx = i
    }
  }
  return { maxDrawdownPct: maxDD, peakDate: ddPeakIdx, troughDate: ddTroughIdx }
}

// ---------------------------------------------------------------------------
// Tool: calculate_risk_metrics
// ---------------------------------------------------------------------------

export const calculateRiskMetrics: Tool = defineTool({
  name: 'calculate_risk_metrics',
  description:
    'Calculate comprehensive risk metrics for a stock: Value at Risk (VaR), ' +
    'historical volatility, maximum drawdown, Sharpe & Sortino ratios, ' +
    'fee-aware position sizing, bracket order scenarios (multiple SL/TP combos), ' +
    'slippage estimation, and account state vector. All computed from 6 months of price history.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Ticker symbol',
      },
      proposed_action: {
        type: 'string',
        enum: ['buy', 'sell', 'hold'],
        description: 'Proposed trade direction',
      },
      entry_price: {
        type: 'number',
        description: 'Proposed entry price (use current price if not specified)',
      },
      portfolio_value: {
        type: 'number',
        description: 'Total portfolio value in USD. Default: $100,000',
      },
      risk_tolerance: {
        type: 'string',
        enum: ['conservative', 'moderate', 'aggressive'],
        description: 'Risk tolerance level. Default: moderate',
      },
      fee_rate: {
        type: 'number',
        description: 'Round-trip transaction fee as decimal (e.g., 0.001 for 0.1%). Default: 0.001 for stocks, 0.002 for crypto.',
      },
    },
    required: ['symbol'],
  },
  isReadOnly: true,
  category: 'custom',
  timeoutMs: 30_000,
  async execute(input) {
    const {
      symbol,
      proposed_action = 'buy',
      entry_price,
      portfolio_value = 100_000,
      risk_tolerance = 'moderate',
      fee_rate = 0.001,
    } = input as {
      symbol: string
      proposed_action?: string
      entry_price?: number
      portfolio_value?: number
      risk_tolerance?: string
      fee_rate?: number
    }

    try {
      const rows = await fetchPriceHistory(symbol, 6)

      if (rows.length < 30) {
        return { content: `Insufficient data for ${symbol} (${rows.length} days)`, isError: true }
      }

      const closes = rows.map(r => r.close)
      const returns = dailyReturns(closes)
      const latestPrice = closes[closes.length - 1]
      const effectiveEntry = entry_price ?? latestPrice

      // ── Volatility ──────────────────────────────────────────────────
      const dailyVol = standardDeviation(returns)
      const annualVol = dailyVol * Math.sqrt(252)

      // ── Value at Risk (Historical simulation) ───────────────────────
      const sortedReturns = [...returns].sort((a, b) => a - b)
      const var95Daily = percentile(sortedReturns, 0.05)
      const var99Daily = percentile(sortedReturns, 0.01)

      // ── Maximum drawdown ────────────────────────────────────────────
      const dd = maxDrawdown(closes)

      // ── Sharpe ratio (annualized, 4.5% risk-free rate) ─────────────
      const avgDailyReturn = returns.reduce((s, r) => s + r, 0) / returns.length
      const riskFreeDaily = 0.045 / 252
      const sharpe = dailyVol > 0
        ? round((avgDailyReturn - riskFreeDaily) / dailyVol * Math.sqrt(252), 2)
        : 0

      // ── Sortino ratio (TorchTrade-inspired: penalizes downside only) ─
      const downsideReturns = returns.filter(r => r < riskFreeDaily)
      const downsideDeviation = downsideReturns.length > 0
        ? Math.sqrt(downsideReturns.reduce((s, r) => s + (r - riskFreeDaily) ** 2, 0) / downsideReturns.length)
        : 0
      const sortino = downsideDeviation > 0
        ? round((avgDailyReturn - riskFreeDaily) / downsideDeviation * Math.sqrt(252), 2)
        : 0

      // ── ATR (14-period, proper EMA smoothing) ──────────────────────
      const trueRanges: number[] = []
      for (let i = 1; i < rows.length; i++) {
        trueRanges.push(Math.max(
          rows[i].high - rows[i].low,
          Math.abs(rows[i].high - rows[i - 1].close),
          Math.abs(rows[i].low - rows[i - 1].close),
        ))
      }
      let atr14 = trueRanges.slice(0, 14).reduce((s, v) => s + v, 0) / 14
      for (let i = 14; i < trueRanges.length; i++) {
        atr14 = (atr14 * 13 + trueRanges[i]) / 14
      }

      // ── Slippage estimation (TorchTrade: based on volatility) ──────
      // Higher volatility → more slippage. Typical: 0.02-0.10% for large-cap, more for small-cap
      const estimatedSlippagePct = Math.min(dailyVol * 0.1, 0.005) // Cap at 0.5%
      const slippagePerShare = round(effectiveEntry * estimatedSlippagePct, 4)

      // ── Fee-aware position sizing (TorchTrade formula) ─────────────
      // TorchTrade insight: you pay fees TWICE (entry + exit), so:
      //   effective_margin = allocation - (allocation × fee_rate × 2)
      //   position_qty = effective_margin / price
      const maxRiskPct = risk_tolerance === 'conservative' ? 0.01
        : risk_tolerance === 'aggressive' ? 0.03
        : 0.02

      const stopDistances = {
        tight: atr14 * 1.5,
        moderate: atr14 * 2,
        wide: atr14 * 3,
      }

      // Use moderate stop for primary sizing
      const primaryStopDist = stopDistances.moderate
      const primaryStopPct = primaryStopDist / effectiveEntry

      // Fee-aware sizing: risk budget must cover stop loss + round-trip fees + slippage
      const totalFriction = fee_rate * 2 + estimatedSlippagePct * 2 // Entry + exit
      const effectiveStopPct = primaryStopPct + totalFriction
      const positionSizePct = Math.min(maxRiskPct / effectiveStopPct, 0.15) // Cap at 15%
      const grossAllocation = portfolio_value * positionSizePct
      const feeCost = grossAllocation * fee_rate * 2
      const slippageCost = grossAllocation * estimatedSlippagePct * 2
      const netAllocation = grossAllocation - feeCost - slippageCost
      const shares = Math.floor(netAllocation / effectiveEntry)

      // ── Support/Resistance levels ──────────────────────────────────
      const recentLows = rows.slice(-20).map(r => r.low).sort((a, b) => a - b)
      const support1 = recentLows[0]
      const support2 = recentLows[Math.floor(recentLows.length * 0.25)]
      const recentHighs = rows.slice(-20).map(r => r.high).sort((a, b) => b - a)
      const resistance1 = recentHighs[0]
      const resistance2 = recentHighs[Math.floor(recentHighs.length * 0.25)]

      // ── Bracket order scenarios (TorchTrade-inspired) ──────────────
      // TorchTrade offers combinatorial SL/TP levels (3 SL × 3 TP = 9 options)
      // We generate 3 scenarios with different risk profiles
      const direction = proposed_action === 'sell' ? -1 : 1
      const bracketScenarios = [
        {
          name: 'tight',
          description: 'Tight stop, conservative target — for uncertain setups',
          stopLoss: round(effectiveEntry - direction * stopDistances.tight),
          stopLossPct: `-${round(stopDistances.tight / effectiveEntry * 100, 1)}%`,
          takeProfit: round(effectiveEntry + direction * stopDistances.tight * 2),
          takeProfitPct: `+${round(stopDistances.tight * 2 / effectiveEntry * 100, 1)}%`,
          riskReward: '2.0:1',
          feeAwareShares: Math.floor((portfolio_value * Math.min(maxRiskPct / (stopDistances.tight / effectiveEntry + totalFriction), 0.15) - feeCost) / effectiveEntry),
        },
        {
          name: 'moderate',
          description: 'Balanced risk/reward — recommended for this volatility regime',
          stopLoss: round(effectiveEntry - direction * stopDistances.moderate),
          stopLossPct: `-${round(stopDistances.moderate / effectiveEntry * 100, 1)}%`,
          takeProfit: round(effectiveEntry + direction * stopDistances.moderate * 2.5),
          takeProfitPct: `+${round(stopDistances.moderate * 2.5 / effectiveEntry * 100, 1)}%`,
          riskReward: '2.5:1',
          feeAwareShares: shares,
        },
        {
          name: 'wide',
          description: 'Wide stop, aggressive target — for high-conviction plays only',
          stopLoss: round(effectiveEntry - direction * stopDistances.wide),
          stopLossPct: `-${round(stopDistances.wide / effectiveEntry * 100, 1)}%`,
          takeProfit: round(effectiveEntry + direction * stopDistances.wide * 3),
          takeProfitPct: `+${round(stopDistances.wide * 3 / effectiveEntry * 100, 1)}%`,
          riskReward: '3.0:1',
          feeAwareShares: Math.floor((portfolio_value * Math.min(maxRiskPct / (stopDistances.wide / effectiveEntry + totalFriction), 0.15) - feeCost) / effectiveEntry),
        },
      ]

      // ── Account state vector (TorchTrade 6-element format) ─────────
      // TorchTrade tracks exactly 6 things for every position.
      // For a proposed NEW trade, we project what the state would look like.
      const projectedExposure = (shares * effectiveEntry) / portfolio_value
      const accountStateVector = {
        format: '[exposure%, direction, unrealized_pnl%, holding_time, leverage, liquidation_distance]',
        projected: [
          round(projectedExposure * 100, 1),  // exposure %
          proposed_action === 'sell' ? -1 : proposed_action === 'buy' ? 1 : 0, // direction
          0,     // unrealized P&L (0 at entry)
          0,     // holding time (0 at entry)
          1.0,   // leverage (1x for stocks)
          1.0,   // distance to liquidation (1.0 = no leverage risk)
        ],
        interpretation: `${round(projectedExposure * 100, 1)}% of portfolio exposed, ${proposed_action} direction, no leverage`,
      }

      // ── Flags ──────────────────────────────────────────────────────
      const flags: string[] = []
      if (annualVol > 0.5) flags.push('ALERT: High volatility stock (>50% annualized)')
      if (annualVol > 0.8) flags.push('ALERT: Extreme volatility (>80%) — reduce position size')
      if (dd.maxDrawdownPct > 0.3) flags.push(`ALERT: Max drawdown was ${round(dd.maxDrawdownPct * 100)}% in last 6 months`)
      if (sharpe < 0) flags.push('WARNING: Negative Sharpe ratio — risk not being compensated')
      if (sortino < 0) flags.push('WARNING: Negative Sortino — downside risk dominates')
      if (sortino > 0 && sharpe < 0) flags.push('NOTE: Sortino positive but Sharpe negative — upside exists but overall risk-adjusted returns poor')
      if (var95Daily < -0.03) flags.push('ALERT: 95% VaR exceeds 3% daily — expect large swings')
      if (estimatedSlippagePct > 0.002) flags.push(`NOTE: Estimated slippage ${round(estimatedSlippagePct * 100, 2)}% — consider limit orders`)
      if (feeCost + slippageCost > grossAllocation * 0.01) flags.push(`NOTE: Trading friction (fees+slippage) is ${round((feeCost + slippageCost) / grossAllocation * 100, 2)}% of position`)

      const result = {
        symbol,
        currentPrice: latestPrice,
        entryPrice: effectiveEntry,
        proposedAction: proposed_action,

        volatility: {
          daily: `${round(dailyVol * 100, 2)}%`,
          annualized: `${round(annualVol * 100, 1)}%`,
          regime: annualVol > 0.5 ? 'high' : annualVol > 0.25 ? 'moderate' : 'low',
        },

        valueAtRisk: {
          daily95: `${round(var95Daily * 100, 2)}% ($${round(Math.abs(var95Daily) * effectiveEntry)} per share)`,
          daily99: `${round(var99Daily * 100, 2)}% ($${round(Math.abs(var99Daily) * effectiveEntry)} per share)`,
          interpretation: `On 95% of days, losses should not exceed ${round(Math.abs(var95Daily) * 100, 1)}%`,
        },

        maxDrawdown: {
          sixMonth: `${round(dd.maxDrawdownPct * 100, 1)}%`,
          peakDate: rows[dd.peakDate]?.date,
          troughDate: rows[dd.troughDate]?.date,
        },

        riskAdjustedReturns: {
          sharpeRatio: {
            value: sharpe,
            assessment: sharpe > 1 ? 'excellent' : sharpe > 0.5 ? 'good' : sharpe > 0 ? 'mediocre' : 'poor',
          },
          sortinoRatio: {
            value: sortino,
            assessment: sortino > 2 ? 'excellent' : sortino > 1 ? 'good' : sortino > 0 ? 'mediocre' : 'poor',
            note: 'Sortino only penalizes downside volatility — more useful than Sharpe for asymmetric returns',
          },
        },

        tradingFriction: {
          feeRate: `${round(fee_rate * 100, 2)}% per side (${round(fee_rate * 200, 2)}% round-trip)`,
          estimatedSlippage: `${round(estimatedSlippagePct * 100, 3)}% per side`,
          totalFrictionPct: `${round(totalFriction * 100, 2)}% round-trip`,
          feeCostUSD: `$${round(feeCost)}`,
          slippageCostUSD: `$${round(slippageCost)}`,
          note: 'Fees and slippage are deducted BEFORE position sizing — you get fewer shares than naive calculation',
        },

        positionSizing: {
          riskTolerance: risk_tolerance,
          maxPortfolioRisk: `${round(maxRiskPct * 100)}% per trade`,
          grossAllocation: `$${round(grossAllocation).toLocaleString()}`,
          netAfterFriction: `$${round(netAllocation).toLocaleString()}`,
          recommendedPositionSize: `${round(positionSizePct * 100, 1)}% of portfolio`,
          shares,
          portfolioValue: `$${portfolio_value.toLocaleString()}`,
        },

        bracketScenarios,

        supportResistance: {
          support1: `$${round(support1)} (20-day low)`,
          support2: `$${round(support2)} (25th percentile low)`,
          resistance1: `$${round(resistance1)} (20-day high)`,
          resistance2: `$${round(resistance2)} (25th percentile high)`,
          atr14: `$${round(atr14)}`,
        },

        accountStateVector,
        flags,
      }

      return { content: JSON.stringify(result, null, 2), isError: false }
    } catch (e) {
      return { content: `Error calculating risk for ${symbol}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
})
