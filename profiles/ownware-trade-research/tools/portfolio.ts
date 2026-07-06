/**
 * Portfolio State Management Tool
 *
 * Tracks positions, trades, and portfolio metrics in a JSON file.
 * Stored in the workspace directory — portable, inspectable, no DB deps.
 *
 * The system MUST know what you hold to:
 * - Check sector concentration before recommending a new buy
 * - Track P&L per trade for the memory/learning system
 * - Enforce portfolio-level risk limits
 * - Avoid recommending stocks highly correlated with existing positions
 *
 * Tools:
 * - get_portfolio_state: Read current positions, exposure, risk metrics
 * - log_trade_decision: Record a recommendation (accepted or rejected by user)
 * - update_position: Record an entry, exit, or stop-loss hit
 */

import { defineTool } from '@ownware/loom'
import type { Tool, ToolContext } from '@ownware/loom'
import { round, dataFreshness } from './shared.ts'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

// ---------------------------------------------------------------------------
// Portfolio data types
// ---------------------------------------------------------------------------

interface Position {
  symbol: string
  direction: 'long' | 'short'
  shares: number
  entryPrice: number
  entryDate: string
  currentPrice: number | null
  stopLoss: number | null
  takeProfit: number | null
  sector: string | null
  compositeScoreAtEntry: number | null
}

interface TradeRecord {
  id: string
  symbol: string
  action: 'buy' | 'sell' | 'stop_hit' | 'tp_hit' | 'manual_close'
  shares: number
  price: number
  date: string
  fees: number
  pnl: number | null
  compositeScore: number | null
  reasoning: string
  accepted: boolean
}

interface PortfolioState {
  version: 1
  lastUpdated: string
  cash: number
  initialValue: number
  positions: Position[]
  tradeHistory: TradeRecord[]
  dailySnapshots: Array<{ date: string; totalValue: number; cash: number; invested: number }>
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function getPortfolioPath(context: ToolContext): string {
  const workspace = context.workspacePath ?? context.cwd
  const dir = join(workspace, '.cortex-trading')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'portfolio.json')
}

function loadPortfolio(context: ToolContext): PortfolioState {
  const path = getPortfolioPath(context)
  if (!existsSync(path)) {
    return {
      version: 1,
      lastUpdated: new Date().toISOString(),
      cash: 100_000,
      initialValue: 100_000,
      positions: [],
      tradeHistory: [],
      dailySnapshots: [],
    }
  }
  const raw = readFileSync(path, 'utf-8')
  return JSON.parse(raw) as PortfolioState
}

function savePortfolio(context: ToolContext, state: PortfolioState): void {
  state.lastUpdated = new Date().toISOString()
  const path = getPortfolioPath(context)
  writeFileSync(path, JSON.stringify(state, null, 2))
}

// ---------------------------------------------------------------------------
// Tool: get_portfolio_state
// ---------------------------------------------------------------------------

