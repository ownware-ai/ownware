/**
 * Signal Backtesting Tool
 *
 * Runs the technical composite score against historical data to prove
 * (or disprove) whether the signal has edge. Pure math, no LLM calls,
 * fully deterministic and reproducible.
 *
 * Simulates: entry on score threshold, exit on opposite threshold or stop-loss,
 * with transaction fees and slippage.
 *
 * Tools:
 * - backtest_signal: Run technical score backtest over 1-5 years
 */

import { defineTool } from '@ownware/loom'
import type { Tool } from '@ownware/loom'
import {
  fetchOHLCVWithRetry,
  dataFreshness,
  round,
  computeRSI,
  computeMACDSignal,
  computeSMA,
  computeATR,
  lastVal,
  type OHLCVRow,
} from './shared.ts'
import { computeTechScore } from './score.ts'

// ---------------------------------------------------------------------------
// Backtest engine
// ---------------------------------------------------------------------------

interface Trade {
  entryDate: string
  entryPrice: number
  exitDate: string
  exitPrice: number
  direction: 'long' | 'short'
  pnlPct: number
  holdingDays: number
  exitReason: 'signal_flip' | 'stop_loss' | 'end_of_data'
}

interface BacktestResult {
  totalTrades: number
  winningTrades: number
  losingTrades: number
  winRate: number
  avgWinPct: number
  avgLossPct: number
  totalReturnPct: number
  annualizedReturnPct: number
  maxDrawdownPct: number
  sharpeRatio: number
  sortinoRatio: number
  profitFactor: number
  avgHoldingDays: number
  trades: Trade[]
  equityCurve: Array<{ date: string; equity: number }>
}

