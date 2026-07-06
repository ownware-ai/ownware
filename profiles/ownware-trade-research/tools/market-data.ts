/**
 * Market Data Tools — OHLCV + Technical Indicators
 *
 * Data source: Yahoo Finance query API (no key required)
 * Returns pre-computed analysis, not raw CSV.
 *
 * Tools:
 * - get_price_analysis: OHLCV with computed statistics
 * - get_technical_signals: All indicators with signal assessment
 */

import { defineTool } from '@ownware/loom'
import type { Tool } from '@ownware/loom'

// ---------------------------------------------------------------------------
// Yahoo Finance data fetching
// ---------------------------------------------------------------------------

interface OHLCVRow {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

async function fetchOHLCV(
  symbol: string,
  period1: number,
  period2: number,
): Promise<OHLCVRow[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false`

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Ownware/1.0 (trading-firm-profile)',
    },
  })

  if (!res.ok) {
    throw new Error(`Yahoo Finance API error: ${res.status} ${res.statusText}`)
  }

  const json = (await res.json()) as Record<string, unknown>
  const chart = json.chart as Record<string, unknown>
  const results = (chart.result as Record<string, unknown>[])?.[0]
  if (!results) throw new Error(`No data returned for ${symbol}`)

  const timestamps = results.timestamp as number[]
  const quote = (results.indicators as Record<string, unknown>).quote as Record<string, unknown>[]
  const q = quote[0]

  const opens = q.open as (number | null)[]
  const highs = q.high as (number | null)[]
  const lows = q.low as (number | null)[]
  const closes = q.close as (number | null)[]
  const volumes = q.volume as (number | null)[]

  const rows: OHLCVRow[] = []
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue
    rows.push({
      date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
      open: round(opens[i] ?? 0),
      high: round(highs[i] ?? 0),
      low: round(lows[i] ?? 0),
      close: round(closes[i] ?? 0),
      volume: volumes[i] ?? 0,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Technical indicator computation
// ---------------------------------------------------------------------------

function sma(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = []
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue }
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += data[j]
    result.push(round(sum / period))
  }
  return result
}

function ema(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = []
  const multiplier = 2 / (period + 1)
  let prev: number | null = null

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue }
    if (prev === null) {
      let sum = 0
      for (let j = i - period + 1; j <= i; j++) sum += data[j]
      prev = sum / period
    } else {
      prev = (data[i] - prev) * multiplier + prev
    }
    result.push(round(prev))
  }
  return result
}

function computeRSI(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = []
  const changes: number[] = []
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1])

  result.push(null) // First element has no change

  let avgGain = 0
  let avgLoss = 0

  for (let i = 0; i < changes.length; i++) {
    if (i < period) {
      // Accumulate for initial average
      if (changes[i] > 0) avgGain += changes[i]
      else avgLoss += Math.abs(changes[i])

      if (i === period - 1) {
        avgGain /= period
        avgLoss /= period
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
        result.push(round(100 - 100 / (1 + rs)))
      } else {
        result.push(null)
      }
    } else {
      const gain = changes[i] > 0 ? changes[i] : 0
      const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
      result.push(round(100 - 100 / (1 + rs)))
    }
  }
  return result
}

function computeMACD(closes: number[]): {
  macd: (number | null)[]
  signal: (number | null)[]
  histogram: (number | null)[]
} {
  const ema12 = ema(closes, 12)
  const ema26 = ema(closes, 26)
  const macdLine: (number | null)[] = []
  for (let i = 0; i < closes.length; i++) {
    if (ema12[i] == null || ema26[i] == null) { macdLine.push(null); continue }
    macdLine.push(round(ema12[i]! - ema26[i]!))
  }
  const macdValues = macdLine.filter((v): v is number => v !== null)
  const signalLine = ema(macdValues, 9)

  // Align signal line with macd line
  const fullSignal: (number | null)[] = []
  let si = 0
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] === null) { fullSignal.push(null); continue }
    fullSignal.push(signalLine[si] ?? null)
    si++
  }

  const histogram: (number | null)[] = []
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] == null || fullSignal[i] == null) { histogram.push(null); continue }
    histogram.push(round(macdLine[i]! - fullSignal[i]!))
  }

  return { macd: macdLine, signal: fullSignal, histogram }
}

function computeBollinger(closes: number[], period = 20, stdDev = 2): {
  upper: (number | null)[]
  middle: (number | null)[]
  lower: (number | null)[]
} {
  const middle = sma(closes, period)
  const upper: (number | null)[] = []
  const lower: (number | null)[] = []

  for (let i = 0; i < closes.length; i++) {
    if (middle[i] == null) { upper.push(null); lower.push(null); continue }
    let sumSq = 0
    for (let j = i - period + 1; j <= i; j++) sumSq += (closes[j] - middle[i]!) ** 2
    const sd = Math.sqrt(sumSq / period)
    upper.push(round(middle[i]! + stdDev * sd))
    lower.push(round(middle[i]! - stdDev * sd))
  }
  return { upper, middle, lower }
}

function computeATR(rows: OHLCVRow[], period = 14): (number | null)[] {
  const tr: number[] = []
  for (let i = 0; i < rows.length; i++) {
    if (i === 0) { tr.push(rows[i].high - rows[i].low); continue }
    tr.push(Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close),
      Math.abs(rows[i].low - rows[i - 1].close),
    ))
  }
  const result: (number | null)[] = []
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) { result.push(null); continue }
    if (i === period - 1) {
      let sum = 0
      for (let j = 0; j < period; j++) sum += tr[j]
      result.push(round(sum / period))
    } else {
      result.push(round((result[i - 1]! * (period - 1) + tr[i]) / period))
    }
  }
  return result
}

function computeVWAP(rows: OHLCVRow[]): number {
  let cumVol = 0
  let cumTP = 0
  for (const r of rows) {
    const tp = (r.high + r.low + r.close) / 3
    cumTP += tp * r.volume
    cumVol += r.volume
  }
  return cumVol > 0 ? round(cumTP / cumVol) : 0
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(n: number, decimals = 2): number {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

function pctChange(current: number, previous: number): number {
  if (previous === 0) return 0
  return round(((current - previous) / previous) * 100)
}

function last<T>(arr: (T | null)[]): T | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null) return arr[i]
  }
  return null
}

function dateToUnix(dateStr: string): number {
  return Math.floor(new Date(dateStr).getTime() / 1000)
}

// ---------------------------------------------------------------------------
// Tool: get_price_analysis
// ---------------------------------------------------------------------------

export const getPriceAnalysis: Tool = defineTool({
  name: 'get_price_analysis',
  description:
    'Get OHLCV price data with computed statistics for a stock. ' +
    'Returns trend direction, key levels, volume analysis, and performance metrics. ' +
    'NOT raw CSV — pre-computed analysis optimized for LLM consumption.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Ticker symbol (e.g., AAPL, NVDA, TSLA)',
      },
      trade_date: {
        type: 'string',
        description: 'Analysis date in YYYY-MM-DD format. Data is fetched for 6 months ending on this date.',
      },
    },
    required: ['symbol', 'trade_date'],
  },
  isReadOnly: true,
  category: 'custom',
  timeoutMs: 30_000,
  async execute(input) {
    const { symbol, trade_date } = input as { symbol: string; trade_date: string }

    try {
      const endDate = new Date(trade_date)
      const startDate = new Date(trade_date)
      startDate.setMonth(startDate.getMonth() - 6)

      const rows = await fetchOHLCV(
        symbol,
        dateToUnix(startDate.toISOString().split('T')[0]),
        dateToUnix(trade_date) + 86400,
      )

      if (rows.length === 0) {
        return { content: `No price data found for ${symbol}`, isError: true }
      }

      const closes = rows.map(r => r.close)
      const latest = rows[rows.length - 1]
      const prev = rows.length > 1 ? rows[rows.length - 2] : latest

      // Performance periods
      const oneWeekAgo = rows.length > 5 ? rows[rows.length - 6] : rows[0]
      const oneMonthAgo = rows.length > 22 ? rows[rows.length - 23] : rows[0]
      const threeMonthAgo = rows.length > 66 ? rows[rows.length - 67] : rows[0]

      // Volume analysis
      const recentVol = rows.slice(-5).reduce((s, r) => s + r.volume, 0) / Math.min(5, rows.length)
      const avgVol20 = rows.slice(-20).reduce((s, r) => s + r.volume, 0) / Math.min(20, rows.length)
      const avgVol50 = rows.slice(-50).reduce((s, r) => s + r.volume, 0) / Math.min(50, rows.length)

      // Key levels
      const highs = rows.map(r => r.high)
      const lows = rows.map(r => r.low)
      const high52w = Math.max(...highs)
      const low52w = Math.min(...lows)
      const highRecent = Math.max(...highs.slice(-20))
      const lowRecent = Math.min(...lows.slice(-20))

      // Moving averages
      const sma20 = sma(closes, 20)
      const sma50 = sma(closes, 50)

      // Trend assessment
      const sma20Val = last(sma20)
      const sma50Val = last(sma50)
      let trend = 'neutral'
      if (sma20Val && sma50Val) {
        if (latest.close > sma20Val && sma20Val > sma50Val) trend = 'strong_uptrend'
        else if (latest.close > sma20Val) trend = 'uptrend'
        else if (latest.close < sma20Val && sma20Val < sma50Val) trend = 'strong_downtrend'
        else if (latest.close < sma20Val) trend = 'downtrend'
      }

      // ── Multi-timeframe analysis (TorchTrade-inspired) ──────────────
      // TorchTrade's key insight: seeing daily + weekly + monthly simultaneously
      // prevents tunnel vision. A stock can be bullish on daily but bearish on weekly.

      // Weekly aggregation (last 12 weeks)
      const weeklyCloses: number[] = []
      const weeklyHighs: number[] = []
      const weeklyLows: number[] = []
      for (let i = rows.length - 1; i >= 4 && weeklyCloses.length < 12; i -= 5) {
        const weekSlice = rows.slice(Math.max(0, i - 4), i + 1)
        weeklyCloses.push(weekSlice[weekSlice.length - 1].close)
        weeklyHighs.push(Math.max(...weekSlice.map(r => r.high)))
        weeklyLows.push(Math.min(...weekSlice.map(r => r.low)))
      }
      weeklyCloses.reverse()
      weeklyHighs.reverse()
      weeklyLows.reverse()

      // Monthly aggregation (last 6 months)
      const monthlyCloses: number[] = []
      for (let i = rows.length - 1; i >= 20 && monthlyCloses.length < 6; i -= 22) {
        monthlyCloses.push(rows[i].close)
      }
      monthlyCloses.reverse()

      // Weekly trend
      const weeklySma4 = weeklyCloses.length >= 4
        ? weeklyCloses.slice(-4).reduce((s, v) => s + v, 0) / 4
        : null
      const weeklySma12 = weeklyCloses.length >= 12
        ? weeklyCloses.reduce((s, v) => s + v, 0) / weeklyCloses.length
        : null
      const weeklyLatest = weeklyCloses[weeklyCloses.length - 1] ?? null

      let weeklyTrend = 'neutral'
      if (weeklyLatest && weeklySma4 && weeklySma12) {
        if (weeklyLatest > weeklySma4 && weeklySma4 > weeklySma12) weeklyTrend = 'strong_uptrend'
        else if (weeklyLatest > weeklySma4) weeklyTrend = 'uptrend'
        else if (weeklyLatest < weeklySma4 && weeklySma4 < weeklySma12) weeklyTrend = 'strong_downtrend'
        else if (weeklyLatest < weeklySma4) weeklyTrend = 'downtrend'
      }

      // Monthly trend
      let monthlyTrend = 'neutral'
      if (monthlyCloses.length >= 3) {
        const recent3 = monthlyCloses.slice(-3)
        const allRising = recent3[0] < recent3[1] && recent3[1] < recent3[2]
        const allFalling = recent3[0] > recent3[1] && recent3[1] > recent3[2]
        if (allRising) monthlyTrend = 'uptrend'
        else if (allFalling) monthlyTrend = 'downtrend'
      }

      // Timeframe alignment check
      const trendsAligned = trend === weeklyTrend || (trend.includes('up') && weeklyTrend.includes('up')) || (trend.includes('down') && weeklyTrend.includes('down'))

      const analysis = {
        symbol,
        date: latest.date,
        price: {
          current: latest.close,
          open: latest.open,
          dayHigh: latest.high,
          dayLow: latest.low,
          previousClose: prev.close,
          dayChange: pctChange(latest.close, prev.close),
        },
        performance: {
          oneWeek: pctChange(latest.close, oneWeekAgo.close),
          oneMonth: pctChange(latest.close, oneMonthAgo.close),
          threeMonth: pctChange(latest.close, threeMonthAgo.close),
          sixMonth: pctChange(latest.close, rows[0].close),
        },
        multiTimeframe: {
          daily: { trend, sma20: sma20Val, sma50: sma50Val },
          weekly: {
            trend: weeklyTrend,
            sma4w: weeklySma4 != null ? round(weeklySma4) : null,
            sma12w: weeklySma12 != null ? round(weeklySma12) : null,
            highLast12w: weeklyHighs.length > 0 ? Math.max(...weeklyHighs) : null,
            lowLast12w: weeklyLows.length > 0 ? Math.min(...weeklyLows) : null,
          },
          monthly: { trend: monthlyTrend },
          alignment: trendsAligned ? 'aligned' : 'divergent',
          alignmentNote: trendsAligned
            ? 'Daily and weekly trends agree — higher conviction signal'
            : 'CAUTION: Daily and weekly trends diverge — trend may be changing',
        },
        keyLevels: {
          resistance20d: highRecent,
          support20d: lowRecent,
          sixMonthHigh: high52w,
          sixMonthLow: low52w,
          distanceFromHigh: pctChange(latest.close, high52w),
          distanceFromLow: pctChange(latest.close, low52w),
          sma20: sma20Val,
          sma50: sma50Val,
        },
        volume: {
          latest: latest.volume,
          avg5d: Math.round(recentVol),
          avg20d: Math.round(avgVol20),
          avg50d: Math.round(avgVol50),
          relativeVolume: round(recentVol / avgVol50),
          volumeTrend: recentVol > avgVol50 * 1.2 ? 'above_average' : recentVol < avgVol50 * 0.8 ? 'below_average' : 'normal',
        },
        trend,
        totalTradingDays: rows.length,
      }

      return { content: JSON.stringify(analysis, null, 2), isError: false }
    } catch (e) {
      return { content: `Error fetching price data for ${symbol}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
})