export const getPortfolioState: Tool = defineTool({
  name: 'get_portfolio_state',
  description:
    'Get the current portfolio state: open positions, cash balance, sector exposure, ' +
    'total P&L, risk metrics, and recent trade history. The CIO MUST check this before ' +
    'making any recommendation to avoid sector concentration and correlation risk.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  isReadOnly: true,
  category: 'custom',
  timeoutMs: 5_000,
  async execute(_input, context) {
    const state = loadPortfolio(context)

    const positions = state.positions
    const invested = positions.reduce((s, p) => s + p.shares * (p.currentPrice ?? p.entryPrice), 0)
    const totalValue = state.cash + invested

    // Sector exposure
    const sectorMap: Record<string, number> = {}
    for (const p of positions) {
      const sector = p.sector ?? 'unknown'
      const value = p.shares * (p.currentPrice ?? p.entryPrice)
      sectorMap[sector] = (sectorMap[sector] ?? 0) + value
    }
    const sectorExposure: Record<string, string> = {}
    for (const [sector, value] of Object.entries(sectorMap)) {
      sectorExposure[sector] = `${round(value / totalValue * 100, 1)}%`
    }

    // Position summaries
    const positionSummaries = positions.map(p => {
      const currentVal = p.shares * (p.currentPrice ?? p.entryPrice)
      const entryVal = p.shares * p.entryPrice
      const pnl = p.direction === 'long'
        ? currentVal - entryVal
        : entryVal - currentVal
      const pnlPct = entryVal > 0 ? round(pnl / entryVal * 100, 2) : 0

      return {
        symbol: p.symbol,
        direction: p.direction,
        shares: p.shares,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice ?? p.entryPrice,
        unrealizedPnl: `$${round(pnl)} (${pnlPct > 0 ? '+' : ''}${pnlPct}%)`,
        positionSize: `${round(currentVal / totalValue * 100, 1)}% of portfolio`,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
        sector: p.sector,
        entryDate: p.entryDate,
      }
    })

    // Recent trades
    const recentTrades = state.tradeHistory.slice(-10).map(t => ({
      date: t.date,
      symbol: t.symbol,
      action: t.action,
      shares: t.shares,
      price: t.price,
      pnl: t.pnl != null ? `$${round(t.pnl)}` : null,
      accepted: t.accepted,
    }))

    // Risk checks
    const riskAlerts: string[] = []
    for (const [sector, pct] of Object.entries(sectorExposure)) {
      const val = parseFloat(pct)
      if (val > 20) riskAlerts.push(`ALERT: ${sector} sector exposure at ${pct} (limit: 20%)`)
    }
    for (const p of positionSummaries) {
      const sizePct = parseFloat(p.positionSize)
      if (sizePct > 10) riskAlerts.push(`ALERT: ${p.symbol} is ${p.positionSize} — exceeds 10% single-position limit`)
    }
    const totalExposure = invested / totalValue * 100
    if (totalExposure > 80) riskAlerts.push(`ALERT: Total exposure ${round(totalExposure)}% — consider holding more cash`)

    // Performance
    const totalPnl = totalValue - state.initialValue
    const totalPnlPct = round(totalPnl / state.initialValue * 100, 2)
    const wins = state.tradeHistory.filter(t => t.pnl != null && t.pnl > 0)
    const losses = state.tradeHistory.filter(t => t.pnl != null && t.pnl <= 0)

    const result = {
      portfolio: {
        totalValue: `$${round(totalValue).toLocaleString()}`,
        cash: `$${round(state.cash).toLocaleString()}`,
        invested: `$${round(invested).toLocaleString()}`,
        totalPnl: `$${round(totalPnl)} (${totalPnlPct > 0 ? '+' : ''}${totalPnlPct}%)`,
        positionCount: positions.length,
        cashPercent: `${round(state.cash / totalValue * 100, 1)}%`,
      },
      positions: positionSummaries,
      sectorExposure: Object.keys(sectorExposure).length > 0 ? sectorExposure : 'No positions',
      riskAlerts: riskAlerts.length > 0 ? riskAlerts : ['All risk limits within bounds'],
      tradeHistory: {
        totalTrades: state.tradeHistory.length,
        winRate: wins.length + losses.length > 0 ? `${round(wins.length / (wins.length + losses.length) * 100)}%` : 'N/A',
        recentTrades,
      },
      ...dataFreshness(),
    }

    return { content: JSON.stringify(result, null, 2), isError: false }
  },
})

// ---------------------------------------------------------------------------
// Tool: log_trade_decision
// ---------------------------------------------------------------------------