function runBacktest(
  rows: OHLCVRow[],
  entryThreshold: number,
  exitThreshold: number,
  stopLossPct: number,
  feeRate: number,
  lookback: number,
): BacktestResult {
  const trades: Trade[] = []
  const dailyReturns: number[] = []
  let equity = 10000
  const equityCurve: Array<{ date: string; equity: number }> = []
  let peakEquity = equity
  let maxDrawdown = 0

  let inPosition = false
  let direction: 'long' | 'short' = 'long'
  let entryPrice = 0
  let entryDate = ''
  let entryIdx = 0

  // Need at least 200 days for SMA200, start scoring from there
  const startIdx = Math.max(lookback, 200)

  for (let i = startIdx; i < rows.length; i++) {
    // Compute score using data up to this point (no lookahead)
    const windowRows = rows.slice(0, i + 1)
    const closes = windowRows.map(r => r.close)
    const highs = windowRows.map(r => r.high)
    const lows = windowRows.map(r => r.low)
    const volumes = windowRows.map(r => r.volume)

    const scoreResult = computeTechScore(closes, highs, lows, volumes)
    const score = scoreResult.score

    const currentPrice = rows[i].close

    if (!inPosition) {
      // Entry logic
      if (score >= entryThreshold) {
        inPosition = true
        direction = 'long'
        entryPrice = currentPrice * (1 + feeRate) // Slippage + fee on entry
        entryDate = rows[i].date
        entryIdx = i
      } else if (score <= -entryThreshold) {
        inPosition = true
        direction = 'short'
        entryPrice = currentPrice * (1 - feeRate)
        entryDate = rows[i].date
        entryIdx = i
      }

      equityCurve.push({ date: rows[i].date, equity: round(equity) })
    } else {
      // Check stop-loss
      const pnlPct = direction === 'long'
        ? (currentPrice - entryPrice) / entryPrice
        : (entryPrice - currentPrice) / entryPrice

      let shouldExit = false
      let exitReason: Trade['exitReason'] = 'signal_flip'

      if (pnlPct <= -stopLossPct) {
        shouldExit = true
        exitReason = 'stop_loss'
      } else if (direction === 'long' && score <= exitThreshold) {
        shouldExit = true
        exitReason = 'signal_flip'
      } else if (direction === 'short' && score >= -exitThreshold) {
        shouldExit = true
        exitReason = 'signal_flip'
      }

      if (shouldExit) {
        const exitPrice = direction === 'long'
          ? currentPrice * (1 - feeRate)  // Fee on exit
          : currentPrice * (1 + feeRate)

        const tradePnl = direction === 'long'
          ? (exitPrice - entryPrice) / entryPrice
          : (entryPrice - exitPrice) / entryPrice

        equity *= (1 + tradePnl)

        trades.push({
          entryDate,
          entryPrice: round(entryPrice),
          exitDate: rows[i].date,
          exitPrice: round(exitPrice),
          direction,
          pnlPct: round(tradePnl * 100, 2),
          holdingDays: i - entryIdx,
          exitReason,
        })

        dailyReturns.push(tradePnl)
        inPosition = false
      }

      // Track equity
      const unrealizedPnl = direction === 'long'
        ? (currentPrice - entryPrice) / entryPrice
        : (entryPrice - currentPrice) / entryPrice
      const currentEquity = equity * (1 + unrealizedPnl)

      equityCurve.push({ date: rows[i].date, equity: round(currentEquity) })

      if (currentEquity > peakEquity) peakEquity = currentEquity
      const dd = (peakEquity - currentEquity) / peakEquity
      if (dd > maxDrawdown) maxDrawdown = dd
    }
  }

  // Close any open position at end of data
  if (inPosition) {
    const exitPrice = rows[rows.length - 1].close
    const tradePnl = direction === 'long'
      ? (exitPrice * (1 - feeRate) - entryPrice) / entryPrice
      : (entryPrice - exitPrice * (1 + feeRate)) / entryPrice

    equity *= (1 + tradePnl)
    trades.push({
      entryDate,
      entryPrice: round(entryPrice),
      exitDate: rows[rows.length - 1].date,
      exitPrice: round(exitPrice),
      direction,
      pnlPct: round(tradePnl * 100, 2),
      holdingDays: rows.length - 1 - entryIdx,
      exitReason: 'end_of_data',
    })
    dailyReturns.push(tradePnl)
  }

  // Compute metrics
  const wins = trades.filter(t => t.pnlPct > 0)
  const losses = trades.filter(t => t.pnlPct <= 0)
  const totalReturn = (equity - 10000) / 10000
  const tradingDays = rows.length - startIdx
  const years = tradingDays / 252
  const annualizedReturn = years > 0 ? (Math.pow(1 + totalReturn, 1 / years) - 1) : totalReturn

  // Sharpe from trade returns
  const avgReturn = dailyReturns.length > 0 ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length : 0
  const stdReturn = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (dailyReturns.length - 1))
    : 0
  const sharpe = stdReturn > 0 ? round(avgReturn / stdReturn * Math.sqrt(dailyReturns.length / years), 2) : 0

  // Sortino
  const downReturns = dailyReturns.filter(r => r < 0)
  const downDev = downReturns.length > 0
    ? Math.sqrt(downReturns.reduce((s, r) => s + r ** 2, 0) / downReturns.length)
    : 0
  const sortino = downDev > 0 ? round(avgReturn / downDev * Math.sqrt(dailyReturns.length / years), 2) : 0

  // Profit factor
  const grossProfit = wins.reduce((s, t) => s + t.pnlPct, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0))
  const profitFactor = grossLoss > 0 ? round(grossProfit / grossLoss, 2) : wins.length > 0 ? 999 : 0

  // Sample equity curve (max 50 points)
  const step = Math.max(1, Math.floor(equityCurve.length / 50))
  const sampledEquity = equityCurve.filter((_, i) => i % step === 0 || i === equityCurve.length - 1)

  return {
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: trades.length > 0 ? round(wins.length / trades.length * 100, 1) : 0,
    avgWinPct: wins.length > 0 ? round(wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length, 2) : 0,
    avgLossPct: losses.length > 0 ? round(losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length, 2) : 0,
    totalReturnPct: round(totalReturn * 100, 2),
    annualizedReturnPct: round(annualizedReturn * 100, 2),
    maxDrawdownPct: round(maxDrawdown * 100, 2),
    sharpeRatio: sharpe,
    sortinoRatio: sortino,
    profitFactor,
    avgHoldingDays: trades.length > 0 ? round(trades.reduce((s, t) => s + t.holdingDays, 0) / trades.length, 1) : 0,
    trades,
    equityCurve: sampledEquity,
  }
}

// ---------------------------------------------------------------------------
// Tool: backtest_signal
// ---------------------------------------------------------------------------