// ---------------------------------------------------------------------------
// Tool: get_technical_signals
// ---------------------------------------------------------------------------

export const getTechnicalSignals: Tool = defineTool({
  name: 'get_technical_signals',
  description:
    'Get all technical indicator readings with signal assessments. ' +
    'Computes RSI, MACD, Bollinger Bands, ATR, moving averages, and VWAP. ' +
    'Each indicator includes the current value AND a plain-English signal assessment.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Ticker symbol (e.g., AAPL, NVDA, TSLA)',
      },
      trade_date: {
        type: 'string',
        description: 'Analysis date in YYYY-MM-DD format',
      },
    },
    required: ['symbol', 'trade_date'],
  },
  isReadOnly: true,
  category: 'custom',
  timeoutMs: 30_000,
  async execute(input) {
    const { symbol, trade_date } = input as { symbol: string; trade_date: string }

    try {
      const endDate = new Date(trade_date)
      const startDate = new Date(trade_date)
      startDate.setMonth(startDate.getMonth() - 12) // Need 12 months for 200 SMA

      const rows = await fetchOHLCV(
        symbol,
        dateToUnix(startDate.toISOString().split('T')[0]),
        dateToUnix(trade_date) + 86400,
      )

      if (rows.length < 30) {
        return { content: `Insufficient data for ${symbol} (${rows.length} days). Need at least 30.`, isError: true }
      }

      const closes = rows.map(r => r.close)
      const latestClose = closes[closes.length - 1]

      // Compute all indicators
      const rsi = computeRSI(closes)
      const rsiVal = last(rsi)

      const macdData = computeMACD(closes)
      const macdVal = last(macdData.macd)
      const macdSignalVal = last(macdData.signal)
      const macdHistVal = last(macdData.histogram)

      const boll = computeBollinger(closes)
      const bollUpper = last(boll.upper)
      const bollMiddle = last(boll.middle)
      const bollLower = last(boll.lower)

      const atr = computeATR(rows)
      const atrVal = last(atr)

      const sma10Val = last(ema(closes, 10))
      const sma20Val = last(sma(closes, 20))
      const sma50Val = last(sma(closes, 50))
      const sma200 = sma(closes, 200)
      const sma200Val = last(sma200)

      const vwap = computeVWAP(rows.slice(-20))

      // Previous values for crossover detection
      const prevMacd = macdData.macd.length > 2 ? macdData.macd[macdData.macd.length - 2] : null
      const prevSignal = macdData.signal.length > 2 ? macdData.signal[macdData.signal.length - 2] : null
      const prevRsi = rsi.length > 2 ? rsi[rsi.length - 2] : null

      // Signal assessments
      const signals: Record<string, unknown> = {
        rsi: {
          value: rsiVal,
          signal: rsiVal == null ? 'insufficient_data'
            : rsiVal > 70 ? 'overbought'
            : rsiVal < 30 ? 'oversold'
            : rsiVal > 60 ? 'bullish_momentum'
            : rsiVal < 40 ? 'bearish_momentum'
            : 'neutral',
          direction: rsiVal != null && prevRsi != null ? (rsiVal > prevRsi ? 'rising' : 'falling') : 'unknown',
        },
        macd: {
          macd: macdVal,
          signal: macdSignalVal,
          histogram: macdHistVal,
          crossover: macdVal != null && macdSignalVal != null && prevMacd != null && prevSignal != null
            ? (prevMacd <= prevSignal && macdVal > macdSignalVal ? 'bullish_crossover'
              : prevMacd >= prevSignal && macdVal < macdSignalVal ? 'bearish_crossover'
              : macdVal > macdSignalVal ? 'bullish' : 'bearish')
            : 'unknown',
          histogramTrend: macdHistVal != null ? (macdHistVal > 0 ? 'expanding_bullish' : 'expanding_bearish') : 'unknown',
        },
        bollinger: {
          upper: bollUpper,
          middle: bollMiddle,
          lower: bollLower,
          position: bollUpper != null && bollLower != null
            ? latestClose > bollUpper ? 'above_upper_band'
            : latestClose < bollLower ? 'below_lower_band'
            : latestClose > bollMiddle! ? 'upper_half' : 'lower_half'
            : 'unknown',
          bandwidth: bollUpper != null && bollLower != null && bollMiddle != null
            ? round((bollUpper - bollLower) / bollMiddle * 100)
            : null,
          signal: bollUpper != null && bollLower != null
            ? latestClose > bollUpper ? 'overbought_or_breakout'
            : latestClose < bollLower ? 'oversold_or_breakdown'
            : 'within_bands'
            : 'unknown',
        },
        atr: {
          value: atrVal,
          percentOfPrice: atrVal != null ? round(atrVal / latestClose * 100) : null,
          volatilityLevel: atrVal != null
            ? (atrVal / latestClose) > 0.03 ? 'high' : (atrVal / latestClose) > 0.015 ? 'moderate' : 'low'
            : 'unknown',
        },
        movingAverages: {
          ema10: sma10Val,
          sma20: sma20Val,
          sma50: sma50Val,
          sma200: sma200Val,
          priceVsEma10: sma10Val != null ? (latestClose > sma10Val ? 'above' : 'below') : 'unknown',
          priceVsSma20: sma20Val != null ? (latestClose > sma20Val ? 'above' : 'below') : 'unknown',
          priceVsSma50: sma50Val != null ? (latestClose > sma50Val ? 'above' : 'below') : 'unknown',
          priceVsSma200: sma200Val != null ? (latestClose > sma200Val ? 'above' : 'below') : 'unknown',
          goldenCross: sma50Val != null && sma200Val != null ? sma50Val > sma200Val : null,
        },
        vwap: {
          value: vwap,
          priceVsVwap: latestClose > vwap ? 'above' : 'below',
        },
      }

      // Overall signal summary
      let bullSignals = 0
      let bearSignals = 0

      if (rsiVal != null && rsiVal > 50) bullSignals++; else bearSignals++
      if (macdVal != null && macdSignalVal != null && macdVal > macdSignalVal) bullSignals++; else bearSignals++
      if (sma20Val != null && latestClose > sma20Val) bullSignals++; else bearSignals++
      if (sma50Val != null && latestClose > sma50Val) bullSignals++; else bearSignals++
      if (sma200Val != null && latestClose > sma200Val) bullSignals++; else bearSignals++
      if (latestClose > vwap) bullSignals++; else bearSignals++

      const overallSignal = {
        bullCount: bullSignals,
        bearCount: bearSignals,
        totalChecks: bullSignals + bearSignals,
        assessment: bullSignals > bearSignals + 2 ? 'strongly_bullish'
          : bullSignals > bearSignals ? 'mildly_bullish'
          : bearSignals > bullSignals + 2 ? 'strongly_bearish'
          : bearSignals > bullSignals ? 'mildly_bearish'
          : 'mixed',
      }

      return {
        content: JSON.stringify({ symbol, date: trade_date, latestClose, signals, overallSignal }, null, 2),
        isError: false,
      }
    } catch (e) {
      return { content: `Error computing signals for ${symbol}: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  },
})