export const logTradeDecision: Tool = defineTool({
  name: 'log_trade_decision',
  description:
    'Record a trade recommendation and whether the user accepted or rejected it. ' +
    'This builds the decision log that feeds into the learning system (AGENTS.md). ' +
    'Call this AFTER every analysis, regardless of whether the user trades.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Ticker symbol' },
      action: { type: 'string', enum: ['buy', 'sell', 'hold'], description: 'Recommended action' },
      reasoning: { type: 'string', description: 'Brief reason for the recommendation (1-2 sentences)' },
      composite_score: { type: 'number', description: 'The composite score at time of recommendation' },
      accepted: { type: 'boolean', description: 'Whether the user accepted the recommendation' },
      entry_price: { type: 'number', description: 'Entry price if accepted' },
      shares: { type: 'number', description: 'Number of shares if accepted' },
      stop_loss: { type: 'number', description: 'Stop-loss price if accepted' },
      take_profit: { type: 'number', description: 'Take-profit target if accepted' },
      sector: { type: 'string', description: 'Stock sector (Technology, Healthcare, etc.)' },
    },
    required: ['symbol', 'action', 'reasoning', 'accepted'],
  },
  isReadOnly: false,
  requiresPermission: false,
  category: 'custom',
  timeoutMs: 5_000,
  async execute(input, context) {
    const {
      symbol, action, reasoning, composite_score, accepted,
      entry_price, shares, stop_loss, take_profit, sector,
    } = input as {
      symbol: string; action: string; reasoning: string
      composite_score?: number; accepted: boolean
      entry_price?: number; shares?: number
      stop_loss?: number; take_profit?: number; sector?: string
    }

    const state = loadPortfolio(context)

    const tradeId = `trade_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const record: TradeRecord = {
      id: tradeId,
      symbol,
      action: action as TradeRecord['action'],
      shares: shares ?? 0,
      price: entry_price ?? 0,
      date: new Date().toISOString().split('T')[0],
      fees: 0,
      pnl: null,
      compositeScore: composite_score ?? null,
      reasoning,
      accepted,
    }

    state.tradeHistory.push(record)

    // If accepted and it's a buy, add to positions
    if (accepted && action === 'buy' && entry_price && shares) {
      state.positions.push({
        symbol,
        direction: 'long',
        shares,
        entryPrice: entry_price,
        entryDate: record.date,
        currentPrice: entry_price,
        stopLoss: stop_loss ?? null,
        takeProfit: take_profit ?? null,
        sector: sector ?? null,
        compositeScoreAtEntry: composite_score ?? null,
      })
      state.cash -= shares * entry_price
    }

    savePortfolio(context, state)

    return {
      content: JSON.stringify({
        logged: true,
        tradeId,
        action,
        symbol,
        accepted,
        portfolioCash: `$${round(state.cash).toLocaleString()}`,
        openPositions: state.positions.length,
      }, null, 2),
      isError: false,
    }
  },
})

// ---------------------------------------------------------------------------
// Tool: update_position
// ---------------------------------------------------------------------------

export const updatePosition: Tool = defineTool({
  name: 'update_position',
  description:
    'Update or close a position. Use when: price updates, stop-loss hit, ' +
    'take-profit reached, or manual close. Calculates realized P&L on close.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Ticker symbol of the position to update' },
      action: {
        type: 'string',
        enum: ['update_price', 'close', 'stop_hit', 'tp_hit'],
        description: 'What happened to this position',
      },
      current_price: { type: 'number', description: 'Current market price' },
    },
    required: ['symbol', 'action', 'current_price'],
  },
  isReadOnly: false,
  requiresPermission: false,
  category: 'custom',
  timeoutMs: 5_000,
  async execute(input, context) {
    const { symbol, action, current_price } = input as {
      symbol: string; action: string; current_price: number
    }

    const state = loadPortfolio(context)
    const posIdx = state.positions.findIndex(p => p.symbol.toUpperCase() === symbol.toUpperCase())

    if (posIdx === -1) {
      return { content: `No open position found for ${symbol}`, isError: true }
    }

    const pos = state.positions[posIdx]

    if (action === 'update_price') {
      pos.currentPrice = current_price
      savePortfolio(context, state)
      const pnl = pos.direction === 'long'
        ? (current_price - pos.entryPrice) * pos.shares
        : (pos.entryPrice - current_price) * pos.shares
      return {
        content: JSON.stringify({
          updated: true,
          symbol: pos.symbol,
          unrealizedPnl: `$${round(pnl)}`,
        }, null, 2),
        isError: false,
      }
    }

    // Close position
    const pnl = pos.direction === 'long'
      ? (current_price - pos.entryPrice) * pos.shares
      : (pos.entryPrice - current_price) * pos.shares

    const feeEst = current_price * pos.shares * 0.001 // 0.1% fee estimate

    state.cash += pos.shares * current_price - feeEst

    state.tradeHistory.push({
      id: `close_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      symbol: pos.symbol,
      action: action as TradeRecord['action'],
      shares: pos.shares,
      price: current_price,
      date: new Date().toISOString().split('T')[0],
      fees: round(feeEst),
      pnl: round(pnl),
      compositeScore: null,
      reasoning: `Position closed: ${action}`,
      accepted: true,
    })

    state.positions.splice(posIdx, 1)
    savePortfolio(context, state)

    return {
      content: JSON.stringify({
        closed: true,
        symbol: pos.symbol,
        entryPrice: pos.entryPrice,
        exitPrice: current_price,
        realizedPnl: `$${round(pnl)} (${round(pnl / (pos.entryPrice * pos.shares) * 100, 2)}%)`,
        reason: action,
        portfolioCash: `$${round(state.cash).toLocaleString()}`,
        remainingPositions: state.positions.length,
      }, null, 2),
      isError: false,
    }
  },
})