export const backtestSignal: Tool = defineTool({
  name: 'backtest_signal',
  description:
    'Backtest the technical composite score against 1-5 years of historical data. ' +
    'Simulates trades with entry/exit on score thresholds, stop-loss, and transaction fees. ' +
    'Returns: win rate, Sharpe ratio, Sortino, max drawdown, profit factor, trade list, equity curve. ' +
    'Fully deterministic — same inputs always produce same output. No LLM involved.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Ticker symbol to backtest',
      },
      years: {
        type: 'number',
        description: 'Years of history to test (1-5). Default: 2',
      },
      entry_threshold: {
        type: 'number',
        description: 'Score threshold to enter a trade. Default: 3 (enter long when score >= 3, short when <= -3)',
      },
      exit_threshold: {
        type: 'number',
        description: 'Score threshold to exit. Default: 0 (exit long when score <= 0, exit short when >= 0)',
      },
      stop_loss_pct: {
        type: 'number',
        description: 'Stop-loss as decimal (e.g., 0.05 for 5%). Default: 0.05',
      },
      fee_rate: {
        type: 'number',
        description: 'Transaction fee per side as decimal (e.g., 0.001 for 0.1%). Default: 0.001',
      },
    },
    required: ['symbol'],
  },
  isReadOnly: true,
  category: 'custom',
  timeoutMs: 60_000,
  async execute(input) {
    const {
      symbol,
      years = 2,
      entry_threshold = 3,
      exit_threshold = 0,
      stop_loss_pct = 0.05,
      fee_rate = 0.001,
    } = input as {
      symbol: string
      years?: number
      entry_threshold?: number
      exit_threshold?: number
      stop_loss_pct?: number
      fee_rate?: number
    }

    try {
      const clampedYears = Math.min(Math.max(years, 1), 5)
      const endUnix = Math.floor(Date.now() / 1000)
      const startUnix = endUnix - clampedYears * 365 * 86400 - 365 * 86400 // Extra year for SMA200 warmup

      const rows = await fetchOHLCVWithRetry(symbol, startUnix, endUnix)

      if (rows.length < 300) {
        return { content: `Insufficient data for ${symbol}: ${rows.length} days (need 300+ for meaningful backtest)`, isError: true }
      }

      const backtestResult = runBacktest(
        rows,
        entry_threshold,
        exit_threshold,
        stop_loss_pct,
        fee_rate,
        200, // SMA200 lookback
      )

      // Assessment
      const assessment: string[] = []
      if (backtestResult.winRate > 55) assessment.push('Win rate above 55% — positive edge')
      else if (backtestResult.winRate < 45) assessment.push('Win rate below 45% — signal may be counter-productive')
      else assessment.push('Win rate near 50% — edge is marginal')

      if (backtestResult.profitFactor > 1.5) assessment.push('Profit factor > 1.5 — winners significantly outsize losers')
      else if (backtestResult.profitFactor < 1.0) assessment.push('Profit factor < 1.0 — losing money overall')

      if (backtestResult.sharpeRatio > 1.0) assessment.push('Sharpe > 1.0 — good risk-adjusted returns')
      else if (backtestResult.sharpeRatio < 0) assessment.push('Negative Sharpe — risk-adjusted returns are negative')

      if (backtestResult.maxDrawdownPct > 30) assessment.push('Max drawdown > 30% — significant pain period')
      if (backtestResult.totalTrades < 10) assessment.push('Very few trades — insufficient sample size for statistical confidence')

      // Buy-and-hold comparison
      const firstPrice = rows[200].close // Start from same point as backtest
      const lastPrice = rows[rows.length - 1].close
      const buyAndHoldReturn = round(((lastPrice - firstPrice) / firstPrice) * 100, 2)

      const result = {
        symbol,
        period: `${rows[200].date} to ${rows[rows.length - 1].date}`,
        tradingDays: rows.length - 200,
        parameters: {
          entryThreshold: `Score >= ${entry_threshold} (long) or <= -${entry_threshold} (short)`,
          exitThreshold: `Score <= ${exit_threshold} (close long) or >= -${exit_threshold} (close short)`,
          stopLoss: `${round(stop_loss_pct * 100)}%`,
          feeRate: `${round(fee_rate * 100, 2)}% per side`,
        },
        performance: {
          totalReturn: `${backtestResult.totalReturnPct}%`,
          annualizedReturn: `${backtestResult.annualizedReturnPct}%`,
          buyAndHoldReturn: `${buyAndHoldReturn}%`,
          excessReturn: `${round(backtestResult.totalReturnPct - buyAndHoldReturn, 2)}% vs buy-and-hold`,
          maxDrawdown: `${backtestResult.maxDrawdownPct}%`,
          sharpeRatio: backtestResult.sharpeRatio,
          sortinoRatio: backtestResult.sortinoRatio,
          profitFactor: backtestResult.profitFactor,
        },
        tradeStats: {
          totalTrades: backtestResult.totalTrades,
          winRate: `${backtestResult.winRate}%`,
          avgWin: `+${backtestResult.avgWinPct}%`,
          avgLoss: `${backtestResult.avgLossPct}%`,
          avgHoldingDays: backtestResult.avgHoldingDays,
          winningTrades: backtestResult.winningTrades,
          losingTrades: backtestResult.losingTrades,
        },
        assessment,
        recentTrades: backtestResult.trades.slice(-10),
        equityCurveSample: backtestResult.equityCurve.slice(-20),
        ...dataFreshness(),
      }

      return { content: JSON.stringify(result, null, 2), isError: false }
    } catch (e) {
      return { content: `Error backtesting ${symbol}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
})
